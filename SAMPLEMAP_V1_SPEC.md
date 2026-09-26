# SampleMap — V1 Technical Specification

**Status:** Entwurf zur Prüfung (noch NICHT implementiert)
**Datum:** 2026-08-31
**SDK-Basis:** `@audiotool/nexus@0.0.17`
**Voraussetzung:** Machiniste Integration POC erfolgreich abgeschlossen (siehe `MACHINISTE_SAMPLE_ACCESS_POC.md`)

---

## 1. Produktziel

SampleMap ist eine Nexus-App für Audiotool. Sie analysiert die Audiotool Sample
Library und erstellt daraus einen eigenen intelligenten, **rein auf Metadaten
basierenden** Index. Der Anwender kann darin nach Instrumentenklassen (Kick, Snare,
Bass, Vocal, …) filtern, Samples **direkt aus Audiotool previewen** und ausgewählte
Samples **per direkter Nexus-Referenz in einen Machiniste laden** — ohne
Download→Upload-Workflow.

**Grundprinzip (kein permanenter Audio-Cache):**

```text
Audiotool Sample Library
        ↓
 Sample abrufen (temporär)
        ↓
 Audio analysieren
        ↓
 Analyseergebnisse speichern (Index)
        ↓
 Audio verwerfen (lokal nichts dauerhaft behalten)
```

SampleMap speichert primär **Metadaten und Analyseergebnisse**, nicht die Audiotool
Library als Audio-Dateien.

### 1.1 Harte Architektur-Invariante

> **`SampleMap MUST NEVER persist Audiotool sample audio bytes.`**

- Audio darf **ausschließlich temporär** im RAM / im (Worker-)Speicher existieren.
- Nach der Analyse wird das Audio **zwingend freigegeben** (WebWorker-Terminierung /
  `ArrayBuffer`-Freigabe / `URL.revokeObjectURL`).
- **IndexedDB enthält ausschließlich**: Metadaten, Analyseergebnisse, Queue-State und
  optional Embeddings — **niemals** WAV-/MP3-/FLAC-Bytes.
- Diese Invariante gilt strukturell (keine `AudioBuffer`/`Blob`-Persistenz-Pfade in
  der Storage-Schicht) und ist als solcher Vertrag in der Spezifikation fixiert.

---

## 2. Bestätigte technische Voraussetzungen

Real (gegen das echte Audiotool-Backend) bereits bestätigt:

| # | Fähigkeit | Nachweis |
|---|-----------|----------|
| 1 | OAuth-Authentifizierung (Browser-Flow) | `http://127.0.0.1:5176/` Login + Consent ok |
| 2 | `client.samples.list()` liefert Library-Samples | paginiert, `nextPageToken` |
| 3 | Öffentliche Samples anderer User erreichbar | `list`/`get` |
| 4 | `client.samples.get()` funktioniert | Metadaten abrufbar |
| 5 | Audio-Preview/Download funktioniert | `previewMp3Url`/`download` |
| 6 | Echtes Projekt über Nexus öffnen/ändern | `client.open(project)` → `SyncedDocument` |
| 7 | Machiniste über Nexus erzeugen/ändern | `t.create("machiniste")`, `t.update(...)` |
| 8 | Fremdes öffentliches Sample per direkter `sampleName`-Referenz in Machiniste laden | `Sample`-Entity `sampleName = "samples/{uuid}"` |
| 9 | Referenz nach Commit zurücklesbar | `readBackMatches: true` |
| 10 | Projekt „Neural Pasture" in Audiotool geöffnet, enthielt Machiniste + Sample | manuell verifiziert |
| 11 | Gain-Plugin im Testprojekt erzeugt | manuell verifiziert |

**Konsequenz:** Der zentrale technische Machbarkeitsnachweis
`existing Audiotool Sample → direct Nexus reference → Machiniste` ist **abgeschlossen
und real verifiziert**. Damit ist die Grundlage für das vorgebene Architekturmerkmal
`SampleMap → AudiotoolSampleReference → MachinisteService → Sample Entity → MachinisteChannel.sample`
gelegt.
gelegt.

---

## 3. Systemarchitektur

### Konzeptionell (Zielbild V2/V3)

```text
Audiotool
    ↓
Analysis Worker (Backend, langfristig)
    ↓
SampleMap Database (Index)
    ↓
Nexus App (UI in Audiotool)
```

### V1 (einfacher POC, aber skalierbar angelegt)

```text
┌─────────────────────────────────────────────────────────────┐
│  UI (Browser / Audiotool Nexus-App)                         │
│  ├── Sample Browser                                          │
│  ├── Search / Filters                                        │
│  ├── Preview                                                 │
│  └── Machiniste Loader                                       │
├─────────────────────────────────────────────────────────────┤
│  Core                                                       │
│  ├── Sample Library Client   (Nexus samples.*)              │
│  ├── Analysis Pipeline       (fetch → analyze → dispose)    │
│  ├── Classifier              (CNN/spectrogram → softmax)    │
│  ├── Feature Extractor       (audio features)               │
│  ├── Index                   (SampleMap-storage)            │
│  ├── Search Engine           (filter + ranked results)      │
│  └── Machiniste Service      (direct-reference loader)      │
├─────────────────────────────────────────────────────────────┤
│  Storage                                                    │
│  └── SampleMap Index (metadatenbasiert, audiofrei)          │
└─────────────────────────────────────────────────────────────┘
```

