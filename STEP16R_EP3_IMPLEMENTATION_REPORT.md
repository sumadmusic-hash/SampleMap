# STEP16R E-P3 — Selection / Send Polish — Implementation Report

**Phase:** STEP16R E-P3 (Selection / Send Polish — UI/UX refinement only)
**Authority:** `STEP16R_PRODUCT_UX_SPEC.md` (FROZEN) · E-P0 PASS · E-P1 PASS · E-P2 PASS
**Author:** SampleMap build agent (big-pickle)
**Date:** 2026-09-05
**Verdict: `E-P3 PASS — SELECTION / SEND POLISH COMPLETE`**

---

## 1. Verdict

`E-P3 PASS — SELECTION / SEND POLISH COMPLETE`

All E-P3 requirements (E-P3.1 count presentation, E-P3.2 cap communication, E-P3.3
Add-to-Machiniste disabled affordance, E-P3.4 send-panel validation guidance, E-P3.5
accessibility) are implemented as copy/a11y/hint refinements only. No selection or send
**behavior** changed. All gates pass; the integrity manifest differs from the E-P2 baseline in
exactly the intended E-P3 files.

## 2. Changed files

| File | Status | Reason |
|---|---|---|
| `src/ui/view.ts` | M | `selectionCountLabel(count, max=8)` cap-aware copy; new pure const `SEND_PANEL_HINT` |
| `src/ui/render.ts` | M | pill aria-label; Add disabled `title`; checkbox aria-labels; send-panel aria/hint wiring |
| `src/ui/samplemap.css` | M | `.send-hint` added to the existing status-line font group (12px, secondary) — only change |
| `src/ui/view.test.ts` | M | E-P3 boundary tests (0/1/7/8), disabled-state copy, hint copy |
| `e2e/final-ui-phase1.spec.ts` | M | FP-01 / FP-04 / FP-05 updated to the new count-title copy (+ Add title, pill aria) |
| `e2e/ep3-select-send.spec.ts` | A | New EP3-01 / EP3-02 e2e (DOM + a11y + layout assertions, artifacts) |

No changes: `app.ts`, `machinisteService.ts` (`MAX_BATCH_SLOTS` untouched), `mapPosition.ts`,
`mapView.ts`, `mapRender.ts`, persistence, search, similarity, preview, audio, global, workers,
`scripts/*`, package/config files, or any spec/plan document.

## 3. Selection count changes (E-P3.1)

- The **single** action-bar surface (`selection-pill`, testid unchanged) remains the only
  counter, now with the whole range readable: pill text stays the clamped `N / 8`
  (`0 / 8` … `8 / 8`, never overshooting — unchanged `selectionPillLabel`).
- `selectionCountLabel` (the pill's `title`/`aria-label`, now with an explicit `max` parameter
  defaulting to `MAX_BATCH_SLOTS`, i.e. 8):
  - `0` → `No samples selected`
  - `1` → `1 of 8 selected`
  - `7` → `7 of 8 selected`
  - `8` → `8 of 8 selected (limit reached)`
  - overshoot (e.g. `20`) → still `8 of 8 selected (limit reached)` (clamped)
- The count is derived from the actual selection state (`app.selectedSampleIds.length` in
  `renderActionBar`); no second counter was introduced.

## 4. Disabled-state changes (E-P3.2 / E-P3.3)

- The cap is communicated **explanatorily**, never by changing selection semantics: at `8/8`
  the pill reads `8 of 8 selected (limit reached)` (`title` + `aria-label`), and the pill keeps
  its existing `is-maxed` visual treatment (unchanged CSS).
- The `Add to Machiniste` button (`machiniste-add`, testid unchanged) keeps its behavior
  (disabled ⇔ zero selected) and now carries the native-disabled explanation
  `Select at least one sample to add to Machiniste` (was `Select samples to add references to
  Machiniste`). When enabled it has no title. No auto-deselect of oldest/newest; the 9th
  attempt still fails exactly as before (controller-level rejection untouched, `app.test.ts:835`
  kept green).

## 5. Send-panel changes (E-P3.4)

- New visible guidance line `.send-hint` = `SEND_PANEL_HINT`:
  `The id must match an existing Machiniste; slots are numbered from the starting slot upward.`
