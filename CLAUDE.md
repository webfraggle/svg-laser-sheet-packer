# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SVG-Best-Space: a purely local web page (no backend, no build step, no external dependencies) that nests uploaded SVGs onto a rectangular sheet. The user uploads n SVGs and enters a sheet size in mm; the page places the **same number k of copies of every SVG** and maximizes k. Filled areas must not overlap (bounding boxes may) and must keep a configurable minimum gap; a separate border margin applies. Rotation is either off or in user-defined degree steps (no mirroring). SVGs keep their original physical size. The output is a preview plus an SVG download in mm. UI language is German. See `PLAN.md` for the original design rationale.

## Hard constraint: must run from `file://`

The page is opened by double-clicking `index.html`. Therefore:
- **No ES modules** (`<script type="module">` and `import` fail under `file://` in Chrome). Use classic `<script src>` tags and the global namespace `window.SVGB`.
- **No `new Worker('file.js')`** (blocked from origin `null`). The worker is built from a Blob URL: `js/worker-host.js` stringifies the global factory `SVGB_nestCoreFactory` (from `js/nest-core.js`) into the worker source.
- No `fetch()` of local files, no SharedArrayBuffer. Cancelling = `worker.terminate()`; the worker posts every improved result, so the last best one survives a cancel.

## Commands

- Run the app: `open index.html` (or open it in Chrome/Firefox via `file://`).
- Unit tests (pure-JS modules only, no DOM): `node --test` (not `node --test tests/` – Node 25 treats a directory argument as a module name)
- Single test file: `node --test tests/nest-core.test.js`, single test: `node --test --test-name-pattern="<name>"`

## Architecture / data flow

```
app.js (UI) ── File ──> svg-import.js ── Source ──> raster.js ── ShapeMasks ──> worker-host.js ──> [Worker: nest-core.js]
                                                                                       │ Result (placements in cells)
                                     export.js <── Sources + ShapeMasks + Result ──────┘ ──> preview + download
```

| File | Global | Role |
|---|---|---|
| `js/units.js` | `SVGB.units` | Length parsing → mm. Pure, Node-testable. |
| `js/svg-import.js` | `SVGB.importSvg` | Parse SVG text (DOMParser), size in mm, prefix IDs. |
| `js/raster.js` | `SVGB.rasterize` | Render each rotation to canvas → RLE masks (shape + dilated collision). |
| `js/nest-core.js` | `SVGB_nestCoreFactory` | Pure nesting algorithm. **No DOM, no closures over outer scope** (it is stringified into the worker). Also `module.exports` for Node. |
| `js/worker-host.js` | `SVGB.runNesting` | Blob worker wrapper, progress, cancel. |
| `js/export.js` | `SVGB.buildOutputSvg` | Builds the final vector SVG (expanded copies, hoisted meerk40t ops). |
| `js/app.js` | – | UI wiring. |

Every browser file is wrapped as `(function (SVGB) { ... })(window.SVGB = window.SVGB || {});`. Script order in `index.html`: units, svg-import, raster, nest-core, worker-host, export, app.

## Data contracts (keep these in sync when changing any module)

**Source** (from `SVGB.importSvg(text, index, fileName)`, synchronous):
```
{ index, name, ok, error?, widthMm, heightMm,
  viewBox: [minX, minY, w, h],
  preserveAspectRatio: string|null,
  innerMarkup: string,      // root children, IDs/classes prefixed "s{index}_", wrapped in <g> carrying the root's
                            // presentation attrs (fill, stroke, style, class…) so export inherits like the raster
  standaloneSvg: string }   // complete prefixed SVG with width/height in mm (for rasterizing/thumbnails)
```
Size rule: `width`/`height` with units (mm, cm, in, pt, pc, px=25.4/96 mm, unitless=px). Percent or missing → derived from viewBox (1 user unit = 1 px). Missing viewBox → `0 0 width height` in px.

