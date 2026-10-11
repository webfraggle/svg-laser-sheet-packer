// Render each rotation of a Source to a canvas and turn it into RLE masks (ShapeMasks, see CLAUDE.md).
// The pure mask helpers (SVGB.rasterCore) have no DOM dependency and are also loadable in Node.
(function (SVGB) {
  'use strict';

  // --- pure helpers -------------------------------------------------------------------------------

  // Dilation kernel for a gap of `gapCells` (= gapMm / cellMm, not rounded) plus one safety cell.
  // Offset (dx, dy) is in the kernel iff the distance between the two unit squares is < gapCells + 1,
  // i.e. hypot(max(|dx|-1, 0), max(|dy|-1, 0)) < gapCells + 1. A plain disc of radius
  // ceil(gap)+1 measured between cell centres is not enough on diagonals (e.g. gap 2.83, offset 3,3).
  // Returns { R, half } where half[dy + R] is the max |dx| for row dy, or -1 if the row is empty.
  // R = ceil(gapCells) + 1, matching the dilation radius in the contract.
  function kernel(gapCells) {
    var g = Math.max(0, gapCells) + 1;
    var R = Math.ceil(Math.max(0, gapCells)) + 1;
    var half = new Int32Array(2 * R + 1);
    for (var dy = -R; dy <= R; dy++) {
      var t = Math.max(Math.abs(dy) - 1, 0);
      var q = g * g - t * t;
      half[dy + R] = q > 0 ? Math.ceil(Math.sqrt(q) - 1e-9) : -1;
    }
    return { R: R, half: half };
  }

  // Binary mask (Uint8Array W*H, nonzero = set) dilated by the kernel, via per-row difference arrays.
  function dilate(mask, W, H, k) {
    var R = k.R, half = k.half;
    var W1 = W + 1;
    var diff = new Int32Array(W1 * H);
    for (var y = 0; y < H; y++) {
      var row = y * W;
      var x = 0;
      while (x < W) {
        if (!mask[row + x]) { x++; continue; }
        var x0 = x;
        while (x < W && mask[row + x]) x++;
        for (var dy = -R; dy <= R; dy++) {
          var hk = half[dy + R];
          var yy = y + dy;
          if (hk < 0 || yy < 0 || yy >= H) continue;
          var a = x0 - hk, b = x + hk;
          if (a < 0) a = 0;
          if (b > W) b = W;
          diff[yy * W1 + a]++;
          diff[yy * W1 + b]--;
        }
      }
    }
    var out = new Uint8Array(W * H);
    for (y = 0; y < H; y++) {
      var acc = 0, d = y * W1, o = y * W;
      for (x = 0; x < W; x++) {
        acc += diff[d + x];
        if (acc > 0) out[o + x] = 1;
      }
    }
    return out;
  }

  // Tight bbox of set cells: { x0, y0, x1, y1 } (half-open) or null if empty.
  function bbox(mask, W, H) {
    var x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (var y = 0; y < H; y++) {
      var row = y * W;
      for (var x = 0; x < W; x++) {
        if (mask[row + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x0: x0, y0: y0, x1: x1 + 1, y1: y1 + 1 };
  }

  // RLE of the window [bx, bx+w) x [by, by+h) of a W-wide mask; x relative to bx.
  function encodeRle(mask, W, bx, by, w, h) {
    var rowPtr = new Int32Array(h + 1);
    var runs = [];
    for (var r = 0; r < h; r++) {
      rowPtr[r] = runs.length / 2;
      var row = (by + r) * W + bx;
      var x = 0;
      while (x < w) {
        if (!mask[row + x]) { x++; continue; }
        var x0 = x;
        while (x < w && mask[row + x]) x++;
        runs.push(x0, x);
      }
    }
    rowPtr[h] = runs.length / 2;
    return { rowPtr: rowPtr, runs: Int32Array.from(runs) };
  }

  function countCells(rle) {
    var n = 0, runs = rle.runs;
    for (var i = 0; i < runs.length; i += 2) n += runs[i + 1] - runs[i];
    return n;
  }

  function rleEqual(a, b) {
    if (a.rowPtr.length !== b.rowPtr.length || a.runs.length !== b.runs.length) return false;
    for (var i = 0; i < a.rowPtr.length; i++) if (a.rowPtr[i] !== b.rowPtr[i]) return false;
    for (i = 0; i < a.runs.length; i++) if (a.runs[i] !== b.runs[i]) return false;
    return true;
  }

  // shapeMask: Uint8Array W*H of the rendered variant, (centerX, centerY) = SVG centre in canvas cells.
  // Returns a variant (without angle) or null if the shape is empty.
  function buildVariant(shapeMask, W, H, centerX, centerY, gapCells, cellMm) {
    var coll = dilate(shapeMask, W, H, kernel(gapCells));
    var bb = bbox(coll, W, H);
    if (!bb) return null;
    var w = bb.x1 - bb.x0, h = bb.y1 - bb.y0;
    return {
      w: w,
      h: h,
      cxMm: (centerX - bb.x0) * cellMm,
      cyMm: (centerY - bb.y0) * cellMm,
      shape: encodeRle(shapeMask, W, bb.x0, bb.y0, w, h),
      coll: encodeRle(coll, W, bb.x0, bb.y0, w, h)
    };
  }

  // Canvas size (cells) for one angle: rotated bbox of the w x h rect plus padding on every side.
  function canvasSize(wCells, hCells, angleDeg, pad) {
    var a = angleDeg * Math.PI / 180;
    var c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    // Snap float noise so 90 deg does not grow by a cell.
    if (c < 1e-12) c = 0;
    if (s < 1e-12) s = 0;
    var bw = wCells * c + hCells * s, bh = wCells * s + hCells * c;
    return { W: Math.ceil(bw - 1e-9) + 2 * pad, H: Math.ceil(bh - 1e-9) + 2 * pad };
  }

  var core = {
    kernel: kernel,
    dilate: dilate,
    bbox: bbox,
    encodeRle: encodeRle,
    countCells: countCells,
    rleEqual: rleEqual,
    buildVariant: buildVariant,
    canvasSize: canvasSize
  };
  SVGB.rasterCore = core;
  if (typeof module !== 'undefined') module.exports = core;

  if (typeof document === 'undefined') return;

  // --- browser part -------------------------------------------------------------------------------

  var MAX_CANVAS_PX = 16e6;

  // standaloneSvg is sized in mm; give the raster image a px size equal to the target cell size so the
  // browser rasterizes the vector at the final resolution.
  function imageSvg(source, wCells, hCells) {
    var doc = new DOMParser().parseFromString(source.standaloneSvg, 'image/svg+xml');
    var root = doc.documentElement;
    root.setAttribute('width', String(wCells));
    root.setAttribute('height', String(hCells));
    return new XMLSerializer().serializeToString(root);
  }

  function loadImage(svgText) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
      var img = new Image();
      img.onload = function () {
        var done = function () { URL.revokeObjectURL(url); resolve(img); };
        if (img.decode) img.decode().then(done, done);
        else done();
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('SVG konnte nicht gerendert werden'));
      };
      img.src = url;
    });
  }

  function renderAngle(img, wCells, hCells, angle, pad) {
    var size = canvasSize(wCells, hCells, angle, pad);
    var W = size.W, H = size.H;
    if (W * H > MAX_CANVAS_PX) {
      throw new Error('SVG ist für die gewählte Auflösung zu groß (' + W + '×' + H + ' Zellen)');
    }
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var cx = W / 2, cy = H / 2;
    ctx.translate(cx, cy);
    ctx.rotate(angle * Math.PI / 180);
    ctx.drawImage(img, -wCells / 2, -hCells / 2, wCells, hCells);

    var data;
    try {
      data = ctx.getImageData(0, 0, W, H).data;
    } catch (e) {
      throw new Error('SVG kann nicht ausgelesen werden (z. B. wegen <foreignObject> oder externer Bilder)');
    }
    var mask = new Uint8Array(W * H);
    for (var i = 0, p = 3; i < mask.length; i++, p += 4) if (data[p] > 0) mask[i] = 1;
    return { mask: mask, W: W, H: H, cx: cx, cy: cy };
  }

  // -> Promise<ShapeMasks>. angles in degrees (rotation of the SVG about its centre, clockwise like SVG).
  SVGB.rasterize = function (source, opts) {
    var cellMm = opts.cellMm;
    var angles = opts.angles && opts.angles.length ? opts.angles : [0];
    var gapCells = Math.max(0, opts.gapMm || 0) / cellMm;
    var wCells = source.widthMm / cellMm;
    var hCells = source.heightMm / cellMm;
    var pad = kernel(gapCells).R + 2; // dilation radius + room for antialiasing spill

    return loadImage(imageSvg(source, wCells, hCells)).then(function (img) {
      var variants = [];
      var areaCells = -1;
      for (var i = 0; i < angles.length; i++) {
        var angle = angles[i];
        var r = renderAngle(img, wCells, hCells, angle, pad);
        var v = buildVariant(r.mask, r.W, r.H, r.cx, r.cy, gapCells, cellMm);
        if (!v || v.shape.runs.length === 0) throw new Error('SVG enthält keine gefüllten Flächen');
        // Area is rotation invariant up to rasterization noise; take angle 0 (or the first angle).
        if (areaCells < 0 || angle === 0) areaCells = countCells(v.shape);
        var dup = variants.some(function (o) {
          return o.w === v.w && o.h === v.h && rleEqual(o.shape, v.shape) && rleEqual(o.coll, v.coll);
        });
        if (dup) continue;
        variants.push({ angle: angle, w: v.w, h: v.h, cxMm: v.cxMm, cyMm: v.cyMm, shape: v.shape, coll: v.coll });
      }
      return {
        index: source.index,
        areaCells: areaCells,
        areaMm2: areaCells * cellMm * cellMm,
        variants: variants
      };
    });
  };

  // Debug view of one variant: shape dark, collision halo light, 1 canvas px per cell.
  SVGB.rasterDebugCanvas = function (variant) {
    var canvas = document.createElement('canvas');
    canvas.width = variant.w;
    canvas.height = variant.h;
    var ctx = canvas.getContext('2d');
    function paint(rle, color) {
      ctx.fillStyle = color;
      for (var r = 0; r < variant.h; r++) {
        for (var j = rle.rowPtr[r]; j < rle.rowPtr[r + 1]; j++) {
          ctx.fillRect(rle.runs[2 * j], r, rle.runs[2 * j + 1] - rle.runs[2 * j], 1);
        }
      }
    }
    paint(variant.coll, '#cfd8e3');
    paint(variant.shape, '#1f2937');
    return canvas;
  };
})(typeof window !== 'undefined' ? (window.SVGB = window.SVGB || {}) : {});
