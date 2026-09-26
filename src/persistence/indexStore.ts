import { ElasticDB } from "./elasticdb";
import { STORES } from "./db";
import type { AnalysisSourceFormat } from "../audio/sourceFormat";
import { isWellFormedHierClassification } from "../classify/hier/types";

export type ClassId = string;
export type SampleVisibility = "public" | "unlisted" | "private" | "unknown";
export type AnalysisStatus = "pending" | "analyzed" | "failed" | "gone";

export interface AudioFeatures {
  duration: number;
  sampleRate: number;
  channels: number;
  rms: number;
  peak: number;
  transientDensity: number;
  spectralCentroid: number;
  spectralBandwidth: number;
  spectralRolloff: number;
  zeroCrossingRate: number;
  spectralFlatness: number;
  attack: number;
  tonalNoiseRatio: number;
}

export interface SecondaryClass {
  class: ClassId;
  confidence: number;
}

/**
 * The persisted SampleMap record. This shape intentionally contains NO audio
 * byte containers (Blob/ArrayBuffer/AudioBuffer). It is metadata + analysis
 * results only. `embedding` (optional) is a Float32Array, label embedding data,
 * not audio bytes.
 */
export interface SampleIndexRecord {
  sampleId: string;
  owner: string;
  visibility: SampleVisibility;
  name: string;
  kind: string;
  originalTags: string[];
  /**
   * METADATA SLICE (flat additive Audiotool source/community fields).
   *
   * `bpm`          : Audiotool musical metadata (double). `0` means "no tempo
   *                  set" and is preserved as-is; UI renders it as "—".
   * `numFavorites` : Audiotool community counter (int32, >= 0). Raw counter,
   *                  NOT a rating/score and NEVER folded into `confidence` or
   *                  `relevance`.
   * `numUsages`    : Audiotool community counter (int32, >= 0). Same semantics.
   *
   * All three are OPTIONAL: legacy records predating this slice simply omit
   * them and remain fully readable. They are metadata-only and may be refreshed
   * at scan time WITHOUT any audio fetch/decode/analysis. They never affect
   * `primaryClass`, `confidence`, `audioFeatures` or `mapPosition`.
   */
  bpm?: number;
  numFavorites?: number;
  numUsages?: number;
  primaryClass: ClassId;
  confidence: number;
  secondaryClasses: SecondaryClass[];
  classificationVersion: string;
  /**
   * STEP38 — the additive semantic classification (fine-grained drum/percussion
   * subtype reconciled from audio family + tag evidence). OPTIONAL: records
   * analyzed before this field existed simply omit it and render with the
   * legacy `primaryClass`. Metadata-only numbers/strings — it never contains
   * audio bytes and survives `assertNoAudioBytes`. It does NOT affect
   * `primaryClass`, `confidence`, `audioFeatures` or `mapPosition` (tags are
   * evidence, never truth; position stays the STEP37 canonical Sound Space).
   */
  semanticClassification?: import("../classify/semanticClassification").SemanticClassification;
  /**
   * STEP44 — additive hierarchical classification (structure / sound family /
   * acoustically-conditional type / optional subtype + parsed name + tag
   * evidence + reconciliation + calibrated decision confidence).
   *
   * OPTIONAL and ADDITIVE by contract: records analyzed before this field
   * existed (or analyzed by the legacy `heuristic-v1` path) simply omit it and
   * remain fully readable — no mass migration ever runs (SC12). It is
   * metadata-only (numbers/strings/booleans/plain arrays, plus a documented
   * subtype string) and never contains audio bytes; it survives
   * `assertNoAudioBytes`. It does NOT affect map/similarity/Find-Similar/VR
   * dimensions. Records written by the hier path carry
   * `classificationVersion: "hier-v1"`.
   */
  hier?: import("../classify/hier/types").HierClassification;
  audioFeatures: AudioFeatures;
  /**
   * V2 (STEP 20): the canonical V2 analysis result (features + sound character
   * + quality).
   *
   * OPTIONAL and ADDITIVE by contract: V1 records without a V2 analysis stay
   * fully valid, are never auto-migrated and never force a re-analysis
   * (re-analysis happens through the normal pipeline and adds this field). It
   * is metadata-only (numbers/strings/arrays — NEVER audio bytes) and survives
   * `assertNoAudioBytes`.
   */
  analysisV2?: import("../analysis/sampleAnalysisV2").SampleAnalysisV2;
  /**
   * V2 (STEP 16Q): the persisted Semantic 2D SampleMap position.
   *
   * This is an ANALYSIS RESULT computed ONCE at analysis time from decoded
   * audio (whole-sample multi-window flatness) + features. It is NOT a value
   * recomputed from `AudioFeatures` downstream — see the "ADOPTED ARCHITECTURE
   * DECISION" in STEP16Q_SPEC_BLOCKER_REPORT.md (the granted exception to
   * Step 16D §26 "recompute, not re-analyze", scoped to map position).
   *
   * Optional because pre-V2 records (analyzed before this field existed) do not
   * carry it. Downstream consumers report a clear Missing-V2 state for such
   * records and must NEVER fall back to a V1 feature-derived position.
   */
  mapPosition?: import("../map/mapPosition").MapPosition;
  analysisVersion: string;
  analyzedAt: string;
  analysisBuild: string;
  status: AnalysisStatus;
  embedding?: Float32Array;
  /**
   * Step 15H identity/persistence fields. All are metadata — never audio bytes.
   * `analysisSourceFormat` is the lossless container actually analyzed.
   * `fileHash` = SHA-256 of the exact source container bytes.
   * `contentHash` = SHA-256 of the versioned canonical PCM (NOT features/name).
   * `contentHashVersion` pins the canonical-PCM spec that produced contentHash.
   */
  analysisSourceFormat?: AnalysisSourceFormat;
  fileHash?: string;
  contentHash?: string;
  contentHashVersion?: string;
  /**
   * Step 15J: the versioned similarity fingerprint (similarity-v1).
   * Compact, serializable metadata (string + number[]); NEVER audio bytes.
   * Present only when analysis succeeded and fingerprint derivation succeeded.
   */
  similarityFingerprint?: import("../similarity/similarityFingerprint").SimilarityFingerprint;
  /**
   * Step 16H: LOCAL usage-acceptance / global-publish delivery state.
   *
   * Option A durability (16G §14): this is a LOCAL, best-effort marker persisted
   * on the existing record — NOT global truth, no new DB/D1 schema, no cloud
   * service, no audio. It records:
   *   - `usageAcceptedAt` — set once a VERIFIED Machiniste transfer actually
   *     succeeded for this sampleId (the 16G acceptance boundary). An absent
   *     `globalPublish` means "not yet usage-accepted".
   *   - `delivery` — "pending" (accepted, not yet globally stored) or
   *     "published" (locally noted as delivered; the GlobalSampleIndex remains
   *     the authoritative source of global truth on restart).
   *
   * The marker is metadata-only (two strings) and survives `assertNoAudioBytes`.
   */
  globalPublish?: {
    usageAcceptedAt: string;
    delivery: "pending" | "published";
  };
}

