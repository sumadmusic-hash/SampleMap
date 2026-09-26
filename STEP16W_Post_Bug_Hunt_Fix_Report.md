# STEP16W — Post-Bug-Hunt Fix & Verifikationszyklus (STEP16V)

**Datum:** 2026-09-06 · **Basis:** `STEP16V_BUG_HUNT_AUDIT.md` (4 confirmed Bugs + 2 likely Findings + 5 Test Gaps) · **Methode:** gezielte Minimal-Fixes (keine Refactorings/Architekturänderung), Regressionstests je Fix, danach alle 6 Gates erneut, Abschlussbewertung.

**Eingangs-Gates (STEP16V-verifiziert):** App Vitest 625/625 · Worker Vitest 19/19 · Playwright 53/53 · App tsc 0 · Worker tsc 0 · Build PASS.

**Ausgangs-Gates (STEP16W):** App Vitest **643/643** · Worker Vitest **19/19** · Playwright **57/57** · App tsc **0** · Worker tsc **0** · Build **PASS**.

---

## Final Verdict

> **FIXES PASS**

Alle 4 confirmed Bugs (STEP16V) sind mit kleinstmöglichem Diff behoben und mit Regressionstests abgesichert. Das 5. Target („UI-Send → Usage-Acceptance") wurde gemäß P0-Auftrag als **B — INTENTIONAL ARCHITECTURE** eingeordnet und **nicht** gefixt (Begründung unten). Die Test-Gaps TG1–TG4 sind geschlossen, TG2 (Restart/Hydration) durch einen neuen Fall-C-Test abgedeckt; TG5 (Harness-Inline-Send umgeht `app.sendToMachiniste`) bleibt als dokumentierter Test-/Integrations-Vorbehalt bestehen. Kein Remaining Blocker, keine eingefrorene Produktsemantik verändert, keine invalierten Invarianten.

---

## Findings-Übersicht

| # | Finding (STEP16V) | Severity | Status | Entschieden als | Fix-Komponente / Ort |
|---|---|---|---|---|---|
| 1 | Stale terminales Queue-Item dominiert den Publish-Status | High | CONFIRMED | **FIX** | `src/ui/view.ts` (`newestPublishItem`), `src/ui/render.ts` |
| 2 | `toggleMultiSelect` Cap-Pfad: Focus ohne Render, Checkbox lügt | Medium | CONFIRMED | **FIX** | `src/ui/app.ts` (`toggleMultiSelect`) |
| 3 | `GlobalIndexError`-Kind via `String(e)` zerstört → Falschklassifikation | Medium | CONFIRMED | **FIX** | `src/global/publishQueue.ts` (`isGlobalIndexError`/`describeGlobalIndexError`/`applyRejection`) |
| 4 | Globaler `keydown`-Listener wird nie entfernt; Remount stapelt Handler | Medium | CONFIRMED | **FIX** | `src/ui/render.ts` (`mountedKeydownDisposers`/`disposeSampleMap`), Harness-`remount` |
| 5 | `refreshGlobalPoints` ohne Generation-Guard → out-of-order-Überschreiben | Low–Med | LIKELY | **FIX (defensiv)** | `src/ui/app.ts` (`globalRefreshEpoch` + `dispose()`-Epoch-Invalidierung) |
| P0 | UI-Send → fehlende Usage-Acceptance | High (LIKELY/Produkt) | — | **B — INTENTIONAL ARCHITECTURE** | kein Code-Fix; dokumentiert (s. §P0) |
| TG5 | Harness-Inline `sendToMachiniste` umgeht `app.sendToMachiniste` | Test | — | **TRANSPARENTER TEST-VORBEHALT** | dokumentiert; kein Code-Fix (Harness-Design) |

---

## P0 — „UI-Send nach `sendToMachiniste` erzeugt keine Usage-Acceptance": Entscheidung

**Entscheidung: B — INTENTIONAL ARCHITECTURE** — **kein Fix**, sondern dokumentieren.

Kette aus Design-Spezifikation und Reports (kein Widerspruch im Repo gefunden):

1. **STEP16G_DESIGN.md §2.5:** „There is **no call site in `src/main.ts`, `src/ui/`, or `src/cli.ts`** that enqueues or flushes a publish. Therefore the current app does NOT auto-publish on analysis — the gate has no code to block yet; **Step 16H establishes the publish seam AND the gate together**."
2. **STEP16G_DESIGN.md §14.1:** „[…] on success, reads the local analyzed record and enqueues `createPublishCandidate(record)`. This is the **only place** where 'analysis → global publish' is connected to a verified human action. **Wiring the existing queue/provider into the app UI/main is part of this step**." → Die Enqueue-Orchestrierung lebt laut Design im App-Layer/16H, nicht im Send-Pfad. Die UI-Mount-Deps sind inzwischen über `globalPublishQueue`/`globalPublishDelivery` verdrahtet; der Acceptance-Call ist bewusst orchestrator-seitig.
3. **STEP16U_EP6_PUBLISH_STATUS_REPORT (L6–8):** Die E-P6-Oberfläche ist explizit **read-only**: „the UI never enqueues, flushes or retries the publish queue — it only reads `queue.snapshot()`".
4. **FINAL_UI_UX_DESIGN_SPEC §19.5:** Usage-Acceptance ist ein **einmaliger Konsent-Dialog als Präferenz**, kein Auto-Publish-Trigger hinter dem Send-Button.
5. **STEP16T_EP6_PUBLISH_STATUS_AUDIT §11:** Der einzige Publish-Status-Text ist der **POC-Console-Log in `main.ts`**, erreichbar nur über den POC-Harness-Button.

**Konsequenz für den Fix-Zyklus:** Der einzige echte Produktions-Caller von `acceptUsageAndEnqueue` liegt im POC-Diagnostics-Pfad (`src/main.ts:432`), was per Spezifikation korrekt ist. Es gibt **keinen** Produktionspfad, in dem die 16H-Acceptance untätig bliebe — das Feature ist als nächster Integrationsschritt (App-Layer) geplant, nicht als offener Bug im Bestand. **Kein Code-Fix in diesem Zyklus.**

**Begleitbefund (dokumentiert, kein Code-Fix):** Der Harness-Inline-Pfad `e2e/harness/main.ts:419-422` umgeht `app.sendToMachiniste` und sendet direkt über `SampleMapMachinisteService.send()` — die 16H-Acceptance wird beim e2e-UI-Send damit umgangen. Das ist beabsichtigtes Harness-Design (E-P6-Redkost ab EP6-02 via `publish.accept`), bleibt aber als Test-/Integrations-Vorbehalt in **TG5** dokumentiert: ein echter „UI-Send → Acceptance → Queue → Publish" in einem Stück ist noch nicht automatisierbar, solange der Harness-Pfad an der App vorbeigeht.

---

## Fix-Details

### BUG #1 — Neuestes Queue-Item gewinnt (Stale terminales Item maskiert Erfolg)

**Fix (`src/ui/view.ts` + `src/ui/render.ts`):** Reiner Renderer-Fix. Neuer purer Selektor `newestPublishItem(snapshot, sampleId)` (Snapshot rückwärts, letzter Match gewinnt) ersetzt `snapshot().find(...)`. Die Queue-State-Machine bleibt unverändert; **kein zusätzliches Pruning eingebaut** (Bestehendes `pruneSucceededAndFailed()` existiert und behält sein Verhalten; Produktionsverhalten unverändert, da ein automatisches Pruning die Ablegbarkeit/Semantik der Terminal-Items ändern würde).

**Regressionstests:**
- `src/ui/ep6PublishStatus.test.ts` — `newestPublishItem`: leer/Nicht-Match, Einzel-Match, mehrere Items (neuestes gewinnt), TG1-Statusprojektion „conflict → re-accept → stored ⇒ Stored" und Reverse-Order.
- `src/global/publish.test.ts` — TG1-Gruppe: Re-Enqueue nach terminalem `failed` erlaubt (2 Items), integrierter Flow `conflict → re-accept → stored ⇒ Stored` über echte Queue.
- `e2e/ep6-publish-status.spec.ts` **EP6-09** — voller Browser-Flow: `accept → flush(conflict) ≈ Conflict` → erneut `accept` → `flush(stored)` ⇒ **Status „Stored"**, Marker `published`, Queue enthält ≥ 2 Items für die sampleId, letztes `succeeded`.

**Effektivitätsprüfung:** Mit dem alten `find()`-Verhalten (first match) schlägt EP6-09 nachweislich fehl (empirisch verifiziert, danach Fix wiederhergestellt).

### BUG #2 — Cap-Guard in `toggleMultiSelect` + Render immer benachrichtigen

**Fix (`src/ui/app.ts`):** Cap-Check (`length < MAX_BATCH_SLOTS`) **vor** dem `selectedSampleIds.push`; das fehlerhafte Early-`return` ohne `notify()` entfernt — `notify()` wird jetzt in jedem Klickpfad ausgeführt. `focusedSampleId` bleibt unverändert „folgt dem Klick" (Semantik unangetastet), nur der Bug „Focus ohne Render + Checkbox lügt" ist behoben.

**Regressionstests:**
- `src/ui/app.test.ts` — Cap erreicht (8/8): 9. Toggle ⇒ `selectedSampleIds` bleibt 8, Sample nicht enthalten, `focusedSampleId` springt zum geklickten, **`onChange` (Render) wird gerufen** (genau 1×); nach Cap ein Deselect ⇒ Slot frei ⇒ 9. Add akzeptiert.
- `e2e/step16w-fixes.spec.ts` **SW-02** — Checkbox-DOM stimmt bei jedem Klick mit `selectedSampleIds`/Pill überein (0/8→1/8→0/8→4/8→3/8), „checkbox lügt nie".
- Begründung kein 8→9-e2e: Harness-Fixture hat nur 4 echte Map-Punkte; zusätzliche persistierte Samples würden die Shared-Page-Assertions der anderen Specs (`toHaveCount(4)`) brechen. Cap-Verhalten ist Controller-Logik und unit vollständig abgedeckt.

### BUG #3 — `GlobalIndexError`-Kind erhalten statt `String(e) = "[object Object]"`

**Fix (`src/global/publishQueue.ts`):** Im `flush`-Transport-Catch wird zuerst geprüft, ob der Wurf ein `GlobalIndexError`-Plain-Object ist (`isGlobalIndexError`); daraus wird ein typisierter Reason-String gebaut (`describeGlobalIndexError`: `validation-rejected: …`, `version-incompatible: …`, `conflict: …`, `rate-limited`, `temporary-unavailable`, `not-found`). Die Klassifikation läuft **identisch** zum Per-Item-Pfad über die neue gemeinsame Methode `applyRejection(item, reason)` (conflict → terminal; retryable-Reasons → Backoff bis `maxAttempts`; sonst terminal; korrekter Rückgabewert bei Erschöpfung). Unbekannte `Error`-/Netzfehler behalten exakt das bisherige Verhalten (retryable bis `maxAttempts`). Keine neue Error-Architektur; Adapter-Verhalten (Plain-Object-Throw ist Vertrag) unangetastet.

**Regressionstests:**
- `src/global/publish.test.ts` — Gruppe **W**: Batch-level Throw für `validation-rejected` (terminal, attempts=1, kein Retry trotz maxAttempts=3, Reason erhalten, **kein `[object Object]`**), `version-incompatible` (terminal), `conflict` (terminal), `rate-limited` (retryable), `temporary-unavailable` (retryable), Klassifikations-Äquivalenz Transport- vs. Per-Item-Pfad, Retry-Erschöpfung für `rate-limited`.
- `e2e/ep6-publish-status.spec.ts` **EP6-10** — Provider wird gezwungen, ein Plain-Object `{kind:"rate-limited"}` zu werfen ⇒ `flush` retryable=1, `lastError === "rate-limited"` (kein `[object Object]`), UI-Status „Temporary unavailable".

### BUG #4 — Keydown-Lifecycle sauber beim Remount

**Fix (`src/ui/render.ts` + `src/e2e/harness/main.ts`):** `mountSampleMap` registriert per-App einen Disposer (`mountedKeydownDisposers`-WeakMap, entfernt exakt den eigenen `document`-Handler); `disposeSampleMap` ruft Disposer + `app.dispose()` auf. Kein `document.onkeydown`-Hack. Der Harness-`remount` nutzt jetzt den Cleanup-Pfad und legt die disposed App unter `__sm.disposedApps` für die Assertion ab (minimaler Test-Hook).

**Regressionstests:**
- `e2e/step16w-fixes.spec.ts` **SW-01** — vor Remount Selection `[KICK]`; nach `remount` + `Escape` bleibt die **disposed App** Selection unverändert `[KICK]` (ihre Keydown-Handler ist entfernt), die Live-App bleibt unberührt; Pfeiltaste bewegt ausschließlich den Fokus der Live-App, nicht der disposed App.
- **Effektivitätsprüfung:** Ohne den Disposer (temporär entfernt) schlägt SW-01 nachweislich fehl (empirisch verifiziert, danach wiederhergestellt).

### BUG #5 — Epoch-Guard in `refreshGlobalPoints`

**Fix (`src/ui/app.ts`):** `refreshGlobalPoints` erhöht `globalRefreshEpoch`, prüft nach jedem `await` (`epoch !== this.globalRefreshEpoch`) und bricht bei Stale ab; `dispose()` invalidiert zusätzlich die Epoch. Analog zum bestehenden `previewEpoch`-Muster; keine Verhaltensänderung im nicht-überlappenden Pfad.

**Regressionstest:** `src/ui/step16L.test.ts` C6 — (a) zwei überlappende Refreshs, zweiter löst zuerst auf ⇒ erstes Ergebnis wird korrekt verworfen (`globalPoints` = 2. Sicht, nicht leer); (b) `dispose()` während eines in-flight Refresh ⇒ Stale-Completion committet keine Points und löst **keinen** weiteren `onChange`/Render aus (Zombie-Render verhindert).

---

## Test-Gaps

| Gap | Status | Abgedeckt durch |
|---|---|---|
| TG1 — mehrere Queue-Items pro sampleId | **GESCHLOSSEN** | `publish.test.ts` TG1 + `ep6PublishStatus.test.ts` + e2e EP6-09 |
| TG2 — Restart/Hydration-Matrix | **GESCHLOSSEN (Fall C ergänzt)** | `usageAcceptance.test.ts` (E-Gruppe): persistierter `pending`-Marker + in-memory-`failed(conflict)` ⇒ nach „Restart" (frische Queue) re-enqueued → `pending`, kein Stale-Conflict-Resurrection. Fälle A/B/E/D restlich bereits vorhanden |
| TG3 — HTTP-Error-Body Worker→Adapter→Queue→UI | **GESCHLOSSEN** | `publish.test.ts` Gruppe W (Kinds/Retry/Äquivalenz) + e2e EP6-10 (echtes Throw-Objekt → Queue → Projektion) |
| TG4 — Cap-Hit-Selection (8→9) | **GESCHLOSSEN** | `app.test.ts` (Cap + notify) + e2e SW-02 (Checkbox-DOM-Ehrlichkeit); 8→9-Pixel-e2e bewusst unit/controller abgedeckt (Harness hat nur 4 Punkte; s. BUG #2) |
| TG5 — UI-Send→Acceptance verdrahten | **DOKUMENTIERT, KEIN CODE-FIX** | P0-Konklusion B (Intentional Architecture); Harness-Umgehung als Integrations-Vorbehalt dokumentiert |

---

## Validation

**App Unit (Vitest):** **643/643** (33 Dateien; Baseline 625)
- `publish.test.ts` 41→50 (W-Gruppe + TG1), `app.test.ts` 65→67 (BUG #2), `ep6PublishStatus.test.ts` 16→20 (newestPublishItem + TG1-Projektion), `step16L.test.ts` 31→33 (BUG #5 × 2), `usageAcceptance.test.ts` 21→22 (TG2 Fall C)

**Worker (Vitest):** **19/19** (unverändert) · **Worker tsc:** 0 Fehler

**Playwright (e2e):** **57/57** (Baseline 53)
- + EP6-09 (BUG #1) · + EP6-10 (BUG #3) · + SW-01 (BUG #4) · + SW-02 (BUG #2)

**App tsc:** 0 Fehler · **Build (Vite):** PASS (Chunk-Größen-Warnung unverändert, kein Fehler)

**Effektivitätsprüfung (rot-ohne-Fix):** BUG #1 (EP6-09) und BUG #4 (SW-01) wurden mit jeweils vorübergehend entferntem Fix rot reproduziert und danach wieder hergestellt; die Tests greifen also auf den eigentlichen Defekt.

---

## Invariant Check (eingefrorene Produktsemantik unverändert)

- **V2-Map autoritativ / kein V1-Fallback / Missing-V2 nie platziert:** unangetastet (kein Diff in `map/`-Logik).
- **Focus ≠ Selection:** unverändert; BUG-#2-Fix isoliert nur Selection-Cap + Render.
- **Selection ≤ 8:** Cap-Guard behält die Grenze; kein `push` über 8 mehr möglich.
- **Esc löscht keine Filter:** unverändert (nur `clearSelection` + Drawer).
- **Preview ephemeral / `previewEpoch`:** unverändert.
- **Transfer ≠ Publish / Usage-Acceptance als Voraussetzung für Publish:** unverändert; P0 nicht gefixt.
- **E-P0 … E-P5A unverändert:** kein UI-/Map-/Search-/Persistence-Diff außerhalb der 5 Fix-Stellen.
- **E-P5 T1 bleibt BLOCKED:** unverändert.
- **`bpm`/`numFavorites`/`numUsages` reine Metadaten:** unverändert.
- **Queue-State-Machine unverändert** (nur Klassifikations-Faktorisierung BUG #3, semantisch äquivalent) und **Publish-Fläche bleibt read-only** (UI mutiert die Queue nie).

---

## Remaining Risks

1. **TG5 / P0 (niedrig, dokumentiert):** Solange der e2e-Send den `app.sendToMachiniste`-Pfad umgeht, ist „UI-Send → Acceptance → Publish in einem Stück" nicht e2e abgesichert — wird zur UI-Seam-Integration (STEP-App-Layer) als eigener Schritt fällig, kein Bestandsfehler.
2. **Restart-Semantik Fall C (bewusst, invariant):** Ein terminaler Konflikt existiert nur in-memory; nach Restart zeigt die UI wieder „Pending". Dies ist der dokumentierte Option-A-Durability-Trade-off, jetzt durch Unit-Test (TG2) abgesichert.
3. **BUG #5 defensiv:** Der Guards ist korrekt, aber kein reales Out-of-Order-Szenario im Produktionsbetrieb beobachtet; Regressionstest simuliert es deterministisch.
4. **Keine neuen gezielten e2e für 8→9-Klick** (Harness-Restriktion, s. BUG #2) — durch Controller-Unit-Tests + SW-02 abgedeckt.

---

## Geprüfte Gates/Abschluss

- [x] App tsc 0 Fehler
- [x] Worker tsc 0 Fehler
- [x] App Vitest 643/643
- [x] Worker Vitest 19/19
- [x] Playwright 57/57
- [x] Vite Build PASS
- [x] Rot-ohne-Fix-Verifikation für BUG #1 und BUG #4
- [x] Invariant-Check bestanden
- [x] STEP16W-Report (dieses Dokument)

**Endstatus: FIXES PASS** — alle 4 confirmed Bugs behoben und abgesichert, P0 als Intentional Architecture dokumentiert, 5/5 Test-Gaps adressiert (4 geschlossen, 1 dokumentiert), keine verletzte Invariante, kein Remaining Blocker.