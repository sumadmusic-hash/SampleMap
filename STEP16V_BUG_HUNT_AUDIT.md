# STEP16V — Vollständiger Read-Only Bug Hunt Audit

**Datum:** 2026-09-06 · **Scope:** gesamt (E-P0 … E-P6 inkl. neuer E-P6-Fläche) · **Methode:** statische Codepfad-Analyse + empirische Reproduktion (isolierte Bundles in tmp, read-only am Repo)

**Eingangs-Gates (verifiziert):** App 625/625 · Worker 19/19 · Playwright 53/53 · tsc 0 · Build PASS.

---

## CONFIRMED BUGS

---

### BUG #1 — Stale terminales Queue-Item dominiert den Publish-Status

**Severity:** High
**Status:** CONFIRMED BUG (empirisch reproduziert)
**Location:**
- `src/ui/render.ts:870` — `queue.snapshot().find((i) => i.sampleId === selected.sampleId)`
- `src/global/publishQueue.ts:257-262` (`enqueue` lässt Re-Enqueue nach `failed` zu → zweites Item gleicher sampleId)
- `src/global/publishQueue.ts:412` (`pruneSucceededAndFailed` wird im Produktionscode NIE aufgerufen)

**Trigger:**
1. Sample wird publiziert → Worker meldet `conflict` → Queue-Item wird `failed` (terminal) → UI zeigt "Conflict" (korrekt).
2. Nutzer überträgt das Sample erneut per Machiniste → `acceptUsageAndEnqueue` → `enqueue` erlaubt (bestehendes Item ist `failed`) → **zweites** Item `pending`.
3. Flush erfolgreich → Item #2 wird `succeeded`, Marker `published`.
4. **Queue enthält jetzt `[failed(conflict), succeeded]`.** `snapshot().find()` liefert das ERSTE (alte, terminierte) Item → UI zeigt **dauerhaft "Conflict"**, obwohl die Publikation erfolgreich war.

**Expected:** Nach erfolgreichem Re-Publish zeigt die UI den aktuellen Zustand (Stored/Known), nicht den alten terminalen.
**Actual:** UI zeigt "Conflict" für immer (bis Queue-Prozess endet). Erfolgreiche Re-Publishing wird durch das stale terminale Item maskiert.
**Root Cause:** `publishStatusFor` bekommt vom Renderer nur **ein** Item (find-first) statt des neuesten; die Queue wächst unbegrenzt mit terminalen Items (kein Prod-Aufruf von `pruneSucceededAndFailed`), und `find()` wählt das älteste.
**Evidence:** Empirisch (isolierte Reproduktion, echte `GlobalPublishQueue`):
```
after conflict   render-status = conflict
re-accept        render-status = conflict  (queue has 2 items)
retry succeeded  render-status = conflict  items: ["failed","succeeded"]
EXPECTED: Stored. ACTUAL: CONFLICT
```
**Minimal Fix:** Im Renderer das **neueste** Item pro sampleId wählen (z. B. Snapshot rückwärts suchen / `.reduce` mit letztem Match), statt `find()`; ergänzend `pruneSucceededAndFailed()` bei jedem erfolgreichen Flush (oder dedup bei `enqueue`).
**Regression Test:** Unit: `publishStatusFor`-Aufrufer-Semantik „letztes Item gewinnt". E2E: `accept → flush(conflict) → accept erneut → flush(stored) → Status muss "Stored" sein, nicht "Conflict"`.

---

### BUG #2 — Cap-Pfad von `toggleMultiSelect` bewegt Focus, ohne zu rendern; Checkbox lügt

