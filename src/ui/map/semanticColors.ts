import type { SampleIndexRecord } from "../../persistence/indexStore";
import { CLASS_COLORS, DEFAULT_CLASS_COLOR } from "./mapView";

/**
 * STEP38 — deterministic semantic dot colors.
 *
 * The map renders fine-grained drum/percussion SUBTYPES with their OWN colors
 * so the semantic layer is visually distinguishable: Ride ≠ Closed Hat,
 * Tom ≠ Bongo, Closed Hat ≠ Open Hat, Ride ≠ Crash, etc. The map uses this
 * ONLY for presentation (fill); it NEVER influences position or classification.
 */
export const SEMANTIC_SUBTYPE_COLORS: Record<string, string> = {
  kick: "#e53935",
  snare: "#fb8c00",
  clap: "#fdd835",
  closedhat: "#43a047",
  openhat: "#26c6da",
  ride: "#3949ab",
  crash: "#ab47bc",
  cymbal: "#5e35b1",
  tom: "#1e88e5",
  shaker: "#9ccc65",
  tambourine: "#dce775",
  rim: "#6a1b9a",
  cowbell: "#c0a000",
  bongo: "#8d6e63",
  conga: "#a1887f",
  clave: "#f9a825",
  percussion: "#8e24aa",
  "percussion-other": "#8e24aa",
};

/** Subtype → color; unknown/absent subtype → the family color → default. */
export function semanticDotColor(
  primaryClass: string,
  semanticSubtype: string | undefined,
): string {
  if (semanticSubtype !== undefined) {
    const c = SEMANTIC_SUBTYPE_COLORS[semanticSubtype];
    if (c !== undefined) return c;
  }
  return CLASS_COLORS[primaryClass] ?? DEFAULT_CLASS_COLOR;
}

/** Record-oriented convenience: prefer the persisted semantic subtype. */
export function semanticColorOf(record: SampleIndexRecord): string {
  return semanticDotColor(
    record.primaryClass,
    record.semanticClassification?.subtype,
  );
}