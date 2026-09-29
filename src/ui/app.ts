import type { SampleIndexRecord, ClassId, IndexStore } from "../persistence/indexStore";
import type { QueueStore } from "../persistence/queueStore";
import type { SampleMapSearchEngine, SearchQuery, SearchResult, SearchSort, SearchSortDir } from "../search/searchEngine";
import type { PreviewService, PreviewHandle } from "../preview/previewService";
import { SampleMapMachinisteService, MAX_BATCH_SLOTS } from "../machiniste/machinisteService";
import type { MachinisteSendResult } from "../machiniste/machinisteService";
import type {
  JobRunner,
  AnalysisBudget,
  RunProgress,
  RunStopReason,
  JobDoneHook,
} from "../pipeline/jobRunner";
import { scanLibrary } from "../library/libraryScanner";
import type { PageFetcher, KnownProvider } from "../library/libraryScanner";
import type { SampleMeta } from "@audiotool/nexus/api";
import type { GlobalSampleIndex, GlobalAnalysisResult } from "../global/contract";
import type { GlobalMapPoint } from "../global/contract";
import { mapVersion } from "../map/mapPosition";
import { mineSampleIds, resolveMapVisibility } from "./map/visibility";
import type { MapVisibility, SampleMembership, VisibilityToggles } from "./map/visibility";
import { findSimilar } from "../similarity/similaritySearch";
import type { SimilarSampleResult } from "../similarity/similaritySearch";
import {
  RANKING_DEFAULT_LIMIT,
  rankSimilar,
  resolveQueryCharacter,
} from "../analysis/similarityRanking";
import type { SimilarityResult } from "../analysis/similarityRanking";
import {
  discoverSamples,
  type DiscoveryReason,
  type DiscoveryQuery,
} from "../analysis/discovery";
import type { SoundSpaceCharFilter } from "../analysis/soundSpaceFilter";
import { isFilterActive } from "../analysis/soundSpaceFilter";
import {
  addToCollection,
  removeFromCollection,
  toggleCollectionSample,
  clearCollection,
  emptyCollectionState,
  summarizeCollection,
  collectionContains,
  isCollectionFull,
  type SoundCollectionState,
  type SoundCharacterSummary,
} from "../analysis/collection";
import {
  DEFAULT_COLLECTION_NAME,
  normalizeCollectionName,
  createPersistedCollection,
  withUpdatedCollection,
  type PersistedSoundCollection,
  type InvalidPersistedCollection,
} from "../analysis/collectionPersistence";
import type { CollectionStore } from "../persistence/collectionStore";
import type { SoundCharacter } from "../analysis/soundCharacter";
import {
  createSoundSpaceProjector,
  projectAll,
} from "../analysis/soundSpaceProjector";
import type { SoundSpacePoint } from "../analysis/soundSpaceProjector";
import { buildRecordFromGlobalAnalysis } from "../global/hydrate";
import {
  computeEligibilityFromMeta,
  priorityGroupOfMeta,
} from "../analysis/eligibility";
import type { GlobalPublishQueue } from "../global/publishQueue";
import {
  acceptUsageAndEnqueue,
  flushPendingPublications,
  isSendSlotAccepted,
} from "../global/usageAcceptance";
import { populatePublishQueue } from "../global/population";
import { discoverPublicSamples } from "../library/publicDiscovery";
import type { ElasticDB } from "../persistence/elasticdb";
import type { PublishDeliveryMode } from "./view";
import {
  createMemoryEp7ConsentStore,
  type Ep7ConsentStore,
} from "./ep7Consent";
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  MapCamera,
  MapPoint,
  NormalizedBBox,
  ScreenPosition,
  cameraToViewportBBox,
  clampPan,
  clampZoom,
  defaultMapCamera,
  zoomBy,
} from "./map/mapView";

/**
 * SampleMapApp — the V1 UI controller (SAMPLEMAP_V1_SPEC §13 / §20.11).
 *
 * The controller is PURE ORCHESTRATION: it delegates to the existing services
 * (LibraryScanner, JobRunner, SearchEngine, PreviewService, MachinisteService)
 * and holds display state. It contains no business logic of its own and no
 * direct Nexus calls. It is DOM-free so it is fully testable in Node; the DOM
 * renderer (`./render.ts`) is a thin projection of its state + view-models.
 *
 * Invariants enforced here (see §13 / §INV-*):
 *  - INV-1 no audio bytes persisted: the controller only ever enqueues sample
 *    ID strings into the queue and passes source URLs to PreviewService; it
 *    never writes Blob/ArrayBuffer/typed arrays anywhere.
 *  - INV-2 tags ≠ classification: the controller never treats originalTags as a
 *    class; classification flows only from SearchEngine/Index records.
 *  - INV-3 no uncontrolled full-library analysis: only 10/100/1000 budgets.
 *  - INV-4 SearchEngine read-only: the controller only calls `search()`.
 *  - INV-5 MachinisteService is the only machiniste integration.
 *  - INV-6 PreviewService owns the audio ObjectURL lifecycle.
 */

export type ScanStatus = "idle" | "scanning" | "done" | "error";
export type RunStatus = "idle" | "running" | "paused" | "stopped";

export interface ScanState {
  status: ScanStatus;
  foundCount: number;
  pageCount: number;
  error: string | undefined;
  /**
   * STEP38 — samples auto-enqueued for analysis after the eligibility gate.
   * Own samples + foreign samples with favorites/usage ≥ 1.
   */
  eligibleEnqueued: number;
  /** STEP38 — discovered samples EXCLUDED from auto-analysis (ineligible). */
  ineligibleSkipped: number;
  /** STEP62 — own samples discovered in this scan. */
  ownDiscovered: number;
  /** STEP62 — own samples enqueued in this scan. */
  ownEnqueued: number;
}

export interface AnalysisState {
  budget: AnalysisBudget | undefined;
  status: RunStatus;
  analyzed: number;
  failed: number;
  skipped: number;
  gone: number;
  stoppedReason: RunStopReason | undefined;
  error: string | undefined;
}

export interface SearchState {
  text: string;
  classes: ClassId[];
  minConfidence: number | undefined;
  sortBy: SearchSort;
  sortDir: SearchSortDir;
}

export interface MachinisteState {
  lastResult: MachinisteSendResult | undefined;
  error: string | undefined;
  /** Ids currently mapped to slots in the pending send. */
  pendingSamples: string[];
}

/**
 * Step 16L: a loaded global inspection.
 *
 * The global map points carry only content identity + position + primary class.
 * To inspect a global-only sample WITHOUT running the analysis pipeline, the
 * app fetches the full canonical `GlobalAnalysisResult` via the existing
 * `GlobalLookup` content-identity path. This state holds that result plus the
 * originating point so the Inspector can render it directly.
 */
export interface GlobalInspection {
  /** The originating global map point (coordinates + representative id). */
  point: MapPoint;
  /** The canonical global analysis for the point's content identity. */
  analysis: GlobalAnalysisResult;
  /** The representative sampleId from the global point. */
  sampleId: string;
  /** True when the sample metadata resolved from Audiotool (richer inspection). */
  resolved: boolean;
  /** Inspection-specific error, if the lookup failed (UNAVAILABLE/UNKNOWN). */
  error: string | undefined;
}

// ---------------------------------------------------------------------------
// STEP23 — V2 similarity product surface.
//
// The V2 "Find Similar" workflow is a SNAPSHOT surface (§29/§30): invoking it
// ranks the CURRENTLY FOCUSED sample's `analysisV2.soundCharacter` against the
// whole local index via the frozen STEP22 `rankSimilar` service and holds the
// result. The snapshot stays tied to its QUERY sample until Find Similar is
// invoked again — changing focus afterwards NEVER re-ranks the open surface
// (stale-query policy). Ranking is pure metadata (§31): it reads persisted
// `analysisV2` only, never audio/DSP/preview bytes.
// ---------------------------------------------------------------------------

export type SimilarityStateStatus = "idle" | "ready" | "empty" | "error";

/** One ranked neighbour row (snapshot, ordered exactly as `rankSimilar`). */
export interface SimilarityV2Row {
  /** The candidate `sampleId` (unique in the result list). */
  sampleId: string;
  /** The snapshot record backing the row (resolved from the same index read). */
  record: SampleIndexRecord;
  /** Weighted-Euclidean similarity in [0,1] (never null — null is excluded). */
  similarity: number;
  /** Number of shared sound-character dims that produced the score. */
  sharedDimensionCount: number;
}

/**
 * STEP23 — the V2 similarity surface state.
 *
 * Semantics (unit/integration-tested):
 *  - `open` — the surface is visible.
 *  - `status` — `idle` (not computed yet), `ready` (snapshot succeeded; the
 *    `results` list is authoritative and may legitimately be empty), `empty`
 *    (nothing to rank — e.g. the focused sample has no V2 analysis, which is
 *    NEVER auto-analyzed, §47), `error` (index unavailable / exception).
 *  - `querySampleId` / `queryName` — the snapshot's QUERY, fixed at invoke
 *    time. The surface stays tied to it even if focus changes afterwards.
 *  - `queryLimited` — DATA-BACKED `Limited analysis` note (§10): true only
 *    when the query's `quality.featureCoverage < 1` at snapshot time.
 *  - `results` — computed ONCE at invoke time from `rankSimilar`; never
 *    recomputed while open.
 */
export interface SimilarityState {
  open: boolean;
  status: SimilarityStateStatus;
  querySampleId: string | undefined;
  queryName: string | undefined;
  queryLimited: boolean;
  results: SimilarityV2Row[];
  error: string | undefined;
}

/** The safe initial V2 similarity surface (closed, nothing computed). */
export function emptySimilarityState(): SimilarityState {
  return {
    open: false,
    status: "idle",
    querySampleId: undefined,
    queryName: undefined,
    queryLimited: false,
    results: [],
    error: undefined,
  };
}

/**
 * STEP24 — the V2 Sound Space snapshot state.
 *
 * Semantics (unit/integration-tested):
 *  - `open` — the surface is visible.
 *  - `status` — `idle`, `ready` (points present or empty library snapshot),
 *    `empty` (no V2-analyzed samples at all), `error` (index unavailable).
 *  - `points` — the projectable-record snapshot taken at open time. Focus
 *    changes while open NEVER recompute coordinates (§§38, 45, 46).
 *  - `recordsById` — the same snapshot's records keyed by sampleId; used by
 *    the STEP25 filter layer (POINTS stay immutable; FILTER picks a subset).
 */
export interface SoundSpaceState {
  open: boolean;
  status: "idle" | "ready" | "empty" | "error";
  points: SoundSpacePoint[];
  recordsById: ReadonlyMap<string, SampleIndexRecord>;
  error: string | undefined;
}

/** The safe initial Sound Space surface (closed, no points). */
export function emptySoundSpaceState(): SoundSpaceState {
  return {
    open: false,
    status: "idle",
    points: [],
    recordsById: new Map(),
    error: undefined,
  };
}

/** STEP25 — the Sound Space Compare surface (derived, session-local). */
export interface SoundSpaceCompareState {
  open: boolean;
  sampleIds: string[];
}

/**
 * STEP26 — the V2 Discovery surface status.
 *
 * `idle` (not submitted yet — "Find a sound"), `running` ("Finding sounds…"),
 * `ready` (snapshot succeeded; `results` authoritative, may be empty),
 * `empty` (a data-backed empty state with `error` carrying the exact copy:
 * "Select a sample to use as a reference." or "No matching sounds found."),
 * `error` (index unavailable / exception).
 */
export type DiscoveryStatus = "idle" | "running" | "ready" | "empty" | "error";

/**
 * STEP26 — one discovery row: the candidate record + the arithmetic that
 * explains it (sources + combined score). A SNAPSHOT tied to the last run.
 */
export interface DiscoveryRowView {
  sampleId: string;
  /** The snapshot record backing the row (resolved from the same index read). */
  record: SampleIndexRecord;
  /** Combined score in [0, 1] (bounded, versioned combination of active sources). */
  score: number;
  /** Always DISCOVERY_MATCH_LABEL ("Match") — never "AI Score"/"Confidence". */
  label: string;
  /** Active-source reasons in canonical order (text, character, similar). */
  reasons: DiscoveryReason[];
  /** Present when the text source was active: the SearchEngine's score. */
  searchScore?: number;
  /** Present when the reference source was active: the rankSimilar score. */
  similarity?: number;
  /** 1 - similarity (reference source active). */
  distance?: number;
  /** Shared-dimension count (reference source active). */
  sharedDimensionCount?: number;
}

/**
 * STEP26 — the V2 Discovery surface state.
 *
 * Session-local ONLY (never persisted, never in the URL): the surface is a
 * composition of the app's existing read-only sources. `referenceSampleId` is
 * the reference sample's id and is stable until explicitly cleared ("Clear
 * reference" sets ONLY this field — focus/selection are untouched). `results`
 * is the snapshot of the last run; reopening re-runs the retained criteria.
 */
export interface DiscoveryState {
  open: boolean;
  status: DiscoveryStatus;
  referenceSampleId: string | undefined;
  results: DiscoveryRowView[];
  error: string | undefined;
}

/** The safe initial Discovery surface (closed, nothing computed). */
export function emptyDiscoveryState(): DiscoveryState {
  return {
    open: false,
    status: "idle",
    referenceSampleId: undefined,
    results: [],
    error: undefined,
  };
}

/**
 * STEP27 — one member row of the Collection panel. Availability is decided
 * against the CURRENT index snapshot (`collectionKnownIds`): a member whose
 * record no longer exists in the index stays in the collection but renders the
 * honest "Unavailable sample" row (never dropped, never crashing — §27).
 */
