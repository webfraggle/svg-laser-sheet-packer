'use strict';
const test = require('node:test');
const assert = require('node:assert');
const factory = require('../js/nest-core.js');

const core = factory();

// ---- Helpers --------------------------------------------------------------

// Bitmap { w, h, m: Uint8Array } from ASCII rows ('#' = filled).
function fromAscii(rows) {
  const h = rows.length, w = Math.max(...rows.map((r) => r.length));
  const m = new Uint8Array(w * h);
  rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === '#') m[y * w + x] = 1; });
  return { w, h, m };
}

function rectBits(w, h) {
  return { w, h, m: new Uint8Array(w * h).fill(1) };
}

function discBits(d) {
  const m = new Uint8Array(d * d), c = (d - 1) / 2, r2 = (d / 2) * (d / 2);
  for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) if ((x - c) ** 2 + (y - c) ** 2 <= r2) m[y * d + x] = 1;
  return { w: d, h: d, m };
}

function rot90(b) {
  const { w, h, m } = b, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = m[y * w + x];
  return { w: h, h: w, m: out };
}

function pad(b, p) {
  const w = b.w + 2 * p, h = b.h + 2 * p, m = new Uint8Array(w * h);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) m[(y + p) * w + x + p] = b.m[y * b.w + x];
  return { w, h, m };
}

// Disc-kernel dilation (symmetric, as the rasterizer uses).
function dilate(b, r) {
  if (r <= 0) return b;
  const { w, h, m } = b, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
    }
  }
  return { w, h, m: out };
}

function toRle(b, plain) {
  const rowPtr = [0], runs = [];
  for (let y = 0; y < b.h; y++) {
    let x = 0;
    while (x < b.w) {
      while (x < b.w && !b.m[y * b.w + x]) x++;
      if (x >= b.w) break;
      const x0 = x;
      while (x < b.w && b.m[y * b.w + x]) x++;
      runs.push(x0, x);
    }
    rowPtr.push(runs.length / 2);
  }
  return plain ? { rowPtr, runs } : { rowPtr: Int32Array.from(rowPtr), runs: Int32Array.from(runs) };
}

// ShapeMasks-like object; each variant bitmap is padded by the gap radius and dilated for coll.
function makeShape(variantBits, gap = 0, plain = false) {
  const area = variantBits[0].m.reduce((a, v) => a + v, 0);
  return {
    areaCells: area,
    variants: variantBits.map((b) => {
      const pb = pad(b, gap);
      return { w: pb.w, h: pb.h, shape: toRle(pb, plain), coll: toRle(dilate(pb, gap), plain) };
    }),
  };
}

function allRotations(b) {
  const r1 = rot90(b), r2 = rot90(r1), r3 = rot90(r2);
  return [b, r1, r2, r3];
}

function counts(result, n) {
  const c = new Array(n).fill(0);
  result.placements.forEach((p) => c[p.shape]++);
  return c;
}

// ---- Edge cases -----------------------------------------------------------

test('empty shapes list returns k=0', () => {
  const r = core.nest({ sheetW: 10, sheetH: 10, shapes: [], timeBudgetMs: 100, seed: 1 });
  assert.strictEqual(r.k, 0);
  assert.strictEqual(r.kMax, 0);
  assert.deepStrictEqual(r.placements, []);
});

test('shape with no variants or empty mask returns k=0', () => {
  const empty = { areaCells: 4, variants: [] };
  const r1 = core.nest({ sheetW: 10, sheetH: 10, shapes: [empty], timeBudgetMs: 100, seed: 1 });
  assert.strictEqual(r1.k, 0);
  const blank = { areaCells: 0, variants: [{ w: 2, h: 2, shape: toRle({ w: 2, h: 2, m: new Uint8Array(4) }), coll: toRle({ w: 2, h: 2, m: new Uint8Array(4) }) }] };
  const r2 = core.nest({ sheetW: 10, sheetH: 10, shapes: [blank], timeBudgetMs: 100, seed: 1 });
  assert.strictEqual(r2.k, 0);
});

test('kMax 0 when total area exceeds sheet', () => {
  const r = core.nest({ sheetW: 5, sheetH: 5, shapes: [makeShape([rectBits(6, 6)])], timeBudgetMs: 100, seed: 1 });
  assert.strictEqual(r.kMax, 0);
  assert.strictEqual(r.k, 0);
});

