// Builds the final vector SVG (in mm) from the original geometry and the nesting result.
//
// Every placed part is written out as a real copy: <g transform="matrix(...)"> containing the source content,
// with IDs made unique per copy. No <symbol>/<use>: laser tools like meerk40t do not scale stroke widths
// through a symbol's viewBox. meerk40t operations (<g type="op ...">) and <note> are hoisted to the document
// root once, and their `references` are rewritten to the IDs of all copies.
(function (SVGB) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var CACHE_DROP_ATTRS = { bounds: 1, paint_bounds: 1 };  // meerk40t caches; invalid after transforming

  function num(v) {
    var s = (Math.round(v * 10000) / 10000).toString();
    return s === '-0' ? '0' : s;
  }
  function prec(v) {
    var s = Number(v.toPrecision(12)).toString();
    return s === '-0' ? '0' : s;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // 2D affine matrices as [a, b, c, d, e, f] (SVG order).
  function mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }
  function translate(x, y) { return [1, 0, 0, 1, x, y]; }
  function scale(x, y) { return [x, 0, 0, y, 0, 0]; }
  function rotate(deg) {
    var r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return [c, s, -s, c, 0, 0];
  }

  // viewBox → viewport (widthMm × heightMm) mapping, following preserveAspectRatio like the rasterizer's <img>.
  function viewBoxMatrix(src) {
    var vb = src.viewBox, W = src.widthMm, H = src.heightMm;
    var sx = W / vb[2], sy = H / vb[3];
    var par = (src.preserveAspectRatio || 'xMidYMid meet').trim().split(/\s+/);
    var align = par[0], slice = par[1] === 'slice';
    if (align === 'none') return mul(scale(sx, sy), translate(-vb[0], -vb[1]));
    var s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
    var dx = W - vb[2] * s, dy = H - vb[3] * s;
    var ax = /xMid/.test(align) ? dx / 2 : /xMax/.test(align) ? dx : 0;
    var ay = /YMid/.test(align) ? dy / 2 : /YMax/.test(align) ? dy : 0;
    return mul(translate(ax, ay), mul(scale(s, s), translate(-vb[0], -vb[1])));
  }

  function isOp(el) { return /^op\s/.test(el.getAttribute('type') || ''); }

  // Parsed, per-source template: content without ops/notes, plus the extracted ops/notes.
  var templateCache = new WeakMap();
  function getTemplate(src) {
    var t = templateCache.get(src);
    if (t) return t;
    var doc = new DOMParser().parseFromString(
      '<svg xmlns="' + SVG_NS + '" xmlns:xlink="' + XLINK_NS + '">' + src.innerMarkup + '</svg>', 'image/svg+xml');
    var root = doc.documentElement;
    var ops = [], notes = [], ids = Object.create(null);
    var all = Array.prototype.slice.call(root.getElementsByTagName('*'));
    all.forEach(function (el) {
      if (isOp(el)) { ops.push(el); return; }
      if (el.localName === 'note') { notes.push(el.getAttribute('text') || el.textContent || ''); return; }
    });
    ops.concat(all.filter(function (el) { return el.localName === 'note'; })).forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    Array.prototype.forEach.call(root.getElementsByTagName('*'), function (el) {
      var id = el.getAttribute('id');
      if (id) ids[id] = true;
      Object.keys(CACHE_DROP_ATTRS).forEach(function (a) { el.removeAttribute(a); });
    });
    t = { root: root, ops: ops, notes: notes, ids: ids, idPrefix: 's' + src.index + '_' };
    templateCache.set(src, t);
    return t;
  }

  // Clone the template content, prefixing all IDs and internal references with `pre`.
  function cloneContent(t, pre) {
    var ser = new XMLSerializer();
    var out = '';
    for (var n = t.root.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      var c = n.cloneNode(true);
      var els = [c].concat(Array.prototype.slice.call(c.getElementsByTagName('*')));
      for (var i = 0; i < els.length; i++) {
        var attrs = els[i].attributes;
        for (var j = 0; j < attrs.length; j++) {
          var a = attrs[j], v = a.value;
          if (a.localName === 'id') a.value = pre + v;
          else if (a.localName === 'href' && v.charAt(0) === '#' && t.ids[v.slice(1)]) a.value = '#' + pre + v.slice(1);
          else if (v.indexOf('url(') !== -1) {
            a.value = v.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, function (m, q, id) {
              return t.ids[id] ? 'url(#' + pre + id + ')' : m;
            });
          }
        }
      }
      out += ser.serializeToString(c);
    }
    return out;
  }

  // meerk40t op: everything except id/references identifies the operation (for merging across sources).
  function opKey(el) {
    return Array.prototype.map.call(el.attributes, function (a) { return a; })
      .filter(function (a) { return a.name !== 'id' && a.name !== 'references'; })
      .map(function (a) { return a.name + '=' + a.value; }).sort().join('\u0001');
  }

  // opts = {
  //   items: [{ source, masks }]   // same order as nesting input.shapes
  //   result,                      // nest-core result
  //   sheetWmm, sheetHmm, marginMm, cellMm,
  //   frame: boolean               // draw sheet outline (blue hairline – may be picked up by laser software!)
  // }
  SVGB.buildOutputSvg = function (opts) {
    var W = opts.sheetWmm, H = opts.sheetHmm, cell = opts.cellMm, m = opts.marginMm;
    var parts = [];
    var opMap = Object.create(null), opList = [], notes = [];
    var templates = opts.items.map(function (item) { return getTemplate(item.source); });

    templates.forEach(function (t) {
      t.notes.forEach(function (n) { if (n && notes.indexOf(n) === -1) notes.push(n); });
      t.ops.forEach(function (op) {
        var k = opKey(op);
        if (!opMap[k]) { opMap[k] = { el: op, refs: [] }; opList.push(opMap[k]); }
      });
    });

    opts.result.placements.forEach(function (p, n) {
      var item = opts.items[p.shape];
      var s = item.source, t = templates[p.shape];
      var v = item.masks.variants[p.variant];
      var M = translate(m + p.x * cell + v.cxMm, m + p.y * cell + v.cyMm);
      if (v.angle) M = mul(M, rotate(v.angle));
      M = mul(M, translate(-s.widthMm / 2, -s.heightMm / 2));
      M = mul(M, viewBoxMatrix(s));
      var pre = 'p' + n + '_';
      parts.push('<g id="part' + n + '" transform="matrix(' + M.map(prec).join(' ') + ')">' +
        cloneContent(t, pre) + '</g>');

      // Original references point to unprefixed source IDs; the importer prefixed them with s{i}_.
      t.ops.forEach(function (op) {
        var entry = opMap[opKey(op)];
        (op.getAttribute('references') || '').split(/\s+/).forEach(function (r) {
          if (!r) return;
          var id = t.ids[t.idPrefix + r] ? t.idPrefix + r : (t.ids[r] ? r : null);
          if (id) entry.refs.push(pre + id);
        });
      });
    });

    var out = [];
    out.push('<svg xmlns="' + SVG_NS + '" xmlns:xlink="' + XLINK_NS + '"' +
      ' xmlns:meerk40t="https://github.com/meerk40t/meerk40t/wiki/Namespace"' +
      ' width="' + num(W) + 'mm" height="' + num(H) + 'mm" viewBox="0 0 ' + num(W) + ' ' + num(H) + '">');
    if (notes.length) out.push('<note text="' + esc(notes.join('\n\n')).replace(/\n/g, '&#10;') + '"/>');
    var ser = new XMLSerializer();
    opList.forEach(function (o, i) {
      var c = o.el.cloneNode(false);
      c.setAttribute('id', 'op' + i);
      if (o.refs.length) c.setAttribute('references', o.refs.join(' '));
      else c.removeAttribute('references');
      out.push(ser.serializeToString(c));
    });
    if (opts.frame) {
      out.push('<rect id="sheet-frame" x="0" y="0" width="' + num(W) + '" height="' + num(H) +
        '" fill="none" stroke="#0000ff" stroke-width="0.1"/>');
    }
    out.push('<g id="parts">');
    out.push(parts.join('\n'));
    out.push('</g>');
    out.push('</svg>');
    return out.join('\n');
  };
})(window.SVGB = window.SVGB || {});
