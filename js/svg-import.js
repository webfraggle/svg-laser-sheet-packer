// Parse SVG text into a Source (see CLAUDE.md): size in mm, IDs/classes prefixed, scripts removed.
(function (SVGB) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

  function fail(index, name, error) {
    return { index: index, name: name, ok: false, error: error };
  }

  function fmt(n) {
    return String(Math.round(n * 1e6) / 1e6);
  }

  // Files without xmlns (or using xlink: without declaring it) do not parse as SVG; patch the root tag.
  function patchNamespaces(text) {
    var m = /<svg\b[^>]*>/.exec(text);
    if (!m) return text;
    var tag = m[0];
    var patched = tag;
    if (!/\sxmlns\s*=/.test(tag)) patched = patched.replace(/^<svg\b/, '<svg xmlns="' + SVG_NS + '"');
    if (/\bxlink:/.test(text) && !/\sxmlns:xlink\s*=/.test(tag)) {
      patched = patched.replace(/^<svg\b/, '<svg xmlns:xlink="' + XLINK_NS + '"');
    }
    return patched === tag ? text : text.slice(0, m.index) + patched + text.slice(m.index + tag.length);
  }

  function parse(text) {
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    var err = doc.getElementsByTagName('parsererror')[0];
    if (err) {
      var msg = (err.textContent || '').replace(/\s+/g, ' ').trim();
      return { error: 'XML-Fehler: ' + (msg.length > 200 ? msg.slice(0, 200) + '…' : msg || 'unbekannt') };
    }
    return { doc: doc };
  }

  // Rewrites url(#id) references; ids not defined in this file are left alone.
  function rewriteUrls(value, ids, prefix) {
    return value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, function (all, q, id) {
      return ids[id] ? 'url(' + q + '#' + prefix + id + q + ')' : all;
    });
  }

  // Crude CSS rewrite: url(#id) everywhere, #id and .class only in selector preludes (not in @-rules
  // or declarations, so hex colours and numbers stay untouched).
  function rewriteCss(css, ids, classes, prefix) {
    css = rewriteUrls(css, ids, prefix);
    return css.replace(/(^|[{}])([^{}]*)(?=\{)/g, function (all, brace, prelude) {
      if (/^\s*@/.test(prelude)) return all;
      prelude = prelude.replace(/#(-?[A-Za-z_][\w-]*)/g, function (m, id) {
        return ids[id] ? '#' + prefix + id : m;
      });
      prelude = prelude.replace(/\.(-?[A-Za-z_][\w-]*)/g, function (m, cls) {
        return classes[cls] ? '.' + prefix + cls : m;
      });
      return brace + prelude;
    });
  }

  var BLOCKED_TAGS = { script: 1, foreignObject: 1, iframe: 1, object: 1, embed: 1 };

  // Root attributes that define the viewport, not inheritable styling.
  var ROOT_SKIP = { width: 1, height: 1, viewBox: 1, x: 1, y: 1, preserveAspectRatio: 1, version: 1, id: 1,
    baseProfile: 1, overflow: 1 };

  // Children of root, wrapped in a <g> carrying the root's presentation attributes (fill, stroke, style,
  // class, ...), so they inherit in the export exactly as in the standalone SVG used for rasterizing.
  function serializeContent(root) {
    var g = root.ownerDocument.createElementNS(SVG_NS, 'g');
    var attrs = root.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      if (a.prefix === 'xmlns' || a.localName === 'xmlns' || ROOT_SKIP[a.localName]) continue;
      g.setAttributeNS(a.namespaceURI, a.name, a.value);
    }
    if (!g.attributes.length) return serializeChildren(root);
    for (var n = root.firstChild; n; n = n.nextSibling) g.appendChild(n.cloneNode(true));
    return new XMLSerializer().serializeToString(g);
  }

  // Content can extend beyond the viewBox. The rasterizer (<img>) clips there, but the export writes plain
  // copies that do not clip, so both would disagree. Instead, grow viewBox/size to cover all content.
  // Returns the new { widthMm, heightMm, viewBox } or null when nothing sticks out (or no DOM to measure).
  function expandToContent(root, size) {
    if (typeof document === 'undefined' || !document.body) return null;
    var vb = size.viewBox;
    var kx = size.widthMm / vb[2], ky = size.heightMm / vb[3];
    var par = (root.getAttribute('preserveAspectRatio') || '').trim();
    if (par !== 'none' && Math.abs(kx - ky) > 1e-9 * Math.max(kx, ky)) return null;  // letterboxed: not handled

    var host = document.createElementNS(SVG_NS, 'svg');
    host.setAttribute('style', 'position:absolute;left:-100000px;top:0;width:100px;height:100px;visibility:hidden');
    host.setAttribute('viewBox', vb.join(' '));
    var g = document.createElementNS(SVG_NS, 'g');
    for (var n = root.firstChild; n; n = n.nextSibling) g.appendChild(document.importNode(n, true));
    // Root presentation attributes (fill/stroke/…) also affect the bbox via inherited stroke width.
    Array.prototype.forEach.call(root.attributes, function (a) {
      if (/^(fill|stroke|stroke-width|style|class)$/.test(a.name)) g.setAttribute(a.name, a.value);
    });
    host.appendChild(g);
    document.body.appendChild(host);
    var bb, pad = 0;
    try {
      bb = g.getBBox();
      // getBBox ignores strokes: pad by half the largest stroke width (user units of the viewBox, approx.).
      Array.prototype.forEach.call(g.getElementsByTagName('*'), function (el) {
        var cs = getComputedStyle(el);
        if (cs.stroke && cs.stroke !== 'none') pad = Math.max(pad, (parseFloat(cs.strokeWidth) || 0) / 2);
      });
    } catch (e) {
      bb = null;
    } finally {
      document.body.removeChild(host);
    }
    if (!bb || !(bb.width > 0 || bb.height > 0)) return null;

    var x0 = Math.min(vb[0], bb.x - pad), y0 = Math.min(vb[1], bb.y - pad);
    var x1 = Math.max(vb[0] + vb[2], bb.x + bb.width + pad), y1 = Math.max(vb[1] + vb[3], bb.y + bb.height + pad);
    var eps = 1e-6 * Math.max(vb[2], vb[3]);
    if (vb[0] - x0 < eps && vb[1] - y0 < eps && x1 - vb[0] - vb[2] < eps && y1 - vb[1] - vb[3] < eps) return null;
    return { widthMm: (x1 - x0) * kx, heightMm: (y1 - y0) * ky, viewBox: [x0, y0, x1 - x0, y1 - y0] };
  }

  function sanitizeAndPrefix(root, prefix) {
    var all = [root].concat(Array.prototype.slice.call(root.getElementsByTagName('*')));
    var ids = Object.create(null);
    var classes = Object.create(null);
    var i, j, el;

    // Remove active/embedding content first; it must not survive into the export or the raster image.
    for (i = all.length - 1; i >= 0; i--) {
      var ln = all[i].localName;
      var target = (all[i].getAttribute('attributeName') || '').toLowerCase();
      if (BLOCKED_TAGS[ln] || ((ln === 'set' || ln.indexOf('animate') === 0) && /href$/.test(target))) {
        if (all[i].parentNode) all[i].parentNode.removeChild(all[i]);
        all.splice(i, 1);
      }
    }

    for (i = 0; i < all.length; i++) {
      el = all[i];
      var id = el.getAttribute('id');
      if (id) ids[id] = true;
      var cls = el.getAttribute('class');
      if (cls) cls.split(/\s+/).forEach(function (c) { if (c) classes[c] = true; });
    }

    for (i = 0; i < all.length; i++) {
      el = all[i];
      var attrs = Array.prototype.slice.call(el.attributes);
      for (j = 0; j < attrs.length; j++) {
        var a = attrs[j];
        var name = a.localName.toLowerCase();
        var v = a.value;
        if (name.indexOf('on') === 0) { el.removeAttributeNode(a); continue; }
        if (name === 'href') {
          // Only internal references and embedded raster images are allowed.
          var hm = /^\s*#(.+?)\s*$/.exec(v);
          if (hm) { if (ids[hm[1]]) a.value = '#' + prefix + hm[1]; continue; }
          if (!/^\s*data:image\/(png|jpe?g|gif|webp);/i.test(v)) el.removeAttributeNode(a);
          continue;
        }
        if (name === 'id' && a.namespaceURI === null) { a.value = prefix + v; continue; }
        if (name === 'class' && a.namespaceURI === null) {
          a.value = v.split(/\s+/).filter(Boolean).map(function (c) { return prefix + c; }).join(' ');
          continue;
        }
        if (name === 'style') { a.value = rewriteUrls(v, ids, prefix); continue; }
        if (v.indexOf('url(') !== -1) a.value = rewriteUrls(v, ids, prefix);
      }
      if (el.localName === 'style') {
        // Rewrite text/CDATA nodes in place so CDATA sections survive serialization.
        for (var n = el.firstChild; n; n = n.nextSibling) {
          if (n.nodeType === 3 || n.nodeType === 4) n.nodeValue = rewriteCss(n.nodeValue, ids, classes, prefix);
        }
      }
    }
  }

  function serializeChildren(root) {
    var ser = new XMLSerializer();
    var out = '';
    for (var n = root.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 || n.nodeType === 3 || n.nodeType === 4) out += ser.serializeToString(n);
    }
    return out;
  }

  // Sync. Never throws; parse/size problems give { ok: false, error }.
  SVGB.importSvg = function (text, index, fileName) {
    var name = fileName || ('SVG ' + (index + 1));
    if (typeof text !== 'string' || !text.trim()) return fail(index, name, 'Datei ist leer');

    var res = parse(text);
    if (res.error) {
      var patched = patchNamespaces(text);
      if (patched !== text) res = parse(patched);
    }
    if (res.error) return fail(index, name, res.error);

    var root = res.doc.documentElement;
    if (!root || root.localName !== 'svg') return fail(index, name, 'Wurzelelement ist kein <svg>');
    if (root.namespaceURI !== SVG_NS) {
      res = parse(patchNamespaces(text));
      if (res.error) return fail(index, name, res.error);
      root = res.doc.documentElement;
      if (root.namespaceURI !== SVG_NS) return fail(index, name, 'Kein SVG-Namensraum');
    }

    var size = SVGB.units.resolveSize(root.getAttribute('width'), root.getAttribute('height'),
      root.getAttribute('viewBox'));
    if (size.error) return fail(index, name, size.error);

    sanitizeAndPrefix(root, 's' + index + '_');
    // Measure only after sanitizing: this temporarily attaches the content to the live document.
    var grown = expandToContent(root, size);
    if (grown) size = grown;

    var par = root.getAttribute('preserveAspectRatio');
    var innerMarkup = serializeContent(root);

    root.setAttribute('width', fmt(size.widthMm) + 'mm');
    root.setAttribute('height', fmt(size.heightMm) + 'mm');
    root.setAttribute('viewBox', size.viewBox.map(fmt).join(' '));
    root.setAttributeNS(XMLNS_NS, 'xmlns:xlink', XLINK_NS);
    // x/y on an outermost <svg> are ignored, but strip them so the standalone file behaves the same everywhere.
    root.removeAttribute('x');
    root.removeAttribute('y');
    var standaloneSvg = new XMLSerializer().serializeToString(root);

    return {
      index: index,
      name: name,
      ok: true,
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      viewBox: size.viewBox,
      preserveAspectRatio: par,
      viewBoxExpanded: !!grown,
      innerMarkup: innerMarkup,
      standaloneSvg: standaloneSvg
    };
  };

  SVGB.importSvg._rewriteCss = rewriteCss;
})(window.SVGB = window.SVGB || {});
