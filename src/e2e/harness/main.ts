import { createOfflineDocument } from "@audiotool/nexus";
import type { SampleMeta } from "@audiotool/nexus/api";
import { openDatabase } from "../../persistence/db";
import { IndexStore } from "../../persistence/indexStore";
import { QueueStore } from "../../persistence/queueStore";
import { IndexedDBCollectionStore } from "../../persistence/collectionStore";
import { SampleMapSearchEngine } from "../../search/searchEngine";
import { PreviewService } from "../../preview/previewService";
import { AnalysisPipeline } from "../../pipeline/analysisPipeline";
import type { FetchedAudio } from "../../pipeline/analysisPipeline";
import { JobRunner } from "../../pipeline/jobRunner";
import type { AnalysisBudget } from "../../pipeline/jobRunner";
import { HeuristicClassifier } from "../../classify/heuristicClassifier";
import { extractFeatures } from "../../audio/featureExtractor";
import { buildPcmWavBytes } from "../../audio/fixtures";
import type { AudioDecoder } from "../../audio/decodedAudio";
import { SampleMapMachinisteService } from "../../machiniste/machinisteService";
import { toSampleName } from "../../library/sampleRef";
import type { PageFetcher } from "../../library/libraryScanner";
import { mountSampleMap, disposeSampleMap } from "../../ui/render";
import type { SampleMapAppDeps } from "../../ui/app";
import { createStorageEp7ConsentStore } from "../../ui/ep7Consent";
import { GlobalPublishQueue } from "../../global/publishQueue";
import { rankSimilar, RANKING_DEFAULT_LIMIT } from "../../analysis/similarityRanking";
import { computeSoundCharacter, computeSoundCharacterQuality } from "../../analysis/soundCharacter";
import { computeCanonicalSoundSpacePoint } from "../../analysis/soundSpaceProjector";
import { ANALYSIS_VERSION, type SampleAnalysisV2 } from "../../analysis/sampleAnalysisV2";
import { analyzeAudio } from "../../audio/v2Dsp";
import type {
  GlobalSampleIndex,
  GlobalPublishItemOutcome,
  GlobalPublishBatch,
  GlobalMapPoint,
} from "../../global/contract";
import {
  clusterMapPoints,
  entryCoverage,
  globalMapPoints,
  mapPoints,
  mergeMapPoints,
  type MapEntry,
} from "../../ui/map/mapView";
import { visibleGlobalPoints } from "../../ui/map/visibility";
import {
  acceptUsageAndEnqueue,
  flushPendingPublications,
} from "../../global/usageAcceptance";
import type { TransferEvidence } from "../../global/usageAcceptance";
import type { PublishDeliveryMode } from "../../ui/view";

// ============================================================================
// SampleMap E2E BROWSER HARNESS (Step 16M, Layer A).
//
// Mounts the REAL SampleMap UI (`mountSampleMap` from src/ui/render.ts) with
// the REAL service stack composed EXACTLY like `buildBrowserDeps` in
// src/ui/bootstrap.ts, with ONLY the external-network / authenticated pieces
// substituted with deterministic OFFLINE fixtures:
//
//   REAL  : IndexStore (browser IndexedDB), QueueStore, SampleMapSearchEngine,
//           PreviewService, AnalysisPipeline, JobRunner, extractFeatures (REAL),
//           HeuristicClassifier (REAL), mapPosition (REAL), map render (REAL),
//           mountSampleMap/renderApp (REAL), scanLibrary (REAL over fixture
//           pages), SampleMapMachinisteService (REAL) over a REAL
//           createOfflineDocument() Nexus WASM document (browser loader -> CDN).
//
//   FIXTURE : fetchAudio (returns deterministic synthetic PCM WAV bytes per
//           sample), decode (REAL browser decodeAudioData), resolveSample +
//           fetchPage (fixture SampleMeta), previewUrlFor (synthetic preview URL
//           — preview PLAYBACK is not exercised; it is BLOCKED for synthetic
//           samples).
//
//   BLOCKED (never simulated) : live Audiotool Sample Pool, OAuth, live
//           Machiniste entity. Layer C.
//
// The harness exposes `window.__sm` with test hooks (state + the persisted
// index + the offline doc) so the Playwright spec can assert end-to-end.
// ============================================================================



/**
 * STEP63R — Runtime Startup Timing Audit instrumentation.
 * All measurements are logged to the harness console; production behavior is unchanged.
 */
const smTiming = {
  // Phase start times
  phaseStarts: new Map<string, number>(),

  start(phase: string) {
    this.phaseStarts.set(phase, performance.now());
  },

  end(phase: string) {
    const start = this.phaseStarts.get(phase);
    if (start !== undefined) {
      const duration = performance.now() - start;
      console.log(`[sm-timing] ${phase}: ${duration.toFixed(2)}ms`);
      this.phaseStarts.delete(phase);
    }
  },
};

const BUILD = "smap-build-v1";

/**
 * Seeded PRNG (mulberry32) for TEST DATA ONLY.
 *
 * Returns a function producing floats in [0,1). Deterministic for a given seed,
 * so every stress run sees byte-identical points. `Math.random` is never used
 * for fixtures anywhere in this harness.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface HarnessSample {
  meta: SampleMeta;
  /** Deterministic real PCM WAV bytes (decode via browser decodeAudioData). */
  bytes: ArrayBuffer;
}

