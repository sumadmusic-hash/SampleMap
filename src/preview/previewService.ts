/**
 * PreviewService — bounded-concurrency preview fetching with disciplined
 * ObjectURL hygiene (SAMPLEMAP_V1_SPEC §9).
 *
 *  - fetches a sample's (preview) audio URL
 *  - materializes a browser Object URL (in-memory, ephemeral — NEVER written to
 *    IndexedDB; consistent with §1.1)
 *  - limits concurrent fetches (MAX_PREVIEW_CONCURRENCY)
 *  - keeps an LRU cache of idle preview URLs up to maxCacheSize; eviction
 *    revokes the URL
 *  - handles revoke the URL when released, so no ObjectURL leaks
 *  - starts browser audio playback when play() is called on the handle
 *    (SM-AUDIT-006); audio is stopped and cleaned up on stop/dispose
 *
 * The browser-specific bits (fetch + URL.createObjectURL + Audio) are injected
 * so the service is unit-testable in Node and swaps cleanly into the browser.
 */

/**
 * Minimal playable surface matching HTMLAudioElement (play/pause/ended/onended).
 * Injected so the service is testable without a real DOM.
 *
 * `onended`/`onerror` accept the standard DOM event handler signature
 * `(this, ev) => any` so the interface is directly assignable from
 * `HTMLAudioElement` without a cast.
 */
