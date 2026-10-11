# SVG Laser Sheet Packer

Ordnet beliebige SVG-Formen möglichst dicht auf einer rechteckigen Fläche an (Nesting). Typische Anwendungen sind Laserschneiden, Plotten und CNC. Von **jedem** hochgeladenen SVG wird **dieselbe Anzahl** an Kopien platziert, und diese Anzahl wird maximiert.

**▶ Online ausprobieren: https://webfraggle.github.io/svg-laser-sheet-packer/**

Alles läuft lokal im Browser: kein Server, keine Installation, kein Build. Auch in der Online-Version verlassen deine SVGs den Rechner nicht, die ganze Berechnung passiert im Browser. Offline geht es genauso: Repo herunterladen und `index.html` per Doppelklick öffnen.

## Funktionen

- **Echtes Nesting unregelmäßiger Formen:** Nur die gefüllten Flächen dürfen sich nicht überschneiden. Die Bounding-Boxen dürfen überlappen, zum Beispiel greifen C-Formen ineinander.
- **Gleiche Stückzahl für alle SVGs:** Platziert wird in Sätzen, ein Satz enthält von jedem SVG genau eine Kopie.
- **Mindestabstand** zwischen den Formen und **Randabstand**, beide in mm einstellbar.
- **Rotation:** aus oder in frei wählbarer Schrittweite (z. B. 90°, 45°, 15°).
- **Originalgröße:** SVGs werden in ihrer physischen Größe übernommen (`mm`, `cm`, `in`, `pt`, `pc`, `px` bei 96 dpi oder nur `viewBox`).
- **Export als SVG in mm** mit den originalen Vektordaten.
- **Kompatibel mit meerk40t:** Laser-Operationen aus den Quelldateien (`<g type="op …">`, z. B. Cut/Engrave/Raster mit Speed und Power) werden einmal übernommen und allen Kopien korrekt zugeordnet.
- Die Berechnung läuft im Hintergrund (Web Worker), mit Fortschrittsanzeige, Abbrechen und Zeitbudget.
- **Kontrolle:** Das Ergebnis wird zum Schluss auf Überlappungen geprüft.

## Bedienung

1. [Online-Version](https://webfraggle.github.io/svg-laser-sheet-packer/) oder die lokale `index.html` im Browser öffnen (Chrome, Firefox, Safari).
2. SVG-Dateien hineinziehen oder auswählen.
3. Breite und Höhe der Fläche, Abstand, Randabstand und Rotation einstellen.
4. **Berechnen** klicken und das Ergebnis mit **SVG herunterladen** speichern.

| Parameter | Bedeutung |
|---|---|
| Auflösung (mm/Zelle) | Rastergenauigkeit der Kollisionsprüfung. Kleiner ist genauer, aber langsamer. Standard: 0,5 mm |
| Zeitbudget (s) | So lange werden verschiedene Anordnungen ausprobiert, die beste wird behalten |
| Rahmen im Export | Zeichnet die Fläche als blaues Rechteck. Standardmäßig aus, weil Laser-Software ihn sonst mitbearbeiten würde |

## Funktionsweise (kurz)

1. **Import:** Das SVG wird eingelesen und bereinigt (Skripte, externe Inhalte). IDs und CSS-Klassen bekommen pro Datei ein Präfix, damit sich mehrere SVGs nicht gegenseitig stören.
2. **Rasterung:** Jede Form wird pro Drehwinkel in eine Belegungsmaske gerastert, konservativ: jedes angeschnittene Pixel zählt als belegt. Zusätzlich gibt es eine um den Mindestabstand vergrößerte Kollisionsmaske.
3. **Nesting:** Satzweises Bottom-Left-Fill mit vielen variierten Durchläufen innerhalb des Zeitbudgets.
4. **Export:** Jede Kopie wird als eigene Gruppe mit exakter Transformationsmatrix geschrieben. Es wird bewusst kein `<symbol>`/`<use>` verwendet, weil viele Laser-Programme das nicht richtig skalieren.

Die Genauigkeit hängt von der Auflösung ab. Durch die konservative Rasterung plus eine Sicherheitszelle landen Formen eher etwas weiter auseinander als nötig, überlappen aber nie.

## Grenzen

- Nesting ist ein NP-schweres Problem. Das Ergebnis ist eine gute Näherung, keine garantiert optimale Lösung.
- Text in SVGs wird mit den lokal installierten Schriften gerastert. Für exakte Ergebnisse vorher in Pfade umwandeln.
- CSS-Regeln nach Elementtyp (z. B. `path { fill: red }`) innerhalb eines SVGs gelten im Export für alle Formen.

## Entwicklung

Reines JavaScript ohne Abhängigkeiten. Wegen `file://` gibt es keine ES-Module, sondern klassische Skripte im Namespace `window.SVGB`.

```sh
node --test                                        # alle Unit-Tests
node --test tests/nest-core.test.js                # eine Testdatei
node --test --test-name-pattern="<Name>"           # ein einzelner Test
```

Testdateien für manuelle Tests liegen in `test-svgs/`. Architektur und Datenformate stehen in [`CLAUDE.md`](CLAUDE.md).

## Lizenz

[MIT](LICENSE)
