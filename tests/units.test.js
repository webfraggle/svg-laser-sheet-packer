const test = require('node:test');
const assert = require('node:assert');
const units = require('../js/units.js');
const core = require('../js/raster.js');

const PX = 25.4 / 96;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('PX_MM is 96 dpi', () => {
  close(units.PX_MM, 0.26458333333333334);
});

test('toMm: absolute units', () => {
  close(units.toMm('10mm'), 10);
  close(units.toMm('2cm'), 20);
  close(units.toMm('1in'), 25.4);
  close(units.toMm('72pt'), 25.4);
  close(units.toMm('6pc'), 25.4);
  close(units.toMm('96px'), 25.4);
  close(units.toMm('4q'), 1);
  close(units.toMm('4Q'), 1);
  close(units.toMm('10MM'), 10);
});

test('toMm: unitless is px, numbers too', () => {
  close(units.toMm('96'), 25.4);
  close(units.toMm(96), 25.4);
  close(units.toMm('0'), 0);
});

test('toMm: whitespace, decimals, sign, scientific notation', () => {
  close(units.toMm('  12.5 mm '), 12.5);
  close(units.toMm('.5mm'), 0.5);
  close(units.toMm('5.mm'), 5);
  close(units.toMm('+3mm'), 3);
  close(units.toMm('-3mm'), -3);
  close(units.toMm('1e2mm'), 100);
  close(units.toMm('1.5E-1cm'), 1.5);
  close(units.toMm('2e+1px'), 20 * PX);
});

test('toMm: invalid input gives null', () => {
  for (const v of ['', '   ', '50%', '10em', '3ex', 'abc', 'mm', '1.2.3mm', '1 0mm', '10 m m', 'e5',
    null, undefined, NaN, Infinity, {}, '1e999mm']) {
    assert.strictEqual(units.toMm(v), null, String(v));
  }
});

test('parseViewBox', () => {
  assert.deepStrictEqual(units.parseViewBox('0 0 100 50'), [0, 0, 100, 50]);
  assert.deepStrictEqual(units.parseViewBox(' -5,-5, 10 ,20 '), [-5, -5, 10, 20]);
  assert.deepStrictEqual(units.parseViewBox('0 0 1e2 5e1'), [0, 0, 100, 50]);
  assert.strictEqual(units.parseViewBox('0 0 100'), null);
  assert.strictEqual(units.parseViewBox('0 0 0 50'), null);
  assert.strictEqual(units.parseViewBox('0 0 -1 50'), null);
  assert.strictEqual(units.parseViewBox('0 0 a 50'), null);
  assert.strictEqual(units.parseViewBox(null), null);
});

test('resolveSize: width and height given', () => {
  const r = units.resolveSize('50mm', '30mm', '0 0 500 300');
  close(r.widthMm, 50);
  close(r.heightMm, 30);
  assert.deepStrictEqual(r.viewBox, [0, 0, 500, 300]);
});

test('resolveSize: no viewBox -> viewBox in px', () => {
  const r = units.resolveSize('200', '150px', null);
  close(r.widthMm, 200 * PX);
  close(r.heightMm, 150 * PX);
  r.viewBox.forEach((v, i) => close(v, [0, 0, 200, 150][i]));
  const r2 = units.resolveSize('1in', '2in', null);
  r2.viewBox.forEach((v, i) => close(v, [0, 0, 96, 192][i], 1e-6));
});

test('resolveSize: only viewBox -> 1 user unit = 1 px', () => {
  const r = units.resolveSize(null, null, '0 0 100 60');
  close(r.widthMm, 100 * PX);
  close(r.heightMm, 60 * PX);
});

test('resolveSize: percent counts as missing', () => {
  const r = units.resolveSize('100%', '100%', '0 0 100 60');
  close(r.widthMm, 100 * PX);
  close(r.heightMm, 60 * PX);
});

test('resolveSize: one dimension derived from viewBox aspect', () => {
  const a = units.resolveSize('40mm', null, '0 0 200 100');
  close(a.widthMm, 40);
  close(a.heightMm, 20);
  const b = units.resolveSize('100%', '1in', '0 0 200 100');
  close(b.widthMm, 50.8);
  close(b.heightMm, 25.4);
});

test('resolveSize: errors', () => {
  assert.ok(units.resolveSize(null, null, null).error);
  assert.ok(units.resolveSize('10mm', null, null).error);
  assert.ok(units.resolveSize('0mm', '0mm', null).error);
  assert.ok(units.resolveSize('-5mm', '10mm', 'garbage').error);
});

// --- raster core (pure mask helpers from js/raster.js) ----------------------------------------------

function maskFrom(rows) {
  const H = rows.length, W = rows[0].length;
  const m = new Uint8Array(W * H);
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === '#') m[y * W + x] = 1; }));
  return { m, W, H };
}

function squareGap(dx, dy) {
  return Math.hypot(Math.max(Math.abs(dx) - 1, 0), Math.max(Math.abs(dy) - 1, 0));
}

