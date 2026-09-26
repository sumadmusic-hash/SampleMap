# SAMPLEMAP V1 — STATUS

**Projekt:** SampleMap V1 — lokale, durchsuchbare Sample-Library-Metadaten + Machiniste-Integration
**SDK:** `@audiotool/nexus@0.0.17`
**Stand:** Abschluss Step 13 (Dokumentation)
**Grundlage:** `SAMPLEMAP_V1_SPEC.md`

Dieses Dokument beschreibt ausschließlich den **tatsächlich implementierten und beobachteten**
Codezustand. Es behauptet keine reale Audiotool-/Backend-Integration, die nicht tatsächlich
ausgeführt wurde.

---

## A — Executive Summary

**Was ist SampleMap?**
SampleMap ist eine lokale (Browser-/IndexedDB-)Anwendung, die Audiotool-Library-Samples
auflistet, ihre Audio-Features extrahiert, sie heuristisch klassifiziert, die Ergebnisse
durchsuchbar macht und auserwählte Samples über direkte Referenzen in einen Machiniste lädt.

**Welches Problem löst es?**
Audiotool bietet eine große Sample-Library, aber keine strukturierte, durchsuchbare und
klassifizierbare lokale Sicht darauf — und vor allem kein Interface, um ein vorhandenes
Library-Sample (auch eines fremden Users) ohne Download/Re-Upload direkt in einen Machiniste
zu laden. SampleMap adressiert diese beiden Punkte.

**Was wurde in V1 tatsächlich implementiert?**
Der komplette Offline-/Architektur-Pfad mit echten, unit-getesteten Modulen:

- IndexedDB-Persistenzschicht (`ElasticDB`, Schema v2) mit `IndexStore` + `QueueStore`
- `LibraryScanner` (Pagination, Delta-Scan, `latestKnown`)
- `AudiotoolSampleReference` / `sampleRef` (kanonischer Name `samples/{uuid}`)
- `FeatureExtractor` (V1-Features aus PCM)
- `Classifier`-Interface + `HeuristicClassifier` (V1-Fallback) + `ClassifierRegistry` + `taxonomy`
- `AnalysisPipeline` + `JobRunner` (Budget 10/100/1000, Pause/Resume, Retry/Backoff, Idempotenz, Crash-Recovery, Fehlerisolation)
- `SearchEngine` (read-only, Name/Tag/Owner/Klasse/Gruppe/Confidence/Status/Sort/Limit)
- `PreviewService` (bounded concurrency, ObjectURL-Hygiene/LRU)
- `SampleMapMachinisteService` (Single-/Multi-Sample → Multi-Slot, 1 Transaction, `MAX_BATCH_SLOTS=8`, Read-Back)
- UI (DOM-freier Controller + View-Models + dünner DOM-Renderer + Browser-Bootstrap)
- Offline-E2E-Chain-Test (`src/e2e/chain.offline-e2e.test.ts`)

**Was ist noch offen?**
Ein **authentifizierter Realtest** wurde am 02.09.2026 mit `AT_PAT` gegen das echte
Audiotool-/Nexus-Backend **ausgeführt** (§4): echter Library-Zugriff, Sample-Fetch,
Audio-Download, Decode, Feature-Extraktion, Klassifikation und — entscheidend — die
direkte **`samples/{uuid}`-Referenz eines fremden Samples im Machiniste ohne erneuten
Audio-Upload** sind damit **verifiziert** (PASS). Bewusst offen bleiben nur die reinen
**Browser-/headless-bedingten** Teile: IndexedDB-**Persistenz** und **Preview**
(kein Browser in dieser Umgebung).

**Was wurde bewusst NICHT behauptet?**
Es wird kein Ergebnis erfunden oder simuliert. Verbleibende browser-only-Punkte (Persistenz,
Preview) werden als **NOT VERIFIED** geführt — nicht als PASS/FAIL. Die Offline-Kette nutzt
den lokalen Nexus-WASM-**Offline**-Validator; die echten Backend-Aussagen stammen aus dem
ausgeführten PAT-Realtest.

---

## B — Architektur

Die tatsächliche, im Code vorhandene Daten-/Steuerfluss-Struktur:

