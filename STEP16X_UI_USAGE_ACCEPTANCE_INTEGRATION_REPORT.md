# STEP16X — UI → Usage Acceptance Integration Report

**Datum:** 2026-09-06
**Typ:** Read-only Architektur- & Call-Graph-Check (keine Code-/Test-/Architekturänderung)
**Scope:** `SampleMap UI → Send to Machiniste → verifizierter Read-back → Usage Acceptance → Publish`
**Verifikation:** Alle Aussagen aus dem aktuellen Quellcode an `file:line` belegt; keine Annahmen aus Funktionsnamen.

> **Zentrale Korrektur ggü. STEP16W-P0:** Der aktuelle Stand enthält die UI-Acceptance-Seam
> bereits vollständig. `acceptUsageAndEnqueue()` wird NICHT nur vom POC-Pfad (`main.ts`) gerufen —
> der echte Produktionspfad liegt in `src/ui/app.ts:1001`. Die STEP16W-Formulierung
> „einziger Produktions-Caller = POC-Diagnostics-Pfad" ist mit dem aktuellen Stand überholt
> (Details in §3/§4/§5).

---

# 1. Actual Production Call Graph

## 1.1 Der reale Produktionspfad ab `sendToMachiniste()`

Produktions-Mount: `src/main.ts` → `mountLiveSampleMap` (`main.ts:174`) → `mountAuthenticated`
(`src/ui/main.ts:27`) → `buildBrowserDeps` (`src/ui/bootstrap.ts:87`) → `mountSampleMap`
(`src/ui/render.ts`) → gerenderte Aktionsleiste/Send-Panel.

```text
[User] "Add to Machiniste" (action-add-btn) / Send-Panel (machiniste-send)
  render.ts:271-288 / render.ts:1029-1031
   │  Caller: DOM-Button → app.sendToMachiniste(id, slotStart)
   ▼
1. Sample-Auswahl ─────────────────────────────────────────────────────────────
   File/Fn:     src/ui/app.ts:953-954  sendToMachiniste()
   Caller:      render.ts Button-Handler
   Callee:      this.selectedRecords (Selektion 0..MAX_BATCH_SLOTS=8, nie Fokus)
   Implementation: pool = selectedRecords; batch = pool.slice(0, 8);
                  ids = batch.map(r => r.sampleId); slots = slotStart+i
   ▼
2. Send-to-Machiniste ─────────────────────────────────────────────────────────
   File/Fn:     src/ui/app.ts:966   →  this.deps.machiniste.send(...)
   Callee:      src/machiniste/machinisteService.ts:111  SampleMapMachinisteService.send()
   Produktion:  bootstrap.ts:164  deps.machiniste = new SampleMapMachinisteService(opts.doc)
                (doc = real geöffnetes SyncedDocument aus openFirstProject)
   ▼
3. Nexus Entity Creation / Sample Reference ──────────────────────────────────
   File/Fn:     machinisteService.ts:158-174  doc.modify(...)
   Caller:      send()
   Callee:      Nexus-Document: t.create("sample", {sampleName, uploadStartTime})
                + t.update(channel.fields.sample, sampleEntity.location)
   Fakten:      Direkt-Referenz `samples/{uuid}`; KEINE Audio-Bytes, kein Upload/Kopie
                (Machiniste-Service-Kommentar L16-35); EIN atomarer Commit für das Batch
   ▼
4. Read-back / Verification ───────────────────────────────────────────────────
   File/Fn:     machinisteService.ts:191-230  resolveMachiniste + doc.queryEntities
   Caller:      send() nach dem Commit (kommittierter Zustand, nicht „send returned")
   Prüfung/Slot: channel.sample.entityId === erzeugte EntityId  ∧
                Sample-Entity existiert  ∧ sampleName === geschriebene Referenz
   ▼
5. Erfolgskriterium (16G §6 Success Boundary) ─────────────────────────────────
   File/Fn:     src/global/usageAcceptance.ts:80-89  isSendSlotAccepted(result, sampleId)
   Forderung:   result.committed === true ∧ result.errors.length === 0 ∧
                slot.applied === true ∧ slot.readBackMatches === true ∧ slot.errors.length === 0
   ▲ Alle Schritte 1-5 sind UNVERÄNDERT (16G: "16H sollte diese Rückgabewerte so konsumieren")
   ▼
6. Rückkehr in den UI/App-State ───────────────────────────────────────────────
   File/Fn:     src/ui/app.ts:966-981  sendToMachiniste()
   Aktion:      machiniste.lastResult = result (oder error); notify()
   Besonderheit: Acceptance-Fehler überschreiben den verified Transfer NICHT (app.ts:974-980)
   ▼
7. mögliche Usage-Acceptance ──────────────────────────────────────────────────
   File/Fn:     src/ui/app.ts:993-1009  recordVerifiedUsage(result, ids)
   Caller:      sendToMachiniste (await, Zeile 975)
   Callee:      acceptUsageAndEnqueue({index, queue}, {kind:"send", sampleId, result})
                src/ui/app.ts:1001  →  src/global/usageAcceptance.ts:132
   Gate:        deps.index && deps.globalPublishQueue (app.ts:997)
   Produktion:  deps.index = IndexStore (immer, bootstrap.ts:108)
                deps.globalPublishQueue = GlobalPublishQueue(provider) wurde von main.ts
                via mountAuthenticated→buildBrowserDeps verdrahtet (main.ts:184-189 /
                bootstrap.ts:180). createGlobalProvider liefert IMMER eine Provider-Instanz
                (live-Adapter ODER offlineProvider, liveProvider.ts:83-105) → Queue ist im
                normalen, authentifizierten Run gesetzt.
   ▲ Dies ist die reale UI-In-Produktion-Seam — der Kern des STEP16X-Checks.
   ▼
8. mögliche Queue-Erstellung ──────────────────────────────────────────────────
   File/Fn:     usageAcceptance.ts:152-158
   Callee:      createPublishCandidate(record) (src/global/publish.ts) → GlobalPublishQueue.enqueue(candidate)
                → index.put({...record, globalPublish:{usageAcceptedAt, delivery:"pending"}})
   Fakten:      nur bei status==="analyzed" + sampleId-level Marker; "duplicate" ist idempotent
   ▼
9. möglicher Publish-Flush ────────────────────────────────────────────────────
   NICHT im UI-Pfad. (Details §2/§4) UI-enqueued Items bleiben "pending" (offline-first-first-class)
   ▼
10. E-P6 Status Reflection (read-only) ────────────────────────────────────────
   File/Fn:     src/ui/render.ts:861-892  "Global Publish"-Block
   Callee:      newestPublishItem(queue.snapshot(), sampleId) (view.ts:460) →
                publishStatusFor(marker, item) (view.ts:488) → publishStatusLabel (view.ts:515)
   Verhalten:   Nach UI-Send+Acceptance: Marker pending + Item ohne Outcome → "Pending".
                Nie-accepted: → "None". Queue wird nie mutiert (reiner Selektor/Projektion).
```