**Severity:** Medium
**Status:** CONFIRMED BUG (aus Code eindeutig ableitbar)
**Location:** `src/ui/app.ts:842-853` (`toggleMultiSelect`)
**Trigger:** 8 Samples ausgewählt (Cap MAX_BATCH_SLOTS). Nutzer klickt die Checkbox eines 9. Samples.
**Expected:** Entweder kompletter No-Op (Cap erreicht, nichts ändert sich) oder — falls Fokus-Folge erwünscht — konsistenter Render (Checkbox korrekt an-/ausgezeichneter Zustand).
**Actual:**
1. `knownRecords.set(9th)` + `this.focusedSampleId = 9th` werden **vor** dem Cap-Check gesetzt.
2. `else { if (length >= MAX) return; }` → **`return` ohne `notify()`**.
3. Interne State: Fokus zeigt plötzlich das 9. Sample; UI wurde nicht neu gerendert → Inspector zeigt noch das alte Sample.
4. Die native Checkbox toggelt im DOM sichtbar auf „checked", aber `selectedSampleIds` enthält das Sample NICHT → nächster beliebiger `notify()` rendert die Checkbox wieder unchecked zurück. **Visuelle und logische Auswahl divergieren.**
**Root Cause:** Fokus-Mutation vor Cap-Guard + fehlender `notify()` im Guard-Pfad.
**Evidence:** `toggleMultiSelect` Zeile 843-849 vor dem `return`; `return` ohne `notify()`.
**Minimal Fix:** Cap-Check VOR Verarbeitung: nur togglen, wenn `idx>=0 || length < MAX`; ergänzend immer `notify()` (auch im Frührückgabepfad), oder Checkbox als kontrollierte Komponente rendern (checked aus State, Change-Handler statt native Toggle).
**Regression Test:** App-Unit: Cap erreicht → 9. Toggle → `focusedSampleId` unverändert ODER Selection unverändert + `renderApp` aufgerufen (DOM-Checkbox unchecked). Playwright: 8 selektieren → 9. klicken → Pill „8 / 8", Checkbox unchecked.

---

### BUG #3 — `GlobalIndexError`-Kind wird durch `String(e)` im Queue-Flush zerstört → falsche Klassifikation

**Severity:** Medium (heute meist durch 200-per-item-Outcome maskiert; wird bei OQ-9-Auth/Rate-Limit scharf)
**Status:** CONFIRMED BUG (Pfad eindeutig; provoziert bei HTTP-Fehlerpfad)
**Location:**
- `workers/d1-worker/src/browserAdapter.ts:123-134` — wirft bei `!response.ok` das **Plain Object** `{kind, …}` (kein `Error`)
- `src/global/publishQueue.ts:320` — `const msg = e instanceof Error ? e.message : String(e)` → `String({kind:"rate-limited", …})` = `"[object Object]"`
- `workers/d1-worker/src/index.ts:249-255` + `:66-74` — global gültige HTTP-Fehler (400/409/429/503) mit `GlobalIndexError`-Body

**Trigger:**
1. Worker lehnt ein HTTP-Level-Request ab (z. B. später aktivierter Auth/CSRF-Hook → 403, echte Rate-Limiter → 429, Überschreitung Body-Limit/Batch → 400 mit `validation-rejected`).
2. Adapter wirft das Object; Queue fängt es: `lastError = "[object Object]"` (Kind + Reason verloren).
3. `isRetryableReason("[object Object]")` → false → Item wird trotzdem `retryable`/retried (transport path) — terminale Rejections (validation-rejected, 400) werden **3× vergeblich retried**, dann `failed`.
4. `publishStatusFor` auf `failed` mit `lastError="[object Object]"`, kein `lastOutcome` → `isTemporaryOutcome` → **"Temporary unavailable"** für eine eigentlich **permanente** Rejection.
**Expected:** Fehler-Kind (`validation-rejected`/`conflict`/`rate-limited`) bleibt erhalten → korrekte terminale Klassifikation + passende UI-Status (Rejected/Conflict/Rate-limited) und keine sinnlosen Retries.
**Actual:** Kind ist `"[object Object]"`; UI zeigt "Temporary unavailable"; terminale Fehler werden 3× wiederholt.
**Root Cause:** Gotcha `instanceof Error` vs. Plain-Object, das als `GlobalIndexError`-Transport-Format (16A Contract) über HTTP läuft.
**Evidence:** Empirisch (`rate-limited`/`validation-rejected`/`conflict` als Thrower → alle `lastError: "[object Object]"`, Retry-Loop). `browserAdapter.request()` Zeilen 123-134 werfen `error` (parsed JSON), kein `Error`-Subtyp.
**Minimal Fix:** Im Adapter `Error` (z. B. `GlobalIndexTransportError extends Error` mit `kind`/`reason`-Feldern) werfen ODER in `publishQueue.flush` Plain-Object-`GlobalIndexError`-Payloads erkennen (`String(e.kind ?? "")`, `JSON.stringify`). UI-seitig reicht der String-Sniff, wenn der Klassifikations-Input ein echter `reason`-String ist.
**Regression Test:** Worker/Adapter-Unit: 429-Body → Queue-Flush → `lastOutcome` bzw. `lastError.reason === "rate-limited"`; E-P6-Projektion: `failed`+`lastError="[...]"` aus validation → "Rejected". Worker-Integration: HTTP-400-Batch → kein Retry (attempts bleibt 1).

