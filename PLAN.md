# SVG-Best-Space – Implementierungsplan

> **Update:** Die Vorgabe „eine einzige Datei“ wurde aufgehoben. Mehrere Dateien sind erlaubt, solange alles über `file://` funktioniert. Die aktuelle Dateistruktur und die Schnittstellen beschreibt `CLAUDE.md`.

## Ziel

Eine einzelne, rein lokale HTML-Datei (`index.html`, kein Backend, keine Build-Tools, keine externen Abhängigkeiten, funktioniert per Doppelklick über `file://`).

- Der Nutzer lädt **n SVG-Dateien** hoch und gibt eine **rechteckige Fläche (Breite × Höhe in mm)** an.
- Die Seite platziert von **jedem** SVG **dieselbe Anzahl k** an Kopien, wobei **k maximiert** wird.
- Die gefüllten Flächen der SVGs dürfen sich **nicht überschneiden** und müssen einen **einstellbaren Mindestabstand** einhalten. Die Bounding-Boxen dürfen sich überschneiden (echtes Nesting unregelmäßiger Formen).
- Die Ergebnisse gibt es als Vorschau und als **SVG-Download** in mm.

## Festgelegte Entscheidungen

| Thema | Entscheidung |
|---|---|
| Rotation | Wählbar: „nicht drehen“ oder „drehen mit Schrittweite X°“ (Zahleneingabe, z. B. 90, 45, 15). Kein Spiegeln. |
| Einheiten | Fläche in mm. SVGs in **Originalgröße**, abgeleitet aus `width`/`height` (mm, cm, in, pt, pc, px mit 96 dpi) bzw. aus der `viewBox`, falls Angaben fehlen (dann 1 Nutzereinheit = 1 px = 0,2646 mm). |
| Abstand | Einstellbarer Mindestabstand zwischen den Formen (mm) und separat einstellbarer Randabstand (mm, Standard = Abstand). |
| Ausgabe | Vorschau im Browser + Download als ein SVG (`width="…mm" height="…mm"`, viewBox in mm). |

## Architektur (alles in `index.html`)

```
index.html
├── <style>            UI-Layout
├── <body>             Upload, Parameter, Ergebnis/Vorschau
├── <script> main      UI, SVG-Parsing, Rasterisierung, Export
└── <script type="text/worker"> nesting-worker   → per Blob-URL als Web Worker gestartet
```

Der Packalgorithmus läuft in einem **Web Worker** (inline als Blob-URL, das funktioniert auch unter `file://`), damit die UI reaktionsfähig bleibt und Fortschritt und Abbrechen möglich sind.

### 1. SVG einlesen und normalisieren (Main Thread)
- Die Datei mit `FileReader` als Text lesen und mit `DOMParser` parsen. Bei Parse-Fehlern das SVG markieren und überspringen.
- Die physische Größe in mm aus `width`/`height` und der `viewBox` bestimmen.
- **IDs mit einem Präfix versehen** (`s{i}_…`) und alle `url(#…)`-, `href`- und `xlink:href`-Referenzen umschreiben, damit sich Gradients, ClipPaths usw. mehrerer SVGs im Export nicht gegenseitig stören.
- Zur Kontrolle eine Vorschau-Kachel pro SVG mit Name, Größe in mm und Flächeninhalt der Füllung anzeigen.

### 2. Rasterisierung zu Masken (Main Thread)
Die Formen sind beliebig unregelmäßig (Löcher, mehrere Teilflächen, Kurven). Ein **rasterbasiertes Nesting** ist dafür robust und einfach korrekt umzusetzen:
- Parameter **Auflösung** in mm/Zelle, Standard 0,5 mm, einstellbar: kleinerer Wert = genauer, aber langsamer.
- Für jedes SVG und jeden Rotationswinkel (0°, Schritt, 2·Schritt, … < 360°):
  - Das SVG als Blob-URL in ein `Image` laden und auf ein Canvas zeichnen (rotiert um den Mittelpunkt, skaliert auf mm/Zelle).
  - Aus `getImageData` den Alpha-Kanal lesen: **jede Zelle mit Alpha > 0 gilt als belegt** (konservativ, d. h. Antialiasing-Kanten zählen mit).
  - **Kollisionsmaske** = Formmaske, dilatiert um `Abstand + 1 Sicherheitszelle` (kreisförmiger Kern).
  - Pro Zeile als Run-Length-Liste speichern (`[x0, x1)`-Spannen) und auf die enge Bounding-Box zuschneiden; den Versatz des Rotationszentrums merken.
- Die Masken gehen als transferable Buffers an den Worker.

### 3. Nesting-Algorithmus (Worker)
**Belegungsraster:** Fläche abzüglich Randabstand, auf Zellen gerastert. Pro Zeile gibt es ein Präfixsummen-Array. Ob eine Spanne frei ist, lässt sich so in O(1) prüfen; eine Kollisionsprüfung kostet O(Anzahl Runs der Form). Eingetragen wird die **unverdünnte** Formmaske, geprüft wird gegen die **dilatierte** Kollisionsmaske. Damit gilt der Mindestabstand zwischen allen Formen.

**Beschleunigung:** Zusätzlich gibt es eine grobe Pyramidenstufe (4×4-Blöcke, OR-verknüpft). Kandidatenpositionen werden zuerst grob verworfen, dann fein geprüft. Ein Zeiger auf die „unterste freie Zeile“ überspringt bereits volle Bereiche.