- It states only constraints the existing pipeline already enforces (the id resolves in
  `MachinisteService.send`; `slots[i] = slotStart + i` — i.e. numbered upward from the entered
  start, with the `[0, channels)` bound enforced and surfaced as the existing error text). No new
  constraint was invented; the panel was not redesigned.
- The `Send (max 8)` label, `min="0"` slot input, `placeholder="Machiniste id"`, and all status
  strings (`Select samples above to send.`, `Selected: …`, error/success rendering) are unchanged.

## 6. Accessibility changes (E-P3.5)

All are additive attributes; zero `data-testid` changes.

- `selection-pill`: `aria-label` equal to `selectionCountLabel(n)` (accessible count meaning).
- Result-row checkboxes: `aria-label="Select <sample name> for batch"`.
- `machiniste-id` input: `aria-label="Machiniste id"`.
- `machiniste-slot-start` input: `aria-label="Starting slot"` + `title="Slots are numbered
  upward from this value"` (native `min="0"` preserved).
- `send-status` line: `role="status"` + `aria-live="polite"` (validation/error announcements).
- `Add to Machiniste`: accessible name from its visible text; disabled explanation via native
  `title`.

## 7. Tests added / changed

Unit (`src/ui/view.test.ts`, now 24 tests):
- `selectionCountLabel` copy: 0 / 1 / 7 / 8 / 20 / custom-max boundaries.
- `selectionPillLabel`: explicit 1 and 7 boundaries added to the existing clamp set.
- E-P3 block: `SEND_PANEL_HINT` exact copy + no German/dev tokens + length; explicit
  `[0,1,7,8] → ["No samples selected","1 of 8 selected","7 of 8 selected","8 of 8 selected
  (limit reached)"]`.

e2e:
- `final-ui-phase1.spec.ts` FP-01: pill `0 / 8` + aria `No samples selected` + Add disabled
  with the new title; FP-04/FP-05: pill titles now `2 of 8 selected` / `4 of 8 selected`
  (+ pill aria used as the count label).
- `ep3-select-send.spec.ts`:
  - EP3-01: real-DOM count 0/8 → 2/8 → 4/8 → 0/8, title/aria consistency, Add
    disabled⇔enabled + title presence/absence, screenshots `ep3-01-action-bar-selected.png`,
    `ep3-01-add-disabled.png`.
  - EP3-02: `.send-hint` visible with exact copy, `aria-label`/`min`/`title` on send controls,
    `role="status"`/`aria-live`, ≥4 checkbox aria-labels matching `Select … for batch`, no
    German/dev strings in `body`, no horizontal overflow, hint/status non-overlap bounding-box
    check, screenshot `ep3-02-send-panel.png`.
- The cap-9-invalid & cap-8-valid behavior remains covered by the untouched `app.test.ts:835`
  controller test (kept green — not weakened).

## 8. Full test counts

| Suite | Baseline (E-P2) | Now |
|---|---|---|
| App vitest | 580/580 (32 files) | **582/582 (32 files)** |
| App view.test.ts | 22 | 24 |
| Worker vitest (d1-worker) | 19/19 (2 files) | 19/19 (2 files) |
| Playwright | 29/29 | **31/31** |

## 9. TypeScript results

- App `tsc --noEmit`: **0 errors**.
- Worker `tsc --noEmit` (`workers/d1-worker`): **0 errors**.

## 10. Build result

`npm run build` (`tsc --noEmit && vite build`): **PASS** — 199 modules, CSS/JS emitted.
(Preexisting non-blocking advisory: `index-CW_2CgXS.js` > 500 kB after minification; unchanged.)

## 11. Playwright result

`npx playwright test` (system Chrome, headless, 1 worker, harness.html): **31 passed (17.5s)**.
Core reapplied after the final layout strengthening in EP3-02: `ep3-select-send.spec.ts` 2/2
passes; every other file is byte-identical to the green 31/31 run.

## 12. STEP16I live result

`npx tsx scripts/live-verify-16i.ts`: **11 VERIFIED, 0 NOT VERIFIED, 0 SKIPPED** (unchanged,
matches E-P0/E-P2 baseline).

## 13. STEP16M live result

`npx tsx --env-file=.env scripts/step16m-live-verify.ts`: **23 VERIFIED, 0 NOT VERIFIED**
(unchanged, matches baseline).

## 14. Frozen invariant verification