test('shape that does not fit dimensionally gives k=0', () => {
  const r = core.nest({ sheetW: 10, sheetH: 10, shapes: [makeShape([rectBits(20, 1)])], timeBudgetMs: 100, seed: 1 });
  assert.strictEqual(r.kMax, 5);
  assert.strictEqual(r.k, 0);
});

test('onImproved is called at least once (at end)', () => {
  let calls = 0;
  core.nest({ sheetW: 10, sheetH: 10, shapes: [makeShape([rectBits(5, 5)])], timeBudgetMs: 100, seed: 1 }, () => calls++);
  assert.ok(calls >= 1);
});

// ---- Packing quality ------------------------------------------------------

test('exact fit of rectangles', () => {
  const r = core.nest({ sheetW: 6, sheetH: 6, shapes: [makeShape([rectBits(2, 3)])], timeBudgetMs: 500, seed: 1 });
  assert.strictEqual(r.kMax, 6);
  assert.strictEqual(r.k, 6);
});

test('exact fit of two rectangle shapes', () => {
  const shapes = [makeShape([rectBits(2, 2)]), makeShape([rectBits(4, 2)])];
  const input = { sheetW: 6, sheetH: 4, shapes, timeBudgetMs: 500, seed: 1 };
  const r = core.nest(input);
  assert.strictEqual(r.kMax, 2);
  assert.strictEqual(r.k, 2);
  assert.ok(core.validate(input, r.placements).ok);
});

test('exact fit needs the rotated variant', () => {
  // 3x1 bars into a 3x2 + 2x3 region: sheet 5x3 holds five 3x1 bars only with mixed rotations.
  const bar = rectBits(3, 1);
  const input = { sheetW: 5, sheetH: 3, shapes: [makeShape([bar, rot90(bar)])], timeBudgetMs: 500, seed: 3 };
  const r = core.nest(input);
  assert.strictEqual(r.kMax, 5);
  assert.ok(r.k >= 4, 'k=' + r.k);
  assert.ok(core.validate(input, r.placements).ok);
});

test('L-shapes interlock (bboxes may overlap)', () => {
  const L = fromAscii(['#.', '##']);
  const input = { sheetW: 6, sheetH: 2, shapes: [makeShape(allRotations(L))], timeBudgetMs: 500, seed: 1 };
  const r = core.nest(input);
  // Bbox packing (2x2 boxes) would give 3; interlocking pairs fill 2x3 blocks.
  assert.strictEqual(r.kMax, 4);
  assert.strictEqual(r.k, 4);
  assert.ok(core.validate(input, r.placements).ok);
});

test('equal counts across shapes', () => {
  const shapes = [
    makeShape(allRotations(rectBits(8, 3)), 1),
    makeShape([discBits(5)], 1),
    makeShape(allRotations(fromAscii(['###', '#..', '#..'])), 1),
  ];
  const input = { sheetW: 60, sheetH: 40, shapes, timeBudgetMs: 300, seed: 7 };
  const r = core.nest(input);
  assert.ok(r.k > 0);
  const c = counts(r, 3);
  assert.deepStrictEqual(c, [r.k, r.k, r.k]);
  assert.ok(core.validate(input, r.placements).ok);
});

test('accepts plain arrays as RLE', () => {
  const input = { sheetW: 6, sheetH: 6, shapes: [makeShape([rectBits(2, 3)], 0, true)], timeBudgetMs: 200, seed: 1 };
  const r = core.nest(input);
  assert.strictEqual(r.k, 6);
  assert.ok(core.validate(input, r.placements).ok);
});

test('gap is respected', () => {
  // 2x2 squares with gap 1 on a 8x2 sheet: at most 3 fit (x = 0, 3, 6).
  const input = { sheetW: 8, sheetH: 2, shapes: [makeShape([rectBits(2, 2)], 1)], timeBudgetMs: 200, seed: 1 };
  const r = core.nest(input);
  assert.strictEqual(r.k, 3);
  assert.ok(core.validate(input, r.placements).ok);
});

// ---- Validation -----------------------------------------------------------

