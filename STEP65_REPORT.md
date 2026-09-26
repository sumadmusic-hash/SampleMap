# STEP65 — Audit: Warum häuft sich die Punktmasse in der Sample Map rechts (rechts-unten)?

**Deliverable:** Finalbericht (Klassifikation A–E + genau EIN konkreter STEP66-Schritt). **Reiner Audit — keine Produktionsänderung.** Alle Aussagen sind nach `FACT` / `CODE` / `INFERENCE` / `UNKNOWN` getaggt (FACT = gemessen, CODE = direkt aus dem Quelltext, INFERENCE = aus beiden abgeleitet, UNKNOWN = nicht verifizierbar).

Messbasis: der echte analysierte Audiotool-Katalog — **1 439 eindeutige Samples** aus den STEP42/44.1/45-Korpora (NDJSON), projiziert mit den **Produktions-Projektoren** (`computeCanonicalSoundSpacePoint` = Sound Space v1.0.0; persistierte `mapPosition` = map-v2). Machbar, weil Schritt 6 die „echten" Samples verlangt: Die globale D1-Karte hat aktuell nur **1 Punkt** (FACT, `/map?mapVersion=map-v2`), das lokale IndexedDB-Profil ist leer (STEP62: samples=0), also ist der Roh-Korpus die einzige echte Messbasis. Skript: `scripts/step65-map-distribution.ts`, Artefakte unter `/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step65/`.

Date: 2026-09-11

---

## 1. Datenfluss („Welcher Punkt landet wo?")

Beide Koordinatensysteme, die die Map rendert, sind vollständig zurückverfolgt (`CODE`):

| Stufe | Quelle | Transformation | Wertebereich |
|---|---|---|---|
| 1. Analyse | Audio → `src/pipeline/analysisPipeline.ts:~296` (`computePosition(features, decodedAudio)` einmalig, solange Audio verfügbar) | `flatnessToX` (ganz-Sample Multi-Fenster-Flatness, Median ≤16 Fenster) + `centroidToY` (log Spektral-Centroid) → persistiert als `record.mapPosition` | map-v2: X∈[0,1], Y∈[0,1] |
| 2a. Projektionseingabe (Sound Space) | `record.analysisV2.soundCharacter` (`tonality`, `noisiness`, `brightness`, je ∈[0,1]) | `toSimilarityVector` + Washing (§37): nur finite Werte in [0,1] gelten als vorhanden; null = MISSING (nie 0) | 3 echte Inputdims ∈[0,1] |
| 2b. Projektionseingabe (map-v2) | `record.mapPosition` = bereits berechnete V2-Position | — (wird von `src/global/publish.ts` **dokumentgetreu** gelesen, nicht neu gerechnet; lokale `mapView.mapPoints()` fällt auf `rep.mapPosition` zurück) | X,Y∈[0,1] |
| 3. X-Projektion | `src/analysis/soundSpaceProjector.ts:132-142` | `x = mean(tonality, 1−noisiness)` über vorhandene Dims (`weightedMean`, Re-Normalisierung auf vorhandene Dims); Punkt existiert nur wenn X UND Y berechenbar | X∈[0,1] |
| 4. Y-Projektion | `soundSpaceProjector.ts:137` | `y = brightness` (nur diese eine Dim — ehrliche Achsen-Semantik) | Y∈[0,1] |
| 5. Normalisierung | `clamp01` (soundSpaceProjector.ts:142) bzw. `clamp01`+`clamp` in `mapPosition.ts:104-121` | **nur** Klemmen auf [0,1]; keine Korpus-Normalisierung, keine Rangierung (beide Projektionen sind korpus-unabhängig, fixe Anker) — `CODE` | [0,1]² |
| 6. Canvas (Panel) | `src/ui/render.ts:1255-1258` | rein lineare Affinität `cx = 4 + x·(W−8)`, `cy = 4 + (1−y)·(H−8)`; W=400, H=260 (render.ts:1217-1218) | 400×260 in SVG-Einheiten |
| 6b. Canvas (Hauptkarte) | `src/ui/map/mapView.ts:386-389` (`toScreen`) | `x_px = x·800`, `y_px = (1−y)·520` (MAP_WIDTH/HEIGHT, Y invertiert); `mapRender.ts` dünne Projektion davon | 800×520 px |

**Zwischenbefund:** In der Pixelphase (Stufe 6) kann keine Verteilungsschieflage entstehen — beides sind lineare Affinitäten `FACT/CODE`. Eine „Normalisierung", die rechts/unten verdichtet, existiert in Produktion **nicht** (`CODE`).