### Browser vs. Server — Entscheidung für V1

| Aspekt | Browser-Worker (V1) | Server/Worker (V2+/langfristig) |
|--------|---------------------|---------------------------------|
| Latenz | hoch (ein Sample nach dem anderen) | parallel, verteilt |
| Skalierung | einzelne Samples halbwegs ok; bei 100k+ Audio kaum praktikabel | horizontal skalierbar |
| Audio-Zugriff | erfordert OAuth pro Sitzung, Browser-Fetch | zentrale Credentials/Backend |
| Speicher | nur temporär im RAM | zentrale Indizes |
| Resume/Faulheit | nur innerhalb einer Browsersitzung | robust (Queue, Job-Graph) |
| Bereitstellung | App ohne eigene Infrastruktur | benötigt eigenes Backend |

**Empfehlung V1:** Analyse **im Browser** (ein Web-Worker für die Audio-Analyse),
aber die **Index-Struktur und Job-Queue als Protokoll** so abstrahieren, dass sie
später 1:1 auf einen Server-Analyse-Worker umzieht. So bleiben wir im POC einfach
(kein Backend), ohne eine Architektur zu bauen, die bei 100.000+ Samples unbrauchbar
wird — der Umzugspfad ist vorgezeichnet.

---

## 4. Datenmodell

### 4.1 SampleMap Index (ohne Audio)

```text
SampleIndexRecord {
  //
  // Identität & Quelle
  sampleId        string   "samples/{uuid}"
  owner           string
  visibility      "public" | "unlisted" | "private" | ...
  name            string   // displayName
  kind            string   // kategorie-typ (z. B. "kick"?)
  originalTags    string[] // Audiotool-Tags — NUR ZUSATZINFO
  //
  // Klassifikation (KI)
  primaryClass    string   // z. B. "snare"
  confidence      number   // 0..1, z. B. 0.94
  secondaryClasses [{ class: string, confidence: number }, ...]
  classificationVersion string
  //
  // Audio-Features
  audioFeatures {
    duration, bpm, sampleRate, channels,
    loudness, rms, peak,
    transientDensity,
    spectralCentroid, spectralBandwidth, spectralRolloff,
    zeroCrossingRate, spectralFlatness,
    attack, decay,
    estimatedPitch, tonalNoiseRatio
    // (siehe §6: nach Nutzen/Kosten gefiltert)
  }
  //
  // Metadaten der Analyse
  analysisVersion string
  analyzedAt      string (ISO)
  analysisBuild   string // Model-Hash, Feature-Hash (→ Dirty-Write-Schutz)
  status          "pending" | "analyzed" | "failed" | "gone"
  //
  // Optional (V2 per Vektorindex)
  embedding?      Float32Array / ClusterId
}
```

### 4.2 Persistenz

- V1: **IndexedDB** im Browser (objektbasiert, transaktional, keine Audio-Bytes).
- Audio-Bytes NIE in IndexedDB; nur temporäre `ArrayBuffer` im RAM/Worker.
- Analyse darf nur **einmal pro `(sampleId, analysisBuild)`** laufen
  (Idempotenz über `sampleId + analysisBuild`).

---

## 5. Analysepipeline

```text
Enqueue(sampleId)
   → Rate-Limit & Kollision prüfen
   → Idempotenz prüfen (sampleId, analysisBuild bereits analysiert? → skip)
   → (get) Metadaten holen (sampleId, owner, tags, dur)
   → download/preview (temporär, WAV bevorzugt)          [temporär im RAM]
   → decode Audio (Worker)
   → Feature Extractor  (siehe §6)
   → Classifier         (Classifier-Interface, siehe §7)
   → Index-Upsert  { sampleId, features, classification, analyzedAt }
   → Release Audio (Vector vom Worker verwerfen)          [kein lokaler Cache]
   → nächster Job (pausierbar / resume-fähig)
```

### 5.0 Inkrementelle, pausierbare Analysejobs (V1-Pflicht)

- V1 analysiert **NICHT** die komplette Library in einer Sitzung.
- Es gibt eine **persistente Job-Queue** in IndexedDB (State nur, kein Audio).
- Jobs sind **pausierbar** (User kann die Analyse stoppen) und **resumable**
  (beim Neustart wird an der letzten Position fortgesetzt).
- Jeder Job ist **idempotent** (Key `sampleId + analysisBuild`), hat **Retry** mit
  exponentiellem Backoff und einen Endzustand `analyzed | failed | gone | skipped`.
