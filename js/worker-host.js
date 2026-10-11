// Runs nest-core in a Web Worker built from a Blob URL (works under file://).
// Falls back to the main thread if workers are unavailable.
(function (SVGB) {
  'use strict';

  var workerUrl = null;

  function getWorkerUrl() {
    if (workerUrl) return workerUrl;
    var src =
      'var SVGB_nestCoreFactory = ' + SVGB_nestCoreFactory.toString() + ';\n' +
      'var core = SVGB_nestCoreFactory();\n' +
      'self.onmessage = function (e) {\n' +
      '  try {\n' +
      '    var res = core.nest(e.data, function (r) { self.postMessage({ type: "improved", result: r }); });\n' +
      '    self.postMessage({ type: "done", result: res });\n' +
      '  } catch (err) {\n' +
      '    self.postMessage({ type: "error", message: String((err && err.stack) || err) });\n' +
      '  }\n' +
      '};\n';
    workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    return workerUrl;
  }

  // handlers: { onImproved(result), onDone(result), onError(message) }
  // Returns { cancel() }. After cancel, no further callbacks fire.
  SVGB.runNesting = function (input, handlers) {
    var finished = false;
    var worker = null;
    try {
      worker = new Worker(getWorkerUrl());
    } catch (e) {
      worker = null;
    }

    if (worker) {
      worker.onmessage = function (e) {
        if (finished) return;
        var msg = e.data;
        if (msg.type === 'improved') handlers.onImproved && handlers.onImproved(msg.result);
        else if (msg.type === 'done') { finished = true; worker.terminate(); handlers.onDone(msg.result); }
        else if (msg.type === 'error') { finished = true; worker.terminate(); handlers.onError(msg.message); }
      };
      worker.onerror = function (e) {
        if (finished) return;
        finished = true;
        worker.terminate();
        handlers.onError(e.message || 'Worker-Fehler');
      };
      worker.postMessage(input);
      return {
        cancel: function () {
          if (finished) return;
          finished = true;
          worker.terminate();
        }
      };
    }

    // Fallback: main thread (UI blocks for the time budget).
    var timer = setTimeout(function () {
      try {
        var core = SVGB_nestCoreFactory();
        var res = core.nest(input, function (r) { if (!finished) handlers.onImproved && handlers.onImproved(r); });
        if (!finished) { finished = true; handlers.onDone(res); }
      } catch (err) {
        if (!finished) { finished = true; handlers.onError(String(err)); }
      }
    }, 30);
    return { cancel: function () { finished = true; clearTimeout(timer); } };
  };
})(window.SVGB = window.SVGB || {});
