/**
 * CloudflareGlobalSampleIndex — the 16F provider.
 *
 * Implements the `GlobalSampleIndex` contract (src/global/contract.ts) against
 * a Cloudflare D1 database binding, reusing the existing pure domain
 * authorities:
 *   - `validatePublishResult` (src/global/validation.ts) — full trust-model
 *     structural validation INCLUDING the no-audio guard (it throws on audio
 *     bytes) and the derived map/similarity cross-check (server-side recompute
 *     from features, WITHOUT audio, 16E §15).
 *   - `selectRepresentative` (src/identity/audioContentIdentity.ts) — the ONE
 *     representative rule (lex-min sampleId), never a second rule.
 *   - `assertNoAudioBytes` (src/persistence/indexStore.ts) — the ONE no-audio
 *     guard, re-run on request payloads and returned rows (16E §16).
 *
 * This provider is intentionally free of browser DOM / IndexedDB / audio code
 * so it runs inside a Cloudflare Worker. It NEVER writes to any local
 * (browser/indexedDB) index and is strictly metadata-only.
 *
 * Atomicity / batching (16E §10): D1 `db.batch()` is the transaction primitive.
 * Each publish item is [ref-pre-read, content upsert, sample_ref upsert] in the
 * SAME `batch()` so a single item can never half-commit. Chunks respect the
 * 100-bound-parameter-per-query limit.
 */
import type {
  GlobalSampleIndex,
  GlobalSampleLookupHit,
  GlobalContentLookupHit,
  GlobalAnalysisResult,
  GlobalPublishOutcome,
  GlobalPublishItemOutcome,
  GlobalPublishBatch,
  GlobalMapViewportResult,
  GlobalMapPoint,
  GlobalSoundCharacterKnowledge,
  MapViewportQuery,
} from "../../../src/global/contract";
import { validatePublishResult } from "../../../src/global/validation";
import {
  contentIdentityKey,
  selectRepresentative,
} from "../../../src/identity/audioContentIdentity";
import { SIMILARITY_VERSION } from "../../../src/similarity/similarityFingerprint";
import {
  assertNoAudioBytes,
  type AudioFeatures,
  type SecondaryClass,
} from "../../../src/persistence/indexStore";

/**
 * Max bound parameters per SQL statement in D1 (16E §10 — decisive limit).
 * An `IN (...)` clause must stay under this.
 */
const MAX_BOUND_PARAMS = 100;

export interface CloudflareGlobalIndexOptions {
  /** Publish batch validation cap (abuse control, 16E §14). */
  maxBatchSize: number;
  /** Map viewport default limit if the caller omits it (16E §12). */
  defaultMapLimit: number;
  /** Hard cap on rows returned per map page (never exceeded). */
  maxMapLimit: number;
}

/** A minimal row shape as returned by D1 `all()`. */
type Row = Record<string, unknown>;

interface ContentRow extends Row {
  content_hash: string;
  content_hash_version: string;
  classification_version: string;
  primary_class: string;
  confidence: number;
  secondary_classes: string;
  analysis_version: string;
  analysis_build: string;
  analysis_source_format: string;
  gate_passed: number;
  map_version: string;
  map_x: number;
  map_y: number;
  similarity_version: string;
  similarity_values: string;
  sound_character_v2: string | null;
  features: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row → domain mapping (single direction; no semantics invented here)
// ─────────────────────────────────────────────────────────────────────────────

function parseJsonArray<T>(value: string, path: string): T[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`expected array at ${path}`);
  return parsed as T[];
}