**ShapeMasks** (from `SVGB.rasterize(source, {cellMm, angles, gapMm})`, Promise):
```
{ index, areaMm2, areaCells,
  variants: [{ angle,            // degrees, rotation of the SVG about its own center
               w, h,             // grid size in cells (bbox of collision mask)
               cxMm, cyMm,       // SVG center relative to the grid's top-left corner, in mm
               shape: RLE,       // filled cells (alpha > 0, conservative)
               coll:  RLE }] }   // shape dilated (see kernel rule below)
RLE = { rowPtr: Int32Array(h+1), runs: Int32Array }
```
Kernel rule: offset (dx,dy) is in the dilation kernel iff `hypot(max(|dx|-1,0), max(|dy|-1,0)) < gapMm/cellMm + 1` (square-to-square distance plus one safety cell; extent R = ceil(gap/cell)+1). A plain centre-distance disc is too small on diagonals. `variants` are deduped, so their count can be smaller than `angles`; always use `variant.angle`.
Export must render exactly what was rasterized. The rasterizer's `<img>` clips at the viewBox, while the exported copies do not clip; so import (`expandToContent`, needs the DOM for `getBBox`) grows viewBox and mm size to cover content that sticks out (`Source.viewBoxExpanded`). Any change to import/export must keep raster and vector output identical, or the gap guarantee breaks.
Import sanitizes: removes script/foreignObject/iframe/object/embed and href-animations, on* attributes, and every href that is not `#id` or `data:image/…`. The result preview is shown as `<img>` (Blob URL), never inline, so SVG `<style>` cannot leak into the page.
Import also prefixes CSS class names (`s{i}_`) because `<style>` inside `<symbol>` is global in the export; element-type selectors remain global (known limitation).

RLE detail: runs of row `r` are pairs `runs[2*j], runs[2*j+1]` for `j` in `[rowPtr[r], rowPtr[r+1])`, half-open `[x0, x1)`, x relative to the variant grid's left edge.

**Nesting input/result** (`nest-core`, cells only, no mm):
```
input  = { sheetW, sheetH,            // usable area in cells (sheet minus border margin)
           shapes: ShapeMasks[],      // only areaCells + variants[{w,h,shape,coll}] are used
           timeBudgetMs, seed }
result = { k, kMax, runs, elapsedMs,
           placements: [{ shape, variant, x, y }] }  // shape = index into input.shapes; (x,y) = variant grid top-left in sheet cells; may be negative (gap padding may hang outside the sheet)
```
Rules: occupancy stores **shape** cells; a new part is tested with its **coll** mask against occupancy. This one-sided check enforces the full gap, because the dilation radius equals the gap distance. The **shape** mask must lie fully inside the sheet; coll cells outside the sheet are ignored. k = number of complete sets (one copy of every shape); incomplete sets are removed.

**Export geometry / laser-software compatibility** (`js/export.js`): the output is consumed by laser software (meerk40t, which parses via `svgelements`). Therefore:
- Every placement is written as a real copy `<g id="part{n}" transform="matrix(…)">` = `translate(marginMm + x*cellMm + cxMm, marginMm + y*cellMm + cyMm) · rotate(angle) · translate(-widthMm/2, -heightMm/2) · viewBox→mm mapping (honouring preserveAspectRatio)`. **Never use `<symbol>`/`<use>`**: svgelements ignores the symbol viewBox (geometry and stroke widths end up thousands of times too large). Matrix numbers need ~12 significant digits (viewBox scales like 0.0004 are common).
- IDs inside each copy get the prefix `p{n}_` (so they are `p{n}_s{i}_<original>`), and internal `#id` / `url(#id)` refs are rewritten per copy.
- meerk40t operations (`<g type="op …">`) and `<note>` are removed from the copies and written **once** at the document root. Identical ops from different sources are merged (all attributes except `id`/`references`). `references` is rebuilt to list every copy's element ID; meerk40t links ops to elements by ID only and **does not auto-classify** when a file contains ops.
- `bounds` / `paint_bounds` attributes are stripped: meerk40t trusts them as cached bounding boxes, and they are wrong after transforming.
- The optional sheet frame is off by default (laser software would pick it up as an element to burn).
- To verify output the way meerk40t sees it: `pip install svgelements`, then `SVG.parse(file, reify=False, ppi=96, transform="scale(65535/96)")` and check `implicit_stroke_width` / `bbox()` of the paths (65535 units per inch).

## Tests

`tests/*.test.js` use `node:test` + `node:assert` and load browser files via `require` (pure modules export with `if (typeof module !== 'undefined') module.exports = …`). Sample SVGs for manual browser testing live in `test-svgs/`.
