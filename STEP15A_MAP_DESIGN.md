# SAMPLEMAP V1 — STEP 15A REPORT
## Map Analysis Design — Existing Features → 2D Sample Map

Status: **Design / Analyse — nichts implementiert.**
Baseline geprüft: 191 Tests / 18 Dateien, TypeScript clean, Build OK (unverändert).

---

## 0 — Untersuchte Quellen (nur tatsächlich Vorhandenes)

| Datei | Rolle |
|-------|-------|
| `src/audio/featureExtractor.ts` | Erzeugt ALLE Audio-Features (pur, deterministisch) |
| `src/persistence/indexStore.ts` | `AudioFeatures`-Typ + `SampleIndexRecord` + `IndexStore` |
| `src/pipeline/analysisPipeline.ts` | job → fetch → decode → extract → classify → `index.put(record)` |
| `src/classify/heuristicClassifier.ts` | Feature-Heuristik → Klassifikation (`heuristic-v1`) |
| `src/classify/classifier.ts`, `registry.ts`, `taxonomy.ts` | Classifier-Vertrag / Registry / Taxonomie |
| `src/search/searchEngine.ts` | Read-only Suche/Filters über Index |
| `src/audio/decodedAudio.ts` | Decode-Vertrag (transient) |
| `SAMPLEMAP_V1_STATUS.md`, Step-12R-Realtest | Motivation + real verifizierte Backend-Fakten |

**Wichtige Feststellung:** Der `SampleIndexRecord` persistiert **bereits die vollen `audioFeatures`**
(alle 13 Werte) — nicht nur Teilmenge. Das ist entscheidend für die Persistenz-Entscheidung (§7).

---

## 1 — Existing Feature Extractor (vollständiges Inventar, nur reale Features)

Alle 13 Werte, die `extractFeatures` real erzeugt und die im `AudioFeatures`-Typ definiert sind
(`src/persistence/indexStore.ts:8`). **Keine Features erfunden.**

### 1.1 duration
- Datentyp: `number` (Sekunden)
- Wertebereich: `≥ 0` (praktisch 0.01 … ≥ 3 für Loops)
- Bedeutung: Dauer des Samples (aus decode, `ceil(mono.length/sampleRate)` Legacy; real aus AudioBuffer)
- Berechnung: `decode`-Metadaten, nicht aus PCM
- **Bereits persistiert:** JA (`audioFeatures.duration`)
- **Bereits vom Classifier verwendet:** JA (`d < 0.5`, `0.5..1.5`, `>1.5`, `>2.5` → short/medium/sustained/loop)
- **Geeignet für Map:** sekundär — nicht für X/Y-Charakter, aber nützlich als Filter/Größe

### 1.2 sampleRate
- Datentyp: `number` (Hz)
- Wertebereich: `8000 … 48000` (typisch 44100)
- Bedeutung: Abtastrate
- Berechnung: aus `DecodedAudio`
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** NEIN (nur indirekt über Hz-basierte Merkmale)
- **Geeignet für Map:** nur als Normalisierungs-Bezug (Nyquist); nicht als Achse

### 1.3 channels
- Datentyp: `number`
- Wertebereich: `≥ 1`
- Bedeutung: Kanalzahl
- Berechnung: aus `DecodedAudio`
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** NEIN
- **Geeignet für Map:** NEIN

### 1.4 rms
- Datentyp: `number` (Vollaussteuerung 0..1)
- Wertebereich: `0 … 1` (PCM /32768 als Float normalisiert)
- Bedeutung: Lautstärke (Energie)
- Berechnung: `sqrt( mean(mono²) )`
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** NEIN (nicht in Heuristik)
- **Geeignet für Map:** möglicher Punkt für „Lautheit“ als Punktgröße; nicht für X/Y-Charakter

### 1.5 peak
- Datentyp: `number`
- Wertebereich: `0 … 1`
- Bedeutung: Spitzenwert
- Berechnung: `max(|mono|)`
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** NEIN
- **Geeignet für Map:** NEIN (redundant zu rms, anfälliger)

