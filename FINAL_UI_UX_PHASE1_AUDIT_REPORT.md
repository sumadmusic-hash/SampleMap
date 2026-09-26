# FINAL UI/UX — Phase 1 Audit Report (Role B / adversarial verification)

Independent audit of the Phase-1 implementation against `FINAL_UI_UX_DESIGN_SPEC.md`
v1.1, the frozen STEP16Q V2 invariant, and the related step-16/step-17 surface.
Scope: shell / action bar / selection / first-use / map presentation. Frozen core
modules (`src/map`, `src/audio`, `src/classify`, `src/persistence`, `src/pipeline`,
`src/machiniste`, `src/global`, worker) were NOT modified by the audit or by the
fixes recorded here.

---

## 1. Original findings (audit pass, before any fix)

### Finding #1 — SPEC CONFLICT (§7.2 orientation vs frozen V2 math) — SEE §2 below

### Finding #2 — CONFIRMED §8.1 deviation: static point radius (FIXED, see §3)

**Spec:** base radius `6px` at 100% zoom, zoom-compensated `6 / zoom`, minimum `4px`
(§8.1). Selected/focused = base × 1.35 (§8.2).

**Implementation (before fix):** constant `r: 5` (rest) / `8` (focused/batch-selected)
in base px inside the camera-transformed `<g>` — i.e. radius scaled **with** zoom on
screen, base was 5px not 6px, no `6/zoom` compensation, no 4px floor.

**Verdict:** confirmed non-spec-compliance. No frozen invariant violated (positions,
math, persistence untouched); purely presentation.

### Finding #3 — COSMETIC: `DARK` axis label position

The `DARK` vertical-axis label is placed at the bottom edge near the left (x≈60)
rather than mid-height along the left edge. §7.2's vertical-axis diagram shows
DARK at the bottom, BRIGHT at the top — the implementation is compatible with that
reading; placement is a minor presentation choice. **No regression test impact, no
action required for Phase 1.** (Not pulled forward per audit direction.)

---

## 2. Finding #1 — SPEC BUG / SPEC CONFLICT (§7.2) — DOCUMENTED, NOT "FIXED"

### The conflict

`FINAL_UI_UX_DESIGN_SPEC.md` §7.2 states as a *binding orientation*:

> **Bottom-left = DARK + TONAL; top-right = BRIGHT + NOISY.** `y` increases upward
> (brightness up), `x` increases rightward (noisiness rightward).

But the **frozen STEP16Q V2 math** (`src/map/mapPosition.ts`, `flatnessToX`) — which
§7.2 itself declares authoritative and unchangeable — places:

```
snr  = (1 - f) / (f + 1e-4)
rawX = log10(snr), clipped to [-2, +3]
x    = (rawX + 2) / 5
```

For NOISY content flatness → 1 ⇒ `snr` → 0 ⇒ `rawX` → -∞ ⇒ `x = 0`.
For TONAL content flatness → 0 ⇒ `snr` → 10⁴ ⇒ `rawX` → +3 ⇒ `x = 1`.

