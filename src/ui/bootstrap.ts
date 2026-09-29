import type { AudiotoolClient, SyncedDocument } from "@audiotool/nexus";
import type { SampleMeta } from "@audiotool/nexus/api";
import { openDatabase } from "../persistence/db";
import { IndexStore } from "../persistence/indexStore";
import type { SampleIndexRecord } from "../persistence/indexStore";
import { QueueStore } from "../persistence/queueStore";
import { IndexedDBCollectionStore } from "../persistence/collectionStore";
import { SampleMapSearchEngine } from "../search/searchEngine";
import { PreviewService } from "../preview/previewService";
import { AnalysisPipeline, DEFAULT_SUPPORTED_VERSIONS } from "../pipeline/analysisPipeline";
import type { FetchedAudio } from "../pipeline/analysisPipeline";
import { JobRunner } from "../pipeline/jobRunner";
import type { AnalysisBudget, JobDoneHook } from "../pipeline/jobRunner";
import type { LosslessSource } from "../pipeline/sourceSelection";
import { HeuristicClassifier } from "../classify/heuristicClassifier";
import { HierClassifier } from "../classify/hierClassifier";
import { extractFeatures } from "../audio/featureExtractor";
import type { AudioDecoder } from "../audio/decodedAudio";
import { SampleMapMachinisteService } from "../machiniste/machinisteService";
import { resolveAuthenticatedUserId } from "../identity/authenticatedUser";
import type { SampleMapAppDeps } from "./app";
import { createStorageEp7ConsentStore } from "./ep7Consent";
import type { PageFetcher, KnownProvider } from "../library/libraryScanner";
import { GlobalLookup } from "../global/lookup";
import type { GlobalSampleIndex } from "../global/contract";
import type { GlobalPublishQueue } from "../global/publishQueue";
import type { PublishDeliveryMode } from "./view";

/**
 * Browser bootstrap wiring (SAMPLEMAP_V1_SPEC §20.11 / §12).
 *
 * Constructs the real services and returns `SampleMapAppDeps` for the UI. This
 * is glue only — it composes existing modules; it adds no business logic.
 *
 * Several pieces here require a live browser + a real, authenticated Audiotool
 * client and an opened project (Web Audio decode, network fetch, Nexus document).
 * These are NOT exercised by the automated test suite and are marked
 * NOT VERIFIED in the step report — the automated UI tests use injected fakes
 * (`SampleMapAppDeps`) exactly like this factory's output shape.
 */

export const ANALYSIS_BUILD = "smap-build-v1";

/** Build the persistent stores from the SampleMap schema. */
export async function openStores() {
  const handle = await openDatabase();
  return {
    db: handle.db,
    index: handle.index,
    queue: handle.queue,
  };
}

/** Browser Web Audio decode → DecodedAudio (channel-summed mono). */
export function browserDecode(audioCtx: AudioContext): AudioDecoder {
  return async (bytes: ArrayBuffer) => {
    const buffer = await audioCtx.decodeAudioData(bytes.slice(0));
    const channelData = buffer.getChannelData(0);
    const mono = new Float32Array(buffer.length);
    if (buffer.numberOfChannels === 1) {
      mono.set(channelData);
    } else {
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] += d[i];
      }
      for (let i = 0; i < mono.length; i++) mono[i] /= buffer.numberOfChannels;
    }
    return {
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      mono,
      durationSeconds: buffer.duration,
    };
  };
}

/**
 * Hard upper bound for a single analysis-audio request.
 *
 * The analysis JobRunner is strictly serial, so one hung CDN request stalls
 * every remaining sample: `fetch` without a timeout never settles, and the
 * pipeline cannot move past an unresolved `await`. Measured healthy fetch is
 * ~1.2 s per `s.wav`, so 30 s keeps a wide margin while still bounding a
 * stalled connection.
 */
