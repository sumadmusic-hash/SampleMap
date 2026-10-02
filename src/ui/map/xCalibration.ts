import { clamp01 } from "../../analysis/normalize";

/**
 * STEP91 — map-display X calibration (presentation only).
 *
 * The canonical Sound Space `rawX` is right-heavy on the real corpus: it only
 * occupies `[0.3984, 0.9982]` (median 0.856, ~35% of samples above 0.90), so
 * the left ~40% of the map is never used. This is a static, monotone linear
 * stretch of that occupied range onto the full `[0, 1]` map width.
 *
 * It is applied as late as possible — only where a `MapPoint`'s rawX becomes
 * the actual map X passed to the renderer / hit-tester. It never touches the
 * analysis, the `SoundCharacter`, the projector, the stored/compared
 * `MapPoint.x`, the Y position, or any persisted data.
 *
 * Endpoints are preserved (`rawX = RAW_X_MIN -> 0`, `rawX = RAW_X_MAX -> 1`),
 * the order of samples never changes, and out-of-range values clamp to 0/1.
 * The bounds are measured once from the real corpus and frozen here; they are
 * never recomputed per render/zoom.
 */
export const RAW_X_MIN = 0.3984435741768317;
export const RAW_X_MAX = 0.9982380892771591;

export function calibrateDisplayX(rawX: number): number {
  const span = RAW_X_MAX - RAW_X_MIN;
  if (!(span > 0)) return clamp01(rawX);
  return clamp01((rawX - RAW_X_MIN) / span);
}