So the frozen formula yields **x = 0 ⇒ NOISY, x = 1 ⇒ TONAL**. The implementation
(axis labels `NOISY` left / `TONAL` right, `aria-label` "noisy-tonal by dark-bright",
and `y`=1 BRIGHT at top via `toScreen`'s Y inversion) is **correct per the frozen
invariant**. §7.2's prose text reverses the X axis relative to the frozen math.

### Resolution (by direction)

- **NOT fixed via math.** `flatnessToX`, `centroidToY`, `computePosition` are
  unchanged — the formula and its anchors are the frozen invariant; reversing them
  would violate the no-change rule and silently relabel every persisted V2 position.
- **Classification:** SPEC BUG inside the design document. The spec text in §7.2
  ("Bottom-left = DARK + TONAL / top-right = BRIGHT + NOISY", "noisiness rightward")
  is internally inconsistent with the frozen formula it references. Recommended
  follow-up for the spec owner: reword §7.2 to "TONAL left ─── NOISY right"/"bottom-left
  = DARK + NOISY, top-right = BRIGHT + TONAL". Implementation work is NOT required.

---

## 3. §8.1 fix implementation (smallest change)

`src/ui/map/mapView.ts`:

```ts
export function pointRadius(zoom: number, emphasized = false): number {
  const z = Number.isFinite(zoom) ? Math.max(zoom, MIN_ZOOM) : MIN_ZOOM;
  const base = Math.max(MIN_POINT_RADIUS_PX, BASE_POINT_RADIUS_PX / z);
  return emphasized ? base * SELECTED_POINT_SCALE : base;
}
```

- `BASE_POINT_RADIUS_PX = 6` (§8.1), `MIN_POINT_RADIUS_PX = 4` (§8.1 floor),
  `SELECTED_POINT_SCALE = 1.35` (§8.2).
- `src/ui/map/mapRender.ts`: circle `r` now computes
  `focused || inSelection ? pointRadius(zoom, true) : pointRadius(zoom)`. Base 6px at
  100% zoom; on-screen size stable (`6/zoom` compensated) until the 4px base floor
  engages; focused/batch-selected keep their §8.2 ×1.35 ≈ 8px visual at 100% zoom.
- Hover keeps its existing stroke treatment (radius bump is part of the deferred
  §8.5 point-treatment batch, not this change).
- **Untouched:** V2 coordinates, map math (`mapPosition.ts`), persistence, camera,
  focus/selection semantics.

### Regression tests (green)

`mapView.test.ts` → `describe("map view : point radius (FINAL_UI_UX §8.1)")` — 5 tests:
base 6px at zoom 1; `6/zoom` compensation (on-screen stays 6px while unclamped;
the compensated region is zoom ≤ 1.5 before the 4px floor); 4px floor; ×1.35 emphasis;
purity + defensive sub-MIN_ZOOM / non-finite zoom.

---

## 4. Re-gate after the §8.1 fix (all green)

| Gate | Result |
|---|---|
| Focused map/UI tests (`src/ui/map`, `src/ui`, `src/map`) | 142/142 PASS |
| Vitest (full app) | 576/576 PASS (was 571; +5 radius tests) |
| `tsc --noEmit` | 0 errors PASS |
| `vite build` | PASS (pre-existing chunk-size warning only) |
| Playwright e2e (offline harness, chrome) | 28/28 PASS |
| Frozen invariants (focus≠selection, cap=8, Esc-clear-selection, search, V2-only positions, no fallback, camera runtime-only) | intact, unit+FP e2e green |

---

## 5. Remaining-gap classifications (correct classification per spec phase)

| Item | Classification |
|---|---|
| §8.5 low-confidence inner ring / density glow | **Phase-1 gap / future work** — presentation-only; not blocking. No map math involved. |
| §20.3 tooltip disclaimer copy ("Position is an impression of timbre…") | **Future work** (optional copy in a later polish phase). Tooltip already shows name/class/owner/tags. |
| §13 structured filter panel restyle (grouped class controls, "Clear filters" link) | **Phase-1 gap / future work** — current compact control row is functionally complete (class/confidence/sort + Clear). |
| §27 responsive drawers E2E coverage (768–1023) | **Test gap** — CSS + shell state classes implemented and reviewed; not e2e-covered because the harness suite is a desktop-viewport suite. Recommend a dedicated responsive-viewport spec in a later phase, not a blocker. |
| §7.2 axis prose conflict | **SPEC BUG** — implementation correct; spec text to be reworded (see §2). |
| `DARK` label placement | Cosmetic; no action for Phase 1 (see Finding #3). |

No High or Critical findings remain. The §8.1 deviation is resolved with regression
coverage and the full gate re-verified.

---

## 6. Verdict

**Phase 1 (Shell / Action Bar / First-Use / §8.1 radius) — APPROVED.**
Ready for Phase 2. Phase 2 must be implemented strictly incrementally (do not port
the remainder of the UI in one pass); each increment keeps the same gate
(vitest / tsc / build / playwright / frozen-invariant checks).