let seq = 0;
function makeMeta(
  name: string,
  displayName: string,
  tags: string[],
  metadata: Partial<
    Pick<SampleMeta, "numFavorites" | "numUsages" | "bpm">
  > = {},
): SampleMeta {
  seq += 1;
  const id = toSampleName(name);
  return {
    name: id,
    displayName,
    description: "",
    ownerName: "users/alice",
    favoritedByUser: false,
    numFavorites: metadata.numFavorites ?? 0,
    numUsages: metadata.numUsages ?? 0,
    bpm: metadata.bpm ?? 0,
    kind: "one-shot",
    visibility: "public",
    tags,
    createTime: new Date("2026-01-01T00:00:00.000Z"),
    updateTime: new Date("2026-01-01T00:00:00.000Z"),
    durationSeconds: 0.5,
    mp3Url: `https://example.mp3/${id}`,
    wavUrl: `https://example.wav/${id}`,
    flacUrl: `https://example.flac/${id}`,
    previewMp3Url: `https://example.preview/${id}`,
    getWaveformUrl: () => `https://example.waveform/${id}`,
  };
}

/** Encode a float mono waveform as 16-bit PCM WAV bytes decodable by Web Audio. */
function pcmWav(mono: Float32Array, sampleRate: number): ArrayBuffer {
  const samples = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    samples[i] = Math.round(v * 32767);
  }
  return buildPcmWavBytes({ sampleRate, channels: 1, bitsPerSample: 16, samples });
}

/** Deterministic synthetic waveforms mirroring the offline e2e profiles. */
function waveform(profile: string, sampleRate: number): Float32Array {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  switch (profile) {
    case "kick": {
      // short, dark, tonal decaying thump -> kick
      const n = Math.floor(sampleRate * 0.4);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        mono[i] = Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 30);
      }
      return mono;
    }
    case "hat": {
      // short, bright, transient, noisy -> hihat
      const n = Math.floor(sampleRate * 0.15);
      const mono = new Float32Array(n);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const r = rnd() * 2 - 1;
        const hp = r - prev; // first-difference high-pass -> bright + noisy
        prev = r;
        mono[i] = hp * 0.9;
      }
      return mono;
    }
    case "bass": {
      // long, dark, sustained tonal -> bass
      const n = Math.floor(sampleRate * 2.0);
      const mono = new Float32Array(n);
      const attack = Math.floor(sampleRate * 0.2);
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const env = Math.min(1, i / attack);
        mono[i] = Math.sin(2 * Math.PI * 55 * t) * env * 0.9;
      }
      return mono;
    }
    case "noise":
      // long, broadband, flat-spectrum noise -> noise
      const n3 = Math.floor(sampleRate * 2.0);
      const mono3 = new Float32Array(n3);
      for (let i = 0; i < n3; i++) {
        mono3[i] = (rnd() * 2 - 1) * 0.9;
      }
      return mono3;
    case "lead": {
      // sustained tonal tone at a mid spectral centroid (interior map y)
      const n = Math.floor(sampleRate * 1.2);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        mono[i] = Math.sin(2 * Math.PI * 1500 * t) * Math.exp(-t * 1.2);
      }
      return mono;
    }
    default:
      return new Float32Array(0);
  }
}

function buildSamples(): HarnessSample[] {
  const sampleRate = 44100;
  const defs: Array<
    [string, string, string[], Partial<Pick<SampleMeta, "numFavorites" | "numUsages" | "bpm">>?]
  > = [
    ["kick-909", "Deep Kick 909", ["kick", "deep"], { bpm: 126, numFavorites: 42, numUsages: 187 }],
    ["hat-airy", "Airy Hat", ["hat", "bright"]],
    ["bass-sub", "Sub Bass", ["bass", "sub"], { bpm: 87, numFavorites: 7, numUsages: 33 }],
    ["lead-ohm", "Synth Lead", ["synth", "lead"], { bpm: 128, numFavorites: 126, numUsages: 240 }],
  ];
  return defs.map(([key, display, tags, metadata]) => ({
    meta: makeMeta(`samples/${key}`, display, tags, metadata),
    bytes: pcmWav(waveform(key.split("-")[0], sampleRate), sampleRate),
  }));
}

const SAMPLES = buildSamples();

// STEP23 — fixture helpers for the V2 similarity surface.
//
// The V1 pipeline never produces `analysisV2` (V1 FROZEN — no pipeline change).
// These helpers stamp a DETERMINISTIC V2 analysis computed by the REAL V2 DSP
// (`analyzeAudio`) over the SAME fixture waveform the pipeline decodes, so the
// e2e exercises the REAL `rankSimilar` code path with FIXTURE-class audio
// evidence (§16 — never "REAL audio evidence"). Product code never calls these;
// they are test-only harness controls, mirroring `publish`/`ep7`.

/** `samples/kick-909` → `kick` (the waveform profile key). */
function profileOf(sampleId: string): string {
  return sampleId.slice("samples/".length).split("-")[0];
}

/** Deterministic V2 analysis of a fixture waveform (FIXTURE-class evidence). */
function v2AnalysisFor(profile: string, sampleRate = 44100): SampleAnalysisV2 {
  const features = analyzeAudio({
    sampleRate,
    channels: [waveform(profile, sampleRate)],
  });
  const soundCharacter = computeSoundCharacter(features);
  return {
    analysisVersion: ANALYSIS_VERSION,
    features,
    soundCharacter,
    quality: computeSoundCharacterQuality(soundCharacter),
  };
}

let fetchCount = 0;

