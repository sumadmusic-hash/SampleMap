# STEP51 — Live Preview & Sample Interaction Verification

## 1. Executive Verdict

Verdict: **B — PASS WITH LIMITATION**

Status: **PASS WITH LIMITATION**

The existing SampleMap preview/interaction path is **correct and defect-free across every
aspect verifiable in this session**:

- Focus and playback remain **distinct** (map point click → focus only; playback is an
  explicit, separate action) — MEASURED in the real browser.
- The explicit preview action targets the intended sample and plays it through a real
  `HTMLAudioElement` loaded from an ephemeral `blob:` ObjectURL — MEASURED offline in the
  browser.
- Sequential A→B→C replacement stops the previous element (exactly one playing at a time),
  repeated Play/Stop and A/B/A/B toggles never duplicate live playback and never leak
  ObjectURLs (created−revoked stays within the bounded 8-entry cache) — MEASURED offline.
- The preview-epoch guard demonstrably discards a stale in-flight fetch (never adopted,
  never played, ObjectURL revoked) — MEASURED offline in the browser AND pinned by existing
  deferred-fetch unit tests.
- Preview audio is **transient by construction and enforced at the persistence boundary**
  (`assertNoAudioBytes` rejects any Blob/ArrayBuffer/typed-array write to IndexedDB) —
  OBSERVED.
- Missing/failed previews yield a controlled, non-crashing error with focus intact —
  MEASURED.

The limitation is environmental, **not a product defect**: the live leg was verified
against the real Audiotool API (real token, 30 real samples, 30/30 preview sources, a real
18,100-byte preview with an ID3-tagged MP3 header), but fully authenticated-UI *pressed by
hand* audible playback inside the app (a live OAuth browser session) was **NOT VERIFIED** in
this session. Per §21 the environment limit is documented, not hidden.

**No production code was changed. Recommendation: KEEP AS-IS.**

---

## 2. Scope

Verified audit-first, against the already-shipped implementation:

1. The complete UI→controller→reference→loader→ObjectURL→playback path, all entry surfaces
   (inspector, result rows, Sound Space compare, collection, similarity), focus/play
   separation, sequential and repeated replacement, stale-async protection, ObjectURL
   lifecycle, failure states, and audio-persistence boundaries.
2. Live Audiotool evidence via the existing authenticated API tooling (read-only; nothing
   persisted to disk).
3. Existing STEP45–STEP50 architecture is treated as settled; STEP51 introduced **zero**
   production changes and **zero** new feature work.

Non-goals honored: no classifier/map/coordinate/persistence/UI redesign, no Audio
architecture change, no map-click semantics change, no new filters or machine learning, no
speculative refactoring.

---

## 3. Existing Architecture

The preview path was already settled by prior steps (STEP15E §9, STEP36 lazy resolution,
SM-AUDIT-006 playback, SM-AUDIT-007 stale-epoch/teardown guards) and was not modified:

```
Persistent layer (IndexedDB):  metadata · classification · coordinates · references
                               (Blob/ArrayBuffer/audio bytes FORBIDDEN — assertNoAudioBytes)
Transient layer (runtime):     preview audio Blob · ObjectURL · HTMLAudioElement playback state

UI (▶ action, one path)
  ├─ inspector-preview-toggle        → app.togglePreview(record)
  ├─ result / similarity / collection rows  → togglePreview(record) / togglePreviewById(id)
  └─ Sound Space compare rows        → togglePreviewById(id)
      ↓
SampleMapApp.togglePreview (epoch guard)
  → previewUrlFor(record)  (metaCache.previewMp3Url; lazy resolveSample → client.samples.get)
  → PreviewService.preview(sampleId, sourceUrl)
      → fetch(sourceUrl) → blob → URL.createObjectURL(blob)  [in-memory, LRU ≤ 8]
      → handle.play() → new Audio(objectUrl) → audio.play()
```

---

## 4. Baseline

