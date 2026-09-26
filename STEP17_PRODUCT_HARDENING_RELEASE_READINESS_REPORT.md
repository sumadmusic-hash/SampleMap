# STEP17 — Product Hardening & Release Readiness Report

**Projekt:** SampleMap (V1)
**Datum:** 2026-09-06
**Scope-Disziplin:** ausschließlich Produkt-Härtung & Release-Reife-Verifikation — keine
Feature-Neubauten, keine Architektur-Neu-Designs. Jede Verifikation unterscheidet
**REAL / MOCKED / FIXTURE / BLOCKED / NOT_TESTED**.

---

## §1 Verdict

| Verdict | Erlaubte Werte |
|---------|----------------|
| **PASS — EXTERNAL VERIFICATION BLOCKED** | ein von: PASS / PASS — EXTERNAL VERIFICATION BLOCKED / NOT READY / FAIL |

**Begründung (Kurzform):**
- Alle internen Release-Gates sind **PASS**: `tsc` 0 Fehler, Build PASS, App-Vitest
  **666/666**, Worker-Vitest **19/19**, Playwright-E2E **64/64**.
- Die im STEP17-Scope identifizierten echten Defekte wurden **gehärtet und belegt**
  (F1 Corrupt-Record-Read-Pfad, F2 Single-Frame-Analytik, F3–F5 Test-Verdichtung),
  inklusive neuer real-browser E2E-Verifikation (17C-01…17C-07).