function browserDecode(audioCtx: AudioContext): AudioDecoder {
  return async (bytes: ArrayBuffer) => {
    const buffer = await audioCtx.decodeAudioData(bytes.slice(0));
    const mono = new Float32Array(buffer.length);
    const ch = buffer.getChannelData(0);
    mono.set(ch);
    return {
      sampleRate: buffer.sampleRate,
      channels: 1,
      mono,
      durationSeconds: buffer.duration,
    };
  };
}

function fetchFixtureAudio(_sample: SampleMeta): Promise<FetchedAudio> {
  const found = SAMPLES.find((s) => s.meta.name === _sample.name);
  const bytes = found ? found.bytes.slice(0) : SAMPLES[0].bytes.slice(0);
  fetchCount++;
  return Promise.resolve({ bytes, release: () => undefined });
}

/**
 * STEP16R E-P6 — scripted global publish provider for the e2e harness.
 *
 * A per-sample outcome map drives `publishAnalysisResults`. The OFFLINE
 * semantics are reproduced by configuring `temporary-unavailable` for every
 * sample (exactly what the real 16H `offlineProvider` returns; see
 * src/global/liveProvider.ts). Lookups return empty — the publish surface is
 * write-path only, this harness never exercises reuse.
 *
 * `queryMapViewport` DOES serve deterministic fixture map points, so the read
 * path (Global visibility and the local/global content-identity merge) becomes
 * browser-verifiable. `setMapPoints` is fed by the `global.mirrorRecord` test
 * hook, which copies the identity straight off a PERSISTED local record. The
 * merge therefore runs on the real production identity rule
 * (`contentIdentityKey`) instead of on a hand-written hash.
 */
class ScriptedPublishProvider implements GlobalSampleIndex {
  private readonly outBySample = new Map<string, GlobalPublishItemOutcome>();
  private mapPoints: GlobalMapPoint[] = [];

  /** Fixture global map points served by `queryMapViewport`. */
  setMapPoints(points: readonly GlobalMapPoint[]): void {
    this.mapPoints = [...points];
  }

  reset(): void {
    this.outBySample.clear();
  }

  set(sampleId: string, outcome: GlobalPublishItemOutcome): void {
    this.outBySample.set(sampleId, outcome);
  }

  /** Offline semantics: every publish is temporary-unavailable. */
  setAllOffline(): void {
    this.outBySample.clear();
    this.outBySample.set("*", {
      status: "rejected",
      reason: "temporary-unavailable",
    });
  }

  getOutcome(sampleId: string): GlobalPublishItemOutcome {
    const star = this.outBySample.get("*");
    return this.outBySample.get(sampleId) ?? star ?? { status: "stored" };
  }

  async lookupSamples() {
    return [];
  }

  async lookupContentIdentities() {
    return [];
  }

  async queryMapViewport() {
    return { mapVersion: "", points: this.mapPoints };
  }

  async publishAnalysisResults(batch: GlobalPublishBatch) {
    const items: GlobalPublishItemOutcome[] = batch.map((p) =>
      this.getOutcome(p.sampleId),
    );
    const accepted = items.every(
      (i) => i.status === "stored" || i.status === "already-known",
    );
    return { items, accepted };
  }
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("harness: #app missing");

  const log = (msg: string, kind: "ok" | "err" = "ok") => {
    const el = document.getElementById("harness-log");
    if (el) {
      const line = document.createElement("div");
      line.className = kind === "ok" ? "log-ok" : "log-err";
      line.textContent = msg;
      el.appendChild(line);
    }
  };

  try {
    smTiming.start("persistence:openDatabase");
    const stores = await openDatabase();
    smTiming.end("persistence:openDatabase");
    const index = new IndexStore(stores.db);
    const queue = new QueueStore(stores.db);
    const collectionStore = new IndexedDBCollectionStore(stores.db);
    const search = new SampleMapSearchEngine(index);
    const preview = new PreviewService();
    const classifier = new HeuristicClassifier();
    const audioCtx = new AudioContext();

    const doc = await createOfflineDocument();
    log("Nexus OfflineDocument ready (real WASM browser loader)");

    const pipeline = new AnalysisPipeline({
      fetchAudio: fetchFixtureAudio,
      decode: browserDecode(audioCtx),
      extract: extractFeatures,
      classifier,
      resolveSample: async (id: string) => SAMPLES.find((s) => s.meta.name === id)?.meta,
      index,
      analysisVersion: "features-v1",
    });

    const createRunner = (budget: AnalysisBudget) =>
      new JobRunner({ pipeline, queue, analysisBuild: BUILD, budget });

    const known = {
      getUpdatedAt: async (id: string) => {
        const rec = await index.get(id);
        return rec ? rec.analyzedAt : undefined;
      },
    };

const fetchPage: PageFetcher = async ({ pageSize, pageToken, filter }) => {
  const size = pageSize ?? 20;
  const start = Number(pageToken ?? "0");
  // STEP62 — apply owner-filter when supplied (e.g. from own-upload pass).
  let page: SampleMeta[];
  if (filter) {
    const match = filter.match(/sample\.owner_name\s*==\s*"([^"]+)"/);
    if (match) {
      const ownerName = match[1];
      page = SAMPLES.filter((s) => s.meta.ownerName === ownerName).map((s) => s.meta);
    } else {
      page = [];
    }
  } else {
    page = SAMPLES.slice(start, start + size).map((s) => s.meta);
  }
  const next =
    start + size < SAMPLES.length ? String(start + size) : undefined;
  return { samples: page, nextPageToken: next };
};

