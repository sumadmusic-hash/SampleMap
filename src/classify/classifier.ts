import type {
  AudioFeatures,
  ClassId,
  SecondaryClass,
} from "../persistence/indexStore";

export type { AudioFeatures, ClassId, SecondaryClass };

/**
 * The stable Classifier contract (SAMPLEMAP_V1_SPEC §7.2).
 *
 * The concrete model behind the interface is exchangeable: a feature heuristic
 * (V1), a pre-trained model, or a small CNN. The pipeline depends only on this
 * interface and on the registry, so a later swap is a drop-in change.
 *
 * Classification is a probability distribution, not a bare `type = x` — the
 * primary class carries a confidence, and alternative (secondary) classes are
 * retained in descending order.
 */
export interface ClassOutput {
  primaryClass: ClassId;
  confidence: number; // 0..1
  /** Alternative classes, sorted by confidence descending. */
  secondaryClasses: SecondaryClass[];
}

export interface Classifier {
  /** Stable identifier of the underlying model, e.g. "heuristic-v1". */
  readonly id: string;
  /** Model version — feeds `analysisVersion`/`analysisBuild` idempotency. */
  readonly version: string;
  classify(features: AudioFeatures): Promise<ClassOutput>;
}