- **Kontrollierter Analysemodus** (für empirische Qualitätsprüfung):
  `Analyse 10 / 100 / 1000 neue Samples`
  Der User legt pro Lauf ein festes Budget neuer Samples fest; danach stoppt der
  Lauf automatisch. So lässt sich die Klassifikationsqualität an einer kleinen,
  manuell prüfbaren Stichprobe verifizieren, bevor die Menge erhöht wird.
- Weiterverarbeitung nach einem abgeschlossenen Lauf: erneuter Lauf mit höherem
  Budget setzt auf den bereits analysierten Teil auf (keine Re-Analyse).

### 5.1 Größenproblem / Skalierungsanforderungen (explizit behandelt)

| Anforderung | V1-Ansatz | Langfristig (V2+/Server) |
|-------------|-----------|--------------------------|
| Streaming | Download → Worker decode, sofern Backend `Content-Range` erlaubt; sonst volles temporäres Fetch | Server-Streaming in Analyse-Jobs |
| Temporäre Downloads | ObjektURL/`ArrayBuffer`, nach Analyse sofort `revokeObjectURL`/freigeben | Backend-Jobs |
| Sofortiges Löschen nach Analyse | `await` + freigeben; kein persistenter Fetch | ephemerer Storage |
| Chunking | pro Sample einzeln; Preview-MP3 nutzen, wenn WAV nicht nötig | datenbankgestützt |
| Caching | nur Metadaten-Cache; Audio nicht cachen (außer Preview-Optimierung, §9) | CDN/cache für Audio nur serverseitig kurz |
| Deduplication | Key = `sampleId`; ein Record pro Sample | normalisiert db |
| Analyse nur einmal pro Sample | Idempotenz via `(sampleId, analysisBuild)` | job-basiert idempotent |
| Inkrementelle Indexierung | delta-scan; nur Neue/Geänderte | DB-Trigger / Change-Stream |
| Resume nach Unterbrechung | Queue-Persistenz in IndexedDB; fortsetzen beim Neustart | Job-Queue (SQS/DB) |
| Rate Limits | Wartezeit/Batching auf `samples.download`; concurrency=1 (`MAX_CONCURRENCY`) | Backend-Drosselung |
| API Pagination | `nextPageToken`-Loop (bereits in `listSamplesPageByPage`) | serverseitig |
| Fehler/Retry | exponentielles Backoff, `failed`-Status | Job-Retry |
| Neue Samples | vergleiche `latestKnown` a. d. letzten Scan-Zeitstempel | Change-Stream |
| Geänderte Samples | Reanalysieren, wenn `updatedAt` > `analyzedAt` ODER `analysisVersion` neu | Change-Stream |
| Nicht mehr verfügbar | `get()`/`download` schlägt fehl → Status `gone`, aus aktiven Ergebnissen ausblenden | DB-Housekeeping |

**Kernrechnung zur Ehrlichkeit:**
- Ein durchschnittliches Sample-Preview (MP3, ~3 s) ist wenige hundert KB;
  WAV-full ~1–10 MB.
- **Browser-seitig** ist realistische Durchsatz gering (Sequenzielles Fetch+Decode+Inference,
  Netzwerk-Schwankungen, Rate-Limits). Für einen POC mit einigen hundert Samples ok,
  für **100.000+ Samples mit Audio-Klassifikation** ist rein-browser-seitige Analyse
  **nicht realistisch als reiner Voll-Scan in einer Sitzung**.
- Deshalb: **V1 = Browser-POC, inkrementell, pro-Sample, beweisbar, mit kontrolliertem
  Analysemodus und explizit NICHT komplette-Library-in-einer-Sitzung**, mit einem
  klar definierten Server-Umzugspfad. Die Audiotool-Tags + Basis-Metadaten liefern
  sofort eine brauchbare Suche, ohne Audio analysieren zu müssen.

---

## 6. Audio-Features (Nutzen/Kosten-Bewertung)

Bewertung jedes Kandidaten nach **Nutzen** (Klassifikation/suche) und **Kosten**
(Rechenaufwand, Robustheit).

| Feature | Nutzen | Kosten | V1? |
|---------|--------|--------|-----|
| duration | hoch (Drum vs. Loop) | trivial (Metadaten) | **Ja** |
| sampleRate / channels | gering, aber billig | trivial | **Ja** (nur speichern) |
| BPM | mittel (Loops) | mittel (Onset-basiert, unzuverlässig bei One-Shots) | V2 (optional) |
| loudness / RMS / peak | mittel-hoch (Hit vs. Pad) | gering | **Ja** (RMS, peak) |
| transientDensity | hoch (Drums vs. Sustained) | gering | **Ja** |
| spectralCentroid | hoch (dunkle Kick vs. helle Hat) | gering | **Ja** |
| spectralBandwidth | mittel | gering | **Ja** |
| spectralRolloff | mittel | gering | **Ja** |
| zeroCrossingRate | mittel (Noise vs. Ton) | gering | **Ja** |
| spectralFlatness | hoch (Noise vs. tonal) | gering | **Ja** |
| attack | mittel (besonderes Transient) | gering | **Ja** (vereinfacht) |
| decay | niedrig-mittel | gering | V2 |
| estimatedPitch | mittel (Bass/Tonal) | mittel | V2 |
| tonalNoiseRatio | hoch | gering | **Ja** (siehe flatness) |

