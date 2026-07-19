/*
 * ui.js — overlay panel for the sphere renderer: SSAO sliders + FPS readout.
 *
 *   AtomicOrbitalsUI.attach(view);
 *
 * Self-contained (injects its own CSS) and dependency-free. Press H to hide.
 */
(function (global) {
  'use strict';

  const CSS = `
  .aoui {
    position: fixed; top: 12px; left: 12px; z-index: 10;
    width: 208px; padding: 10px 12px 12px;
    background: rgba(14, 18, 26, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 8px;
    color: #c9d3e0;
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    backdrop-filter: blur(6px);
    user-select: none;
  }
  .aoui[hidden] { display: none; }
  .aoui-fps {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 10px; padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .aoui-fps b { font-size: 19px; font-weight: 600; letter-spacing: -0.02em; }
  .aoui-fps span { color: #6b7789; }
  .aoui-row { margin-top: 9px; }
  .aoui-row label {
    display: flex; justify-content: space-between;
    color: #8b97a8; margin-bottom: 3px;
  }
  .aoui-row label i { font-style: normal; color: #dfe6ef; }
  .aoui input[type=range] {
    width: 100%; height: 14px; margin: 0; background: transparent;
    -webkit-appearance: none; appearance: none; cursor: ew-resize;
  }
  .aoui input[type=range]::-webkit-slider-runnable-track {
    height: 3px; border-radius: 2px; background: rgba(255, 255, 255, 0.15);
  }
  .aoui input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 11px; height: 11px; margin-top: -4px;
    border-radius: 50%; background: #74a8ff; border: 0;
  }
  .aoui input[type=range]::-moz-range-track {
    height: 3px; border-radius: 2px; background: rgba(255, 255, 255, 0.15);
  }
  .aoui input[type=range]::-moz-range-thumb {
    width: 11px; height: 11px; border-radius: 50%; background: #74a8ff; border: 0;
  }
  .aoui-foot { margin-top: 11px; color: #5c6675; font-size: 10px; }
  `;

  function el(tag, cls, parent) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  function attach(view, opts) {
    opts = opts || {};

    if (!document.getElementById('aoui-css')) {
      const style = el('style');
      style.id = 'aoui-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const s = view.settings();
    const panel = el('div', 'aoui', document.body);

    // --- fps readout ------------------------------------------------------
    const fpsRow = el('div', 'aoui-fps', panel);
    const fpsVal = el('b', null, fpsRow);
    fpsVal.textContent = '--';
    const fpsSub = el('span', null, fpsRow);
    fpsSub.textContent = 'fps';

    // --- sliders ----------------------------------------------------------
    function slider(name, min, max, step, value, onInput) {
      const row = el('div', 'aoui-row', panel);
      const label = el('label', null, row);
      label.appendChild(document.createTextNode(name));
      const out = el('i', null, label);
      const input = el('input', null, row);
      input.type = 'range';
      input.min = min; input.max = max; input.step = step; input.value = value;
      const show = (v) => { out.textContent = (+v).toFixed(step < 0.01 ? 3 : 2); };
      show(value);
      input.addEventListener('input', () => {
        show(input.value);
        onInput(parseFloat(input.value));
      });
      return input;
    }

    slider('ao radius', 0.01, 1.0, 0.01, s.ao.radius, (v) => view.setAO({ radius: v }));
    slider('ao intensity', 0, 2.5, 0.05, s.ao.intensity, (v) => view.setAO({ intensity: v }));
    slider('ao bias', 0, 0.05, 0.001, s.ao.bias, (v) => view.setAO({ bias: v }));
    slider('supersample', 1, 2, 0.5, s.superSample, (v) => view.setQuality({ superSample: v }));

    const foot = el('div', 'aoui-foot', panel);
    foot.textContent = s.count.toLocaleString() + ' spheres · H to hide';

    // --- frame timing -----------------------------------------------------
    // Wrap render() rather than running a separate rAF, so the count follows
    // actual draws and we can time the CPU side of the frame.
    const inner = view.render.bind(view);
    let frames = 0, cpuMs = 0, windowStart = performance.now();

    view.render = function () {
      const t0 = performance.now();
      inner();
      cpuMs += performance.now() - t0;
      frames++;

      const now = performance.now();
      const elapsed = now - windowStart;
      if (elapsed >= 500) {
        const fps = (frames * 1000) / elapsed;
        fpsVal.textContent = fps.toFixed(fps < 10 ? 1 : 0);
        fpsVal.style.color = fps >= 50 ? '#7fd68a' : fps >= 25 ? '#e5c07b' : '#e88b8b';
        fpsSub.textContent = 'fps · ' + (cpuMs / frames).toFixed(1) + ' ms cpu';
        frames = 0; cpuMs = 0; windowStart = now;
      }
    };

    global.addEventListener('keydown', (e) => {
      if (e.key === 'h' || e.key === 'H') panel.hidden = !panel.hidden;
    });

    if (opts.hidden) panel.hidden = true;
    return panel;
  }

  global.AtomicOrbitalsUI = { attach };
})(window);