```text
Audiotool Library
       │            (nur über Client-API `client.samples.*`; real NICHT verifiziert)
       ▼
LibraryScanner  ──────────── injectierte `PageFetcher` + `KnownProvider`
       │
       ▼
AudiotoolSampleReference (sampleRef / samples/{uuid})
       │
       ▼
QueueStore  (IndexedDB: jobs — nur Metadaten, kein Audio)
       │
       ▼
JobRunner (Budget 10/100/1000, Pause/Resume, Retry/Backoff, Idempotenz, Recovery)
       │
       ▼
AnalysisPipeline
       ├── Fetch          (injectierte `fetchAudio` — transient)
       ├── Decode         (injectierte `AudioDecoder`)
       ├── Feature Extraction  (REAL `extractFeatures`)
       ├── Classification      (REAL `HeuristicClassifier` via `Classifier`-Interface)
       └── Index Persistence   (IndexStore.put; `assertNoAudioBytes`)
                 │
                 ▼
             IndexStore  (IndexedDB: samples — nur Metadaten + Analyse)
                 │
          ┌──────┴──────┐
          ▼             ▼
    SearchEngine   PreviewService
          │
          ▼
  SampleMapMachinisteService
          │
          ▼
      Machiniste (Nexus Document Channel.sample)
```

**Wichtig — tatsächliche Kopplung:**

- Der **Fetch**- und **Decode**-Schritt sind **abstrahiert/injiziert**. Die Browser-Echt-
  Implementierungen (`browserFetchAudio` mit `fetch`, `browserDecode` mit Web Audio
  `AudioContext.decodeAudioData`) existieren in `src/ui/bootstrap.ts`, werden aber von den
  automatisierten Tests **nicht** ausgeführt (sie benötigen einen echten, authentifizierten
  Browser-Kontext; NICHT VERIFIERT). Die Tests treiben die Pipeline mit injizierten Fakes.
- Der **Classifier** hängt nur am stabilen `Classifier`-Interface; V1 nutzt den
  `HeuristicClassifier`. Ein anderes Modell ist über die `ClassifierRegistry` austauschbar.
- **SearchEngine** ist strikt read-only gegen `IndexStore.getAll()`.
- **PreviewService** ist über `fetchFn`/`blobUrl` injizierbar; Browser-Netzwerk/Object-URL
  werden in Tests durch Fakes ersetzt.
- **Machiniste**: Die Offline-Tests (inkl. Offline-E2E) verwenden die **echte**
  `createOfflineDocument` von `@audiotool/nexus/node` (lokaler Nexus-WASM-Validator). Der
  **reale** Backend-/Sync-Transport wird **nicht** berührt.

---

## 3 — Implementierungsstatus

| Step | Bereich                      | Status                 | Nachweis |
| ---- | ---------------------------- | ---------------------- | -------- |
| 1    | Spec Review/Freigabe         | DONE                   | `SAMPLEMAP_V1_SPEC.md`, `SAMPLE_ACCESS_POC.md` |
| 2    | IndexedDB                    | DONE                   | `src/persistence/*`, `db.test.ts`, `elasticdb.test.ts`, `indexStore.test.ts`, `queueStore.test.ts` |
| 3    | Library Scanner              | DONE                   | `src/library/libraryScanner.test.ts` (6) |
| 4    | Sample Reference             | DONE                   | `src/library/sampleRef.test.ts` (7) |
| 5    | Preview                      | DONE                   | `src/preview/previewService.test.ts` (8) |
| 6    | Feature Extraction           | DONE                   | `src/audio/featureExtractor.test.ts` (8) |
| 7    | Classifier                   | DONE                   | `src/classify/classifier.test.ts` (8) |
| 8    | AnalysisPipeline + JobRunner | DONE                   | `analysisPipeline.test.ts` (12), `jobRunner.test.ts` (11) |
| 9    | SearchEngine                 | DONE                   | `src/search/searchEngine.test.ts` (19) |
| 10   | MachinisteService            | DONE                   | `machiniste.test.ts` (6), `machinisteService.test.ts` (14), offline-WASM |
| 11   | UI                           | DONE                   | `src/ui/app.test.ts` (26), `view.test.ts` (9) |
| 12   | E2E / Realtest               | **PARTIAL — backend-Teile VERIFIED** | Offline-E2E grün (`chain.offline-e2e.test.ts`, 2); **echter Realtest ausgeführt** (PAT, §4) — Backend-Hypothese `samples/{uuid}` bestätigt; browser-only-Teile (IndexedDB-Persistenz, Preview) bleiben NOT VERIFIED (headless) |
| 13   | Documentation                | DONE                   | dieses Dokument |