**Empfehlung V1:** implementieren → `duration, sampleRate, channels, rms, peak,
transientDensity, spectralCentroid, spectralBandwidth, spectralRolloff,
zeroCrossingRate, spectralFlatness, attack, tonalNoiseRatio`.
Auslassen in V1 → `bpm, decay, estimatedPitch` (hohe Kosten / geringe Robustheit;
auf den Index- und Klassifikationswert keiner der drei hat in Drums/FX entscheidende
Wirkung).

---

## 7. Klassifizierung

### 7.1 Klassen-Taxonomie

```text
Drums:     kick, snare, clap, hihat, openhat, tom, cymbal, percussion
Musical:   bass, synth, piano, guitar, strings, keys, pad, lead
Other:     vocal, fx, atmosphere, noise, loop, other
```

### 7.2 Stabiles `Classifier`-Interface (V1-Pflicht)

Die V1 **festschreibt kein konkretes Modell** (auch kein zwingendes Spectrogram-CNN).
Stattdessen wird ein **stabiles `Classifier`-Interface** definiert, das einen
späteren Austausch des darunterliegenden Modells erlaubt:

```ts
type ClassOutput = {
  primaryClass: ClassId;                  // z. B. "snare"
  confidence: number;                     // 0..1
  secondaryClasses: { class: ClassId; confidence: number }[]; // geordnet
};

interface Classifier {
  readonly id: string;                    // Identifikator des Modells (z. B. "heuristic-v1")
  readonly version: string;               // analysisVersion-Segment für Idempotenz
  classify(audio: DecodedAudio): Promise<ClassOutput>;
}
```

**Eigenschaften / Vertrag:**
- Eingang: ein einmalig dekodiertes Audio-Feature/`DecodedAudio` (RAM, temporär).
- Ausgang: `{primaryClass, confidence, secondaryClasses[]}`.
- Modell-austauschbar: Die Pipeline hängt nur am Interface; das konkrete Modell
  (Feature-Heuristik, ein passendes vortrainiertes Modell oder ein kleines CNN) ist
  frei wählbar und wird registriert, z. B.:
  - `HeuristicClassifier` (V1-Fallback: Flatness→Noise, TransientDensity→Drums,
    Centroid→Hat/OpenHat, RMS→Hit),
  - oder ein vortrainiertes Modell (falls ohne Trainingsaufwand verfügbar),
  - oder ein kleines CNN (frühestens, wenn ein V1-Datensatz vorliegt).
- **Kein Modell wird vorab verbindlich festgeschrieben**; `Classifier.id`/`version`
  erlauben, Ergebnisse aus Alt-Modellen gezielt neu zu klassieren
  (`analysisVersion`-Trigger, §4.1/§8.1).
- **V1-Datensatz:** eigene kuratierte Samples + öffentliche Audiotool-Samples
  (klein, für POC); Trainingsdaten liegen lokal/offline — nur relevant, sobald ein
  trainierbares Modell (z. B. CNN) gewählt wird.

### 7.3 Strikte Trennung: Audiotool-Tags vs. SampleMap-Klassifikation

- **`originalTags`** (Audiotool) und **`primaryClass/confidence/secondaryClasses`**
  (SampleMap) sind **getrennte Felder** im Index (§4.1) und werden in der UI/Suche
  auch getrennt behandelt.
- **Audiotool-Tags sind NUR Zusatzinformation und niemals Klassifikationswahrheit.**
- Beispiel:

  ```text
  Name: something
  Audiotool tags: [pierre]
  ```
  ```text
  KI-Klassifikation:
    snare: 0.94
    percussion: 0.04
    other: 0.02
  ```

- Die SampleMap-Klassifikation ist **eine Wahrscheinlichkeitsverteilung**, keine bloße
  `type = snare`-Zuordnung.

---

## 8. Index & Suche

### 8.1 Index

- Siehe §4.1. Reine Metadaten/Analyse; **funktioniert ohne Audio**.
- Index-Schema versioniert (`analysisVersion`), damit Model- oder Feature-Wechsel
  gezielt Reanalyse auslösen können.

### 8.2 Suche

- **Textsuche:** `name`, `originalTags`, `owner` (fuzzy via einfacher Tokenisierung).
- **Klassenfilter:** `primaryClass` (or Mehrfach-Auswahl), optional
  `secondaryClasses`.