export const AUDIO_FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch a sample's lossless audio bytes for transient in-RAM analysis (Step 15H).
 *
 * STEP77 — `cache: "no-store"` is mandatory here. The Audiotool CDN answers the
 * lossless sample URLs with `Cache-Control: public, max-age=86400`, so a plain
 * `fetch(url)` persists every sample's full audio in the browser's HTTP disk
 * cache (measured: 172 samples -> +483 MB `Cache_Data`, 563 MB after browser
 * close) even though the bytes are only needed transiently in RAM. Analysis
 * results belong in IndexedDB; the audio itself must never be persisted.
 *
 * The request is bounded by `AUDIO_FETCH_TIMEOUT_MS` via an `AbortController`.
 * On expiry the fetch is aborted and rejects with an `AbortError`, which the
 * analysis pipeline maps to a regular `failed` job — the existing retry/backoff
 * logic then applies unchanged. The abort signal does not affect cache
 * semantics, so the `no-store` policy stays intact.
 */
export async function browserFetchAudio(
  _sample: SampleMeta,
  source: LosslessSource,
): Promise<FetchedAudio> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const bytes = await res.arrayBuffer();
    return { bytes, release: () => undefined };
  } finally {
    // Runs on every exit path: success, non-2xx, abort, and any other throw.
    clearTimeout(timer);
  }
}

/**
 * Build the full dependency set for the SampleMap UI from a browser session.
 * `client` must be authenticated; `doc` is the opened project document used for
 * machiniste sends (step-12 concern; `undefined` disables machiniste).
 */
