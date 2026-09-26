/**
 * AnalysisSourceFormat — the container of the *analysis source*.
 *
 * Only lossless sources may feed SampleMap analysis (Step 15H §3). Lossy
 * MP3/preview URLs remain playback-only and are never an analysis source.
 */
export type AnalysisSourceFormat = "wav" | "flac";

export const ANALYSIS_SOURCE_FORMATS: readonly AnalysisSourceFormat[] = [
  "wav",
  "flac",
];

export function isAnalysisSourceFormat(
  value: string,
): value is AnalysisSourceFormat {
  return (ANALYSIS_SOURCE_FORMATS as readonly string[]).includes(value);
}