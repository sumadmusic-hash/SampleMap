# STEP19A — E-P7 One-Time Consent Implementation Report

| | |
|---|---|
| **Step** | STEP19A (V1 closing item — follows STEP19, Layer-C live closure) |
| **Verdict** | **E-P7 PASS — ONE-TIME CONSENT IMPLEMENTED AND VERIFIED** |
| **Date** | 2026-09-06 |
| **Environment** | macOS, System-Chrome 152.0.7977.77, `@audiotool/nexus@0.0.17` |
| **Baseline** | STEP19: tsc 0 · App 666/666 · Worker 19/19 · E2E 64/64 · Build PASS |

## §1 Scope & verdict

E-P7 (V1 boundary item, previously NOT_TESTED) is the **first `Add to Machiniste`**
usage-acceptance consent gate, specified by the single authoritative source
`FINAL_UI_UX_DESIGN_SPEC` §19.5. It is implemented at the controller seam
(`SampleMapApp.sendToMachiniste`), rendered as an accessible one-time modal, and
persisted as a **preference** via a namespaced localStorage key.

With the gate in place every guardable path of the V1 boundary is now internally
tested. **V1 is frozen**; no STEP20 follows (per the prior step reports).

Scope limits honored: no V2/redesign/refactor, no `SampleIndexRecord` change, no
audio-cache participation, no auth bypass, no automatic acceptance, no hidden
consent path.

## §2 Specification reference

`FINAL_UI_UX_DESIGN_SPEC` §19.5 (Usage-acceptance gate):

> On **first** `Add to Machiniste`, show a one-time, non-technical confirmation
> dialog: *Text (canonical):* `This adds references to audiotool samples in your
> Machiniste document. No audio is uploaded or copied from SampleMap.`
> *Primary:* `Continue` · *Secondary:* `Cancel`. This is a consent step
> (documented in STEP16R as a usage-acceptance gate), stored as a **preference
> thereafter**.

Consistent with `STEP16W_Post_Bug_Hunt_Fix_Report.md` §19.5 note: the consent
dialog is a one-time preference, **not** an auto-publish trigger behind the send
button.

## §3 Controller gate semantics (`src/ui/app.ts`)

State model (app-level, never attached to `SampleIndexRecord`):

- **NOT_GRANTED** (default; also the safe default when no store is provided) →
  `sendToMachiniste` performs **zero** operations and raises `ep7ConsentRequired`, suspending the exact call.
- **Accept** (`grantEp7Consent`) → persists the preference (write must succeed)
  → closes the dialog → resumes the suspended send **exactly once**.
  Persistence failure → consent stays un-granted, dialog stays up with an alert error; the action never runs on an unstored consent.
- **Cancel / Escape / deny** (`denyEp7Consent`) → drops the pending send
  (**zero** continuation), grants nothing; a later attempt re-raises the dialog.
- **GRANTED** (persisted) → subsequent sends proceed with no dialog (one-time).

Guards:
- **Selection before consent:** with no selection the send short-circuits to
  `"no sample selected"` *before* the gate — the pre-existing 16M-14 behavior is
  preserved even in an un-granted store.
- **No stacking:** while a dialog is up, repeat triggers are ignored.
- **No implicit consent:** consent is inferred from nothing — not from
  authentication, session, a previous send/analyze/publish, or any hidden path.
  `grantEp7Consent()` is only ever invoked by the user accepting.

The storage read is a **strict sentinel** (`parseEp7ConsentValue`): only the
exact value `granted` counts; missing/malformed/drifted values always read as
NOT_GRANTED, so storage corruption can never silently re-grant consent.

## §4 UX / dialogue (`src/ui/render.ts` + `src/ui/samplemap.css`)

- Modal conversation: `role=dialog`, `aria-modal=true`, labelled
  (title) and described (canonical body) with ids.
- Copy matches §19.5 exactly:
  - Title: `Add to Machiniste`
  - Body (canonical): `This adds references to audiotool samples in your Machiniste document. No audio is uploaded or copied from SampleMap.`
  - Detail line discloses preference persistence: `This one-time acceptance is stored as a preference and can be changed later.`
  - Primary `Continue` (`ep7-consent-accept`), Secondary `Cancel` (`ep7-consent-cancel`).
- Focus handling: the app shell is `inert` while the dialog is up; focus moves
  into the dialog (safe Cancel default); `Tab` is trapped between the two
  actions; `Escape` performs Cancel; on close (accept **or** cancel) focus
  returns to the trigger (`machiniste-add`) and is kept there across the
  async send re-renders that otherwise drop focus to `<body>`.
- Uses the pre-existing `--z-modal: 70` design token (§34.7).

## §5 Persistence (`src/ui/ep7Consent.ts`, `src/ui/bootstrap.ts`)

- Key: `samplemap:e-p7:consent:v1` — namespaced + versioned (STEP mandates §12).
- Value: single exact sentinel `granted`; anything else = NOT_GRANTED.
- Store interface (`Ep7ConsentStore`):
  - `isGranted()` / `grant()` / `clear()` (clear = test/reset utility only, never auto-invoked).
- Factories: `createStorageEp7ConsentStore` (localStorage-backed — the real
  product path, wired in `buildBrowserDeps`) and `createMemoryEp7ConsentStore`
  (safe default when no store is injected; tests/harness).