### 1.6 transientDensity
- Datentyp: `number` (Transienten pro Sekunde)
- Wertebereich: `≥ 0`, oberseitig **unbegrenzt** (harter transient-Burst hoher Wert)
- Bedeutung: rhythmische Dichte / Anzahl von Anschlägen je Sekunde
- Berechnung: Envelope (Fenster 512, Hop 256), Schwelle mean+std, Zählung, / duration
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** JA (`transientDensity > 5`)
- **Geeignet für Map:** sekundär (Dichte); nicht als X- oder Y-Achse empfohlen

### 1.7 spectralCentroid
- Datentyp: `number` (Hz)
- Wertebereich: `0 … sampleRate/2` (Nyquist); real meist 0 … ~12 kHz
- Bedeutung: **spektrale Schwerpunkt-Frequenz** — der kanonische „Helligkeits“-Proxy
- Berechnung: amplitude-weighted mean frequency über FFT-Bins (FFT_N 1024, Hann)
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** JA (`dark < 400`, `mid 400..3000`, `bright > 3000`)
- **Geeignet für Map:** **JA — Y-Achse (DARK↔BRIGHT)**

### 1.8 spectralBandwidth
- Datentyp: `number` (Hz)
- Wertebereich: `0 … sampleRate/2`
- Bedeutung: spektrale Breite (Std.-Abw. um Centroid)
- Berechnung: `sqrt( Σ mag·(f−centroid)² / Σmag )`
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** JA (nur bei `noise`: `> 3000`)
- **Geeignet für Map:** sekundär (Schärfe); nicht als Achse empfohlen

### 1.9 spectralRolloff
- Datentyp: `number` (Hz, 85 %-Energie)
- Wertebereich: `0 … sampleRate/2`
- Bedeutung: Frequenz, unter der 85 % der Energie liegt (Helligkeit/Roll-Off)
- Berechnung: kumulierte Magnitude bis 85 %
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** NEIN
- **Geeignet für Map:** Alternative zum Centroid für Y (hoch korreliert)

### 1.10 zeroCrossingRate
- Datentyp: `number` (0..1 Anteil)
- Wertebereich: `0 … 1`
- Bedeutung: Nulldurchgänge je Sample — grober Vibrations-/Frequenz-Proxy
- Berechnung: Kreuzungen / (n−1)
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** NEIN
- **Geeignet für Map:** sekundäre Helligkeits-Stütze; rauschiger als Centroid

### 1.11 spectralFlatness
- Datentyp: `number`
- Wertebereich: `0 … 1` (geclampt)
- Bedeutung: **Tonalität vs. Noise** — 0 = tonal (wenige dominante Bins), 1 = noise (flach)
- Berechnung: geometric/arithmetic mean der Magnitude (DC-exklusiv), clamp01
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** JA (`noisy > 0.6`, `tonal < 0.35`, `> 0.8`)
- **Geeignet für Map:** **JA — Kern für X-Achse (NOISY↔TONAL)**

### 1.12 attack
- Datentyp: `number` (Sekunden)
- Wertebereich: `0 … duration`
- Bedeutung: Einschwingzeit (Zeit bis 90 % des Envelope-Peaks)
- Berechnung: Envelope-Fenster bis `0.9·maxEnv`
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** JA (`fastAttack < 0.02`)
- **Geeignet für Map:** sekundär (Einschwing-Größe); nicht als Achse empfohlen

### 1.13 tonalNoiseRatio
- Datentyp: `number`
- Wertebereich: `0 … 1` (geclampt)
- Bedeutung: **Inverses von SpectralFlatness** = 1 − spectralFlatness; 1 = tonal, 0 = noise
- Berechnung: `1 − spectralFlatness`
- **Bereits persistiert:** JA
- **Bereits vom Classifier verwendet:** NEIN (redundant zu Flatness)
- **Geeignet für Map:** **JA — direkter X-Achsen-Wert** (siehe §3)

> **NOT CURRENTLY AVAILABLE** (nicht im Repo, nicht erfinden): MFCC, Chroma, Onset-Stärke, Spectral-Spread unabhängig von Bandwidth, Beat-Tempo, Pitch/Pitch-Class, Spectral-Contrast, F0/Grundton, LPC, Mel-Bänder. Diese existieren NICHT.

