/*
 * orbital.js — hydrogen wavefunctions, and sampling points from |psi|^2.
 *
 *   const s = Orbital.sampler(n, l, m);
 *   s.sample(out, 0);            // writes x,y,z in Bohr radii
 *
 * psi_nlm = R_nl(r) * Y_lm(theta, phi), with *real* spherical harmonics, so
 * m > 0 carries cos(m phi), m < 0 sin(|m| phi). That gives the lobed textbook
 * orbitals rather than the axially symmetric |Y| of the complex form.
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

  /** Real spherical harmonic Y_lm, cosTheta = z/r. */
  function realY(l, m, cosTheta, phi) {
    if (m === 0) return nalp(l, 0, cosTheta);
    const am = Math.abs(m);
    const p = Math.SQRT2 * nalp(l, am, cosTheta);
    return m > 0 ? p * Math.cos(am * phi) : p * Math.sin(am * phi);
  }

  /** Radial part R_nl(r), r in Bohr radii, up to a constant. */
  function radial(n, l, r) {
    const rho = 2 * r / n;
    return Math.exp(-0.5 * rho) * Math.pow(rho, l) * laguerre(n - l - 1, 2 * l + 1, rho);
  }

  /** psi itself — the caller wants its sign, to tell the lobes apart. */
  function psi(n, l, m, x, y, z) {
    const r = Math.hypot(x, y, z);
    if (r < 1e-9) return l === 0 ? radial(n, l, 0) * realY(l, 0, 1, 0) : 0;
    return radial(n, l, r) * realY(l, m, z / r, Math.atan2(y, x));
  }

  /** Clamp l and m into the range the physics allows: 0 <= l < n, |m| <= l. */
  function clampQuantum(n, l, m) {
    n = Math.max(1, Math.round(n));
    l = Math.min(n - 1, Math.max(0, Math.round(l)));
    m = Math.min(l, Math.max(-l, Math.round(m)));
    return { n, l, m };
  }

  function sampler(n, l, m) {
    const q = clampQuantum(n, l, m);
    n = q.n; l = q.l; m = q.m;

    // --- radial CDF -------------------------------------------------------
    // The density has died off long before 4n^2 + 20 Bohr for every n we allow,
    // so that is a safe upper bound to tabulate over.
    const rHi = 4 * n * n + 20;
    const dr = rHi / RSTEPS;
    const rGrid = new Float64Array(RSTEPS + 1);
    const weight = new Float64Array(RSTEPS + 1);   // r^2 R^2, the radial density
    const cdf = new Float64Array(RSTEPS + 1);

    let maxR2 = 0;
    for (let i = 0; i <= RSTEPS; i++) {
      const r = i * dr;
      const R = radial(n, l, r);
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

      // Uniform direction, kept with probability Y^2 / maxY^2.
      let cosTheta, phi;
      for (;;) {
        cosTheta = 2 * Math.random() - 1;
        phi = Math.random() * 2 * Math.PI;
        const y = realY(l, m, cosTheta, phi);
        if (Math.random() * maxY2 <= y * y) break;
      }

      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      out[off + 0] = r * sinTheta * Math.cos(phi);
      out[off + 1] = r * sinTheta * Math.sin(phi);
      out[off + 2] = r * cosTheta;
    }

    return {
      n, l, m,
      rOuter,
      /** Peak of |psi|^2 anywhere — the two factors max out independently. */
      maxDensity: maxR2 * maxY2,
      sample,
      density(x, y, z) { const p = psi(n, l, m, x, y, z); return p * p; },
      psi(x, y, z) { return psi(n, l, m, x, y, z); },
    };
  }

  /** Spectroscopic name, e.g. (3, 2, -1) -> "3d". Empty past l = 5, which has no
   *  standard letter, so callers simply show nothing rather than a placeholder. */
  function label(n, l, m) {
    const letter = 'spdfgh'[l];
    if (letter === undefined) return '';
    return n + letter + (m === 0 ? '' : (m > 0 ? '+' : '-') + Math.abs(m));
  }

  global.Orbital = { sampler, clampQuantum, laguerre, nalp, realY, radial, label };
})(window);