test('validate detects overlap, out of bounds, gap and unequal counts', () => {
  const a = makeShape([rectBits(2, 2)], 1);
  const b = makeShape([rectBits(2, 2)], 1);
  const input = { sheetW: 10, sheetH: 10, shapes: [a, b] };
  // Variant grid is 4x4 with the shape at offset 1.
  assert.ok(core.validate(input, [{ shape: 0, variant: 0, x: 0, y: 0 }, { shape: 1, variant: 0, x: 4, y: 0 }]).ok);
  const overlap = core.validate(input, [{ shape: 0, variant: 0, x: 0, y: 0 }, { shape: 1, variant: 0, x: 1, y: 0 }]);
  assert.ok(!overlap.ok);
  assert.ok(overlap.errors.some((e) => /überlappt/.test(e)));
  const gap = core.validate(input, [{ shape: 0, variant: 0, x: 0, y: 0 }, { shape: 1, variant: 0, x: 2, y: 0 }]);
  assert.ok(!gap.ok);
  assert.ok(gap.errors.some((e) => /Mindestabstand/.test(e)));
  const oob = core.validate(input, [{ shape: 0, variant: 0, x: 8, y: 0 }, { shape: 1, variant: 0, x: 0, y: 4 }]);
  assert.ok(!oob.ok);
  assert.ok(oob.errors.some((e) => /außerhalb/.test(e)));
  // Coll outside the sheet is fine as long as the shape is inside.
  assert.ok(core.validate(input, [{ shape: 0, variant: 0, x: -1, y: -1 }, { shape: 1, variant: 0, x: 7, y: 7 }]).ok);
  const unequal = core.validate(input, [{ shape: 0, variant: 0, x: 0, y: 0 }]);
  assert.ok(!unequal.ok);
  assert.ok(unequal.errors.some((e) => /Ungleiche/.test(e)));
});

test('all nest results pass validate (randomized)', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let t = 0; t < 25; t++) {
    const n = 1 + Math.floor(rnd() * 4);
    const gap = Math.floor(rnd() * 3);
    const shapes = [];
    for (let s = 0; s < n; s++) {
      const w = 2 + Math.floor(rnd() * 8), h = 2 + Math.floor(rnd() * 8);
      const b = rectBits(w, h);
      for (let i = 0; i < w * h; i++) if (rnd() < 0.3) b.m[i] = 0;
      b.m[0] = 1;
      shapes.push(makeShape(rnd() < 0.5 ? [b] : allRotations(b), gap));
    }
    const input = { sheetW: 20 + Math.floor(rnd() * 60), sheetH: 20 + Math.floor(rnd() * 60), shapes, timeBudgetMs: 60, seed: t + 1 };
    const r = core.nest(input);
    const v = core.validate(input, r.placements);
    assert.ok(v.ok, 'case ' + t + ': ' + v.errors.join('; '));
    assert.ok(r.k <= r.kMax);
    assert.deepStrictEqual(counts(r, n), new Array(n).fill(r.k));
  }
});

// ---- Performance ----------------------------------------------------------

test('performance: 2000x1200 sheet, 3 shapes ~100 cells', () => {
  const ring = discBits(110);
  const inner = discBits(50);
  for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) if (inner.m[y * 50 + x]) ring.m[(y + 30) * 110 + x + 30] = 0;
  const L = rectBits(120, 90);
  for (let y = 0; y < 60; y++) for (let x = 40; x < 120; x++) L.m[y * 120 + x] = 0;
  const shapes = [
    makeShape(allRotations(rectBits(140, 60)), 3),
    makeShape([ring], 3),
    makeShape(allRotations(L), 3),
  ];
  const input = { sheetW: 2000, sheetH: 1200, shapes, timeBudgetMs: 3000, seed: 42 };
  let first = null;
  const t0 = Date.now();
  const r = core.nest(input, (res) => { if (first === null) first = { ms: Date.now() - t0, k: res.k }; });
  const ms = Date.now() - t0;
  console.log(`perf: first result k=${first.k} after ${first.ms} ms; final k=${r.k}/${r.kMax} after ${ms} ms, ${r.runs} runs`);
  assert.ok(r.k > 0);
  assert.ok(first.ms < 2000, 'first run took ' + first.ms + ' ms');
  assert.ok(ms < 4000, 'took ' + ms + ' ms');
  assert.ok(core.validate(input, r.placements).ok);
});