Verified unchanged (all still green, no source touched):
1. 16R product spec text untouched.
2. `mapPosition` / persisted V2 formula untouched.
3. No V1/V2 reprojection added.
4. Selection semantics unchanged (only display projections touched).
5. Cap = 8 (`MAX_BATCH_SLOTS` untouched); 9th rejected at controller; no auto-deselect.
6. Focus ≠ selection (FP-03 still passes).
7. Selection survives search / filter / sort / camera / zoom / hiding (tests untouched).
8. Existing selection toggles unchanged (checkbox onclick identical; aria added only).
9. Machiniste protocol unchanged (select → send → read-back → verified, `app.sendToMachiniste`
   untouched).
10. No audio-copy changes.
11. Read-back mandatory untouched (`machinisteService` untouched).
12. `SEND_PANEL_HINT` exposes only existing enforced constraints.
13. All `data-testid`s unchanged.
14. No global tokens / typography / responsive-architecture changes (one class added to an
    existing font group).
15. Map appearance/layout unchanged.
16. No E-P4 work started.
17. No redesign of any surface.
18. Projections stay pure; `SEND_PANEL_HINT` is a pure constant; all new copy is English.
19. No German/dev strings anywhere in the product copy (asserted in EP3-02 + unit hint test).

## 15. Visual / DOM QA

Screenshots were saved as E-P3 artifacts but this agent model has **no image input**, so visual
pixel inspection was unavailable (same limitation as E-P2). Compensation — programmatic DOM /
layout evidence collected in the real browser:
- Count pill text reads `0 / 8`, `2 / 8`, `4 / 8` and back to `0 / 8` in the live DOM, with
  `title` = `aria-label` = the count label at each step.
- Add button disabled → title present; enabled → no title (asserted both ways).
- `.send-hint` visible; `document.documentElement.scrollWidth − clientWidth ≤ 0` (no horizontal
  overflow, so `8 of 8 selected (limit reached)` / disabled state / hint cannot clip at the
  1280 px test viewport).
- Hint and status-line bounding boxes do not overlap vertically.
- ≥4 checkboxes each carry an accessible name; send/slot/id controls carry labels/titles.
- The harness point cloud holds 4 analyzed samples, so the exact `8/8` in-browser rendering is
  not reachable there; the `8/8` boundary is covered by the pure-projection unit tests
  (`8 of 8 selected (limit reached)`, `8 / 8`) and the unchanged controller cap test.

## 16. Out-of-scope confirmation

No modifications (verified by manifest diff or unchanged gates) to: `map/`, `mapPosition`,
media/DSP/ML, search/filter/similarity, persistence/caching, PreviewService, Worker, global
map/publication, OAuth, Machiniste service/protocol, responsive architecture, test IDs, the
core state machine, selection semantics, cap 8, or any spec/plan document. No E-P4 work exists.

## 17. SHA-256 integrity comparison vs E-P2 baseline

Baseline: `ep2-after.txt` (116 tracked files). Current manifest: `ep3-after.txt` (117).

Path-set diff: exactly one addition — `e2e/ep3-select-send.spec.ts`.
Content diff of tracked files: exactly the four intended E-P3 files —
- `e2e/final-ui-phase1.spec.ts`
- `src/ui/render.ts`
- `src/ui/view.test.ts`
- `src/ui/view.ts`

plus the non-manifest-tracked `src/ui/samplemap.css` (the manifest tracks only `.ts` under
`src/`). Every other tracked file (workers, scripts, map, machiniste, persistence, audio,
global, search, similarity, preview, configs) is byte-identical to the E-P2 state.
**No unexpected changes — integrity clean.**

## 18. Remaining non-blocking findings

- Pre-existing Vite chunk-size advisory (> 500 kB) — unchanged from E-P0/E-P2.
- `e2e/artifacts/test-results/.last-run.json` (45 B) — standard Playwright last-run marker.
- The exact `8/8` pill rendering is not exercised by the offline harness (4 analyzed points);
  covered at unit/controller level as documented in §15.
- `SEND_PANEL_HINT` is newly visible copy; it renders on a single line at the 1280 px test
  viewport and passed the overflow/non-overlap assertions.

---

**Verdict: `E-P3 PASS — SELECTION / SEND POLISH COMPLETE`** — stopping here. E-P4 is NOT
started.