## 1.2 Kleinste Bausteine (Kalldaten)

| # | Schritt | Datei:Fn | Caller | Callee | Produktionspfad |
|---|---------|----------|--------|--------|----------------|
| 1 | Selektion | `app.ts:953-964` | render.ts Button | `selectedRecords` | UI live |
| 2 | Send | `app.ts:966` | sendToMachiniste | `machinisteService.ts:111` | UI live |
| 3 | Entity/Ref | `machinisteService.ts:158-174` | send() | `doc.modify` | UI live |
| 4 | Read-back | `machinisteService.ts:191-230` | send() | `doc.queryEntities` | UI live |
| 5 | Erfolgskriterium | `usageAcceptance.ts:80-89` | recordVerifiedUsage | `isSendSlotAccepted` | wiederverwendet |
| 6 | App-State | `app.ts:966-981` | sendToMachiniste | machiniste.lastResult/error | UI live |
| 7 | Acceptance | `app.ts:1001` | recordVerifiedUsage | `acceptUsageAndEnqueue` | **UI live** |
| 8 | Queue | `usageAcceptance.ts:152-158` | acceptUsageAndEnqueue | createPublishCandidate→enqueue→marker | UI live |
| 9 | Flush | `main.ts:438` | runMachinisteTest (POC-Button) | `flushPendingPublications` | nur POC-Diagnostics |
| 10 | E-P6 | `render.ts:861-892` | Renderer | newestPublishItem/publishStatusFor | UI live (read-only) |

---

# 2. `acceptUsageAndEnqueue()` vollständig verfolgen

## 2.1 Call-Graph