---

### BUG #4 — Globaler `keydown`-Listener wird nie entfernt; Harness-Remount stapelt Listener und der alte App kann das Root neu rendern

**Severity:** Medium (Harness/Test-Infra; Produktion mountet nur einmal)
**Status:** CONFIRMED BUG (aus Code eindeutig ableitbar, in neue E-P6-e2e-Harness-Pfad nachweisbar)
**Location:** `src/ui/render.ts:1122` (`document.addEventListener("keydown", onKeyDown)`, kein `removeEventListener`, keine `dispose`-Koordination)
**Trigger:** `e2e/harness/main.ts:585-592` — EP6-04 ruft `publish.remount("live")` → zweiter `mountSampleMap` auf demselben `#app`-Root → **zwei** aktive `document`-Handler.
**Expected:** Nach Remount wirkt nur der neue Handler; die alte App-Instanz rendert nie wieder in das Root.
**Actual:** Der alte Listener ist weiterhin aktiv:
- Escape → `app.clearSelection()` (alte App, `renderApp(root, alteApp)`) → DOM wird mit altem Zustand überschrieben.
- Pfeiltasten auf `.sample-map-svg` → `focusAdjacent` (alte App) → notify → `renderApp(root, alteApp)` ersetzt die UI durch den veralteten Snapshot; neue App-Handler wirken parallel mit → **Doppel-Navigation, wechselseitige Re-Renders**.
**Root Cause:** Listener werden global registriert und nie entfernt; `mountSampleMap` liefert kein Cleanup-Handle; `dispose()` existiert auf der App, ruft aber weder Listener-Removal noch wird es beim Harness-Remount aufgerufen.
**Evidence:** render.ts:1122 ohne korrespondierenden `removeEventListener`; Harness-remount ruft `mountSampleMap` erneut (main.ts:588) ohne vorheriges `dispose()`/Cleanup. E-P6-e2e laufen deshalb nur grün, weil die Tests keine Tastatur-Interaktion nach dem Remount auslösen.
**Minimal Fix:** `mountSampleMap` einen Cleanup-Resolver zurückgeben lassen (`if (replaced) removed listener`), oder in `dispose()` `document.removeEventListener` aufrufen; Harness-remount vor neuer Mount `tm.app.dispose()`.
**Regression Test:** Playwright nach Remount: Pfeil-rechts → nur EIN Punkt-Fokuswechsel (kein Double-Move, kein Revert der UI auf alten Stand); Escape nach Remount → Selection bleibt bei Zustand der neuen App.

---

## LIKELY BUGS

---

### BUG #5 — `refreshGlobalPoints` ohne Generation-Guard: ältere Antwort kann neuere überschreiben

**Severity:** Low–Medium
**Status:** LIKELY BUG
**Location:** `src/ui/app.ts:551-583` (`refreshGlobalPoints`)
**Trigger:** Schnelles Pan/Zoom (Debounce kappt nicht ALLE Überlappungen): zwei `refreshGlobalPoints` gleichzeitig; Netzwerkantworten können out-of-order auflösen → ältere BBox-Points überschreiben die neuere Sicht (`this.globalPoints = collected`).
**Expected:** UI zeigt die Points zur aktuellsten Kamera-Position.
**Actual:** Bei out-of-order-Auflösung gewinnt die ältere, kleinere/anderer Ausschnitt-Sicht → falsche `globalPoints`.
**Root Cause:** Kein Epoch/Abort-Guard wie beim Preview (`previewEpoch`); `setMapCamera` → `scheduleGlobalRefresh` ist debounced, aber `refreshGlobalPointsImmediate`/verschachtelte Aufrufe können sich überlappen.
**Evidence:** `refreshGlobalPoints` hat keinen Zähler-/Abort-Mechanismus; Zuweisung nach `await` ohne Gültigkeitscheck (Zeile 576). Vorhandene Audit-Muster (`previewEpoch`) existieren für Preview, nicht für Global-Map.
**Minimal Fix:** Generationszähler wie `previewEpoch` einführen; Ergebnis nur übernehmen, wenn Generation aktuell.
**Regression Test:** Simulierter globaler Provider mit verzögerter erster Antwort — absichtlich zweite fast → assert `globalPoints` entspricht zweiter Kamera.

---

