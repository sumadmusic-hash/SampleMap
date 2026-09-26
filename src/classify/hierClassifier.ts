/**
 * STEP44 — `hier-v1` classifier (implements the stable `Classifier` contract).
 *
 * The full evidence-driven hierarchical classification runs through
 * `classifyHier`; the `classify(features)` surface is the feature-only view used
 * by the registry/legacy consumers (no metadata, no V2 → weak evidence, low
 * confidence, honest `UNKNOWN`/ambiguous states). The analysis pipeline calls
 * `classifyHier` directly with full metadata + V2 features.
 */
import type { AudioFeatures, ClassOutput, Classifier } from "./classifier";
import { classifyHier } from "./hier/classify";
import { HIER_CLASSIFICATION_VERSION } from "./hier/types";
import type { HierClassifyInput, HierResult } from "./hier/types";

export class HierClassifier implements Classifier {
  readonly id = "hier";
  readonly version = HIER_CLASSIFICATION_VERSION;

  /** Full classification with metadata + optional V2 features. */
  classifyHier(input: HierClassifyInput): HierResult {
    return classifyHier(input);
  }

  async classify(features: AudioFeatures): Promise<ClassOutput> {
    const result = classifyHier({
      features,
      meta: {
        kind: "unknown",
        durationSeconds: features.duration,
        name: "",
        tags: [],
      },
      v2: null,
    });
    return result.surface;
  }
}