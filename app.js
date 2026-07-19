/*
 * app.js — the scene: builds the ball cloud, animates it, wires up the UI.
 * Rendering lives in atomic_orbitals.js, controls in ui.js.
 */
(function () {
  'use strict';

  const N = 100000;
  const R = 2.0;              // radius of the ball the cloud fills

  function buildCloud(n) {
    const positions = new Float32Array(n * 3);
    const radii = new Float32Array(n);
    const colors = new Float32Array(n * 3);
    const dirs = new Float32Array(n * 3);   // unit direction
    const shell = new Float32Array(n);      // distance from the centre
    const phase = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      // Uniform over the sphere's *volume*: rejection-sample the cube and keep
      // what lands inside the unit ball. (Scaling a random direction by a
      // uniform radius would pile everything up near the centre.)
      let x, y, z, d2;
      do {
        x = Math.random() * 2 - 1;
        y = Math.random() * 2 - 1;
        z = Math.random() * 2 - 1;
        d2 = x * x + y * y + z * z;
      } while (d2 > 1 || d2 < 1e-12);

      const len = Math.sqrt(d2);
      dirs[i * 3 + 0] = x / len;
      dirs[i * 3 + 1] = y / len;
      dirs[i * 3 + 2] = z / len;
      shell[i] = len * R;

      phase[i] = Math.random() * Math.PI * 2;
      radii[i] = 0.012 + 0.010 * Math.random();

      // Colour by hemisphere, the way orbital lobes get signed.
      const ny = y / len;
      const t = ny * 0.5 + 0.5;
      colors[i * 3 + 0] = 0.25 + 0.75 * t;
      colors[i * 3 + 1] = 0.45 + 0.25 * Math.abs(ny);
      colors[i * 3 + 2] = 1.0 - 0.6 * t;
    }

    return { positions, radii, colors, dirs, shell, phase };
  }

  function main() {
    const view = AtomicOrbitals.create(document.getElementById('gl'));
    const cloud = buildCloud(N);
    const { positions, dirs, shell, phase } = cloud;

    view.setSpheres(cloud);

    view.onFrame = (time) => {
      // All N vertices rewritten every frame.
      for (let i = 0; i < N; i++) {
        const k = i * 3;
        const breathe = shell[i] + 0.25 * Math.sin(time * 1.3 + phase[i]);
        positions[k + 0] = dirs[k + 0] * breathe;
        positions[k + 1] = dirs[k + 1] * breathe + 0.12 * Math.sin(time * 2 + phase[i]);
        positions[k + 2] = dirs[k + 2] * breathe;
      }
      view.updatePositions(positions);
    };

    view.setCamera({ dist: 8 });
    // Occlusion radius is in world units — roughly the size of the cavities you
    // want darkened, not the size of a ball.
    view.setAO({ radius: 0.18, intensity: 1.1, bias: 0.008 });

    AtomicOrbitalsUI.attach(view);
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