---

## 2 — Feature Evaluation

| Feature | Bedeutung | X (NOISY↔TONAL) | Y (DARK↔BRIGHT) | Persistiert? |
|---------|-----------|-----------------|-----------------|--------------|
| spectralFlatness | Ton/nöise-Anteil | **Kern** (0=tonal) | – | JA |
| tonalNoiseRatio | 1−flatness | **Kern** (1=tonal) | – | JA |
| spectralCentroid | Helligkeit | – | **Kern** (0=dark, >hell) | JA |
| spectralRolloff | Helligkeit (85%) | – | Alternative zu Y | JA |
| zeroCrossingRate | Vibrationsdichte | sekundär | sekundär | JA |
| spectralBandwidth | spektrale Schärfe | sekundär | sekundär | JA |
| transientDensity | rhythmische Dichte | sekundär | – | JA |
| attack | Einschwingzeit | sekundär | – | JA |
| duration | Länge | – | – | JA |
| rms / peak | Lautheit | – | – | JA |
| sampleRate / channels | Kontext | – | – | JA |

---

## 3 — Recommended X Axis

- **Bedeutung:** `0 = NOISY … 1 = TONAL` (rechts laut Zielbild tonal)
- **Formel:** `x = clamp01( tonalNoiseRatio )`  ⟺  `x = clamp01( 1 − spectralFlatness )`
- **Eingabefeatures:** `tonalNoiseRatio` (bzw. `spectralFlatness`)
- **Normalisierung:** liegt **bereits in [0,1]**; ist im Extractor geclampt; keine weitere Skalierung nötig
- **Wertebereich:** `[0,1]`
- **Begründung:** Tonal → niedrige Flatness (wenige dominante Bins), Noise → hohe Flatness. Beide Features existieren und sind bereits persistiert. `tonalNoiseRatio` ist direkt die gewünschte Richtung.

*Hinweis Orientierung:* Das Zielbild zeigt NOISY links / TONAL rechts. Mit `x = spectralFlatness` wäre 0=tonal=links. Daher wird **invertiert** (`tonalNoiseRatio`), damit 0=NOISY links, 1=TONAL rechts. Rein konventionell — deterministisch.

---

## 4 — Recommended Y Axis

- **Bedeutung:** `0 = DARK … 1 = BRIGHT` (oben hell gemäß Zielbild)
- **Formel:** `y = clamp01( ( ln( max(centroid, μ) ) − ln(μ) ) / ( ln(Ω) − ln(μ) ) )`
  - `μ = 100` Hz (Schwelle „maximal dunkel“, bei/unter → y=0)
  - `Ω = 8000` Hz (Schwelle „maximal hell“, ab → y=1)
  - `ln` = natürlicher Logarithmus (Frequenzwahrnehmung annähernd logarithmisch)
- **Eingabefeature:** `spectralCentroid` (Hz)
- **Normalisierung:** feste, absolute Konstanten (µ, Ω) — **keine** dataset-relative Min/Max-Norm
- **Wertebereich:** `[0,1]`
- **Begründung:** Centroid ist der standardisierte Helligkeits-Proxy. Log-Skalierung verteilt tonale/dunkle und helle Inhalte besser (linear 0…Nyquist würde alles in den unteren Bereich pressen). Feste Konstanten ⇒ Position eines Samples ist **unabhängig von der Collection** (siehe §7/§9).
- **Ausreißer/Clamping:** Werte < µ → clamp 0; Werte > Ω → clamp 1. Hard-clamp ist deterministisch.

---

## 5 — Recommended Pick: kombinierte, präzise Formel

```text
mapVersion = "map-v1"

x = clamp01( record.audioFeatures.tonalNoiseRatio )            // NOISY(0) ↔ TONAL(1)
y = clamp01(
      ( ln( max(record.audioFeatures.spectralCentroid, 100) ) − ln(100) )
      / ( ln(8000) − ln(100) )
    )                                                          // DARK(0) ↔ BRIGHT(1)
```

