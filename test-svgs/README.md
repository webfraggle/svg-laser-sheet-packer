# Test-SVGs für SVG Best Space

Manuelle Testdateien für das Nesting-Tool. Alle Formen gefüllt, transparenter Hintergrund.

| Datei | Größe | Testet |
|---|---|---|
| `l-shape.svg` | 50 × 50 mm | Konkave L-Form; Teile können in die Ecke greifen |
| `star.svg` | 40 × 40 mm | 5-zackiger Stern, viele konkave Einbuchtungen |
| `ring.svg` | 60 × 60 mm | Ring mit Loch (`fill-rule="evenodd"`); Loch ist frei, kleine Teile können hinein |
| `c-shape.svg` | 60 × 40 mm | Dicke U/C-Form (Wand 10 mm), Ineinandergreifen |
| `triangle-px.svg` | 200 × 150 px ≈ 52,9 × 39,7 mm | Einheitenumrechnung px → mm (96 dpi) |
| `no-size.svg` | viewBox 100 × 60 ≈ 26,5 × 15,9 mm | Keine width/height, nur viewBox (User Units = px) |
| `inches.svg` | 2 × 1 in = 50,8 × 25,4 mm | Einheit `in`, Blob aus kubischen Béziers |
| `transformed-gradient.svg` | 60 × 60 mm | `<g transform>` (translate + rotate), Gradient `#grad`, clipPath `#clip` – ID-Präfixierung bei mehreren Kopien |
| `multi-part.svg` | 70 × 30 mm | Zwei getrennte Teile in einer Datei |
| `stroked.svg` | 40 × 40 mm | Dicke Kontur (8 mm), Kontur zählt als Fläche (Außen-Ø 36 mm) |
| `broken.svg` | – | Absichtlich fehlerhaftes XML → Fehlerbehandlung |
| `root-style.svg` | 40 × 40 mm | Styling nur am Wurzel-`<svg>` (`fill="none"`, `stroke`) wie bei Icon-Sets – muss im Export identisch aussehen wie in der Rasterung |
| `overflow.svg` | 40 × 40 mm | Inhalt ragt rechts über die viewBox → Import erweitert auf 50 × 40 mm, damit Raster und Export übereinstimmen |
