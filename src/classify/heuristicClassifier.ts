import type {
  AudioFeatures,
  ClassId,
  ClassOutput,
  Classifier,
} from "./classifier";
import { ALL_CLASSES } from "./taxonomy";

/**
 * HeuristicClassifier — the V1 feature-rule baseline implementation.
 *
 * It is deliberately simple, deterministic and framework-independent. It maps
 * extracted audio features onto the taxonomy via hand-tuned rules, then converts
 * the raw scores into a proper probability distribution (softmax) so the output
 * is a confidence + ranked secondary classes. A later CNN/pre-trained model can
 * be registered alongside it through the same Classifier interface.
 */
export class HeuristicClassifier implements Classifier {
  readonly id = "heuristic";
  readonly version = "heuristic-v1";

  async classify(features: AudioFeatures): Promise<ClassOutput> {
    const scores = scoreAll(features);
    return toOutput(scores);
  }
}

function scoreAll(f: AudioFeatures): Record<ClassId, number> {
  const s: Record<ClassId, number> = {} as Record<ClassId, number>;
  for (const c of ALL_CLASSES) s[c] = scoreClass(c, f);
  return s;
}

function scoreClass(c: ClassId, f: AudioFeatures): number {
  const d = f.duration;
  const short = d < 0.5;
  const medium = d >= 0.5 && d <= 1.5;
  const sustained = d > 1.5;
  const loop = d > 2.5;
  const transient = f.transientDensity > 5;
  const noisy = f.spectralFlatness > 0.6;
  const tonal = f.spectralFlatness < 0.35;
  const dark = f.spectralCentroid < 400;
  const mid = f.spectralCentroid >= 400 && f.spectralCentroid <= 3000;
  const bright = f.spectralCentroid > 3000;
  const fastAttack = f.attack < 0.02;

  switch (c) {
    case "kick":
      return sum([short ? 0.5 : 0, transient ? 0.3 : 0, dark ? 0.6 : 0, fastAttack ? 0.3 : 0, tonal ? 0.2 : 0]);
    case "snare":
      return sum([transient ? 0.5 : 0, mid ? 0.35 : 0, medium ? 0.25 : 0, fastAttack ? 0.2 : 0]);
    case "clap":
      return sum([transient ? 0.45 : 0, mid ? 0.3 : 0, noisy ? 0.3 : 0, medium ? 0.2 : 0]);
    case "hihat":
      return sum([short ? 0.3 : 0, transient ? 0.4 : 0, bright ? 0.6 : 0, noisy ? 0.35 : 0]);
    case "openhat":
      return sum([bright ? 0.6 : 0, noisy ? 0.4 : 0, medium ? 0.3 : 0]);
    case "tom":
      return sum([transient ? 0.4 : 0, medium ? 0.3 : 0, mid ? 0.4 : 0, tonal ? 0.3 : 0]);
    case "cymbal":
      return sum([bright ? 0.4 : 0, noisy ? 0.5 : 0, sustained ? 0.3 : 0, medium ? 0.15 : 0]);
    case "percussion":
      return sum([transient ? 0.35 : 0, mid ? 0.3 : 0, short || medium ? 0.25 : 0]);
    case "bass":
      return sum([dark ? 0.8 : 0, tonal ? 0.4 : 0, sustained ? 0.4 : 0, !noisy ? 0.2 : 0]);
    case "synth":
      return sum([tonal ? 0.5 : 0, sustained ? 0.4 : 0, mid ? 0.4 : 0]);
    case "piano":
      return sum([tonal ? 0.4 : 0, mid ? 0.4 : 0, transient ? 0.2 : 0, medium ? 0.2 : 0]);
    case "guitar":
      return sum([tonal ? 0.4 : 0, mid ? 0.4 : 0, medium ? 0.25 : 0, transient ? 0.2 : 0]);
    case "strings":
      return sum([tonal ? 0.4 : 0, sustained ? 0.4 : 0, mid ? 0.3 : 0, !transient ? 0.2 : 0]);
    case "keys":
      return sum([tonal ? 0.35 : 0, mid ? 0.3 : 0, sustained ? 0.3 : 0]);
    case "pad":
      return sum([sustained ? 0.5 : 0, tonal ? 0.35 : 0, !transient ? 0.3 : 0, mid ? 0.2 : 0]);
    case "lead":
      return sum([tonal ? 0.5 : 0, sustained ? 0.4 : 0, bright || mid ? 0.3 : 0]);
    case "vocal":
      return sum([tonal ? 0.3 : 0, mid ? 0.3 : 0, medium ? 0.25 : 0, !noisy ? 0.15 : 0]);
    case "fx":
      return sum([noisy ? 0.4 : 0, transient ? 0.3 : 0, medium || sustained ? 0.25 : 0]);
    case "atmosphere":
      return sum([sustained ? 0.4 : 0, noisy ? 0.5 : 0, !transient ? 0.3 : 0]);
    case "noise":
      return sum([
        noisy ? 0.6 : 0,
        f.spectralBandwidth > 3000 ? 0.5 : 0,
        f.spectralFlatness > 0.8 ? 0.4 : 0,
        sustained ? 0.2 : 0,
        !transient ? 0.2 : 0,
      ]);
    case "loop":
      return loop ? 1.5 : 0;
    case "other":
      return 0.1;
    default:
      return 0;
  }
}

function toOutput(scores: Record<ClassId, number>): ClassOutput {
  // Rank all classes by raw score, then softmax over only the top plausible
  // candidates so confidence is interpretable (irrelevant classes get zero
  // probability mass instead of diluting the top class toward ~1/24).
  const ranked = ALL_CLASSES.map((c) => ({ class: c, score: scores[c] })).sort(
    (a, b) => b.score - a.score,
  );
  const top = ranked.slice(0, 5);
  const max = top[0].score;
  const T = 0.5;
  const exps = top.map((r) => Math.exp((r.score - max) / T));
  const total = exps.reduce((a, b) => a + b, 0);
  const dist = top
    .map((r, i) => ({ class: r.class, confidence: exps[i] / total }))
    .sort((a, b) => b.confidence - a.confidence);

  const primary = dist[0];
  return {
    primaryClass: primary.class,
    confidence: round4(primary.confidence),
    secondaryClasses: dist.slice(1).map((r) => ({
      class: r.class,
      confidence: round4(r.confidence),
    })),
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