Alle Eingaben sind **bereits persistierte** Felder. Reine Funktion ⇒ deterministisch (§9). Keine Zufälligkeit.

**Beispiel mit realem Wert (Step-14-Realtest, „Flume Tennis Snare“):** `tonalNoiseRatio=0.5746`, `spectralCentroid=5703` →
`x ≈ 0.575`, `y = (ln(5703)−ln(100))/(ln(8000)−ln(100)) ≈ (8.649−4.605)/(8.987−4.605) ≈ 0.919` ⇒ hell/leicht-rauschig, oben-rechts.

---

## 6 — Classification Visualization (Empfehlung)

- **Klasse = Form/Farbe, Position = Klangcharakter** (getrennt, INV-2-konform).
- `primaryClass` → Punktfarbe/-symbol (Taxonomie-Gruppen `drums`, `musical`, `other` als Farb-Familien, individuelle Klasse als Ton).
- Position kommt **ausschließlich aus `mapPosition(features)`**, nicht aus der Klasse.
- **Ein Kick wird NICHT in einen festen Kartenbereich gezwungen** (§10): zwei Kicks können bei identischer Klasse unterschiedlich liegen, wenn `tonalNoiseRatio`/`spectralCentroid` abweichen. Position folgt dem Klangcharakter.
- Klassifizierung wird primär über Filter/Beizer visualisiert (Farbe, Legend toggles), nicht über Position.

*Auch wenn technisch eine „Kick→dunkel-rechts“-Tendenz entsteht (dunkle, tonale Kicks landen naturgemäß unten-rechts), ist das eine **Eigenschaft der Feature-Metrik**, keine erzwungene Klassenzuordnung.*

---

## 7 — Persistence (minimal halten, anhand realen Codes begründet)

**Fakt:** `SampleIndexRecord.audioFeatures` persistiert die **kompletten** 13 Features bereits
(`src/pipeline/analysisPipeline.ts:143`, `src/persistence/indexStore.ts:46`). X/Y sind also vollständig
aus bereits gespeicherten Daten bestimmbar.

- **Variante A** (nur id/class/conf/version): NICHT zutreffend — die Features sind bereits da; die Frage stellt sich so nicht.
- **Variante B** (x/y zusätzlich speichern): möglich, aber **in V1 nicht nötig**.

**Empfehlung: KEINE neuen Felder `mapX`/`mapY` in `SampleIndexRecord` für V1.** Stattdessen:

> x/y werden **on-read** aus `audioFeatures` über die reine, versionierte Funktion `mapPosition(features)` berechnet.

Gründe (Prioritäten §20):
1. **Gestaltung deterministisch & reproduzierbar** (idempotent — gleiche Features ⇒ gleiche Position).
2. **Versionierung ohne Re-Analyse:** Map-Formel-Änderung (z. B. `map-v2`) ⇒ Positionsänderung **ohne Audio-Fetch / ohne neue Analyse**, weil Features gespeichert bleiben. Ein `mapVersion`-Konstanter in der Funktion genügt.
3. **Geringste Persistenz:** keine zusätzlichen Bytes; kein Migrations-/Backfill-Aufwand.
4. **Geringste Architektur-Änderung:** keine Änderung an `SampleIndexRecord`/`IndexStore`/`db.ts` erforderlich; kein zweiter Index.

Temporäre `DecodedAudio`/Bytes bleiben ausnahmslos transient (§1.1 weiter erfüllt). **Keine Änderung am Persistenzmodell.**

**Ausnahmefall für Step 15B** (Entscheidungspunkt): Nur falls die Map einen räumlichen Index/Clustering
über große N *innerhalb* von IndexedDB braucht und `getAll()`+Berechnung pro Render zu teuer wird, dann
als bewusste, begründete Erweiterung `mapX`/`mapY`/`mapVersion` in `SampleIndexRecord` ergänzen. Für V1-Größenordnungen (§8) ist das NICHT nötig.

---

## 8 — Storage Estimate (nur persistierte SampleMap-Daten; `estimated`)

