import type { ClassId } from "../persistence/indexStore";

/**
 * The SampleMap classification taxonomy (SAMPLEMAP_V1_SPEC §7.1).
 * Audiotool originalTags are never treated as ground truth; these are the
 * SampleMap-native class labels the classifier outputs.
 */
export const TAXONOMY = {
  drums: [
    "kick",
    "snare",
    "clap",
    "hihat",
    "openhat",
    "tom",
    "cymbal",
    "percussion",
  ],
  musical: [
    "bass",
    "synth",
    "piano",
    "guitar",
    "strings",
    "keys",
    "pad",
    "lead",
  ],
  other: ["vocal", "fx", "atmosphere", "noise", "loop", "other"],
} as const;

export const ALL_CLASSES: ClassId[] = [
  ...TAXONOMY.drums,
  ...TAXONOMY.musical,
  ...TAXONOMY.other,
];

export const DRUM_CLASSES: ClassId[] = [...TAXONOMY.drums];
export const MUSICAL_CLASSES: ClassId[] = [...TAXONOMY.musical];
export const OTHER_CLASSES: ClassId[] = [...TAXONOMY.other];