export interface CollectionMemberView {
  sampleId: string;
  /** The registry record when the member is present in the index (else undefined). */
  record: SampleIndexRecord | undefined;
  /** True when the id still exists in the CURRENT index snapshot. */
  available: boolean;
}

/**
 * STEP28 — one row of the Collection manager. `invalid` is present when the
 * persisted record failed validation: the row is surfaced honestly (never
 * silently dropped); an "unsupported-version" row is additionally never
 * deletable (§21).
 */
export interface CollectionListEntry {
  id: string;
  name: string;
  active: boolean;
  invalid: InvalidPersistedCollection | undefined;
}

/** STEP28 — Collection manager panel state (lifecycle + surfacing, §40–§42). */
export interface CollectionManagerState {
  open: boolean;
  listStatus: "idle" | "loading" | "loaded" | "error";
  entries: CollectionListEntry[];
  listError: string | undefined;
  loadError: string | undefined;
  deleteError: string | undefined;
  /** Draft text of the working collection name input (commit on blur/Enter). */
  nameDraft: string;
  /** Active confirmation dialog: unsaved-switch or explicit delete. */
  confirm:
    | { kind: "switch"; targetId: string; targetName: string }
    | { kind: "delete"; id: string; name: string }
    | undefined;
}

export interface SampleMapAppDeps {
  /** Queue used to enqueue scanned sampleIds (persisted metadata only). */
  queue: QueueStore;
  /** Step 16L: the local index (for hydration + similarity over local records). */
  index?: IndexStore;
  /** Read-only search over the index. */
  search: SampleMapSearchEngine;
  /** Audio-preview ObjectURL owner. */
  preview: PreviewService;
  /** The only machiniste integration. */
  machiniste: SampleMapMachinisteService;
  /**
   * Build a fresh JobRunner with the given controlled budget.
   *
   * The optional `onJobDone` hook is forwarded to the runner so a live
   * consumer can react to each finished job without waiting for `start()` to
   * resolve (which only happens at the end of the whole run).
   */
  createRunner: (budget: AnalysisBudget, onJobDone?: JobDoneHook) => JobRunner;
  /**
   * STEP38 — the authenticated user's STABLE account id (`users/{uuid}`,
   * never the display name). Drives OWN-vs-FOREIGN eligibility + priority.
   * OPTIONAL: when `undefined` (identity not resolvable) every sample is
   * evaluated under foreign rules and is never wrongly promoted to OWN.
   */
  authenticatedUserId?: string;
  /** The existing delta library scanner. */
  scanFn?: typeof scanLibrary;
  /** Page source for the scanner (wraps the samples.list client). */
  fetchPage: PageFetcher;
  /** Known-updatedAt provider for the scanner (from the index). */
  known: KnownProvider;
  /** Resolve a preview source URL for a record (from library metadata). */
  previewUrlFor: (record: SampleIndexRecord) => string | undefined;
  analysisBuild: string;
  /** Bound the number of samples fetched by one scan (no uncontrolled scan). */
  scanMaxSamples?: number;
  /** Optional subscriber invoked after any state change (for rendering). */
  onChange?: () => void;
  /** Step 16K: the global index for map viewport queries. */
  globalIndex?: GlobalSampleIndex;
  /** Step 16K: resolve sample metadata by id (for global point selection). */
  resolveSample?: (sampleId: string) => Promise<SampleMeta | undefined>;
  /**
   * STEP16R E-P6 — read-only handle to the GLOBAL publish queue whose snapshot
   * feeds the publish-status inspector surface. The UI NEVER enqueues, flushes
   * or retries through this handle; it only reads `snapshot()`.
   */
  globalPublishQueue?: GlobalPublishQueue;
  /** STEP16R E-P6 — delivery mode of the provider already wired at bootstrap. */
  globalPublishDelivery?: PublishDeliveryMode;
  /**
   * STEP19A E-P7 — one-time consent preference store for the first `Add to
   * Machiniste` (FINAL_UI_UX_DESIGN_SPEC §19.5). When omitted the controller
   * uses a fresh in-memory store (NOT granted), so the guard is always active
   * and safe-by-default; the browser bootstrap wires a localStorage-backed
   * store so the granted preference survives reloads.
   */
  ep7Consent?: Ep7ConsentStore;
  /**
   * STEP28 — the persistent Sound Collection store (§15/§16). Optional by
   * contract: when absent, collections remain session-local and the manager
   * honestly surfaces "persistence unavailable" without crashing.
   */
  collectionStore?: CollectionStore;
  /**
   * STEP80 — shared IndexedDB handle hosting the tiny `meta` discovery-cursor
   * store. OPTIONAL: when absent, public discovery is simply skipped (the app
   * behaves exactly as before). Wired by the browser bootstrap from the stores
   * it already opens — never a second database.
   */
  dbForDiscovery?: ElasticDB;
}

/** STEP62 — page size for the dedicated own‑upload discovery pass. */
/** Start-of-scan default (bounded — the scanner must never run unbounded). */
const DEFAULT_SCAN_MAX_SAMPLES = 200;

/**
 * Step 16L — global map bounded-loading constants (V1).
 * The client NEVER auto-loads the whole global map: one viewport page per
 * camera state, at most GLOBAL_MAP_MAX_PAGES pages via `nextCursor`. This is
 * the bounded-hydration boundary — no unbounded paging into millions.
 */
const GLOBAL_MAP_PAGE_LIMIT = 500;
const GLOBAL_MAP_MAX_PAGES = 2;

/** Debounce for camera-driven global refresh (no request per pointermove). */
const GLOBAL_REFRESH_DEBOUNCE_MS = 250;

/**
 * Minimum interval between coalesced live result refreshes while an analysis
 * run is in flight.
 *
 * The pipeline persists every finished record immediately, but a run may
 * complete thousands of jobs; refreshing (a full `getAll()` + search + full
 * render) per job would cost more than the analysis itself. Jobs that finish
 * within this window share one refresh, so the update rate is bounded by TIME,
 * not by the job count. The run's final state is always synced exactly once at
 * run end (see `applyProgress`), which also cancels any pending live refresh.
 */
const ANALYSIS_LIVE_REFRESH_MS = 500;

/**
 * Budget of the AUTOMATIC background run started when the app is opened.
 *
 * 1000 is one of the three INV-3 budgets (10/100/1000) and is still enforced by
 * the `JobRunner`, so the automatic run stays a BOUNDED run — it is not
 * unbounded processing. A session constant: never configurable, never
 * persisted, and never widened by the automatic workflow.
 */
export const BACKGROUND_INDEXING_BUDGET: AnalysisBudget = 1000;

/** Step 16L: distinguishable global-map UI states. */
export type GlobalMapState = "idle" | "loading" | "ok" | "empty" | "error";

export class SampleMapApp {
  readonly scan: ScanState = {
    status: "idle",
    foundCount: 0,
    pageCount: 0,
    error: undefined,
    eligibleEnqueued: 0,
    ineligibleSkipped: 0,
    ownDiscovered: 0,
    ownEnqueued: 0,
  };

  readonly analysis: AnalysisState = {
    budget: undefined,
    status: "idle",
    analyzed: 0,
    failed: 0,
    skipped: 0,
    gone: 0,
    stoppedReason: undefined,
    error: undefined,
  };

  readonly searchState: SearchState = {
    text: "",
    classes: [],
    minConfidence: undefined,
    sortBy: "relevance",
    sortDir: "desc",
  };

  /**
   * Global / My Samples — two INDEPENDENT visibility toggles over the one
   * shared 2D sound space. The visible map set is their UNION (never the
   * intersection); all four combinations are valid, including both OFF.
   *
   * Default: both ON, so the map shows the widest possible view (the user's
   * own samples plus the existing global set) instead of starting empty.
   */
  readonly visibility: { global: boolean; mine: boolean } = { global: true, mine: true };

  /**
   * The COMPLETE set of the authenticated user's known sample ids, in ANY
   * analysis status — not viewport-bounded and not limited to analyzed
   * samples. Refreshed together with the search snapshot so newly persisted
   * live-analysis records join the set immediately.
   */
  private mySampleIds = new Set<string>();

  readonly machiniste: MachinisteState = {
    lastResult: undefined,
    error: undefined,
    pendingSamples: [],
  };

  results: SearchResult[] = [];

  /**
   * FOCUS (FINAL_UI_UX_DESIGN_SPEC §1.1 / §3): the single sample currently
   * being inspected / interacted with. Exactly zero or one. This is the target
   * of the Inspector, Find-Similar and the map highlight. Focus NEVER
   * participates in batch selection and is never pruned by filtering/search.
   */
  focusedSampleId: string | null = null;

  /**
   * SELECTION (FINAL_UI_UX_DESIGN_SPEC §3 / §13.7): the explicit batch selection
   * (0..MAX_BATCH_SLOTS, i.e. at most 8) used for batch actions such as "Send to
   * Machiniste". Independent of focus. Filtering/search/zoom MUST NOT mutate
   * this list (visibility ≠ availability; a hidden sample stays selected).
   */
  selectedSampleIds: string[] = [];

  /**
   * Record registry so that a focused/selected sample remains resolvable (and
   * the Inspector inspectable) even when filtering/search removes it from
   * `results`. Populated whenever a record is focused or toggled into selection.
   */
  private knownRecords = new Map<string, SampleIndexRecord>();

  /** Step 15F: the map camera (zoom/pan). RUNTIME-ONLY — never persisted. */
  mapCamera: MapCamera = defaultMapCamera();

  /** Step 16K: global map points from the worker /map endpoint. */
  globalPoints: GlobalMapPoint[] = [];

  /** Step 16L: current global-map UI state (idle/loading/ok/empty/error). */
  globalMapState: GlobalMapState = "idle";

  /** Step 16L: the normalized viewport bbox of the last global-map query. */
  globalBBox: NormalizedBBox | undefined;

  /** Step 16L: a loaded global-only inspection (undefined when none). */
  globalInspection: GlobalInspection | undefined;

  /** Step 16L: Find-Similar results for the current selection. */
  similarResults: SimilarSampleResult[] = [];
  /** Step 16L: resolved local records backing `similarResults`. */
  similarRecords: SampleIndexRecord[] = [];
  /** Step 16L: last Find-Similar error, if any. */
  similarError: string | undefined;

  /**
   * STEP23 — the V2 similarity product surface (see `SimilarityState`). A
   * snapshot tied to its query sample; V1 `similar*` above is untouched.
   */
  similarityV2: SimilarityState = emptySimilarityState();
  soundSpace: SoundSpaceState = emptySoundSpaceState();
  /** STEP26 — the V2 Discovery surface (session-local, never persisted). */
  discovery: DiscoveryState = emptyDiscoveryState();
  /** STEP26 — draft text typed into the Discovery panel (not yet submitted). */
  discoveryTextDraft = "";
  /**
   * STEP27 — the session-local Sound Collection (pure boundary in
   * `src/analysis/collection.ts`). Explicit insertion order, duplicate-safe,
   * hard-capped at 50, NEVER persisted and NEVER automatically mutated (no
   * auto-add, no auto-sort, no auto-eviction). Independent of focus, selection,
   * Discovery, Search and the Sound Space filter.
   */
  collection: SoundCollectionState = emptyCollectionState();
  /** STEP27 — the Collection Compare surface (derived, session-local). */
  collectionCompare: SoundSpaceCompareState = { open: false, sampleIds: [] };
  /**
   * STEP29/STEP32 — progressive disclosure state tracking which surfaces are
   * revealed by INTENT (STEP32: focus reveals similarity, add reveals the
   * collection; Sound Space and Inspector are always available surfaces and so
   * carry no flag). Each flag is written by its natural trigger and read as a
   * render gate — no dead flags.
   */
  progressiveDisclosure: {
    /** True when the Discovery surface has been used at least once. */
    discoveryUsed: boolean;
    /** True when the Collection manager has been revealed (first genuine add). */
    collectionManagerUsed: boolean;
    /** True when Similarity V2 has been revealed (focus or explicit open). */
    similarityV2Used: boolean;
  } = {
    discoveryUsed: false,
    collectionManagerUsed: false,
    similarityV2Used: false,
  };
  /**
   * STEP27 — the set of sampleIds known to be present in the CURRENT local
   * index snapshot. Refreshed on collection-open/add and on search refresh
   * (when the collection is non-empty) so a member whose record was removed
   * from the index degrades to the honest "Unavailable sample" row WITHOUT
   * being dropped from the collection (spec §27/§28).
   */
  private collectionKnownIds: ReadonlySet<string> = new Set();
  /**
   * STEP28 — the display name of the current working collection (the draft the
   * user curates). Started at the default; renamed/laden explicitly. The
   * persistence layer stores ONLY this name + the ordered sampleIds (§28).
   */
  collectionName = DEFAULT_COLLECTION_NAME;
  /**
   * STEP28 — id of the ACTIVE persisted collection backing the working set
   * (§29/§48). NULL on boot: there is NEVER an automatic restore and never a
   * hidden "last used" persistence. A null active id means the working set is
   * not yet saved under any collection.
   */
  activeCollectionId: string | null = null;
  /**
   * STEP28 — true when the working set (name or membership) differs from the
   * last successful persisted state. Rendered as a trailing `*` (§44: `Drums
   * *`). Set by rename/add/remove/clear/create; cleared ONLY by a successful
   * save/save-as or load. A FAILED save keeps `dirty === true` (§26).
   */
  collectionDirty = false;
  /** STEP28 — last save/save-as failure (surfaced, retry allowed — §26). */
  collectionSaveError: string | undefined;
  /** STEP28 — true while a save/save-as is in flight (prevents double submit). */
  collectionSaving = false;
  /** STEP28 — the Collection manager panel state (list/load/delete/confirm). */
  collectionManager: CollectionManagerState = {
    open: false,
    listStatus: "idle",
    entries: [],
    listError: undefined,
    loadError: undefined,
    deleteError: undefined,
    nameDraft: DEFAULT_COLLECTION_NAME,
    confirm: undefined,
  };
  /** STEP24 — the deterministic Sound Space projector instance. */
  private readonly soundSpaceProjector = createSoundSpaceProjector();