- **Feature-Filter (V2+):** duration-Bereich, BPM-Bereich, RMS.
- **Sortierung:** Relevanz (Konfidenz bei Filterabfragen), Name, analyzedAt.
- **„Find Similar" (skizziert für V1-Architektur, implementiert in V2):**
  Embedding-Vektor pro Sample; Such-Skizze:

  ```text
  [Kick selected]
     ↓ Find Similar
  ähnliche Samples
      ↓
  98% Kick A
  96% Kick B
  94% Kick C
  91% Kick D
  ```

  V1 lagert dafür nur einen optionalen `embedding`/`clusterId`-Platz im Index.
  Der eigentliche Vektorindex (z. B. Approximate Nearest Neighbor) ist V2.

---

## 9. Preview

- **Bevorzugt:** Audiotool `previewMp3Url` bzw. `client.samples.download(..., "preview")`
  direkt im Browser abspielen.
- **Parallelität:** begrenzte Anzahl paralleler Preview-Fetches
  (`MAX_PREVIEW_CONCURRENCY`, voreingestellt 2–4).
- **Cache:** nur sinnvoll, wenn wiederholtes Abspielen; flüchtiger MP3-Browser-Cache /
  ObjektURL-Pool mit LRU und Größenlimit. **Kein permanenter Audio-Storage.**
- **ObjektURL-Hygiene:** jede erzeugte `URL.createObjectURL` wird nach Ablauf/Stop
  mit `URL.revokeObjectURL` freigegeben.
- **Ausgabe-Typen:** `<audio>`-Element oder WebAudio für Pegel-Anzeige.

---

## 10. Machiniste Integration

Bestätigter Mechanismus als eigener Service abstrahiert:

```text
SampleMap
    ↓
AudiotoolSampleReference     (fasst sample.name → sampleName zusammen)
    ↓
MachinisteService
    ↓
Sample Entity  (document-local, sampleName="samples/{uuid}")
    ↓
MachinisteChannel.sample     (NexusLocation → entities.Sample)
```

### 10.1 Workflow (UI)

```text
Select Samples
      ↓
Select Machiniste
      ↓
Select Slots
      ↓
Send
```

### 10.2 Mehrere Samples → Mehrere Slots (V1-Pflicht, gebremst)

- Benutzer kann mehrere Samples (z. B. 8 Kicks) auswählen.
- `MachinisteService.send(samples[], machinisteId, slots[])`:
  - Für jedes Sample eine documents-lokale `Sample`-Entity anlegen
    (`sampleName` = `samples/{uuid}`).
  - `MachinisteChannel[i].sample` auf jeweilige Entity setzen (Slot i).
  - **Eine einzige `modify(...)`-Transaction** für alle Slots (atomic commit, ein
    Rücklesen).
- **Begrenzte Concurrency:** Die Zahl gleichzeitig verarbeiteter Samples pro Send-
  Vorgang ist beschränkt (`MAX_BATCH_SLOTS`, z. B. 8); größere Auswahlen werden in
  Batches geschickt (nicht unbegrenzt parallel, kein Sammelsurium an Transaktionen).
- Nach dem Commit **muss** der Dienst pro Slot ein Read-Back durchführen und
  `applied`/`readBackMatches`/`errors[]` melden.
- Damit entfällt das manuelle Einzelsenden.

### 10.3 Verifikation

- Neuer Dienst führt intern `read-back` durch (τ innerhalb der Transaction).
- Er meldet pro Slot: `applied`, `readBackMatches`, `errors[]`.

---

## 11. Skalierungsstrategie

### 11.1 Browser-POC (V1)

- Inkrementell: nur neue/geänderte Samples analysieren.
- Idempotente Analyse (`sampleId + analysisBuild`).
- Pausierbare Jobs + Queue in IndexedDB → Resume nach Unterbrechung.
- **Kontrollierter Analysemodus:** festes Budget `10/100/1000` neue Samples pro Lauf,
  automatischer Stopp (siehe §5.0).
- Begrenzte Concurrency, Rate-Limit, Backoff.
- Bewusst **keine** Voll-Library-Analyse in einer Sitzung erzwingen.

### 11.2 Langfristig (V2+/Server)

```text
Audiotool
    ↓
Analysis Worker   (Docker/Kubernetes/HorizontalScale, konsumiert Queue)
    ↓
SampleMap Database (Postgres/Clickhouse + Vektorindex + S3 für temporäres Audio)
    ↓
Nexus App
```

- Analyse-Jobs mit Retry/DLQ, per Job-Tracking resumable.
- Per-Sample-Idempotenz bleibt erhalten.
- Batching + Parallelisierung über mehrere Worker.
- Der V1-`AnalysisPipeline`-Auftrag ist als Interface so geschrieben, dass er auf
  den Server-Worker umzieht (gleiches Ein-/Ausgabeprotokoll).

---

## 12. Storage-Strategie