export async function buildBrowserDeps(opts: {
  client: AudiotoolClient;
  /** Opened project document used for machiniste sends (required). */
  doc: SyncedDocument;
  analysisBuild?: string;
  /**
   * STEP38 — the authenticated user's DISPLAY NAME (as exposed by the browser
   * auth result). Resolved to the stable `users/{uuid}` account id BEFORE the
   * deps are returned; absent/unresolvable → "own detection unavailable".
   */
  authenticatedUserName?: string;
  /**
   * Step 16J: the global index provider for analysis reuse. When provided (e.g.
   * the live `CloudflareGlobalAdapter` from `createGlobalProvider`), a globally
   * known + compatible sample reuses the stored analysis instead of running the
   * local audio chain. When absent, local analysis always runs.
   */
  globalIndex?: GlobalSampleIndex;
  /**
   * STEP16R E-P6 — read-only publish queue for the publish-status surface.
   * Defaults to `undefined` (no publish surface).
   */
  globalPublishQueue?: GlobalPublishQueue;
  /** STEP16R E-P6 — delivery mode of the wired provider. Default "offline". */
  globalPublishDelivery?: PublishDeliveryMode;
}): Promise<SampleMapAppDeps> {
  const stores = await openStores();
  const index = new IndexStore(stores.db);
  const queue = new QueueStore(stores.db);
  const collectionStore = new IndexedDBCollectionStore(stores.db);
  const search = new SampleMapSearchEngine(index);
  const preview = new PreviewService();
  const classifier = new HeuristicClassifier();
  // STEP44 — hierarchical classifier (hier-v1), additive. When wired the
  // pipeline records `classificationVersion: "hier-v1"` + the `hier` field on
  // newly analyzed samples; legacy heuristic-v1 records are untouched (SC12).
  const hierClassifier = new HierClassifier();
  const audioCtx = new AudioContext();

  // STEP38 — resolve the authenticated user's STABLE account id (`users/{uuid}`,
  // never the display name). Absent/unresolvable → undefined (own detection
  // unavailable; every sample evaluates under foreign rules, never wrongly
  // promoted to own). Non-fatal: a resolution failure never blocks the app.
  // STEP64 — with the OAuth `GetWhoami` `users/{slug}` fast path this is O(1)
  // (no network) and no longer performs the full project pagination.
  const authenticatedUserId = await resolveAuthenticatedUserId(
    opts.client,
    opts.authenticatedUserName,
  );

  // Resolve sample metadata from the library client, falling back to a cache.
  const metaCache = new Map<string, SampleMeta>();
  const resolveSample = async (sampleId: string): Promise<SampleMeta | undefined> => {
    const cached = metaCache.get(sampleId);
    if (cached) return cached;
    const meta = await opts.client.samples.get(sampleId);
    if (meta instanceof Error) return undefined;
    metaCache.set(sampleId, meta);
    return meta;
  };

  const pipeline = new AnalysisPipeline({
    fetchAudio: browserFetchAudio,
    decode: browserDecode(audioCtx),
    extract: extractFeatures,
    classifier,
    // STEP44 — hier evidence classification of every newly analyzed sample.
    classifyHier: (input) => Promise.resolve(hierClassifier.classifyHier(input)),
    resolveSample,
    index,
    analysisVersion: "features-v1",
    globalLookup: opts.globalIndex
      ? new GlobalLookup(opts.globalIndex, DEFAULT_SUPPORTED_VERSIONS)
      : undefined,
    supportedVersions: DEFAULT_SUPPORTED_VERSIONS,
  });

  const queueStore = queue;
  const analysisBuild = opts.analysisBuild ?? ANALYSIS_BUILD;
  const createRunner = (budget: AnalysisBudget, onJobDone?: JobDoneHook) =>
    new JobRunner({ pipeline, queue: queueStore, analysisBuild, budget, onJobDone });

  // Known-updatedAt provider: index.analyzedAt as a "seen" proxy for delta scan.
  const known: KnownProvider = {
    getUpdatedAt: async (sampleId: string) => {
      const rec = await index.get(sampleId);
      return rec ? rec.analyzedAt : undefined;
    },
  };

  // Page fetcher wraps the real samples.list client (existing API).
  // STEP81: `orderBy` is forwarded VERBATIM (it is undefined for the own-library
  // scan, so that path is unchanged). Without this pass-through the public
  // discovery lanes would silently fall back to the default listing order.
  const pageFetcher: PageFetcher = async ({ pageSize, pageToken, orderBy }) => {
    const res = await opts.client.samples.list({ pageSize, pageToken, orderBy });
    if (res instanceof Error) throw res;
    return { samples: res.samples, nextPageToken: res.nextPageToken };
  };

  const previewUrlFor = (record: SampleIndexRecord): string | undefined => {
    return metaCache.get(record.sampleId)?.previewMp3Url;
  };

  const machiniste = new SampleMapMachinisteService(opts.doc);

  // STEP76 POC — explicit scan-budget override for controlled measurement.
  // Inactive by default: without ?scanMaxSamples= the app keeps the standard
  // 200 budget exactly as before. Only an explicit, finite, in-range value in
  // the URL opts into a larger scan. Never unbounded.
  const scanMaxSamples = readScanMaxSamplesOverride();

  return {
    queue,
    index,
    search,
    preview,
    machiniste,
    createRunner,
    fetchPage: pageFetcher,
    known,
    // STEP80 — reuse the SAME already-opened IndexedDB handle for the tiny
    // public-discovery cursor store (never a second database).
    dbForDiscovery: stores.db,
    previewUrlFor,
    analysisBuild,
    scanMaxSamples,
    globalIndex: opts.globalIndex,
    resolveSample,
    globalPublishQueue: opts.globalPublishQueue,
    globalPublishDelivery: opts.globalPublishDelivery,
    // STEP28 — persistent Sound Collection store (references only, survives
    // page reloads on the same origin).
    collectionStore,
    // STEP19A E-P7 — localStorage-backed one-time consent preference, so the
    // granted state survives page reloads. Strict sentinel read in the store.
    ep7Consent: createStorageEp7ConsentStore(window.localStorage),
    // STEP38 — stable authenticated account id driving own/foreign eligibility.
    authenticatedUserId,
  };
}

/**
 * STEP76 POC — reads the optional `?scanMaxSamples=` query parameter.
 *
 * Returns the standard scan budget (200) unless the URL explicitly carries a
 * finite, positive, in-range override. Anything else — missing, malformed,
 * non-finite, non-positive or out of range — falls back to the standard budget.
 * The override is never read from storage, so it cannot persist or creep up.
 */
export function readScanMaxSamplesOverride(
  search: string = typeof window === "undefined" ? "" : window.location.search,
  standard: number = STANDARD_SCAN_MAX_SAMPLES,
): number {
  const raw = new URLSearchParams(search).get("scanMaxSamples");
  if (raw === null || raw.trim() === "") return standard;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return standard;
  const value = Math.floor(parsed);
  if (value < 1 || value > MAX_SCAN_MAX_SAMPLES_OVERRIDE) return standard;
  return value;
}

/** Hard ceiling for the POC override — the scan is never allowed to run unbounded. */
const MAX_SCAN_MAX_SAMPLES_OVERRIDE = 5000;

/** The unmodified STEP76 standard scan budget. */
const STANDARD_SCAN_MAX_SAMPLES = 200;
