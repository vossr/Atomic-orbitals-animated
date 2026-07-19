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
  .aoui-sep {
    margin-top: 11px; padding-top: 9px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .aoui-check {
    display: flex; align-items: center; gap: 7px;
    margin-top: 6px; color: #8b97a8; cursor: pointer;
  }
  .aoui-check:hover { color: #c9d3e0; }
  .aoui-check input {
    width: 12px; height: 12px; margin: 0; accent-color: #74a8ff; cursor: pointer;
  }
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
    //
    // cfg: { fmt, log, snap, commit }. `log` spreads a range spanning decades
    // evenly across the track, `snap` quantises the result, and `commit` waits
    // for the drag to end before firing — for anything too costly to redo on
    // every pixel of travel.
    function slider(name, min, max, step, value, onInput, cfg) {
      cfg = cfg || {};
      const fmt = cfg.fmt || ((v) => v.toFixed(step < 0.01 ? 3 : 2));
      const row = el('div', 'aoui-row', panel);
      const label = el('label', null, row);
      label.appendChild(document.createTextNode(name));
      const out = el('i', null, label);
      const input = el('input', null, row);
      input.type = 'range';

      const toValue = (t) => {
        const v = cfg.log ? min * Math.pow(max / min, t / 1000) : t;
        return cfg.snap ? Math.round(v / cfg.snap) * cfg.snap : v;
      };
      const toSlider = (v) =>
        cfg.log ? (1000 * Math.log(v / min)) / Math.log(max / min) : v;

      input.min = cfg.log ? 0 : min;
      input.max = cfg.log ? 1000 : max;
      input.step = cfg.log ? 1 : step;
      input.value = toSlider(value);

      const read = () => toValue(parseFloat(input.value));
      const show = (v) => { out.textContent = fmt(v); };
      show(value);
      input.addEventListener('input', () => {
        show(read());
        if (!cfg.commit) onInput(read());
      });
      if (cfg.commit) input.addEventListener('change', () => onInput(read()));
      return input;
    }

    const fmtCount = (v) =>
      v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : Math.round(v / 1000) + 'k';

    // Rebuilding the cloud at a million balls is far too slow to do live, so
    // this one only fires when the drag ends.
    slider('balls', 10000, 1000000, 1, s.count, (v) => {
      if (opts.onCount) opts.onCount(v);
      setFoot(v);
    }, { log: true, snap: 1000, commit: true, fmt: fmtCount });

    slider('ao radius', 0.01, 5.0, 0.01, s.ao.radius, (v) => view.setAO({ radius: v }));
    slider('ao intensity', 0, 5, 0.05, s.ao.intensity, (v) => view.setAO({ intensity: v }));
    slider('supersample', 1, 8, 0.5, s.superSample, (v) => view.setQuality({ superSample: v }));

    // --- clipping box -----------------------------------------------------
    function check(name, value, onChange, parent) {
      const row = el('label', 'aoui-check', parent || panel);
      const input = el('input', null, row);
      input.type = 'checkbox';
      input.checked = value;
      row.appendChild(document.createTextNode(name));
      input.addEventListener('change', () => onChange(input.checked));
      return input;
    }

    const clipBox = el('div', 'aoui-sep', panel);
    check('clip box edges', s.clip.showEdges, (v) => view.setClip({ showEdges: v }), clipBox);
    check('clip box gizmo', s.clip.showGizmo, (v) => view.setClip({ showGizmo: v }), clipBox);

    const foot = el('div', 'aoui-foot', panel);
    function setFoot(n) {
      foot.textContent = n.toLocaleString() + ' spheres · ctrl = scale gizmo · H to hide';
    }
    setFoot(s.count);

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