export interface IndexQuery {
  primaryClass?: ClassId;
  search?: string;
  status?: AnalysisStatus;
  owner?: string;
  minDuration?: number;
  maxDuration?: number;
  sortBy?: "confidence" | "name" | "analyzedAt";
  sortDir?: "asc" | "desc";
  limit?: number;
}

const DEFAULT_SORT: NonNullable<IndexQuery["sortBy"]> = "confidence";

/**
 * Deep-walk a value and throw if any audio byte container is present. This is
 * the runtime enforcement of the persistence invariant
 * (SAMPLEMAP_V1_SPEC §1.1): no Blob / ArrayBuffer / SharedArrayBuffer and no
 * non-embedding typed array may ever be written through the index store.
 */
export function assertNoAudioBytes(value: unknown, path = "$"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "object") {
    if (
      value instanceof Blob ||
      value instanceof ArrayBuffer ||
      // SharedArrayBuffer is not a global in non-cross-origin-isolated browser
      // contexts (including default headless Chrome); guard it so the invariant
      // check never throws ReferenceError and breaks writes in the real browser.
      (typeof SharedArrayBuffer !== "undefined" &&
        value instanceof SharedArrayBuffer)
    ) {
      throw new Error(`audio byte container prohibited at ${path}`);
    }
    if (ArrayBuffer.isView(value)) {
      // Float32Array is reserved for the (optional) embedding field and is not audio.
      if (value instanceof Float32Array) return;
      throw new Error(`non-embedding typed array prohibited at ${path}`);
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertNoAudioBytes(v, `${path}[${i}]`));
      return;
    }
    for (const key of Object.keys(value)) {
      assertNoAudioBytes(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    }
  }
}

/**
 * Structural read-path validation for persisted `SampleIndexRecord` rows.
 *
 * A row is "well-formed" when it carries the minimal mandatory shape every
 * record produced by the pipeline/hydration always has. Rows that fail this
 * check are treated as corrupt: reads exclude them (see `get`/`getAll`) so
 * malformed persisted data can never crash search, map, similarity, publish
 * reconstruction or mount, and a corrupt record with a valid sampleId is
 * simply undefined to `get`, which lets the analysis pipeline re-analyze and
 * self-heal it. Invalid rows are NOT deleted — they are preserved in storage
 * for a future inspection/repair path.
 *
 * Note: structural corruption can reach the stores because `put` enforces only
 * the no-audio-bytes invariant, NOT the full record shape (older writers /
 * manual edits / partial version-migrated rows are the threat model).
 */