export interface Playable {
  play(): Promise<void>;
  pause(): void;
  readonly ended: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onended: ((this: any, ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((this: any, ev: any) => void) | null;
  src: string;
}

/** Factory that creates a Playable from a URL. Defaults to `new Audio(src)`. */
export type AudioFactory = (src: string) => Playable;

export interface PreviewHandle {
  sampleId: string;
  url: string;
  /** Whether audio playback is currently active. */
  isPlaying: boolean;
  /** Release this reference; revokes the underlying Object URL when last ref. */
  stop(): void;
  /** Start browser audio playback from the ObjectURL. Returns when playback starts. */
  play(): Promise<void>;
}

export interface PreviewBlob {
  // Minimal blob surface needed to build an object URL.
  readonly type: string;
  readonly size: number;
}

export interface BlobUrlApi {
  createObjectURL(blob: PreviewBlob): string;
  revokeObjectURL(url: string): void;
}

export type PreviewFetch = (
  url: string,
) => Promise<{ blob(): Promise<PreviewBlob> }>;

export interface PreviewServiceOptions {
  maxConcurrency?: number;
  maxCacheSize?: number;
  blobUrl?: BlobUrlApi;
  fetchFn?: PreviewFetch;
  /** Deterministic clock (ms epoch) for LRU tests. */
  now?: () => number;
  /**
   * Factory for audio playback elements. Defaults to `new Audio(src)`.
   * In tests, inject a controllable mock.
   */
  audioFactory?: AudioFactory;
}

interface CacheEntry {
  objectUrl: string;
  refs: number;
  lastUsed: number;
}

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_CACHE_SIZE = 8;

export class PreviewService {
  private readonly maxConcurrency: number;
  private readonly maxCacheSize: number;
  private readonly blobUrl: BlobUrlApi;
  private readonly fetchFn: PreviewFetch;
  private readonly now: () => number;
  private readonly audioFactory: AudioFactory;

  private active = 0;
  private readonly queue: Array<{ run: () => void; reject: (e: unknown) => void }> = [];
  /** sourceUrl -> cached entry; Map preserves insertion order (LRU-ish). */
  private readonly cache = new Map<string, CacheEntry>();
  /** SM-AUDIT-007: once disposed, in-flight fetches must not resurrect the cache. */
  private disposed = false;
  /** SM-AUDIT-006: active Audio elements for playback control. */
  private readonly activeAudio = new Set<Playable>();

  constructor(opts: PreviewServiceOptions = {}) {
    this.maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.maxCacheSize = opts.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    this.blobUrl =
      opts.blobUrl ??
      {
        createObjectURL: (b) => URL.createObjectURL(b as Blob),
        revokeObjectURL: (u) => URL.revokeObjectURL(u),
      };
    this.fetchFn = opts.fetchFn ?? ((url) => fetch(url));
    this.now = opts.now ?? (() => Date.now());
    this.audioFactory = opts.audioFactory ?? ((src) => new Audio(src));
  }

  async preview(sampleId: string, sourceUrl: string): Promise<PreviewHandle> {
    if (this.disposed) {
      throw new Error("preview service disposed");
    }
    const cached = this.cache.get(sourceUrl);
    if (cached) {
      cached.refs++;
      cached.lastUsed = this.now();
      // touch = move to MRU
      this.cache.delete(sourceUrl);
      this.cache.set(sourceUrl, cached);
      return this.makeHandle(sampleId, sourceUrl, cached);
    }
    return this.enqueue(sampleId, sourceUrl);
  }

  private enqueue(sampleId: string, sourceUrl: string): Promise<PreviewHandle> {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.active++;
        try {
          const resp = await this.fetchFn(sourceUrl);
          const blob = await resp.blob();
          const objectUrl = this.blobUrl.createObjectURL(blob);
          // SM-AUDIT-007 (stale async): a fetch that completes after the service
          // was disposed must NOT resurrect the cache or leak an unreferenced
          // ObjectURL — revoke it immediately and abort.
          if (this.disposed) {
            this.blobUrl.revokeObjectURL(objectUrl);
            reject(new Error("preview service disposed"));
            return;
          }
          const entry: CacheEntry = { objectUrl, refs: 1, lastUsed: this.now() };
          this.cache.set(sourceUrl, entry);
          this.evictIdle();
          const handle = this.makeHandle(sampleId, sourceUrl, entry);
          resolve(handle);
        } catch (e) {
          reject(e);
        } finally {
          this.active--;
          this.pump();
        }
      };
      if (this.disposed) {
        reject(new Error("preview service disposed"));
        return;
      }
      if (this.active < this.maxConcurrency) {
        void run();
      } else {
        this.queue.push({ run: () => void run(), reject });
      }
    });
  }

  private makeHandle(
    sampleId: string,
    sourceUrl: string,
    entry: CacheEntry,
  ): PreviewHandle {
    let stopped = false;
    let audio: Playable | undefined;
    const state = { isPlaying: false };
    const self = this;

    const handle: PreviewHandle = {
      sampleId,
      url: entry.objectUrl,
      get isPlaying() {
        return state.isPlaying;
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        entry.refs--;
        // SM-AUDIT-006: stop any active audio playback.
        if (audio && !audio.ended) {
          audio.pause();
          self.activeAudio.delete(audio);
        }
        state.isPlaying = false;
        self.revokeIfIdle(sourceUrl, entry);
      },
      // SM-AUDIT-006: start browser audio playback from the ObjectURL.
      play: async () => {
        if (stopped || state.isPlaying) return;
        try {
          audio = self.audioFactory(entry.objectUrl);
          state.isPlaying = true;
          self.activeAudio.add(audio);
          audio.onended = () => {
            state.isPlaying = false;
            self.activeAudio.delete(audio!);
          };
          audio.onerror = () => {
            state.isPlaying = false;
            self.activeAudio.delete(audio!);
          };
          await audio.play();
        } catch {
          state.isPlaying = false;
          if (audio) self.activeAudio.delete(audio);
        }
      },
    };
    return handle;
  }

  private revokeIfIdle(sourceUrl: string, entry: CacheEntry): void {
    if (entry.refs <= 0) {
      this.blobUrl.revokeObjectURL(entry.objectUrl);
      this.cache.delete(sourceUrl);
    }
  }

  /** Revoke idle (zero-ref) entries beyond maxCacheSize, LRU first. */
  private evictIdle(): void {
    while (this.cache.size > this.maxCacheSize) {
      let lruKey: string | undefined;
      let lruUsed = Infinity;
      for (const [key, entry] of this.cache) {
        if (entry.refs === 0 && entry.lastUsed < lruUsed) {
          lruKey = key;
          lruUsed = entry.lastUsed;
        }
      }
      if (lruKey === undefined) break; // all remaining entries are in use
      const entry = this.cache.get(lruKey)!;
      this.blobUrl.revokeObjectURL(entry.objectUrl);
      this.cache.delete(lruKey);
    }
  }

  /** Number of URLs currently cached (idle + in use). */
  cachedCount(): number {
    return this.cache.size;
  }

  /** Number of active (in-flight) fetches. */
  activeCount(): number {
    return this.active;
  }

  /** Revoke every cached URL and stop all audio playback (e.g. on session teardown). */
  dispose(): void {
    this.disposed = true;
    // SM-AUDIT-006: stop any active audio and update handle.isPlaying via the
    // onended callback (which is always set when play() was called).
    for (const audio of this.activeAudio) {
      if (!audio.ended) audio.pause();
      // Trigger the cleanup callback so handle.isPlaying is set to false.
      audio.onended?.(undefined as never);
    }
    this.activeAudio.clear();
    for (const entry of this.cache.values()) {
      this.blobUrl.revokeObjectURL(entry.objectUrl);
    }
    this.cache.clear();
    // SM-AUDIT-007: settle queued-but-never-started fetches so callers awaiting
    // them are not left hanging after teardown.
    for (const q of this.queue) q.reject(new Error("preview service disposed"));
    this.queue.length = 0;
    this.active = 0;
  }

  private pump(): void {
    const next = this.queue.shift();
    if (next) next.run();
  }
}