  /** Id of the sample currently previewing (undefined if none). */
  previewSampleId: string | undefined;
  previewError: string | undefined;

  private runner: JobRunner | undefined;
  /**
   * STEP80 — the settled-later promise of the analysis run that is currently in
   * flight (`undefined` when no run was ever started).
   *
   * `analyze()` starts the runner ITSELF and wires its own progress handling;
   * this is only a single reference to that very same run, never a second run.
   * The public discovery round uses it to WAIT for an already running analysis
   * (instead of starting another one) and then decide about one follow-up run.
   * It changes no analysis/pipeline/runner behaviour.
   */
  private currentAnalysisRun: Promise<void> | undefined;
  private previewHandleValue: PreviewHandle | undefined;
  /** SM-AUDIT-007: generation counter so stale in-flight previews are discarded. */
  private previewEpoch = 0;
  private scanAborted = false;
  /** Step 16L: debounce timer for camera-driven global refresh. */
  private globalRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private globalRefreshDisposed = false;
  /** BUG #5 (STEP16V): generation counter so a stale in-flight global-points
   *  response can never overwrite a newer camera's points (previewEpoch style). */
  private globalRefreshEpoch = 0;
  /** SM-AUDIT-008: generation counter so a stale in-flight `refreshSearch()`
   *  can never write an older snapshot over a newer one. Matters once search
   *  refreshes overlap (live analysis updates + rapid user filter changes);
   *  without it a slow earlier query can clobber a fast later one. */
  private searchEpoch = 0;
  /** Pending coalesced live result refresh during an analysis run. */
  private analysisLiveTimer: ReturnType<typeof setTimeout> | undefined;
  private analysisLiveDisposed = false;

  /**
   * Whether the AUTOMATIC background indexing run was already started for this
   * app instance. Session state only (never persisted) and the single guard
   * against a duplicate automatic scan+analysis run.
   */
  private backgroundIndexingStarted = false;

  /**
   * True once the automatic background indexing was started for this instance
   * (whether it is still running or already finished). Exposed so the UI, the
   * tests and the e2e harness can observe the automatic workflow without
   * reaching into private state.
   */
  get backgroundIndexingTriggered(): boolean {
    return this.backgroundIndexingStarted;
  }

  /** STEP19A E-P7 — the one-time consent store (default: safe in-memory). */
  private readonly consentStore: Ep7ConsentStore;
  /** STEP19A E-P7 — true while the consent dialog is showing. */
  ep7ConsentRequired = false;
  /** STEP19A E-P7 — surfaced in the dialog when a persistence write fails. */
  ep7ConsentError: string | undefined;
  /** STEP19A E-P7 — the guarded action suspended until explicit acceptance. */
  private pendingMachinisteSend:
    | { machinisteId: string; slotStart: number }
    | undefined;

  constructor(private readonly deps: SampleMapAppDeps) {
    this.consentStore = deps.ep7Consent ?? createMemoryEp7ConsentStore();
    this.authenticatedUserId = deps.authenticatedUserId;
  }

  /**
   * STEP38 — the authenticated user's stable account id driving OWN-vs-FOREIGN
   * eligibility + queue priority. Session context (never persisted). Absent →
   * "own detection unavailable": every sample evaluates under FOREIGN rules.
   */
  private readonly authenticatedUserId: string | undefined;

  /**
   * STEP28 — whether persistent collection storage is wired for this session.
   * When absent, the manager honestly surfaces persistence as unavailable.
   */
  get collectionPersistenceAvailable(): boolean {
    return this.deps.collectionStore !== undefined;
  }

  /**
   * STEP16R E-P6 — read-only view of the GLOBAL publish queue. The UI never
   * enqueues/flushes/retries here; it only reads the snapshot for the
   * publish-status surface. `undefined` → no publish surface at all.
   */
  get globalPublishQueue(): GlobalPublishQueue | undefined {
    return this.deps.globalPublishQueue;
  }

  /** STEP16R E-P6 — delivery mode of the provider wired at bootstrap. */
  get globalPublishDeliveryMode(): PublishDeliveryMode {
    return this.deps.globalPublishDelivery ?? "offline";
  }

  /** Number of budget slots remaining (undefined when no budget / uncontrolled). */
  get remainingBudget(): number | undefined {
    if (this.analysis.budget === undefined) return undefined;
    return Math.max(0, this.analysis.budget - this.analysis.analyzed);
  }

  // ------------------------------------------------------------------
  // Library scan (§A) — bounding file: scanner and analysis stay separate
  // ------------------------------------------------------------------

  /** Start a (bounded) library scan and enqueue new/changed samples to the queue. */
  async startScan(): Promise<void> {
    if (this.scan.status === "scanning") return;
    this.scanAborted = false;
    this.scan.status = "scanning";
    this.scan.error = undefined;
    this.notify();

    const scanFn = this.deps.scanFn ?? scanLibrary;
    try {
      const out = await scanFn(this.deps.fetchPage, this.deps.known, {
        pageSize: 20,
        maxSamples: this.deps.scanMaxSamples ?? DEFAULT_SCAN_MAX_SAMPLES,
      });
if (this.scanAborted) {
      this.scan.status = "done";
      return;
    }
    // STEP62 — initialise own‑upload discovery counters.
    this.scan.ownDiscovered = 0;
    this.scan.ownEnqueued = 0;
      // STEP38 — eligibility gate: enqueue ONLY eligible samples (own, or
      // foreign with favorites/usage ≥ 1). Ineligible foreign zero/zero samples
      // are NOT auto-enqueued (no retroactive deletion — already-analyzed
      // records are untouched; re-analysis never triggers on a metadata change).
      // Eligible ones carry a priorityGroup (own first, one-shots before loops).
      const toEnqueue = [...out.added, ...out.changed];
      let eligibleEnqueued = 0;
      let ineligibleSkipped = 0;
      for (const sample of toEnqueue) {
        const el = computeEligibilityFromMeta(sample, this.authenticatedUserId);
        if (el.eligible) {
          await this.deps.queue.enqueue(
            sample.name,
            this.deps.analysisBuild,
            priorityGroupOfMeta(sample, this.authenticatedUserId),
          );
          eligibleEnqueued++;
        } else {
          ineligibleSkipped++;
        }
      }
      // METADATA SLICE — refresh bpm/numFavorites/numUsages on ANY sample whose
      // fresh SampleMeta we observed this scan (added + changed) that already has
      // an analyzed record. This is a pure metadata write: it never downloads or
      // decodes audio, never re-extracts features, never re-classifies and never
      // recomputes mapPosition — those analysis fields are preserved verbatim.
      for (const sample of toEnqueue) {
        await this.applyMetadataRefresh(sample);
      }
      this.scan.foundCount = out.seenSampleIds.length;
      this.scan.pageCount = out.pageCount;
      this.scan.eligibleEnqueued = eligibleEnqueued;
      this.scan.ineligibleSkipped = ineligibleSkipped;
      this.scan.status = "done";
    } catch (e) {
      this.scan.status = "error";
      this.scan.error = e instanceof Error ? e.message : String(e);
    }
    this.notify();
  }

  /** Prevent the scan from enqueueing / continuing (used to stop a scan). */
  stopScan(): void {
    this.scanAborted = true;
    this.notify();
  }

  /**
   * METADATA SLICE — update ONLY bpm / numFavorites / numUsages on an existing
   * analyzed record from a fresh SampleMeta. This is strictly a metadata write:
   * it performs NO audio fetch, NO decode, NO feature extraction, NO
   * classification and NO map-position computation. All analysis fields seen on
   * the existing record (primaryClass, confidence, secondaryClasses,
   * audioFeatures, mapPosition, identity, timestamps, ...) are preserved
   * verbatim as an atomic object swap through the index store, so nothing
   * re-enters the analysis pipeline.
   */
  private async applyMetadataRefresh(meta: SampleMeta): Promise<void> {
    if (!this.deps.index) return;
    const sampleId = meta.name;
    const existing = await this.deps.index.get(sampleId);
    if (!existing) return;
    const refreshed: SampleIndexRecord = { ...existing };
    if (meta.bpm !== undefined) refreshed.bpm = meta.bpm;
    if (meta.numFavorites !== undefined) refreshed.numFavorites = meta.numFavorites;
    if (meta.numUsages !== undefined) refreshed.numUsages = meta.numUsages;
    await this.deps.index.put(refreshed);
  }

  // ------------------------------------------------------------------
  // Controlled analysis (§4) — budgets 10/100/1000 only
  // ------------------------------------------------------------------

  /** Start a controlled analysis run with the given budget. Returns the runner. */
  analyze(budget: AnalysisBudget): JobRunner {
    // SM-AUDIT-005: reentrancy guard — a second call while running returns
    // the existing runner instead of creating a concurrent duplicate.
    if (this.analysis.status === "running") {
      return this.runner!;
    }
    this.analysis.budget = budget;
    this.analysis.status = "running";
    this.analysis.stoppedReason = undefined;
    this.analysis.analyzed = 0;
    this.analysis.failed = 0;
    this.analysis.skipped = 0;
    this.analysis.gone = 0;
    this.runner = this.deps.createRunner(budget, () => this.applyLiveProgress());
    // STEP80 — keep ONE reference to the run started here, so callers that must
    // not start a parallel run (public discovery) can await exactly this run.
    this.currentAnalysisRun = this.runner.start().then(
      (p) => {
        this.applyProgress(p);
      },
      (e) => {
        this.analysis.status = "stopped";
        this.analysis.error = e instanceof Error ? e.message : String(e);
        this.notify();
      },
    );
    this.notify();
    return this.runner;
  }

  /**
   * AUTOMATIC background indexing — the NORMAL product path.
   *
   * Opening the app is enough: it scans the library and then analyses whatever
   * is due, so the user never has to press "Start Scan" and then "Analyse N"
   * first. The manual controls stay available as the technical/debug fallback.
   *
   * This is pure ORCHESTRATION of the existing `startScan()` + `analyze()`: no
   * eligibility rule, budget rule, queue rule or pipeline step is duplicated
   * here. The mount calls it WITHOUT awaiting (`void app.startBackgroundIndexing()`),
   * so the UI is interactive while it runs and the mount never blocks on the
   * scan, let alone on the analysis run. Individual results keep appearing live
   * on the map through the existing per-job refresh.
   */
  async startBackgroundIndexing(): Promise<void> {
    // MEHRACHSTART: exactly one automatic run per app instance, no matter how
    // often this is called. The existing `startScan()` / `analyze()` reentrancy
    // guards still apply on top, so neither a parallel scan nor a parallel
    // analysis run can be started from here.
    if (this.backgroundIndexingStarted) return;
    this.backgroundIndexingStarted = true;

    await this.startScan();

    // STEP80 — public discovery runs BEFORE the due-work check and OUTSIDE the
    // scan/analyse ownership logic: newly discovered public samples are now in
    // the queue, so a session that would otherwise find "nothing due" still
    // starts the existing analysis for them. Fire-and-forget on purpose: a
    // failing/slow listing round must never break or block the normal
    // background indexing path.
    void this.runPublicDiscoveryRound();

    // A scan owned by someone else (a manual "Start Scan" click that won the
    // race against this automatic start) is still enqueueing. Starting the
    // analysis now would analyse a half-discovered queue and leave the rest
    // stranded, so the manual flow keeps ownership of this round.
    if (this.scan.status === "scanning") return;

    // Analyse only when there is genuinely DUE work. `nextDue` covers both the
    // jobs this scan just enqueued AND jobs a previous session left behind (an
    // interrupted run, or a library that is still only partially analysed) —
    // without it, reopening the app could never finish that work. Already
    // analysed samples are not due and are therefore never analysed again
    // (existing queue idempotency: `enqueue` returns "existing" for a
    // completed job of the same build).
    const due = await this.deps.queue.nextDue(1);
    if (due.length === 0) return;

    this.analyze(BACKGROUND_INDEXING_BUDGET);
  }