## TEST GAPS

---

### TEST GAP 1 — Mehrere Queue-Items pro sampleId werden nie getestet

Die gesamte E-P6-Suite verwendet pro Sample genau ein Queue-Item (Unit: je Item einzeln; e2e: `clear()` zwischen Szenarien). Die `enqueue`-Semantik „Re-Enqueue nach `failed` erlaubt" (publishQueue.ts:257-262) und das nie real prunierte `items[]` erzeugen Duplikate — und damit BUG #1. **Ein einziger E2E mit conflict→Re-Accept→success hätte den Bug gefunden.** Verdeckt, weil `publishStatusFor` selbst mit einem Item stets die Queue-Reihenfolgen-abhängigen Fälle aufruft. → Regressionstest aus BUG #1 verwenden.

### TEST GAP 2 — Restart/Hydration-Matrix (Fall A–E) nicht e2e/Unit abgedeckt

`reconstructPending` (usageAcceptance.ts:235-249) wird durch keinerlei Test mit einer echten `GlobalPublishQueue` in der UI geprüft. Insbesondere Fall C: konflikt/`failed`-Item ist rein in-memory → nach Restart verschwindet der terminale Zustand und `reconstructPending` re-enqueued das Sample als `pending` (Marker noch `pending`) → UI zeigt nach Neustart **"Pending"**, obwohl zuvor "Conflict" war. Das ist ein legitimer, aber ungetesteter Trade-off der Option-A-Durability (nur `pending|published` persistiert). Der Audit verifizierte die Übergänge logisch (A–E alle konsistent), aber es gibt keinen automatischen Beweis, dass Queue+Marker nach Restart nicht auseinanderlaufen.

### TEST GAP 3 — HTTP-Fehlerpfad Adapter → Queue → Projektion nie getestet

DUMMY: E-P6-Tests und Worker-Tests ignorieren den `!response.ok`-Pfad; BUG #3 wirkt unsichtbar. Es gibt keinen einzigen Test, der einen echten 4xx/5xx-`GlobalIndexError`-Body durch `browserAdapter` → `publishQueue.flush` → `publishStatusFor` schickt.

### TEST GAP 4 — Cap-Hit-Selection-Szenario nicht e2e-asserted