---

## 2. X-Verteilung (vor Normalisierung ≈ nach Normalisierung)

Sound Space v1.0.0 — 1 439 Punkte (`FACT`, gemessen via Produktions-Projektor):

| | min | p05 | p25 | p50 | p75 | p95 | max | mean | skew |
|---|---|---|---|---|---|---|---|---|---|
| **X canonical** | 0.150 | 0.381 | 0.613 | 0.822 | 0.911 | 0.980 | 0.999 | **0.758** | −0.330 |

Quartile-Bins: **<0.25 = 0.6 %** · [0.25,0.5] = 12.6 % · (0.5,0.75] = 22.9 % · **>0.75 = 63.8 %**. Ränder: exakt 0 = 0, exakt 1 = 0, ≥0.99 = 30.

**Pre-normalization:** Beim Sound-Space-Projektor ist die Projektion selbst schon die [0,1]-Abbildung — `x = mean(tonality, 1−noisiness)` liegt für zwei [0,1]-Werte immer in [0,1], `clamp01` ist hier ein No-op (`CODE`). Zustand A (Roh-Projektion) **==** Zustand B (normalisiert) für canonical. **Die Rechtslastigkeit entsteht also VOR der Canvas-Abbildung, direkt in der Projektions-Ausgabe bzw. ihren Eingabedaten.**

map-v2 (persistiert) — 1 439 Punkte (`FACT`): mean 0.614, p50 0.604, p75 0.745, **>0.75 = 24.2 %**; exakt 1 = 21, exakt 0 = 34. Vornormalisiert (`rawX = log10(SNR)`, invertierte Skala): mean **+1.07** (Anker [−2,+3]) → schon im Rohwert rechtslastig.

**Vergleich gegen Schritt-6-Beschreibung:** Die linke Hälfte ist in beiden Systemen massiv unterbelegt (links-halb <0.5: canonical **13.3 %**, persisted **27.9 %**).

---

## 3. Y-Verteilung

| | min | p05 | p25 | p50 | p75 | p95 | max | mean | skew |
|---|---|---|---|---|---|---|---|---|---|
| **Y canonical** (brightness) | 0.000 | 0.081 | 0.333 | 0.545 | 0.757 | 0.964 | 1.000 | **0.538** | −0.027 |
| **Y persisted** (log Centroid) | 0.000 | 0.010 | 0.515 | 0.734 | 0.879 | 1.000 | 1.000 | **0.671** | −0.232 |

Canonical Y: Bins 16.6 / 27.8 / 29.5 / 26.1 — **im Wesentlichen symmetrisch** (skew −0.027), aber mit Extrem-Dichte (exakt 0 = 19, exakt 1 = 34). Persisted Y ist hell-lastig (47.9 % >0.75), bedingt durch die log-Skala auf dem Centroid. Das beobachtete „rechts-UNten" entsteht NICHT aus der Y-Achse allein, sondern aus der Kreuzung X-rechts (tonal) × Y-unten (dunkel → tiefes Centroid) — siehe §7.

---

## 4. Zustände A / B / C

| Zustand | Was? | canonical X | persisted X |
|---|---|---|---|
| **A** Roh/Projektion | Projektor-Ausgabe (bzw. rawX log-SNR) | **== B** (mean aus [0,1]-Werten, clamp No-op) | mean −1.07·5→…: roh **rechtslastig** (mean +1.07 von [−2,3]) |
| **B** Normalisiert | [0,1]-Koordinaten | mean 0.758 | mean 0.614 |
| **C** Canvas (px) | 800 px breit, affine | mean 606.5 px (p50 657 px, max 799 px) | mean 491 px |

C = reine Lineare Skalierung von B (`CODE`, mapView.ts:386-389, render.ts:1257-1258). **Histogrammform A→B→C unverändert.** Alle drei Zustände transportieren dieselbe Rechtslastigkeit; keine Stufe fügt eine hinzu.

---

## 5. SoundCharacter-Dim-Audit (was treibt X?)

Inputdims über alle 1 439 Samples (`FACT`):

| Dim | mean | p50 | <0.25 | >0.75 | max | Kommentar |
|---|---|---|---|---|---|---|
| `tonality` | 0.714 | 0.786 | 3.5 % | 57.5 % | 0.9998 | **stark rechtslastig** |
| `noisiness` | 0.198 | 0.143 | 67.4 % | 0.3 % | 0.811 | **stark linkslastig** (→ 1−n mean 0.80) |
| `brightness` | 0.538 | 0.545 | 16.6 % | 26.1 % | 1.0 | symmetrisch |