| Daten | V1 | Langfristig |
|-------|----|-------------|
| Index (Metadaten/Features/Klassifikation) | IndexedDB (Browser) | Postgres/Clickhouse |
| Audio-Bytes | NIE persistent; nur temporär im Worker-RAM/ObjektURL | ephemerer S3/Temp-Volume pro Job; danach delete |
| Queue | IndexedDB | Server-Queue (SQS/DB) |
| Embeddings | optional IndexedDB (Float32Array) | Vektorindex (pgvector/ANN) |
| Config/Ui-State | localStorage | — |

**Merksatz:** „Die Audiodateien sollen NICHT dauerhaft auf dem Rechner gespeichert
werden“ → **IndexedDB == Metadaten + Analyse, niemals WAV/MP3-Bytes.** Alle
Audio-Objekte werden nach Analyse freigegeben.

---

## 13. UI/UX

Skizze:

```text
SAMPLEMAP
Search...

[Drums]
  Kick
  Snare
  Clap
  Hat
  Percussion

[Musical]
  Bass
  Synth
  Piano
  Guitar

[Other]
  Vocal
  FX
  Loop
  Other

----------------------------------------
Results

▶ Hard Kick 01
  Kick 98%
  0.42 sec

▶ Deep Kick
  Kick 96%
  0.51 sec

▶ ...
[ ] [ ] [ ]

        Send to Machiniste
```

Prinzipien:
- **Schnell:** Filter-Änderung → sofortige IndexedDB-Query; keine Audio-Blockierung.
- **Übersichtlich:** Kategorien als akkordeonartig aufklappbare Gruppen; Suchergebnisse
  als kompakte Zeilen mit Klassen-Chi und Konfidenz.
- **Preview:** Play-Button je Zeile (nicht-blockierend, begrenzte Parallelität).
- **Multi-Select:** Checkboxen; unten „Send to Machiniste".
- **Status:** Fortschritt der Analyse-Job-Queue sichtbar (analysiert/geplant/fehlerhaft).

---

## 14. Permissions / Rechte

Ohne API-Umgehung, basierend auf dem, was Nexus erlaubt:

| Aktion | Voraussetzung / Nexus-Regel |
|--------|------------------------------|
| `samples.list` | OAuth-Scope für Sample-Zugriff |
| `samples.get` / preview / download | `public` ok; `unlisted` nur mit Link/Recht; fremde private nicht |
| Projekt öffnen (`client.open`) | Projekt-Rechte des angemeldeten Users |
| Machiniste erzeugen/ändern | Schreibrecht auf das Projekt (`project:write`) |
| Gain-/Effekt-Plugins setzen | Projekt-Schreibrecht |
| Direkte Sample-Referenz auf fremdes öffentliches Sample | im POC verifiziert (funktioniert) |

Zu klärende Punkte:
- Genauer Umfang der benötigten OAuth-Scopes (aktuell `project:write` für den
  Machiniste-Test).
- Wie `unlisted`-Samples aussehen und ob Klassifikation sie anfassen darf.
- Wie private/eigene Samples des Nutzers im Index behandelt werden (inkl. eigener
  Upload-Berechtigung).
- Welche Aktionen Nexus **nicht** erlaubt (z. B. fremde Projekte ändern) — strikt
  beachten, keine Umgehung.

---

## 15. Fehlerbehandlung

- **Rate-Limit / 429:** exponentielles Backoff + Jitter; Concurrency-Regler.
- **Netzwerkfehler:** Retry mit max. Versuchen; danach `status=failed`.
- **Transaction-Rejection (Nexus):** exakter Fehlerstring dokumentieren;
  `MachinisteService` gibt strukturierte `errors[]` zurück (bereits im POC).
- **Sample verschwunden:** `get`/`download` schlägt fehl → `status=gone`.
- **Analyse eines einzelnen Samples schlägt fehl:** nie die ganze Queue stoppen;
  markieren, weiter.
- **Parse/Format-Fehler:** pro Sample isoliert fangen (kein Cross-Sample-Crash).
- **ObjectURL-Leak:** zentraler Preview-Pool mit explizitem revoke.

---

## 16. V1 Scope — Was MUSS funktionieren

1. OAuth-Login (Browser) + `samples.list` paginiert.
2. **IndexedDB-Index** ohne Audio (Metadaten + Analyseergebnisse + Queue-State +
   optional Embeddings). **Invariante §1.1: nie Audio-Bytes persistieren.**
3. **`Classifier`-Interface** (§7.2) mit einer ersten austauschbaren Implementierung
   (Heuristik und/oder passendes vortrainiertes Modell; CNN erst, wenn Datensatz
   vorliegt) und Output `{primaryClass, confidence, secondaryClasses[]}`.
4. **Strikte Trennung** `originalTags` (Audiotool, Zusatzinfo) vs.
   `primaryClass/confidence/secondaryClasses` (SampleMap, nie Tags als Wahrheit).