- Extern verifizierbar ist nur der OFFLINE-Harness-Pfad. Die **Live-Schicht bleibt
  BLOCKED**: E-P7 (Human Layer-C closure, echter Audiotool-Send/Preview mit einwilligter
  Erstnutzung `§19.5-Einwilligung`), echtes OAuth/Live-Nexus (STEP16M-19, „Preview
  BLOCKED für synthetische Samples"). Diese Blocker sind **roadmap-definiert und
  kein interner Defekt** (siehe §13).

---

## §2 Scope, Methodik & Beweiskategorien

- **Scope:** Bestandsaufnahme → Baseline → Requirement-Traceability → E2E/Fehler/Recovery-
  Verifikation → Asset-Härtung bei echten Defekten/Lücken → Regressionslauf → Report.
- **Beweiskategorien:** jede Behauptung wird einer Kategorie zugeordnet:
  - **REAL** — echter Code, echter Browser, echte WebAudio-Decode, echte Queue.
  - **MOCKED** — Service-Seam durch Test-Double ersetzt (z. B. machiniste.send, fetchPage).
  - **FIXTURE** — deterministische Fixture-Daten (synthetische WAV/PCM), echter Codepfad.
  - **BLOCKED** — nicht in dieser Umgebung verifizierbar (Live-Schicht, externe Dienste).
  - **NOT_TESTED** — bewusst ungetesteter Codepfad (Browser-Netzwerk-Seam), dokumentiert.
- **Lesart Traceability (§7):** Quelle ist der Quellcode; Spec-Anker ist `SAMPLEMAP_V1_SPEC.md`.

---

## §3 Baseline (vor STEP17-Härtung)

| Gate | Baseline | Ergebnis |
|------|----------|----------|
| `tsc --noEmit` | 0 Fehler | PASS |
| `npm run build` | PASS; Main-Chunk 791.62 kB, nur Vite-Chunk-Warnung | PASS |
| App-Vitest (`npm test`) | 643/643 (33 Dateien) | PASS |
| Worker-Vitest (`workers/d1-worker`) | 19/19 (2 Dateien) | PASS |
| Playwright-E2E (`npm run test:e2e`) | 57/57 (11 Specs) | PASS |

---

## §4 Repo-Inventur (Auswahl)

- **Build/Tooling:** `package.json` (build=tsc+vite), `tsconfig`, `vite`, `playwright.config.ts`
  (Chrome via `channel: chrome`, baseURL localhost:5176, Linear-Serial-Läufe).
- **Umgebung:** `.env.example` → `VITE_AUDIOTOOL_CLIENT_ID`, `VITE_SAMPLE_SCOPE`,
  `VITE_GLOBAL_WORKER_URL` (getrennt generiert, ohne Secrets im Repo).
- **Worker:** `workers/d1-worker` (Wrangler, D1, Vitest 19 Tests), Global-Layer ~9 Module.
- **Scripts:** Analyse-/Live-Verify-Tools (`cli.ts` POC-Konsole).
- **Produktions-Entry:** `src/main.ts` → `mountLiveSampleMap` → `mountAuthenticated` →
  `buildBrowserDeps` (`src/ui/bootstrap.ts`) → `mountSampleMap` (`src/ui/render.ts`).
  Zweiter POC-Diagnostics-Pfad `runMachinisteTest` (`main.ts:361-467`) mit Console-Log-Button.
- **E2E-Verzeichnis:** `e2e/*.spec.ts` (Harness via `harness.html` → `src/e2e/harness/main.ts`,
  `window.__sm` Test-Hooks).

---

## §5 Read-Only Audits (abgeschlossen, kein Code geändert)

| # | Audit | Ergebnis | Gaps |
|---|-------|----------|------|
| A1 | **Audio-Lifecycle / No-Audio-Cache** | INVARIANT **HELD** — transienter Fetch
 (`bootstrap.ts:75-80`), `FetchedAudio.release()` zwingend (`analysisPipeline.ts:51-56`),
 `assertNoAudioBytes` auf jedem Store-Put (`indexStore.ts:143`), kein Audio in IndexedDB/D1,
 Preview revoke. | 2 Browser-Seams ohne Unit-Tests (s. §13) |
| A2 | **Index/Persistence** | Create/Update/Reload/Missing/Versioning **OK-TESTED** | **CORRUPT RECORD**: kein Read-Pfad-Validierung →
 **behoben F1** |
| A3 | **Analysis/Classification** | PCM-Gate deterministisch; Decode-Fehler terminal „skipped";
 Retry-State-Machine OK; Klassifikation total. | **1-Frame-Audio** crasht via `Float32Array(1.5)`
 (`featureExtractor.ts`, alt L197) → **behoben F2**; Release-im-Fehlerfall nur teil-testiert → **F3**; NaN/Infinit-Inputs ungetestet → **F5** |
| A4 | **Map/States/Error-Handling** | Map-Zustände (empty/one/many/dup/selection/zoom/pan/reload/Missing-V2),
 Loading/ERROR/EMPTY-State für scan/analysis/map/preview/findSimilar/machiniste **belegt**; dedup via
 contentHash (`mapView.ts:282-295`). | keine UI-Crash-Gaps im Hauptpfad; Fehlerbranchen
 `analysis.error` + `findSimilar`-Prereqs ungetestet → **F4b** |
| A5 | **Security/Performance-Sanity** | keine Secrets/Token in DB oder Logs; `console.*` nur in
 `cli.ts`/Logger; kein `Worker`/`setInterval` in prod; Env-Zugriffe beschränkt auf die 3 VITE-Vars. | — |

---

## §6 Gap-Härtung (nur Defekte / spezifizierte Lücken)

| Fix | Defekt / Lücke | Umsetzung | Verifikation |
|-----|----------------|-----------|--------------|
| **F1** | Corrupt persisted record crasht `refreshSearch`/`reconstructPending`/Mount
 („Corrupt record → no crash", Mission §6). | `isWellFormedIndexRecord` (`indexStore.ts:191`)
 als Read-Pfad-Validierung; `get`→undefined, `getAll`→gefiltert (`indexStore.ts:234,243`).
 Malformed Rows werden **gequarantänt, nicht gelöscht**; `get`=undefined ermöglicht
 Self-Heal durch Re-Analyse (Pipeline-Idempotenzpfad). | Unit `indexStore.test.ts` (4 neue);
 E2E `step17-corrupt-record.spec.ts` (17C-01…07, inkl. Raw-IDB-Injektion + Reload mit
 Corrupt-Daten) |
| **F2** | 1-Frame/ultra-kurzer PCM → RangeError in `featureExtractor.fftMag`. | `MIN_VALID_FRAMES=2`
 im Decoded-PCM-Gate (`qualityGate.ts:41,207-210`) → deterministischer
 `INVALID_PCM`-Skip; Totality-Guard `n<2` in `computeSpectral` (`featureExtractor.ts:142`). | `qualityGate.test.ts` (neu, 6),
 `featureExtractor.test.ts` (+1), `analysisPipeline.test.ts` (+2 Single-Frame/Sub-Min) |
| **F3** | Container-Reject-Pfad release-assert fehlte. | Test assert `release()` nach Gate-Reject. | `analysisPipeline.test.ts` |
| **F4a** | Pipeline-Single-Frame-/Kurz-Audio deterministisch. | Pipeline-Tests: skipped `INVALID_PCM`,
 kein Persist, kein Extract/Classify, Release einmal. | `analysisPipeline.test.ts` (+2) |
| **F4b** | `analysis.error` (Runner-Reject) + `findSimilar`-Prereqs ungetestet. | Tests für Rejecting-Runner
 (stopped+error, Pause→Resume-Reject), findSimilar: no-selection / no-fingerprint / no-contentHash / success+self-exclusion. | `app.test.ts` (+6) |
| **F5** | NaN/Infinity/missing-feature Inputs für Classifier ungetestet. | Verhalten war bereits **total**
 (boolean-prädikat-basiert, nie NaN/Infinity); als Vertrag festgehalten + determinism-Test. | `classifier.test.ts` (+4) |
| **E2E** | Corrupt-Daten im echten Browser ungeprüft. | Neues E2E-Spec `17C` (7 Tests, siehe §10). | `e2e/step17-corrupt-record.spec.ts` |

**Fix-Verdict:** alle Fixes verhaltens-kompatibel (keine neuen Produktkonzepte), deterministisch,
mit Regressionstests belegt.

---

## §7 Requirement-Traceability-Matrix

Legende Status: **OK-T** = OK, getestet · **OK-T-FIX** = OK, FIXTURE-basiert ·
**REAL** = echter Codepfad/Browser · **MOCKED** = Test-Double · **BLOCKED** = extern nicht
verifizierbar · **NOT_TESTED** = dokumentiert offen.

| Req-ID | Requirement (Spec-Anker) | Implementation (src) | Test | Evidence | Status |
|--------|---------------------------|----------------------|------|----------|--------|
| 4.1 | SampleIndexRecord ohne Audio, metadata-only | `indexStore.ts:36-121` (interface), `assertNoAudioBytes:143` | `indexStore.test.ts`, `analysisPipeline.test.ts` | Audit A1/A2 | OK-T |
| 4.2 / 12 | Persistenz IndexedDB, **nie Audio-Bytes**, Idempotenz `(sampleId,analysisBuild)` | `elasticdb.ts`, `indexStore.ts:234` (`get:144` Idempotenz), `analysisPipeline.ts:140-148` | `elasticdb.test.ts`, `db.test.ts`, `analysisPipeline.test.ts` | Baseline; Audit A1 | OK-T |
| 5.0 | Inkrementelle, pausierbare/resumable Jobs; Budget 10/100/1000; automatischer Stopp | `queueStore.ts:38,63`, `jobRunner.ts:109-155` (Budget L134, Retry L155) | `jobRunner.test.ts`, `app.test.ts` (Budget/Rapid-Repeat S.M.-Audit-005) | E2E 16M-03/11/13 | OK-T |
| 5.1 | Concurrency=1, Rate-Limit, Backoff, Resume nach Unterbrechung, `gone`-Status | `jobRunner.ts:21` (`MAX_CONCURRENCY`), LibraryScanner-Requeue | `jobRunner.test.ts`, `analysisPipeline.test.ts` | Audit A3 | OK-T |
| 6 | V1-Featureset (13 Features, §6-„Ja") | `featureExtractor.ts` | `featureExtractor.test.ts` (+ F2 totality) | Audit A3 | OK-T |
| 7.1 / 7.2 | Taxonomie (drums/musical/other) + stabiles `Classifier`-Interface, Modell austauschbar | `classify/classifier.ts`, `heuristicClassifier.ts`, `registry.ts`, `taxonomy.ts` | `classifier.test.ts` (+ F5), `analysisPipeline.test.ts` | Audit A3 | OK-T |
| 7.3 | Strikte Trennung `originalTags` vs. SampleMap-Klassifikation | `app.ts`/`view.ts` (Separate Render-Buchten), `indexStore.ts:36-121` | Such-/View-Tests; Audit A4 | — | OK-T |
| 8.1 | Index versioniert (`analysisVersion`), funktioniert ohne Audio | `indexStore.ts:36-121`, `analysisPipeline.ts:130,296` | `analysisPipeline.test.ts` | Audit A2 | OK-T |
| 8.2 | Suche: Text (name/tags/owner, fuzzy), Klassen-/Gruppenfilter, Sortierung Relevanz/Name/analyzedAt, deterministisch | `searchEngine.ts` (all, sort L138-163, tiebreak L158-161, groups L77-81) | `searchEngine.test.ts`, E2E 16M-15 | Audit A4 | OK-T |
| 9 | Preview: begrenzte Parallele, ObjectURL-Hygiene, kein permanenter Audio-Storage | `previewService.ts` (`MAX_PREVIEW_CONCURRENCY:8`, LRU `:100`, revoke `:46`) | `previewService.test.ts`, E2E 16M-19 | Audit A1 | OK-T / BLOCKED (Live-Playback) |
| 10.1/10.2/10.3 | Machiniste: Select→Machiniste→Slots→Send; Multi-Sample→Multi-Slot in **einer** Transaction; `MAX_BATCH_SLOTS=8`; Read-Back je Slot (`applied/readBackMatches/errors[]`) | `machinisteService.ts:38,111-205` | `machinisteService.test.ts`, E2E 16M-10/14/18 | Audit A4 | OK-T (offline doc, REAL WASM) |
| 11 | Skalierungsstrategie V1: inkrementell, budgetiert, gebremste Concurrency | `jobRunner.ts`, `libraryScanner.ts:8-88` | `app.test.ts`, `jobRunner.test.ts` | Baseline | OK-T |
| 13 | UI: Suche, Kategorien, Results, Preview, Multi-Select, Job-Status, „Send to Machiniste" | `ui/app.ts`, `ui/view.ts`, `ui/render.ts`, `ui/map/mapView.ts` | `app.test.ts`, `view/render/MappingTests`, E2E 16M-01…08/17 | Audit A4 | OK-T |
| 14 | Permissions minimal & least-privilege (Scopes via Env) | `main.ts:24-29`; Machiniste über OfflineDocument | E2E 16M-10 | Live-Scope-Ausgestaltung | BLOCKED (Live) |
| 15 | Fehlerbehandlung: Backoff/Rate-Limit, Retry→failed, Transaction-Reject strukturiert, `gone`, Einzel-Sample-Isolation, ObjectURL-Leakfrei | `jobRunner.ts`, `machinisteService.ts:182-205`, `previewService.ts`, `app.ts` (Error-States) | `app.test.ts` (scan/preview/machiniste error, stale-fetch), E2E 16M-14 | Audit A4 | OK-T |
| 16-1..16-13 | V1-Scope-Pflichten (Login, IndexedDB-Index, Classifier, Trennung, Features, Pipeline-Hygiene, Jobs, Budget, Suche, Preview, Machiniste, UI, Fehler) | siehe o. g. Module | gesamte Suite | Baseline | OK-T |
| 20.3 | Test-Invarianten: kein Audio in IDB; Idempotenz; Austauschbarkeit | `indexStore.ts:143`, `analysisPipeline.ts:140-148`, `classifier.ts` | `indexStore.test.ts` (bytes), `analysisPipeline.test.ts`, `classifier.test.ts` | Audit A1/A3 | OK-T |
| STEP16R (EP0…EP6) | UX-Surface der Schritt-16-Lieferungen (EP2 Copy, EP3 Select/Send, EP4 Filter, EP5 Gesture/Responsive/A11y, EP6 Publish-Status) | `ui/app.ts`, `ui/render.ts` (E-P6-Block `render.ts:861-892` read-only), `ui/view.ts:391-` (PublishStatus) | `ep*.spec.ts` (Playwright), `ep6PublishStatus.test.ts`, `step16w-fixes.spec.ts` | Baseline E2E | OK-T |
| E-P7 | Human Layer-C closure + §19.5-Einwilligung (einmaliger Dialog) | bewusst NICHT implementiert (Roadmap) | — | STEP16X R-B | **BLOCKED** (Roadmap) |
| STEP17 F1/F2 | Corrupt-Record-no-crash; Single-Frame deterministisch | `indexStore.ts:191,234,243`; `qualityGate.ts:41,207`; `featureExtractor.ts:142` | `indexStore.test.ts`, `qualityGate.test.ts`, 17C-E2E | §6 | OK-T |
| STEP17 F3/F4/F5 | Reinforcement-Festigkeit (Release außerhalb Happy-Path; NaN/Infinity; Reject-Recovery) | Test-Verdichtung (kein Produktverhalten geändert) | `analysisPipeline.test.ts`, `classifier.test.ts`, `app.test.ts` | §6 | OK-T |

---

## §8 Map-/State-/Error-Surface-Verifikation

- Alle Map-Zustände belegt: leer/einer/viele/duplikat (contentHash-Dedup), Auswahl, Zoom, Pan,
  Reload (E2E 16M-12), Missing-V2 (Position nie aus Features rekonstruiert, I25).
- Zustandsmaschinen scan/analysis/map/preview/findSimilar/machiniste inkl. Loading/ERROR/EMPTY
  verifiziert; Livestatus-Fehler propagieren kontrolliert bis zum User.

---

## §9 Publish-Status-Surface-State-Matrix (§11, E-P6)

E-P6-Oberfläche ist **read-only** (16R DECISIONS #9; `ui/view.ts:391-` pure Projection; Queue wird
nie aus der UI mutiert). Zustände gemäß STEP16T/16U/16W (unverändert, RE-Audit im Rahmen von 17):

| Zustand | Bedeutung | Machinerie | UI-Sink |
|---------|-----------|------------|---------|
| `none` | nie usage-accepted, nie gequeued | — | Steht baselined |
| `pending` | accepted + enqueued, noch kein Outcome | `usageAcceptance.acceptUsageAndEnqueue` (`usageAcceptance.ts:132`) | E-P6 pending (erste-Klasse) |
| `stored` / `already-known` | provider akzeptiert | PublishQueue Outcome | E-P6 stored/known |
| `conflict` | terminal (kein Überschreiben) | PublishQueue `applyRejection` | E-P6 conflict |
| `rejected`/`temporary-unavailable` | retryable / rate-limit | PublishQueue | E-P6 |
| Publish-Marker `published` | lokal notiert, GlobalIndex autoritativ | `markDelivered` (`usageAcceptance.ts:189`) | nie von stale pending überschrieben |

Kontroverse Fälle belegt: „published-Marker nie von stale pending Item überschrieben"
(`view.ts`-Kommentarblock); In-Flight auf pending abgebildet (kein getrenntes „publishing" —
bewusste 16T-Entscheidung). **Verdict: konsistent, read-only, kein Fix nötig.**

---

## §10 E2E/Browser-Verifikation (Harness, REAL Browser + REAL Decode)

- 16M (20 Tests) deckt Boot, Fixture-Ingestion, echte Analyse (REAL WebAudio-Dekodierung),
  Klassifikation, Map-Rendering+Hit-Test, Referenz-/Identity-Propagation, Machiniste offline,
  UI-State-Transitions, Reload-Persistenz, Idempotenz, Error-State, Suche, Console-Audit.
- EP2/3/4/5(a11y/gesture/responsive) + EP6-Publish-Status + step16w-fixes (BUG#2/#4) jeweils grün.
- **Neu 17C (7 Tests):** Corrupt-Reccord-Härtung im echten Browser —
  Injektion über Store **und** Raw-IndexedDB, Quarantäne in `get`/`getAll`/Suche, UI-Refresh,
  **Reload mit Corrupt-Daten im DB-Boot**, Console-TypeError/RangeError-Audit. **64/64.**

---

## §11 Fehler-/Recovery-Matrix

| Szenario | Erwartung | Beleg | Kategorie |
|----------|-----------|-------|-----------|
| Corrupt persisted record beim Boot/Suche/Karte | kein Crash; Quarantäne; Map/Suche unverändert | 17C-02…06, `indexStore.test.ts` | REAL/FIXTURE |
| 1-Frame-/Kurz-Audio | deterministischer `INVALID_PCM`-Skip, kein Persist | `qualityGate.test.ts`, `analysisPipeline.test.ts` | FIXTURE |
| Decode-Fehler | `skipped DECODE_FAILED`, Release | `analysisPipeline.test.ts` | MOCKED |
| Classifier-Fehler | `failed`, Release, Queue läuft weiter | `analysisPipeline.test.ts`, `jobRunner.test.ts` | MOCKED |
| Runner-Start wirft | `stopped` + error, kein Hänger | `app.test.ts` (neu F4b) | MOCKED |
| Machiniste-Reject / kein Sample | strukturierte `errors[]` / UI-error | `app.test.ts`, `machinisteService.test.ts`, 16M-14 | MOCKED/REAL |
| findSimilar ohne Auswahl/Fingerprint | klare Meldung, keine Mutation | `app.test.ts` (neu F4b) | MOCKED |
| 429/Netzwerk | Backoff, `failed` terminal | `jobRunner.test.ts` | MOCKED |
| Preview-Fehler | Fehlerzustand, kein Crash, kein Focus-Verlust | `app.test.ts`, 16M-19 | MOCKED/BLOCKED |

---

## §12 Security & Performance-Sanity

- Keine Secrets/Token in DB oder Logs; `console.log` nur in `cli.ts`/main-Logger.
- Kein `Worker`/`setInterval`-Missbrauch in prod ausgeliefertem Code.
- Env-Variablen: nur `VITE_AUDIOTOOL_CLIENT_ID`, `VITE_SAMPLE_SCOPE`, `VITE_GLOBAL_WORKER_URL`
  (öffentliche Client-Konfiguration).
- Performance: sequential weightedness gewollt (Concurrency=1), Preview-Parallelität begrenzt,
  LRU+Revoke; Build-Warnung nur Chunk-Größe (kein Fehler).

---

## §13 Bekannte Einschränkungen / BLOCKED / NOT_TESTED

| Punkt | Kategorie | Begründung |
|-------|-----------|-----------|
| E-P7 Human Layer-C closure + §19.5-Einwilligung | **BLOCKED** | Roadmap-Boundary (STEP16X R-B); kein Defekt |
| Live-Audiotool / echtes OAuth / echtes Projekt | **BLOCKED** | keine Live-Credentials in der Audits-Umgebung; bestimmte externe Verifikation (16M-19 Preview-BLOCKED) |
| `browserFetchAudio` (Netzwerk-Seam, `bootstrap.ts:75`) | **NOT_TESTED** (Unit) | browser-only; im Harness durch `fetchFixtureAudio` ersetzt. `browserDecode` dagegen **REAL**-exeziert (E2E, echte WebAudio-Dekodierung) |
| `AudioContext` nach `dispose()` nicht geschlossen | dokumentiert | Single-Page-Remounts teilen deps (kein Leck im Harness-Nutzungspfad); Einzel-Rebootstrap erzeugt neuen Context — Ressourcen-Hinweis |
| Confidence `NaN%` über Global-Reuse | residual | lokal per F1 (finite-confidence-Filter) geschlossen; Global-Analyse stammt aus eigenem, schemavalidierenden D1-Worker (REAL-Write-Validierung) |
| V2-Features (`findSimilar` ANN, BPM, `decay`, `estimatedPitch`) | V2-Scope | spec-definiert, Architektur-Platz reserviert |

---

## §14 Regressionslauf (final, exakt)

| Gate | Ergebnis vorher | Ergebnis jetzt | Δ |
|------|----------------|---------------|----|
| `tsc --noEmit` | 0 Fehler | **0 Fehler** | — |
| App-Vitest | 643/643 · 33 Files | **666/666 · 34 Files** | +23 Tests (23× neu grün) |
| Worker-Vitest | 19/19 · 2 Files | **19/19 · 2 Files** | — |
| Playwright-E2E | 57/57 · 11 Specs | **64/64 · 12 Specs** | +7 (17C) |
| Build | PASS · 791.62 kB | **PASS · 792.74 kB** (nur chunk-size-Warnung) | — |

---

## §15 Risiken & Restarbeiten

1. **Live-Verifikation (E-P7)** — nach Bereitstellung einer Live-Umgebung: echter
   Send/Preview/Flush + Einwilligungsdialog.
2. **`browserFetchAudio`-Seam** — optionaler Integrationstest in einer Live-Umgebung.
3. **Repair-Pfad für quarantänierte Records** — aktuell bewusst „Quarantäne statt Löschen";
   ein späterer Schritt kann korrupte Rows sichtbar machen.
4. **AudioContext-Lebenszyklus** bei Voll-Remount.

---

## §16 Release Decision

**Verdict: PASS — EXTERNAL VERIFICATION BLOCKED.**

- Die internen Release-Kriterien sind vollständig erfüllt; alle identifizierten Defekte/Lücken
  wurden behoben und mit Tests (Unit + real-browser E2E) belegt; keine offenen internen Blocker.
- Die verbliebenen BLOCKED-Punkte sind **ausschließlich externe/roadmap-definierte
  Verifikationsgegenstände** (Live-Audiotool-Schicht, E-P7, Layer C), keine Produktfehler.
- **Release-Empfehlung:** Freigabe für den internen/offline-beweisbaren Stand.
  Bedingung für die vollständige „PASS"-Erklärung: erfolgreiche Live-Verifikation von E-P7
  und der Audiotool-Integration (separater, externer Schritt).