Gemessen an einem repräsentativen, vollständig analysierten Record (JSON-Serialisierung, inkl. 13 Features):
**≈ 0.8–1.0 KB pro Record** (real gemessen: 862 bytes für ein Beispiel).

| Samples | Größenordnung (persistierter Index) |
|---------|-------------------------------------|
| 1.000   | ≈ 0.8 – 1.0 MiB (`estimated`) |
| 10.000  | ≈ 8 – 10 MiB (`estimated`) |
| 100.000 | ≈ 80 – 100 MiB (`estimated`) |
| 1.000.000 | ≈ 0.8 – 1.0 GiB (`estimated`) |

Hinweise/Folgerungen:
- Diese Menge ist **weitgehend schon heute** als `audioFeatures` persistiert — die Map verursacht bei „compute-on-read“ **0 zusätzliche Bytes**.
- Die Werte sind JSON/Lebensgrößen des ElasticDB-Klons; echtes IndexedDB-Structured-Clone kann geringfügig abweichen ⇒ klar als `estimated` markiert.
- Audio bleibt **nicht** persistent; Audiotool-Speicher bleibt unberührt; keine ML-Modelle enthalten.

---

## 9 — Versioning

- **Classifier version:** bereits vorhanden (`classificationVersion = "heuristic-v1"`, aus `classifier.version`; zusätzlich `analysisVersion="features-v1"` und `analysisBuild`). Änderungen ⇒ Job-Runner (Wieder-)Analyse über `(sampleId, analysisBuild)`.
- **Map version:** empfohlen als **Konstante in der reinen `mapPosition`-Funktion** (`"map-v1"`), bewusst **kein** eigenes persistiertes Feld in V1.
- **Verhalten bei Map-Versions-Wechsel:** Da `audioFeatures` gespeichert sind und die Map eine reine Funktion ist, **braucht es KEINE neue Analyse / kein Audio-Fetch**. Die gesamte Karte kann offline aus bestehenden Records neu berechnet werden (ein `Index`-Durchlauf, kein IO). Das ist ein klarer Vorteil gegenüber der Persistenz von x/y.
- **Vollständige Re-Analyse** (neue Features/Classifier) bleibt unverändert über `analysisBuild`/`classificationVersion` (bestehender Mechanismus).

---

## 10 — Required Code Changes for Step 15B (genau, minimal)

Neues, eigenständiges Modul (kein Umbau vorhandener Pfade):

| Ziel | Änderung |
|------|----------|
| **NEU** `src/map/mapPosition.ts` | Pure Funktion `mapPosition(features: AudioFeatures): { x: number; y: number; mapVersion: "map-v1" }` — Formel aus §5. Keine I/O, kein Audio, deterministisch. |
| **NEU** `src/map/mapPosition.test.ts` | Unit-Tests: Determinismus (gleiche Features ⇒ gleiche x/y), Grenzwerte (Centroid=0⇒y=0, Centroid≥8000⇒y=1, Flatness=0/1⇒x), Reihenfolge-Monotonie, Clamping, keine Zufälligkeit. |
| `src/search/searchEngine.ts` (optional, read-only) | `SearchResult`/Record → als Convenience `mapPosition(record.audioFeatures)` exportieren; **keine** neue Logik im Suchpfad. |
| `src/ui/view.ts` / `src/ui/app.ts` (Step 15B-UI) | `SampleMapVM`-Erweiterung um `x`/`y` (berechnet aus `record.audioFeatures`); Map-Ansicht in `render.ts`. |
| `src/ui/bootstrap.ts` | ggf. `mapPosition` in die deps injizieren (kein Pflichtfeld). |

Nicht anfassen ohne Basis: `SampleIndexRecord`/`IndexStore`/`db.ts`/`analysisPipeline.ts`/`classifier` — bleiben in V1 unverändert.

**Ausdrücklich NICHT in Step 15A implementiert:** Canvas/SVG/WebGL, Zoom/Pan/Hover, Inspector, Filter-UI, Preview-UI, Machiniste-UI, Clustering.

---

## 11 — New Features Required?

**NO.**