---

## 4 — Realtest-Status (besonders deutlich)

### Offline verifiziert

Die Offline-Kette wurde erfolgreich mit **synthetischen** Audiodaten getestet (Unit-Tests +
`src/e2e/chain.offline-e2e.test.ts`):

```text
scanLibrary
→ sampleRef
→ QueueStore
→ JobRunner
→ AnalysisPipeline
→ FeatureExtractor  (REAL)
→ HeuristicClassifier (REAL)
→ IndexStore
→ SearchEngine
→ MachinisteService (offline WASM-Dokument)
→ Read-Back
```

### Nicht verifiziert / bewusst offen

Folgende Punkte wurden **NICHT** gegen ein echtes Audiotool-Backend / echten Browser verifiziert:

- echte **Persistenz** (IndexedDB) — erfordert Browser; headless nicht möglich
- echte **Preview** — erfordert Browser-`ObjectURL`-Lifecycle; headless nicht möglich
- OAuth-Interaktiver Browser-Login — stattdessen wurde **PAT**-Authentifizierung verifiziert

> ~~Es wurde NICHT verifiziert, dass `samples/{uuid}` eines fremden Audiotool-Library-Samples
> vom realen Machiniste-Backend ohne erneuten Audio-Upload akzeptiert wird.~~
>
> **ZUSATZ (Realtest am 02.09.2026):** Diese kritische Hypothese wurde inzwischen **verifiziert** —
> siehe §4 „Realtest ausgeführt“ direkt unten. Sie wird nicht mehr als offen geführt.

**Blocker für die restlichen Punkte:** headless ohne Browser (kein Chromium/Playwright) →
IndexedDB-Persistenz und Preview können nicht gegen echten Browser-Code ausgeführt werden.
Diese werden bewusst als NOT VERIFIED (nicht als PASS/FAIL) geführt, **ohne** Fake-Simulation.

### Realtest ausgeführt (PAT, echtes Audiotool-Backend, 02.09.2026)

Mit `AT_PAT` (hinterlegt in `.env`, gitignored) und den Nexus-`ProjectService`-/`SampleService`-/
`SyncedDocument`-Endpunkten wurden folgende echte Tests ausgeführt:

| Realtest-Punkt                                  | Ergebnis  | Beleg |
| ---------------------------------------------- | --------- | ----- |
| Authentifizierung (PAT)                        | **PASS**  | `client created (auth accepted at construction)` |
| Echte Library-Liste                            | **PASS**  | 20 reale Samples (inkl. fremder `users/*`-Samples) |
| Sample-Metadaten (get)                         | **PASS**  | Flume Tennis Snare, korrekte URLs/Tags/Dauer |
| Audio-Download                                 | **PASS**  | 113881 Bytes echter WAV (44100 Hz, 16 bit, 2ch) |
| Decode (reale Bytes)                           | **PASS**  | PCM geparst (28452 Frames, 0.645 s) |
| Feature-Extraktion (reale Bytes)               | **PASS**  | `extractFeatures` (real, lokal) auf echtem PCM |
| Klassifikation (reale Bytes)                   | **PASS**  | `HeuristicClassifier` → `openhat` (0.32) |
| Suche                                          | **PASS**  | `SampleMapSearchEngine` (real, read-only) über realem Index |
| Sample-Referenz im Machiniste (`samples/{uuid}`, fremdes Sample, **kein Re-Upload**) | **PASS** | `directReferenceApplied:true`, `readBackMatches:true`, `created:true`, `errors:[]` |
| Multi-Slot (3 fremde Samples → 1 Dokument)     | **PASS**  | alle Slots `readBack=true`; Projekt create→open→modify→delete |
| Read-Back gegen echtes Backend                 | **PASS**  | Kanal-Sample-Entity stimmt nach Commit überein |
| Persistenz (IndexedDB)                         | NOT VERIFIED | browser-only (headless) |
| Preview                                        | NOT VERIFIED | browser-only (headless) |