    const metaById = new Map(SAMPLES.map((s) => [s.meta.name, s.meta]));
    const previewUrlFor = (rec: { sampleId: string }): string | undefined =>
      metaById.get(rec.sampleId)?.previewMp3Url;

    const machiniste = new SampleMapMachinisteService(doc);
    // Eagerly materialize the offline Machiniste entity so the UI action-bar
    // "Add to Machiniste" path (app.sendToMachiniste via the panel id) can be
    // exercised e2e with a real id.
    const machinisteId = (await setupMachiniste(doc)).machinisteId;

    // STEP19A E-P7 — the one-time consent is backed by REAL localStorage, so an
    // e2e can verify the preference survives a full page reload. Shared across
    // `publish.remount` (same store reference). Default: granted, so the 64
    // legacy specs clicking Add/Send keep exercising the send; the E-P7 spec
    // resets the key to exercise the first-use dialog + acceptance flow.
    const consentStore = createStorageEp7ConsentStore(window.localStorage);
    consentStore.grant();

    // STEP16R E-P6 — an in-memory publish queue over the scripted provider.
    // Read-only for the UI, driven from the spec via `__sm.publish`.
    const publishProvider = new ScriptedPublishProvider();
    const publishQueue = new GlobalPublishQueue(publishProvider, {});
    let publishDelivery: PublishDeliveryMode = "offline";
    publishProvider.setAllOffline();

    const deps: SampleMapAppDeps = {
      queue,
      index,
      search,
      preview,
      machiniste,
      createRunner,
      fetchPage,
      known,
      previewUrlFor,
      analysisBuild: BUILD,
      scanMaxSamples: 200,
      resolveSample: async (id: string) => metaById.get(id),
      globalPublishQueue: publishQueue,
      globalPublishDelivery: publishDelivery,
      // READ path for the e2e harness only. The provider's `queryMapViewport`
      // serves fixture points injected via `global.mirrorRecord`; the publish
      // semantics above stay exactly as they were (offline/unavailable).
      globalIndex: publishProvider,
      ep7Consent: consentStore,
      collectionStore,
      // STEP38 — the fixture library is the authenticated user's OWN pool
      // (`users/alice`), so every scanned sample stays eligibility-eligible
      // (own one-shot tier 0) exactly like a real authenticated scan.
      authenticatedUserId: "users/alice",
    };

    smTiming.start("mountSampleMap");
    let app: ReturnType<typeof mountSampleMap> = mountSampleMap(root, deps);
    smTiming.end("mountSampleMap");
    log("mounted REAL SampleMap UI (mountSampleMap)");

    const readRecords = async () => {
      const out: Array<{
        sampleId: string;
        primaryClass: string;
        confidence: number;
        tags: string[];
        mapX: number;
        mapY: number;
        cx: number;
        cy: number;
        features: {
          tonalNoiseRatio: number;
          spectralCentroid: number;
          spectralFlatness: number;
          duration: number;
        };
      }> = [];
      for (const s of SAMPLES) {
        const rec = await index.get(s.meta.name);
        if (!rec || !rec.audioFeatures) continue;
        // STEP37 canonical: the map positions points by the CANONICAL Sound
        // Space coordinate when the record has a projectable V2 sound
        // character, with the persisted `mapPosition` as a legacy fallback.
        // This mirrors mapView.mapPoints exactly so the asserted cx/cy always
        // describe what the map actually rendered (16M-07).
        const canonical = rec.analysisV2?.soundCharacter
          ? computeCanonicalSoundSpacePoint(rec)
          : null;
        const p = canonical ?? (rec.mapPosition ?? null);
        if (!p) {
          throw new Error(
            `sample ${s.meta.name} has neither a projectable V2 sound character nor a persisted mapPosition`,
          );
        }
        out.push({
          sampleId: rec.sampleId,
          primaryClass: rec.primaryClass,
          confidence: rec.confidence,
          tags: rec.originalTags,
          mapX: p.x,
          mapY: p.y,
          cx: p.x * 800,
          cy: (1 - p.y) * 520,
        features: {
          tonalNoiseRatio: rec.audioFeatures.tonalNoiseRatio,
          spectralCentroid: rec.audioFeatures.spectralCentroid,
          spectralFlatness: rec.audioFeatures.spectralFlatness,
          duration: rec.audioFeatures.duration,
        },
        });
      }
      return out;
    };

    const sendToMachiniste = async (sampleId: string) => {
      const mach = await setupMachiniste(doc);
      return mach.send([toSampleName(sampleId)], mach.machinisteId, [0]);
    };

    interface PublishSpecOutcome {
      status: "stored" | "already-known" | "rejected";
      reason?: string;
    }

    interface PublishHooks {
      queue: typeof publishQueue;
      provider: ScriptedPublishProvider;
      /** Set the outcome the provider returns for one sample on the next flush. */
      setSampleOutcome: (sampleId: string, outcome: PublishSpecOutcome) => void;
      /** Offline semantics: every publish becomes temporary-unavailable/retryable. */
      setAllOffline: () => void;
      resetOutcomes: () => void;
      clear: () => void;
      /** Persist a pending acceptance marker + enqueue the publish (16H). */
      accept: (
        sampleId: string,
      ) => Promise<import("../../global/usageAcceptance").UsageAcceptanceOutcome>;
      /**
       * Flush the queue via the provider (optionally after forcing the given
       * per-sample outcome) and reflect delivery on the local markers. Returns
       * the combined flush/markedPublished result, then re-renders the UI.
       */
      flush: (
        outcome?: Record<string, PublishSpecOutcome>,
      ) => Promise<{ submitted: number; succeeded: number; retryable: number; rejected: number; markedPublished: number }>;
      /**
       * Re-mount the UI with a different delivery mode (the label is a
       * bootstrap-time fact). Records persist in IndexedDB; `refreshSearch`
       * repopulates the map without re-analyzing.
       */
      remount: (mode: PublishDeliveryMode) => Promise<ReturnType<typeof mountSampleMap>>;
      /** Re-read the index (syncs the focused record) and re-render, awaited. */
      refresh: () => Promise<void>;
    }

