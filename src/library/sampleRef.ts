import type { SampleMeta } from "@audiotool/nexus/api";

/**
 * AudiotoolSampleReference — the canonical translation from a library sample to
 * the persistent `sampleName` (`samples/{uuid}`) used to create the
 * document-local `Sample` entity inside a Machiniste (direct-reference path).
 *
 * This is the first hop of the machiniste chain:
 *   SampleMap → AudiotoolSampleReference → MachinisteService → Sample Entity →
 *   MachinisteChannel.sample
 */
export type AudiotoolSampleReference = string;

export const SAMPLE_NAME_PREFIX = "samples/";

/** Match a well-formed sample name: `samples/` + url-safe token. */
const SAMPLE_NAME_RE = /^samples\/[A-Za-z0-9._~-]+$/;

/**
 * Normalize a sample (or raw identifier) to a canonical `samples/{uuid}` name.
 * `SampleMeta.name` is already `samples/{uuid}`; a bare id is prefixed.
 */
export function toSampleName(input: SampleMeta | string): AudiotoolSampleReference {
  const name = typeof input === "string" ? input : input.name;
  return name.startsWith(SAMPLE_NAME_PREFIX) ? name : `${SAMPLE_NAME_PREFIX}${name}`;
}

/** True if `value` is a well-formed `samples/{uuid}` name. */
export function isSampleName(value: string): boolean {
  return SAMPLE_NAME_RE.test(value);
}

/** Extract the bare id part after `samples/`. */
export function sampleIdFromName(sampleName: string): string | undefined {
  if (!isSampleName(sampleName)) return undefined;
  return sampleName.slice(SAMPLE_NAME_PREFIX.length);
}