- Reload survival is the bootstrap contract; E2E verifies the preference
  survives a **full page reload** through the real storage key.

## §6 Continuation (action derivation)

The guarded operation (`app.sendToMachiniste`, call sites: action-bar
`machiniste-add` at `render.ts` and send-panel `machiniste-send`) is **not**
executed before consent. On accept, the *exact* suspended call (machiniste id +
slot start, captured at click time) is performed; on cancel it is dropped. No
consent is ever derived from a previous operation.

## §7 Changed files

| File | Change |
|---|---|
| `src/ui/ep7Consent.ts` | **new** — sentinel, parser, store interface, storage + memory factories |
| `src/ui/ep7Consent.test.ts` | **new** — 8 unit tests (mode/strictness/persistence/storage) |
| `e2e/ep7-consent.spec.ts` | **new** — 6 E2E scenarios E-P7-01…06 |
| `src/ui/app.ts` | gate in `sendToMachiniste`, `grantEp7Consent`, `denyEp7Consent`, `performMachinisteSend` (private), deps `ep7Consent` + docs, state fields |
| `src/ui/render.ts` | `renderEp7ConsentDialog`, capture-restore-before-wipe, dialog block (inert/focus/Tab/restore-pin), `Escape` = deny while open |
| `src/ui/samplemap.css` | dialog styles (backdrop, card, actions, primary/secondary, error) |
| `src/ui/bootstrap.ts` | `ep7Consent: createStorageEp7ConsentStore(window.localStorage)` |
| `src/ui/app.test.ts` | mk() gains granted default store; **E-P7-01…07** controller tests |
| `src/ui/step16L.test.ts` | mkApp granted default store (`grantedEp7`) |
| `src/ui/globalMapIntegration.test.ts` | mkApp granted default store (`grantedEp7`) |
| `src/e2e/harness/main.ts` | localStorage-backed consent store + `__sm.ep7` controls (isGranted/grant/reset) |

## §8 Test results

**New unit tests (STEP19A):** `npm test`
```
src/ui/ep7Consent.test.ts .......... 8 passed
src/ui/app.test.ts (incl. E-P7-01…07) 80 passed
```
Controller coverage: dialog raised on first send with zero ops (01) · accept
persists + resumes exactly once + one-time thereafter (02) · cancel drops with
0 continuation + re-armed (03) · storage-write failure keeps consent un-granted,
dialog stays, action never runs (04) · no-selection short-circuits before gate
(05) · grant-without-pending idempotent / deny-without-dialog no-op (06) ·
granted apps never raise the dialog (07).

**New E2E (Playwright, real Chrome, offline harness):** `npx playwright test e2e/ep7-consent.spec.ts`
```
E-P7-01 first use → canonical dialog only, no send          PASS
E-P7-02 Cancel → no send, no persist, selection kept, re-armed dialog PASS
E-P7-03 Continue → send performed once, key persisted       PASS
E-P7-04 full reload → preference survives, no dialog again  PASS
E-P7-05 Escape → cancel, no new send, selection kept        PASS
E-P7-06 role/name/description, Tab trap, keyboard Continue,
        focus restored to Add after async send              PASS
```

## §9 Regression vs STEP19

| Suite | STEP19 baseline | STEP19A result |
|---|---|---|
| `tsc --noEmit` (npm run typecheck) | 0 | **0** |
| App vitest (`npm test`) | 666/666 | **681/681** (+15) |
| Worker vitest (`workers/d1-worker`) | 19/19 | **19/19** (unchanged) |
| Playwright E2E | 64/64 | **70/70** (+6) |
| `npm run build` | PASS | **PASS** (tsc + vite, only the pre-existing chunk-size warning) |

Legacy suites were kept green **without modification of their assertions**: the
shared unit rigs (`mk`, `mkApp` ×2) and the E2E harness pre-grant the consent
store, so the 64 existing E2E and the pre-existing send tests exercise the send.
The gate itself is asserted with deliberately un-granted stores and the
`__sm.ep7.reset()` harness control.

## §10 Invariants

- **Audio:** consent state carries no audio bytes; the gate delays the transfer,
  it does not copy/upload anything. `SampleIndexRecord` untouched.
- **Security audit:** credentials exposed = NO · committed = NO · production
  auth bypass = NO · automatic/consent-hidden acceptance = NO (accept requires an
  explicit user click or keyboard activation of `Continue`).
- **Preference semantics:** once granted, never re-asked; cancel grants nothing.

## §11 Evidence classification

| Item | Classification | Basis |
|---|---|---|
| Controller gate behavior | **REAL** | Unit + E2E against the actual `SampleMapApp` |
| Modal UI behavior in a browser | **REAL** | Playwright on System-Chrome vs the offline harness (`mountSampleMap` real) |
| localStorage persistence round-trip | **REAL** | E2E exercises `window.localStorage` across a full reload |
| `buildBrowserDeps` injected storage factory | **VERIFIED BY CONSTRUCTION** | shares the same `createStorageEp7ConsentStore` module that E2E exercises |
| Downstream authenticated Machiniste send | **BLOCKED (external)** | No credentialed browser session; recorded as EXTERNAL LIMITATION in STEP18/STEP19 — the consent *dialog* is fully testable without it (§17) |

---

*End of STEP19A report. V1 boundary criterion E-P7 is PASS; V1 is frozen.*