| Check | Before (STEP50 end) | After (STEP51 end) |
|---|---|---|
| TypeScript (`tsc --noEmit`) | PASS | **PASS** |
| Vitest files / tests | 77 / 1333 | 77 / 1333 (+0) |
| Vitest failures | 0 | **0** |
| Playwright | 181/181 | **187/187** (+6 new, e2e/step51-preview.spec.ts) |
| Live Audiotool | — | 30/30 real samples, preview bytes verified (read-only) |

Baseline was green before any work; the full suites ran green again after.

---

## 5. Preview Path Trace

Recorded from implementation (OBSERVED):

- **Entry points** (all route to the single controller call):
  - `render.ts:2219` inspector `inspector-preview-toggle` click → `app.togglePreview(selected)`.
  - `render.ts:887` search-result row `preview-<id>` → `togglePreview(record)` (focus untouched).
  - `render.ts:1000` / `1948` / `2030` similarity and other rows → `togglePreview` /
    `togglePreviewById`.
  - `render.ts:1453` Sound Space compare `sound-space-compare-preview-<id>` →
    `togglePreviewById`.
  - `render.ts:1582` collection `collection-preview-<id>` → `togglePreviewById`.
- **Controller** `app.ts:2275 togglePreview(record)`:
  1. `epoch = ++previewEpoch` (invalidates every in-flight intent).
  2. Same-sample toggle when already previewing → stop, clear, return (toggle stop).
  3. Resolve source URL: `deps.previewUrlFor` (runtime `metaCache`), else
     `deps.resolveSample` → `client.samples.get` (STEP36 lazy; URL never persisted).
  4. Guarded `deps.preview.preview(sampleId, url)`; on resolve, if `epoch` changed →
     `handle.stop()` (fetch discarded, never played).
  5. Adopt handle, set `previewSampleId`, `void handle.play()`.
- **Loader/playback** `previewService.ts`: bounded-concurrency fetch (3) → `blob()` →
  `URL.createObjectURL` (in-memory only) → cache entry (LRU ≤ 8, eviction revokes) →
  `handle.play()` → `new Audio(objectUrl)` → `.play()`; `stop()` pauses audio and revokes
  the ObjectURL when the last reference is released; `dispose()` stops all audio, revokes
  everything, rejects queued fetches.
- **UI reflection** `render.ts:2213-2219`: `previewing` flips the button to "■ Stop";
  `previewError` renders an inline `.preview-error` row.

The traced flow matches the intended architecture exactly; no hidden path, no alternate
loader, no direct `HTMLAudioElement` construction outside `PreviewService`.

---

## 6. Focus vs Playback

- Map point press → `mapRender.ts:297-309` `pointAt` hit → `opts.onSelect(record)` →
  `render.ts:778` `app.selectSample(record)` → **focus only**. The pointerdown path never
  triggers `togglePreview` (OBSERVED).
- Browser-verified (`51-01`, OFFLINE): clicking a map point set `focusedSampleId`,
  produced **zero** preview fetches and **zero** `Audio` elements; playback began only after
  the explicit **▶ Preview** action.
