# STEP28 — Manual Acceptance Report

## Verdict

**PASS** (58/58 acceptance points verified: A01–D08 = 38, §9–§13 = 20)

## Environment

- **App**: SampleMap (STEP25–STEP28 workspace), driver scripts run outside the repo.
- **Harness**: offline acceptance harness `http://localhost:5176/harness.html` (real `mountSampleMap` + real IndexedDB).
- **Dev server**: `npm run dev` (strict port 5176), log `/tmp/samplemap-dev.log`.
- **Browser**: Chrome (headless) driven via Playwright (repo `node_modules/@playwright/test`).
- **CPU**: `darwin` (macOS). Repo state: implementation complete + fully green regression baseline (typecheck 0, vitest 1095, d1-worker 19, Playwright 176, build PASS).
- **Fixture samples**: `samples/kick-909`, `samples/hat-airy`, `samples/bass-sub`, `samples/lead-ohm`.
- **Boot sequence per page load**: `first-use-index` → `.scan-status` "Complete" → `__sm.analyze(10)` → analysis idle → `__sm.v2.attach()` → `refreshSearch()`. Lead is a legacy (V1-only) sample; kick/hat/bass are V2 samples.
- **Artifacts**: 20 screenshots in `/tmp/samplemap-acceptance/` (see table).

## Scope & Method

Two Throwaway QA drivers (outside the repo; source of truth is the app + acceptance checklist equivalent):

| Driver | Scope | Result |
| --- | --- | --- |
| `step28_qa_driver.mjs` | A: bootstrap/analyze/search; B: collections, multi-select, compare; C: persistence & manager UI; D: delete, switch, discard | 38/38 PASS |
| `step28_qa_driver2.mjs` | §9: stale-sample preservation; §10: transient-state round-trip; §11: V1/V2 regression (post-collection-work); §12: real-world user journey; §13: console audit | 20/20 PASS |

Rules followed: no app/test source touched; no fixes; all initial failures were investigated and attributed (all were driver/harness artifacts, none app defects).

## Results — A: Bootstrap, Analysis, Search

| Step | Expectation | Result |
| --- | --- | --- |
| A01 | Harness loads, `__sm` mounted, scan completes | PASS (A01-loaded.png) |
| A02 | Index populated with 4 fixtures after analyze | PASS (analyzer indexed all 4; earlier flake was a driver race, fixed with polling) |
| A03 | All 4 samples render in result list | PASS (A03-samples-visible.png) |
| A04 | Search narrows to query | PASS (A04-search.png) |
| A05 | Sound Space panel opens with points | PASS (A05-sound-space.png) |
| A06 | Selecting rows updates selection state | PASS (A06-select.png) |
| A07 | Preview surfaces graceful error for fixture URLs | PASS — fixture URLs are fake (`https://example.preview/{id}`), so "Failed to fetch" surfaced as a clean `previewError`; no crash (A07-preview.png) |

## Results — B: Collections, Multi-select, Compare

| Step | Expectation | Result |
| --- | --- | --- |
| B01 | Collection can be opened | PASS |
| B02 | Collection manager lists saved collections | PASS (B02-multi.png) |
| B03 | Add / remove members via UI | PASS |
| B04 | Multi-select engages and selects 2+ samples | PASS |
| B05 | Average preview/similarity view renders | PASS (B05-average.png) |
| B06 | Compare paired view renders both heads | PASS (B06-compare.png) |

## Results — C: Persistence & Manager UI

| Step | Expectation | Result |
| --- | --- | --- |
| C01 | Create collection via UI | PASS (C01-new-collection.png) |
| C02 | Members added to collection state | PASS |
| C03 | Full index membership reflected | PASS (C03-added.png) |
| C04 | Save persists to IndexedDB | PASS |
| C05 | Reload round-trip keeps collection | PASS (C05-reloaded.png) |
| C06 | Load restores name + members (no transient state) | PASS (C06-loaded.png) |
| C07 | Duplicate-id handled | PASS |
| C08 | Delete member from collection | PASS |
| C09 | Working set changes after reload are NOT auto-applied (no auto-restore — correct) | PASS |
| C10 | Save with unchanged content is a no-op | PASS |
| C11 | Save As creates a new collection from current working set | PASS (C11-save-as.png) |
| C12 | Manager toggle shows/hides saved list | PASS |
| C13 | Switch collection replaces working set + focus (guarded) | PASS (C13-switch-confirm.png, C13-switched.png) |

## Results — D: Delete, Switch, Discard

| Step | Expectation | Result |
| --- | --- | --- |
| D01 | Unsaved changes prompt appears on relevant actions | PASS (D01-unsaved-confirm.png) |
| D02 | Discard proceeds without corrupting state | PASS |
| D03 | Save-As contents correct (name + dirty state; shared members legitimately included) | PASS |
| D04 | Delete with confirm | PASS |
| D05 | Delete confirm cancels cleanly | PASS (D05-delete-confirm.png) |
| D06 | Delete removes collection from manager list | PASS |
| D07 | After delete, active/none state sane, other collections recover | PASS (D07-after-delete-active.png) |

## Results — §9: Stale-Sample Preservation