export function isWellFormedIndexRecord(value: unknown): value is SampleIndexRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.sampleId !== "string" || r.sampleId.length === 0) return false;
  if (typeof r.owner !== "string") return false;
  if (typeof r.name !== "string") return false;
  if (typeof r.primaryClass !== "string") return false;
  if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence)) return false;
  const statuses: readonly string[] = ["pending", "analyzed", "failed", "gone"];
  if (typeof r.status !== "string" || !statuses.includes(r.status)) return false;
  if (!Array.isArray(r.originalTags) || !r.originalTags.every((t) => typeof t === "string")) {
    return false;
  }
  if (
    !Array.isArray(r.secondaryClasses) ||
    !r.secondaryClasses.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as Record<string, unknown>).class === "string" &&
        typeof (s as Record<string, unknown>).confidence === "number" &&
        Number.isFinite((s as Record<string, unknown>).confidence as number),
    )
  ) {
    return false;
  }
  if (typeof r.analyzedAt !== "string") return false;
  if (typeof r.classificationVersion !== "string") return false;
  const af = r.audioFeatures as Record<string, unknown> | undefined;
  if (typeof af !== "object" || af === null) return false;
  if (typeof af.duration !== "number" || !Number.isFinite(af.duration)) return false;
  if (typeof af.sampleRate !== "number" || !Number.isFinite(af.sampleRate)) return false;
  // STEP48: a persisted `hier` block, when present, must be coherent — an
  // incoherent family/type pair fails the same structural gate; such rows are
  // treated as absent (undefined to `get`) so the pipeline re-analyzes them.
  const hier = r.hier as unknown;
  if (hier !== undefined && !isWellFormedHierClassification(hier)) return false;
  return true;
}

export class IndexStore {
  constructor(private readonly db: ElasticDB) {}

  async put(record: SampleIndexRecord): Promise<void> {
    assertNoAudioBytes(record);
    await this.db.put(STORES.samples, record);
  }

  async get(sampleId: string): Promise<SampleIndexRecord | undefined> {
    const record = await this.db.get<SampleIndexRecord>(STORES.samples, sampleId);
    // Corrupt row -> treated as absent (undefined), never a crash. Callers have
    // a clear undefined/NotFound path; the analysis pipeline self-heals by
    // re-analyzing.
    if (record !== undefined && !isWellFormedIndexRecord(record)) return undefined;
    return record;
  }

  async getAll(): Promise<SampleIndexRecord[]> {
    const records = await this.db.getAll<SampleIndexRecord>(STORES.samples);
    // Structural read-path validation: exclude malformed rows from every
    // projection (search, query, map, similarity, publish reconstruction).
    return records.filter(isWellFormedIndexRecord);
  }

  async delete(sampleId: string): Promise<void> {
    await this.db.delete(STORES.samples, sampleId);
  }

  async clear(): Promise<void> {
    await this.db.clear(STORES.samples);
  }

  async count(): Promise<number> {
    return this.db.count(STORES.samples);
  }

  private matchesClass(record: SampleIndexRecord, classId: ClassId): boolean {
    return (
      record.primaryClass === classId ||
      record.secondaryClasses.some((c) => c.class === classId)
    );
  }

  async query(query: IndexQuery = {}): Promise<SampleIndexRecord[]> {
    const all = await this.getAll();
    let rows = all;

    if (query.primaryClass) {
      rows = rows.filter((r) => this.matchesClass(r, query.primaryClass!));
    }
    if (query.owner) {
      rows = rows.filter((r) => r.owner === query.owner);
    }
    if (query.status) {
      rows = rows.filter((r) => r.status === query.status);
    }
    if (query.minDuration !== undefined) {
      rows = rows.filter((r) => r.audioFeatures.duration >= query.minDuration!);
    }
    if (query.maxDuration !== undefined) {
      rows = rows.filter((r) => r.audioFeatures.duration <= query.maxDuration!);
    }
    if (query.search && query.search.trim()) {
      const andTerms = tokenize(query.search);
      rows = rows.filter((r) =>
        andTerms.every((term) =>
          tokenize(`${r.name} ${r.originalTags.join(" ")}`).some((w) =>
            w.includes(term),
          ),
        ),
      );
    }

    const sortBy = query.sortBy ?? DEFAULT_SORT;
    const dir = query.sortDir ?? "desc";
    rows = [...rows].sort((a, b) => compareFor(a, b, sortBy, dir));

    if (query.limit !== undefined && query.limit > 0) {
      rows = rows.slice(0, query.limit);
    }
    return rows;
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function compareFor(
  a: SampleIndexRecord,
  b: SampleIndexRecord,
  sortBy: NonNullable<IndexQuery["sortBy"]>,
  dir: "asc" | "desc",
): number {
  let cmp: number;
  if (sortBy === "name") {
    cmp = a.name.localeCompare(b.name);
  } else if (sortBy === "analyzedAt") {
    cmp = a.analyzedAt.localeCompare(b.analyzedAt);
  } else {
    cmp = a.confidence - b.confidence;
  }
  return dir === "asc" ? cmp : -cmp;
}