- Beide Achsen verwenden **ausschließlich bereits existierende, bereits persistierte Features**
  (`tonalNoiseRatio`, `spectralCentroid`).
- Die V1-Regel „keine neuen Audiofeatures ohne Notwendigkeit“ greift: die Basis reicht aus.
- **Kein** zusätzlicher DSP vorgeschlagen. (Falls Step 15B später eine feinere Trennung von z. B. Kick-Helligkeit will, wäre ein Mel-Band- oder Spectral-Envelope-Feature V2 — begründet, aber NICHT jetzt.)

---

## 12 — Risks / Limitations

- **Konzeptuell, nicht psychoakustisch kalibriert:** X/Y approximieren „noisy/tonal/dunkel/hell“ konsistent, aber nicht exakt menschlich empfundene Werte. Das ist per Design (§19) akzeptabel.
- **SpectralFlatness anfällig bei sehr kurzen Samples:** wenige Bins → flacher/noisiger als empfunden; akzeptiert.
- **Centroid-Clamping an den Rändern:** starke semantische Stauung oberhalb 8 kHz bzw. unter 100 Hz. Deterministisch, aber die eher „extreme“ Klassen liegen am Rand. Als V1 in Ordnung.
- **Tempo-unabhängige transientDensity:** wird NICHT als Achse verwendet, vermeidet Frequenz-/Tempo-Artefakte.
- **Keine Ähnlichkeits-Psychoakustik:** §11 nur X/Y-Euklid als V1-Similarity (siehe unten).
- **Einheitlichkeit der Sample-Formate:** Loop vs. One-Shot können bei gleicher Klasse differieren; erwünscht (Position=Klang).
- **Kollektionsunabhängigkeit** garantiert stabile Positionen beim Hinzufügen neuer Samples (feste Konstanten).

---

## 13 — Similarity (V1-Empfehlung, §11)

- **V1:** reine 2D-Euklid-Distanz über X/Y:
  `distance(A,B) = sqrt( (Ax−Bx)² + (Ay−By)² )` mit `x,y ∈ [0,1]`.
  - Ausreichend für „ähnliche Samples nahe beieinander / unähnliche auseinander“.
  - **Kategorie nur optional** als Filter/Beize **vor** der Distanz (gleiche Klasse ⇒ vergleichbar). Nicht als Gewicht in die Distanz mischen (sonst dominiert die Klasse die Position — INV der Trennung).
  - **Confidence:** nicht in die Distanz einbeziehen (kennzeichnet Treffsicherheit, nicht Klang). Optional nur als Punkt-Opazität.
- **Keine ML-Similarity-Engine** in V1; bewusst V2/optional.

---

## 14 — Decision-Prioritäten eingehalten (§20)

1. Vorhandene Architektur unverändert (kein neuer Index, keine neue DB, keine neue Persistence-Schicht).
2. Reale Nexus-API-Verträge respektiert (nur persistierte Felder genutzt, keine erfundenen APIs).
3. Deterministisch (reine Funktion, feste Konstanten).
4. Geringe Persistenz (0 Zusatz-Bytes; x/y on-read).
5. Schnell (2 Float-Berechnungen pro Sample, kein Audio).
6. Verständlich (2 beschriftete Achsen, farbige Klassen).
7. Erweiterbar (mapVersion-Konstante; später räumlicher Index möglich).

---

## 15 — Step 15A Verdict

**READY FOR STEP 15B**

Die drei Pflichtfragen sind belastbar beantwortet:
1. **Welche vorhandenen Analysewerte?** → `tonalNoiseRatio` (X), `spectralCentroid` (Y) — beide bereits existieren & persistiert.
2. **Wie entsteht X/Y?** → reine, deterministische Funktion `mapPosition` mit festen Konstanten (Formel §5), x,y ∈ [0,1].
3. **Was wird minimal gespeichert?** → **nichts Neues**; x/y on-read aus den bereits gespeicherten `audioFeatures`; `mapVersion` als Funktionskonstante.

Keine Produktionsänderung, keine Tests gelöscht/geändert, keine Features erfunden.
Baseline unverändert: **191 Tests / 18 Dateien, TypeScript clean, Build OK**.
