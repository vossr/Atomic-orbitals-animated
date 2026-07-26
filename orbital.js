/*
 * orbital.js — atomic wavefunctions, and sampling points from |psi|^2.
 *
 *   const s = Orbital.sampler(n, l, m);        // hydrogen, exact
 *   const s = Orbital.gtoSampler(shell, m);    // any atom's HF orbital, from basis.js
 *   s.sample(out, 0);            // writes x,y,z in Bohr radii
 *
 * psi_nlm = R_nl(r) * Y_lm(theta, phi), with *real* spherical harmonics, so
 * m > 0 carries cos(m phi), m < 0 sin(|m| phi). That gives the lobed textbook
 * orbitals rather than the axially symmetric |Y| of the complex form.
 * sampler(n, l, m, true) draws from the complex eigenstate instead — same R,
 * but |Y| with no phi dependence — which is the density to pair with advecting
 * the cloud along the e^(i m phi) phase gradient (the Bohmian flow).
 *
 * Because the density separates as R(r)^2 * Y(theta,phi)^2, points are drawn in
 * two independent steps: the radius from a tabulated CDF of 4 pi r^2 R^2, the
 * direction by rejection against max Y^2. Plain rejection over a bounding box
 * would accept well under a percent of its tries at n = 80.
 *
 * Nothing here is normalised: rejection and inverse-CDF sampling both only care
 * about ratios, and the caller scales the cloud to the viewport anyway.
 */
