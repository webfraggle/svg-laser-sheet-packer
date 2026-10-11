// UI wiring: upload, parameters, run, preview, download.
(function (SVGB) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var sources = [];          // Source objects (see CLAUDE.md)
  var nextIndex = 0;
  var thumbUrls = {};
  var job = null;            // running nesting job (null while idle)
  var runId = 0;             // incremented per run; stale async callbacks compare against it
  var last = null;           // { opts for buildOutputSvg, svg, p }
  var previewUrl = null;

  // ---------- Upload ----------

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return /\.svg$/i.test(f.name) || f.type === 'image/svg+xml';
    });
    Promise.all(files.map(function (f) { return f.text().then(function (t) { return [f.name, t]; }); }))
      .then(function (pairs) {
        pairs.forEach(function (p) {
          var src;
          try {
            src = SVGB.importSvg(p[1], nextIndex, p[0]);
          } catch (e) {
            src = { index: nextIndex, name: p[0], ok: false, error: String(e.message || e) };
          }
          nextIndex++;
          sources.push(src);
        });
        renderSources();
      });
  }

  function renderSources() {
    var ul = $('source-list');
    ul.innerHTML = '';
    sources.forEach(function (s) {
      var li = document.createElement('li');
      if (!s.ok) li.className = 'error';
      var img = document.createElement('img');
      if (s.ok) {
        if (!thumbUrls[s.index]) {
          thumbUrls[s.index] = URL.createObjectURL(new Blob([s.standaloneSvg], { type: 'image/svg+xml' }));
        }
        img.src = thumbUrls[s.index];
      }
      img.alt = '';
      var info = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = s.name;
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = s.ok
        ? fmt(s.widthMm, 1) + ' × ' + fmt(s.heightMm, 1) + ' mm' +
          (s.viewBoxExpanded ? ' (Inhalt ragt über die viewBox – Fläche erweitert)' : '')
        : 'Fehler: ' + s.error;
      info.appendChild(name);
      info.appendChild(meta);
      var del = document.createElement('button');
      del.title = 'Entfernen';
      del.textContent = '×';
      del.onclick = function () {
        sources = sources.filter(function (x) { return x !== s; });
        if (thumbUrls[s.index]) { URL.revokeObjectURL(thumbUrls[s.index]); delete thumbUrls[s.index]; }
        renderSources();
      };
      li.appendChild(img);
      li.appendChild(info);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  var dz = $('dropzone');
  $('file-input').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', function () { dz.classList.remove('over'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault();
    dz.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });

  // ---------- Parameters ----------

  function fmt(v, d) { return Number(v).toLocaleString('de-DE', { maximumFractionDigits: d }); }

  function readParams() {
    var p = {
      sheetWmm: parseFloat($('p-width').value),
      sheetHmm: parseFloat($('p-height').value),
      gapMm: parseFloat($('p-gap').value),
      marginMm: parseFloat($('p-margin').value),
      rotate: $('p-rotate').checked,
      step: parseFloat($('p-step').value),
      cellMm: parseFloat($('p-cell').value),
      timeS: parseFloat($('p-time').value)
    };
    if (!(p.sheetWmm > 0) || !(p.sheetHmm > 0)) throw new Error('Bitte gültige Breite und Höhe angeben.');
    if (!(p.gapMm >= 0) || !(p.marginMm >= 0)) throw new Error('Abstände dürfen nicht negativ sein.');
    if (!(p.cellMm > 0)) throw new Error('Bitte eine gültige Auflösung angeben.');
    if (!(p.timeS > 0)) throw new Error('Bitte ein gültiges Zeitbudget angeben.');
    if (p.rotate && !(p.step > 0 && p.step <= 360)) throw new Error('Schrittweite muss zwischen 0 und 360° liegen.');
    if (p.sheetWmm - 2 * p.marginMm <= 0 || p.sheetHmm - 2 * p.marginMm <= 0) {
      throw new Error('Der Randabstand ist größer als die Fläche.');
    }
    var cells = ((p.sheetWmm - 2 * p.marginMm) / p.cellMm) * ((p.sheetHmm - 2 * p.marginMm) / p.cellMm);
    if (cells > 40e6) throw new Error('Auflösung zu fein für diese Fläche (zu viele Rasterzellen). Bitte mm/Zelle erhöhen.');
    p.angles = [0];
    if (p.rotate) {
      p.angles = [];
      for (var a = 0; a < 360 - 1e-9; a += p.step) p.angles.push(Math.round(a * 1e6) / 1e6);
    }
    return p;
  }

  $('p-rotate').addEventListener('change', function () { $('p-step').disabled = !this.checked; });

  // ---------- Run ----------

  function setStatus(t) { $('status').textContent = t; }
  function setRunning(r) {
    $('btn-run').disabled = r;
    $('btn-cancel').disabled = !r;
  }
  function showWarning(t) {
    var w = $('warning');
    w.hidden = !t;
    w.textContent = t || '';
  }

  $('btn-run').addEventListener('click', function () {
    showWarning('');
    var p;
    try { p = readParams(); } catch (e) { setStatus(''); showWarning(e.message); return; }
    var ok = sources.filter(function (s) { return s.ok; });
    if (!ok.length) { showWarning('Bitte mindestens ein gültiges SVG hochladen.'); return; }

    var myRun = ++runId;
    var tick = null;
    clearResult();
    setRunning(true);
    setStatus('Rastere Formen …');
    var t0 = performance.now();
    job = { cancel: function () {}, stopUi: function () { setRunning(false); job = null; },
      finalize: function () { setStatus('Abgebrochen.'); } };

    Promise.all(ok.map(function (s) {
      return SVGB.rasterize(s, { cellMm: p.cellMm, angles: p.angles, gapMm: p.gapMm })
        .catch(function (e) { throw new Error(s.name + ': ' + (e.message || e)); });
    })).then(function (masks) {
      if (myRun !== runId) return;  // cancelled during rasterization
      renderDebug(masks);
      var items = ok.map(function (s, i) { return { source: s, masks: masks[i] }; });
      var input = {
        sheetW: Math.floor((p.sheetWmm - 2 * p.marginMm) / p.cellMm + 1e-9),
        sheetH: Math.floor((p.sheetHmm - 2 * p.marginMm) / p.cellMm + 1e-9),
        shapes: masks,
        timeBudgetMs: p.timeS * 1000,
        seed: (Math.random() * 1e9) | 0
      };
      var exportOpts = {
        items: items, result: null,
        sheetWmm: p.sheetWmm, sheetHmm: p.sheetHmm, marginMm: p.marginMm, cellMm: p.cellMm
      };
      var areaTotal = masks.reduce(function (a, m) { return a + m.areaMm2; }, 0);

      setStatus('Berechne Anordnung …');
      tick = setInterval(function () {
        var el = (performance.now() - t0) / 1000;
        setStatus('Berechne Anordnung … ' + fmt(el, 0) + ' / ' + fmt(p.timeS, 0) + ' s');
      }, 500);

      var lastShow = 0;
      function show(result, final) {
        exportOpts.result = result;
        renderResult(exportOpts, areaTotal, p, final, performance.now() - t0, input);
      }
      function stop() { clearInterval(tick); setRunning(false); job = null; }

      var handle = SVGB.runNesting(input, {
        onImproved: function (r) {
          // Building the full SVG is expensive for large sources; throttle intermediate previews.
          exportOpts.result = r;
          var now = performance.now();
          if (now - lastShow > 700) { lastShow = now; show(r, false); }
        },
        onDone: function (r) { stop(); show(r, true); setStatus('Fertig.'); },
        onError: function (msg) {
          stop();
          clearResult();
          setStatus('');
          showWarning('Fehler bei der Berechnung: ' + msg);
        }
      });
      job = {
        cancel: handle.cancel,
        stopUi: stop,
        finalize: function () {
          if (exportOpts.result) show(exportOpts.result, true);
          else setStatus('Abgebrochen – noch kein Ergebnis vorhanden.');
        }
      };
    }).catch(function (e) {
      if (myRun !== runId) return;
      clearInterval(tick);
      setRunning(false);
      job = null;
      setStatus('');
      showWarning(e.message || String(e));
    });
  });

  $('btn-cancel').addEventListener('click', function () {
    if (!job) return;
    var j = job;
    runId++;
    j.cancel();
    j.stopUi();
    setStatus('Abgebrochen – bestes bisheriges Ergebnis wird angezeigt.');
    j.finalize();
  });

  // ---------- Result ----------

  function clearResult() {
    last = null;
    $('btn-download').disabled = true;
    $('stats').innerHTML = '';
    setPreview(null);
  }

  // Preview via <img>: styles inside the SVGs cannot leak into the page and IDs cannot collide.
  function setPreview(svg) {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    var box = $('preview');
    box.innerHTML = '';
    if (!svg) return;
    previewUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    var img = document.createElement('img');
    img.alt = 'Vorschau der Anordnung';
    img.src = previewUrl;
    box.appendChild(img);
  }

  function renderResult(opts, areaTotal, p, final, ms, input) {
    var r = opts.result;
    opts.frame = $('p-frame').checked;
    var svg = SVGB.buildOutputSvg(opts);
    last = { opts: opts, svg: svg, p: p };
    setPreview(svg);

    var nShapes = opts.items.length;
    var used = r.k * areaTotal;
    var util = used / (p.sheetWmm * p.sheetHmm) * 100;
    $('stats').innerHTML = '';
    [
      [fmt(r.k, 0), 'Stück pro SVG'],
      [fmt(r.k * nShapes, 0), 'Teile gesamt'],
      [fmt(util, 1) + ' %', 'Flächenausnutzung'],
      [fmt(r.kMax, 0), 'theoretische Obergrenze pro SVG'],
      [fmt(r.runs, 0), 'Durchläufe'],
      [fmt(ms / 1000, 1) + ' s', 'Rechenzeit']
    ].forEach(function (x) {
      var d = document.createElement('div');
      var b = document.createElement('b');
      b.textContent = x[0];
      var s = document.createElement('span');
      s.textContent = x[1];
      d.appendChild(b);
      d.appendChild(s);
      $('stats').appendChild(d);
    });

    $('btn-download').disabled = !(r.k > 0);
    if (final) {
      if (r.k === 0) showWarning('Es passt kein vollständiger Satz (je 1× jedes SVG) auf die Fläche.');
      var v = SVGB_nestCoreFactory().validate(input, r.placements);
      if (!v.ok) showWarning('Validierung fehlgeschlagen: ' + v.errors.slice(0, 3).join('; '));
    }
  }

  $('p-frame').addEventListener('change', function () {
    if (!last) return;
    last.opts.frame = this.checked;
    last.svg = SVGB.buildOutputSvg(last.opts);
    setPreview(last.svg);
  });

  $('btn-download').addEventListener('click', function () {
    if (!last) return;
    var p = last.p;
    var name = 'nesting_' + p.sheetWmm + 'x' + p.sheetHmm + 'mm_k' + last.opts.result.k + '.svg';
    var url = URL.createObjectURL(new Blob([last.svg], { type: 'image/svg+xml' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  // ---------- Debug ----------

  function renderDebug(masks) {
    var box = $('debug-masks');
    box.innerHTML = '';
    if (!SVGB.rasterDebugCanvas) return;
    masks.forEach(function (m) {
      m.variants.forEach(function (v) {
        var c = SVGB.rasterDebugCanvas(v);
        c.title = 'SVG ' + m.index + ', ' + v.angle + '°, ' + v.w + '×' + v.h + ' Zellen';
        box.appendChild(c);
      });
    });
  }
})(window.SVGB = window.SVGB || {});