> **Kernaussage:** Der reale Machiniste/Nexus-Backend akzeptiert die direkte Referenz
> `samples/{uuid}` eines **fremden, öffentlichen** Library-Samples **ohne erneuten
> Audio-Upload** — `directReferenceApplied:true`, `readBackMatches:true`, `errors:[]`.
> Damit ist die in der Spec (§8 Schritt 8) und in den POCs gestellte Schlüsselfrage
> positiv beantwortet.
>
> Die Ausführung erfolgte gegen von der Probe **selbst erzeugte und danach gelöschte**
> Test-Projekte; es wurden keine fremden/fremd-existierenden Projekte mutiert. Es wurde
> kein Ergebnis erfunden, simuliert oder abgeschwächt.

---

## 5 — Harte Invarianten

| Invariante                      | Status       | Nachweis |
| ------------------------------- | ------------ | -------- |
| Kein Audio in IndexedDB         | VERIFIED     | Guards (`assertNoAudioBytes`) + `indexStore.test.ts` + E2E |
| Audio nur transient             | VERIFIED     | `AnalysisPipeline` (Audio nur in lokalen Variablen) + Tests |
| Release auf Fehlerpfaden        | VERIFIED     | `finally` in `pipeline.run` (alle Pfade) + Tests |
| Idempotenz                      | VERIFIED     | Queue-/Pipeline-Tests (gleicher `(sampleId, analysisBuild)` → skip) |
| Pause/Resume                    | VERIFIED     | `jobRunner.test.ts` |
| Crash-Recovery                  | VERIFIED     | `recoverStuckProcessing` + Tests |
| Fehlerisolation                 | VERIFIED     | Queue/Runner-Tests (fehlender Sample blockt Queue nicht) |
| Budget 10/100/1000              | VERIFIED     | `jobRunner.test.ts`, `ui/app.test.ts` |
| Tags ≠ Klassifikation           | VERIFIED     | `indexStore`/`view`-Tests (`originalTags` getrennt von Klasse) |
| SearchEngine read-only          | VERIFIED     | `searchEngine.test.ts` (keine Mutation) |
| Machiniste zentrale Integration | VERIFIED     | `SampleMapMachinisteService` als einzige Stelle, Service-Tests |
| Echter Backend-Zugriff          | VERIFIED     | PAT-Realtest (§4): Library, Download, Machiniste-`samples/{uuid}`-Direktreferenz |

---

## 6 — Persistenzmodell

**Backend:** IndexedDB über `ElasticDB` (`src/persistence/elasticdb.ts`), zentraler Schema-
Aufbau in `src/persistence/db.ts`.

- **Schema-Version:** `SCHEMA_VERSION = 2` (v1→v2 ergänzt den `owner`-Index auf `samples`).
- **Store `samples`** (`IndexStore`): Schlüssel `sampleId`. Persistiert werden ausschließlich
  Metadaten + Analyseergebnisse:
  `sampleId`, `owner`, `visibility`, `name`, `kind`, `originalTags`, `primaryClass`,
  `confidence`, `secondaryClasses`, `classificationVersion`, `audioFeatures`,
  `analysisVersion`, `analyzedAt`, `analysisBuild`, `status`.
- **Store `jobs`** (`QueueStore`): Schlüssel `sampleId`. Persistiert wird der Job-Status:
  `sampleId`, `status`, `analysisBuild`, `attempts`, `error`, `createdAt`, `updatedAt`,
  `nextRetryAt`.

**Explizit NIE als Sample-Audio persistiert** (durch die Guards `assertNoAudioBytes` in
`IndexStore.put` und `QueueStore.write` sowie durch Tests abgesichert):

```text
Audio bytes
AudioBuffer
Blob
ArrayBuffer
TypedArray
```

Sound-Daten existieren ausschließlich transient im Analyse-/Preview-Pfad im Speicher.

**Embeddings:** Das Feld `embedding` ist im Typ als optionales `Float32Array` vorgesehen
(Label-Embedding, kein Audio). Es ist **keine aktive Implementierung** vorhanden, die
Embeddings berechnet — es wird kein solches Verhalten behauptet.

---

## 7 — Klassifikation

Kontrakt (`src/classify/classifier.ts`):

```text
Classifier
├── id          (stabile Modell-ID, z. B. "heuristic")
├── version     (Modellversion, z. B. "heuristic-v1")
└── classify(features) → ClassOutput
        ClassOutput = { primaryClass, confidence, secondaryClasses[] }
```

- **`HeuristicClassifier`** (`src/classify/heuristicClassifier.ts`) ist die V1-
  Fallback-Implementierung: deterministische Feature-Regeln, umgesetzt in eine
  Wahrscheinlichkeitsverteilung (Softmax über die Top-Kandidaten der Taxonomie).