Korrelationen: `corr(X, tonality)=+0.974`, `corr(X, noisiness)=−0.954`, `corr(X, brightness)=−0.812`, `corr(Y, brightness)=1.000`.

- **Formanalyse (`CODE`/`INFERENCE`):** `x = ½·tonality + ½·(1−noisiness)`. Der Operator ist symmetrisch in jedem der beiden Beiträge; **die Form erzeugt keine Schieflage**. Aber BEIDE Beiträge sind real rechtsverschoben (tonality hoch, noisiness tief) → X ist konstruktionsbedingt rechts. `mean = ½(0.714 + 0.802) = 0.758` — exakt der gemessene Wert.
- **Sättigung (`FACT`):** canonical X klemmt **nicht** an 1 (0 exakt = 1, nur 30/1439 ≥0.99, max 0.999). Trotzdem Kompression der tonalen Mehrheit: **63.8 %** der Samples liegen in x∈(0.75, 1] — ein Viertel der Kartenbreite. persisted map-v2 klemmt moderat (21 exakt = 1).
- **Fazit Dim-Audit:** Die Rechtslastigkeit sitzt in den **Eingabedaten** (tonality-hoch/noisiness-niedrig über den echten Katalog), nicht im Projektor und nicht in einer Sättigungsklemme.

---

## 6. Datensatz-Effekt vs. Projektions-Effekt

- **Zufalls-Subsets (deterministisch, `FACT`):** 4 Seeds à 500–800 Samples → meanX 0.748–0.760, >0.75 63.0–64.6 % — identisch zum Vollsatz (0.758 / 63.8 %). Die Schieflage ist robust gegen Teil-Stichproben.
- **Struktur:** one-shot (n=851) meanX 0.711; loop (n=184) 0.833; sustained-phrase (n=404) 0.824. Selbst die „unbiasedeste" Gruppe bleibt >0.70.
- **Klassen (canonical X, n≥20, `FACT`):** kick 0.931 (>0.75: 98.9 %), bass 0.930, tom 0.912, piano 0.908, keys 0.873, guitar 0.889, strings 0.871, pad 0.851, synth 0.861, lead 0.820, vocal 0.832, fx 0.756, atmosphere 0.702, noise 0.679, percussion 0.679, snare 0.611, clap 0.602, cymbal 0.507, hihat 0.481, openhat 0.485. **Nur Hüte/Zimbeln/Snares/Claps ≈ 20 % des Katalogs bewohnen die Noisy-Hälfte — und selbst die stehen um die Mittellinie, nicht im linken Viertel.**
- **Befund:** Die Verteilung ist ein Eigenschaft des Katalogs (mehrheitlich tonal-harmonisches Material), nicht der Stichprobenwahl.

---

## 7. Visualisierungen (`FACT`, Artefakte)

- `plotA-canonical-X-pre-norm-soundspace.svg` — Histogramm X (Projektor-Ausgabe, vor Canvas): Klumpen rechts, 20-Bins.
- `plotA2-persisted-rawX.svg` — Histogramm rawX (map-v2, vor Normalisierung).
- `plotB-canvas-X.svg` — Histogramm finaler Canvas-X (identische Form; affine Abbildung).
- `plotC-scatter-canonical.svg` — 2D-Scatter der 1 439 finalen Positionen: Massenzentrum rechts-unten, linkes Viertel fast leer.
- `plotC2-scatter-persisted.svg` — dito für map-v2.
- `step65-distribution.json` — alle Zahlenmaschinen.

Quadrat-Belegung (`FACT`): canonical **rightHalf 86.7 %**, **lowerRight 44.4 %**, upperLeft nur 13.3 %; persisted rightHalf 72.1 %, lowerRight 20.8 %. Das entspricht exakt der Screenshot-Beobachtung „Masse rechts bzw. rechts-unten".

---

## 8. Ist die Rechtslastigkeit „falsch"?

**Vermutlich nein — sie ist akustisch weitgehend korrekt.** (`INFERENCE`, gestützt auf FACT-Daten + CODE-Semantik)

