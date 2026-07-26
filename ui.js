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
  .aoui-title {
    display: flex; justify-content: space-between; align-items: baseline;
    margin: 4px 0 6px; color: #dfe6ef;
    font-size: 13px; letter-spacing: 0.03em;
  }
  /* The section's live readout, e.g. the orbital's spectroscopic name. */
  .aoui-title i { font-style: normal; font-size: 11px; color: #e0b070; }
  .aoui-title.aoui-sep { margin-top: 13px; }
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
  /* The native color input draws a chunky bordered box; strip it back to a
     flat bar that matches the sliders it sits under. */
  .aoui input[type=color] {
    width: 100%; height: 14px; padding: 0; cursor: pointer;
    background: transparent; border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 2px; -webkit-appearance: none; appearance: none;
  }
  .aoui input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
  .aoui input[type=color]::-webkit-color-swatch { border: 0; border-radius: 1px; }
  .aoui input[type=color]::-moz-color-swatch { border: 0; border-radius: 1px; }
  /* The n slider's editable ceiling: shown as "value / max" beside the readout. */
  .aoui-int-right { display: flex; align-items: baseline; gap: 5px; }
  .aoui-int-sep { color: #5c6675; }
  .aoui input[type=number] {
    width: 34px; padding: 0 3px; text-align: right;
    color: #dfe6ef; font: inherit;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 3px;
    -moz-appearance: textfield;
  }
  .aoui input[type=number]::-webkit-inner-spin-button,
  .aoui input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .aoui select {
    width: 100%; padding: 1px 2px; color: #dfe6ef; font: inherit;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 3px;
    cursor: pointer;
  }
  .aoui select:focus { outline: none; border-color: rgba(116, 168, 255, 0.5); }
  /* The popup list ignores the panel styling and would come out black-on-white
     in some browsers; pin its own colors. */
  .aoui select option { background: #14181f; color: #dfe6ef; }
  /* Atom row: label text, dropdown and type note share one inline line, the
     select flexing to fill the gap between them. */
  .aoui-atom label { align-items: center; gap: 6px; margin-bottom: 0; }
  .aoui-atom select { width: auto; flex: 1; min-width: 0; }
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
      const row = el('div', 'aoui-row', cfg.parent || panel);
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

    // --- quantum numbers --------------------------------------------------
    //
    // n, l and m are integers with nested ranges: 0 <= l < n and |m| <= l. The
    // dependent sliders get their bounds rewritten whenever the one above them
    // moves, and their value clamped into the new range. n's own ceiling is not
    // fixed either: an editable "/ max" box beside its value rewrites it, so how
    // far the shells reach is a setting rather than a constant.
    //
    // Passing maxCeil turns the readout into "value / max", the max a typed box
    // that re-ranges this slider. Only n uses it.
    function intSlider(name, min, max, value, onInput, maxCeil) {
      const row = el('div', 'aoui-row', panel);
      const label = el('label', null, row);
      label.appendChild(document.createTextNode(name));
      const right = el('span', 'aoui-int-right', label);
      const out = el('i', null, right);
      const input = el('input', null, row);
      input.type = 'range';
      input.step = 1;

      input.min = min;
      input.max = max;
      input.value = value;

      const show = () => { out.textContent = input.value; };
      const self = {
        get value() { return parseInt(input.value, 10); },
        setRange(lo, hi) {
          const v = self.value;
          input.min = lo;
          input.max = hi;
          input.value = Math.min(hi, Math.max(lo, v));
          show();
        },
      };
      show();

      // The editable ceiling, capped at maxCeil (past which |psi|^2 overflows a
      // double as the radial CDF is built). Lowering it below n drags n down too.
      // Exposed as ceilEl/getCeil so the atom dropdown can stash it away — a
      // basis-set atom's shells end where they end, no ceiling to edit.
      if (maxCeil) {
        const wrap = el('span', 'aoui-int-right', right);
        el('span', 'aoui-int-sep', wrap).textContent = '/';
        const cap = el('input', null, wrap);
        cap.type = 'number';
        cap.min = min; cap.max = maxCeil; cap.step = 1;
        cap.value = max;
        let last = max;
        cap.addEventListener('change', () => {
          let hi = Math.round(parseFloat(cap.value));
          hi = isFinite(hi) ? Math.min(maxCeil, Math.max(min, hi)) : last;
          cap.value = hi;
          last = hi;
          self.setRange(min, hi);
          onInput();
        });
        self.ceilEl = wrap;
        self.getCeil = () => last;
      }

      input.addEventListener('input', () => { show(); onInput(); });
      return self;
    }

    /** Section heading. `sep` rules a line above it; returns its readout slot. */
    function title(name, sep) {
      const row = el('div', 'aoui-title' + (sep ? ' aoui-sep' : ''), panel);
      row.appendChild(document.createTextNode(name));
      return el('i', null, row);
    }

    const orbLabel = title('Quantums');
    const q0 = opts.quantum || { n: 3, l: 1, m: 0 };

    // --- atom ---------------------------------------------------------------
    //
    // Hydrogen stays on the exact analytic eigenstates with its open-ended n;
    // every other atom offers the occupied Hartree-Fock orbitals its basis-set
    // table carries, so n and l are pinned to shells the atom actually has.
    // (Those shells are gapless — 4p occupied implies 4s, 3d, ... are too — so
    // plain nested slider ranges cover exactly the valid set.)
    const elements = opts.elements || [];
    let elem = null;                        // null = analytic hydrogen
    let atomNote = null;

    if (elements.length) {
      const row = el('div', 'aoui-row aoui-atom', panel);
      const label = el('label', null, row);
      label.appendChild(document.createTextNode('atom'));
      const sel = el('select', null, label);
      atomNote = el('i', null, label);
      atomNote.textContent = 'exact ψ';
      const h = el('option', null, sel);
      h.value = '';
      h.textContent = '1 H — Hydrogen';
      for (const e of elements) {
        if (e.Z === 1) continue;            // analytic H beats its own basis fit
        const o = el('option', null, sel);
        o.value = e.symbol;
        o.textContent = e.Z + ' ' + e.symbol + ' — ' + e.name;
      }
      sel.addEventListener('change', () => {
        elem = null;
        for (const e of elements) if (e.symbol === sel.value) elem = e;
        if (opts.onElement) opts.onElement(elem);
        applyAtomRanges();
        pushQuantum();
      });
    }

    function elemLMax(n) {
      let hi = 0;
      for (const s of elem.shells) if (s.n === n && s.l > hi) hi = s.l;
      return hi;
    }

    function applyAtomRanges() {
      atomNote.textContent = elem ? 'HF · cc-pVDZ' : 'exact ψ';
      if (elem) {
        let nHi = 1;
        for (const s of elem.shells) if (s.n > nHi) nHi = s.n;
        if (sn.ceilEl) sn.ceilEl.style.display = 'none';
        sn.setRange(1, nHi);
      } else {
        if (sn.ceilEl) sn.ceilEl.style.display = '';
        sn.setRange(2, sn.getCeil());
      }
    }

    function pushQuantum() {
      // Order matters: n bounds l, and l bounds m.
      sl.setRange(0, elem ? elemLMax(sn.value) : sn.value - 1);
      sm.setRange(-sl.value, sl.value);
      const q = { n: sn.value, l: sl.value, m: sm.value };
      orbLabel.textContent = (elem ? elem.symbol + ' ' : '') + Orbital.label(q.n, q.l, q.m);
      setMotionLabel();
      if (opts.onQuantum) opts.onQuantum(q);
    }

    const N_MAX_DEFAULT = 7;   // starting ceiling; the "/ max" box beside n raises it
    const N_CEIL = 80;         // highest ceiling allowed, before |psi|^2 overflows
    const sn = intSlider('n  principal', 2, N_MAX_DEFAULT, q0.n, pushQuantum, N_CEIL);
    const sl = intSlider('l  angular', 0, q0.n - 1, q0.l, pushQuantum);
    const sm = intSlider('m  magnetic', -q0.l, q0.l, q0.m, pushQuantum);
    orbLabel.textContent = Orbital.label(q0.n, q0.l, q0.m);

    // --- motion -----------------------------------------------------------
    //
    // The complex eigenstate's e^{i m phi} phase drives a circulation about
    // the vertical axis (the Bohmian velocity field, L_z = m hbar); the
    // checkbox swaps the lobed real harmonic for that state and sets the
    // cloud turning. m = 0 has no phase gradient and stays put either way.
    const motionLabel = title('Motion', true);
    const f0 = opts.flow || { on: false, speed: 1 };

    const flowCheck = check('flow (complex ψ)', f0.on, (v) => {
      setMotionLabel();
      if (opts.onFlow) opts.onFlow({ on: v });
    });

    slider('speed', 0.05, 20, 1, f0.speed, (v) => {
      if (opts.onFlow) opts.onFlow({ speed: v });
    }, { log: true, fmt: (v) => v.toFixed(2) + '×' });

    function setMotionLabel() {
      motionLabel.textContent = !flowCheck.checked ? 'off'
        : sm.value === 0 ? 'static' : 'Lz = ' + sm.value + 'ħ';
    }
    setMotionLabel();

    title('Rendering', true);

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
    slider('roughness', 0, 1, 0.01, s.roughness, (v) => view.setMaterial({ roughness: v }));

    // --- color ------------------------------------------------------------
    //
    // Either the blackbody ramp — brightness by probability density, warm and
    // cold ends splitting the lobes by the sign of psi — or one flat color, in
    // which case the three sliders below choose it and the orbital's structure
    // has to be read off the geometry alone.
    const modeLabel = title('Color', true);
    const p0 = opts.palette || { solid: false, h: 205, s: 0.72, l: 0.55 };

    function pushPalette(next) {
      if (opts.onPalette) opts.onPalette(next);
    }

    function setMode(solid) {
      hslRows.hidden = !solid;
      modeLabel.textContent = solid ? 'solid' : 'blackbody';
    }

    check('solid color', p0.solid, (v) => {
      setMode(v);
      pushPalette({ solid: v });
    });

    const hslRows = el('div', null, panel);

    const hslCfg = { parent: hslRows };
    slider('hue', 0, 360, 1, p0.h, (v) => pushPalette({ h: v }),
      Object.assign({ fmt: (v) => v.toFixed(0) + '°' }, hslCfg));
    slider('saturation', 0, 1, 0.01, p0.s, (v) => pushPalette({ s: v }), hslCfg);
    slider('lightness', 0, 1, 0.01, p0.l, (v) => pushPalette({ l: v }), hslCfg);

    setMode(p0.solid);

    // --- background -------------------------------------------------------
    // A native color input: the swatch opens the platform's full picker.
    function swatch(name, rgb, onChange) {
      const row = el('div', 'aoui-row aoui-swatch', panel);
      const label = el('label', null, row);
      label.appendChild(document.createTextNode(name));
      const out = el('i', null, label);
      const input = el('input', null, row);
      input.type = 'color';

      const hex = (c) =>
        '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)
          .toString(16).padStart(2, '0')).join('');

      input.value = hex(rgb);
      out.textContent = input.value;
      input.addEventListener('input', () => {
        out.textContent = input.value;
        const h = input.value;
        onChange([
          parseInt(h.slice(1, 3), 16) / 255,
          parseInt(h.slice(3, 5), 16) / 255,
          parseInt(h.slice(5, 7), 16) / 255,
        ]);
      });
      return input;
    }

    swatch('background', s.background, (rgb) => view.setBackground(rgb));

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