(function (global) {
  'use strict';

  const RSTEPS = 4096;      // radial grid resolution for the CDF
  const TAIL = 1e-6;        // radial probability treated as "the orbital ends here"

  /**
   * Generalised Laguerre L_n^a(x), by the standard three-term recurrence.
   * Stable enough here: the degree n - l - 1 reaches 79 at the n <= 80 we expose,
   * still inside where this forward recurrence stays well-conditioned. Above ~86
   * the unnormalised R^2 overflows a double, which is what really caps n.
   */
  function laguerre(n, a, x) {
    if (n === 0) return 1;
    let prev = 1;                 // L_0
    let cur = 1 + a - x;          // L_1
    for (let k = 1; k < n; k++) {
      const next = ((2 * k + 1 + a - x) * cur - (k + a) * prev) / (k + 1);
      prev = cur;
      cur = next;
    }
    return cur;
  }

  /**
   * Normalised associated Legendre function for m >= 0, i.e. P_l^m scaled by
   * sqrt((2l+1)/4pi * (l-m)!/(l+m)!). The factorials are folded into the
   * recurrence instead of being computed separately, which is what keeps this
   * from overflowing for large l.
   */
  function nalp(l, m, x) {
    const sinTheta = Math.sqrt(Math.max(0, (1 - x) * (1 + x)));

    // Seed at l = m: (-1)^m sqrt((2m+1)!!/(2m)!! / 4pi) sin^m(theta), built up a
    // factor at a time so the double factorials never exist as numbers.
    let pmm = Math.sqrt(0.25 / Math.PI);
    for (let k = 1; k <= m; k++) {
      pmm *= -Math.sqrt((2 * k + 1) / (2 * k)) * sinTheta;
    }
    if (l === m) return pmm;

    let pmm1 = x * Math.sqrt(2 * m + 3) * pmm;
    if (l === m + 1) return pmm1;

    let pll = 0;
    for (let ll = m + 2; ll <= l; ll++) {
      const a = Math.sqrt((4 * ll * ll - 1) / (ll * ll - m * m));
      const b = Math.sqrt(((ll - 1) * (ll - 1) - m * m) / (4 * (ll - 1) * (ll - 1) - 1));
      pll = a * (x * pmm1 - b * pmm);
      pmm = pmm1;
      pmm1 = pll;
    }
    return pll;
  }

  /**
   * Angular amplitude whose square is the angular density. The real harmonic
   * carries the cos/sin(m phi) lobes; `complex` asks for |Y| of the complex
   * eigenstate instead, which drops the phi factor (that density is axially
   * symmetric) but keeps the sqrt(2), so both modes share the same envelope
   * maxY2 and the same overall scale.
   */
  function ampY(l, m, cosTheta, phi, complex) {
    if (m === 0) return nalp(l, 0, cosTheta);
    const am = Math.abs(m);
    const p = Math.SQRT2 * nalp(l, am, cosTheta);
    if (complex) return p;
    return m > 0 ? p * Math.cos(am * phi) : p * Math.sin(am * phi);
  }

  /** Real spherical harmonic Y_lm, cosTheta = z/r. */
  function realY(l, m, cosTheta, phi) {
    return ampY(l, m, cosTheta, phi, false);
  }

  /** Radial part R_nl(r), r in Bohr radii, up to a constant. */
  function radial(n, l, r) {
    const rho = 2 * r / n;
    return Math.exp(-0.5 * rho) * Math.pow(rho, l) * laguerre(n - l - 1, 2 * l + 1, rho);
  }

  /** Clamp l and m into the range the physics allows: 0 <= l < n, |m| <= l. */
  function clampQuantum(n, l, m) {
    n = Math.max(1, Math.round(n));
    l = Math.min(n - 1, Math.max(0, Math.round(l)));
    m = Math.min(l, Math.max(-l, Math.round(m)));
    return { n, l, m };
  }

  /**
   * The sampling machinery over an arbitrary radial profile. Nothing in here
   * assumes hydrogen — only that psi = R(r) Y_lm, which holds for atomic
   * Hartree-Fock orbitals just as well — so the samplers below differ solely
   * in the R they pass in. `rHi` bounds the radial grid and the density must
   * be dead beyond it; `complex` swaps the real harmonic for the complex
   * eigenstate's |Y|; `n` is only carried through for labelling.
   */
  function makeSampler(radialFn, rHi, n, l, m, complex) {
    // --- radial CDF -------------------------------------------------------
    const dr = rHi / RSTEPS;
    const rGrid = new Float64Array(RSTEPS + 1);
    const weight = new Float64Array(RSTEPS + 1);   // r^2 R^2, the radial density
    const cdf = new Float64Array(RSTEPS + 1);

    let maxR2 = 0;
    for (let i = 0; i <= RSTEPS; i++) {
      const r = i * dr;
      const R = radialFn(r);
      const R2 = R * R;
      if (R2 > maxR2) maxR2 = R2;
      rGrid[i] = r;
      weight[i] = r * r * R2;
    }

    let total = 0;
    for (let i = 1; i <= RSTEPS; i++) {
      total += 0.5 * dr * (weight[i] + weight[i - 1]);   // trapezoid
      cdf[i] = total;
    }
    for (let i = 0; i <= RSTEPS; i++) cdf[i] /= total;

    // Where to consider the orbital finished, for scaling the view.
    let rOuter = rHi;
    for (let i = RSTEPS; i > 0; i--) {
      if (1 - cdf[i] > TAIL) { rOuter = rGrid[i]; break; }
    }

    // --- angular envelope -------------------------------------------------
    // Y^2 peaks somewhere on a meridian; phi only contributes cos^2 or sin^2,
    // which tops out at 1, so scanning cosTheta alone bounds the whole sphere.
    const am = Math.abs(m);
    let maxY2 = 0;
    for (let i = 0; i <= 2048; i++) {
      const c = -1 + 2 * i / 2048;
      const p = nalp(l, am, c);
      const y2 = (m === 0 ? 1 : 2) * p * p;
      if (y2 > maxY2) maxY2 = y2;
    }
    maxY2 *= 1.0001;    // keeps the grid's near-misses from ever exceeding 1

    function sampleRadius() {
      const u = Math.random();
      // Binary search the CDF, then interpolate inside the bracketing cell.
      let lo = 0, hi = RSTEPS;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] <= u) lo = mid; else hi = mid;
      }
      const span = cdf[hi] - cdf[lo];
      const t = span > 0 ? (u - cdf[lo]) / span : 0;
      return rGrid[lo] + t * dr;
    }

    /** Writes x,y,z into out[off..off+2]. */
    function sample(out, off) {
      const r = sampleRadius();

      // Uniform direction, kept with probability Y^2 / maxY^2. In complex mode
      // phi never enters the test — every direction on the accepted ring wins.
      let cosTheta, phi;
      for (;;) {
        cosTheta = 2 * Math.random() - 1;
        phi = Math.random() * 2 * Math.PI;
        const y = ampY(l, m, cosTheta, phi, complex);
        if (Math.random() * maxY2 <= y * y) break;
      }

      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      out[off + 0] = r * sinTheta * Math.cos(phi);
      out[off + 1] = r * sinTheta * Math.sin(phi);
      out[off + 2] = r * cosTheta;
    }

    /** Signed amplitude whose square is |psi|^2 — the caller wants its sign,
     *  to tell the lobes (real) or the theta-nodes (complex) apart. */
    function psiAt(x, y, z) {
      const r = Math.hypot(x, y, z);
      if (r < 1e-9) return l === 0 ? radialFn(0) * realY(0, 0, 1, 0) : 0;
      return radialFn(r) * ampY(l, m, z / r, Math.atan2(y, x), complex);
    }

    return {
      n, l, m, complex,
      rOuter,
      /** Peak of |psi|^2 anywhere — the two factors max out independently. */
      maxDensity: maxR2 * maxY2,
      sample,
      density(x, y, z) { const p = psiAt(x, y, z); return p * p; },
      psi: psiAt,
    };
  }

  /** Hydrogen eigenstate sampler — the exact analytic solutions. */
  function sampler(n, l, m, complex) {
    const q = clampQuantum(n, l, m);
    // The density has died off long before 4n^2 + 20 Bohr for every n we
    // allow, so that is a safe upper bound to tabulate over.
    return makeSampler((r) => radial(q.n, q.l, r), 4 * q.n * q.n + 20,
                       q.n, q.l, q.m, !!complex);
  }

  /**
   * Sampler over a contracted-Gaussian orbital, as Basis.parse() yields them:
   * { n, l, exponents, coeffs }, exponents in Bohr^-2 and coefficients over
   * *normalized* primitives (the Basis Set Exchange convention). So
   *
   *   R(r) = r^l sum_i c_i N_i exp(-a_i r^2),  N_i ∝ a_i^((2l+3)/4),
   *
   * where only the ratios of the N_i matter, like everything else here.
   */
  function gtoSampler(orb, m, complex) {
    if (!orb) throw new Error('no such orbital in this basis');
    const l = orb.l;
    m = Math.min(l, Math.max(-l, Math.round(m)));

    const a = orb.exponents;
    const w = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) {
      w[i] = orb.coeffs[i] * Math.pow(a[i], (2 * l + 3) / 4);
    }
    function radialFn(r) {
      const r2 = r * r;
      let s = 0;
      for (let i = 0; i < a.length; i++) s += w[i] * Math.exp(-a[i] * r2);
      return s * Math.pow(r, l);
    }

    // One uniform grid has to resolve whatever this orbital is — a Kr 1s is
    // dead by half a Bohr, a Li 2s reaches past 25 — so sweep a log grid for
    // where the radial density falls nine decades below its peak, and only
    // tabulate out to there.
    let aMin = Infinity;
    for (let i = 0; i < a.length; i++) if (a[i] < aMin) aMin = a[i];
    const rFar = Math.sqrt(30 / aMin) + 1;  // even the most diffuse primitive is dead here
    const probe = new Float64Array(513);
    let peak = 0;
    for (let i = 0; i <= 512; i++) {
      const r = 1e-3 * Math.pow(rFar * 1e3, i / 512);
      const R = radialFn(r);
      probe[i] = r * r * R * R;
      if (probe[i] > peak) peak = probe[i];
    }
    let rHi = rFar;
    for (let i = 512; i >= 0; i--) {
      if (probe[i] > peak * 1e-9) {
        rHi = Math.min(rFar, 1e-3 * Math.pow(rFar * 1e3, i / 512) * 1.15);
        break;
      }
    }

    return makeSampler(radialFn, rHi, orb.n, l, m, !!complex);
  }

  /** Spectroscopic name, e.g. (3, 2, -1) -> "3d". Empty past l = 5, which has no
   *  standard letter, so callers simply show nothing rather than a placeholder. */
  function label(n, l, m) {
    const letter = 'spdfgh'[l];
    if (letter === undefined) return '';
    return n + letter + (m === 0 ? '' : (m > 0 ? '+' : '-') + Math.abs(m));
  }

  global.Orbital = { sampler, gtoSampler, clampQuantum, laguerre, nalp, realY, ampY, radial, label };
})(window);