Die Tests decken Selection ≤ 8 ab, aber keiner prüft das UX-Verhalten beim 9. Klick (Bug #2). Playwright-Suite nutzt `multiselect-${id}`-Checkboxen; ein 9-Klick-Assert fehlt.

### TEST GAP 5 — UI-Senden → Nutzungsakzeptanz nicht verdrahtet (produktweiter Quiet-Bug auf der Kante)

**Status:** LIKELY BUG (High, Produktverhalten) / als Test-Gap schwer verifizierbar
**Location:** `src/ui/app.ts:938-958` (`sendToMachiniste`) vs. `src/main.ts:432` (`acceptUsageAndEnqueue` nur im POC-Diagnostics-Pfad)
Der **einzige** Produktions-Caller von `acceptUsageAndEnqueue` ist der „Machiniste Test"-Button im POC-Pfad (`main.ts`). Der aus dem SampleMap-UI montierten App (`app.sendToMachiniste`) fehlt der 16H-Acceptance-Schritt komplett: Nach einem UI-Send wird **kein** `globalPublish`-Marker geschrieben und **nichts** in `globalPublishQueue` enqueued → die E-P6-Fläche bleibt im echten UI-Ablauf für immer auf "None". Ob das bewusst in E-P4/16H verschoben wurde, lässt sich aus dem Repo nicht belegen — es ist eine große Lücke zwischen „Machiniste-Send mit Read-back" und „Usage-Acceptance → Publish". Ohne Fix ist E-P6 im produktiven UI-Teil funktionslos.

---

## NICHT-PROBLEME (geprüft, ok)

- **knownRecords/refreshSearch re-sync:** performt nur add/overwrite, nie delete → Focus/Selection bleiben auflösbar; keine Objektidentität wird woanders erwartet (nur `selectedRecords`/`focusedRecord`-Lookups); kein Destructiv-Pfad bei Publish-während-Search.
- **publishStatusFor-Matrix (single item):** pending/in-flight/retryable/succeeded/failed/cancelled × stored/already-known/conflict/rejected/temp-unavailable/keinOutcome × Marker pending/published/keiner — alle Kombis konsistent mit `publishQueue`-State-Machine; kein falsches published-override, keine falsche success-Ableitung aus conflict/rejected; `cancelled` fällt korrekt auf Marker zurück und erfindet keinen Terminal-State.
- **Focus≠Selection, Selection≤8 (außer Bug #2-Pfad), Publish verändert weder Focus/Selection/MapPosition/Classification noch AudioFeatures** — Publish liest nur `globalPublish`, `sendToMachiniste` nur selection.
- **Map/16Q:** Missing-V2 wird nie platziert; kein V1-Fallback; `mapPoints` nur über persisted mapPosition.
- **Audio/Preview:** `previewEpoch`/deselect-Reject-Guard vorhanden, objektiv korrekt; keine Audio-Persistenz.
- **Worker-Reason-Sprache:** zurückgegebene 200-Reasons (`conflict: …`, `validation-rejected: …`, `temporary-unavailable: …`, `rate-limited`) passen exakt auf die `publishStatusFor`-Hints.
- **Fall A–E** (Restart: pending/succeeded/retryable/conflict, published+altes pending): logisch konsistent; `published` überschreibt niemals stale pending.
- **Offline→Live:** statusübergänge konsistent (temporary-unavailable → retry → stored); kein Auseinanderlaufen von Persistenz, da Marker erst nach success auf published, sonst pending bleibt.

---

## VERDICT

- **Confirmed Bugs: 4** (High 1 · Medium 3)
- **Likely Bugs: 2** (#5 Medium/Low · UI-Send→Acceptance High/Likely)
- **Test Gaps: 5**
- **Critical: 0**
- **High: 2** (#1 confirmed, #5/LIKELY-UI-Send als Produktlücke)
- **Medium: 4**
- **Low: 0–1**

### Top 5 Risiken

1. **E-P6-Status dauerhaft falsch (Conflict/Success) nach Re-Publish** — BUG #1; erfordert kleinen Renderer-Fix + pünktliches Pruning. (Empirisch belegt.)
2. **UI-Send erzeugt keine Usage-Acceptance** → E-P6 im echten UI-Flow funktionslos (nur POC-Button schreibt Marker). Produktintegration offen. (High, LIKELY.)
3. **HTTP-Fehlerkinds gehen durch `String(e)` im Queue verloren** → Falschklassifikation + 3× sinnlose Retries bei permanenten Rejections; eskaliert bei OQ-9-Auth/Rate-Limiting. (Confirmed, Medium.)
4. **Cap-Hit-Selection: UI/State divergieren** (Checkbox checked≠selected, Focus ohne Render). (Confirmed, Medium.)
5. **Listener-/Lifecycle-Lecks bei Remount** (Harness + potentielle Mehrfach-Mounts) führen zu Doppel-Navigation und Re-Render des alten App-Snapshots. (Confirmed, Medium, Test-Infra.)

### Geprüfte Bereiche

- **Persistence:** globalPublish-Marker-Roundtrip, reconstructPending, Restart-Fälle A–E, leere/malformed DB ✔
- **Hydration:** mapVersion-Guard, kein V1-Fallback, idempotent ✔
- **Map:** V2-autoritativ, Missing-V2 → kein Punkt, kein On-Read-Rekompute, Camera runtime-only ✔ (Race #5 offen)
- **Search/Filter/Sort:** Kombinationen, kein Selection-Mutate, sort stable ✔
- **Focus/Selection:** Focus≠Selection ✔ (Cap-Bug #2)
- **Audio/Worker:** Preview-Epoch-Guard, echte Readback-Verifikation (isSendSlotAccepted/isPocAccepted) ✔, Worker 19/19 ✔
- **Machiniste:** read-back matched, partial errors ✔ (UI-Acceptance-Lücke #5)
- **Global Publish / E-P6 UI:** exhaustive State-Matrix + Doppel-Item-Fall, HTTP-Fehlerpfad, Restart-Matrix ✔ (Bugs #1/#3, Gaps 1–4)
- **Async/Race:** search out-of-order (LOW, kein Gegenbeweis), refreshGlobalPoints (#5), preview ✔
- **Responsive/A11y:** unverändert, kein neuer Befund

**Empfohlen:** BUG #1 und #2 sind klein und UI-lokal — direkte Fix-Kandidaten. BUG #3 braucht nur eine Error-Kind-Extraktion. BUG #4 und die UI-Send→Acceptance-Lücke (#5-LIKELY) sollten vor einem produktiven Roll-out von E-P6 entschieden werden.