function parseJsonObject<T>(value: string, path: string): T {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected object at ${path}`);
  }
  return parsed as T;
}

function rowToAnalysis(row: ContentRow): GlobalAnalysisResult {
  const analysis: GlobalAnalysisResult = {
    contentIdentity: {
      contentHash: row.content_hash,
      contentHashVersion: row.content_hash_version,
    },
    classificationVersion: row.classification_version,
    primaryClass: row.primary_class,
    confidence: Number(row.confidence),
    secondaryClasses: parseJsonArray<SecondaryClass>(
      row.secondary_classes,
      "secondary_classes",
    ),
    analysisVersion: row.analysis_version,
    analysisBuild: row.analysis_build,
    map: {
      mapVersion: row.map_version,
      x: Number(row.map_x),
      y: Number(row.map_y),
    },
    similarity: {
      similarityVersion: row.similarity_version as typeof SIMILARITY_VERSION,
      values: parseJsonArray<number>(row.similarity_values, "similarity_values"),
    },
    analysisSourceFormat: row.analysis_source_format as "wav" | "flac",
    gatePassed: true,
    audioFeatures: parseJsonObject<AudioFeatures>(row.features, "features"),
  };
  // STEP41 — carry the compact V2 knowledge block when the row has one (a
  // legacy row published before the column exists is simply absent — additive,
  // never a null that poisons the result). A corrupt stored JSON block is
  // treated as absent, never a crash.
  if (row.sound_character_v2 != null) {
    try {
      const v2Knowledge = parseJsonObject<GlobalSoundCharacterKnowledge>(
        row.sound_character_v2,
        "sound_character_v2",
      );
      analysis.soundCharacterV2 = v2Knowledge;
    } catch {
      // omit the block; the row stays readable and the no-audio guard below
      // still runs over everything we actually return.
    }
  }
  // No-audio guard on everything we return to a caller (16E §16).
  assertNoAudioBytes(analysis, "$analysis");
  return analysis;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunking helpers (respect the D1 100-bound-param limit)
// ─────────────────────────────────────────────────────────────────────────────

function chunkIds<T>(ids: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

function inPlaceholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export class CloudflareGlobalSampleIndex implements GlobalSampleIndex {
  private readonly db: D1Database;
  private readonly opts: CloudflareGlobalIndexOptions;

  constructor(db: D1Database, opts: CloudflareGlobalIndexOptions) {
    this.db = db;
    this.opts = opts;
  }

  // ── 16F-4 Sample lookup (fast-path, read-only) ───────────────────────────
  async lookupSamples(
    sampleIds: readonly string[],
  ): Promise<GlobalSampleLookupHit[]> {
    assertNoAudioBytes(sampleIds, "$samples");
    const unique = [...new Set(sampleIds)];
    const known = new Map<string, GlobalSampleLookupHit>();

    for (const chunk of chunkIds(unique, MAX_BOUND_PARAMS)) {
      const rows = (
        await this.db
          .prepare(
            `SELECT s.sample_id, s.content_hash AS sample_content_hash,
                    s.content_hash_version AS sample_content_hash_version,
                    c.content_hash, c.content_hash_version,
                    c.primary_class, c.confidence, c.secondary_classes,
                    c.analysis_version, c.analysis_build,
                    c.classification_version, c.analysis_source_format,
                    c.gate_passed, c.map_version, c.map_x, c.map_y,
                    c.similarity_version, c.similarity_values,
                    c.sound_character_v2, c.features
             FROM sample_ref s
             JOIN content c
               ON c.content_hash = s.content_hash
              AND c.content_hash_version = s.content_hash_version
             WHERE s.sample_id IN (${inPlaceholders(chunk.length)})`,
          )
          .bind(...chunk)
          .all<ContentRow>()
      ).results;
      for (const row of rows) {
        const sampleId = String(row.sample_id);
        const analysis = rowToAnalysis(row);
        known.set(sampleId, {
          status: "known",
          sampleId,
          contentIdentity: analysis.contentIdentity,
          analysis,
        });
      }
    }

    // One hit per unique input sampleId, in input order.
    return unique.map((sampleId) => {
      const hit = known.get(sampleId);
      return hit ?? { status: "unknown", sampleId };
    });
  }

  // ── 16F-5 Content lookup (identity path + representative) ────────────────
  async lookupContentIdentities(
    identities: readonly { contentHash: string; contentHashVersion: string }[],
  ): Promise<GlobalContentLookupHit[]> {
    assertNoAudioBytes(identities, "$identities");
    const unique = new Map<
      string,
      { contentHash: string; contentHashVersion: string }
    >();
    for (const id of identities) unique.set(contentIdentityKey(id), id);

    const results: GlobalContentLookupHit[] = [];

    for (const id of [...unique.values()]) {
      const contentRows = (
        await this.db
          .prepare(
            `SELECT content_hash, content_hash_version, primary_class, confidence,
                    secondary_classes, analysis_version, analysis_build,
                    classification_version, analysis_source_format,
                    gate_passed, map_version, map_x, map_y,
                    similarity_version, similarity_values,
                    sound_character_v2, features
             FROM content
             WHERE content_hash = ? AND content_hash_version = ?`,
          )
          .bind(id.contentHash, id.contentHashVersion)
          .all<ContentRow>()
      ).results;

      if (contentRows.length === 0) continue; // absent → domain maps to unknown

      const analysis = rowToAnalysis(contentRows[0]);

      const refRows = (
        await this.db
          .prepare(
            `SELECT sample_id FROM sample_ref
             WHERE content_hash = ? AND content_hash_version = ?`,
          )
          .bind(id.contentHash, id.contentHashVersion)
          .all<Row>()
      ).results;
      const sampleIds = refRows.map((r) => String(r.sample_id));

      results.push({
        contentIdentity: analysis.contentIdentity,
        analysis,
        sampleIds,
        // ONE representative authority (lex-min), never a second rule.
        representativeSampleId: selectRepresentative(sampleIds),
      });
    }

    return results;
  }

  // ── 16F-6/7 Publish (idempotent, atomic per item, conflict-safe) ─────────
  async publishAnalysisResults(
    batch: GlobalPublishBatch,
  ): Promise<GlobalPublishOutcome> {
    assertNoAudioBytes(batch, "$publish");
    if (batch.length > this.opts.maxBatchSize) {
      throw {
        kind: "validation-rejected",
        reason: `batch of ${batch.length} exceeds max ${this.opts.maxBatchSize}`,
      } as const;
    }

    const outcomes: GlobalPublishItemOutcome[] = new Array(batch.length);
    const stmts: D1PreparedStatement[] = [];
    // Map of batch index -> index into stmts where that item's statements begin.
    const itemStart: number[] = new Array(batch.length).fill(-1);

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      let issues;
      try {
        issues = validatePublishResult(item);
      } catch (err) {
        // assertNoAudioBytes throws on any audio byte container.
        outcomes[i] = {
          status: "rejected",
          reason: `rejected: ${String(err)}`,
        };
        continue;
      }
      if (issues.length > 0) {
        outcomes[i] = {
          status: "rejected",
          reason: `validation-rejected: ${issues[0].message}`,
        };
        continue;
      }

      const { sampleId, contentIdentity, analysis, features } = item;
      itemStart[i] = stmts.length;

      // (a) Pre-read current sample_ref binding (deterministic conflict check,
      //     no last-write-wins, 16E §11). Read-only; part of the item's atomic set.
      stmts.push(
        this.db
          .prepare(
            `SELECT content_hash, content_hash_version FROM sample_ref
             WHERE sample_id = ?`,
          )
          .bind(sampleId),
      );

      // (b) content: insert-or-ignore — a repeat content is already-known, never
      //     a second row (PK + ON CONFLICT DO NOTHING, 16E §9).
      stmts.push(this.contentUpsert(contentIdentity, analysis, features));

      // (c) sample_ref: insert-new, but only re-point when a conflicting binding
      //     already exists AND differs (rejected, never overwritten). The WHERE
      //     guard means an identical re-publish is a no-op (already-known).
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO sample_ref (sample_id, content_hash, content_hash_version, published_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(sample_id) DO UPDATE SET
               content_hash = excluded.content_hash,
               content_hash_version = excluded.content_hash_version
             WHERE sample_ref.content_hash = excluded.content_hash
               AND sample_ref.content_hash_version = excluded.content_hash_version
             RETURNING rowid`,
          )
          .bind(
            sampleId,
            contentIdentity.contentHash,
            contentIdentity.contentHashVersion,
            new Date().toISOString(),
          ),
      );
    }

    if (stmts.length === 0) {
      // Every item rejected during validation; nothing to execute.
      return { items: outcomes, accepted: false };
    }

    // Execute all item statement groups atomically (each item is internally
    // atomic because its 3 statements share one batch call).
    let results: { meta: Record<string, unknown>; results: Row[] }[];
    try {
      results = await this.db.batch<Row>(stmts);
    } catch (err) {
      for (let i = 0; i < batch.length; i++) {
        if (!outcomes[i]) {
          outcomes[i] = {
            status: "rejected",
            reason: `temporary-unavailable: ${String(err)}`,
          };
        }
      }
      return { items: outcomes, accepted: false };
    }

    for (let i = 0; i < batch.length; i++) {
      if (outcomes[i]) continue; // already rejected during validation
      const start = itemStart[i];
      const preRead = results[start].results as Row[];
      const contentRes = results[start + 1];
      const refRes = results[start + 2];
      outcomes[i] = classifyPublishOutcome(
        preRead,
        batch[i].contentIdentity,
        contentRes,
        refRes,
      );
    }

    return {
      items: outcomes,
      accepted: outcomes.every((o) => o.status !== "rejected"),
    };
  }

  // ── 16F-8 Map viewport (bounded bbox + LIMIT + cursor, deterministic) ────
  async queryMapViewport(
    query: MapViewportQuery,
  ): Promise<GlobalMapViewportResult> {
    const limit = Math.min(
      query.limit ?? this.opts.defaultMapLimit,
      this.opts.maxMapLimit,
    );
    const clauses: string[] = ["map_version = ?"];
    const params: unknown[] = [query.mapVersion];

    if (query.xMin !== undefined && query.xMax !== undefined) {
      clauses.push("map_x >= ?", "map_x <= ?");
      params.push(query.xMin, query.xMax);
    }
    if (query.yMin !== undefined && query.yMax !== undefined) {
      clauses.push("map_y >= ?", "map_y <= ?");
      params.push(query.yMin, query.yMax);
    }
    if (query.primaryClass !== undefined) {
      clauses.push("primary_class = ?");
      params.push(query.primaryClass);
    }

    const offset = cursorOffset(query.cursor);
    const rows = (
      await this.db
        .prepare(
          `SELECT content_hash, content_hash_version, map_x, map_y, primary_class
           FROM content
           WHERE ${clauses.join(" AND ")}
           ORDER BY map_y, map_x
           LIMIT ? OFFSET ?`,
        )
        .bind(...params, limit + 1, offset)
        .all<Row>()
    ).results;

    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    const points: GlobalMapPoint[] = [];

    for (const row of visible) {
      const contentIdentity = {
        contentHash: String(row.content_hash),
        contentHashVersion: String(row.content_hash_version),
      };
      // representative per point: the SAME single lex-min rule, via MIN(sample_id).
      const repRows = (
        await this.db
          .prepare(
            `SELECT MIN(sample_id) AS rep FROM sample_ref
             WHERE content_hash = ? AND content_hash_version = ?`,
          )
          .bind(contentIdentity.contentHash, contentIdentity.contentHashVersion)
          .all<Row>()
      ).results;
      const representativeSampleId =
        repRows.length > 0 && repRows[0].rep != null
          ? String(repRows[0].rep)
          : contentIdentity.contentHash;
      assertNoAudioBytes({ ...contentIdentity, representativeSampleId }, "$map");
      points.push({
        contentIdentity,
        x: Number(row.map_x),
        y: Number(row.map_y),
        representativeSampleId,
        primaryClass: String(row.primary_class),
      });
    }

    const result: GlobalMapViewportResult = {
      mapVersion: query.mapVersion,
      points,
    };
    if (hasMore) result.nextCursor = String(offset + visible.length);
    return result;
  }

  // -------------------------------------------------------------------------
  private contentUpsert(
    contentIdentity: GlobalAnalysisResult["contentIdentity"],
    analysis: GlobalAnalysisResult,
    features: AudioFeatures,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO content
          (content_hash, content_hash_version, classification_version,
           primary_class, confidence, secondary_classes, analysis_version,
           analysis_build, analysis_source_format, gate_passed, map_version,
           map_x, map_y, similarity_version, similarity_values,
           sound_character_v2,
           representative_version, features, first_published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(content_hash, content_hash_version) DO UPDATE SET
           sound_character_v2 = COALESCE(content.sound_character_v2,
                                         excluded.sound_character_v2)`,
      )
      .bind(
        contentIdentity.contentHash,
        contentIdentity.contentHashVersion,
        analysis.classificationVersion,
        analysis.primaryClass,
        analysis.confidence,
        jsonText(analysis.secondaryClasses),
        analysis.analysisVersion,
        analysis.analysisBuild,
        analysis.analysisSourceFormat,
        1,
        analysis.map.mapVersion,
        analysis.map.x,
        analysis.map.y,
        analysis.similarity.similarityVersion,
        jsonText(analysis.similarity.values),
        // STEP41 — compact V2 knowledge block; SQL NULL when absent (additive,
        // backfilled only into a row that has none, never clobbered).
        analysis.soundCharacterV2 === undefined
          ? null
          : jsonText(analysis.soundCharacterV2),
        "representative-v1",
        jsonText(features),
        new Date().toISOString(),
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome classification
// ─────────────────────────────────────────────────────────────────────────────

interface D1RunResultLike {
  meta: Record<string, unknown>;
  results: Row[];
}

/**
 * Classify one publish item deterministically from its batch results.
 *  - pre-read shows an existing sample_ref:
 *      * maps to SAME content → already-known (idempotent re-publish).
 *      * maps to DIFFERENT content → rejected (conflict; no last-write-wins).
 *  - no pre-existing sample_ref → stored (new sample binding).
 */
function classifyPublishOutcome(
  preRead: Row[],
  contentIdentity: { contentHash: string; contentHashVersion: string },
  _contentRes: D1RunResultLike,
  refRes: D1RunResultLike,
): GlobalPublishItemOutcome {
  const existing = preRead[0];
  if (existing) {
    const sameContent =
      String(existing.content_hash) === contentIdentity.contentHash &&
      String(existing.content_hash_version) === contentIdentity.contentHashVersion;
    if (!sameContent) {
      return {
        status: "rejected",
        reason: "conflict: sample is already mapped to a different content identity",
      };
    }
    return { status: "already-known" };
  }
  // New binding. If the sample_ref upsert actually inserted a row, it's stored.
  const changed = Number(refRes.meta.changes ?? 0) > 0;
  return changed ? { status: "stored" } : { status: "already-known" };
}

function cursorOffset(cursor?: string): number {
  if (cursor === undefined) return 0;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
