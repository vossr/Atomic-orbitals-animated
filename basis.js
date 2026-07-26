/*
 * basis.js — turns a Basis Set Exchange JSON (here cc-pVDZ) into per-element
 * lists of occupied atomic orbitals for Orbital.gtoSampler().
 *
 * A correlation-consistent basis is generally contracted from atomic
 * Hartree-Fock calculations: within each angular momentum, the leading
 * contraction columns *are* the occupied HF orbitals (1s, 2s, ... under s;
 * 2p, 3p, ... under p), and the trailing columns are correlation functions —
 * usually single free primitives — that describe no orbital at all. So the
 * ground-state electron configuration decides how many columns to keep; the
 * basis file itself never says.
 */
(function (global) {
  'use strict';

  const SYMBOL = [null,
    'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
    'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
    'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
    'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr'];

  // Madelung filling order, enough for Z <= 36. The Cr/Cu anomalies move one
  // electron between 4s and 3d but never empty either shell, so the *set* of
  // occupied shells — all this file cares about — is aufbau-exact through Kr.
  const ORDER = [[1, 0], [2, 0], [2, 1], [3, 0], [3, 1], [4, 0], [3, 2], [4, 1]];

  /** Occupied shells of the neutral ground-state atom: [{n, l, electrons}]. */
  function occupiedShells(Z) {
    const out = [];
    let left = Z;
    for (let i = 0; i < ORDER.length && left > 0; i++) {
      const n = ORDER[i][0], l = ORDER[i][1];
      const e = Math.min(left, 2 * (2 * l + 1));
      out.push({ n, l, electrons: e });
      left -= e;
    }
    return out;
  }

  /**
   * BSE JSON -> [{ Z, symbol, shells: [{n, l, electrons, exponents, coeffs}] }]
   * sorted by Z. Elements past Kr, or whose basis lacks a column for one of
   * their occupied shells, are dropped rather than shown wrong.
   */
  function parse(bse) {
    const out = [];
    for (const key of Object.keys(bse.elements)) {
      const Z = +key;
      if (!SYMBOL[Z]) continue;

      // All contracted functions, per angular momentum, in file order — which
      // is orbital-energy order, matching occupiedShells' n-ascending order.
      const byL = [];
      for (const sh of bse.elements[key].electron_shells) {
        if (sh.angular_momentum.length !== 1) continue;   // no SP shells in cc
        const l = sh.angular_momentum[0];
        const exps = sh.exponents.map(Number);
        if (!byL[l]) byL[l] = [];
        for (const col of sh.coefficients) {
          // Keep only the primitives a column actually uses: most correlation
          // columns are one 1.0 in a fog of zeros.
          const exponents = [], coeffs = [];
          for (let i = 0; i < col.length; i++) {
            const c = Number(col[i]);
            if (c !== 0) { exponents.push(exps[i]); coeffs.push(c); }
          }
          byL[l].push({ exponents, coeffs });
        }
      }

      const shells = [];
      const used = [];
      for (const occ of occupiedShells(Z)) {
        const i = used[occ.l] || 0;
        used[occ.l] = i + 1;
        const fn = (byL[occ.l] || [])[i];
        if (!fn) { shells.length = 0; break; }
        shells.push({ n: occ.n, l: occ.l, electrons: occ.electrons,
                      exponents: fn.exponents, coeffs: fn.coeffs });
      }
      if (shells.length) out.push({ Z, symbol: SYMBOL[Z], shells });
    }
    return out.sort((a, b) => a.Z - b.Z);
  }

  global.Basis = { parse, occupiedShells };
})(window);