- **`ClassifierRegistry`** macht das Modell **austauschbar**; ein neu registriertes Modell
  (z. B. ein kleines CNN) ist ein Drop-In via `id`/`version`.
- **Taxonomie** (`taxonomy.ts`): Gruppen `drums`/`musical`/`other`.

**Trennung (Invariante §5/Tags ≠ Klassifikation):**

```text
originalTags        (Audiotool-Tags, unverändert übernommen)
        ≠
primaryClass        (SampleMap-Klassenlabel)
confidence
secondaryClasses
```

`originalTags` werden nie als Ground-Truth für die Klasse verwendet und getrennt
gespeichert/angezeigt.

**Ehrliche Einordnung:** `confidence` ist eine **heuristische Klassifikations-Score-Darstellung
(Softmax über regelbasierte Scores)**, keine empirisch kalibrierte Modellwahrscheinlichkeit.
Die V1-Implementierung ist bewusst ein schlanker, deterministischer Fallback — kein CNN ist
in V1 Vorgabe.

---

## 8 — Queue / Analyse

`AnalysisPipeline` (pro Job) + `JobRunner` (Kontrolle) implementieren:

- **Inkrementelle Jobs:** Die Queue verarbeitet Samples sequenziell (Concurrency = 1, spec §5.1).
- **Controlled Budgets:** `10 / 100 / 1000` neue Analysen pro Lauf; danach sauberer Stopp
  (`stoppedReason = "budget"`). Ein späterer, höher-budgetierter Lauf setzt am persistierten
  Zustand an.
- **Pause / Resume:** ohne Job-Verlust; persisted Queue-Zustand → Resume setzt fort.
- **Retry / Backoff / maxAttempts:** fehlgeschlagene Jobs werden mit Backoff erneut fällig,
  bis `maxAttempts` erreicht ist.
- **Idempotenz:** gleicher `(sampleId, analysisBuild)` führt max. 1 Analyse aus (Pipeline-Skip
  + Queue-State).
- **Crash-Recovery:** beim Start werden hängende `processing`-Jobs neu in `queued` überführt.
- **Fehlerisolation:** ein fehlendes/fehlschlagendes Sample markiert nur seinen Job, nie den
  ganzen Lauf.
- **Concurrency-Limit:** 1 (bewusst einfach für die browser-residente Analyse).

**Wichtig:** V1 ist **nicht** darauf ausgelegt, die komplette Library in einer einzigen Sitzung
zu analysieren. Die kontrollierten Budgets + `scanMaxSamples` (200) begrenzen Aufwand.

---

## 9 — SearchEngine

`SampleMapSearchEngine` (`src/search/searchEngine.ts`) — read-only, deterministisch:

- **Name, Tags, Owner:** Textsuche über diese Felder (Token, case-insensitive, AND-Semantik).
- **Klassen:** Filter über `primaryClass` **oder** beliebige `secondaryClass` (OR bei Mehrfachwahl).
- **Taxonomiegruppen:** `drums` / `musical` / `other` werden zu ihren Mitgliedsklassen expandiert.
- **Confidence:** optionaler `minConfidence`-Filter (0..1, primär).
- **Status:** Standardmäßig `analyzed`; andere Status nur auf explizite Anfrage.
- **Sortierung:** `relevance` (Standard) | `confidence` | `name` | `analyzedAt`, Richtung asc/desc.
- **Limit:** `query.limit` begrenzt die Zahl der Ergebnisse.
- **Deterministisch:** totale Comparator inkl. stabiler `sampleId`-Tiebreaker → identischer
  Index + Query ergibt identische Reihenfolge.

**V1-Einschränkung:** Die SearchEngine lädt den Index über `getAll()` in den Speicher und
filtert/sortiert dort. Das ist für die kontrollierten V1-Analysebudgets ausreichend, aber für
sehr große Libraries ein möglicher V2-Optimierungspunkt.

---

## 10 — Machiniste-Integration

Tatsächlicher Ablauf (offline per `createOfflineDocument`/WASM belegt):

```text
SampleMap
   ↓
AudiotoolSampleReference   (samples/{uuid})
   ↓
SampleMapMachinisteService
   ↓
Sample Entity              (document-lokal, sampleName = samples/{uuid})
   ↓
MachinisteChannel.sample   (NexusLocation-Property, zeigt auf die Sample-Entity)
```

