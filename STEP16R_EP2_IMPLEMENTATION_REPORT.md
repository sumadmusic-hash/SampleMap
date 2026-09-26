# STEP16R — E-P2 Implementation Report (Copy + Labels)

**STEP**: STEP16R, E-P2 (Copy + labels pass)
**Status**: COMPLETE
**Type**: First implementation increment after the baseline lock. Scope strictly limited to
product-facing copy and labels. No core service, architecture, or semantics changed.

**Verdict: `E-P2 PASS — COPY + LABELS COMPLETE`**

Gate baseline (E-P0): tsc 0/0, app vitest 576/576 (32 files), worker vitest 19/19 (2 files),
`vite build` PASS, Playwright 28/28, 16I 11/11, 16M 23/23, 19 frozen invariants VERIFIED,
zero 16R product-source changes, Axis `SPEC BUG` record (design-spec §7.2) untouched.

---

## 1. Scope

Applied exactly the three E-P2 work items plus the mandated focused copy audit:

1. **E-P2.1 — Missing-V2 canonical copy.** The inspector "Map Position" line for a record
   without a persisted V2 position renders exactly `Map position unavailable`
   (16R DECISIONS #3/#15). Underlying Missing-V2 semantics unchanged — record still never
   renders a map point, is never re-positioned, and the publish guard is untouched.
2. **E-P2.2 — Remove German/dev-facing analysis labels.** The `Analysiert:` / `Fehler:` /
   `Verbleibend:` counters become final English product copy `Analyzed:` / `Failed:` /
   `Remaining:`. Counters and state untouched.
3. **E-P2.3 — Axis/map explanatory copy.** Plain-English orientation restatement per spec A3
   ("axis copy may be restated in plain English in tooltips/labels"): improved SVG `aria-label`,
   a native SVG `<title>` map tooltip, and a per-axis direction hint tooltip. The coordinate
   system, `computePosition`, `mapPosition.ts`, persisted positions, and projection math are
   untouched.
4. **Copy audit.** All user-visible strings in the audited surfaces (`render.ts`, `view.ts`,
   `mapRender.ts`) reviewed for dev wording, test wording, capitalization inconsistency,
   terminology inconsistency, accidental German, and raw implementation state names. The scan
   panel `Status: idle/scanning/done/error` (a raw state-name leak) was normalized to
   `Status: Idle/Scanning/Complete/Failed`. Everything else reviewed was left untouched with
   reasons (§8).

---

## 2. Changed Files

| File | Change |
|---|---|
| `src/ui/view.ts` | ADDED three pure copy projections: `mapPositionLabel`, `scanStatusLabel`, `analysisProgressLabels` (consistent with the existing `selectionCountLabel`/`resultCountLabel` pattern). |
| `src/ui/render.ts` | Inspector position line now delegates to `mapPositionLabel` (Missing-V2 → canonical copy); analysis counters use `analysisProgressLabels`; scan status uses `scanStatusLabel`. |
| `src/ui/map/mapRender.ts` | Improved map SVG `aria-label`; added native SVG `<title>` map tooltip; added per-axis `<title>` hints (NOISY left / TONAL right / BRIGHT top / DARK bottom). Axis labels themselves unchanged. |
| `src/ui/view.test.ts` | ADDED `describe("SampleMap view : STEP16R E-P2 canonical copy projections")` — 4 new tests. |
| `e2e/ep2-copy.spec.ts` | NEW Playwright spec (EP2-01) verifying the E-P2 copy in the real DOM. |
| `e2e/final-ui-phase1.spec.ts` | FP-02 scan-status assertion updated `"done"` → `"Complete"` (human label). |
| `e2e/step16m.spec.ts` | 16M-02 scan-status assertion updated `"done"` → `"Complete"` (human label). |

No core service under `src/map`, `src/audio`, `src/classify`, `src/persistence`, `src/pipeline`,
`src/search`, `src/machiniste`, `src/global`, `src/identity`, `src/similarity`,
`workers/d1-worker` was touched.

---

## 3. Copy Changes (Before → After)

| Location | Before | After |
|---|---|---|
| `render.ts` inspector position (Missing-V2) | `unavailable` | `Map position unavailable` |
| `render.ts` analysis progress | `Analysiert: ${n}` | `Analyzed: ${n}` |
| `render.ts` analysis progress | `Fehler: ${n}` | `Failed: ${n}` |
| `render.ts` analysis progress | `Verbleibend: ${n}` | `Remaining: ${n}` |
| `render.ts` scan status | `Status: ${rawState}` (`idle`/`scanning`/`done`/`error`) | `Status: Idle` / `Status: Scanning` / `Status: Complete` / `Status: Failed` |
| `mapRender.ts` map `aria-label` | `Sample map (noisy-tonal by dark-bright)` | `Sample map: noisy to the left, tonal to the right; dark at the bottom, bright at the top` |
| `mapRender.ts` (new SVG `<title>`) | — | `Sample map: noisier samples on the left, more tonal on the right; darker samples at the bottom, brighter at the top` |
| `mapRender.ts` (new per-axis `<title>` hints) | — | `NOISY (left)` · `TONAL (right)` · `BRIGHT (top)` · `DARK (bottom)` |

The existing non-German position formatting `X: 0.656  Y: 0.540` (3-decimal, two-space) is
preserved bit-for-bit; only the Missing-V2 branch changed. Persisted coordinates are read on
demand and never recomputed.

**Audit — reviewed and left unchanged (with reason):**
- `No analyzed samples yet.` / `No samples match your search.` / `No samples match your
  filters.` / `Global: unavailable (local map still works)` + the four other global-state
  labels — frozen canonical copy (DECISION #15 / A13); unchanged, re-verified green.
- `Local index · N analyzed` (header) — spec A1 frozen copy; unchanged.
- `Analyse 10/100/1000` — the product's chosen verb spelling, matches spec FLOW 2 wording and
  `analyze-<budget>` testids; spelling is consistent; unchanged.
- `Sample Map (map-v2)` section title — technical version indicator, not frozen copy; hiding it
  is a presentation decision deferred (visual surface, E-P5-adjacent); documented not changed.
- `no sample selected` and global-inspection discriminators (`unknown` / `unavailable` /
  `incompatible`) — semantic state values (not rendered text); the rendered copy was already
  humanized (`render.ts` global-inspection lines); unchanged.
- `No samples selected` / `N selected` / `N / 8` / `Add to Machiniste` / tooltips — final
  product copy; matching polish belongs to E-P3 by spec; unchanged here.
- Map hopover tooltips (`Class:` / `Owner:` / `Tags:`) and `Search name, owner, or tag…` —
  already final English; unchanged.

---

## 4. Test Changes

**Unit (`src/ui/view.test.ts`, +4 tests, file now 22 tests):**
- `mapPositionLabel renders the frozen Missing-V2 string exactly (DECISION #15)` —
  asserts `"Map position unavailable"`.
- `mapPositionLabel renders persisted V2 coordinates at 3 decimals (never recomputed)` —
  asserts `X: 0.100  Y: 0.200` and `X: 0.656  Y: 0.540`.
- `analysis progress labels are final English product copy (no dev/German strings)` —
  asserts `Analyzed: 4` / `Failed: 0` / `Remaining: 6` and the `—` em-dash for no-budget.
- `scan status labels surface human English states, never raw state names` — asserts
  Idle/Scanning/Complete/Failed.

**New e2e `e2e/ep2-copy.spec.ts` — `EP2-01 Canonical copy, English analysis labels, axes, Missing-V2`**
(1 test): canonical first-use title + CTA; real scan→analyze→point cloud; axis labels
(NOISY/TONAL/BRIGHT/DARK) + their tooltip hints + exact `aria-label`; English analysis labels
and zero German/dev strings anywhere in `body`; **Missing-V2 rendered end-to-end** — a fixture
record is stripped of its persisted position (status stays `analyzed`) and focused, asserting
the inspector shows exactly `Map position unavailable` (and no `X:`); canonical no-match copy
(`No samples match your filters.` in the list, `No samples match your search.` on the map);
no horizontal overflow (`scrollWidth − clientWidth ≤ 0`); two screenshots saved as visual
evidence (`e2e/artifacts/ep2-01-pointcloud.png`, `e2e/artifacts/ep2-02-missing-v2-inspector.png`).

**Updated e2e assertions (semantic state → human label):**
- `final-ui-phase1.spec.ts` FP-02: `.scan-status` `toContainText("done")` →
  `toContainText("Complete")`.
- `step16m.spec.ts` 16M-02: same update.

No existing `data-testid`, no assertion of the German strings, and no other test changed.
(Pre-change grep confirmed no unit/e2e assertion referenced `Analysiert`/`Fehler`/`Verbleibend`
or the old `unavailable` inspector text.)

---

## 5. Validation Results

| Gate | Command | Result |
|---|---|---|
| App TypeScript | `npm run typecheck` | 0 errors |
| Worker TypeScript | `npm run typecheck` (workers/d1-worker) | 0 errors |
| App Vitest | `npx vitest run` | **580/580 passed (32 files)** — 576 baseline + 4 new E-P2 tests |
| Worker Vitest | `npx vitest run` (workers/d1-worker) | 19/19 passed (2 files) |
| Vite build | `npm run build` | PASS |

Note: the build emitted the same pre-existing chunk-size advisory (>500 kB) that already
existed at the E-P0 baseline; it is not an error.

| Playwright | `npx playwright test` | **29/29 passed** — 28 baseline + 1 new EP2-01 |
|---|---|---|
| 16I live | `npx tsx scripts/live-verify-16i.ts` | 11/11 VERIFIED |
| 16M live | `npx tsx --env-file=.env scripts/step16m-live-verify.ts` | 23/23 VERIFIED (live backend read-back + worker publish intact) |

No gate was weakened; no live-verification script was modified.

---

## 6. Frozen Invariant Check

Re-supported by full-green gates (above) and the unchanged-core manifest proof (§9). All 19
frozen invariants confirmed un-impacted — the changes are presentation strings only:

- Persisted V2 position authority · no V1 fallback · no on-read recomputation — `mapPosition.ts`
  untouched; `mapPositionLabel` read-only projection of the persisted value.
- Missing-V2 does not render · publish guarded — unchanged; only the inspector *copy* changed.
- Focus ≠ selection · selection max = 8 · selection survives filtering · camera runtime-only ·
  search/filter/camera never mutate positions — unchanged (`app.ts` untouched).
- Preview ephemeral · no audio persistence — untouched (`previewService.ts` untouched).
- Direct Machiniste references · mandatory read-back · selection-based send — untouched.
- Transfer ≠ publication · verified usage-acceptance gate · bounded global loading · local map
  survives global failure — untouched (16I 11/11, 16M 23/23 re-passed).
- Canonical copy semantics · existing `data-testids` — the four frozen strings re-asserted in
  unit + novel e2e; the 28 pre-existing Playwright tests passed unchanged (testids intact).

---

## 7. Visual QA

The auditing surfaces were exercised in a real desktop Chrome session via the new EP2-01
Playwright test, which asserted programmatically: the four axis labels keep their exact prefixes
with the new direction hints; the map `aria-label` is the exact plain-English statement; the
analysis panel shows `Analyzed:` / `Failed:` / `Remaining:`; the Missing-V2 inspector line shows
`Map position unavailable`; no German/dev string appears anywhere in the page body; and there is
no horizontal overflow (`scrollWidth − clientWidth ≤ 0`). 16M-20 (browser console audit, no
errors/uncaught exceptions) still passes.

Screenshots for human review are saved at `e2e/artifacts/ep2-01-pointcloud.png` (full point
cloud, axes) and `e2e/artifacts/ep2-02-missing-v2-inspector.png` (Missing-V2 inspector);
the pre-existing evidence shots (`16M-map-analyzed.png`, `16M-selection.png`,
`fp-action-bar-selected.png`) remain in place. (The model running this session has no image
input, so the PNGs were added as evidence and cross-checked via the DOM assertions above.)

No layout redesign was performed.

---

## 8. Out-of-Scope Items (explicitly left)

- **E-P3** — Selection/send polish surface: `selectionCountLabel` tooltips, disabled-state
  title on `Add to Machiniste`, send-panel id/slot validation hint (already announced in §3:
  existing tooltip/disabled copy left as-is).
- **E-P4** — Structured filter panel (grouped class controls + "Clear filters"; restyle only).
- **E-P5** — Low-confidence map cue (§8.5), tooltip disclaimer copy (§20.3), keyboard-point
  navigation / ARIA live regions, 768–1023 drawer e2e, drag-pan/wheel-zoom gesture e2e.
- **E-P6** — Global publish-status surface (plain `Global: idle` treatment kept; `Sample Map
  (map-v2)` title also deferred as a presentation surface decision, E-P5-adjacent).
- **E-P7** — Human Layer-C OAuth closure (FLOW 1 + FLOW 10).
- **Later** — Overlap fan-out, saved viewport restore, confidence-threshold UI, ≤767 desktop
  support.

---

## 9. Git / File Integrity

The repository has no `.git` (`git rev-parse` → fatal). Integrity is asserted with SHA-256
manifests (same method as E-P1):

- E-P1 end-state manifest: 115 files (all `.ts` under `src/`, `workers/d1-worker/src|test|
  migrations`, `scripts/`, `e2e/`; plus package/config root files; `.env` excluded as
  secret-bearing).
- E-P2 final manifest captured at E-P2 close and `diff`-ed against the E-P1 end-state.
- **Diff result: exactly the 7 intended files differ** — the seven rows of §2. No other source,
  test, script, worker, or config file changed. (Distinct test-name evidence; e.g. unrelated
  `src/search`, `src/global`, `src/pipeline`, `workers/d1-worker/**` hashes are identical.)
- The new artifact PNGs and regenerated `dist/` are build/output artifacts, not source.
- No secret touched; `.env` never read by any changed code.

---

## 10. Verdict

> **E-P2 PASS — COPY + LABELS COMPLETE**
>
> Missing-V2 renders the canonical `Map position unavailable`; German/dev analysis labels are
> final English product copy; the scan panel no longer leaks raw state names; the map and axes
> carry plain-English explanatory tooltips per spec A3 with no coordinate/projection change.
> Canonical frozen strings, `data-testids`, and all 19 frozen invariants re-verified green.
> App tsc 0, worker tsc 0, app vitest 580/580 (32 files), worker vitest 19/19 (2 files),
> `vite build` PASS, Playwright 29/29, 16I 11/11, 16M 23/23. The SHA-256 manifest vs. the
> E-P1 baseline shows only the 7 intended files changed.