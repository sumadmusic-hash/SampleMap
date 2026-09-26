import type { SampleMeta } from "@audiotool/nexus/api";
import type { AnalysisSourceFormat } from "../audio/sourceFormat";

/**
 * Lossless analysis source selection (Step 15H §3–§4).
 *
 * The analysis source is deliberately decoupled from the playback source:
 *  - ANALYSIS SOURCE : `wavUrl` → `flacUrl` (lossless only, MP3 never used)
 *  - PREVIEW SOURCE  : `previewMp3Url` / `mp3Url` (playback, unchanged)
 *
 * Order is a deliberate, documented decision: WAV first, FLAC second.
 * Rationale: a WAV container's payload PCM claim is checkable purely from the
 * header (non-PCM WAV is rejected by the gate), and WAV decodes universally
 * in Web Audio, whereas FLAC `decodeAudioData` support is only verified for the
 * target Chromium runtime (Step 15G live verification), not for every browser.
 * Choosing WAV first therefore minimizes gate risk on the common path.
 *
 * If no lossless URL exists the sample is technically not analyzable
 * (NO_LOSSLESS_SOURCE); it must NOT fall back to MP3/preview.
 */
export interface LosslessSource {
  url: string;
  format: AnalysisSourceFormat;
}

export function selectLosslessSource(sample: SampleMeta): LosslessSource | undefined {
  if (sample.wavUrl && sample.wavUrl.length > 0) {
    return { url: sample.wavUrl, format: "wav" };
  }
  if (sample.flacUrl && sample.flacUrl.length > 0) {
    return { url: sample.flacUrl, format: "flac" };
  }
  return undefined;
}