    interface Tm {
      app: ReturnType<typeof mountSampleMap>;
      /** Apps disposed by `publish.remount` (BUG #4 / STEP16W: their global
       *  keydown handler must be gone after dispose — specs assert on these
       *  instances so a zombie listener cannot mutate apps that were torn down). */
      disposedApps: Array<ReturnType<typeof mountSampleMap>>;
      index: typeof index;
      queue: typeof queue;
      search: typeof search;
      deps: typeof deps;
      doc: typeof doc;
      meta: Record<string, SampleMeta>;
      fetchCount: number;
      machinisteId: string;
      scan: () => Promise<void>;
      analyze: (budget?: AnalysisBudget) => Promise<void>;
      /**
       * The AUTOMATIC background indexing entry point — the exact call the
       * production mount (`mountAuthenticated`) makes after its initial
       * `refreshSearch()`. Exposed so the e2e suite can observe the normal
       * "open the app and it indexes itself" path WITHOUT clicking Start Scan.
       * Not wired into the harness mount itself: the other suites drive the
       * manual scan/analyze flow and assert on the idle state.
       */
      autoIndex: () => Promise<void>;
      readRecords: typeof readRecords;
      sendToMachiniste: typeof sendToMachiniste;
      selectSample: (sampleId: string) => void;
      wavBytesFor: (sampleId: string) => ArrayBuffer;
      publish: PublishHooks;
      /**
       * STEP19A E-P7 — test controls for the one-time consent gate. The store is
       * localStorage-backed, so `reset()` + subsequent UI interactions exercise
       * the first-use dialog and `isGranted()` reflects the persisted key even
       * after a full page reload.
       */
      ep7: {
        isGranted: () => boolean;
        /** Write the granted preference (programmatic consent). */
        grant: () => void;
        /** Remove the preference (back to first-use state). */
        reset: () => void;
      };
      /**
       * Global MAP read-path controls (test-only).
       *
       * `mirrorRecord(sampleId)` publishes a global point that carries the
       * PERSISTED local record's own `contentHash`/`contentHashVersion` and
       * `mapPosition`. That makes the sample simultaneously `isGlobal` and
       * `isMine`, so the real merge path (`mergeMapPoints`, keyed by
       * `contentIdentityKey`) and the real renderer can be checked in a real
       * browser for exactly-one-circle behaviour. No product code is involved
       * and no hash is invented here — the identity is read back from the index.
       */
      global: {
        mirrorRecord: (sampleId: string) => Promise<GlobalMapPoint>;
        /**
         * Serve `count` SYNTHETIC global map points and refresh.
         *
         * The LOD/clustering PoC needs a map far denser than the 4 fixture
         * records. `mirrorRecord` can only ever serve persisted records, so
         * this hook manufactures points on a deterministic lattice-plus-jitter
         * (no `Math.random`, so every run is byte-identical) with unique
         * content identities. They arrive through the normal
         * `queryMapViewport` -> `globalMapPoints()` path, so the clustering
         * layer sees exactly what production sees.
         */
        serveMany: (count: number) => Promise<GlobalMapPoint[]>;
        /**
         * Serve `count` SYNTHETIC global map points with a REALISTIC spatial
         * mix and refresh. Returns the served points.
         *
         * `serveMany` is a uniform lattice, which is the worst case for
         * clustering (every cell fills at the same rate). This hook serves the
         * distribution a real library actually has, so a stress run measures
         * something meaningful:
         *
         *   ~45%  normal-distributed cloud over the whole map (Box-Muller)
         *   ~20%  tight dense hotspots (sigma 0.02-0.05)
         *   ~15%  sparse points spread over the full area
         *   ~12%  near-coincident groups (2-4 points within ~1e-3)
         *    ~8%  a wandering diagonal band (structure, NOT a straight line)
         *
         * Deterministic: seeded mulberry32, no `Math.random`, no `Date`. The
         * same (count, seed) always yields byte-identical points.
         *
         * `order` only permutes the SERVED order (same point set) so the
         * clustering layer's order-independence can be verified in a real
         * browser.
         */
        serveRealistic: (
          count: number,
          opts?: { seed?: number; order?: "natural" | "reversed" | "shuffled" },
        ) => Promise<GlobalMapPoint[]>;
        /**
         * Serve `count` synthetic global map points that are FULLY COINCIDENT
         * (identical x/y) and refresh. This is the exact probe for
         * CLUSTER_MIN_POINTS: a cell can hold at most one cluster, so
         * `clusters === 0` below the threshold and `clusters === 1` from the
         * threshold upwards. Returns the served points.
         */
        serveCoincident: (count: number) => Promise<GlobalMapPoint[]>;
        clear: () => Promise<void>;
        current: () => GlobalMapPoint[];
      };
      /**
       * READ-ONLY inspection of the PRODUCT clustering function (test-only).
       *
       * Re-runs the exact renderer pipeline for the app's current state
       * (`visibleMapRecords` + visible global points -> merge -> cluster) and
       * returns the entries, so a stress run can compare the real DOM against
       * the product result and read the per-cluster MEMBER assignment (which
       * the DOM deliberately does not expose, because a cluster carries no
       * sample identity).
       *
       * It changes nothing: no state is written, nothing is re-rendered.
       */
      cluster: {
        inspect: (zoom: number) => {
          merged: number;
          entries: Array<{
            kind: "point" | "cluster";
            cell: string | null;
            count: number;
            x: number;
            y: number;
            members: string[];
          }>;
          coverage: number;
        };
      };
      /**
       * STEP23 — V2 similarity surface controls (test-only; product code never
       * auto-runs V2 analysis, §47). `keys` are waveform profiles ("kick",
       * "hat", "bass", "lead"); `attach`/`detach` default to ALL fixtures.
       */
      v2: {
        attach: (keys?: string[]) => Promise<string[]>;
        detach: (keys?: string[]) => Promise<string[]>;
        /** The REAL `rankSimilar` top-10 for a query sampleId (deterministic). */
        rank: (querySampleId: string) => Promise<string[]>;
      };
    }

