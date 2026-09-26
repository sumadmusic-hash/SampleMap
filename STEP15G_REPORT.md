# SAMPLEMAP V1 — STEP 15G REPORT

## STEP 15G RESULT

### Files created:
- `STEP15G_DESIGN.md` — the Step-15G design/analysis document (verbindliche
  §29-Struktur: exactly the 20 mandated sections; §32 DoD addressed throughout).
- `STEP15G_REPORT.md` — this report.

### Files modified:
- None. No production file was touched. (Baseline re-verified before and after:
  no production change.)

### Production implementation:
- **NONE.** Vertical design only, as mandated by Step 15G:
  - no quality-gate code,
  - no duplicate detector,
  - no audio hashing / fingerprinting,
  - no similarity engine,
  - no embedding model,
  - no new database fields,
  - no new UI / filters / map functions,
  - no machiniste changes.
- Existing functions unchanged (no `src/` file edited).

### Tests before:
267 tests
### Tests after:
267 tests
### Test files before:
20
### Test files after:
20

### TypeScript:
`npx tsc --noEmit` → clean (no production code changed).

### Build:
`npm run build` → OK (only the pre-existing chunk-size warning).

---

### Key verified findings used in the design (`STEP15G_DESIGN.md`)

| Finding | Evidence | Status |
|---|---|---|
| Current analysis source prefers the lossy MP3 **preview** | `src/ui/bootstrap.ts:71` `previewMp3Url \|\| mp3Url \|\| wavUrl \|\| flacUrl` | VERIFIED |
| Audiotool `Sample` offers `mp3Url`/`wavUrl`/`flacUrl`/`previewMp3Url` | `node_modules/@audiotool/nexus/dist/gen/audiotool/sample/v1/sample_pb.d.ts` | VERIFIED |
| `SampleMeta` has no `codec`/`bitrate`/`compressionQuality` fields | installed package types | VERIFIED (absent); nothing invented |
| Audio is immutable ("The underlying audio can't be changed.") | `Sample.update_time` protobuf doc | VERIFIED |
| `SampleIndexRecord` has no `format`/`codec`/`quality`/`hash`/`audioIdentity` | `src/persistence/indexStore.ts` | VERIFIED |
| Pipeline: resolve→fetch→decode→extract→classify→upsert→release; audio transient | `src/pipeline/analysisPipeline.ts` | VERIFIED |
| `DecodedAudio` carries no format/codec after decode | `src/audio/decodedAudio.ts` | VERIFIED |
| Gate slot between decode and extractFeatures (design level) | `STEP15G_DESIGN.md §5.2` | DECISION (not implemented) |
| `assertNoAudioBytes` guards IndexStore + QueueStore | `indexStore.ts`/`queueStore.ts` | VERIFIED |

### Per-area outcome (design, not implementation)
- Quality gate: hard admission gate ACCEPT/REJECT; REJECT → no map point, no
  classification, no similarity, no representative; source untouched
  (`STEP15G_DESIGN.md §5`).
- Analysis sources allowed: lossless `wavUrl`→`flacUrl` only in V1; preview/
  mp3 never as analysis source; preview is playback-only
  (`STEP15G_DESIGN.md §3–§5`).
- Audio Identity: three strictly separated levels — Exact File Duplicate
  (byte SHA-256) / Audio Content Identity (canonical PCM hash) / Perceptual
  Similarity (similar ≠ identical; deferred) (`§6–§8`).
- Name ≠ Identity; Map Point = unique sound (not sample id); multiple
  Audiotool refs per sound kept for machiniste (`§6`, `§9`, `§13`).
- Hash vs. fingerprint: evaluated — V1 = SHA-256 file hash + canonical
  content hash from existing features path; no ML/cloud/new deps; perceptual
  fingerprint only as documented DEPENDENCY CANDIDATE for a later step (`§8`, `§16`).
- Persistence need: examined; optional metadata fields proposed for the
  implementing step only, `assertNoAudioBytes`-compatible (`§14`).
- Versioning: `analysisBuild` bump + `gateVersion`/`contentHashAlgorithmVersion`/
  `identityAlgorithmVersion` rules (`§15`).

### Verified
- Baseline 267/20; `tsc` clean; `npm run build` OK; all facts cited above from
  existing code/types; no production file changed.

### Not verified (documented as such in the design)
- Whether every Audiotool sample with audio also has WAV/FLAC (OQ-1) — needs a
  live authenticated session.
- WAV container payload is truly PCM; FLAC decodeAudioData support in the
  target browser (especially Safari); cross-browser determinism of a canonical
  content hash (OQ-2/3/4).
- Real lossless download bandwidth/cost for analysis (OQ-9).

### Deferred
- Lossy-source acceptance with verifiable bitrate/artifact thresholds.
- Perceptual similarity engine/UI (regular features first, no ML in V1).
- Map-point grouping & representative visibility in map/inspector/search.
- Persisted rejected-list vs. queue-only `skipped` marker.
- Artifact measurement with calibrated thresholds.

### Open questions
10 open questions documented in `STEP15G_DESIGN.md §18` (OQ-1 … OQ-10).

### Dependencies
- **NONE** added. `DEPENDENCY CANDIDATE`s (chromaprint-like fingerprints /
  Essentia-based features) only documented for the optional later perceptual-
  similarity step — explicitly not part of V1 (`§16`).

### Recommendation for the following implementing step
- `STEP15G_DESIGN.md §16`: (1) hard lossless source-gate +
  post-decode sanity gate, (2) `fileHash`/`contentHash` computed transiently,
  (3) optional metadata fields + build bump, (4) map-point = unique sound with
  representative rule, search/inspector grouping after, (5) machiniste
  unchanged, (6) integration + browser-probe tests. Acceptance criteria in §20.

### Verdict
**DONE** — Step 15G (§32 DoD: all 20 criteria addressed in the design; no
production implementation; no existing function changed; open questions
explicitly documented; clear recommendation provided).