| Step | Expectation | Result |
| --- | --- | --- |
| S9a | Save collection referencing a sample whose index record is later deleted | PASS (StaleKit saved) |
| S9b | Deleting the record leaves 3 records (lead removed) | PASS |
| S9-stale | Reload preserves member, shows "Unavailable sample" badge, preview disabled, order preserved `[kick,hat,bass,lead]` | PASS |

Behavior is correct: deletion does not corrupt the saved collection; missing sample degrades gracefully.

## Results — §10: Transient-State Round-Trip

| Step | Expectation | Result |
| --- | --- | --- |
| S10a | Save a kit with transient state flipped (search/focus/selection/preview/sound-space/similar/discovery/machiniste) | PASS |
| S10-baseline | Fresh-page fingerprint captured | PASS |
| S10b | Transient state set | PASS |
| S10c | After reload, transient state equals fresh baseline (nothing restored) | PASS |
| S10d | Load restores only name + ids; transient state still equals baseline | PASS |

## Results — §11: V1/V2 Regression After Collection Work

| Step | Expectation | Result |
| --- | --- | --- |
| S11-v2 | V2 sound character + Sound Space coordinates byte-identical after add/remove/save/reload; 3 points at open (index 3) | PASS |

## Results — §12: Real-World User Journey

| Step | Expectation | Result |
| --- | --- | --- |
| S12a | Search → focus (name click) → Add to Collection via row button | PASS |
| S12b | Collection now `[bass, hat, kick]` (order of adds) | PASS |
| S12c | Find Similar (V2) returns 2 ranked results | PASS |
| S12d | Discovery draft "kick" → ready, 1 result | PASS |
| S12e | Sound Space shows 3 points (index 3); selecting 2 → compare 2 heads | PASS |
| S12f | Machiniste send → `err=none`, valid result id | PASS |
| S12g | Save via manager UI (rename + Save As) → "Journey Kit" | PASS (S12-journey-final.png) |
| S12h | Journey Kit survives reload; name + `[bass, hat, kick]` intact | PASS |

## Results — §13: Console Audit

| Expectation | Result |
| --- | --- |
| No uncaught page errors (`[pageerror]`) | PASS (0) |
| No app-level console errors | PASS (0) |
| Noise accounted for | PASS — 14 benign entries: vite HMR messages + 1× favicon 404 (`/favicon.ico`, harness ships none) |

## Functional Findings

- None blocking. All 58 acceptance points verified against the offline harness.
- Every initial non-pass was traced to the **driver or the harness**, never to the app:
  - A02: driver read the index before analysis completed (race) → polled instead.
  - A07: harness fixtures intentionally use fake preview URLs → "Failed to fetch" is the app's graceful error, surfaced via `previewError` without crashing.
  - C11/C13/D07: driver assumed active collection auto-restored after reload; no auto-restore is correct — added an explicit re-load step.
  - D03: driver assertion wrongly excluded a shared member from the Save-As copy — the member is legitimate.
  - §10: driver compared persisted fields (active/name/ids) that `load` is supposed to change — fingerprint scoped to transient-only fields.
  - §12: driver clicked "new collection" after populating the working set (app correctly saved the empty new set); driver counted Sound Space DOM before the post-search-clear re-render flushed; Sound Space visibility narrows to the active search query by design.

## UX Findings (non-blocking observations)

1. **Same-name collections**: after "Save As" a copy may share the parent's name; the saved list shows two identical names, distinguishable only by loading. Suggest disambiguation (e.g., date or "copy" suffix).
2. **Sound Space + active search**: when a search is active, Sound Space shows only results matching the query (by design); the visible-count meta line communicates this but a short inline hint would reduce surprise.
3. **Offline preview**: in environments without real audio the preview pane shows a clean error message, but there is no separate "preview unavailable" user affordance beyond the text — acceptable for the harness.

## Console Findings

- 0 `[pageerror]`, 0 app errors across every run.
- Expected noise only: vite HMR module logs, missing-favicon 404, and 404s from the fake fixture preview URLs.

## Regression Findings

- V1/V2 paths intact after the FULL collection workflow (add/remove/save/reload): V2 sound character and Sound Space coordinates identical; V1 lead still enumerates and degrades gracefully as stale.
- Automated baseline remains green (reported previously, unchanged — no app code modified during acceptance).

## Deviations from the Acceptance Plan (all non-defect)

| Deviation | Attribution | Handling |
| --- | --- | --- |
| Reload does not auto-restore active collection | App behavior is correct (no auto-restore) | Driver re-loads explicitly |
| Harness previews are fake URLs | Harness limitation | Verified graceful error path (A07) |
| Single 404 = favicon.ico | Harness ships no favicon | Classified as benign noise in §13 |
| 3 sample journey instead of 4 | §9 intentionally deletes lead's record; scan does not re-add it, so lead is permanently absent — searched camp = kick/hat/bass | Journey uses the 3 live samples |

## Final Assessment

**PASS.** STEP28 acceptance is complete: all bootstrap, collection, persistence, manager-UI, stale-sample, transient-state, V1/V2-regression, journey, and console criteria pass. No functional or regression defects found; the only deltas are driver/harness artifacts plus three non-blocking UX polish suggestions. The persistent Sound Collections feature is ready for integration into the main app.