- Die X-Achse ist dokumentiert als **„Noisy ↔ Tonal"** (`SOUND_SPACE_X_LOW/HIGH`, soundSpaceProjector.ts:47-48). Echte Produktions-Soundbibliotheken (Kicks, Bässe, Tasten, Pads, Leads, Gitarren, Streicher, Vocals, Synths) sind überwiegend **tonal** — der Katalog ist es nachweislich (tonality mean 0.714, noisiness mean 0.198, `FACT`). Dass die Masse an der "Tonal"-Polseite liegt, ist also die **wahre acoustische Verteilung**, nicht ein Artefakt.
- Die linke Hälfte ist keine „Fehlfunktion", sondern schlicht unterbevölkert: Noisy-Klassen (hihat/openhat/cymbal/clap/snare/percussion ≈ 20–25 % des Katalogs) stellen nur ~2 % der Samples links von x=0.25 (`FACT`). Dass tonale Body-Klassen (kick 98.9 %, bass 94.6 %, piano 100 % >0.75) praktisch nie im linken Viertel landen, ist akustisch plausibel.
- Sekundäre (echte, aber kleine) Verzerrung (`INFERENCE`): Die **tonale Mehrheit wird am rechten Rand komprimiert** — 63.8 % liegen in x∈(0.75,1]. Das ist eine Auflösungs-/Kontrastfrage der Skala, keine falsche Platzierung einzelner Samples. map-v2 klemmt zusätzlich 21 Samples exakt an x=1 (log-SNR-Sättigung).

---

## 9. Fazit — Klassifikation (genau EIN Buchstabe)

**Verdict: A — DATENVERTEILUNG (dominant).**

Begründung pro Kandidat:

- **A (Datenverteilung) — TAUGLICH.** Die Schieflage entsteht in den Inputdims (`tonality` hoch, `noisiness` niedrig über den echten Katalog, `FACT`), ist robust gegen 4 zufällige Teilstichproben und über alle Klassen/Strukturen reproduzierbar, und ist bereits in Zustand A (Roh-Projektion bzw. rawX) vorhanden.
- **B (Projektion) — nein.** `x = mean(tonality, 1−noisiness)` ist form-symmetrisch; die Achse soll eine tonal-lastige Bibliothek an die Tonal-Polseite legen. map-v2s log-SNR ist ebenfalls monoton und nur an 21 von 1439 Samples geklemmt.
- **C (Normalisierung) — nein.** Produktion kennt keine Korpus-Normalisierung; einzige Normalisierung ist `clamp01` (bei canonical ein No-op). `CODE`.
- **D (Rendering/Canvas) — ausgeschlossen.** Beide Pixelpfade sind lineare Affinitäten (render.ts:1257-1258, mapView.ts:386-389); Histogrammform A→C unverändert. `CODE`.
- **E (gemischt)** — wäre formal denkbar, aber die Sekundärfaktoren (Skalenkompression, log-SNR-Sättigung) verändern das Urteil nicht: die dominante Ursache ist eindeutig die Datenverteilung.

---

## 10. Empfohlener STEP66 (genau EIN Schritt, §9-konform)

**STEP66 — „Ehrliche Dichte-Darstellung + dauerhafter Verteilungs-Monitor":**

Erstens: `scripts/step65-map-distribution.ts` zum dauerhaften, geführten **`npm run audit:map-distribution`** ausbauen (Exit-Code + hochschwellenden Skew-Grenzwert), damit die Verteilung bei jedem Korpus-Export gemessen statt subjektiv „angesehen" wird.

Zweitens (Produktions-UI, **ohne** jede Änderung an X/Y-Formeln, Projektion, Normalisierung, Clusterung oder Scale): eine **Dichte-/Belegungs-Schicht** über der Map (Heat-Map + Quadranten-Auslastung als Lesezeichen) hinzufügen, die die wahre acoustische Verteilung ehrlich darstellt und die Überlappung der tonalen Mehrheit am rechten Rand visuell auflöst.

Begründung: Der Befund ist Daten-seitig, die aktuelle Darstellung ist akustisch korrekt. Ein „Verteilen", Umnormalisieren oder Skalieren wäre nach §9 ausgeschlossen UND fachlich falsch (es würde eine echte akustische Eigenschaft des Katalogs verschleiern). Der einzige sinnvolle Eingriff ist, die Dichte-Grammatik der Karte so zu erweitern, dass die Mehrheit am Tonal-Pol als **beabsichtigte Daten-Eigenschaft** sichtbar wird statt als Defekt — und dauerhaft messbar bleibt.

---

## Anhang: Mess-Reset zum Reproduzieren

```
npx tsx scripts/step65-map-distribution.ts
# Artefakte: /var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step65/{step65-distribution.json,plotA-*.svg,plotB-*.svg,plotC-*.svg}
npx tsc --noEmit      # clean (FACT, geprüft)
```