  /**
   * STEP80 — ONE bounded public-discovery round, orchestrated entirely through
   * EXISTING abstractions (no second analysis pipeline, NO second publish
   * pipeline):
   *
   *   discoverPublicSamples()      → existing QueueStore.enqueue (jobs)
   *   existing JobRunner/pipeline  → analyzes whatever is due (once per round)
   *   populateGlobalPublishQueue() → THE single existing publish transition
   *                                   (createPublishCandidate →
   *                                    GlobalPublishQueue.enqueue → flush)
   *
   * Discovery itself never publishes; the Step-70 auto-population pass already
   * covers every analyzed record (including discovered public samples) after
   * the analysis completes, so `publishPublicAnalyses()` is intentionally NOT
   * wired here — it stays as a targeted helper for tests/tooling only.
   *
   * Budgeted (page + sample budget inside the discovery module), incremental
   * (persisted cursor + index/job dedup) and non-blocking: the mount calls
   * this fire-and-forget and every failure is logged only. Without the
   * optional dep (`dbForDiscovery`) this is a no-op — behavior identical to
   * before STEP80.
   */
  private async runPublicDiscoveryRound(): Promise<void> {
    const { index, dbForDiscovery } = this.deps;
    if (!index || !dbForDiscovery) return;
    try {
      // 1. Discover: paginated listing → new public samples enter the EXISTING
      //    analysis queue. Known/analyzed/published samples are skipped by the
      //    module's persisted-state dedup — nothing is enqueued twice.
      await discoverPublicSamples(
        { fetchPage: this.deps.fetchPage, index, queue: this.deps.queue, db: dbForDiscovery },
        this.deps.analysisBuild,
      );

      // 2. Let the EXISTING runner analyze whatever became due — at most once
      //    per round. If a run is already in flight (background or manual), we
      //    never start a concurrent one; leftover due jobs are picked up by the
      //    next round / next app start via the existing `nextDue` recovery.
      if (this.analysis.status !== "running") {
        const due = await this.deps.queue.nextDue(1);
        if (due.length > 0) {
          this.analyze(BACKGROUND_INDEXING_BUDGET);
        }
      } else {
        // STEP80: race window — an analysis run IS currently in flight. We must
        // NOT start a parallel run here. Instead, we WAIT for this running run
        // to finish (or settle), because new public jobs may have been enqueued
        // just before it completed. Once it settles, we check ONCE if there are
        // still due jobs and, if so, start EXACTLY one follow-up run. This is
        // the smallest possible coordination with the existing architecture.
        if (this.currentAnalysisRun !== undefined) {
          await this.currentAnalysisRun.catch(() => undefined);
        }
        const due = await this.deps.queue.nextDue(1);
        if (due.length > 0 && this.analysis.status !== "running") {
          this.analyze(BACKGROUND_INDEXING_BUDGET);
        }
      }

      // 3. Publish ONLY through the existing Step-70 transition (single path,
      //    internally guarded by its own deps check).
      await this.populateGlobalPublishQueue();
    } catch (e) {
      // Discovery must never destroy the normal indexing path — log only.
      console.warn(
        `[SampleMap] public discovery round failed (ignored): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Request a clean pause (current in-flight job finishes; nothing is lost). */
  pause(): void {
    this.runner?.pause();
  }

  /** Resume a paused run (JobRunner.start() resumes persisted queue state). */
  resume(): JobRunner {
    if (!this.runner) {
      throw new Error("no analysis run to resume");
    }
    this.analysis.status = "running";
    this.analysis.stoppedReason = undefined;
    void this.runner.start().then(
      (p) => this.applyProgress(p),
      (e) => {
        this.analysis.status = "stopped";
        this.analysis.error = e instanceof Error ? e.message : String(e);
        this.notify();
      },
    );
    this.notify();
    return this.runner;
  }

  /**
   * Per-job progress while a run is in flight (`JobRunner` `onJobDone`).
   *
   * Deliberately does NOT call `notify()`: a full render per job is exactly
   * what this path must avoid. The counters are written straight through and
   * the expensive part (search + render) is coalesced by
   * `scheduleLiveRefresh()`, so the next render picks up both the new counts
   * and the new records.
   */
  private applyLiveProgress(): void {
    // Late callback from a run that already ended — applyProgress owns the
    // final state; never move the progress display backwards.
    if (this.analysis.status !== "running") return;
    const p = this.runner?.progressSnapshot();
    if (!p) return;
    this.analysis.analyzed = p.analyzed;
    this.analysis.failed = p.failed;
    this.analysis.skipped = p.skipped;
    this.analysis.gone = p.gone;
    this.scheduleLiveRefresh();
  }

  /**
   * Coalesce per-job progress into at most one result refresh per
   * `ANALYSIS_LIVE_REFRESH_MS` window (trailing edge, never re-armed): several
   * jobs finishing back-to-back share a single refresh, so a 1000-sample run
   * cannot produce 1000 full search+render cycles.
   */
  private scheduleLiveRefresh(): void {
    if (this.analysisLiveDisposed) return;
    if (this.analysisLiveTimer !== undefined) return; // already coalescing
    this.analysisLiveTimer = setTimeout(() => {
      this.analysisLiveTimer = undefined;
      void this.refreshSearch();
    }, ANALYSIS_LIVE_REFRESH_MS);
  }

  /** Drop a pending coalesced live refresh (the run is over; it is redundant). */
  private cancelLiveRefresh(): void {
    if (this.analysisLiveTimer !== undefined) {
      clearTimeout(this.analysisLiveTimer);
      this.analysisLiveTimer = undefined;
    }
  }

  private applyProgress(p: RunProgress): void {
    // The run is over: a pending live refresh is now redundant, and letting it
    // fire later would re-render the same data (or, without the status guard
    // in applyLiveProgress, could fight this final state).
    this.cancelLiveRefresh();
    this.analysis.analyzed = p.analyzed;
    this.analysis.failed = p.failed;
    this.analysis.skipped = p.skipped;
    this.analysis.gone = p.gone;
    this.analysis.stoppedReason = p.stoppedReason;
    this.analysis.error = undefined;
    this.analysis.status = p.stoppedReason === "pause" ? "paused" : "stopped";
    this.notify();
    // The analysis run wrote its records straight into the index; the result set
    // (and with it the result list and the map) is only re-read here. Without this
    // the surfaces keep serving the pre-run results and the map stays empty even
    // though every record is analyzed and carries a persisted map position.
    // Best-effort: a failing re-read must not surface as an unhandled rejection.
    // This final sync is authoritative — it is the only refresh that must
    // observe every record the run persisted.
    if (typeof this.deps.search?.search === "function") void this.refreshSearch();
    // Step 70 — automatic global population: a completed run is the trigger
    // for "local analyzed → publish queue" (offline-first; fire-and-forget so
    // the analysis result path is never delayed by publish/delivery work).
    void this.populateGlobalPublishQueue();
  }

  /**
   * Step 70 — feed the EXISTING global publish path from completed analysis.
   *
   * Scans the local index for analyzed, publish-eligible records (the single
   * gate stays `createPublishCandidate`), enqueues them into the existing
   * `GlobalPublishQueue` and persists the 16H pending marker. When the
   * bootstrap delivery mode is "live" an immediate best-effort flush drains
   * the queue (existing retry/backoff applies); offline a flush is NOT
   * attempted — items stay `pending` (per §2) and are delivered by the next
   * live session / explicit flush.
   *
   * Runs AFTER the analysis run is finished (never in the per-job hot path),
   * never throws into the analysis UX, and only acts when bootstrap provided
   * BOTH the local index and the publish queue (live mount / harness).
   */
  private async populateGlobalPublishQueue(): Promise<void> {
    if (!this.deps.index || !this.deps.globalPublishQueue) return;
    try {
      const { index, globalPublishQueue } = this.deps;
      await populatePublishQueue({ index, queue: globalPublishQueue });
      if (this.globalPublishDeliveryMode === "live") {
        await flushPendingPublications({ index, queue: globalPublishQueue });
        void this.refreshGlobalPoints().catch(() => {});
      }
    } catch {
      // Population/delivery must never surface as an analysis failure; the
      // queue's retry/backoff keeps every item retryable for a later flush.
    }
    // Reflect the new/updated publish markers on the read-only status surface.
    void this.refreshSearch().catch(() => {});
  }

  async setSearch(text: string): Promise<void> {
    this.searchState.text = text;
    await this.refreshSearch();
  }

  async setClasses(classes: ClassId[]): Promise<void> {
    this.searchState.classes = [...classes];
    await this.refreshSearch();
  }

  async setMinConfidence(v: number | undefined): Promise<void> {
    this.searchState.minConfidence = v;
    await this.refreshSearch();
  }

  async setSort(sortBy: SearchSort, sortDir: SearchSortDir = "desc"): Promise<void> {
    this.searchState.sortBy = sortBy;
    this.searchState.sortDir = sortDir;
    await this.refreshSearch();
  }

  // ------------------------------------------------------------------
  // Global / My Samples visibility — map-only, search untouched
  // ------------------------------------------------------------------

  /**
   * Toggle Global and/or My Samples. The two flags are fully independent, and
   * only the passed key(s) change — passing one never resets the other.
   *
   * This is deliberately NOT a search filter: `results` (the searchable set)
   * is left completely untouched, so a sample stays findable through the
   * existing search mechanism even while it is not on the map. Only the map's
   * visible point set changes, which is a pure projection of `results`.
   */
  async setVisibility(patch: Partial<VisibilityToggles>): Promise<void> {
    this.visibility.global = patch.global ?? this.visibility.global;
    this.visibility.mine = patch.mine ?? this.visibility.mine;
    // Deliberately no re-search: the searchable set did not change, so this is
    // a render-only update. A full re-search here would risk an epoch race for
    // no benefit.
    this.notify();
  }

  /** The records that may become map points under the current toggles. */
  get visibleMapRecords(): readonly SampleIndexRecord[] {
    return this.mapVisibility.visibleRecords;
  }

  /** Membership (isGlobal/isMine) for every record, visible or not. */
  get mapMembership(): ReadonlyMap<string, SampleMembership> {
    return this.mapVisibility.membershipAll;
  }

  /**
   * The complete set of the authenticated user's known sample ids (any analysis
   * status). Never viewport-bounded and never limited to analyzed samples.
   */
  get mySamples(): ReadonlySet<string> {
    return this.mySampleIds;
  }

  /** True when the authenticated user's stable id is known (My Samples works). */
  get hasAuthenticatedIdentity(): boolean {
    return typeof this.authenticatedUserId === "string" && this.authenticatedUserId.length > 0;
  }

  /**
   * The current visibility projection, recomputed per access so it can never go
   * stale against `results` / `globalPoints` / the toggles.
   */
  private get mapVisibility(): MapVisibility {
    return resolveMapVisibility(
      this.results.map((r) => r.record),
      this.globalPoints,
      this.visibility,
      this.authenticatedUserId,
    );
  }

  /** Project current filters onto the SearchEngine (read-only). */
  async refreshSearch(): Promise<void> {
    // SM-AUDIT-008: every refresh supersedes the previous in-flight one
    // (previewEpoch / globalRefreshEpoch style). Search calls overlap once
    // live analysis updates meet rapid user filter changes, and an older
    // response must never overwrite a newer snapshot.
    const epoch = ++this.searchEpoch;
    const q: SearchQuery = {};
    if (this.searchState.text.trim()) q.text = this.searchState.text.trim();
    if (this.searchState.classes.length) q.classes = [...this.searchState.classes];
    if (this.searchState.minConfidence !== undefined) q.minConfidence = this.searchState.minConfidence;
    q.sortBy = this.searchState.sortBy;
    q.sortDir = this.searchState.sortDir;
    const results = await this.deps.search.search(q);
    // Superseded mid-flight: a newer refresh will publish its own snapshot.
    if (epoch !== this.searchEpoch) return;
    this.results = results;
    // STEP16R E-P6: re-sync the record registry with the freshly-read records
    // so that out-of-band persisted writes (16H usage-acceptance markers) are
    // reflected by read-only surfaces (e.g. the publish-status inspector block).
    // This never REMOVES an entry — a focused/selected sample stays resolvable.
    for (const r of this.results) {
      this.knownRecords.set(r.record.sampleId, r.record);
    }
    // My Samples membership is recomputed from the COMPLETE index (any status),
    // not from the analyzed search hits — so a sample that is known but not
    // (yet) analyzed is still part of the user's set, and a record persisted
    // by a live analysis run joins it as soon as this snapshot lands.
    if (this.deps.index) {
      const allRecords = await this.deps.index.getAll();
      // The getAll() above awaits — a newer refresh may own the state now.
      if (epoch !== this.searchEpoch) return;
      this.mySampleIds = mineSampleIds(allRecords, this.authenticatedUserId);
    }
    // STEP27 — index-refresh must NEVER drop a collection member; instead the
    // availability snapshot is re-synced so stale members surface as
    // "Unavailable sample" while remaining in the collection (§27/§28).
    if (this.collection.sampleIds.length > 0) {
      await this.refreshCollectionKnownIds();
    }
    // The collection re-sync above awaits — a newer refresh may have started.
    if (epoch !== this.searchEpoch) return;
    this.notify();
  }

  /**
   * STEP27 — snapshot the CURRENT index sampleIds for availability checks. A
   * member whose record no longer exists degrades to "Unavailable sample" (it
   * is NEVER dropped — §27/§28). STEP28: this ALSO hydrates the registry from
   * the current index so a loaded collection's members (and any refresh) can
   * resolve records for focus/preview against the CURRENT index snapshot
   * (§36 — re-resolve, never re-analyze).
   */
  private async refreshCollectionKnownIds(): Promise<void> {
    if (!this.deps.index) {
      this.collectionKnownIds = new Set();
      return;
    }
    const all = await this.deps.index.getAll();
    this.collectionKnownIds = new Set(all.map((r) => r.sampleId));
    for (const r of all) this.knownRecords.set(r.sampleId, r);
  }

  /**
   * Reset every search/filter criterion and reload the full (analyzed) result
   * set via the SearchEngine. No separate "all samples" list is maintained.
   */
  async clearSearch(): Promise<void> {
    this.searchState.text = "";
    this.searchState.classes = [];
    this.searchState.minConfidence = undefined;
    this.searchState.sortBy = "relevance";
    this.searchState.sortDir = "desc";
    await this.refreshSearch();
  }

  /**
   * The focused sample record (undefined when nothing is focused). Resolves via
   * the record registry so a focused sample that filtering/search hides from
   * `results` is still inspectable. FOCUS — never the batch selection.
   */
  get focusedRecord(): SampleIndexRecord | undefined {
    return this.focusedSampleId === null
      ? undefined
      : this.knownRecords.get(this.focusedSampleId);
  }

  /**
   * The selected sample records, in selection order (0..MAX_BATCH_SLOTS).
   * SELECTION — the explicit batch used by "Send to Machiniste", independent of
   * focus and never pruned by filtering/search/zoom.
   */
  get selectedRecords(): SampleIndexRecord[] {
    const out: SampleIndexRecord[] = [];
    for (const id of this.selectedSampleIds) {
      const rec = this.knownRecords.get(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Map camera (Step 15F) — runtime-only view state, never persisted
  // ------------------------------------------------------------------

  /**
   * Commit a new camera (drag-pan end / wheel zoom from `mapRender`). This only
   * mutates the pure viewing transform; sample positions, audioFeatures and
   * classification are untouched (§34 Camera State ≠ Sample State). The camera
   * is clamped to the zoom/pan bounds so the committed state always satisfies
   * the view invariants (§6/§11).
   */
  setMapCamera(camera: MapCamera): void {
    this.mapCamera = clampPan({ ...camera, zoom: clampZoom(camera.zoom) });
    this.notify();
    this.scheduleGlobalRefresh();
  }

  /**
   * Zoom by `factor` (must be > 0), keeping the base-pixel `anchor` point fixed
   * on screen when given (wheel-around-pointer); otherwise zoom around the map
   * centre (the [−]/[+] buttons). Clamped to [MIN_ZOOM, MAX_ZOOM].
   */
  zoomMapBy(factor: number, anchor?: ScreenPosition): void {
    this.setMapCamera(
      zoomBy(this.mapCamera, factor, anchor ?? { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }),
    );
  }

  /** Restore the default full-map view (zoom 1, no pan). */
  resetMapView(): void {
    this.mapCamera = defaultMapCamera();
    this.notify();
    this.scheduleGlobalRefresh();
  }

  // ------------------------------------------------------------------
  // Step 16K/L: Global Map — viewport-aware global point loading
  // ------------------------------------------------------------------

  /**
   * Step 16L: Immediately refresh the global map using the CURRENT camera viewport
   * (not a blind 0..1). Bounded: one page of GLOBAL_MAP_PAGE_LIMIT points, at
   * most GLOBAL_MAP_MAX_PAGES pages via `nextCursor`. Distinguishes
   * loading/ok/empty/error states. Errors do NOT clear local points.
   */
  async refreshGlobalPoints(): Promise<void> {
    if (!this.deps.globalIndex) return;
    const epoch = ++this.globalRefreshEpoch;
    const bbox = cameraToViewportBBox(this.mapCamera);
    this.globalBBox = bbox;
    this.globalMapState = "loading";
    this.notify();

    const collected: GlobalMapPoint[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < GLOBAL_MAP_MAX_PAGES; page++) {
        const result = await this.deps.globalIndex.queryMapViewport({
          mapVersion,
          xMin: bbox.xMin,
          xMax: bbox.xMax,
          yMin: bbox.yMin,
          yMax: bbox.yMax,
          zoom: bbox.zoom,
          limit: GLOBAL_MAP_PAGE_LIMIT,
          cursor,
        });
        // A newer refresh superseded this one mid-flight — its result will
        // render; this stale response must not overwrite the newer viewport.
        if (epoch !== this.globalRefreshEpoch) return;
        collected.push(...result.points);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      if (epoch !== this.globalRefreshEpoch) return;
      this.globalPoints = collected;
      this.globalMapState = collected.length === 0 ? "empty" : "ok";
    } catch {
      if (epoch !== this.globalRefreshEpoch) return;
      // UNAVAILABLE: keep previous globalPoints; local map still works.
      this.globalMapState = "error";
    }
    this.notify();
  }

  /** Step 16L: debounced camera-driven global refresh (no request per pointermove). */
  scheduleGlobalRefresh(): void {
    if (this.globalRefreshDisposed) return;
    if (this.globalRefreshTimer !== undefined) {
      clearTimeout(this.globalRefreshTimer);
    }
    this.globalRefreshTimer = setTimeout(() => {
      this.globalRefreshTimer = undefined;
      void this.refreshGlobalPoints();
    }, GLOBAL_REFRESH_DEBOUNCE_MS);
  }

  /** Refresh global points immediately and cancel any pending debounce. */
  refreshGlobalPointsImmediate(): void {
    if (this.globalRefreshDisposed) return;
    if (this.globalRefreshTimer !== undefined) {
      clearTimeout(this.globalRefreshTimer);
      this.globalRefreshTimer = undefined;
    }
    void this.refreshGlobalPoints();
  }

  /**
   * Step 16K/L: Handle selection of a global-only map point.
   *
   * If the point corresponds to a local record, select it directly. Otherwise
   * load the canonical GLOBAL INSPECTION (Phase 2) via the existing content
   * identity lookup — this does NOT automatically run the analysis pipeline.
   */
  async selectGlobalPoint(point: MapPoint): Promise<void> {
    // Check if this point already exists locally.
    const localMatch = this.results.find(
      (r) => r.record.sampleId === point.sampleId,
    );
    if (localMatch) {
      this.selectSample(localMatch.record);
      return;
    }
    await this.inspectGlobalPoint(point);
  }

  /**
   * Step 16L Phase 2 — Global Inspection: load the canonical global analysis
   * for a global-only point WITHOUT running the local analysis pipeline.
   *
   * Uses the existing `GlobalLookup.lookupContentIdentities` path. No audio
   * fetch, no decode, no feature extraction, no classification.
   */
  async inspectGlobalPoint(point: MapPoint): Promise<void> {
    this.globalInspection = undefined;
    if (!this.deps.globalIndex) {
      return;
    }
    this.notify();

    let resolved = false;
    try {
      if (this.deps.resolveSample) {
        const sampleMeta = await this.deps.resolveSample(point.sampleId);
        if (sampleMeta) resolved = true;
      }
    } catch {
      resolved = false;
    }

    try {
      const hits = await this.deps.globalIndex.lookupContentIdentities([
        point.contentIdentity,
      ]);
      const hit = hits.find(
        (h) =>
          h.contentIdentity.contentHash === point.contentIdentity.contentHash &&
          h.contentIdentity.contentHashVersion ===
            point.contentIdentity.contentHashVersion,
      );
      if (!hit) {
        this.globalInspection = {
          point,
          analysis: undefined as unknown as GlobalAnalysisResult,
          sampleId: point.sampleId,
          resolved,
          error: "unknown",
        };
        this.notify();
        return;
      }
      this.globalInspection = {
        point,
        analysis: hit.analysis,
        sampleId: point.sampleId,
        resolved,
        error: undefined,
      };
    } catch {
      // UNAVAILABLE — distinguishable from unknown.
      this.globalInspection = {
        point,
        analysis: undefined as unknown as GlobalAnalysisResult,
        sampleId: point.sampleId,
        resolved,
        error: "unavailable",
      };
    }
    this.notify();
  }

  /**
   * Step 16L Phase 3 — Hydration: persist a global-only point's canonical
   * analysis into the LOCAL index so the existing SearchEngine can find it.
   *
   * Bounded: only EXPLICITLY selected points are hydrated (never the whole
   * global map). Idempotent at the sampleId level via `index.put`. Metadata is
   * best-effort from `resolveSample`; the content-level analysis is reused
   * verbatim. No audio bytes.
   *
   * Version defense (SM-AUDIT-004): the persisted `mapPosition` is copied
   * verbatim from the global analysis, so this never silently persists a
   * global record whose `map.mapVersion` is not the current V2 projection —
   * a stale/legacy (or missing) version is rejected, surfaced read-only, and
   * skipped. No V1 fallback, no fabricated V2 position.
   *
   * Returns true when the record was hydrated, false when skipped.
   */
  async hydrateGlobalSample(point: MapPoint, analysis: GlobalAnalysisResult): Promise<boolean> {
    if (!this.deps.index) return false;
    if (analysis.map?.mapVersion !== mapVersion) {
      if (this.globalInspection) this.globalInspection.error = "incompatible";
      this.notify();
      return false;
    }
    let meta: SampleMeta | undefined;
    try {
      if (this.deps.resolveSample) {
        meta = await this.deps.resolveSample(point.sampleId);
      }
    } catch {
      meta = undefined;
    }
    const { record } = buildRecordFromGlobalAnalysis(
      point.sampleId,
      meta,
      analysis,
      this.deps.analysisBuild,
    );
    await this.deps.index.put(record);
    await this.refreshSearch();
    // After hydration the selected sample should now exist locally.
    const local = this.results.find((r) => r.record.sampleId === point.sampleId);
    if (local) this.selectSample(local.record);
    this.notify();
    return true;
  }

  /**
   * Step 16L Phase 5 — Find Similar: run the existing `similarity-v1`
   * `findSimilar` over the LOCAL index using the SELECTED record's stored
   * content identity + similarity fingerprint. The selected record itself is
   * excluded (exact duplicate). Deterministic ordering, bounded limit.
   */
  async findSimilarForSelected(): Promise<void> {
    this.similarResults = [];
    this.similarRecords = [];
    this.similarError = undefined;
    const selected = this.focusedRecord;
    if (!selected) {
      this.similarError = "no sample selected";
      this.notify();
      return;
    }
    if (!this.deps.index) {
      this.similarError = "local index unavailable";
      this.notify();
      return;
    }
    if (!selected.contentHash || !selected.similarityFingerprint) {
      this.similarError = "selected sample has no similarity fingerprint";
      this.notify();
      return;
    }
    try {
      const records = await this.deps.index.getAll();
      const results = findSimilar({
        contentIdentity: {
          contentHash: selected.contentHash,
          contentHashVersion: selected.contentHashVersion ?? "unknown",
        },
        fingerprint: selected.similarityFingerprint,
        records,
        limit: 10,
      });
      this.similarResults = results;

      const byId = new Map(records.map((r) => [r.sampleId, r]));
      const resolved: SampleIndexRecord[] = [];
      for (const r of results) {
        const rec = byId.get(r.representativeSampleId);
        if (rec) resolved.push(rec);
      }
      this.similarRecords = resolved;
    } catch (e) {
      this.similarError = e instanceof Error ? e.message : String(e);
    }
    this.notify();
  }

  /**
   * STEP23 — V2 Find Similar (product search surface).
   *
   * Ranks the FOCUSED sample's `analysisV2.soundCharacter` against the whole
   * local index through the frozen STEP22 `rankSimilar` service (top-K =
   * `RANKING_DEFAULT_LIMIT`, self-exclusion, deterministic order, `null`
   * exclusion all come from `rankSimilar`). The result is a SNAPSHOT tied to
   * the focused sample at invoke time (§29/§30) — it is NEVER recomputed while
   * the surface is open, and later focus changes do not re-rank it.
   *
   * A focused record WITHOUT a valid V2 analysis yields an EMPTY state: the
   * record is never auto-analyzed (§47) and never fabricated. Ranking reads
   * persisted metadata only, so no audio/DSP/preview is fetched (§31).
   */
  async openFindSimilarV2(): Promise<void> {
    this.progressiveDisclosure.similarityV2Used = true;
    const focused = this.focusedRecord;
    this.similarityV2 = { ...emptySimilarityState(), open: true };

    if (!focused) {
      this.similarityV2.status = "empty";
      this.similarityV2.error = "Select a sample to find similar sounds.";
      this.notify();
      return;
    }
    if (!focused.analysisV2 || !resolveQueryCharacter(focused)) {
      this.similarityV2.status = "empty";
      this.similarityV2.error =
        "This sample has no V2 sound-character analysis yet.";
      this.notify();
      return;
    }
    if (!this.deps.index) {
      this.similarityV2.status = "error";
      this.similarityV2.error = "local index unavailable";
      this.notify();
      return;
    }
    try {
      const records = await this.deps.index.getAll();
      const ranked: SimilarityResult[] = rankSimilar(focused, records, {
        limit: RANKING_DEFAULT_LIMIT,
        includeSelf: false,
      });
      const byId = new Map(records.map((r) => [r.sampleId, r]));
      const results: SimilarityV2Row[] = [];
      for (const r of ranked) {
        const rec = byId.get(r.sampleId);
        if (rec) {
          results.push({
            sampleId: r.sampleId,
            record: rec,
            similarity: r.similarity,
            sharedDimensionCount: r.sharedDimensionCount,
          });
        }
      }
      this.similarityV2 = {
        open: true,
        status: "ready",
        querySampleId: focused.sampleId,
        queryName: focused.name,
        queryLimited: focused.analysisV2.quality.featureCoverage < 1,
        results,
        error: undefined,
      };
    } catch (e) {
      this.similarityV2 = {
        ...this.similarityV2,
        status: "error",
        results: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
    this.notify();
  }

  /**
   * STEP23 — close the V2 surface and DROP its snapshot entirely, so a later
   * reopen recomputes from the current focus and can never show stale rows.
   */
  closeFindSimilarV2(): void {
    this.similarityV2 = emptySimilarityState();
    this.notify();
  }

  /**
   * STEP24 — open the V2 Sound Space: capture an index snapshot and compute
   * the derived point set via the SoundSpaceProjector. Purely metadata-derived
   * (§§38-40): index snapshots only, no audio, no ranking, no network.
   *
   * Focus changes while the surface is OPEN never recompute coordinates
   * (§§45/46 — only the visual focus highlight follows the focus). Close drops
   * the point snapshot; reopen re-projects a fresh snapshot.
   */
  async openSoundSpace(): Promise<void> {
    this.soundSpace = { ...emptySoundSpaceState(), open: true };
    if (!this.deps.index) {
      this.soundSpace.status = "error";
      this.soundSpace.error = "local index unavailable";
      this.notify();
      return;
    }
    try {
      const records = await this.deps.index.getAll();
      const points = projectAll(this.soundSpaceProjector, records);
      const recordsById = new Map<string, SampleIndexRecord>();
      for (const r of records) recordsById.set(r.sampleId, r);
      if (points.length === 0) {
        this.soundSpace.status = "empty";
        this.soundSpace.error =
          "No analyzed samples in Sound Space yet.";
      } else {
        this.soundSpace.status = "ready";
        this.soundSpace.points = points;
      }
      this.soundSpace.recordsById = recordsById;
      this.notify();
    } catch (e) {
      this.soundSpace.status = "error";
      this.soundSpace.points = [];
      this.soundSpace.error = e instanceof Error ? e.message : String(e);
      this.notify();
    }
  }

  /**
   * STEP24 — close the Sound Space and drop its point snapshot; a later
   * reopen recomputes deterministically from the current index.
   */
  closeSoundSpace(): void {
    this.soundSpace = emptySoundSpaceState();
    this.notify();
  }

  /**
   * STEP24 — focus a sample by its id, resolving via the record registry
   * (same canonical focus/selection path the map and results list use).
   * No-ops for ids that are not known to the registry (e.g. hidden by the
   * currently active filter).
   */
  focusSampleById(sampleId: string): void {
    const record = this.knownRecords.get(sampleId);
    if (record) this.selectSample(record);
  }

  /**
   * STEP24 — a stable display name for a known sample, falling back to the
   * sample id while the record is not (yet) in the registry. Read-only; the
   * hero is the SoundCharacter, identity never moves a point (§57).
   */
  sampleNameFor(sampleId: string): string {
    return this.knownRecords.get(sampleId)?.name ?? sampleId;
  }

  /** STEP25 — preview for a known sample id, canonical to the focused path. */
  async togglePreviewById(sampleId: string): Promise<void> {
    const rec = this.knownRecords.get(sampleId);
    if (rec) await this.togglePreview(rec);
  }

  /** STEP25 — focus an id and then open Find Similar (STEP23-compatible). */
  async findSimilarForId(sampleId: string): Promise<void> {
    this.focusSampleById(sampleId);
    await this.openFindSimilarV2();
  }

  /** STEP25 — session-local Sound Space character filter (never persisted). */
  soundSpaceFilter: SoundSpaceCharFilter = {};
  /** STEP25 — the Compare surface state (derived from the selection). */
  soundSpaceCompare: SoundSpaceCompareState = { open: false, sampleIds: [] };

  /**
   * STEP25 — replace the Sound Space character filter. This is a pure
   * presentation preference, never persisted, never touches coordinates
   * (§26).
   */
  setSoundSpaceFilter(filter: SoundSpaceCharFilter): void {
    this.soundSpaceFilter = filter;
    this.notify();
  }

  /** STEP25 — reset the Sound Space filter to the identity (all-pass) one. */
  clearSoundSpaceFilter(): void {
    this.soundSpaceFilter = {};
    this.notify();
  }

  /**
   * STEP25 — open the Compare surface for the current batch selection.
   * Compare uses the existing selection only; it does NOT mutate it. The
   * snapshot is capped at 4 samples (§15). Calling with fewer than 2 selected
   * samples keeps the state closed.
   */
  openSoundSpaceCompare(): void {
    const ids = this.selectedSampleIds.slice(0, 4);
    if (ids.length < 2) return;
    this.soundSpaceCompare = { open: true, sampleIds: ids };
    this.notify();
  }

  /** STEP25 — close the Compare surface; selection remains untouched. */
  closeSoundSpaceCompare(): void {
    this.soundSpaceCompare = { open: false, sampleIds: [] };
    this.notify();
  }

  // ------------------------------------------------------------------
  // STEP26 — V2 Discovery (orchestration over the frozen V1/V2 systems)
  // ------------------------------------------------------------------

  /**
   * STEP26 — open the Discovery surface and re-run with the retained
   * session-local criteria (draft text + shared Sound Space filter + pinned
   * reference). With no criterion active the surface sits in the `idle` hint
   * state ("Find a sound") without inventing a browse-order.
   */
  async openDiscovery(): Promise<void> {
    this.progressiveDisclosure.discoveryUsed = true;
    this.discovery = { ...this.discovery, open: true };
    this.notify();
    await this.runDiscovery();
  }

  /** STEP26 — close the Discovery surface; criteria stay on the session. */
  closeDiscovery(): void {
    this.discovery = { ...this.discovery, open: false };
    this.notify();
  }

  /** STEP26 — update the un-submitted draft text (run() commits it). */
  setDiscoveryTextDraft(text: string): void {
    this.discoveryTextDraft = text;
    this.notify();
  }

  /**
   * STEP26 — pin the FOCUSED sample as the discovery reference. Only the id is
   * recorded (no record copy); the reference is stable until "Clear reference".
   * Focus/selection are untouched. With nothing focused the surface reports the
   * "Select a sample to use as a reference." empty state.
   */
  useFocusedSampleAsReference(): void {
    const focused = this.focusedSampleId;
    if (focused === null) {
      this.discovery = {
        ...this.discovery,
        status: "empty",
        error: "Select a sample to use as a reference.",
        results: [],
      };
      this.notify();
      return;
    }
    this.discovery = { ...this.discovery, referenceSampleId: focused, error: undefined };
    this.notify();
  }

  /**
   * STEP26 — clear the reference. Sets ONLY `referenceSampleId` to undefined —
   * focus and selection are deliberately untouched (the user can keep browsing).
   */
  clearDiscoveryReference(): void {
    if (this.discovery.referenceSampleId === undefined) return;
    this.discovery = { ...this.discovery, referenceSampleId: undefined };
    this.notify();
  }

  /**
   * STEP26 — submit the current draft text + shared Sound Space filter +
   * reference through the frozen discovery core. The result snapshot is
   * session-local and never persisted; DISCOVERY itself is read-only (it never
   * auto-analyzes, never triggers audio, never mutates the index).
   */
  async runDiscovery(): Promise<void> {
    const text = this.discoveryTextDraft.trim();
    const filter = this.soundSpaceFilter;
    const hasFilter = isFilterActive(filter);
    const reference = this.discovery.referenceSampleId;
    const hasReference = reference !== undefined && reference.length > 0;
    const hasCriterion = text.length > 0 || hasFilter || hasReference;

    this.discovery = {
      ...this.discovery,
      open: true,
      status: hasCriterion ? "running" : "idle",
      error: undefined,
      results: [],
    };
    if (!hasCriterion) {
      this.notify();
      return;
    }
    if (!this.deps.index) {
      this.discovery.status = "error";
      this.discovery.error = "Local sample index unavailable.";
      this.notify();
      return;
    }

    try {
      const records = await this.deps.index.getAll();
      const refRecord =
        reference !== undefined
          ? (records.find((r) => r.sampleId === reference) ?? this.knownRecords.get(reference))
          : undefined;
      const referenceAvailable = refRecord !== undefined && resolveQueryCharacter(refRecord) !== undefined;

      // Reference-only discovery with an unavailable reference: a data-backed
      // empty state — the user is told to pick a usable reference sample.
      if (reference !== undefined && !referenceAvailable && !text.length && !hasFilter) {
        this.discovery.status = "empty";
        this.discovery.error = "Select a sample to use as a reference.";
        this.notify();
        return;
      }

      const query: DiscoveryQuery = {};
      if (text.length) query.text = text;
      if (hasFilter) query.characterFilter = filter;
      if (reference !== undefined) query.referenceSampleId = reference;

      const rows = await discoverSamples(query, records, { search: this.deps.search });

      const recordsById = new Map<string, SampleIndexRecord>();
      for (const r of records) recordsById.set(r.sampleId, r);
      const results: DiscoveryRowView[] = rows.map((row) => ({
        sampleId: row.sampleId,
        record: recordsById.get(row.sampleId) ?? this.knownRecords.get(row.sampleId)!,
        score: row.score,
        label: row.label,
        reasons: row.reasons,
        searchScore: row.searchScore,
        similarity: row.similarity,
        distance: row.distance,
        sharedDimensionCount: row.sharedDimensionCount,
      }));
      // Registry: result rows are focusable/selectable/previewable even when
      // they are not in the global search results (never a hard filter change).
      for (const row of results) this.knownRecords.set(row.sampleId, row.record);

      this.discovery.results = results;
      this.discovery.status = results.length === 0 ? "empty" : "ready";
      this.discovery.error = results.length === 0 ? "No matching sounds found." : undefined;
      this.notify();
    } catch (e) {
      this.discovery.status = "error";
      this.discovery.results = [];
      this.discovery.error = e instanceof Error ? e.message : String(e);
      this.notify();
    }
  }

  /**
   * STEP26 — the sampleIds highlighted in the Sound Space by the LAST discovery
   * result. Read-only; a highlight NEVER recomputes or moves a point (the
   * projector coordinates stay frozen — the highlight is purely a blot-style
   * visual signal on top of the existing points).
   */
  get discoveryHighlightedSampleIds(): ReadonlySet<string> {
    if (!this.discovery.open || this.discovery.status !== "ready") return new Set();
    return new Set(this.discovery.results.map((r) => r.sampleId));
  }

  // ------------------------------------------------------------------
  // STEP27 — V2 Sound Collections (session-local, user-curated)
  // ------------------------------------------------------------------

  /**
   * STEP27 — add a sample to the Collection. ONLY the collection changes:
   * focus, selection, preview, search, Discovery results and the Sound Space
   * filter are untouched. `record` (when the caller has it) is registered so
   * the member is resolvable/focusable/previewable; availability is still
   * decided against the CURRENT index snapshot. Duplicate-safe and capped at
   * COLLECTION_MAX_SAMPLES by the pure boundary.
   */
  async addToCollection(sampleId: string, record?: SampleIndexRecord): Promise<void> {
    if (record) this.knownRecords.set(record.sampleId, record);
    const wasMember = collectionContains(this.collection, sampleId);
    const wasFull = isCollectionFull(this.collection);
    this.collection = addToCollection(this.collection, sampleId);
    // STEP32 P1 — the first genuine add reveals the My Sounds/Collections
    // surface. This is the canonical add path used by every "Add" control
    // (Results, Discovery, Sound Space), so adding a sound always surfaces the
    // home for it. A duplicate re-add or a cap no-op does not re-trigger.
    if (!wasMember && !wasFull) {
      this.progressiveDisclosure.collectionManagerUsed = true;
    }
    this.collectionDirty = true;
    await this.refreshCollectionKnownIds();
    this.notify();
  }

  /** STEP27 — remove a member from the Collection (only the collection changes). */
  async removeFromCollection(sampleId: string): Promise<void> {
    this.collection = removeFromCollection(this.collection, sampleId);
    this.collectionDirty = true;
    this.notify();
  }

  /**
   * STEP27 — toggle membership (add when absent — cap-still-applying — remove
   * when present). Only the collection changes.
   */
  async toggleCollectionSample(sampleId: string, record?: SampleIndexRecord): Promise<void> {
    if (record && !this.knownRecords.has(record.sampleId)) {
      this.knownRecords.set(record.sampleId, record);
    }
    this.collection = toggleCollectionSample(this.collection, sampleId);
    this.collectionDirty = true;
    await this.refreshCollectionKnownIds();
    this.notify();
  }

  /** STEP27 — empty the collection. Nothing else observes this action. */
  async clearCollection(): Promise<void> {
    this.collection = clearCollection(this.collection);
    this.collectionDirty = true;
    this.notify();
  }

  /** STEP27 — open the Collection panel; availability is re-synced. */
  async openCollection(): Promise<void> {
    this.collection = { ...this.collection, open: true };
    await this.refreshCollectionKnownIds();
    this.notify();
  }

  /** STEP27 — close the Collection panel (and its Compare surface). */
  closeCollection(): void {
    this.collection = { ...this.collection, open: false };
    this.collectionCompare = { open: false, sampleIds: [] };
    this.notify();
  }

  /** Read-only membership test (used by render + view-models). */
  isCollectionMember(sampleId: string): boolean {
    return this.collection.sampleIds.includes(sampleId);
  }

  /**
   * STEP27 — public registry lookup used by render for stale-member and
   * multiply-reachable rows (Focus/Preview/Add shortcuts). Read-only.
   */
  recordForSample(sampleId: string): SampleIndexRecord | undefined {
    return this.knownRecords.get(sampleId);
  }

  /**
   * STEP27 — the Collection member rows, in explicit insertion order. Members
   * whose record is missing from the CURRENT index stay listed as
   * "Unavailable sample" (never dropped, never crashing — §27/§28).
   */
  get collectionMembers(): CollectionMemberView[] {
    return this.collection.sampleIds.map((sampleId) => {
      const record = this.knownRecords.get(sampleId);
      const available = this.collectionKnownIds.has(sampleId) && record !== undefined;
      return { sampleId, record: available ? record : undefined, available };
    });
  }

  /**
   * STEP27 — arithmetic-mean character summary over the AVAILABLE members'
   * PRESENT SoundCharacter values (nulls ignored; a dim with values nowhere in
   * the collection is null → "—"). Pure metadata, O(8N), never a new metric.
   */
  get collectionSummary(): SoundCharacterSummary | null {
    const records = this.collectionMembers
      .map((m) => m.record)
      .filter((r): r is SampleIndexRecord => r !== undefined);
    return summarizeCollection(records);
  }

  /**
   * STEP27 — open the Compare surface over the collection: <2 samples keeps it
   * closed; 2–4 compares all; >4 compares the first 4 IN EXPLICIT COLLECTION
   * ORDER. The collection and the batch selection are never mutated by this.
   */
  openCollectionCompare(): void {
    const ids = this.collection.sampleIds.slice(0, 4);
    if (ids.length < 2) return;
    this.collectionCompare = { open: true, sampleIds: ids };
    this.notify();
  }

  /** STEP27 — close the Collection Compare surface; collection untouched. */
  closeCollectionCompare(): void {
    this.collectionCompare = { open: false, sampleIds: [] };
    this.notify();
  }

  /** STEP27 — row metadata of the Collection Compare surface (mirrors the
   *  Sound Space Compare getter; resolved through the same registry). */
  get collectionCompareCharacters(): {
    id: string;
    name: string;
    character: SoundCharacter | null;
  }[] {
    if (!this.collectionCompare.open) return [];
    return this.collectionCompare.sampleIds.map((id) => {
      const rec = this.knownRecords.get(id);
      const char = rec?.analysisV2?.soundCharacter ?? null;
      return { id, name: this.sampleNameFor(id), character: char };
    });
  }

  /**
   * STEP27 — EXPLICIT "Select All": replace the batch selection with the
   * collection, in collection order, bounded by the existing MAX_BATCH_SLOTS()
   * (the collection can hold up to 50; the batch sends at most 8). Uses the
   * EXISTING `selectedSampleIds` field — no parallel selection logic. Focus,
   * preview, Discovery and filters are untouched. Never automatic.
   */
  selectCollection(): void {
    this.selectedSampleIds = this.collection.sampleIds.slice(0, MAX_BATCH_SLOTS);
    this.notify();
  }

  // ------------------------------------------------------------------
  // STEP28 — Persistent Sound Collections (lifecycle, §23–§45)
  // ------------------------------------------------------------------

  /** STEP28 — the working set is dirty iff it differs from the ACTIVE saved
   *  collection (name + membership) OR there is no active saved collection
   *  yet and the working set is non-empty / renamed from default. Mirrors
   *  §44: dirty shows the trailing `*`. A FAILED save keeps it true (§26). */
  private recomputeCollectionDirty(active: PersistedSoundCollection | null): void {
    if (active === null) {
      this.collectionDirty =
        this.collection.sampleIds.length > 0 ||
        this.collectionName !== DEFAULT_COLLECTION_NAME;
      return;
    }
    this.collectionDirty =
      this.collectionName !== active.name ||
      !(this.collection.sampleIds.length === active.sampleIds.length &&
        this.collection.sampleIds.every((id, i) => id === active.sampleIds[i]));
  }

  /**
   * STEP28 — open the persistent collection manager and list the stored
   * collections. Invalid rows are surfaced honestly (never silently dropped);
   * a list failure sets the honest error state (never a fake empty list).
   */
  async openCollectionManager(): Promise<void> {
    this.progressiveDisclosure.collectionManagerUsed = true;
    this.collectionManager = {
      ...this.collectionManager,
      open: true,
      listStatus: "loading",
      listError: undefined,
    };
    this.notify();
    if (!this.deps.collectionStore) {
      this.collectionManager = {
        ...this.collectionManager,
        open: true,
        listStatus: "error",
        listError: "Collection persistence is unavailable in this session.",
        entries: [],
      };
      this.notify();
      return;
    }
    try {
      const rows = await this.deps.collectionStore.list();
      this.collectionManager = {
        ...this.collectionManager,
        open: true,
        listStatus: "loaded",
        listError: undefined,
        entries: rows.map((row) =>
          row.ok
            ? {
                id: row.collection.id,
                name: row.collection.name,
                active: row.collection.id === this.activeCollectionId,
                invalid: undefined,
              }
            : {
                id: row.invalid.id ?? "(unknown id)",
                name: row.invalid.kind === "unsupported-version"
                  ? `Unsupported version (${row.invalid.unknownVersion})`
                  : "Corrupt collection",
                active: false,
                invalid: row.invalid,
              },
        ),
      };
    } catch (e) {
      this.collectionManager = {
        ...this.collectionManager,
        open: true,
        listStatus: "error",
        listError: e instanceof Error ? e.message : String(e),
        entries: this.collectionManager.entries,
      };
    }
    this.notify();
  }

  closeCollectionManager(): void {
    this.collectionManager = {
      ...this.collectionManager,
      open: false,
      confirm: undefined,
    };
    this.notify();
  }

  /** STEP28 — update the working-set name DRAFT (commit via renameCollection). */
  setCollectionNameDraft(draft: string): void {
    this.collectionManager = { ...this.collectionManager, nameDraft: draft };
  }

  /**
   * STEP28 — create a NEW working collection (§24): fresh id (unpersisted),
   * empty membership, default name, stays dirty until saved. NEVER touches the
   * index/library. Only the working set changes — focus/selection/preview/
   * filters/Discovery are untouched.
   */
  createNewCollection(): void {
    this.collection = emptyCollectionState();
    this.collectionName = DEFAULT_COLLECTION_NAME;
    this.activeCollectionId = null;
    this.collectionDirty = false;
    this.collectionSaveError = undefined;
    this.collectionManager = {
      ...this.collectionManager,
      nameDraft: DEFAULT_COLLECTION_NAME,
      loadError: undefined,
      deleteError: undefined,
      confirm: undefined,
    };
    this.notify();
  }

  /**
   * STEP28 — rename the working collection (§11/§25). Revalidates the name via
   * the pure boundary (trim, non-empty, ≤100 code points). It marks the set
   * dirty (so Save persists the rename); a failed save keeps it dirty.
   */
  renameCollection(raw: string): void {
    const name = normalizeCollectionName(raw);
    if (name === null) {
      this.collectionDirty = true;
      this.collectionSaveError =
        "Collection name must be non-empty and at most 100 characters.";
      this.notify();
      return;
    }
    if (name === this.collectionName) {
      this.collectionManager = { ...this.collectionManager, nameDraft: name };
      this.notify();
      return;
    }
    this.collectionName = name;
    this.collectionManager = { ...this.collectionManager, nameDraft: name };
    this.collectionDirty = true;
    this.notify();
  }

  /**
   * STEP28 — SAVE the working set to the ACTIVE persisted collection (§26).
   * On failure the working set is UNCHANGED, `dirty` stays true, the error is
   * surfaced and a retry is allowed. `updatedAt` advances only after a SUCCESS
   * (§45). With no active collection, Save behaves as Save-As.
   */
  async saveCollection(): Promise<void> {
    if (this.collectionSaving) return;
    if (!this.deps.collectionStore) {
      this.collectionSaveError = "Collection persistence is unavailable in this session.";
      this.collectionDirty = true;
      this.notify();
      return;
    }
    this.collectionSaving = true;
    this.collectionSaveError = undefined;
    this.notify();
    try {
      const patch = {
        name: this.collectionName,
        sampleIds: [...this.collection.sampleIds],
      };
      if (this.activeCollectionId !== null) {
        const existing = await this.deps.collectionStore.get(this.activeCollectionId);
        if (existing === undefined) {
          throw new Error(
            `Active collection "${this.activeCollectionId}" no longer exists. Use Save As to create a new collection.`,
          );
        }
        if (!existing.ok) {
          throw new Error(
            `Active collection is unreadable: ${existing.invalid.reason}`,
          );
        }
        const updated = withUpdatedCollection(existing.collection, patch);
        await this.deps.collectionStore.put(updated);
        this.recomputeCollectionDirty(updated);
      } else {
        const created = createPersistedCollection(patch);
        await this.deps.collectionStore.put(created);
        this.activeCollectionId = created.id;
        this.collectionDirty = false;
      }
      this.collectionManager = { ...this.collectionManager, confirm: undefined };
    } catch (e) {
      // §26 — a failed save leaves the working set unchanged and dirty.
      this.collectionSaveError = e instanceof Error ? e.message : String(e);
      this.collectionDirty = true;
    } finally {
      this.collectionSaving = false;
      this.notify();
    }
  }

  /**
   * STEP28 — SAVE AS: persist the working set as a NEW collection with a fresh
   * id, preserving member ORDER (§27). Never silently overwrites; the loaded
   * target stays active afterward.
   */
  async saveCollectionAs(): Promise<void> {
    if (this.collectionSaving) return;
    if (!this.deps.collectionStore) {
      this.collectionSaveError = "Collection persistence is unavailable in this session.";
      this.collectionDirty = true;
      this.notify();
      return;
    }
    this.collectionSaving = true;
    this.collectionSaveError = undefined;
    this.notify();
    try {
      const created = createPersistedCollection({
        name: this.collectionName,
        sampleIds: [...this.collection.sampleIds],
      });
      await this.deps.collectionStore.put(created);
      this.activeCollectionId = created.id;
      this.collectionDirty = false;
      this.collectionManager = { ...this.collectionManager, confirm: undefined };
    } catch (e) {
      this.collectionSaveError = e instanceof Error ? e.message : String(e);
      this.collectionDirty = true;
    } finally {
      this.collectionSaving = false;
      this.notify();
    }
  }

  /**
   * STEP28 — LOAD a persisted collection into the working set (§28/§36).
   * Restores ONLY name + ordered ids; NEVER restores selection/preview/focus/
   * filter/Discovery/Sound Space/Machiniste batch/playback and NEVER triggers
   * reanalysis/reprojection. Stale ids are re-resolved against the CURRENT
   * index and degrade honestly (§36). Loading destroys the previous unsaved
   * working set, so it is only offered when NOT dirty (the manager Singleton
   * guards this via the confirm dialog).
   */
  async loadCollection(id: string): Promise<void> {
    this.collectionManager = { ...this.collectionManager, loadError: undefined };
    if (!this.deps.collectionStore) {
      this.collectionManager = {
        ...this.collectionManager,
        loadError: "Collection persistence is unavailable in this session.",
      };
      this.notify();
      return;
    }
    try {
      const row = await this.deps.collectionStore.get(id);
      if (row === undefined) {
        this.collectionManager = {
          ...this.collectionManager,
          loadError: `Collection "${id}" no longer exists.`,
        };
        this.notify();
        return;
      }
      if (!row.ok) {
        this.collectionManager = {
          ...this.collectionManager,
          loadError: `Cannot load collection: ${row.invalid.reason}`,
        };
        this.notify();
        return;
      }
      this.collection = {
        ...emptyCollectionState(),
        open: true,
        sampleIds: [...row.collection.sampleIds],
      };
      this.collectionName = row.collection.name;
      this.activeCollectionId = row.collection.id;
      this.collectionDirty = false;
      this.collectionSaveError = undefined;
      await this.refreshCollectionKnownIds();
      this.collectionManager = {
        ...this.collectionManager,
        nameDraft: row.collection.name,
        confirm: undefined,
      };
    } catch (e) {
      this.collectionManager = {
        ...this.collectionManager,
        loadError: e instanceof Error ? e.message : String(e),
      };
    }
    this.notify();
  }

  /** STEP28 — the current working set member-array (for save/load comparisons). */
  private get currentMemberIds(): string[] {
    return [...this.collection.sampleIds];
  }

  /**
   * STEP28 — switch the active collection. Follows the explicit dirty policy
   * (§30): dims are Saved / Discarded / Cancel. Save reuses saveCollection;
   * Discard drops the unsaved edits and loads the target; Cancel does nothing.
   */
  requestSwitchCollection(id: string, name: string): void {
    if (this.collectionDirty) {
      this.collectionManager = {
        ...this.collectionManager,
        confirm: { kind: "switch", targetId: id, targetName: name },
      };
      this.notify();
      return;
    }
    void this.loadCollection(id);
  }

  /** Save (persist edits) then switch to the pending target. */
  async confirmSaveThenSwitch(): Promise<void> {
    const target = this.collectionManager.confirm;
    if (target?.kind !== "switch") return;
    this.collectionManager = { ...this.collectionManager, confirm: undefined };
    await this.saveCollection();
    if (this.collectionDirty) return; // Save failed; stay on the working set.
    await this.loadCollection(target.targetId);
  }

  /** Discard unsaved edits and switch to the pending target (§30). */
  async confirmDiscardThenSwitch(): Promise<void> {
    const target = this.collectionManager.confirm;
    if (target?.kind !== "switch") return;
    await this.loadCollection(target.targetId);
  }

  cancelSwitch(): void {
    if (this.collectionManager.confirm?.kind === "switch") {
      this.collectionManager = { ...this.collectionManager, confirm: undefined };
      this.notify();
    }
  }

  /**
   * STEP28 — explicit delete confirmation (§31): never silent. Confirms the
   * "collection deleted, samples NOT deleted" messaging before removing the
   * reference document only. NEVER touches the index/library/analysis/Sound
   * Space/Discovery/Search/Machiniste.
   */
  requestDeleteCollection(id: string, name: string): void {
    this.collectionManager = {
      ...this.collectionManager,
      confirm: { kind: "delete", id, name },
    };
    this.notify();
  }

  async confirmDeleteCollection(): Promise<void> {
    const c = this.collectionManager.confirm;
    if (c?.kind !== "delete") return;
    this.collectionManager = {
      ...this.collectionManager,
      confirm: undefined,
      deleteError: undefined,
    };
    if (!this.deps.collectionStore) {
      this.collectionManager = {
        ...this.collectionManager,
        deleteError: "Collection persistence is unavailable in this session.",
      };
      this.notify();
      return;
    }
    try {
      await this.deps.collectionStore.delete(c.id);
      // If we deleted the active collection, the working set reverts to an
      // unpersisted draft (never left pointing at a deleted id).
      if (this.activeCollectionId === c.id) {
        this.activeCollectionId = null;
        this.collectionDirty = this.currentMemberIds.length > 0;
        this.collectionSaveError = undefined;
      }
      await this.openCollectionManager();
    } catch (e) {
      // A failed delete keeps the collection and surfaces the honest error.
      this.collectionManager = {
        ...this.collectionManager,
        deleteError: e instanceof Error ? e.message : String(e),
      };
    }
  }

  cancelDeleteCollection(): void {
    if (this.collectionManager.confirm?.kind === "delete") {
      this.collectionManager = { ...this.collectionManager, confirm: undefined };
      this.notify();
    }
  }

  /** STEP28 — persist the working set immediately when a name edit blurs. */
  onCollectionNameCommitted(): void {
    if (this.collectionDirty && this.activeCollectionId !== null && this.deps.collectionStore) {
      void this.saveCollection();
    }
  }

  /**
   * STEP25 — one entry of the Compare view (row). Pure metadata: name +
   * SoundCharacter (read through SoundCharacter, never compared to a 0)
   * for every focusable dimension (canonical 8).
   */
  get soundSpaceCompareCharacters(): {
    id: string;
    name: string;
    character: SoundCharacter | null;
  }[] {
    if (!this.soundSpaceCompare.open) return [];
    return this.soundSpaceCompare.sampleIds.map((id) => {
      const rec = this.knownRecords.get(id);
      const char = rec?.analysisV2?.soundCharacter ?? null;
      return { id, name: this.sampleNameFor(id), character: char };
    });
  }

  /**
   * FOCUS (single click). Sets the single focused/inspected sample. This DOES
   * NOT modify the batch selection — focus and selection are independent. When
   * focus changes, a running preview of the previous sample is stopped (one
   * active player at a time). No-op when the focused sample is unchanged.
   */
  selectSample(record: SampleIndexRecord | undefined): void {
    const nextId = record?.sampleId ?? null;
    if (nextId === this.focusedSampleId && record) return;
    // SM-AUDIT-007: any in-flight preview fetch for a previous sample that
    // resolves after this focus change must be discarded (see togglePreview).
    this.previewEpoch++;
    if (this.previewSampleId !== undefined) {
      this.previewHandleValue?.stop();
      this.previewHandleValue = undefined;
      this.previewSampleId = undefined;
      this.previewError = undefined;
    }
    this.focusedSampleId = nextId;
    if (record) {
      this.knownRecords.set(record.sampleId, record);
      // STEP32 P0 — focusing a real sample makes Find Similar discoverable.
      // This is the single canonical focus path (map point, result row,
      // discovery result, Sound Space point, global point hydration), so every
      // focus reveals the similarity surface without any opaque switch.
      this.progressiveDisclosure.similarityV2Used = true;
    }
    this.notify();
  }

  /**
   * E-P5A T4 — ADDITIVE keyboard point navigation. Moves the single FOCUS
   * (`focusedSampleId`) along the current, already-filtered result order —
   * the same local records the map renders (global-only points have no local
   * record and cannot be focused). Selection, camera, search and filters are
   * untouched: focus always stays independent of the batch selection
   * (§17.1/§28) and arrow keys never create a selection. When nothing is
   * focused yet, a positive delta enters at the first result and a negative
   * delta at the last; movement wraps at both ends; no results = no-op.
   */
  focusAdjacent(delta: 1 | -1): void {
    const records = this.results.map((r) => r.record);
    if (records.length === 0) return;
    const current = this.focusedSampleId;
    const idx =
      current === null ? -1 : records.findIndex((r) => r.sampleId === current);
    const next =
      idx === -1
        ? records[delta > 0 ? 0 : records.length - 1]
        : records[(idx + delta + records.length) % records.length];
    this.selectSample(next);
  }

  /**
   * SELECTION (Cmd/Ctrl-click). Toggles `record` in the batch selection
   * (capped at MAX_BATCH_SLOTS — attempting to add an 8th+ leaves the existing
   * selection unchanged) AND focuses it, matching the Cmd/Ctrl-click semantics
   * of the finalized UI (focus the clicked sample + toggle it in the selection).
   * The cap is checked BEFORE mutating the selection and the render is always
   * notified, so the DOM checkbox always agrees with `selectedSampleIds` even
   * when the click hits the cap (BUG #2 / STEP16V).
   */
  toggleMultiSelect(record: SampleIndexRecord): void {
    this.knownRecords.set(record.sampleId, record);
    this.focusedSampleId = record.sampleId;
    const idx = this.selectedSampleIds.indexOf(record.sampleId);
    if (idx >= 0) {
      this.selectedSampleIds.splice(idx, 1);
    } else if (this.selectedSampleIds.length < MAX_BATCH_SLOTS) {
      this.selectedSampleIds.push(record.sampleId);
    }
    this.notify();
  }

  /**
   * SELECTION (FINAL_UI_UX_DESIGN_SPEC §17.5 / §28.1): clear the ENTIRE batch
   * selection (e.g. the action-bar `Clear all` or the terminal `Esc` action).
   * This touches ONLY selection — focus, preview, search and filters are
   * deliberately unaffected (Esc never clears search/filters). Selecting the
   * next sample starts from 0 again; the cap (MAX_BATCH_SLOTS) is not reset.
   */
  clearSelection(): void {
    if (this.selectedSampleIds.length === 0) return;
    this.selectedSampleIds = [];
    this.notify();
  }

  // ------------------------------------------------------------------
  // Preview (§8) — Delegates the whole lifecycle to PreviewService
  // ------------------------------------------------------------------

  async togglePreview(record: SampleIndexRecord): Promise<void> {
    // SM-AUDIT-007: every preview intent invalidates previously in-flight
    // fetches (generation/token semantics), guarding stale async completions.
    const epoch = ++this.previewEpoch;
    if (this.previewSampleId === record.sampleId && this.previewHandleValue) {
      this.previewHandleValue.stop();
      this.previewHandleValue = undefined;
      this.previewSampleId = undefined;
      this.previewError = undefined;
      this.notify();
      return;
    }
    let url = this.deps.previewUrlFor(record);
    // STEP36 — lazy runtime preview metadata resolution. The persisted index
    // record carries NO preview URL (audio/storage policy); the URL lives only
    // in the live sample metadata, which the browser resolves via
    // `client.samples.get(sampleId)` (through the `resolveSample` seam). After
    // a reload (stale runtime cache) or for samples whose metadata was never
    // loaded this session, resolve it on demand BEFORE declaring the sample
    // un-previewable. The URL is kept only transiently in the runtime
    // metadata cache — never persisted, never an audio cache.
    if (!url && this.deps.resolveSample) {
      let meta: SampleMeta | undefined;
      try {
        meta = await this.deps.resolveSample(record.sampleId);
      } catch {
        // Case E — metadata request failed: controlled error, no crash.
        if (epoch === this.previewEpoch) {
          this.previewError = "preview metadata unavailable";
          this.previewSampleId = undefined;
          this.notify();
        }
        return;
      }
      // SM-AUDIT-007 — the user moved on (focus/selection changed, another
      // preview started) while metadata was resolving: discard silently.
      if (epoch !== this.previewEpoch) {
        this.notify();
        return;
      }
      if (meta === undefined) {
        // Metadata not resolvable for this sample: honest controlled state.
        this.previewError = "preview metadata unavailable";
        this.previewSampleId = undefined;
        this.notify();
        return;
      }
      url = this.deps.previewUrlFor(record);
    }
    if (!url) {
      this.previewError = "no preview url available";
      this.previewSampleId = undefined;
      this.notify();
      return;
    }
    this.previewError = undefined;
    if (this.previewSampleId !== undefined) {
      this.previewHandleValue?.stop();
      this.previewHandleValue = undefined;
    }
    try {
      const handle = await this.deps.preview.preview(record.sampleId, url);
      // SM-AUDIT-007: the fetch resolved after the user moved on (selection
      // changed / another preview started / revoked). Discard it immediately —
      // stop() revokes the ObjectURL; play() is never called.
      if (epoch !== this.previewEpoch) {
        handle.stop();
        return;
      }
      this.previewHandleValue = handle;
      this.previewSampleId = record.sampleId;
      // SM-AUDIT-006: start actual audio playback.
      void handle.play();
    } catch (e) {
      if (epoch === this.previewEpoch) {
        this.previewError = e instanceof Error ? e.message : String(e);
        this.previewSampleId = undefined;
      }
    }
    this.notify();
  }

  revokeCurrentPreview(): void {
    // SM-AUDIT-007: also invalidate in-flight fetches on revoke.
    this.previewEpoch++;
    this.previewHandleValue?.stop();
    this.previewHandleValue = undefined;
    this.previewSampleId = undefined;
    this.notify();
  }

  // ------------------------------------------------------------------
  // Send to Machiniste (§10 / §11) — delegates to MachinisteService only
  // ------------------------------------------------------------------

  /**
   * Send the EXPLICIT SELECTION to a Machiniste (FINAL_UI_UX_DESIGN_SPEC §8.9).
   * Only samples in `selectedSampleIds` (0..MAX_BATCH_SLOTS) are sent, mapped
   * sample[i] -> slotStart+i. Focus alone is NOT sufficient — if there is no
   * selection this reports "no sample selected" and sends nothing. Delegates
   * entirely to MachinisteService.send().
   *
   * STEP19A E-P7 (FINAL_UI_UX_DESIGN_SPEC §19.5 "Usage-acceptance gate"): the
   * FIRST send is a one-time consent gate. When consent is not yet granted the
   * send is NOT performed; the controller raises the consent dialog
   * (`ep7ConsentRequired`) and suspends this exact call. It resumes exactly
   * once on `grantEp7Consent()` and is dropped on `denyEp7Consent()`. Consent
   * is explicit only — never inferred from authentication, session, or any
   * previous operation, and never auto-granted.
   */
  async sendToMachiniste(machinisteId: string, slotStart = 0): Promise<void> {
    if (this.selectedRecords.length === 0) {
      this.machiniste.error = "no sample selected";
      this.machiniste.lastResult = undefined;
      this.notify();
      return;
    }
    // A dialog is already showing: ignore repeat triggers (no stack of sends).
    if (this.ep7ConsentRequired) return;
    if (this.consentStore.isGranted()) {
      await this.performMachinisteSend(machinisteId, slotStart);
      return;
    }
    this.pendingMachinisteSend = { machinisteId, slotStart };
    this.ep7ConsentRequired = true;
    this.ep7ConsentError = undefined;
    this.notify();
  }

  /**
   * STEP19A E-P7 — explicit acceptance of the one-time usage-acceptance gate.
   * Persists the consent preference, closes the dialog and resumes the
   * suspended send EXACTLY once. When no send is pending this only persists
   * the preference (idempotent). If the persistence write fails the consent is
   * NOT granted and the dialog stays up with an error — the action never runs
   * on an unstored consent.
   */
  grantEp7Consent(): void {
    try {
      this.consentStore.grant();
    } catch (e) {
      this.ep7ConsentError =
        `consent could not be stored: ${e instanceof Error ? e.message : String(e)}`;
      this.notify();
      return;
    }
    const pending = this.pendingMachinisteSend;
    this.pendingMachinisteSend = undefined;
    this.ep7ConsentRequired = false;
    this.ep7ConsentError = undefined;
    if (pending) {
      void this.performMachinisteSend(pending.machinisteId, pending.slotStart);
    }
    this.notify();
  }

  /**
   * STEP19A E-P7 — cancel/close the consent dialog. The guarded send is
   * dropped (zero continuation) and no consent is persisted; the user may
   * retry the action and receive the dialog again.
   */
  denyEp7Consent(): void {
    if (!this.ep7ConsentRequired) return;
    this.pendingMachinisteSend = undefined;
    this.ep7ConsentRequired = false;
    this.ep7ConsentError = undefined;
    this.notify();
  }

  /**
   * The actual send (selection→slots→MachinisteService→usage-acceptance).
   * Always reached through the E-P7 gate above (immediate when consent is
   * already granted, once on explicit acceptance, never on cancel).
   */
  private async performMachinisteSend(
    machinisteId: string,
    slotStart: number,
  ): Promise<void> {
    const pool = this.selectedRecords;
    if (pool.length === 0) {
      this.machiniste.error = "no sample selected";
      this.machiniste.lastResult = undefined;
      this.notify();
      return;
    }
    const batch = pool.slice(0, MAX_BATCH_SLOTS);
    const ids = batch.map((r) => r.sampleId);
    const slots = batch.map((_, i) => slotStart + i);
    this.machiniste.pendingSamples = ids;
    try {
      this.machiniste.lastResult = await this.deps.machiniste.send(ids, machinisteId, slots);
      this.machiniste.error = undefined;
    } catch (e) {
      this.machiniste.lastResult = undefined;
      this.machiniste.error = e instanceof Error ? e.message : String(e);
      this.notify();
      return;
    }
    try {
      await this.recordVerifiedUsage(this.machiniste.lastResult, ids);
    } catch (e) {
      // The transfer is verified; a usage-acceptance write must never erase that.
      this.machiniste.error =
        `usage acceptance failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.notify();
  }

  /**
   * Step 16H/G production seam (the real product path): every VERIFIED transfer
   * made through the UI action bar becomes usage-acceptance evidence. Only slots
   * that pass the 16G success boundary (`isSendSlotAccepted`) are accepted and
   * enqueued into the global publish queue (Option-A marker + candidate) —
   * offline-first. Unverified slots write nothing. Active only when the local
   * index AND the publish queue are provided at bootstrap (live mount); without
   * them the send stays transfer-only, exactly as before.
   */
  private async recordVerifiedUsage(
    result: MachinisteSendResult,
    ids: readonly string[],
  ): Promise<void> {
    if (!this.deps.index || !this.deps.globalPublishQueue) return;
    if (result.committed !== true) return;
    for (const sampleId of ids) {
      if (!isSendSlotAccepted(result, sampleId)) continue;
      await acceptUsageAndEnqueue(
        { index: this.deps.index, queue: this.deps.globalPublishQueue },
        { kind: "send", sampleId, result },
      );
    }
    // Re-sync the record registry so the persisted acceptance markers are
    // reflected immediately by the read-only publish-status surface.
    await this.refreshSearch();
  }

  /** Release all preview resources (e.g. on app teardown). */
  dispose(): void {
    this.globalRefreshDisposed = true;
    this.globalRefreshEpoch++;
    if (this.globalRefreshTimer !== undefined) {
      clearTimeout(this.globalRefreshTimer);
      this.globalRefreshTimer = undefined;
    }
    this.analysisLiveDisposed = true;
    this.searchEpoch++;
    this.cancelLiveRefresh();
    this.revokeCurrentPreview();
    this.deps.preview.dispose();
  }

  private notify(): void {
    this.deps.onChange?.();
  }
}