test('kernel: radius matches contract, every excluded offset keeps gap + 1 safety cell', () => {
  for (let g = 0; g < 12; g += 0.07) {
    const k = core.kernel(g);
    assert.strictEqual(k.R, Math.ceil(g) + 1);
    for (let dy = -k.R - 2; dy <= k.R + 2; dy++) {
      for (let dx = -k.R - 2; dx <= k.R + 2; dx++) {
        const inside = Math.abs(dy) <= k.R && k.half[dy + k.R] >= 0 && Math.abs(dx) <= k.half[dy + k.R];
        if (!inside) assert.ok(squareGap(dx, dy) >= g + 1 - 1e-9, `g=${g} (${dx},${dy})`);
        else assert.ok(squareGap(dx, dy) < g + 1 + 1e-9, `kernel too large g=${g} (${dx},${dy})`);
      }
    }
  }
});

test('kernel: gap 0 is a 3x3 block', () => {
  const k = core.kernel(0);
  assert.strictEqual(k.R, 1);
  assert.deepStrictEqual([...k.half], [1, 1, 1]);
});

test('dilate: single cell with gap 0', () => {
  const { m, W, H } = maskFrom(['.....', '.....', '..#..', '.....', '.....']);
  const d = core.dilate(m, W, H, core.kernel(0));
  const bb = core.bbox(d, W, H);
  assert.deepStrictEqual(bb, { x0: 1, y0: 1, x1: 4, y1: 4 });
  assert.strictEqual(d.reduce((a, b) => a + b, 0), 9);
});

test('dilate matches brute force', () => {
  const W = 40, H = 30;
  const m = new Uint8Array(W * H);
  let s = 12345;
  for (let y = 10; y < 20; y++) for (let x = 12; x < 28; x++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    if (s % 3) m[y * W + x] = 1;
  }
  for (const g of [0, 1, 2.5, 4]) {
    const k = core.kernel(g);
    const d = core.dilate(m, W, H, k);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let want = 0;
      for (let dy = -k.R; dy <= k.R && !want; dy++) {
        const hk = k.half[dy + k.R];
        for (let dx = -hk; dx <= hk; dx++) {
          const yy = y - dy, xx = x - dx;
          if (yy >= 0 && yy < H && xx >= 0 && xx < W && m[yy * W + xx]) { want = 1; break; }
        }
      }
      assert.strictEqual(d[y * W + x], want, `g=${g} x=${x} y=${y}`);
    }
  }
});

test('encodeRle: runs are half-open and relative to window', () => {
  const { m, W } = maskFrom(['......', '.##.#.', '......', '.####.']);
  const rle = core.encodeRle(m, W, 1, 1, 4, 3);
  assert.deepStrictEqual([...rle.rowPtr], [0, 2, 2, 3]);
  assert.deepStrictEqual([...rle.runs], [0, 2, 3, 4, 0, 4]);
  assert.ok(rle.rowPtr instanceof Int32Array && rle.runs instanceof Int32Array);
  assert.strictEqual(core.countCells(rle), 7);
});

test('bbox of empty mask is null', () => {
  assert.strictEqual(core.bbox(new Uint8Array(12), 4, 3), null);
});

test('buildVariant: crop to collision bbox and centre offset', () => {
  // 2x2 block at (4..6, 3..5) in a 10x8 canvas, centre of the SVG at (5, 4)
  const W = 10, H = 8, m = new Uint8Array(W * H);
  for (let y = 3; y < 5; y++) for (let x = 4; x < 6; x++) m[y * W + x] = 1;
  const v = core.buildVariant(m, W, H, 5, 4, 0, 0.5);
  assert.strictEqual(v.w, 4);
  assert.strictEqual(v.h, 4);
  close(v.cxMm, (5 - 3) * 0.5);
  close(v.cyMm, (4 - 2) * 0.5);
  assert.deepStrictEqual([...v.shape.rowPtr], [0, 0, 1, 2, 2]);
  assert.deepStrictEqual([...v.shape.runs], [1, 3, 1, 3]);
  assert.strictEqual(core.countCells(v.coll), 16);
  assert.strictEqual(core.buildVariant(new Uint8Array(W * H), W, H, 5, 4, 0, 0.5), null);
});

test('canvasSize: rotated bbox plus padding', () => {
  assert.deepStrictEqual(core.canvasSize(100, 50, 0, 3), { W: 106, H: 56 });
  assert.deepStrictEqual(core.canvasSize(100, 50, 90, 3), { W: 56, H: 106 });
  assert.deepStrictEqual(core.canvasSize(100, 50, 180, 0), { W: 100, H: 50 });
  const s = core.canvasSize(10, 10, 45, 0);
  assert.strictEqual(s.W, Math.ceil(10 * Math.SQRT2));
});

test('rleEqual', () => {
  const a = { rowPtr: Int32Array.of(0, 1), runs: Int32Array.of(0, 2) };
  const b = { rowPtr: Int32Array.of(0, 1), runs: Int32Array.of(0, 2) };
  const c = { rowPtr: Int32Array.of(0, 1), runs: Int32Array.of(0, 3) };
  assert.ok(core.rleEqual(a, b));
  assert.ok(!core.rleEqual(a, c));
});
