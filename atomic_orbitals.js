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
 *   1. scene -> G-buffer   (MRT: linear colour + view-space normal, depth texture)
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

  out vec3 vCenterView;        // sphere centre in view space
  out float vRadius;
  out vec3 vColor;

  void main() {
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

    // Blinn-Phong with a key light plus a little ambient/rim fill.
    vec3 L = normalize(vec3(0.4, 0.7, 0.6));
    vec3 V = -normalize(hit);
    vec3 H = normalize(L + V);
    float diff = max(dot(normal, L), 0.0);
    float spec = pow(max(dot(normal, H), 0.0), 48.0);
    float rim = pow(1.0 - max(dot(normal, V), 0.0), 3.0);

    oColor = vec4(vColor * (0.18 + 0.82 * diff) + vec3(0.9) * spec * 0.5 + vColor * rim * 0.35, 1.0);
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

    const sphereU = uniforms(gl, sphereProg, ['view', 'proj', 'viewport', 'maxPointSize']);
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

    const maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    const kernel = makeKernel(AO_KERNEL_SIZE);

    gl.clearColor(0.043, 0.051, 0.071, 1);

    const proj = mat4Identity();
    const view = mat4Identity();

    const state = {
      count: 0,
      yaw: 0.6,
      pitch: 0.3,
      dist: 6,
      autoSpin: 0.15,      // rad/s, disabled once the user drags
      superSample: 1,      // >1 renders the G-buffer larger and downsamples
      ao: { radius: 0.35, bias: 0.02, intensity: 1.0 },
      running: false,
    };

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

      /** { superSample } — 2 supersamples the G-buffer, costs 4x the fill. */
      setQuality(opts) {
        if (opts.superSample !== undefined) state.superSample = opts.superSample;
        return api;
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

        mat4Perspective(proj, (50 * Math.PI) / 180, cw / ch, 0.1, 100);
        mat4View(view, state.yaw, state.pitch, state.dist);

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

        // 3. blur AO + composite to the screen (linear filtering on the colour
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

    // --- drag to orbit, wheel to zoom -------------------------------------
    let dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      state.autoSpin = 0;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      state.yaw += (e.clientX - lastX) * 0.008;
      state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch + (e.clientY - lastY) * 0.008));
      lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.dist = Math.max(1.5, Math.min(40, state.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });

    return api;
  }

  global.AtomicOrbitals = { create };
})(window);