**Platzierung (Bottom-Left-Fill):** Für eine Form werden alle erlaubten Rotationen getestet. Gewählt wird die Position mit dem kleinsten y, bei Gleichstand mit dem kleinsten x (Variante: erst x, dann y).

**Gleiche Anzahl k für alle SVGs:**
1. Obergrenze: `k_max = floor(nutzbare Fläche / Σ Flächeninhalt aller Formen)`.
2. Es wird **satzweise im Round-Robin** platziert: Ein Satz besteht aus je einer Kopie jedes SVGs, innerhalb des Satzes die größte Fläche zuerst. Lässt sich eine Form nicht mehr platzieren, ist der Satz unvollständig. Der unvollständige Satz wird wieder entfernt. Ergebnis: k vollständige Sätze.
3. **Verbesserung innerhalb eines Zeitbudgets** (Standard 10 s, einstellbar): mehrere Durchläufe mit variierter Strategie (Reihenfolge im Satz, Platzierungskriterium y-first/x-first, Rotationspräferenz, leicht zufällige Reihenfolge). Behalten wird das beste k; bei Gleichstand gewinnt die kompaktere Anordnung (kleinere belegte Höhe). Bei `k == k_max` wird früh abgebrochen.
4. Der Worker meldet Fortschritt (aktueller Durchlauf, bestes k) und unterstützt Abbrechen.

**Ergebnis:** eine Liste `{svgIndex, x_mm, y_mm, rotation}` pro Teil.

### 4. Validierung
Nach dem Packen wird die Lösung erneut gegen die Formmasken (ohne Sicherheitszelle) auf Überlappung und Randverletzung geprüft. Bei einem Fehler, der eigentlich nicht auftreten sollte, gibt es eine deutliche Warnung im UI.

### 5. Vorschau und Export (Main Thread)
- Das Ergebnis-SVG wird aufgebaut:
  - `<svg width="Wmm" height="Hmm" viewBox="0 0 W H">`
  - pro Quell-SVG ein `<symbol id="src{i}" viewBox="…">` mit dem präfixierten Originalinhalt
  - pro Teil `<use href="#src{i}" width="…" height="…" transform="translate(x y) rotate(r cx cy)">`
  - optional ein Rahmen der Fläche (in der Vorschau sichtbar; beim Export per Checkbox ein- oder ausschaltbar)
- Die Vorschau zeigt das SVG inline, dazu Kennzahlen: **k pro SVG**, Gesamtzahl der Teile, Flächenausnutzung in % und Rechenzeit.
- Der Download läuft über eine Blob-URL: `nesting_{W}x{H}_k{k}.svg`.

## UI

- **Upload:** Drag & Drop und Dateiauswahl (`multiple`, `.svg`), Liste mit Thumbnails, Entfernen-Button.
- **Parameter:** Breite (mm), Höhe (mm), Abstand (mm), Randabstand (mm), Rotation [nicht drehen | Schrittweite __°], Auflösung (mm/Zelle), Zeitbudget (s).
- **Buttons:** Berechnen / Abbrechen, Fortschrittsanzeige, SVG herunterladen.
- **Ergebnis:** Kennzahlen und Vorschau.

## Umsetzungsschritte

1. Grundgerüst `index.html`: UI, Parameter, Upload-Liste
2. SVG-Parsing: mm-Größe, ID-Präfixe, Thumbnails
3. Rasterisierung und Masken (inkl. Rotation, Dilatation, RLE), Debug-Ansicht der Masken
4. Worker: Belegungsraster, Kollisionsprüfung, Bottom-Left-Fill
5. Satzweises Round-Robin, Mehrfachdurchläufe, Zeitbudget, Fortschritt und Abbrechen
6. Validierung
7. Export-SVG, Vorschau, Download
8. Testdaten in `test-svgs/` erstellen: L-Form, Stern, Ring mit Loch, C-Form (Ineinandergreifen), Formen mit `transform`s und Gradients, verschiedene Einheiten. Manuelle Tests im Browser über `file://`.

## Einsatz von Agents

Alles liegt in einer einzigen Datei. Paralleles Schreiben durch mehrere Agents würde daher zu Konflikten führen. Empfehlung:
- Die Implementierung erfolgt **sequenziell** durch mich (Schritte 1–8).
- Parallel dazu erstellt **ein Agent die Test-SVGs** (Schritt 8, eigene Dateien, konfliktfrei).
- Am Ende macht **ein Review-Agent** eine Prüfung (Korrektheit der Kollisionsprüfung, Einheiten, ID-Präfixe, Robustheit bei kaputten SVGs).

## Bekannte Grenzen

- Die Genauigkeit hängt von der Auflösung ab. Durch die konservative Rasterung und die Sicherheitszelle werden Formen eher etwas zu weit auseinander platziert, aber nie überlappend.
- Das Nesting ist heuristisch. Ein optimales k ist nicht garantiert (NP-schweres Problem), wird aber durch Mehrfachdurchläufe angenähert.
- Text in SVGs wird mit den lokal verfügbaren Schriften gerastert. Für exakte Ergebnisse sollte Text vorher in Pfade umgewandelt werden.