```text
acceptUsageAndEnqueue (src/global/usageAcceptance.ts:132)
 ├── src/ui/app.ts:1001        PRODUKTION — echter UI-Send-Pfad (recordVerifiedUsage, kind:"send")
 ├── src/main.ts:432           PRODUKTION — POC-Diagnostics-Seam (Machiniste-Test-Button, kind:"poc")
 └── src/e2e/harness/main.ts:562  nur E2E (Tm.publish.accept)

createPublishCandidate (src/global/publish.ts)
 ├── usageAcceptance.ts:152    (acceptUsageAndEnqueue)
 ├── usageAcceptance.ts:244    (reconstructPending)
 └── Tests (publish.test.ts)

flushPendingPublications (usageAcceptance.ts:217)
 ├── src/main.ts:438           PRODUKTION — NUR POC-Diagnostics-Seam
 └── src/e2e/harness/main.ts:579  nur E2E
 └── KEIN UI-/App-Caller

reconstructPending (usageAcceptance.ts:235)
 ├── src/main.ts:115           PRODUKTION — Boot (idempotentes Re-Enqueue von pending, KEIN Flush)
 └── src/e2e/harness/main.ts

markDelivered (usageAcceptance.ts:189)
 └── ausschließlich via flushPendingPublications
```

## 2.2 Antwort auf die Frage „Ist `src/main.ts` der einzige Produktions-Caller?"

**Nein — das ist mit dem aktuellen Stand nicht mehr richtig.**

- Der **echte Produktions-Caller der UI** ist `src/ui/app.ts:1001` innerhalb
  `recordVerifiedUsage` (`src/ui/app.ts:993-1009`): jeder per `sendToMachiniste` verifizierte
  Slot (16G-Boundary via `isSendSlotAccepted`) wird automatisch akzeptiert und enqueued —
  sobald `deps.index` und `deps.globalPublishQueue` beim Mount gesetzt sind (Normalfall im
  authentifizierten Browser-Run; `createGlobalProvider` wirft nie → immer eine Queue).
