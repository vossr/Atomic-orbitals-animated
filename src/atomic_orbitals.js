/*
 * atomic_orbitals.js — WebGL2 sphere-impostor renderer with SSAO.
 *
 * Every sphere is a single vertex drawn as a point sprite. The fragment shader
 * ray-traces the sphere inside the sprite, so it shades like a real 3D ball and
 * writes gl_FragDepth, which means sprites depth-test and interpenetrate
 * correctly against each other (a flat sprite would only sort by centre).
 *
 * All vertex attributes live in dynamic buffers and can be rewritten each frame
 * via updatePositions() / updateRadii() / updateColors().
 *
 * Pipeline:
 *   1. scene -> G-buffer   (MRT: linear color + view-space normal, depth texture)
 *   2. SSAO                (hemisphere kernel over the depth buffer)
 *   3. blur + composite    (box-blur the AO, multiply, gamma, to the screen)
 */
(function (global) {
  'use strict';

  const AO_KERNEL_SIZE = 16;

  // --- scene pass ---------------------------------------------------------

  const SPHERE_VERT = `#version 300 es
  precision highp float;

  in vec3 aPosition;
  in float aRadius;
  in vec3 aColor;

  uniform mat4 uView;
  uniform mat4 uProj;
  uniform vec2 uViewport;      // render target size in px
  uniform float uMaxPointSize;
  uniform vec3 uClipMin;       // clipping box, world space
  uniform vec3 uClipMax;

  out vec3 vCenterView;        // sphere centre in view space
  out float vRadius;
  out vec3 vColor;

  void main() {
    // Balls whose centre falls inside the clipping box are culled outright:
    // pushing the vertex outside the clip volume drops the whole point sprite.
    if (all(greaterThanEqual(aPosition, uClipMin)) &&
        all(lessThanEqual(aPosition, uClipMax))) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec4 centerView = uView * vec4(aPosition, 1.0);
    vCenterView = centerView.xyz;
    vRadius = aRadius;
    vColor = aColor;

    gl_Position = uProj * centerView;

    // The sprite must cover the whole silhouette. A sphere projects to an
    // ellipse that grows the further off-axis it sits, so bound it with the
    // radial extent: half-angle theta about the centre, which is at angle phi
    // from the view axis, spans tan(phi+theta) - tan(phi) on its far side.
    float d = length(centerView.xyz);
    if (d <= aRadius) {
      gl_PointSize = uMaxPointSize;          // eye is inside the sphere
    } else {
      float theta = asin(aRadius / d);
      float phi = atan(length(centerView.xy), -centerView.z);
      float extent = tan(min(phi + theta, 1.5533)) - tan(phi);   // clamp near 89deg
      // NDC = proj[i][i] * extent, and NDC -> px is viewport * 0.5.
      float px = max(uProj[0][0] * uViewport.x, uProj[1][1] * uViewport.y) * extent * 0.5;
      gl_PointSize = clamp(2.0 * px, 1.0, uMaxPointSize);
    }
  }`;

  const SPHERE_FRAG = `#version 300 es
  precision highp float;

  in vec3 vCenterView;
  in float vRadius;
  in vec3 vColor;

  uniform mat4 uProj;
  uniform vec2 uViewport;
  uniform float uRough;

  layout(location = 0) out vec4 oColor;    // linear; gamma happens at composite
  layout(location = 1) out vec4 oNormal;   // view-space normal, encoded

  void main() {
    // Rebuild this fragment's view ray from its pixel coordinate rather than
    // from gl_PointCoord, so the enlarged sprite stays geometrically exact.
    vec2 ndc = (gl_FragCoord.xy / uViewport) * 2.0 - 1.0;
    vec3 rayDir = normalize(vec3(ndc.x / uProj[0][0], ndc.y / uProj[1][1], -1.0));

    // Ray-sphere intersection, ray origin at the eye (0,0,0).
    float b = dot(rayDir, vCenterView);
    float c = dot(vCenterView, vCenterView) - vRadius * vRadius;
    float disc = b * b - c;
    if (disc < 0.0) discard;                      // outside the silhouette
    float t = b - sqrt(disc);
    if (t < 0.0) discard;                         // sphere behind the eye

    vec3 hit = rayDir * t;
    vec3 normal = (hit - vCenterView) / vRadius;

    // Real per-pixel depth: this is what makes spheres intersect each other,
    // and it is what the SSAO pass reads back as geometry.
    vec4 clip = uProj * vec4(hit, 1.0);
    gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;

    // Blinn-Phong with a key light plus a little ambient/rim fill. uRough runs
    // 0 (a tight mirror glint) to 1 (matte), widening the highlight and fading
    // it out together — a rougher surface spreads the same energy over more of
    // the sphere, so a broad highlight has to be a dimmer one.
    vec3 L = normalize(vec3(0.4, 0.7, 0.6));
    vec3 V = -normalize(hit);
    vec3 H = normalize(L + V);
    float diff = max(dot(normal, L), 0.0);
    float shine = exp2(1.0 + 10.0 * (1.0 - uRough));
    float spec = pow(max(dot(normal, H), 0.0), shine) * (1.0 - uRough);
    float rim = pow(1.0 - max(dot(normal, V), 0.0), 3.0);

    oColor = vec4(vColor * (0.18 + 0.82 * diff) + vec3(0.9) * spec * 0.6 + vColor * rim * 0.35, 1.0);
    oNormal = vec4(normal * 0.5 + 0.5, 1.0);
  }`;

  // --- fullscreen passes --------------------------------------------------

  // Single oversized triangle, no attributes needed.
  const FULLSCREEN_VERT = `#version 300 es
  precision highp float;
  out vec2 vUV;
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUV = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const AO_FRAG = `#version 300 es
  precision highp float;

  in vec2 vUV;

  uniform sampler2D uDepth;
  uniform sampler2D uNormal;
  uniform mat4 uProj;
  uniform vec3 uKernel[${AO_KERNEL_SIZE}];
  uniform float uRadius;       // occlusion radius, view-space units
  uniform float uBias;
  uniform float uIntensity;

  out vec4 oAO;

  // Undo the projection's z mapping: ndcZ = (c*z + d) / -z.
  float viewZ(float ndcZ) {
    return -uProj[3][2] / (ndcZ + uProj[2][2]);
  }

  vec3 viewPos(vec2 uv, float depth) {
    vec2 ndc = uv * 2.0 - 1.0;
    float z = viewZ(depth * 2.0 - 1.0);
    // Point on the z=-1 plane through this pixel, pushed out to the real depth.
    return vec3(ndc.x / uProj[0][0], ndc.y / uProj[1][1], -1.0) * (-z);
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    float depth = texture(uDepth, vUV).r;
    if (depth >= 1.0 || uIntensity <= 0.0) { oAO = vec4(1.0); return; }

    vec3 P = viewPos(vUV, depth);
    vec3 N = normalize(texture(uNormal, vUV).xyz * 2.0 - 1.0);

    // Per-pixel rotation of the kernel; the blur pass averages the noise out.
    float ang = hash(gl_FragCoord.xy) * 6.2831853;
    vec3 rv = vec3(cos(ang), sin(ang), 0.0);
    vec3 T = normalize(rv - N * dot(rv, N));
    mat3 TBN = mat3(T, cross(N, T), N);

    float occ = 0.0;
    for (int i = 0; i < ${AO_KERNEL_SIZE}; i++) {
      vec3 sp = P + TBN * uKernel[i] * uRadius;      // sample in the hemisphere
      vec4 clip = uProj * vec4(sp, 1.0);
      vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

      float sd = texture(uDepth, suv).r;
      if (sd >= 1.0) continue;                       // background occludes nothing

      // Larger z is nearer the eye: geometry in front of the sample occludes it.
      float sceneZ = viewZ(sd * 2.0 - 1.0);
      float range = smoothstep(0.0, 1.0, uRadius / max(abs(P.z - sceneZ), 1e-4));
      occ += (sceneZ >= sp.z + uBias ? 1.0 : 0.0) * range;
    }

    oAO = vec4(clamp(1.0 - (occ / float(${AO_KERNEL_SIZE})) * uIntensity, 0.0, 1.0));
  }`;

  const COMPOSITE_FRAG = `#version 300 es
  precision highp float;

  in vec2 vUV;

  uniform sampler2D uColor;
  uniform sampler2D uAO;
  uniform vec2 uAOTexel;

  out vec4 oColor;

  void main() {
    // 4x4 box blur to kill the per-pixel kernel rotation noise.
    float ao = 0.0;
    for (int y = -2; y < 2; y++) {
      for (int x = -2; x < 2; x++) {
        ao += texture(uAO, vUV + vec2(float(x) + 0.5, float(y) + 0.5) * uAOTexel).r;
      }
    }
    ao /= 16.0;

    vec3 col = texture(uColor, vUV).rgb * ao;
    oColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
  }`;

  // --- overlay lines (clip box wireframe + gizmo) -------------------------
  //
  // Drawn straight to the default framebuffer after the composite, so they are
  // already in sRGB and always on top. Gizmo handles you cannot see are gizmo
  // handles you cannot grab, and the box interior is empty anyway.

  const LINE_VERT = `#version 300 es
  precision highp float;

  in vec3 aLinePos;
  in vec3 aLineColor;

  uniform mat4 uView;
  uniform mat4 uProj;

  out vec3 vLineColor;

  void main() {
    vLineColor = aLineColor;
    gl_Position = uProj * uView * vec4(aLinePos, 1.0);
  }`;

  const LINE_FRAG = `#version 300 es
  precision highp float;
  in vec3 vLineColor;
  out vec4 oColor;
  void main() { oColor = vec4(vLineColor, 1.0); }`;

  // --- minimal mat4 helpers (column-major, as WebGL expects) --------------

  function mat4Identity() {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  }

  function mat4Perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }

  // View = translate(0,0,-dist) * rotX(pitch) * rotY(yaw)
  function mat4View(out, yaw, pitch, dist) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    out[0] = cy;       out[1] = sp * sy;   out[2] = -cp * sy;  out[3] = 0;
    out[4] = 0;        out[5] = cp;        out[6] = sp;        out[7] = 0;
    out[8] = sy;       out[9] = -sp * cy;  out[10] = cp * cy;  out[11] = 0;
    out[12] = 0;       out[13] = 0;        out[14] = -dist;    out[15] = 1;
    return out;
  }

  // Hemisphere samples, biased towards the origin so nearby geometry dominates.
  function makeKernel(n) {
    const k = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let x, y, z, len;
      do {
        x = Math.random() * 2 - 1;
        y = Math.random() * 2 - 1;
        z = Math.random();
        len = Math.sqrt(x * x + y * y + z * z);
      } while (len > 1 || len < 1e-3);
      const t = (i + 1) / n;
      const s = (0.1 + 0.9 * t * t) / len;
      k[i * 3 + 0] = x * s;
      k[i * 3 + 1] = y * s;
      k[i * 3 + 2] = z * s;
    }
    return k;
  }

  // --- gizmo geometry / picking helpers -----------------------------------

  const AXIS_COLOR = [[0.95, 0.32, 0.32], [0.40, 0.85, 0.40], [0.36, 0.62, 1.0]];
  const AXIS_HOT = [1.0, 0.85, 0.30];
  const EDGE_COLOR = [0.55, 0.62, 0.74];
  const PICK_PX = 11;           // grab radius around a handle, CSS px

  /** Distance from point p to segment ab, all in 2D. */
  function distToSegment(p, a, b) {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = p[0] - (a[0] + abx * t), dy = p[1] - (a[1] + aby * t);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Parameter along the line C + s*A of the point closest to the ray O + u*D.
   * Both A and D are unit; returns null when they are near-parallel and the
   * closest point is therefore undefined (drag would explode).
   */
  function closestOnAxis(C, A, O, D) {
    const wx = C[0] - O[0], wy = C[1] - O[1], wz = C[2] - O[2];
    const b = A[0] * D[0] + A[1] * D[1] + A[2] * D[2];
    const d = A[0] * wx + A[1] * wy + A[2] * wz;
    const e = D[0] * wx + D[1] * wy + D[2] * wz;
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-4) return null;
    return (b * e - d) / denom;
  }

  // --- GL plumbing --------------------------------------------------------

  function compile(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function link(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p));
    }
    return p;
  }

  function uniforms(gl, prog, names) {
    const out = {};
    for (const n of names) out[n] = gl.getUniformLocation(prog, 'u' + n[0].toUpperCase() + n.slice(1));
    return out;
  }

  function makeTexture(gl, internalFormat, format, type, filter) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, internalFormat, format, type };
  }

  function create(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is required (gl_FragDepth and MRT are not in WebGL1).');

    const sphereProg = link(gl, SPHERE_VERT, SPHERE_FRAG);
    const aoProg = link(gl, FULLSCREEN_VERT, AO_FRAG);
    const compProg = link(gl, FULLSCREEN_VERT, COMPOSITE_FRAG);
    const lineProg = link(gl, LINE_VERT, LINE_FRAG);

    const sphereU = uniforms(gl, sphereProg, ['view', 'proj', 'viewport', 'maxPointSize', 'clipMin', 'clipMax', 'rough']);
    const lineU = uniforms(gl, lineProg, ['view', 'proj']);
    const aoU = uniforms(gl, aoProg, ['depth', 'normal', 'proj', 'radius', 'bias', 'intensity']);
    aoU.kernel = gl.getUniformLocation(aoProg, 'uKernel[0]');   // arrays want the [0] form
    const compU = uniforms(gl, compProg, ['color', 'aO', 'aOTexel']);

    const attr = {
      position: gl.getAttribLocation(sphereProg, 'aPosition'),
      radius: gl.getAttribLocation(sphereProg, 'aRadius'),
      color: gl.getAttribLocation(sphereProg, 'aColor'),
    };

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    function makeBuffer(location, components) {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);
      return buf;
    }

    const buffers = {
      position: makeBuffer(attr.position, 3),
      radius: makeBuffer(attr.radius, 1),
      color: makeBuffer(attr.color, 3),
    };
    gl.bindVertexArray(null);

    const lineVao = gl.createVertexArray();
    gl.bindVertexArray(lineVao);
    const lineBuffers = {
      position: makeBuffer(gl.getAttribLocation(lineProg, 'aLinePos'), 3),
      color: makeBuffer(gl.getAttribLocation(lineProg, 'aLineColor'), 3),
    };
    gl.bindVertexArray(null);

    const maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    const kernel = makeKernel(AO_KERNEL_SIZE);

    const proj = mat4Identity();
    const view = mat4Identity();

    const state = {
      count: 0,
      yaw: -Math.PI / 4,    // 90 degrees
      pitch: Math.PI / 4,  // 45 degrees, looking down
      dist: 1, // not affected here
      autoSpin: 0,         // rad/s, default idle orbit off
      superSample: 1,      // >1 renders the G-buffer larger and downsamples
      rough: 0.4,          // specular spread, 0 = mirror glint, 1 = matte
      background: [0.043, 0.051, 0.071],   // sRGB, matching the page behind us
      ao: { radius: 0.35, bias: 0.02, intensity: 1.0 },
      clip: {
        center: [0, 0, 0],
        size: [1.6, 1.6, 1.6],   // full extents; the box is never rotated
        showEdges: true,
        showGizmo: true,
      },
      running: false,
    };

    // The clear color lands in the G-buffer, which the composite pass gammas
    // on its way to the screen — so store the linear value and the picked sRGB
    // one survives the round trip intact.
    function applyBackground() {
      const b = state.background;
      gl.clearColor(Math.pow(b[0], 2.2), Math.pow(b[1], 2.2), Math.pow(b[2], 2.2), 1);
    }
    applyBackground();

    // Which axis the pointer is over / dragging, and in which mode. Left
    // Control swaps translate for scale; the mode is latched at grab time so a
    // drag never changes meaning under your hand.
    const gizmo = { hover: -1, axis: -1, mode: 'translate', ctrl: false, s0: 0, base: 0 };

    const clipMin = new Float32Array(3);
    const clipMax = new Float32Array(3);

    function clipBounds() {
      for (let i = 0; i < 3; i++) {
        const h = Math.abs(state.clip.size[i]) * 0.5;
        clipMin[i] = state.clip.center[i] - h;
        clipMax[i] = state.clip.center[i] + h;
      }
    }

    // --- G-buffer + AO target ---------------------------------------------

    const targets = { w: 0, h: 0 };

    function allocTargets(w, h) {
      if (targets.w === w && targets.h === h) return;
      targets.w = w;
      targets.h = h;

      if (!targets.color) {
        targets.color = makeTexture(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
        targets.normal = makeTexture(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
        targets.depth = makeTexture(gl, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
        targets.ao = makeTexture(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
        targets.gFbo = gl.createFramebuffer();
        targets.aoFbo = gl.createFramebuffer();
      }

      for (const t of [targets.color, targets.normal, targets.depth, targets.ao]) {
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, t.internalFormat, w, h, 0, t.format, t.type, null);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);

      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.gFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targets.color.tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, targets.normal.tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, targets.depth.tex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.aoFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targets.ao.tex, 0);

      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) throw new Error('Incomplete framebuffer at ' + w + 'x' + h);
    }

    // --- attribute upload; call any of these every frame -------------------

    function upload(buffer, data) {
      const arr = data instanceof Float32Array ? data : new Float32Array(data);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      // bufferData with DYNAMIC_DRAW grows the store; bufferSubData is used on
      // the steady-state path where the size is unchanged.
      if (arr.byteLength === (buffer._size | 0)) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, arr);
      } else {
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
        buffer._size = arr.byteLength;
      }
    }

    // --- camera matrices, projection and unprojection ----------------------

    function updateMatrices() {
      const aspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight);
      mat4Perspective(proj, (50 * Math.PI) / 180, aspect, 0.1, 100);
      mat4View(view, state.yaw, state.pitch, state.dist);
    }

    /** World point -> CSS pixels within the canvas, or null if behind the eye. */
    function project(p) {
      const vx = view[0] * p[0] + view[4] * p[1] + view[8] * p[2] + view[12];
      const vy = view[1] * p[0] + view[5] * p[1] + view[9] * p[2] + view[13];
      const vz = view[2] * p[0] + view[6] * p[1] + view[10] * p[2] + view[14];
      const w = -vz;
      if (w <= 1e-4) return null;
      return [
        ((proj[0] * vx) / w * 0.5 + 0.5) * canvas.clientWidth,
        (0.5 - (proj[5] * vy) / w * 0.5) * canvas.clientHeight,
      ];
    }

    function localXY(e) {
      const rect = canvas.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    }

    /** Eye ray through the pointer, in world space. */
    function pointerRay(e) {
      const rect = canvas.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = 1 - ((e.clientY - rect.top) / rect.height) * 2;
      // View-space ray, then rotated into world by the transpose of the view
      // rotation (which is its inverse, the view matrix being rigid).
      const dv = [nx / proj[0], ny / proj[5], -1];
      const d = [
        view[0] * dv[0] + view[1] * dv[1] + view[2] * dv[2],
        view[4] * dv[0] + view[5] * dv[1] + view[6] * dv[2],
        view[8] * dv[0] + view[9] * dv[1] + view[10] * dv[2],
      ];
      const len = Math.hypot(d[0], d[1], d[2]);
      d[0] /= len; d[1] /= len; d[2] /= len;
      const o = [view[2] * state.dist, view[6] * state.dist, view[10] * state.dist];
      return { o, d };
    }

    // --- gizmo ------------------------------------------------------------

    function scaleMode() {
      return gizmo.axis >= 0 ? gizmo.mode === 'scale' : gizmo.ctrl;
    }

    // Handles sit clear of the box face so they stay grabbable however small
    // the box gets; dragging only ever uses the *change* in the parameter, so
    // the offset itself never enters the arithmetic.
    function handleLen(a, scale) {
      return Math.abs(state.clip.size[a]) * 0.5 + (scale ? 0.10 : 0.22) * state.dist;
    }

    function pickAxis(px, py) {
      if (!state.clip.showGizmo) return -1;
      const c = state.clip.center;
      const origin = project(c);
      const scale = scaleMode();
      let best = -1, bestD = PICK_PX;
      for (let a = 0; a < 3; a++) {
        const tip = c.slice();
        tip[a] += handleLen(a, scale);
        const p1 = project(tip);
        if (!p1) continue;
        // Only the outer 65% of the shaft is pickable, so the three axes do not
        // fight over the pixels bunched up at the box centre.
        const p0 = origin
          ? [origin[0] + (p1[0] - origin[0]) * 0.35, origin[1] + (p1[1] - origin[1]) * 0.35]
          : p1;
        const d = distToSegment([px, py], p0, p1);
        if (d < bestD) { bestD = d; best = a; }
      }
      return best;
    }

    // --- overlay line list, rebuilt each frame -----------------------------

    const linePos = [];
    const lineCol = [];

    function seg(a, b, col) {
      linePos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      lineCol.push(col[0], col[1], col[2], col[0], col[1], col[2]);
    }

    function boxEdges(c, hx, hy, hz, col) {
      const xs = [c[0] - hx, c[0] + hx];
      const ys = [c[1] - hy, c[1] + hy];
      const zs = [c[2] - hz, c[2] + hz];
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          seg([xs[0], ys[i], zs[j]], [xs[1], ys[i], zs[j]], col);
          seg([xs[i], ys[0], zs[j]], [xs[i], ys[1], zs[j]], col);
          seg([xs[i], ys[j], zs[0]], [xs[i], ys[j], zs[1]], col);
        }
      }
    }

    /** Wireframe cone pointing down +axis, tip at `tip`. */
    function cone(tip, axis, r, len, col) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      let prev = null, first = null;
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2;
        const p = tip.slice();
        p[axis] -= len;
        p[u] += Math.cos(ang) * r;
        p[v] += Math.sin(ang) * r;
        seg(p, tip, col);
        if (prev) seg(prev, p, col); else first = p;
        prev = p;
      }
      seg(prev, first, col);
    }

    function buildLines() {
      linePos.length = 0;
      lineCol.length = 0;
      const c = state.clip.center;

      if (state.clip.showEdges) {
        const s = state.clip.size;
        boxEdges(c, Math.abs(s[0]) * 0.5, Math.abs(s[1]) * 0.5, Math.abs(s[2]) * 0.5, EDGE_COLOR);
      }

      if (state.clip.showGizmo) {
        const scale = scaleMode();
        const k = 0.035 * state.dist;      // ornament size, ~constant on screen
        for (let a = 0; a < 3; a++) {
          const lit = gizmo.axis >= 0 ? gizmo.axis === a : gizmo.hover === a;
          const col = lit ? AXIS_HOT : AXIS_COLOR[a];
          const tip = c.slice();
          tip[a] += handleLen(a, scale);
          seg(c, tip, col);
          if (scale) boxEdges(tip, k * 0.6, k * 0.6, k * 0.6, col);
          else cone(tip, a, k * 0.55, k * 1.9, col);
        }
      }
    }

    const api = {
      gl,
      canvas,

      /** positions: xyz triples; radii: one float per sphere; colors: rgb triples. */
      setSpheres({ positions, radii, colors }) {
        state.count = positions.length / 3;
        upload(buffers.position, positions);
        upload(buffers.radius, radii);
        upload(buffers.color, colors);
        return api;
      },

      /** Any of { yaw, pitch, dist, autoSpin }. */
      setCamera(opts) {
        for (const k of ['yaw', 'pitch', 'dist', 'autoSpin']) {
          if (opts[k] !== undefined) state[k] = opts[k];
        }
        return api;
      },

      /** Any of { radius, bias, intensity }. intensity 0 switches SSAO off. */
      setAO(opts) {
        Object.assign(state.ao, opts);
        return api;
      },

      /**
       * Clipping box: balls whose centre lands inside it are not drawn.
       * Any of { center, size, showEdges, showGizmo }; center/size are xyz
       * arrays. The box is axis-aligned and cannot be rotated.
       */
      setClip(opts) {
        if (opts.center) state.clip.center = [+opts.center[0], +opts.center[1], +opts.center[2]];
        if (opts.size) state.clip.size = [+opts.size[0], +opts.size[1], +opts.size[2]];
        if (opts.showEdges !== undefined) state.clip.showEdges = !!opts.showEdges;
        if (opts.showGizmo !== undefined) state.clip.showGizmo = !!opts.showGizmo;
        return api;
      },

      /** { superSample } — 2 supersamples the G-buffer, costs 4x the fill. */
      setQuality(opts) {
        if (opts.superSample !== undefined) state.superSample = opts.superSample;
        return api;
      },

      /** { roughness } — how the balls take the key light's highlight, 0..1. */
      setMaterial(opts) {
        if (opts.roughness !== undefined) {
          state.rough = Math.min(1, Math.max(0, +opts.roughness));
        }
        return api;
      },

      /** Background, as an rgb array of sRGB values in 0..1. */
      setBackground(rgb) {
        state.background = [+rgb[0], +rgb[1], +rgb[2]];
        applyBackground();
        return api;
      },

      /** Snapshot of the current settings (for UI to read defaults from). */
      settings() {
        return {
          yaw: state.yaw, pitch: state.pitch, dist: state.dist, autoSpin: state.autoSpin,
          superSample: state.superSample, ao: Object.assign({}, state.ao), count: state.count,
          roughness: state.rough, background: state.background.slice(),
          clip: {
            center: state.clip.center.slice(), size: state.clip.size.slice(),
            showEdges: state.clip.showEdges, showGizmo: state.clip.showGizmo,
          },
        };
      },

      updatePositions(positions) { upload(buffers.position, positions); },
      updateRadii(radii) { upload(buffers.radius, radii); },
      updateColors(colors) { upload(buffers.color, colors); },

      /** Called with elapsed seconds before each draw; rewrite attributes here. */
      onFrame: null,

      render() {
        const dpr = Math.min(global.devicePixelRatio || 1, 2);
        const cw = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== cw || canvas.height !== ch) {
          canvas.width = cw;
          canvas.height = ch;
        }

        const ss = state.superSample;
        const w = Math.max(1, Math.round(cw * ss));
        const h = Math.max(1, Math.round(ch * ss));
        allocTargets(w, h);

        updateMatrices();
        clipBounds();

        // 1. scene -> G-buffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets.gFbo);
        gl.viewport(0, 0, w, h);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        if (state.count > 0) {
          gl.useProgram(sphereProg);
          gl.uniformMatrix4fv(sphereU.proj, false, proj);
          gl.uniformMatrix4fv(sphereU.view, false, view);
          gl.uniform2f(sphereU.viewport, w, h);
          gl.uniform1f(sphereU.maxPointSize, maxPointSize);
          gl.uniform3fv(sphereU.clipMin, clipMin);
          gl.uniform3fv(sphereU.clipMax, clipMax);
          gl.uniform1f(sphereU.rough, state.rough);
          gl.bindVertexArray(vao);
          gl.drawArrays(gl.POINTS, 0, state.count);
          gl.bindVertexArray(null);
        }

        gl.disable(gl.DEPTH_TEST);

        // 2. SSAO
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets.aoFbo);
        gl.viewport(0, 0, w, h);
        gl.useProgram(aoProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, targets.depth.tex);
        gl.uniform1i(aoU.depth, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, targets.normal.tex);
        gl.uniform1i(aoU.normal, 1);
        gl.uniformMatrix4fv(aoU.proj, false, proj);
        gl.uniform3fv(aoU.kernel, kernel);
        gl.uniform1f(aoU.radius, state.ao.radius);
        gl.uniform1f(aoU.bias, state.ao.bias);
        gl.uniform1f(aoU.intensity, state.ao.intensity);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // 3. blur AO + composite to the screen (linear filtering on the color
        //    texture downsamples for free when superSample > 1)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, cw, ch);
        gl.useProgram(compProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, targets.color.tex);
        gl.uniform1i(compU.color, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, targets.ao.tex);
        gl.uniform1i(compU.aO, 1);
        gl.uniform2f(compU.aOTexel, 1 / w, 1 / h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // 4. clip-box wireframe + gizmo, straight over the composited image
        buildLines();
        if (linePos.length) {
          upload(lineBuffers.position, linePos);
          upload(lineBuffers.color, lineCol);
          gl.useProgram(lineProg);
          gl.uniformMatrix4fv(lineU.proj, false, proj);
          gl.uniformMatrix4fv(lineU.view, false, view);
          gl.bindVertexArray(lineVao);
          gl.drawArrays(gl.LINES, 0, linePos.length / 3);
          gl.bindVertexArray(null);
        }
      },

      start() {
        if (state.running) return api;
        state.running = true;
        const t0 = performance.now();
        let prev = t0;
        const loop = (now) => {
          if (!state.running) return;
          const t = (now - t0) / 1000;
          state.yaw += state.autoSpin * ((now - prev) / 1000);
          prev = now;
          if (api.onFrame) api.onFrame(t);
          api.render();
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        return api;
      },

      stop() { state.running = false; },
    };

    // --- drag the gizmo, else orbit; wheel to zoom -------------------------
    let dragging = false, lastX = 0, lastY = 0;
    let dragOrigin = null;      // box centre latched at grab time

    // Parameter along the grabbed axis of the point nearest the pointer ray.
    function axisParam(e) {
      const A = [0, 0, 0];
      A[gizmo.axis] = 1;
      const r = pointerRay(e);
      return closestOnAxis(dragOrigin, A, r.o, r.d);
    }

    canvas.addEventListener('pointerdown', (e) => {
      gizmo.ctrl = e.ctrlKey;
      updateMatrices();
      state.autoSpin = 0;
      canvas.setPointerCapture(e.pointerId);

      const xy = localXY(e);
      const a = pickAxis(xy[0], xy[1]);
      if (a >= 0) {
        const scale = scaleMode();
        dragOrigin = state.clip.center.slice();
        gizmo.axis = a;
        gizmo.mode = scale ? 'scale' : 'translate';
        const s = axisParam(e);
        if (s !== null) {
          gizmo.s0 = s;
          gizmo.base = scale ? Math.abs(state.clip.size[a]) * 0.5 : state.clip.center[a];
          return;
        }
        gizmo.axis = -1;     // axis edge-on to the eye: nothing to drag along
      }

      dragging = true; lastX = e.clientX; lastY = e.clientY;
    });

    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      gizmo.axis = -1;
      canvas.releasePointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (gizmo.axis >= 0) {
        const s = axisParam(e);
        if (s === null) return;
        if (gizmo.mode === 'scale') {
          // The handle tracks the face, so the half-extent follows the pointer.
          state.clip.size[gizmo.axis] = Math.max(0.02, (gizmo.base + (s - gizmo.s0)) * 2);
        } else {
          state.clip.center[gizmo.axis] = gizmo.base + (s - gizmo.s0);
        }
        return;
      }

      if (dragging) {
        state.yaw += (e.clientX - lastX) * 0.008;
        state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch + (e.clientY - lastY) * 0.008));
        lastX = e.clientX; lastY = e.clientY;
        return;
      }

      gizmo.ctrl = e.ctrlKey;
      const xy = localXY(e);
      gizmo.hover = pickAxis(xy[0], xy[1]);
      canvas.style.cursor = gizmo.hover >= 0 ? 'grab' : '';
    });

    // Left Control swaps the gizmo between translate and scale.
    global.addEventListener('keydown', (e) => { if (e.key === 'Control') gizmo.ctrl = true; });
    global.addEventListener('keyup', (e) => { if (e.key === 'Control') gizmo.ctrl = false; });
    global.addEventListener('blur', () => { gizmo.ctrl = false; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.dist = Math.max(1.5, Math.min(40, state.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });

    return api;
  }

  global.AtomicOrbitals = { create };
})(window);