    const waitForSettle = async (
      get: () => string,
      timeoutMs = 60000,
    ): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (get() !== "running") return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("harness: settle timeout");
    };

    const disposedApps: Array<ReturnType<typeof mountSampleMap>> = [];

    const tm: Tm = {
      app,
      disposedApps,
      index,
      queue,
      search,
      deps,
      doc,
      meta: Object.fromEntries(SAMPLES.map((s) => [s.meta.name, s.meta])),
      get fetchCount() {
        return fetchCount;
      },
      machinisteId,
      scan: async () => {
        if (app.scan.status !== "scanning") await app.startScan();
      },
      analyze: async (budget: AnalysisBudget = 10) => {
        if (app.analysis.status !== "running") {
          app.analyze(budget);
          await waitForSettle(() => app.analysis.status);
        }
      },
      autoIndex: async () => {
        // Fire-and-forget, exactly like the mount: do NOT wait for the scan or
        // the run, so the e2e sees the non-blocking behaviour too.
        void app.startBackgroundIndexing();
      },
      readRecords,
      sendToMachiniste,
      selectSample: (sampleId: string) => {
        void index
          .get(sampleId)
          .then((rec) => {
            if (rec) app.selectSample(rec);
          });
      },
      wavBytesFor: (sampleId: string) => {
        const found = SAMPLES.find((s) => s.meta.name === sampleId);
        return found ? found.bytes.slice(0) : new ArrayBuffer(0);
      },
      publish: {
        queue: publishQueue,
        provider: publishProvider,
        setSampleOutcome: (sampleId: string, outcome: PublishSpecOutcome) =>
          publishProvider.set(
            sampleId,
            outcome.reason !== undefined
              ? { status: "rejected", reason: outcome.reason }
              : { status: outcome.status as "stored" | "already-known" },
          ),
setAllOffline: () => publishProvider.setAllOffline(),
      resetOutcomes: () => publishProvider.reset(),
      /** Clear the queue (in-memory reset between scenarios). */
      clear: () => publishQueue.clear(),
        accept: async (sampleId: string) => {
          const sample = metaById.get(sampleId);
          if (!sample) throw new Error(`accept: unknown sample ${sampleId}`);
          const evidence: TransferEvidence = {
            kind: "poc",
            result: {
              sample,
              sampleEntityId: "harness-sentinel-e",
              machinisteId: "harness-sentinel-m",
              channelSampleEntityId: "harness-sentinel-c",
              directReferenceApplied: true,
              readBackMatches: true,
              created: true,
              errors: [],
            },
          };
          return acceptUsageAndEnqueue(
            { index, queue: publishQueue },
            evidence,
          );
        },
        flush: async (outcome?: Record<string, PublishSpecOutcome>) => {
          if (outcome) {
            publishProvider.reset();
            for (const [sampleId, o] of Object.entries(outcome)) {
              publishProvider.set(
                sampleId,
                o.reason !== undefined
                  ? { status: "rejected", reason: o.reason }
                  : { status: o.status as "stored" | "already-known" },
              );
            }
          }
          const res = await flushPendingPublications({
            index,
            queue: publishQueue,
          });
          smTiming.start("refreshSearch");
          await app.refreshSearch();
          smTiming.end("refreshSearch");
          return {
            submitted: res.flush.submitted,
            succeeded: res.flush.succeeded,
            rejected: res.flush.rejected,
            retryable: res.flush.retryable,
            markedPublished: res.markedPublished,
          };
        },
        remount: async (mode: PublishDeliveryMode) => {
          publishDelivery = mode;
          if (mode === "offline") publishProvider.setAllOffline();
          disposedApps.push(app);
          disposeSampleMap(app);
          app = mountSampleMap(root, { ...deps, globalPublishDelivery: mode });
          await app.refreshSearch();
          tm.app = app;
          return app;
        },
        refresh: async () => app.refreshSearch(),
      },
      ep7: {
        isGranted: () => consentStore.isGranted(),
        grant: () => {
          consentStore.grant();
          app.refreshSearch();
        },
        reset: () => consentStore.clear(),
      },
      global: {
        /**
         * Make the given already-analyzed fixture sample appear in the global
         * set as well, then refresh the app's global points. Returns the
         * global point that was served.
         */
        mirrorRecord: async (sampleId: string): Promise<GlobalMapPoint> => {
          const rec = await index.get(sampleId);
          if (!rec) throw new Error(`global.mirrorRecord: no record ${sampleId}`);
          if (!rec.contentHash) {
            throw new Error(`global.mirrorRecord: ${sampleId} has no contentHash`);
          }
          const mp = rec.mapPosition;
          if (!mp) {
            throw new Error(`global.mirrorRecord: ${sampleId} has no mapPosition`);
          }
          const point: GlobalMapPoint = {
            contentIdentity: {
              contentHash: rec.contentHash,
              contentHashVersion: rec.contentHashVersion ?? "unknown",
            },
            x: mp.x,
            y: mp.y,
            representativeSampleId: rec.sampleId,
            primaryClass: rec.primaryClass,
          };
          publishProvider.setMapPoints([point]);
          await app.refreshGlobalPoints();
          return point;
        },
        /**
         * Serve `count` synthetic global map points (see the type doc) and
         * refresh the app. Returns the served points.
         */
        serveMany: async (count: number): Promise<GlobalMapPoint[]> => {
          const points: GlobalMapPoint[] = [];
          // Deterministic lattice + jitter: dense enough that the zoomed-out
          // map MUST cluster, spread enough that it also resolves on zoom-in.
          const side = Math.max(1, Math.ceil(Math.sqrt(count)));
          for (let i = 0; i < count; i++) {
            const col = i % side;
            const row = Math.floor(i / side);
            const jx = ((i * 2654435761) % 1000) / 1000;
            const jy = ((i * 40503) % 1000) / 1000;
            const x = (col + 0.15 + 0.7 * jx) / side;
            const y = (row + 0.15 + 0.7 * jy) / side;
            points.push({
              contentIdentity: {
                contentHash: `synthetic-${String(i).padStart(4, "0")}`,
                contentHashVersion: "pcm-v1",
              },
              x: Math.min(1, Math.max(0, x)),
              y: Math.min(1, Math.max(0, y)),
              representativeSampleId: `samples/synthetic-${String(i).padStart(4, "0")}`,
              primaryClass: "kick",
            });
          }
          publishProvider.setMapPoints(points);
          await app.refreshGlobalPoints();
          return points;
        },
        serveCoincident: async (count: number): Promise<GlobalMapPoint[]> => {
          const points: GlobalMapPoint[] = [];
          for (let i = 0; i < count; i++) {
            points.push({
              contentIdentity: {
                contentHash: `coincident-${String(i).padStart(4, "0")}`,
                contentHashVersion: "pcm-v1",
              },
              x: 0.5,
              y: 0.5,
              representativeSampleId: `samples/coincident-${String(i).padStart(4, "0")}`,
              primaryClass: "kick",
            });
          }
          publishProvider.setMapPoints(points);
          await app.refreshGlobalPoints();
          return points;
        },
        /**
         * Serve `count` synthetic global map points with a realistic spatial
         * mix (see the type doc) and refresh. Returns the served points.
         */
        serveRealistic: async (
          count: number,
          opts?: { seed?: number; order?: "natural" | "reversed" | "shuffled" },
        ): Promise<GlobalMapPoint[]> => {
          const seed = opts?.seed ?? 20260927;
          const rnd = mulberry32(seed);
          const gauss = () => {
            // Box-Muller; u1 clamped away from 0 so log() stays finite.
            const u1 = Math.max(rnd(), 1e-12);
            const u2 = rnd();
            return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          };
          const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
          const uniform = () => rnd();

          // Dense hotspot centres, drawn once so the whole set is coherent.
          const hotspots = [
            { x: 0.28, y: 0.66, s: 0.05 },
            { x: 0.63, y: 0.31, s: 0.03 },
            { x: 0.82, y: 0.78, s: 0.02 },
          ];

          const raw: Array<{ x: number; y: number }> = [];
          const nCloud = Math.round(count * 0.45);
          const nHot = Math.round(count * 0.2);
          const nSparse = Math.round(count * 0.15);
          const nNear = Math.round(count * 0.12);
          const nBand = count - nCloud - nHot - nSparse - nNear;

          // 1. normal cloud over the whole map
          for (let i = 0; i < nCloud; i++) {
            raw.push({
              x: clamp01(0.5 + gauss() * 0.19),
              y: clamp01(0.5 + gauss() * 0.19),
            });
          }
          // 2. dense hotspots
          for (let i = 0; i < nHot; i++) {
            const h = hotspots[i % hotspots.length];
            raw.push({
              x: clamp01(h.x + gauss() * h.s),
              y: clamp01(h.y + gauss() * h.s),
            });
          }
          // 3. sparse, spread over the whole area
          for (let i = 0; i < nSparse; i++) {
            raw.push({ x: uniform(), y: uniform() });
          }
          // 4. near-coincident groups: 2-4 points ~1e-4..1e-3 apart.
          // A group emits SEVERAL points, so the BUDGET (not the group count)
          // terminates this section; the total stays exactly `count`.
          let nearEmitted = 0;
          while (nearEmitted < nNear) {
            const ax = uniform();
            const ay = uniform();
            const group = 2 + Math.floor(rnd() * 3);
            for (let g = 0; g < group && nearEmitted < nNear; g++) {
              raw.push({
                x: clamp01(ax + gauss() * 3e-4),
                y: clamp01(ay + gauss() * 3e-4),
              });
              nearEmitted++;
            }
          }
          // 5. a wandering diagonal band: structure without being a line
          for (let i = 0; i < nBand; i++) {
            const t = i / Math.max(1, nBand);
            const base = 0.08 + 0.84 * t;
            const wobble = 0.05 * Math.sin(t * Math.PI * 2.5) + gauss() * 0.012;
            raw.push({
              x: clamp01(base + gauss() * 0.015),
              y: clamp01(t + wobble),
            });
          }

          // Identity is bound to the GENERATION index, so a point's id and its
          // coordinates always travel together.
          const points: GlobalMapPoint[] = raw.map((p, i) => ({
            contentIdentity: {
              contentHash: `realistic-${String(i).padStart(5, "0")}`,
              contentHashVersion: "pcm-v1",
            },
            x: p.x,
            y: p.y,
            representativeSampleId: `samples/realistic-${String(i).padStart(5, "0")}`,
            primaryClass: "kick",
          }));

          // `order` permutes the SERVED ORDER only. The point set — every id,
          // every coordinate — is byte-identical for all four variants, which
          // is what makes this a real order-independence probe.
          if (opts?.order === "reversed") {
            points.reverse();
          } else if (opts?.order === "shuffled") {
            // Deterministic Fisher-Yates on a separate seed stream.
            const sh = mulberry32(seed ^ 0x5bf03635);
            for (let i = points.length - 1; i > 0; i--) {
              const j = Math.floor(sh() * (i + 1));
              const tmp = points[i];
              points[i] = points[j];
              points[j] = tmp;
            }
          }

          publishProvider.setMapPoints(points);
          await app.refreshGlobalPoints();
          return points;
        },
        /** Drop all fixture global points and refresh. */
        clear: async (): Promise<void> => {
          publishProvider.setMapPoints([]);
          await app.refreshGlobalPoints();
        },
        /** The global points the app currently holds. */
        current: (): GlobalMapPoint[] => app.globalPoints,
      },
      cluster: {
        inspect: (zoom: number) => {
          // Mirrors render.ts -> renderSampleMap() exactly.
          const local = mapPoints(app.visibleMapRecords);
          // render.ts passes the visible globals; the renderer converts them
          // with globalMapPoints() before merging. Same order, same functions.
          const globals = globalMapPoints(
            visibleGlobalPoints(app.globalPoints, app.visibility),
          );
          const merged = mergeMapPoints(local, globals);
          const entries: MapEntry[] = clusterMapPoints(merged, zoom);
          return {
            merged: merged.length,
            entries: entries.map((e) =>
              e.kind === "point"
                ? {
                    kind: "point" as const,
                    cell: null,
                    count: 1,
                    x: e.point.x,
                    y: e.point.y,
                    members: [e.point.sampleId],
                  }
                : {
                    kind: "cluster" as const,
                    cell: e.cell,
                    count: e.count,
                    x: e.x,
                    y: e.y,
                    members: e.points.map((p) => p.sampleId),
                  },
            ),
            coverage: entryCoverage(entries),
          };
        },
      },
      v2: {
        attach: async (keys?: string[]): Promise<string[]> => {
          const requested = keys ? new Set(keys) : null;
          const stamped: string[] = [];
          for (const s of SAMPLES) {
            const id = s.meta.name;
            const profile = profileOf(id);
            if (requested && !requested.has(profile)) continue;
            const rec = await index.get(id);
            if (!rec || rec.status !== "analyzed") continue;
            await index.put({ ...rec, analysisV2: v2AnalysisFor(profile) });
            stamped.push(id);
          }
          await app.refreshSearch();
          return stamped;
        },
        detach: async (keys?: string[]): Promise<string[]> => {
          const requested = keys ? new Set(keys) : null;
          const detached: string[] = [];
          for (const s of SAMPLES) {
            const id = s.meta.name;
            const profile = profileOf(id);
            if (requested && !requested.has(profile)) continue;
            const rec = await index.get(id);
            if (!rec || !rec.analysisV2) continue;
            const { analysisV2: _drop, ...rest } = rec;
            await index.put(rest);
            detached.push(id);
          }
          await app.refreshSearch();
          return detached;
        },
        rank: async (querySampleId: string): Promise<string[]> => {
          const records = await index.getAll();
          const query = records.find((r) => r.sampleId === querySampleId);
          if (!query) return [];
          return rankSimilar(query, records, {
            limit: RANKING_DEFAULT_LIMIT,
            includeSelf: false,
          }).map((r) => r.sampleId);
        },
      },
    };

    (window as unknown as { __sm: Tm }).__sm = tm;
    log("test hooks exposed at window.__sm");
  } catch (err) {
    log(`harness init failed: ${(err as Error).stack ?? String(err)}`, "err");
  }
}

let machCache: { doc: Awaited<ReturnType<typeof createOfflineDocument>>; machinisteId: string } | undefined;

async function setupMachiniste(doc: Awaited<ReturnType<typeof createOfflineDocument>>) {
  if (!machCache) {
    let machinisteId = "";
    await doc.modify((t) => {
      machinisteId = t.create("machiniste", {}).id;
    });
    machCache = { doc, machinisteId };
  }
  return {
    machinisteId: machCache.machinisteId,
    send: (slots: string[], id: string, positions: number[]) => {
      const s = new SampleMapMachinisteService(doc);
      return s.send(slots, id, positions);
    },
  };
}

main().catch((e) => {
  const el = document.getElementById("harness-log");
  if (el) {
    const d = document.createElement("div");
    d.className = "log-err";
    d.textContent = `harness fatal: ${String(e)}`;
    el.appendChild(d);
  }
});
