/*
 * app.js — the scene: samples a hydrogen orbital into a ball cloud, wires up
 * the UI. Rendering lives in atomic_orbitals.js, controls in ui.js, the
 * wavefunction maths in orbital.js.
 *
 * The balls are stationary. A real (rather than complex) wavefunction is a
 * standing wave, so its Bohmian velocity field is identically zero anyway —
 * these points are the ensemble at rest, not a snapshot of anything moving.
 */
(function () {
  'use strict';

  const N0 = 100000;          // starting ball count; the UI slider changes it
  const R_WORLD = 2.0;        // the cloud is scaled to roughly this radius
  const Q0 = { n: 3, l: 1, m: 0 };

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
  function buildCloud(count, q) {
    const s = Orbital.sampler(q.n, q.l, q.m);

    const positions = new Float32Array(count * 3);
    const radii = new Float32Array(count);
    const colors = new Float32Array(count * 3);

    const scale = R_WORLD / s.rOuter;
    const rgb = [0, 0, 0];

    for (let i = 0; i < count; i++) {
      const k = i * 3;
      s.sample(positions, k);
      const x = positions[k], y = positions[k + 1], z = positions[k + 2];

      positions[k] = x * scale;
      positions[k + 1] = z * scale;
      positions[k + 2] = -y * scale;

      radii[i] = 0.008 + 0.006 * Math.random();

      // Brightness tracks how dense this point's neighbourhood is; hue splits
      // the lobes by the sign of psi, which is the structure you actually want
      // to read off an orbital.
      const p = s.psi(x, y, z);
      const t = Math.pow(Math.min(1, (p * p) / s.maxDensity), 1 / 2.2);
      blackbody(t, rgb);
      if (p >= 0) {
        colors[k] = rgb[0]; colors[k + 1] = rgb[1]; colors[k + 2] = rgb[2];
      } else {
        // Same ramp read cold: swap the red and blue ends.
        colors[k] = rgb[2] * 0.9; colors[k + 1] = rgb[1] * 0.95; colors[k + 2] = rgb[0];
      }
    }

    return { positions, radii, colors };
  }

  function main() {
    const view = AtomicOrbitals.create(document.getElementById('gl'));

    let count = N0;
    let q = Orbital.clampQuantum(Q0.n, Q0.l, Q0.m);

    function rebuild() {
      view.setSpheres(buildCloud(count, q));   // old buffers fall out of scope
    }

    rebuild();

    view.setCamera({ dist: 8 });
    // Occlusion radius is in world units — roughly the size of the cavities you
    // want darkened, not the size of a ball.
    view.setAO({ radius: 3, intensity: 4, bias: 0.05 });
    view.setQuality({ superSample: 2 });
    // Half the box's width offset on every axis, so its three near faces all
    // sit on the origin planes and it cuts a clean octant out of the cloud.
    view.setClip({ center: [1.8, 1.8, 1.8], size: [3.6, 3.6, 3.6] });

    AtomicOrbitalsUI.attach(view, {
      quantum: q,
      onCount: (v) => { count = v; rebuild(); },
      onQuantum: (next) => { q = next; rebuild(); },
    });
    view.start();
  }

  try {
    main();
  } catch (e) {
    // Mostly catches WebGL2 being unavailable or a shader failing to compile,
    // either of which otherwise just leaves a blank canvas.
    const box = document.getElementById('error');
    box.style.display = 'grid';
    box.textContent = e.message;
    throw e;
  }
})();