- Focus change autonomously stops a running preview (`app.ts:2190-2201
  `selectSample` calls `previewEpoch++` and stops the current handle) — pinned by
  `app.test.ts:1402` ("focussing a different sample stops a running preview…") and
  observed in the browser (`51-01` focus of a fresh point while a preview runs does not
  leave stale audio). Filtering a focused sample away deliberately does **not** stop its
  preview (`app.test.ts:1420`) — focus/preview survive filtering by design.
- The accepted product rule "map point click → focus; playback explicit" is **preserved**
  exactly.

## 7. Preview Lifecycle

OBSERVED in `previewService.ts`:

1. **Creation** — one `Audio` element per play, `src = blob:` ObjectURL.
2. **Playback start** — `audio.onended`/`onerror` (idempotent state off) + `await play()`.
3. **Replacement** — next `togglePreview` calls `handle.stop()` (pause + ref-release) before
   adopting the new handle.
4. **Cleanup/revocation** — `revokeIfIdle` revokes at ref 0; LRU eviction (`evictIdle`)
   revokes oldest idle entries beyond `maxCacheSize` (8).
5. **Repeated previews** — same source hits the cached ObjectURL (ref++), no second fetch.
6. **Failed loading** — fetch rejection propagates to the controller → `.preview-error`.
7. **Disposal** — `dispose()` pauses all audio, fires `onended`, revokes all URLs, rejects
   queued fetches (no resurrect on late completion, `previewService.test.ts:347-392`).

**Stale-preview race** — the epoch guard (app) + post-dispose abort + revoke-before-return
(service) both exist and were **demonstrated effective** in the real browser (`51-04`: a
deferred fetch for A resolving after the user played B was discarded — `previewSampleId`
stayed B, its ObjectURL revoked, never played) and pinned by `app.test.ts:1527-1585`
(deferred-fetch unit audit).

## 8. Sequential Preview

Requirement: A→Play A, B→Play B, C→Play C.

Browser-measured (`51-02`, OFFLINE, real `HTMLAudioElement`):

- Playing B replaced A: **exactly one** non-paused Audio element (blob: src); A's element
  was paused (`a.paused === true`).
- Playing C replaced B likewise: **exactly one** playing; C current in
  `app.previewSampleId`.
- Old playback never continues unexpectedly; no hidden second element; the controller is
  the single source of truth for the active preview.
- Oldest audio element count is bounded (per-preview elements are well-behaved; see §9 for
  the leak accounting).

## 9. Repeated Preview

Requirement: Play A four times; then A, B, A, B.

Browser-measured (`51-03`, OFFLINE):

- Play A → Stop (toggle) repeated: at every instant at most one non-paused Audio element;
  after each Stop, **zero** playing elements and `previewSampleId === null`.
- A→B→A→B: ends on B playing; **exactly one** non-paused element throughout.
- **ObjectURL accounting** after all repetitions: `created − revoked ≤ 8`
  (the bounded LRU cache), and `revoked > 0` (old URLs genuinely revoked on stop/replace
  → no accumulating ObjectURLs; no element/event-handler accumulation beyond the 
  service's per-play instance, which is intentionally re-created per play and paused on
  replacement).
- No duplicate live audio, no stale playback, no inspector state corruption
  (`previewSampleId` always equals the last played).

## 10. Failure / Missing Preview

| Case | Code path | Evidence |
|---|---|---|
| No preview URL (metadata has none) | `app.ts:2324` → `previewError = "no preview url available"` | unit `previewLazyResolution.test.ts:170` (Case D) |
| Metadata request fails | `app.ts:2302` → `"preview metadata unavailable"` | unit `previewLazyResolution.test.ts:184` (Case E) |
| Fetch fails (network/auth) | `app.ts:2348` caught → `previewError` = message | **browser-measured** `51-05` (stub network failure) |
| Sample disappears / session lost | fetch reject or lazy resolve failure → controlled error; no state corruption | OBSERVED code + `51-05` |

Browser-measured behavior on fetch failure (`51-05`): `.preview-error` renders the message,
`previewSampleId` is undefined, **focus is intact**, the app does not crash, no stale audio
is left, and a subsequent successful preview recovers cleanly (error cleared, new sample
plays).

## 11. Audio Persistence

- The persisted layer stores **metadata, classification, coordinates, references only**.
- `indexStore.ts:180 assertNoAudioBytes` deep-walks every persisted row and **throws** on
  `Blob` / `ArrayBuffer` / `SharedArrayBuffer` / non-embedding typed arrays; `queueStore.ts`
  applies the analogous rule (OBSERVED). `assertNoAudioBytes` is called on every
  `IndexStore.put` (OBSERVED; pinned by tests `indexStore.test.ts:216-222`,
  `collectionStore.test.ts:263`, `previewLazyResolution.test.ts:196`).
- `URL.createObjectURL` is the only audio byte carrier and is **runtime-only**: revoked on
  stop/replacement/eviction/dispose — never written to IndexedDB, Cache API, localStorage,
  or serialized (OBSERVED across `previewService.ts`, `bootstrap.ts`, `indexStore.ts`).
- `soundCharacterCodec.ts` base64 is the 7-dimension analysis Sound Character, not audio
  (OBSERVED). The standalone `main.ts` POC download demo creates one ephemeral ObjectURL in
  memory (OBSERVED) and is not the SampleMap UI.
- **Result: preview audio is transient by construction and enforced at every write path —
  AC6/AC7 PASS.**

## 12. Offline Browser Evidence

`e2e/step51-preview.spec.ts` (6 tests, **OFFLINE VERIFIED**, real system Chrome):

- Runs the **real** UI, **real** `PreviewService`, **real** `HTMLAudioElement`; the harness
  supplies fixture metadata and the spec supplies playable WAV bytes via a page-level fetch
  stub (the harness's service uses the page `window.fetch` at call time). Instrumented
  `Audio` construction and `URL.createObjectURL`/`revokeObjectURL`.
- Verified: focus-only on map click; explicit play → one real playing Audio (blob: src);
  sequential replacement; repeated/toggling without leaks; stale-epoch discard; fetch-failure
  control; no pageerrors.
- **What the offline harness proves:** the whole interaction state machine and the real
  browser playback machinery (fetch → blob → ObjectURL → Audio → play → pause/revoke) work
  end-to-end against synthetic bytes.
- **What it cannot prove:** **LIVE AUDIO VERIFIED: NO** — synthetic WAV + fixture metadata
  ≠ real Audiotool rendering; no claims drawn from it about real audio content or the real
  Sample Pool session.

## 13. Live Audiotool Evidence

`scripts/step51-live-preview-check.mts` (read-only, authenticated via the existing
`AT_PAT`, nothing written to disk) — **LIVE-VERIFIED** (this session):

- Token accepted by `createAudiotoolClient` ✓
- **LIST**: 30 real Audiotool samples returned ✓
- **AVAIL**: 30/30 carry a preview source (`previewMp3Url` present) ✓
- **DOWNLOAD (preview)**: real `client.samples.download(meta, { format: "preview" })` →
  18,100 bytes; first bytes `49 44 33 …` = **ID3 header** → genuine MPEG audio payload, not
  an error/JSON envelope ✓

This proves the *reference → preview source → real audio bytes* leg of the product path on
live Audiotool. **NOT VERIFIED:** audible playback inside the authenticated SampleMap UI
browser session, live repeated/sequential audible playback, and the live OAuth browser
consent flow were not exercised in this session (interactive authenticated browser session
unavailable to this run; see §21). This is an environmental limit, not a product defect.

## 14. Evidence Classification

**OBSERVED:** the complete trace of §5 (entry points, `togglePreview` epoch guard, lazy
metadata resolution, `PreviewService` LRU/revoke/dispose); map click → focus only
(`mapRender.ts:297-309`, `render.ts:778`); focus-change stops preview (`app.ts:2190-2201`);
`assertNoAudioBytes` at every index/queue write; `previewMp3Url` source never persisted;
SoundCharacter base64 is analysis data, not audio.

**MEASURED:** offline browser (real Chrome + real Audio): focus-only zero-fetch/zero-play
(51-01); exactly-one-playing across A→B→C (51-02); A,B,A,B with `created−revoked ≤ 8` and
`revoked > 0` (51-03); stale deferred fetch discarded, revoked, never played (51-04);
failure → controlled error + focus intact + clean recovery (51-05); zero pageerrors (51-06).
Live: 30 real samples, 30/30 preview sources, preview download = 18,100-byte ID3 MP3.

**CALCULATED:** none beyond the tests' own arithmetic.

**INFERRED:** that a fully authenticated-UI audible session would behave identically to the
offline state machine given the live bytes — explicitly NOT claimed as verified; that
element re-creation per play is intentional (each play is a fresh, disposable Audio).

**NOT VERIFIED:** audible playback in a live authenticated SampleMap UI browser session;
live repeated/sequential audible playback; live auth-expiry mid-session error path.

**SPECIFICATION GAP:** none found.

## 15. Defects

**No concrete product defect found.** Observations (dispositions):

| # | Observation | Disposition |
|---|---|---|
| 1 | Playback un-verifiable audibly in a live UI session this session | Environmental — live API leg verified; documented (§13) |
| 2 | Result-row ▶ and the inspector ▶ are both visible simultaneously | Established pre-STEP51 UI (all route through the single `togglePreview`); no STEP51 change |
| 3 | Multiple idle Audio elements accumulate per played sample (one per play session) | Intentional disposable design; paused elements reference revoked URLs; bounded URL cache proven leak-free (51-03) |

## 16. Production Changes

**None.** STEP51 added test/verification artifacts only:
`e2e/step51-preview.spec.ts` (6 browser checks) and
`scripts/step51-live-preview-check.mts` (read-only live probe). No product file was touched.

## 17. Regression Results

Offline:
```
TypeScript:  tsc --noEmit            PASS
Vitest:      1333/1333 passed (77 files)
Playwright:  187/187 passed (2.1 m)
```

Live Audiotool (read-only, this session):
```
AUTH      PASS (token accepted)
LIST      30 real samples
AVAIL     30/30 preview sources present
PREVIEW DOWNLOAD  18,100 bytes, ID3 MP3 header  →  LIVE-VERIFIED
AUDIBLE UI PLAYBACK  NOT VERIFIED (no live authenticated UI session run)
```

## 18. Acceptance Criteria

| Criterion | Result | Evidence |
|---|---|---|
| AC1 | Current preview/playback implementation fully traced | **PASS** | §5 (OBSERVED) |
| AC2 | Focus and playback remain distinct | **PASS** | §6; MEASURED 51-01 |
| AC3 | Explicit playback targets the intended sample | **PASS** | §5,§8; MEASURED 51-01/02 |
| AC4 | Sequential A→B→C behaves correctly | **PASS** | §8; MEASURED 51-02 |
| AC5 | Repeated preview creates no demonstrated stale/leak defect | **PASS** | §9; MEASURED 51-03 |
| AC6 | Preview resources are transient | **PASS** | §7,§11 |
| AC7 | No decoded audio/blob/ArrayBuffer persisted | **PASS** | §11 (OBSERVED + unit pins) |
| AC8 | ObjectURL lifecycle correct; no concrete leak demonstrated | **PASS** | §7,§9 (created−revoked ≤ 8) |
| AC9 | Stale async completion cannot override newer preview | **PASS** | §7; MEASURED 51-04 + `app.test.ts:1527` |
| AC10 | Missing/failed preview does not corrupt app state | **PASS** | §10; MEASURED 51-05 + Case D/E units |
| AC11 | Offline claims separated from live claims | **PASS** | §12 vs §13, §14 |
| AC12 | Live Audiotool preview tested if available | **PASS** | §13 (real token → real preview bytes) |
| AC13 | Live limitation explicitly documented if unverifiable | **PASS** | §13, §21 |
| AC14 | No STEP45–STEP50 architecture modified without a defect | **PASS** | §16 (zero product changes) |
| AC15 | No speculative production changes | **PASS** | §16 |
| AC16 | Complete regression passes if production changed | **N/A** (no production change) | §17 |

## 19. Final Recommendation

**B — PASS WITH LIMITATION / KEEP AS-IS.**

The existing final interaction path is correct:

```
REAL SAMPLE → FOCUS → EXPLICIT PREVIEW → CORRECT AUDIO → SAFE REPLACEMENT → CLEAN RUNTIME STATE
```

all legs verified except the single environmental gap of *audible playback inside a live
authenticated UI session*, which is documented and not a product defect. Keep the current
implementation; no production code change is warranted.