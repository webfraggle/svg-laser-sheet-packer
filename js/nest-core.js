// Pure nesting algorithm. The factory body must stay self-contained: worker-host.js
// stringifies SVGB_nestCoreFactory via .toString() into a Blob worker, so nothing
// outside this function (no DOM, no require, no outer closures) may be referenced.
function SVGB_nestCoreFactory() {
  'use strict';

  var now = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  // Small seeded PRNG (mulberry32), returns floats in [0, 1).
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function toI32(a) {
    if (a instanceof Int32Array) return a;
    return Int32Array.from(a || []);
  }

  // Normalizes an RLE to Int32Arrays with exactly h rows (missing rows are empty).
  function normRle(rle, h) {
    var rp = toI32(rle && rle.rowPtr), runs = toI32(rle && rle.runs);
    if (rp.length === h + 1) return { rowPtr: rp, runs: runs };
    var out = new Int32Array(h + 1);
    for (var r = 0; r <= h; r++) out[r] = r < rp.length ? rp[r] : (rp.length ? rp[rp.length - 1] : 0);
    return { rowPtr: out, runs: runs };
  }

  function rleToBits(rle, w, h) {
    var m = new Uint8Array(w * h);
    for (var r = 0; r < h; r++) {
      for (var j = rle.rowPtr[r]; j < rle.rowPtr[r + 1]; j++) {
        var a = Math.max(0, rle.runs[2 * j]), b = Math.min(w, rle.runs[2 * j + 1]);
        for (var x = a; x < b; x++) m[r * w + x] = 1;
      }
    }
    return m;
  }

  function bitsToRle(m, w, h) {
    var rowPtr = new Int32Array(h + 1), runs = [];
    for (var r = 0; r < h; r++) {
      rowPtr[r] = runs.length / 2;
      var x = 0;
      while (x < w) {
        while (x < w && !m[r * w + x]) x++;
        if (x >= w) break;
        var x0 = x;
        while (x < w && m[r * w + x]) x++;
        runs.push(x0, x);
      }
    }
    rowPtr[h] = runs.length / 2;
    return { rowPtr: rowPtr, runs: Int32Array.from(runs) };
  }

  // Transposed copy of an RLE (cell (x,y) -> (y,x)); used for the left-bottom frame.
  function transposeRle(rle, w, h) {
    var m = rleToBits(rle, w, h), t = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) t[x * h + y] = m[y * w + x];
    return bitsToRle(t, h, w);
  }

  // Flattens a variant for fast search. Returns null if the shape mask is empty.
  function prepVariant(w, h, shape, coll) {
    var sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
    var sRow = [], sA = [], sB = [];
    for (var r = 0; r < h; r++) {
      for (var j = shape.rowPtr[r]; j < shape.rowPtr[r + 1]; j++) {
        var a = shape.runs[2 * j], b = shape.runs[2 * j + 1];
        if (b <= a) continue;
        sRow.push(r); sA.push(a); sB.push(b);
        if (a < sx0) sx0 = a;
        if (b > sx1) sx1 = b;
        if (r < sy0) sy0 = r;
        if (r + 1 > sy1) sy1 = r + 1;
      }
    }
    if (!sRow.length) return null;
    var cRow = [], cA = [], cB = [];
    for (r = 0; r < h; r++) {
      for (j = coll.rowPtr[r]; j < coll.rowPtr[r + 1]; j++) {
        a = coll.runs[2 * j]; b = coll.runs[2 * j + 1];
        if (b <= a) continue;
        cRow.push(r); cA.push(a); cB.push(b);
      }
    }
    return {
      sx0: sx0, sx1: sx1, sy0: sy0, sy1: sy1,
      sRow: Int32Array.from(sRow), sA: Int32Array.from(sA), sB: Int32Array.from(sB),
      cRow: Int32Array.from(cRow), cA: Int32Array.from(cA), cB: Int32Array.from(cB)
    };
  }

  // Builds the search frame. transposed=true swaps axes so that the same bottom-left
  // search yields "min x, then min y" in the original frame.
  function buildFrame(input, transposed) {
    var W = transposed ? input.sheetH : input.sheetW;
    var H = transposed ? input.sheetW : input.sheetH;
    var shapes = [];
    for (var s = 0; s < input.shapes.length; s++) {
      var src = input.shapes[s], vs = [];
      var variants = (src && src.variants) || [];
      for (var v = 0; v < variants.length; v++) {
        var vr = variants[v], w = vr.w | 0, h = vr.h | 0;
        if (w <= 0 || h <= 0) continue;
        var shape = normRle(vr.shape, h), coll = normRle(vr.coll || vr.shape, h);
        if (transposed) {
          shape = transposeRle(shape, w, h);
          coll = transposeRle(coll, w, h);
          var t = w; w = h; h = t;
        }
        var pv = prepVariant(w, h, shape, coll);
        if (!pv) continue;
        if (pv.sx1 - pv.sx0 > W || pv.sy1 - pv.sy0 > H) continue;
        pv.index = v;
        vs.push(pv);
      }
      shapes.push(vs);
    }
    return { W: W, H: H, wpr: (W + 31) >>> 5, shapes: shapes, transposed: transposed };
  }

  // ---- Bitset occupancy -------------------------------------------------

  // Highest occupied cell in [a, b) of a row, or -1.
  function lastSet(occ, base, a, b) {
    var wa = a >>> 5, wb = (b - 1) >>> 5;
    for (var w = wb; w >= wa; w--) {
      var v = occ[base + w];
      if (v === 0) continue;
      if (w === wb) v &= 0xffffffff >>> (31 - ((b - 1) & 31));
      if (w === wa) v &= 0xffffffff << (a & 31);
      if (v !== 0) return (w << 5) + 31 - Math.clz32(v);
    }
    return -1;
  }

  function setSpan(occ, base, a, b) {
    var wa = a >>> 5, wb = (b - 1) >>> 5;
    for (var w = wa; w <= wb; w++) {
      var m = 0xffffffff;
      if (w === wb) m &= 0xffffffff >>> (31 - ((b - 1) & 31));
      if (w === wa) m &= 0xffffffff << (a & 31);
      occ[base + w] |= m;
    }
  }

  var NO_FIT = -2147483648;

  // Smallest x <= xLimit at row y where the variant fits, or NO_FIT (x may be negative: coll/padding may hang over the edge).
  // On a collision, x jumps just past the last occupied cell in the colliding span.
  function findInRow(F, occ, pv, y, xLimit, hint) {
    var W = F.W, H = F.H, wpr = F.wpr;
    var cRow = pv.cRow, cA = pv.cA, cB = pv.cB, n = cRow.length;
    var x = -pv.sx0;
    var xmax = W - pv.sx1;
    if (xLimit < xmax) xmax = xLimit;
    var start = hint[0];
    if (start >= n) start = 0;
    outer:
    while (x <= xmax) {
      for (var t = 0; t < n; t++) {
        var j = start + t;
        if (j >= n) j -= n;
        var yy = y + cRow[j];
        if (yy < 0 || yy >= H) continue;
        var a = x + cA[j], b = x + cB[j];
        if (a < 0) a = 0;
        if (b > W) b = W;
        if (a >= b) continue;
        var p = lastSet(occ, yy * wpr, a, b);
        if (p >= 0) {
          x = p - cA[j] + 1;
          start = j;
          continue outer;
        }
      }
      hint[0] = start;
      return x;
    }
    hint[0] = start;
    return NO_FIT;
  }

  function stamp(F, occ, pv, x, y) {
    var wpr = F.wpr;
    for (var j = 0; j < pv.sRow.length; j++) {
      setSpan(occ, (y + pv.sRow[j]) * wpr, x + pv.sA[j], x + pv.sB[j]);
    }
  }

  // ---- One packing run --------------------------------------------------

  // strat: { frame, sequence: Int32Array of shape indices, varOrders: [[variant pos]],
  //          offMode: 0 top | 1 bottom | 2 center, cap, rr: bool }
  function runOnce(F, occ, strat, nShapes, deadline, minUsefulK) {
    occ.fill(0);
    var shapes = F.shapes;
    var lb = [], hints = [], offs = [];
    for (var s = 0; s < nShapes; s++) {
      var vs = shapes[s];
      lb.push(new Int32Array(vs.length));
      var hs = [], os = new Int32Array(vs.length);
      for (var v = 0; v < vs.length; v++) {
        hs.push([0]);
        var pv = vs[v];
        os[v] = strat.offMode === 1 ? pv.sy1 : strat.offMode === 2 ? ((pv.sy0 + pv.sy1) >> 1) : pv.sy0;
        lb[s][v] = -pv.sy0;
      }
      hints.push(hs); offs.push(os);
    }
    var counts = new Int32Array(nShapes), cap = strat.cap;
    var placed = [];
    var seq = strat.sequence;
    for (var i = 0; i < seq.length; i++) {
      s = seq[i];
      if (counts[s] >= cap) continue;
      if (deadline !== null && (i & 3) === 0 && now() > deadline) break;
      vs = shapes[s];
      var order = strat.varOrders[s], lbs = lb[s], os2 = offs[s];
      var bestScore = Infinity, bestX = 0, bestY = 0, bestV = -1;
      for (var oi = 0; oi < order.length; oi++) {
        v = order[oi];
        pv = vs[v];
        var yEnd = F.H - pv.sy1, off = os2[v], y = lbs[v];
        for (; y <= yEnd; y++) {
          var sc = y + off;
          if (sc > bestScore) break;
          var limit = sc === bestScore ? bestX - 1 : 0x7fffffff;
          var x = findInRow(F, occ, pv, y, limit, hints[s][v]);
          if (x !== NO_FIT) {
            bestScore = sc; bestX = x; bestY = y; bestV = v;
            break;
          }
          if (limit !== 0x7fffffff) break; // row may still be feasible beyond bestX
        }
        lbs[v] = y;
      }
      if (bestV < 0) {
        if (counts[s] < cap) cap = counts[s];
        if (strat.rr || cap < minUsefulK) break;
        continue;
      }
      pv = vs[bestV];
      stamp(F, occ, pv, bestX, bestY);
      counts[s]++;
      placed.push({ s: s, v: bestV, x: bestX, y: bestY });
    }
    var k = cap;
    for (s = 0; s < nShapes; s++) if (counts[s] < k) k = counts[s];
    // Keep the first k copies of every shape; any subset of a valid packing is valid.
    var kept = [], seen = new Int32Array(nShapes), maxBottom = 0;
    for (i = 0; i < placed.length; i++) {
      var p = placed[i];
      if (seen[p.s] >= k) continue;
      seen[p.s]++;
      kept.push(p);
      var bot = p.y + shapes[p.s][p.v].sy1;
      if (bot > maxBottom) maxBottom = bot;
    }
    return { k: k, kept: kept, extent: F.H > 0 ? maxBottom / F.H : 0 };
  }

  // ---- Public API -------------------------------------------------------

  function nest(input, onImproved) {
    var t0 = now();
    var sheetW = Math.max(0, input.sheetW | 0), sheetH = Math.max(0, input.sheetH | 0);
    var srcShapes = input.shapes || [];
    var n = srcShapes.length;
    var budget = input.timeBudgetMs == null ? 10000 : +input.timeBudgetMs;
    var rng = makeRng(input.seed == null ? 1 : input.seed);

    var sumArea = 0;
    for (var s = 0; s < n; s++) sumArea += Math.max(0, +srcShapes[s].areaCells || 0);
    var kMax = (n > 0 && sumArea > 0) ? Math.floor(sheetW * sheetH / sumArea) : 0;

    var best = { k: 0, kMax: kMax, runs: 0, elapsedMs: 0, placements: [] };
    var bestExtent = Infinity;
    function finish(runs) {
      best.runs = runs;
      best.elapsedMs = now() - t0;
      if (onImproved) onImproved(best);
      return best;
    }
    if (kMax === 0) return finish(0);

    var frameIn = { sheetW: sheetW, sheetH: sheetH, shapes: srcShapes };
    var frames = [buildFrame(frameIn, false), null];
    for (s = 0; s < n; s++) if (!frames[0].shapes[s].length) return finish(0);
    var occs = [new Uint32Array(frames[0].H * frames[0].wpr), null];

    var areaDesc = [];
    for (s = 0; s < n; s++) areaDesc.push(s);
    areaDesc.sort(function (a, b) { return (+srcShapes[b].areaCells || 0) - (+srcShapes[a].areaCells || 0) || a - b; });

    var deadline = t0 + budget;
    var runs = 0;
    while (true) {
      var r = runs;
      var frameIdx, offMode, rr = true, setOrder = areaDesc.slice(), perSetShuffle = false, varMode = 0;
      if (r < 4) {
        frameIdx = r & 1;
        offMode = r < 2 ? 0 : 1;
      } else {
        frameIdx = rng() < 0.5 ? 0 : 1;
        offMode = Math.floor(rng() * 3);
        rr = !(best.k > 0 && rng() < 0.5);
        var om = rng();
        if (om < 0.4) { /* keep area-descending */ }
        else if (om < 0.7) shuffle(setOrder, rng);
        else perSetShuffle = true;
        varMode = Math.floor(rng() * 3);
      }
      if (frameIdx === 1 && !frames[1]) {
        frames[1] = buildFrame(frameIn, true);
        occs[1] = new Uint32Array(frames[1].H * frames[1].wpr);
      }
      var F = frames[frameIdx];

      var varOrders = [];
      for (s = 0; s < n; s++) {
        var vo = [];
        for (var v = 0; v < F.shapes[s].length; v++) vo.push(v);
        if (varMode === 1) vo.reverse();
        else if (varMode === 2) shuffle(vo, rng);
        varOrders.push(vo);
      }

      var cap, seq = [];
      if (rr) {
        cap = kMax;
        for (var k = 0; k < kMax; k++) {
          var so = perSetShuffle ? shuffle(areaDesc.slice(), rng) : setOrder;
          for (var q = 0; q < n; q++) seq.push(so[q]);
        }
      } else {
        // Target mode: try best.k + 1 copies of each shape, grouped by shape.
        cap = Math.min(kMax, best.k + 1);
        if (perSetShuffle) {
          for (k = 0; k < cap; k++) for (q = 0; q < n; q++) seq.push(setOrder[q]);
          shuffle(seq, rng);
        } else {
          for (q = 0; q < n; q++) for (k = 0; k < cap; k++) seq.push(setOrder[q]);
        }
      }

      var res = runOnce(F, occs[frameIdx], {
        sequence: seq, varOrders: varOrders, offMode: offMode, cap: cap, rr: rr
      }, n, runs === 0 ? null : deadline, best.k);
      runs++;

      if (res.k > best.k || (res.k === best.k && res.k > 0 && res.extent < bestExtent)) {
        var pl = [];
        for (var i = 0; i < res.kept.length; i++) {
          var p = res.kept[i], pv = F.shapes[p.s][p.v];
          pl.push(F.transposed
            ? { shape: p.s, variant: pv.index, x: p.y, y: p.x }
            : { shape: p.s, variant: pv.index, x: p.x, y: p.y });
        }
        best = { k: res.k, kMax: kMax, runs: runs, elapsedMs: now() - t0, placements: pl };
        bestExtent = res.extent;
        if (onImproved) onImproved(best);
      }
      if (best.k >= kMax || now() >= deadline) break;
    }
    return finish(runs);
  }

  function validate(input, placements) {
    var errors = [];
    var MAX_ERRORS = 50;
    function err(msg) { if (errors.length < MAX_ERRORS) errors.push(msg); }
    var W = input.sheetW | 0, H = input.sheetH | 0, shapes = input.shapes || [];
    var owner = new Int32Array(Math.max(0, W * H)).fill(-1);
    var counts = new Int32Array(shapes.length);
    var prepared = [];

    for (var i = 0; i < placements.length; i++) {
      var p = placements[i];
      var sh = shapes[p.shape];
      var vr = sh && sh.variants && sh.variants[p.variant];
      if (!vr) { err('Teil ' + i + ': ungültige Form/Variante'); prepared.push(null); continue; }
      counts[p.shape]++;
      var h = vr.h | 0;
      var shape = normRle(vr.shape, h), coll = normRle(vr.coll || vr.shape, h);
      prepared.push({ shape: shape, coll: coll, h: h });
      var oob = false, overlap = -1;
      for (var r = 0; r < h; r++) {
        var y = p.y + r;
        for (var j = shape.rowPtr[r]; j < shape.rowPtr[r + 1]; j++) {
          for (var x = p.x + shape.runs[2 * j]; x < p.x + shape.runs[2 * j + 1]; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) { oob = true; continue; }
            var o = owner[y * W + x];
            if (o >= 0 && o !== i) overlap = o;
            else owner[y * W + x] = i;
          }
        }
      }
      if (oob) err('Teil ' + i + ' (Form ' + p.shape + ') liegt außerhalb des Bogens');
      if (overlap >= 0) err('Teil ' + i + ' überlappt Teil ' + overlap);
    }

    for (i = 0; i < placements.length; i++) {
      var pr = prepared[i];
      if (!pr) continue;
      p = placements[i];
      var hit = -1;
      for (r = 0; r < pr.h && hit < 0; r++) {
        y = p.y + r;
        if (y < 0 || y >= H) continue;
        for (j = pr.coll.rowPtr[r]; j < pr.coll.rowPtr[r + 1] && hit < 0; j++) {
          var a = Math.max(0, p.x + pr.coll.runs[2 * j]), b = Math.min(W, p.x + pr.coll.runs[2 * j + 1]);
          for (x = a; x < b; x++) {
            o = owner[y * W + x];
            if (o >= 0 && o !== i) { hit = o; break; }
          }
        }
      }
      if (hit >= 0) err('Teil ' + i + ' unterschreitet den Mindestabstand zu Teil ' + hit);
    }

    for (var s = 1; s < counts.length; s++) {
      if (counts[s] !== counts[0]) { err('Ungleiche Anzahl: Form 0 x' + counts[0] + ', Form ' + s + ' x' + counts[s]); }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  return { nest: nest, validate: validate };
}

if (typeof module !== 'undefined') module.exports = SVGB_nestCoreFactory;
