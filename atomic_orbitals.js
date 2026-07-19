/*
 * atomic_orbitals.js — WebGL2 sphere-impostor renderer.
 *
 * Every sphere is a single vertex drawn as a point sprite. The fragment shader
 * ray-traces the sphere inside the sprite, so it shades like a real 3D ball and
 * writes gl_FragDepth, which means sprites depth-test and interpenetrate
 * correctly against each other (a flat sprite would only sort by centre).
 *
 * All vertex attributes live in dynamic buffers and can be rewritten each frame
 * via updatePositions() / updateRadii() / updateColors().
 */
(function (global) {
  'use strict';

  const VERT = `#version 300 es
  precision highp float;

  in vec3 aPosition;
  in float aRadius;
  in vec3 aColor;

  uniform mat4 uView;
  uniform mat4 uProj;
  uniform vec2 uViewport;      // drawing buffer size in px
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

  const FRAG = `#version 300 es
  precision highp float;

  in vec3 vCenterView;
  in float vRadius;
  in vec3 vColor;

  uniform mat4 uProj;
  uniform vec2 uViewport;

  out vec4 fragColor;

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

    // Real per-pixel depth: this is what makes spheres intersect each other.
    vec4 clip = uProj * vec4(hit, 1.0);
    gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;

    // Blinn-Phong with a key light plus a little ambient/rim fill.
    vec3 L = normalize(vec3(0.4, 0.7, 0.6));
    vec3 V = -normalize(hit);
    vec3 H = normalize(L + V);
    float diff = max(dot(normal, L), 0.0);
    float spec = pow(max(dot(normal, H), 0.0), 48.0);
    float rim = pow(1.0 - max(dot(normal, V), 0.0), 3.0);

    vec3 col = vColor * (0.18 + 0.82 * diff) + vec3(0.9) * spec * 0.5 + vColor * rim * 0.35;
    fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
  }`;

  // --- minimal mat4 helpers (column-major, as WebGL expects) ---------------

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

  function mat4Multiply(out, a, b) {
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
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

  // --- GL plumbing ---------------------------------------------------------

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

  function create(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is required (gl_FragDepth is not in WebGL1).');

    const prog = link(gl, VERT, FRAG);
    const loc = {
      view: gl.getUniformLocation(prog, 'uView'),
      proj: gl.getUniformLocation(prog, 'uProj'),
      viewport: gl.getUniformLocation(prog, 'uViewport'),
      maxPointSize: gl.getUniformLocation(prog, 'uMaxPointSize'),
    };
    const attr = {
      position: gl.getAttribLocation(prog, 'aPosition'),
      radius: gl.getAttribLocation(prog, 'aRadius'),
      color: gl.getAttribLocation(prog, 'aColor'),
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

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0.043, 0.051, 0.071, 1);

    const proj = mat4Identity();
    const view = mat4Identity();

    const state = {
      count: 0,
      yaw: 0.6,
      pitch: 0.3,
      dist: 6,
      autoSpin: 0.15,   // rad/s, disabled once the user drags
      onFrame: null,
      running: false,
    };

    // --- attribute upload; call any of these every frame ------------------

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

      updatePositions(positions) { upload(buffers.position, positions); },
      updateRadii(radii) { upload(buffers.radius, radii); },
      updateColors(colors) { upload(buffers.color, colors); },

      /** Called with elapsed seconds before each draw; rewrite attributes here. */
      onFrame: null,

      render() {
        const dpr = Math.min(global.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (state.count === 0) return;

        mat4Perspective(proj, (50 * Math.PI) / 180, w / h, 0.1, 100);
        mat4View(view, state.yaw, state.pitch, state.dist);

        gl.useProgram(prog);
        gl.uniformMatrix4fv(loc.proj, false, proj);
        gl.uniformMatrix4fv(loc.view, false, view);
        gl.uniform2f(loc.viewport, w, h);
        gl.uniform1f(loc.maxPointSize, maxPointSize);

        gl.bindVertexArray(vao);
        gl.drawArrays(gl.POINTS, 0, state.count);
        gl.bindVertexArray(null);
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
          const cb = api.onFrame || state.onFrame;
          if (cb) cb(t);
          api.render();
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        return api;
      },

      stop() { state.running = false; },
    };

    // --- drag to orbit, wheel to zoom ------------------------------------
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
