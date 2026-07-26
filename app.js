/*
 * app.js — the scene: samples an orbital into a ball cloud and wires up the
 * UI. Hydrogen uses the exact analytic eigenstates; every other atom shows
 * its occupied Hartree-Fock orbitals out of the cc-pVDZ basis-set table.
 * Rendering lives in atomic_orbitals.js, controls in ui.js, the wavefunction
 * maths in orbital.js, the basis-set parsing in basis.js.
 *
 * With flow on, the cloud is sampled from the *complex* eigenstate and each
 * ball rides the Bohmian velocity field v = (hbar/m_e) grad(arg psi). The
 * phase of psi_nlm is e^(i m phi), so v is a pure circulation about the
 * quantization axis, omega = m / rho^2 in atomic units (rho = distance from
 * the axis) — angular momentum L_z = m hbar made visible. Every ball orbits
 * its own circle of constant rho and z, and because |psi|^2 of the complex
 * state is axially symmetric, the aggregate density is *exactly* invariant:
 * only the individual balls move, no resampling required.
 *
 * With flow off (or m = 0) the state is real, a standing wave whose phase has
 * no gradient, so the velocity field vanishes and the balls sit still.
 */
(function () {
  'use strict';

  const N0 = 300000;          // starting ball count; the UI slider changes it
  const R_WORLD = 2.0;        // the cloud is scaled to roughly this radius
  const Q0 = { n: 7, l: 3, m: 1 };
  const P0 = { solid: true, h: 100, s: 1, l: 0.6 };
  const F0 = { on: true, speed: 0.30 };

  // Flow pacing. True omega = m/rho^2 in atomic units spans decades across n
  // (rho ~ n^2 Bohr), so time is rescaled per orbital: the ball at the cloud's
  // rms axial radius circles at OMEGA_REF * |m| rad/s at speed 1. The ∝m and
  // ∝1/rho^2 structure — outer balls lag, inner balls whirl — is untouched.
  // OMEGA_MAX caps the rare near-axis speedsters that would strobe.
  const OMEGA_REF = 0.5;
  const OMEGA_MAX = 6;

  // Blackbody ramp, following the reference shader: cold red through to a hot
  // near-white. `i` runs 0..1.
  function blackbody(i, out) {
    const T = 1400 + 1400 * i;
    const L = [7.4, 5.6, 4.4];      // r,g,b wavelengths, hundreds of nm
    for (let c = 0; c < 3; c++) {
      const w = Math.pow(L[c], 5) * (Math.exp(1.43876719683e5 / (T * L[c])) - 1);
      out[c] = 1 - Math.exp(-5e8 / w);
    }
    return out;
  }

  /**
   * HSL to linear RGB. h in degrees, s and l in 0..1. The shader's colors are
   * linear (the composite pass gammas on the way out), but the slider values
   * are picked by eye, so undo sRGB's curve on the way in — otherwise every
   * choice lands washed out.
   */
  function hslToLinear(h, s, l, out) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = ((h % 360) + 360) % 360 / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = l - c / 2;
    const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
    const rgb = seg[Math.floor(hp) % 6];
    for (let i = 0; i < 3; i++) out[i] = Math.pow(rgb[i] + m, 2.2);
    return out;
  }

  /**
   * Fills a cloud's color buffer from its per-ball tone (0..1, how dense the
   * neighbourhood is) and sign (which lobe). Split out from buildCloud so the
   * palette can change without resampling a million points.
   */
  function paint(cloud, palette) {
    const { colors, tone, sign } = cloud;
    const rgb = [0, 0, 0];

    if (palette.solid) {
      hslToLinear(palette.h, palette.s, palette.l, rgb);
      for (let k = 0; k < colors.length; k += 3) {
        colors[k] = rgb[0]; colors[k + 1] = rgb[1]; colors[k + 2] = rgb[2];
      }
      return colors;
    }

    for (let i = 0; i < tone.length; i++) {
      const k = i * 3;
      blackbody(tone[i], rgb);
      if (sign[i] >= 0) {
        colors[k] = rgb[0]; colors[k + 1] = rgb[1]; colors[k + 2] = rgb[2];
      } else {
        // Same ramp read cold: swap the red and blue ends.
        colors[k] = rgb[2] * 0.9; colors[k + 1] = rgb[1] * 0.95; colors[k + 2] = rgb[0];
      }
    }
    return colors;
  }

  /**
   * Draws `count` points from |psi_nlm|^2 and packs them into render buffers.
   * Positions come back scaled so the orbital fills R_WORLD regardless of n —
   * a 5g orbital is some 25x wider than a 2p one, and without this only one
   * choice of n would be on screen at a time.
   *
   * The sampler works in physics coordinates, where the quantization axis is z.
   * The renderer orbits about y, so that is the axis a viewer reads as vertical
   * and the one an orbital is drawn around by convention. Rotating -90 degrees
   * about x lines them up: (x, y, z)_phys -> (x, z, -y)_render. A plain swap of
   * y and z would do it too, but it mirrors the scene and would flip the
   * handedness of the m < 0 lobes.
   */
  function buildCloud(count, q, palette, flow, elem) {
    // The two samplers return the same interface, and the flow works on both:
    // a complex m != 0 eigenstate's phase is e^(i m phi) whatever R(r) is.
    const s = elem
      ? Orbital.gtoSampler(elem.shells.find((sh) => sh.n === q.n && sh.l === q.l), q.m, flow.on)
      : Orbital.sampler(q.n, q.l, q.m, flow.on);

    const positions = new Float32Array(count * 3);
    const radii = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const tone = new Float32Array(count);
    const sign = new Int8Array(count);

    // Only a complex m != 0 state carries a phase gradient to flow along.
    const spin = flow.on && q.m !== 0;
    const omega = spin ? new Float32Array(count) : null;
    let sumRho2 = 0;

    const scale = R_WORLD / s.rOuter;

    for (let i = 0; i < count; i++) {
      const k = i * 3;
      s.sample(positions, k);
      const x = positions[k], y = positions[k + 1], z = positions[k + 2];

      if (spin) {
        const rho2 = x * x + y * y;      // axial distance², physics frame
        sumRho2 += rho2;
        omega[i] = rho2;                  // turned into rad/s below
      }

      positions[k] = x * scale;
      positions[k + 1] = z * scale;
      positions[k + 2] = -y * scale;

      radii[i] = 0.008 + 0.006 * Math.random();

      // Brightness tracks how dense this point's neighbourhood is; hue splits
      // the lobes by the sign of psi, which is the structure you actually want
      // to read off an orbital. paint() turns the pair into a color.
      const p = s.psi(x, y, z);
      tone[i] = Math.pow(Math.min(1, (p * p) / s.maxDensity), 1 / 2.2);
      sign[i] = p >= 0 ? 1 : -1;
    }

    if (spin) {
      // omega_i = m/rho_i^2, paced so the rms-radius ball does OMEGA_REF * m.
      const rho2Char = sumRho2 / count;
      for (let i = 0; i < count; i++) {
        const w = q.m * OMEGA_REF * rho2Char / Math.max(omega[i], 1e-12);
        omega[i] = Math.max(-OMEGA_MAX, Math.min(OMEGA_MAX, w));
      }
    }

    const cloud = { positions, radii, colors, tone, sign, omega };
    paint(cloud, palette);
    return cloud;
  }

  function main(elements) {
    const view = AtomicOrbitals.create(document.getElementById('gl'));

    let count = N0;
    let q = Orbital.clampQuantum(Q0.n, Q0.l, Q0.m);
    let element = null;                    // null = hydrogen, from Orbital.sampler
    const palette = Object.assign({}, P0);
    const flow = Object.assign({}, F0);
    let cloud;

    function rebuild() {
      cloud = buildCloud(count, q, palette, flow, element);   // old buffers fall out of scope
      view.setSpheres(cloud);
    }

    // Advect: rotate each ball about the vertical axis by its own omega * dt.
    // Physics z is render y, so the circulation plane is render x/z. sin/cos
    // come from small-angle series renormalised to unit length — an exact
    // rigid rotation (through a marginally quantised angle), so radii never
    // drift and there is nothing to resample: no trig for 300k balls a frame.
    let prevT = 0;
    view.onFrame = (t) => {
      const dt = Math.min(t - prevT, 0.1);    // tab-switch pauses don't leap
      prevT = t;
      const om = cloud.omega;
      if (!om || dt <= 0) return;
      const sdt = dt * flow.speed;
      const pos = cloud.positions;
      for (let i = 0, k = 0; i < om.length; i++, k += 3) {
        let d = om[i] * sdt;
        if (d > 0.35) d = 0.35; else if (d < -0.35) d = -0.35;
        const c0 = 1 - 0.5 * d * d;
        const s0 = d * (1 - d * d / 6);
        const inv = 1 / Math.sqrt(c0 * c0 + s0 * s0);
        const c = c0 * inv, s = s0 * inv;
        const x = pos[k], z = pos[k + 2];
        pos[k] = x * c + z * s;
        pos[k + 2] = z * c - x * s;
      }
      view.updatePositions(pos);
    };

    // Palette-only changes reuse the sampled cloud, so dragging a hue slider
    // costs one buffer upload rather than a million rejection samples.
    function repaint() {
      view.updateColors(paint(cloud, palette));
    }

    rebuild();

    view.setCamera({ dist: 4.8 });
    // Occlusion radius is in world units — roughly the size of the cavities you
    // want darkened, not the size of a ball.
    view.setAO({ radius: 2, intensity: 4, bias: 0.05 });
    view.setQuality({ superSample: 2 });
    view.setMaterial({ roughness: 1 });
    view.setBackground([1, 1, 1]);
    // Half the box's width offset on every axis, so its three near faces all
    // sit on the origin planes and it cuts a clean octant out of the cloud.
    // Edges and gizmo start hidden — the box is there to be turned on from the
    // panel, not to frame the orbital by default.
    view.setClip({
      center: [1.2, 1.2, 1.2], size: [2.4, 2.4, 2.4],
      showEdges: false, showGizmo: false,
    });

    AtomicOrbitalsUI.attach(view, {
      quantum: q,
      elements: elements,
      palette: palette,
      flow: flow,
      // Switching atoms only stores the element: the UI re-clamps n/l/m to the
      // new atom's shells and follows up with onQuantum, which rebuilds once.
      onElement: (e) => { element = e; },
      onCount: (v) => { count = v; rebuild(); },
      onQuantum: (next) => { q = next; rebuild(); },
      onPalette: (next) => { Object.assign(palette, next); repaint(); },
      // Speed is read live by the advection loop; only toggling the flow
      // changes which density the cloud is drawn from, and needs a resample.
      onFlow: (next) => {
        const was = flow.on;
        Object.assign(flow, next);
        if (flow.on !== was) rebuild();
      },
    });
    view.start();
  }

  // The basis-set table rides in a separate JSON, straight off Basis Set
  // Exchange. When the fetch fails — typically an unserved file:// open, which
  // blocks it — the app still runs, hydrogen-only.
  fetch('./cc-pVDZ.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
    .then((json) => Basis.parse(json))
    .catch((err) => {
      console.warn('cc-pVDZ.json unavailable (' + err.message +
        ') — hydrogen only. Serve over http:// to get the other atoms.');
      return [];
    })
    .then((elements) => {
      try {
        main(elements);
      } catch (e) {
        // Mostly catches WebGL2 being unavailable or a shader failing to
        // compile, either of which otherwise just leaves a blank canvas.
        const box = document.getElementById('error');
        box.style.display = 'grid';
        box.textContent = e.message;
        throw e;
      }
    });
})();