Eigenschaften (`src/machiniste/machinisteService.ts`):

- **Single Sample:** ein Sample → ein Slot.
- **Multi-Sample / Multi-Slot:** `samples[i] → slots[i]`.
- **Eine Transaction:** alle Slots werden in **einem** `commit`/`modify` geschrieben
  (all-or-nothing).
- **`MAX_BATCH_SLOTS = 8`:** mehr als 8 Samples pro `send()` wird vorab abgelehnt.
- **Read-Back:** nach Commit wird pro Slot der Zeiger + die Entity ausgelesen und gegen das
  Erwartete geprüft (`readBackMatches`).
- **Strukturierte Fehler:** pro Slot (`errors[]`) und global (`errors[]`, `committed`).
  Spezialfehler: `MachinisteNotFoundError`, `MachinisteValidationError`.

> **Offline/WASM erfolgreich geprüft; echtes Backend verifiziert (02.09.2026).** Der reale
> Server akzeptiert den fremden `sampleName` (`samples/{uuid}`) eines öffentlichen Samples
> **ohne Upload** — PAT-Realtest, `directReferenceApplied:true`, `readBackMatches:true` (§4).
> Multi-Slot (3 fremde Samples → 1 Dokument) ebenfalls verifiziert.

---

## 11 — Teststatus (tatsächlich zuletzt ausgeführt)

Ausgeführt (exakt dieser Stand):

```text
npm run test        → 18 Dateien, 191 Tests — alle grün
npx tsc --noEmit    → fehlerfrei
npm run build       → erfolgreich (nur bekannte Chunk-Warnung >500 kB)
```

Testverteilung:

- `sample-api.test.ts` 26 · `ui/app.test.ts` 26 · `searchEngine.test.ts` 19 ·
  `indexStore.test.ts` 15 · `machinisteService.test.ts` 14 · `analysisPipeline.test.ts` 12 ·
  `jobRunner.test.ts` 11 · `view.test.ts` 9 · `featureExtractor.test.ts` 8 ·
  `previewService.test.ts` 8 · `classifier.test.ts` 8 · `queueStore.test.ts` 7 ·
  `libraryScanner.test.ts` 6 · `machiniste.test.ts` 6 · `elasticdb.test.ts` 5 ·
  `sampleRef.test.ts` 7 · `db.test.ts` 2 · `e2e/chain.offline-e2e.test.ts` 2

**TypeScript:** clean.

**Build:** erfolgreich. Die verbleibende Warnung ist die bekannte Chunk-Größen-Warnung
(>500 kB) — das ist eine **Warnung**, kein Fehler.

---

## 12 — Bekannte Einschränkungen / V2

Nur Punkte, die durch den tatsächlichen Code bzw. die Spec begründet sind:

1. ~~Echter Audiotool-Realtest fehlt~~ — **ausgeführt** (§4 Realtest): PAT-Auth, Library,
   Download, Decode, Extract, Klassifikation und Machiniste-`samples/{uuid}`-Direktreferenz
   (fremdes Sample, kein Re-Upload) gegen das echte Backend verifiziert.
2. **Echte Persistenz & Preview** (IndexedDB / `ObjectURL`-Browser-Glue in `bootstrap.ts`)
   nicht real ausgeführt — headless-Umgebung; nur zu Kompilier-/Kopplungszeit bestätigt.
3. **Echte Sample-Reference → Machiniste** — **jetzt verifiziert** (§4): reales Backend
   akzeptiert `samples/{uuid}` eines fremden öffentlichen Samples ohne Audio-Upload.
4. **Performance großer Indizes:** SearchEngine `getAll()` im Speicher; für sehr große
   Libraries ein V2-Optimierungspunkt.
5. **Bessere Klassifikation:** `HeuristicClassifier` ist ein regelbasierter Fallback; ein
   vortrainiertes Modell/CNN ist per `ClassifierRegistry` möglich, aber nicht implementiert.
6. **Echte Browser/Worker-AudioFetcher-Integration:** Audio-Fetch/Decode ist injiziert;
   die echte Browser-Integration (`bootstrap.ts`) ist nicht automatisiert getestet.
7. **UI-/Browser-Glue-Realtest:** `render.ts`/`main.ts` sind dünner Browser-Glue ohne
   jsdom/headless-Test; der authentifizierte Live-Lauf (`mountAuthenticated`) ist manuell
   zu verifizieren.