5. **V1-Feature-Extraktion** (die als „Ja" markierten, §6).
6. **Analyse-Pipeline im Worker:** temporärer Fetch → decode → analysieren →
   Index-Upsert → Audio freigeben. **Kein permanenter Audio-Storage.**
7. **Inkrementelle, pausierbare Analysejobs:** Idempotenz (`sampleId+analysisBuild`),
   Resume (Queue in IndexedDB), Retry mit Backoff; **nicht** Voll-Library-in-einer-Sitzung.
8. **Kontrollierter Analysemodus:** `Analyse 10 / 100 / 1000 neue Samples` —
   festes Budget pro Lauf, automatischer Stopp, weiter mit höherem Budget ohne Re-
   Analyse.
9. **Suche/Filter:** Kategorien + Textsuche + Konfidenz-Sortierung.
10. **Preview** direkt aus Audiotool (begrenzte Parallelität, ObjectURL-Hygiene).
11. **MachinisteService (§10):** mehrere Samples → mehrere Slots in **einer**
    Transaction, begrenzte Concurrency (`MAX_BATCH_SLOTS`), danach Read-Back pro
    Slot (direkte Referenz, ohne Download/Upload).
12. **UI** laut §13 (Browser, Filter, Results, Preview, Multi-Select, Status, „Send to
    Machiniste", Analysemodus-Budget).
13. **Fehlerhandling** laut §15.

---

## 17. V2 Scope — Sinnvoll, aber nicht notwendig für V1

- „Find Similar" (Embeddings + ANN) — Architekturplatz (`embedding`) vorhanden.
- BPM-Schätzung, `decay`, `estimatedPitch`, `tonalNoiseRatio` verfeinern.
- Feature-basierte Filter (duration-/BPM-/Loudness-Bereiche) in der Suche.
- Eigene-Samples-Verwaltung (Upload aus Audiotool) inkl. Rechte-Differenzierung.
- Server-Analyse-Worker (erster Ausbau) — Skalierung für >10k Audio-Samples.
- Batch-Auswahl-Machinistes mit Slot-Vorschau (Auto-Mapping-Heuristik).

---

## 18. V3 Scope — Fortgeschrittene Funktionen (später)

- Voll serverseitige Analyse-Infrastruktur für die komplette Library (Mio. Samples).
- On-the-fly-Modell-Updates inkl. Reklassifikation (`analysisVersion`-Trigger).
- Kollaboration: geteilte Indizes/Playlists, kuratierte Sammlungen.
- Automatisiertes Slot-Mapping (KI schlägt passende Slots vor).
- Qualitäts-/Mischheuristik (z. B. „dieser Kick druckt mehr").
- Mangement von Duplikaten über Ähnlichkeit.

---

## 19. Offene technische Fragen

1. **Backend-Akzeptanz von Fremd-Referenzen bei mehreren Samples/parallelen
   Transaktionen** stabil? (ein Sample verifiziert; Multi-Slot noch ungetestet)
2. **`uploadStartTime`**-Semantik für reine Referenz-Samples (aktuell `0n`).
3. Welche **Nexus-Scopes** sind nötig, um Sample-Referenz + Projekt-Änderung in der
   echten App sauber zu trennen (Least-Privilege)?
4. Wie verhält sich `samples.list` bei sehr großer Library — gibt es
   **Filterparameter** (owner, visibility, tag, updatedAfter) oder müssen wir
   clientseitig filtern?
5. Liefert `download(..., "preview")` genug Auflösung für die KI, oder brauchen
   wir WAV? (Preview-MP3-Only-Option für Skalierung)
6. **Modell-Framework** im Browser (ONNX/WebGPU/TensorFlow.js) und dessen
   Speicher-/GPU-Verhalten — **offen**; über das `Classifier`-Interface gekapselt
   (§7.2), entscheiden wir erst, wenn eine trainierte/vortrainierte Implementierung
   gewählt wird. V1 beginnt mit dem Framework-unabhängigen `HeuristicClassifier`.
7. Wie zählt/wie viele eigene vs. fremde Samples der angemeldete User sehen darf.
8. Ist ein **Projekt-Schreibzugriff** für jede Machiniste-Aktion nötig, oder reicht
   ein separater Scope?
9. Verhalten bei **zerstörten/fehlerhaften Audiodateien** — Fehlercodes im Backend?

---

## 20. Konkrete nächste Implementierungsschritte (Reihenfolge)

> **Noch NICHTS implementieren.** Erst nach Review dieser Spec.

### 20.1 Module-Übersicht (Verzeichnis `src/`)

```text
src/
  persistence/
    elasticdb.ts        // IndexedDB-Schicht: Schema(v), CRUD, Transaktionen
    indexStore.ts       // SampleIndexRecord Speichern/Lesen/Query
    queueStore.ts       // Analyse-Job-Queue (nur State, kein Audio)
  library/
    libraryScanner.ts   // Pagination (nextPageToken), delta-scan, latestKnown
    sampleRef.ts        // AudiotoolSampleReference (sample.name → sampleName)
  audio/
    audioFetcher.ts     // temporärer Fetch + decode + Freigabe (Worker)
    featureExtractor.ts // §6-Features
  classify/
    classifier.ts       // Classifier-Interface (Vertrag, austauschbar)
    heuristicClassifier.ts // V1-Fallback-Implementierung
    registry.ts         // Classifier-Registrierung nach id/version
  pipeline/
    analysisPipeline.ts // fetch → decode → features → classify → index → dispose
    jobRunner.ts        // Inkrem. pausierbare/ resumable Jobs, Budget, Retry
  search/
    searchEngine.ts     // Kategorien-Filter + Textsuche + Konfidenz-Sortierung
  machiniste/
    machinisteService.ts // direkte Referenz → Multi-Sample → Multi-Slot, 1 Transaction
  preview/
    previewService.ts   // Preview-Pool, Concurrency, ObjectURL-Hygiene
  ui/
    (Browser-Komponenten laut §13)
```

### 20.2 Schrittfolge

1. **Review & Freigabe** dieser Spec.
2. **IndexedDB-Schicht**: `elasticdb` (Schema-Versionierung, Migration) +
   `indexStore`/`queueStore` (kein Audio). Tests: CRUD, Schema-Migration, Query,
   Nachweis „keine Audio-Bytes gespeichert" (persistenzreiner Vertrag).
3. **Library-Scanner**: `libraryScanner` auf Basis des vorhandenen
   `listSamplesPageByPage` — Pagination, delta-scan (nur Neue/Geänderte), `latestKnown`.
   Tests: Pagination, Delta, Abwesenheit von `error`-Objekten.
4. **AudiotoolSampleReference**: `sampleRef` — Mapping `SampleMeta → sampleName`
   (`samples/{uuid}`). Tests: Mapping, Fehlerfälle.
5. **PreviewService**: Preview-Pool, `MAX_PREVIEW_CONCURRENCY`, ObjectURL-Revoke.
   Tests: Parallelitäts-Regler, Revoke ohne Leak.
6. **Feature-Extractor** (Worker): §6-V1-Features + Schnittstellen-Vertrag.
   Tests: deterministische Ausgabe auf synthetischen Audiopuffern.
7. **`Classifier`-Interface + erste Implementierung**:
   - Definiert `Classifier` (Interface, §7.2) + `registry`.
   - V1-Implementierung: **`HeuristicClassifier`** (Feature-Heuristik) als solider
     Fallback; ein passendes vortrainiertes Modell nur falls ohne Trainingsaufwand.
     *Kein* CNN in V1-Implementierung zwingend; Modell ist austauschbar.
   - Tests: Interface-Kontrakt, Registry-Austausch, Heuristik-Grenzfälle,
     Output-Form (confidence 0..1, secondary geordnet), Idempotenz via `id/version`.
8. **AnalysisPipeline + JobRunner** (Worker): fetch → decode → features+classify →
   index → dispose; **Queue + Idempotenz + Resume + Retry;** **Budget-Modus
   `10/100/1000`; Pause/Resume.** Tests (offline, synthetische Samples):
   Idempotenz (kein Doppel-Lauf bei gleicher `analysisBuild`), Resume nach Abbruch,
   Retry/Backoff, Budget-Stopp, Freigabe (keine Audio-Referenz nach Job).
9. **SearchEngine**: Kategorien-Filter + Textsuche + Konfidenz-Sortierung, read-only
   gegen Index. Tests: Filter/Suche/Sortierung, Trennung Tags vs. Klasse.
10. **MachinisteService**: `AudiotoolSampleReference → MachinisteService → Sample
    Entity → MachinisteChannel.sample`; **Multi-Sample → Multi-Slot in einer
    Transaction**, `MAX_BATCH_SLOTS`-Begrenzung, Read-Back pro Slot. Tests (offline,
    WASM-Validator): 8-Samples → 8-Slots, Read-Back-Match, Transaction-Ablehnung,
    Interfaces.
11. **UI**: Browser, Kategorien, Results, Preview, Multi-Select, Status,
    Analysemodus-Budget, „Send to Machiniste".
12. **End-to-End (Realtest)**: gegen ein echtes Projekt; mehrere Samples → Machiniste;
    in Audiotool prüfen.
13. **Doku aktualisieren** (diese Spec → Implementierungsstatus).

**Tests jederzeit:** `npm run test`, `npx tsc --noEmit`, `npm run build`.

### 20.3 Test-Invarianten (Querschnitt)

- **Kein Audio in IndexedDB**: es existiert kein Storage-Pfad, der `Blob`/`AudioBuffer`
  persistiert; per Test/Review abgesichert (§1.1).
- **Idempotenz**: gleicher `(sampleId, analysisBuild)` führt max. 1 Analyse aus.
- **Austauschbarkeit**: UI/Pipeline hängt nur am `Classifier`-Interface und an
  Services — keine hartkodierten Modell-Abhängigkeiten.