- `src/main.ts:432` ist ein **zweiter, bewusst getrennter Produktions-Caller** im
  POC-Diagnostics-Pfad (`runMachinisteTest`, „Machiniste Direct-Reference Test", `kind:"poc"`).
  Er ist Teil des POC/Diagnostics-Surface (Console-Log-Block), NICHT des SampleMap-UI-Flows.
- `src/e2e/harness/main.ts:562` ist nur E2E (nicht Produktion).

**Konsequenz:** Die STEP16W-P0-Begründung („Acceptance gehört zu einem späteren App-Layer-
Schritt, weil kein UI-Caller existiert") ist damit faktisch überholt — der App-Layer-Aufruf
EXISTIERT bereits. Was bewusst offen bleibt, ist nicht die Acceptance selbst, sondern:
(a) der **Delivery-Flush** von UI-enqueued Items (nur POC-Seam flusht) und (b) die
**§19.5-Ersteinwilligung** (Dialog/Preference). Details §4–§6.

---

# 3. Specification Evidence

| Dokument | Aussage | Konsequenz für heutigen Stand |
| -------- | ------- | ----------------------------- |
| `STEP16G_DESIGN.md` §2.5 | „no call site in `main.ts`, `src/ui/`, or `src/cli.ts` that enqueues or flushes a publish … 16H establishes the publish seam AND the gate together" | Zustand ZUM DESIGN-ZEITPUNKT. Heute: Seam existiert (16H) **und** ist in die UI verdrahtet (`app.ts:1001`). |
| `STEP16G_DESIGN.md` §4/§5/§6 | V1 binär: Usage-Accepted nur nach *real erfolgreichem* Machiniste-Transfer; Boundary = `send()`-Rückgabe (committed ∧ readBackMatches ∧ errors==0) | Implementierung identisch (`isSendSlotAccepted`/`acceptUsageAndEnqueue`, usageAcceptance.ts). |
| `STEP16G_DESIGN.md` §7 | „Enqueue happens only after acceptance; **flush only when a provider is available** (the existing queue is offline-first)" | Enqueue-Disziplin erfüllt. Flush bewusst getrennt vom Send-Klick; offline-first pending first-class. |
| `STEP16G_DESIGN.md` §12 | Gate ist ein *Produkt*-Gate (usage), kein Authentication-/Consent-Gate; OQ-9 bewusst offen | Kein expliziter Per-Use-Consent gefordert — siehe aber `FINAL_UI_UX_DESIGN_SPEC §19.5` (einmaliger Dialog). |
| `STEP16H_IMPLEMENTATION.md` §4/§8/§11 | Seam in `main.ts` `runMachinisteTest`; **„Real global delivery … live worker provider … NOT VERIFIED"**; live-Adapter war NICHT verdrahtet | Konsistent mit heutigem Stand: Delivery bleibt POC-/offline-Pfad; die UI-Acceptance-Seam wurde später ergänzt (`app.ts`), der Flush jedoch nicht mit. |
| `STEP16R_PRODUCT_UX_SPEC.md` — 16R DECISIONS #9 | „Global publish is a strict 7-step semantic chain; transfer ≠ publication; publishing is gated on verified usage acceptance; **offline-first pending is a first-class state**; publish-status surface = E-P6" | Eingehalten: E-P6 read-only Surface spiegelt pending; Transfer≠Publish bleibt. |
| `STEP16R_PRODUCT_UX_SPEC.md` FLOW 10 | „Global publish after verified usage (**human-confirm**): ≈ `acceptUsageAndEnqueue` … (main.ts/runMachinisteTest path); live worker → 7 steps; offline → pending, re-queued via reconstructPending. Human step: one authenticated Layer-C run." | Sprachlich auf den POC-Pfad bezogen; die heute existierende UI-Seam macht den impliziten Teil bereits — Delivery + Layer-C-Verifikation bleiben roadmap (E-P7). |
| `STEP16R_PRODUCT_UX_SPEC.md` §14.1 | „current GUI is a **functional / technical proof-of-concept**, NOT the final design; the Final UI/UX Design phase owns all visual styling …" | §19.5-Dialog ist ein Increment der Final-UI-/App-Phase, kein Bestandsdefizit. |
| `FINAL_UI_UX_DESIGN_SPEC.md` §19.5 | „On **first** `Add to Machiniste`, show a one-time, non-technical confirmation dialog … **This is a consent step** (… usage-acceptance gate), **stored as a preference thereafter**" | **NICHT implementiert.** Kein Dialog/Preference in `app.ts`/`render.ts` (Grep: consent/dialog/continue/preference → keine Treffer). Automatik hinter Send existiert, der Ersteinwilligungs-Dialog fehlt. |
| `STEP16R_SP E-P6/E-P7` | E-P6 = Publish-Status-Surface (done, `STEP16U`); **E-P7 – Human Layer-C closure**: ein authentifizierter OAuth-Run FLOW 1 + FLOW 10 end-to-end; BLOCKED/verifikatorisch | Der definierte spätere Schritt, der die Integration inkl. Delivery im produktiven Run schließt. |
| `STEP16R_SPEC.md` §14.3-Open (OQ-7) | Worker/D1-Produktionsstate + „global-publish UX (gated on usage acceptance) is specified, and its **production contingency … is Open**" | Live-Delivery-Kontingenz offen; kein finaler Produktions-Publish-Status derzeit definiert. |
| `STEP16V/W` | P0-Audit: „UI-Send erzeugt keine Usage-Acceptance; einziger Produktions-Caller = POC" | **Überholt** (siehe §2.2): `app.ts:1001`-Seam existiert heute. |

Geltung der späteren Dokumente: Die Automatik hinter dem UI-Send entspricht STEP16G (V1-Policy);
`FINAL_UI_UX_DESIGN_SPEC §19.5` konkretisiert die Consent-Frage als *einmalige* dialoggestützte
Präferenz — gilt, ist aber der Final-UI-Phase/App-Layer zugeordnet (nicht V1-Bestand).

---

# 4. Current User Flow

```text
[Authentifizierter Browser-Run]  main.ts
  ├─ publishQueue + publishIndex bootstrap (main.ts:104-126)   → Queue ist verdrahtet
  ├─ mountLiveSampleMap → mountAuthenticated (real UI)         (main.ts:184-189)
  └─ runSamplePoc (POC-Diagnostics, parallel, Console-Log-UI)

── UI-User-Flow (real) ─────────────────────────────────────────────────────────
  Selektion (0..8) ─► Add to Machiniste (render.ts) 
     └► sendToMachiniste (app.ts:953)
         └► MachinisteService.send (machinisteService.ts:111)   atomarer Commit
             └► Read-back pro Slot (queryEntities)               verified
                 └► recordVerifiedUsage (app.ts:993)             Seam
                     └► acceptUsageAndEnqueue (app.ts:1001)
                         ├─ createPublishCandidate → queue.enqueue
                         └─ index.put(marker {pending})          Offline-first
                             └► refreshSearch (app.ts:1008)      NYI: E-P6-Rückfluss
                                 └► E-P6 „Global Publish"-Block: Status "Pending", 
                                    Delivery entsprechend live/offline

── Delivery / Publish (aktuell NUR POC-Diagnostics) ────────────────────────────
  [Machiniste Direct-Reference Test] (main.ts:361-467)
     └► loadLibrarySampleIntoMachiniste → acceptUsageAndEnqueue(kind:"poc") (main.ts:432)
         └► flushPendingPublications (main.ts:438) → queue.flush → worker/D1 bzw. offline
             └► markDelivered → marker "published"

Endpunkt des realen UI-Flows: **verifizierter Transfer → Acceptance-Marker → Publish-
Candidate enqueued (pending), E-P6 zeigt "Pending".** Der Delivery-Flush ist NICHT Teil des
UI-Flows (bewusst, §2).

---

# 5. Usage Acceptance

* **Caller:** Produktion — `src/ui/app.ts:1001` (echter UI-Send-Pfad) UND `src/main.ts:432`
  (POC-Diagnostics-Seam); E2E — `src/e2e/harness/main.ts:562`.
* **Trigger:** Ein verifizierter Transfer-Slot (16G-Boundary: committed ∧ readBackMatches ∧
  applied ∧ errors==0), ausgelöst über den UI-Send; zusätzlich Gate `deps.index &&
  deps.globalPublishQueue` (im Normal-Run erfüllt). Failed/Read-back-failed → nicht akzeptiert.
* **Human consent:** **Automatisch** nach dem verifizierten Transfer (kein Dialog, keine
  Preference existieren im Code). Die aktuelle Spezifikation verlangt laut `FINAL_UI_UX_
  DESIGN_SPEC §19.5` einen **einmaligen Consent-Dialog beim ersten** `Add to Machiniste`
  (gespeichert als Preference) — **nicht implementiert**. STEP16G selbst (§5, §12) definiert
  die Acceptance rein maschinell-observabel und als Produkt-Gate (usage), ohne separaten
  Per-Use-Consent.
  **Einordnung:** Die automatische Acceptance entspricht 16G und der offline-first-Policy;
  der §19.5-Ersteinwilligungs-Dialog ist ein dokumentierter, noch nicht gebauter
  Human-/Final-UI-Increment (E-P7/App-Layer). Ein „expliziter Consent pro Nutzung" ist NICHT
  gefordert; die Automatik ist daher nicht per se spezifikationswidrig, aber sie läuft heute
  **ohne** die von §19.5 geforderte Ersteinwilligung.
* **Queue:** `queue.enqueue(candidate)` idempotent (sampleId-Dedup), Marker `delivery:"pending"`.
* **Publish:** NUR über `flushPendingPublications` — Produktion nur im POC-Button-Pfad
  (`main.ts:438`); UI-enqueued Items werden derzeit **niemals automatisch** an den Worker
  abgegeben (kein Auto-Flush in `app.ts`/`main.ts` außerhalb des POC-Buttons; Boot läuft nur
  `reconstructPending` = Re-Enqueue ohne Flush).
* **E-P6:** read-only Spiegel (`render.ts:861-892`). Nach UI-Send → "Pending"; nach
  provider-bestätigtem Flush (POC-Pfad) → stored/known/conflict/rejected/temporary-unavailable;
  nie-akzeptiert → "None".

---

# 6. E-P6 "None" — korrekt im normalen UI Flow?

**Ja, „None" kann aktuell korrekt sein und IST es:** `none` = *kein Publish-Zustand* —
nie usage-accepted, nie queued (`view.ts:396-397`). Für ein Sample, das nur analysiert,
aber nie erfolgreich transferiert wurde, ist „None" der ehrliche, spezifikationskonforme
Zustand (16G: analyse ≠ publish). Zustand, der „fehlt": Es gibt keinen Produktionspfad, der
einen UI-enqueued (pending) Item automatisch flusht, damit aus „Pending" ein provider-
bestätigter Zustand (stored/known) wird — real passiert das heute nur über den POC-Button
bzw. den Worker-Pfad (Kontingenz Open, E-P7/Layer-C). Die E-P6-Fläche selbst bleibt
**read-only** (purer Selektor `publishStatusFor`/`newestPublishItem`; render.ts mutiert die
Queue nicht) und darf NICHT zu einem Queue-Mutator werden.

---

# 5. Verdict

> **RESULT B — INTENTIONAL ROADMAP BOUNDARY**

**Genauer Endpunkt des User Flows heute:** UI-Send endet nach *verifiziertem Machiniste-
Transfer* mit **automatischer Usage-Acceptance + Publish-Candidate-Enqueue (pending)** und
E-P6-Reflexion „Pending". Der „kein App-Layer-Schritt vorhanden"-Fall aus der Fragestellung
liegt NICHT vor — der App-Layer-Aufruf (`app.ts:1001 → acceptUsageAndEnqueue`) ist da.

**Was bewusst offen geblieben ist (Roadmap, kein Bug):**
1. **Delivery des UI-Enqueuet:** kein Auto-Flush im UI-Pfad; `flushPendingPublications` läuft
   produktiv nur im POC-Diagnostics-Button (`main.ts:438`). Spec: offline-first pending ist
   first-class (16R #9), Flush nur bei verfügbarem Provider (16G §7), Live-Kontingenz „Open".
2. **§19.5-Ersteinwilligung:** einmaliger Consent-Dialog + Preference beim ersten
   `Add to Machiniste` — dokumentiert, nicht implementiert (Final-UI-/App-Layer-Increment).
3. **Humanverifikation:** produktiver „UI-Send → Acceptance → Queue → Worker-Publish in
   einem Stück" ist nur über einen authentifizierten Layer-C-Run prüfbar (E-P7, BLOCKED/16R #19).

Kein Code-Fix. E-P6 bleibt read-only und kein Queue-Mutator.

---

# 6. If Result B

> **Welcher zukünftige Schritt muss diese Integration übernehmen?**

- **E-P7 — Human Layer-C closure** (`STEP16R_PRODUCT_UX_SPEC.md` E-Phasenliste, L519-522): der
  definierte Schritt, der FLOW 1 + FLOW 10 **in einem authentifizierten Browser-Run**
  end-to-end ausführt. Er ist für die **Delivery-/Publish-Integration** des UI-User-Flows
  zuständig (App-Layer-Flush der UI-enqueueden Items gegen den konfigurierten Worker; Live-
  Roundtrip; Upgrade des PARTIALLY-REAL/BLOCKED-Status). Zusätzlich besitzt die **Final
  UI/UX-Phase / App-Layer** den **§19.5-Ersteinwilligungs-Dialog** (einmalige Consent-
  Preference vor dem ersten `Add to Machiniste`), gekoppelt an den Send-UX-Kosmos.
  Zwischen E-P7 und der UI-Flush-Verdrahtung: E-P7 ist die verifikatorische Klammer; die
  eigentliche App-Layer-Verdrahtung (Flush nach einem UI-Send-Batch bei Live-Provider) ist
  Teil derselben Folge-/Phase-Arbeit, solange die Live-Kontingenz (OQ-7) offen ist.

---

# 7. If Result C

Nicht anwendbar (Verdict = B). **Minimaler Integrationspunkt** (nur benannt, NICHT gebaut —
ausdrücklich kein Fix in STEP16X): nach einer erfolgreichen, akzeptierten UI-Send-Batch in
`app.sendToMachiniste` bei konfiguriertem Live-Provider `flushPendingPublications` aufrufen
(äquivalente Semantik wie `main.ts:432-451`, jedoch für den UI-Pfad mit `kind:"send"`-
Evidenz), plus die §19.5-Ersteinwilligungs-Gate. Erwartete Semantik: Acceptance bleibt
atomar-enqueue-first; Flush läuft idempotent (sampleId-Dedup); Markers upgrade pending→published
nur für provider-bestätigte Items.

---

# 8. Release Impact

> **Documentation / roadmap only**

Begründet, ohne „alles fertig"-Floskel: Der User Flow besitzt eine **bewusst offene
Integrationsgrenze** nach „Enqueue (pending)": Die produktive Abgabe an den Worker läuft
derzeit nur über den POC-Diagnostics-Pfad, die Live-Kontingenz ist per Spezifikation Open und
die Humanverifikation (E-P7/Layer-C) recorded-BLOCKED. Für den Spezifikationsstand
„offline-first pending ist first-class" (16R #9) blockiert diese Grenze V1 nicht — sie ist
Roadmap-/Dokumentations-Thema des nächsten Integrationsschritts (E-P7 + Final-UI-Phase).
Kein Gate, kein Test und kein Verhalten wird durch STEP16X verändert.