8. **Code-Splitting-Optimierung:** die Build-Warnung >500 kB könnte durch
   `dynamic import()`/`manualChunks` adressiert werden (kosmetisch).

---

## 13 — Keine künstlichen Verbesserungen

Dieser Step hat **keine** Produktionslogik verändert und **keine** neuen Features, APIs,
Modelle oder Backend-Annahmen eingeführt. Es wurde kein Audio persistiert, nichts umgebaut,
kein Test gelöscht/abgeschwächt. Der Realtest (§4) wurde **real ausgeführt** (PAT, echte
Nexus-Endpunkte) und **nicht simuliert**; verbleibende browser-only-Teile (IndexedDB,
Preview) bleiben bewusst als NOT VERIFIED ausgewiesen.

---

## Abschluss-Checks

- Alle Tests grün: **ja** (191).
- TypeScript clean: **ja**.
- Build erfolgreich: **ja** (nur bekannte Chunk-Warnung).
- Keine Produktionslogik verändert: **ja** (nur `SAMPLEMAP_V1_STATUS.md` dokumentiert Realtest).
- Berechtigungen für PASS-Aussagen: **ja** (echter Realtest ausgeführt, nichts erfunden; Rest als NOT VERIFIED).
- Step 1–11 als DONE dokumentiert: **ja**.
- Step 12 als `PARTIAL` (backend-Teile VERIFIED, browser-Teile NOT VERIFIED) dokumentiert: **ja**.

```text
Step 1–11: DONE
Step 12: PARTIAL — Backend-Teile VERIFIED (Realtest bestanden); Persistenz/Preview NOT VERIFIED (headless)
Step 13: DONE
Step 14: PARTIAL — Browser-Verifikation unvollständig (echter Browser-Test ausgeführt; OAuth-Login BLOCKED)
```

---

# Step 14 — Browser Verify (02.09.2026)

## Durchgeführt (echter Browser)

Mit **Google Chrome (headless, 152.0.7977.65)** gegen `http://127.0.0.1:5176/` (Vite dev,
Port 5176 laut `vite.config.ts`; Redirect über `127.0.0.1`, nicht `localhost`):

- App lädt fehlerfrei: **keine unhandled exception**, **keine Auth-/Nexus-Fehler** in der
  Konsole (nur erwartete `[info]`-Logs: `Booting POC …`, `Not authenticated.`).
- Unauthentifizierter UI-Zustand korrekt: „Log in with Audiotool“-Button erscheint.
- OAuth-Verdrahtung real bestätigt: Klick auf Login redirectet korrekt auf
  `https://accounts.audiotool.com/login?login_challenge=…` (Audiotool-Sign-in-Seite).

## Blockiert (ehrlich, kein PASS)

- **Test A (Browser OAuth): BLOCKED.** Der reale Browser erreicht die echte Audiotool-
  Sign-in-Seite („Account / Password“). Die **manuelle Anmeldung** erfordert Benutzer-
  Zugangsdaten, die hier **nicht vorliegen** (nur ein `AT_PAT` für den CLI-/Backend-Pfad).
  Zugangsdaten werden **nicht erfunden**. Ohne Login bleibt die App im unauthentifizierten
  Zustand.
- **Tests B–I: BLOCKED.** Jeder dieser Tests setzt eine **authentifizierte Browser-Session**
  voraus, die ausschließlich über den (blockierten) OAuth-Login erreichbar ist. Die Doc/served
  Browser-Einstiegspunkte nutzen OAuth; der `AT_PAT` ist der Node-/CLI-Pfad (Step 12R) und
  wird **nicht** in eine Browser-Seite injiziert (kein neues Architektur-Feature, keine
  Umgehung des OAuth-Gates, kein Secret in served-Dateien).

Es wurden **keine Tests simuliert** und **keine Ergebnisse erfunden**. Nicht durchgeführte
Browser-Tests werden als BLOCKED gemeldet (siehe §4-Fehlerklassifikation), **niemals** als PASS.

## Fazit

Die **server-/backend-seitigen** Aussagen sind VERIFIED (Step 12R). Die **Browser-UI-Verifikation**
(B–I) ist wegen fehlender interaktiver Audiotool-Login-Zugangsdaten **nicht abgeschlossen**.
`SampleMap V1` wird daher **nicht** als „fully browser-verified“ deklariert.
