// Length parsing -> mm. Pure (no DOM), also loadable in Node via require().
(function (SVGB) {
  'use strict';

  var PX_MM = 25.4 / 96;

  // mm per unit. Unitless = px (SVG user units at 96 dpi).
  var UNIT_MM = {
    '': PX_MM,
    px: PX_MM,
    mm: 1,
    cm: 10,
    q: 0.25,
    in: 25.4,
    pt: 25.4 / 72,
    pc: 25.4 / 6
  };

  var LENGTH_RE = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i;

  // "10mm", " 2.5 in ", "1e2", "300" (px) -> mm. Returns null for %, em, empty or invalid input.
  function toMm(str) {
    if (typeof str === 'number') return isFinite(str) ? str * PX_MM : null;
    if (typeof str !== 'string') return null;
    var m = LENGTH_RE.exec(str);
    if (!m) return null;
    var unit = m[2].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(UNIT_MM, unit)) return null;
    var v = parseFloat(m[1]);
    if (!isFinite(v)) return null;
    return v * UNIT_MM[unit];
  }

  // "0 0 100 50" / "0,0,100,50" -> [minX, minY, w, h]; null if malformed or w/h <= 0.
  function parseViewBox(str) {
    if (typeof str !== 'string') return null;
    var parts = str.trim().split(/[\s,]+/);
    if (parts.length !== 4) return null;
    var vb = [];
    for (var i = 0; i < 4; i++) {
      var v = Number(parts[i]);
      if (parts[i] === '' || !isFinite(v)) return null;
      vb.push(v);
    }
    if (vb[2] <= 0 || vb[3] <= 0) return null;
    return vb;
  }

  function positiveMm(str) {
    var v = toMm(str);
    return v !== null && v > 0 ? v : null;
  }

  // Applies the size rule from CLAUDE.md to the root attributes (strings or null).
  // -> { widthMm, heightMm, viewBox } or { error }
  function resolveSize(widthAttr, heightAttr, viewBoxAttr) {
    var vb = parseViewBox(viewBoxAttr);
    var w = positiveMm(widthAttr);
    var h = positiveMm(heightAttr);

    if (w !== null && h !== null) {
      // nothing to derive
    } else if (vb) {
      if (w !== null) h = w * vb[3] / vb[2];
      else if (h !== null) w = h * vb[2] / vb[3];
      else { w = vb[2] * PX_MM; h = vb[3] * PX_MM; }
    } else if (w !== null || h !== null) {
      return { error: (w === null ? 'Breite' : 'Höhe') + ' fehlt und keine viewBox vorhanden' };
    } else {
      return { error: 'Keine Größenangabe (width/height oder viewBox) gefunden' };
    }

    if (!vb) vb = [0, 0, w / PX_MM, h / PX_MM];
    return { widthMm: w, heightMm: h, viewBox: vb };
  }

  SVGB.units = {
    PX_MM: PX_MM,
    toMm: toMm,
    parseViewBox: parseViewBox,
    resolveSize: resolveSize
  };

  if (typeof module !== 'undefined') module.exports = SVGB.units;
})(typeof window !== 'undefined' ? (window.SVGB = window.SVGB || {}) : {});
