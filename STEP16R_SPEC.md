# STEP16R_SPEC.md — SampleMap Product & UX Foundation Specification (Revised)

**STEP**: STEP16R (post-STEPS16E/16F/16G/16H/16I/16L/16M/16O/16P/16Q)
**Status**: SPECIFICATION COMPLETE — IMPLEMENTATION NOT STARTED
**Type**: Specification only. This document defines product-level functionality and UX
foundation for the SampleMap GUI after STEP16Q. It makes NO source, test, config,
formula, persistence, classification, API, or GUI code changes. The only deliverable of
STEP16R is this specification.

> **Revision note:** this document is the corrected and consolidated STEP16R. It replaces
> the earlier draft. The product definition is corrected to the **accessible public
> Audiotool Sample Pool** (not "my own sample library"). The STEP16Q map architecture is
> respected verbatim and is **not** reopened. This revision is otherwise consistent with
> the verified repository state (SampleIndexRecord fields, Machiniste direct-reference /
> read-back, and MAX_BATCH_SLOTS=8).

---

## 1. Status

- **STEP16R is a specification-only phase.** No implementation work has been performed or
  is authorized by this document. Anchor: STEP16Q implementation is complete and verified
  (540 app tests / 32 files pass; tsc 0 errors; vite build PASS; worker typecheck 0 errors,
  worker 19/19 tests; Playwright STEP16M 20/20; real-data 100-sample run 11/11 acceptance
  checks PASS). STEP16Q is **not** reopened.
- STEP16Q established the **persisted-map architecture**. That architecture is a frozen
  technical boundary for STEP16R; it is described (§4) and honored, never re-litigated.
- This spec describes what SampleMap should do and how the user should experience it, and
  it is the foundation a later Final UI/UX Design phase (visual styling) and a later
  implementation phase will build on. It intentionally fixes nothing about final colors,
  fonts, shadows, spacing, icons, layout, or other visual styling — that is deferred
  (see §12 and §14).
- Binding architectural decisions adopted in STEP16Q remain in force (see §4).
- Open questions and genuine unresolved detail questions are recorded, not silently
  resolved by code changes (see §17).

---

## 2. Objective

Define the product-level functionality and UX foundation of SampleMap after STEP16Q:

1. A single, authoritative description of **what the product does** and **how a user
   thinks about it** (product definition, mental model, primary workflow, interaction
   model) over the **accessible public Audiotool Sample Pool**.
2. A precise split of what is in **V1**, **Later/Optional**, and **Out of scope** so
   downstream implementation and a Final UI/UX Design phase have an unambiguous contract.
3. A clear account of the **current GUI's faithful functionality** (which is a functional /
   technical proof-of-concept, **not** a final visual design) and the boundaries of scope
   for the near-term product.
4. Explicit acceptance criteria and a verification plan that align to the already-verified
   STEP16M user flows, so "product behavior" can be proven, not assumed.
5. Explicit non-goals and a stop condition so the phase cannot expand into implementation.

The spec grounds every claim in the verified repository state established by STEP16Q and
documented in `STEP16Q_IMPLEMENTATION.md`, `STEP16Q_SPEC_BLOCKER_REPORT.md`,
`STEP16P_MAP_DESIGN.md`, and `SAMPLEMAP_V1_SPEC.md`.

---

## 3. Relationship to STEP16Q

STEP16Q produced and verified the **persisted-map architecture** that this spec is the
product-level expression of. The following are **binding baseline** items (rules 1–5 of
`STEP16Q_SPEC_BLOCKER_REPORT.md`). STEP16R does not change, reopen, or relax any of them:

1. **Persisted V2 map position is authoritative.** A sample's 2D position comes
   exclusively from the persisted analysis result (`record.mapPosition`), computed once at
   analysis time by `src/map/mapPosition.ts` (`computePosition(features, decodedAudio)` →
   `{x, y}`). It is **never recomputed from `AudioFeatures`** on read, and never
   recalculated by the UI or any consumer (`Missing-V2`, see §13).
2. **No V1 fallback.** The legacy `mapPosition(features)` function was removed. There is no
   silent fallback path. `mapPosition` is a single representation (`mapVersion="map-v2"`).
3. **The map formula is FROZEN.** `flatnessToX`, `centroidToY`, and `wholeSampleFlatness`
   are stable. There is no normalization, retuning, or reinterpretation of the coordinate
   space. (Documented formula-vs-spec deviations — e.g. `flatnessToX(0.5)≈0.4`,
   `centroidToY(<100)=0`, `centroidToY(>10000)=1`, silence flatness≈1 — are accepted and
   **not** adjusted.)
4. **No permanent audio storage.** Audio is used only transiently for analysis. The system
   never persists decoded audio bytes; only analysis results and identities are stored.
   Preview is ephemeral (ObjectURL, see §9).
5. **No redesign of OAuth/Nexus/Machiniste.** The proven mechanism is assumed; only its
   product-facing behavior is described here (§§12–13).

The real-data verification anchors for the product promise (saved in
`STEP16O_X_SATURATION_ANALYSIS.md` / `STEP16Q_IMPLEMENTATION.md`): X median V1 0.935 →
V2 0.663; X≥0.95 edge pile-up 46%→6%; X stdev 0.221; X P10–P90 0.520; Y stdev 0.273; Y
P10–P90 0.765; |Pearson(X,Y)| = 0.267; edge pile-up x=8% / y=13%; 5×5 corner-bin 6%. These
underpin the product claim that the map is "spread along the defined V2 axes, not
corner-piled". The UI does **not** expose raw model math; it exposes the human-meaningful
map described in §7.

---

## 4. STEP16Q as Technical Boundary (Map Semantics)

This section makes the STEP16Q constraints explicit as a non-negotiable boundary for every
product/UX statement that follows:

- `mapPosition` is the **authoritative stored V2 position**. `mapVersion = "map-v2"`.
- **No V1 fallback calculation** exists or is permitted.
- **No reconstruction** of position from `AudioFeatures` on read.
- **No later recalculation** of position by the UI or any consumer; the position is written
  once at analysis time and read thereafter.
- `Missing-V2` means: the position is **not available** (see §13).
- Audio is used **only transiently for analysis**; there is **no permanent storage of audio
  data** by SampleMap.
- The STEP16Q formula itself is **not changed** by STEP16R.

### 4.1 What the axes mean — and what they do NOT promise
The V2 position uses the two axes defined in STEP16Q. The product-level axis labels are:

- Horizontal axis: **Tonal ↔ Noisy**
- Vertical axis: **Dark ↔ Bright**

The `↔` labels a directional continuum; it does NOT reorder the frozen coordinates. In the
STEP16Q coordinates, `x = 0` is the **Noisy** end (rendered **left**) and `x = 1` is the
**Tonal** end (rendered **right**); `y = 0` is the **Dark** end (rendered **bottom**) and
`y = 1` is the **Bright** end (rendered **top**). No formula value is changed by this
wording; it only makes the existing axis anchoring explicit.

These are labels over the existing frozen coordinates; they are not a redefinition of the
math (§3). The product description must distinguish three layers clearly:

1. **Actual analysis** — the audio features and the frozen coordinate computation
   (STEP16Q; not re-derived here).
2. **Visual position** — the persisted V2 `{x, y}` rendered on the 2D map.
3. **User interpretation** — how the user reads the resulting layout.

Because STEP16Q defines only the X and Y axes (Tonal↔Noisy, Dark↔Bright) and does not
claim a general acoustic-similarity metric, the product promises **no general "timbral
similarity"**. The only proximity claim is:

> **Samples that are close together share similar characteristics along the defined
> SampleMap V2 axes.**

Any broader notion of similarity ("sounds the same") is an *open question*, not a product
promise (see §17).

---

## 5. Product Definition

**SampleMap in one sentence:**

> **SampleMap is an intelligent visual browser and classification layer over the
> accessible public Audiotool Sample Pool.**

SampleMap **is not** exclusively a browser for the samples owned by a single user. It works
over the accessible public sample pool of Audiotool:

- Samples may originate from **other Audiotool users**.
- SampleMap may **analyze and display the accessible public sample stock**.
- The **creator/owner of a sample is metadata** — it is shown and used as a filter — but it
  is **not a restriction** on use within SampleMap.
- A sample does **not** have to belong to the currently logged-in user.
- The previously proven capability to **fetch public samples owned by other users** and to
  use them as a **direct sample reference in Machiniste** is part of the product foundation.

**Product scope (what SampleMap is):**
- A **visual map of the accessible public sample pool**: analysis, classification, and
  spatial navigation/discovforty over accessible public Audiotool samples.
- A **browser + preview**: find and listen before acting; samples from any public owner.
- A **search & filter surface**: by name, owner/creator, original tags, and classification.
- A **selection surface**: choose samples (on the map and/or via the sample list) and act
  on them — insert into Audiotool via Machiniste as **direct sample references**
  (no re-upload, no local copy).

**Product scope (what SampleMap is NOT — see §14 and §18):**
- Not a DAW, editor, or waveform mangler.
- Not a full Audiotool tag/metadata editor (tag-writing is out of scope unless confirmed, §11).
- Not a social/community platform (favorites, playlists, sharing, follows, profiles).
- Not a replacement for Audiotool's own library or project browser.
- Not a permanent audio hosting/caching service.

**Core user value:** "Turn the accessible Audiotool public sample pool into a searchable,
analyzable, visual map, so I can find, hear, inspect, and use the right sample in my
project — regardless of who created it."

---

## 6. User Mental Model

The mental model SampleMap presents to the user:

> **"The accessible Audiotool public sample pool becomes a searchable visual map."**

- **"The public pool is a map."** Every analyzed, accessible public sample is a point on
  the map. A point may come from any Audiotool user. Points do not move after analysis
  (persisted, deterministic V2 position).
- **"The directions mean something musical."** The map has two interpretable axes —
  horizontal **Tonal ↔ Noisy**, vertical **Dark ↔ Bright** (labels over persisted V2
  coordinates, §4.1).
- **"Close together means similar along the defined axes."** Proximity reflects shared
  characteristics along the V2 axes — it does **not** promise general timbral identity
  (§4.1). Density is exposed as a discovery aid, not as a DSP feature.
- **"I find by looking, hearing, and filtering."** I locate a region by vision, confirm by
  preview, and narrow by search/filter (name, owner, tags, class) when the pool is large.
- **"The owner is a clue, not a wall."** I can see and filter by creator/owner, but a
  sample from another user is fully usable.
- **"I act in Audiotool, not in SampleMap."** SampleMap is the lens; Audiotool is where the
  sample ultimately lands. I insert a sample by **direct reference**; SampleMap does not
  re-upload, does not keep a local copy, and never stores audio.
- **"Analysis is a one-time per-sample investment."** Once a sample is analyzed, its
  position, class, and confidence persist. When I return later, the map is the same.

**Handling the imperfect classifier (mental-model guard):** The user trusts the map for
*browsing*, but understands the classification is a best-effort estimate, not ground truth.
The UI must never present the classifier as authoritative (§11).

**Positioning of the product (§6 framing):** SampleMap is **not a new sample database** and
does not own a copy of the sample pool. It is a:

> **visual analysis, classification, search and navigation layer over Audiotool's public
> sample pool.**

---

## 7. Primary User Workflow

The core end-to-end flow (and the STEP16M-verified happy path):

1. **Sign in / connect Audiotool** via the existing OAuth/Nexus mechanism (proven
   capability, §12). This grants *access* to the user's public samples **and** other
   public samples reachable through the accessible pool.
2. **Index / analyze.** SampleMap enumerates the accessible public samples, analyzes each
   (decode → audio features → classification → persisted V2 map position), and stores a
   **SampleMap local index** (metadata + analysis results only — **no audio**, §8). This is
   one-time per sample; already-indexed samples are not re-analyzed.
3. **See the map.** The canvas shows one point per analyzed sample at its persisted V2
   coordinates. Samples may share a position; each record keeps its own position, and
   overlapping samples remain selectable/reachable (§10).
4. **Look → Hear → Narrow → Act:**
   - **Look:** navigate the map (pan/zoom), read the axes, see density.
   - **Hear:** select + preview (single-playing semantics, §9).
   - **Narrow:** search by name/owner/tag and filter by classification (§11).
   - **Inspect:** open the inspector for details of one sample (§8 includes owner/creator).
   - **Act:** send one or more selected (1–8) samples to Audiotool via Machiniste as
     **direct references** (no re-upload), with read-back verification (§13).

**User-role distinctions (each has a tailored entry path):**
- **First-use user:** sees the empty map and guidance to sign in + index; sees onboarding
  text, not a blank failure (§§12, 15).
- **Returning user:** map is populated from the persisted local index; reloads to the same
  layout (§16).
- **Existing (pre-V2) records:** their samples are Missing-V2 (no persisted V2 map
  position). They do **not** get a fabricated position; see §13.
- **Newly analyzed samples:** appear at their deterministic V2 position; no re-analysis of
  already-indexed samples.
- **Low-confidence samples:** appear on the map (position is still valid) but are flagged
  in the inspector as low-confidence so the user discounts their classification (§§8, 11).
- **Inaccessible/unavailable samples** (private, unlisted-but-not-accessible, or no longer
  reachable): shown with an explicit availability state; not silently dropped (§15).
- **Unanalyzable inputs (silence, corrupt, unsupported format):** handled at indexing, no
  point is placed, and the user is informed at the indexing layer, not silently (§12).

---

## 8. Indexing Model: Audiotool Sample Pool vs SampleMap Local Index

SampleMap **does not own a copy of the sample pool.** The Audiotool sample remains the
single source of truth for the audio and its metadata; SampleMap keeps only a **local
index** of metadata and analysis results.

**Audiotool (source of truth):**
```text
Sample
 ├─ sampleId
 ├─ owner
 ├─ name
 ├─ tags
 └─ audio
```

**SampleMap local index (metadata + analysis only):**
```text
SampleIndexRecord
 ├─ sampleId
 ├─ owner
 ├─ name
 ├─ visibility (public | unlisted | private | unknown)
 ├─ originalTags
 ├─ primaryClass
 ├─ confidence
 ├─ secondaryClasses
 ├─ audioFeatures (14 fields)
 ├─ mapPosition? (persisted V2, optional = Missing-V2)
 └─ analysis metadata (status, analysisVersion, analyzedAt, analysisBuild, hashes, …)
```

- **Audio data belongs to Audiotool, not to the persistent SampleMap index.** The index
  never persists audio bytes; audio is used only transiently for analysis and ephemeral
  preview (§§3, 4, 9).
- The identity of a sample is its Audiotool `sampleId` (each record also carries content
  identity/hashes for provenance).
- `owner`, `visibility`, `name`, and `originalTags` are metadata; `owner` and `visibility`
  reflect whether a sample is part of the accessible public pool. This aligns with the
  verified data model (`SampleIndexRecord` and `SampleVisibility`).
- **Accessibility:** only samples reachable through the authenticated Audiotool access are
  indexed and displayed. Inaccessible/private samples are shown as unavailable, not
  fabricated (see §15).

---

## 9. Map Interaction Model

The map is the product's centerpiece. It renders persisted V2 coordinates; UI viewport:
`MAP_WIDTH=800`, `MAP_HEIGHT=520`.

### 9.1 Map Fundamentals
- Each analyzed sample = one point at its persisted V2 `{x, y}` (both in [0,1]).
- Points are stable and deterministic; reloading produces the same layout (§16).
- Each sample record has its **own persisted position**; multiple samples may occupy the
  same or nearly the same position (§10).
- The UI may label axes "Tonal ↔ Noisy / Dark ↔ Bright" as product-level guidance (labeling
  of the existing frozen coordinates, not a redefinition of the math, §4.1).

### 9.2 Navigation & Zoom
- Pan (drag) and zoom (scroll/wheel or controls).
- Zoom levels are discrete: `MIN_ZOOM=1` → `MAX_ZOOM=8` via `ZOOM_STEP=2`
  (1 → 2 → 4 → 8). Zoom-in reveals finer separation; zoom-out shows density.
- Region-of-interest navigation ("go to a region") is V1; a persistent zoom/pan memory
  (restore last viewport on reload) is **Later/Optional** (see §14).

### 9.3 Selection (incl. Multi-Selection) & Hit-Testing
Multi-selection is **V1** (essential for the Machiniste batch action, §13).

- A point is "hit" within `POINT_HIT_RADIUS_PX=10`.
- **Single selection:** click a point to inspect it (§8, inspector).
- **Multi-selection:** the user can select several samples at once — on the map and/or via
  the sample list. The selection set is the union of what is sent to Machiniste.
- **Deselection:** clicking an already-selected point (or clearing via the list) removes it
  from the selection; there is a clear command to clear all selection.
- **Selection vs zoom:** changing the zoom level does **not** clear the selection set;
  selected samples remain selected and remain reachable even if currently out of view or
  behind an overlapping point.
- **Selection vs filtering:** applying a search/filter does not clear the selection, but it
  limits which samples are visible/available for *new* picks. Selected samples that become
   hidden by a filter remain in the selection and are still included in a batch send
   (subject to the §9.3 selection cap of 8).
- **Overlapping points:** each record keeps its own position; overlapping samples must
  remain **selectable and reachable**. The concrete visual overlap-resolution technique is
  **not invented here** — it is specified as a later UX feature (§10), with the V1
  requirement being only that overlapping samples remain reachable.
- **V1 Selection Limit (batch bound relationship):** the UI selection is capped at
  `MAX_BATCH_SLOTS=8`. A ninth sample **cannot be added** to an already-full selection;
  further selections do **not** create a ninth, and the UI does **not** generate a >8
  rejection dialog (this is the defined V1 selection contract).
  - 1–8 samples can be selected and sent to Machiniste.
  - The Machiniste service retains an **independent >8 defensive rejection** for callers
    that bypass the UI selection layer (see §13); that service rejection is **not** a
    regular UI flow.

### 9.4 Density & Clustering
- The map communicates **density** (visual crowding) as a discovery aid — V1.
- **Clustering as an algorithmic feature** (auto-grouping similar regions, zoom-dependent
  cluster collapse) is **Later** (see §14) and must not be conflated with the density
  *read* the current map already provides.

---

## 10. Overlap Behavior (corrected)

Overlapping positions are a real, expected situation — not an error:

- **Each sample record possesses its own persisted V2 position.** Multiple samples may have
  the same or nearly the same position.
- The map must **technically accommodate** this (points can coincide after deterministic
  analysis).
- **No concrete visual overlap resolution is invented in this specification.** The "denser
  representative is shown" statement from the earlier draft is **removed** — there is no
  defined rule for it, so it is not asserted as behavior.
- **V1 requirement:** overlapping samples must remain **selectable / reachable**. A user
  must be able to reach any member of an overlapping cluster to inspect, preview, and
  select it.
- A **detailed overlap visualization** (expansion, stacking, lens, cluster-fan, etc.) may be
  specified as a **later UX feature** (§14, §17 open on exact technique).

---

## 11. Sample Inspection & Search

### 11.1 Inspector — Sample Details
Selecting a point opens an inspector. The following are **V1 (essential)** fields:

- **sample owner / creator** — shown; a clue for provenance and filtering.
- **sample name**
- **sample ID** (Audiotool `sampleId`) and content identity (for provenance).
- **original Audiotool tags** — read-only; SampleMap does not overwrite them (§11.4).
- **classification** — primary class + confidence (0..1) + secondary classes (descending),
  presented as an *estimate*, never ground truth (§11.4).
- **classification confidence** — always shown.
- **map position** — X / Y (or the axis reading Tonal↔Noisy / Dark↔Bright). For a
  Missing-V2 record this is "unavailable", never fabricated (§13).
- **sample availability / visibility** — public / unlisted / private / unknown; a hint
  whether the sample is in the accessible pool (§§8, 15).
- **analysis status** — analyzed / pending / failed / gone.

**Later/Optional:** full 14-field audio-feature readout (the *data* exists; exposing all
fields is optional — a subset such as duration, channels, sample rate may be shown by
default).

**Out of scope (this spec):** editable metadata / tag-writing from the inspector, waveform
display/editing, social/derived content (§14).

### 11.2 Search & Filtering over the Public Pool
Search is deterministic and text-driven over the local index (`src/search/searchEngine.ts`),
optionally filtered by classification. Search supports at least:

- **Name**
- **Creator/Owner** (search and/or filter by owner; the data model supports `owner`
  queries).
- **Original tags**
- **Primary classification**

Classification filtering uses the **existing classifier taxonomy** (22 concrete classes, not
invented categories):

- `drums`: `kick`, `snare`, `clap`, `hihat`, `openhat`, `tom`, `cymbal`, `percussion`
- `musical`: `bass`, `synth`, `piano`, `guitar`, `strings`, `keys`, `pad`, `lead`
- `other`: `vocal`, `fx`, `atmosphere`, `noise`, `loop`, `other`

### 11.3 Behavior
- **Text search** matches name, owner, and original tags (and primary class as appropriate).
- **Classification filter** narrows by primary class and/or class group (drums / musical /
  other) using the exact class set above.
- **Owner/creator filter** narrows by owner, where supported by the existing architecture
  (the index supports `owner` queries).
- **Combined filtering** (search + classification + owner) is supported and deterministic.
- **Confidence display** is supported (always shown with classification).
- **Confidence threshold UI** ("only classes with confidence ≥ X") is **Later/Optional**;
  low-confidence results are never silently discarded, only filtered on explicit user
  request.
- A filter yielding no results shows the distinct message: **"No samples match your
  search."** (§15), distinct from the empty-pool message **"No analyzed samples yet."**.
- **Canonical V1 no-match message:** the single, normative no-match string for the V1
  product is **"No samples match your search."** — used consistently across the map empty
  state and the results list (the only acceptable V1 no-match copy).

### 11.4 Classification UX — honesty & no tag-writing
The classifier is **NOT ground truth** and must never be presented as such. SampleMap may
use the classifier's label for *display* and *filtering*, but it **never overwrites or
rewrites Audiotool metadata or tags** (including an owner's tags). Tag-writing is **out of
scope unless explicitly confirmed** (§17; the current app is read-only over tags).

UI obligations:
- Always render confidence (V1) so the user can discount low-confidence labels.
- Flag low-confidence samples in the inspector and consider a visual cue on the map.
- Secondary classes are shown ordered by confidence so a "near-miss" (e.g. hihat vs
  openhat, both drum-family) is understandable rather than presented as a hard error.
- Confidence is a display/filter discriminator; it is never used to hide or drop points.

---

## 12. Audiotool Actions & Indexing

### 12.1 Audiotool Actions
The Audiotool integration mechanism (OAuth via `@audiotool/nexus`, resource access,
Machiniste creation) is proven and **not redesigned** (§3 rule 5). The following are the
**11 implemented/documented Audiotool capabilities supporting the V1 design**, with live
verification status **varying by capability** (`SAMPLEMAP_V1_SPEC` §2 and
`MACHINISTE_SAMPLE_ACCESS_POC.md`). Each item is labeled with its current status:
**implemented / tested / live verified / documented POC / unproven.**

1. OAuth login via `@audiotool/nexus` — **implemented, live verified** (Node/PAT).
2. `client.samples.list()` pagination over accessible public samples — **implemented**;
   the call is unscoped (owner-agnostic). See cross-user note below.
3. **Foreign public samples are reachable** — **implemented (owner-agnostic integration)**,
   but real backend confirmation that `list()` returns samples owned by other users is
   **UNPROVEN** in the current verification environment.
4. `samples.get()` resolves a sample (any public id) — **implemented, live verified**
   (Node/PAT).
5. Audio preview / download is obtainable (source of preview + analysis decode) —
   **implemented, partially live verified**.
6. A real Audiotool project can be opened and modified via Nexus — **implemented,
   offline-tested** (documented POC for the live project surface).
7. Machiniste (project entity) creation — **implemented, offline-tested**.
8. Machiniste modification once created — **implemented, offline-tested**.
9. **Direct `sampleName` reference of a foreign public sample** (insert-by-reference) —
   **implemented and offline-POC tested**; real backend acceptance of a foreign
   sample reference is **UNPROVEN until an authenticated live Layer-C run is available**.
10. **No-audio-persistence invariant** (SampleMap stores analysis + identity, not audio
    bytes) — **implemented, tested, architecture-verified** (asserted at every persistence
    layer).
11. The analyzed/classified/map-positioned pipeline produces persisted results that other
    steps consume (the persisted-map foundation) — **implemented, tested, live verified**.

**Cross-user verification status (binding, from the STEP16R Formal Review F-02):**
- Cross-user public sample access is **implemented / owner-agnostic** in the current
  integration, but live backend confirmation that `samples.list()` returns foreign public
  samples remains **UNPROVEN** in the current verification environment (STEP16M Layer C is
  currently **BLOCKED** — no authenticated live browser session was available).
- Foreign public sample → direct Machiniste reference is **implemented and offline-POC
  tested**, but real backend acceptance remains **UNPROVEN** until an authenticated live
  Layer-C run is available.
- This is a **verification gap**, not a confirmed technical impossibility (see §17 OQ-6 /
  OQ-9).

**Product-facing behavior**
- **Action: Connect Audiotool (sign in).** V1. Grants access to the accessible public
  sample pool for indexing.
- **Action: Index / re-index the pool.** V1 (on-demand, idempotent, no re-analysis of
  already-indexed samples).
- **Action: Insert sample(s) into the user's project** via Machiniste as direct references.
  V1, *gated* on confirmed usage (§13).
- **Read-only metadata exposure** (name, owner, tags, visibility) — V1 for inspection and
  filtering (§11).
- **Out of scope (Audiotool side):** publishing/pushing tags or metadata back to
  Audiotool, private-sample management, social actions, API-level administration.

### 12.2 Indexing & Analysis UX
- **Entry:** indexing begins after Audiotool connection, on user action (V1). It may run in
  the background; progress must be visible and non-blocking (the map updates as results
  land).
- **Scope:** indexing covers the **accessible public sample pool** (own and foreign public
  samples), not only the logged-in user's samples.
- **Idempotent:** re-running indexing does not re-analyze already-indexed samples; it
  catches new/changed ones and removes or flags inaccessible ones.
- **Per-sample lifecycle** is exposed: `pending → analyzed` (success) or `failed` / `gone`
  (unavailable). Failures are reported per sample at the indexing layer, not silently.
- **Unanalyzable inputs** (silence / corrupt / unsupported format) produce no point; the
  user is told which inputs failed and why, at the indexing surface.
- **Freshness:** analyzedAt / analysisBuild / analysisVersion are captured so the user can
  see *when* and *with which build* a sample was analyzed. This underpins identification of
  stale analysis.

---

## 13. Machiniste Workflow & Direct References

Machiniste is how the user **acts** on selected samples: create/modify an Audiotool project
entity and reference accessible public samples directly (`src/machiniste/` +
`src/machiniste/machinisteService.ts`; direct Nexus reference, no re-upload, no local
copy). The flow:

```text
Audiotool Public Sample
        ↓
SampleMap
        ↓
Select Sample(s)
        ↓
Direct Audiotool Sample Reference
        ↓
Machiniste
```

**Key principles:**
- **No audio re-upload.** SampleMap sends the Audiotool sample reference, not audio.
- **No local sample copy.** SampleMap does not keep a copy of the sample for Machiniste.
- **No own sample-file management.** The sample remains an Audiotool sample; SampleMap only
  references it.
- **Direct reference** to the Audiotool sample (`sampleName`), including **foreign public
  samples** created by other users.
- **Batch maximum = 8.** A single batch action handles at most `MAX_BATCH_SLOTS=8` samples.
  The UI selection is capped at 8 (§9.3); a ninth sample cannot be added at the UI layer.
- **Read-back verification** per the existing POC (send + read back to confirm references
  landed).

### Behavior
- **Send selection to Audiotool** — creates a Machiniste entity that references the
  selected samples by their Audiotool sample reference.
- **Batch bound (V1 Selection Limit):** a `send` is bounded by `MAX_BATCH_SLOTS=8`; a
  selection of **1–8** samples is sent. The UI selection layer caps the active selection at
  8, so a >8 selection is **not a regular UI flow**. The Machiniste service retains an
  **independent defensive >8 rejection** (`buildPlan` throws a validation error when a
  caller bypasses the UI cap); it is not surfaced as a normal UI dialog (no silent
  truncation, no silent partial send).
- **Send + read-back verification:** after sending, SampleMap reads back to confirm the
  references landed (visible in the verified STEP16M flow).
- **Usage-acceptance gate:** publishing is gated on verified Machiniste usage (usage
  acceptance, `src/global/usageAcceptance.ts`) — the user must have used the tool
  meaningfully before global publish is permitted; the UI reflects this gate rather than
  silently failing.
- Proven steps (from STEP16M e2e): scan → analyze/classify/map → points → select →
  Machiniste send → read-back → reload persistence. The product must keep this sequence
  intact.

### Out of scope in near-term
- Arbitrary project assembly / arrangement of multiple samples into a musical arrangement.
- Automatic project naming or templating (Open, §17).

---

## 14. Scope Consolidation

### 14.1 Current-GUI Status (functional POC, not final design)
The current GUI is a **functional / technical proof-of-concept**, and it is **NOT the final
visual design**. It faithfully demonstrates and verifies behavior
(scan/analyze/classify/map/select/preview/inspect/Machiniste send/persist-reload) but its
colors, fonts, shadows, spacing, icons, layout, and other visual styling are provisional.

- **The Final UI/UX Design phase** (a separate, later phase) owns all visual styling and
  the polished presentation layer. §14 in no way implies the current look is final.
- STEP16R defines **product behavior and UX foundations** — interactions, states,
  navigation, selection, preview, inspector, search, filter, indexing, loading, errors,
  Missing-V2, Machiniste actions, empty states — but **not** the final visual language
  (colors, typography, spacing, icons, animations, layout aesthetics). Those belong to a
  later **Final UI/UX Design step**.

### 14.2 Indexing distinction
SampleMap has **no own copy of the sample pool**. The local index contains only metadata
and analysis results (§8). This distinction holds for all of V1.

### 14.3 V1 vs Later vs Out of scope — Scope Table

**V1 must contain:**
- Audiotool Authentication / Connection
- Access to the accessible public Sample Pool
- Sample Index (local metadata + analysis)
- Sample Analysis
- Persisted V2 Map Position
- 2D Map
- Pan
- Zoom
- Sample Selection
- Multi-Selection
- Sample Inspector (incl. owner/creator, name, ID, original tags, classification,
  confidence, map position, availability, analysis status)
- Audio Preview (single-playing, ephemeral)
- Search (name, owner, original tags, primary classification)
- Classification Filter (existing 22-class taxonomy)
- Creator/Owner information (shown + searchable/filterable where supported)
- Classification + Confidence
- Original Tags (read-only)
- Audiotool Sample Identity
- Indexing / Re-indexing (over the accessible pool)
- Persistence / Reload
- Error States
- Missing-V2 State
- Machiniste insertion by direct reference
- Batch insertion 1–8 samples
- Read-back verification

**Later / Optional:**
- advanced overlap resolution
- sophisticated clustering
- confidence threshold UI
- saved viewport (restore last viewport on reload)
- advanced visual encodings
- advanced similarity search
- waveform editing
- audio processing
- local audio storage
- tag writing
- social features

| Feature | Classification | Notes |
|---|---|---|
| Audiotool auth + access public pool | V1 | Implemented capabilities (§12.1); cross-user live status varies |
| Sample index + analysis | V1 | Local metadata + analysis only, no audio |
| Persisted V2 map position | V1 | Frozen; authoritative; no recompute |
| 2D map of persisted positions | V1 | Centerpiece |
| Pan / zoom (1→2→4→8) | V1 | Current GUI |
| Single + multi selection | V1 | Map and/or list; bounded at send |
| Deselection / clear selection | V1 | Explicit |
| Sample inspector | V1 | Essential field set (§11.1) |
| Audio preview (ephemeral, single-player) | V1 | No audio caching |
| Search: name / owner / tags / class | V1 | Existing search + owner support |
| Classification filter (22 classes) | V1 | Existing taxonomy |
| Classification + confidence display | V1 | Estimate, not ground truth |
| Creator/Owner info | V1 | Shown + filter where supported |
| Original tags read-only | V1 | Never overwritten |
| Audiotool sample identity | V1 | sampleId + content identity |
| Indexing / re-indexing | V1 | Over accessible pool; idempotent |
| Persistence & reload determinism | V1 | Verified |
| Error / empty / unavailable states | V1 | Explicit, non-fatal |
| Missing-V2 state | V1 | "Map position unavailable" |
| Machiniste insert by direct reference | V1 | No re-upload |
| Batch insertion 1–8 + read-back | V1 | MAX_BATCH_SLOTS=8; UI selection capped at 8; service >8 guard defensive |
| Density read as discovery aid | V1 (read) / Later (feature) | Visual crowding now; clustering later |
| Overlap reachability | V1 (requirement) | Detail visualization Later |
| Restore last viewport on reload | Later | Optional nicety |
| Sophisticated clustering / cluster collapse | Later | Distinct from density read |
| Confidence threshold UI | Later/Optional | Explicit only, never implicit |
| Advanced visual encodings | Later | Beyond current rendering |
| Advanced similarity search | Later | Beyond name/tag/class |
| Full 14-field audio-feature readout | Optional | Data exists |
| Overlap visualization detail | Later | Exact technique Open (§17) |
| Waveform editing | Out of scope | Not a DAW |
| Audio processing | Out of scope | Not an editor |
| Local audio storage / caching | Out of scope | Binding invariant |
| Tag writing | Out of scope (unless confirmed) | Read-only over tags |
| Social features | Out of scope | Not a platform |

The product remains a **focused MVP**: **public pool → map → find (look / hear / search /
filter) → inspect → insert by direct reference**, built solely on the verified architecture.

---

## 15. Missing-V2 & Empty / Error States

### 15.1 Missing-V2 Behavior
`Missing-V2` is the state of a record that carries **no persisted V2 `mapPosition`**. This
occurs for pre-V2 records (analyzed before the V2 map existed), and it is a legitimate,
distinguished state — not an error and not a placeholder.

**Rules (binding, per §3):**
1. A Missing-V2 record has **no V2 map point** — not fabricated at a guessed position, not
   silently placed at origin/center.
2. **No V1 calculation.**
3. **No reconstruction from AudioFeatures.**
4. **No automatic replacement position.**
5. Downstream consumers that require positions (map, publish candidate) treat Missing-V2 as
   "not on map / not publishable-redirect", surfaced read-only rather than fatal.

**Product/UX manifestation:**
- Map: Missing-V2 samples are excluded from point rendering; the map never shows a
  fabricated position.
- Inspector: position is shown as **"Map position unavailable"** (a clear, distinguished
  state), never a fake number, and the reason (no persisted V2 position) is surfaced.
- Publish path: a candidate without a persisted `mapPosition` cannot be included in a
  publish (guarded) — surfaced as a clear, actionable message, not a crash.
- **Remediation:** a later **re-analysis** (which produces V2 `mapPosition` once) may be
  provided, but it must **not** be implied or invented implicitly in this spec; whether it is
  automatic, per-sample, or batch is an open question (§17). The current app keeps the state
  honest and read-only.

### 15.2 Empty / Error / Availability States
All states are explicit and guide the user; none is a silent blank/failure.

- **Empty pool (no analyzed samples):** message **"No analyzed samples yet."** + a path to
  connect Audiotool / start indexing.
- **No match (filter/search yields nothing):** message **"No samples match your search."**,
  distinct from the empty-pool message.
- **No sample selected:** preview / inspector show a benign "no sample selected" prompt,
  not a crash.
- **Local index unavailable:** preview / map show a clear offline / local-unavailable state.
- **Global unavailable:** a "Global: unavailable (local map still works)" banner keeps the
  core map usable even when the global layer cannot load. Global analysis present but
  incompatible version → shown read-only with an explanation.
- **Inaccessible / private / unavailable sample** (not part of the accessible public pool,
  or reference no longer reachable): shown read-only as **"unavailable"** with its
  visibility; preview reports the audio error non-blockingly.
- **Loading / indexing in progress:** visible, non-blocking progress; the map updates as
  results land.
- **Low-confidence / Missing-V2:** shown with the flags described in §§11/15.1; never a
  data-loss appearance.

---

## 16. Persistence & Reload

- All analysis outcomes (audio features, classification, persisted V2 `mapPosition`,
  analysis metadata) are stored in the **SampleMap local index** (`SampleIndexRecord`) and
  survive reload. Audio is **never** persisted (§§3, 4, 8).
- On reload, the app hydrates records and re-reads persisted positions — it does **not**
  recompute them (§3). The STEP16M reload scenario (16M-12) verifies this: the map and
  inspector look identical before and after reload.
- **Determinism is a product guarantee:** same index → same map, every time. This is a
  verified property (STEP16M-07 positional determinism; live-verify comparing persisted
  `rec.mapPosition === computePosition(...)`).
- Missing-V2 records persist their absence as a stable state (§15.1).
- Metadata (owner, name, tags, visibility, classification, confidence) survives reload;
  only analysis/metadata are stored — **no audio bytes persist** (§8).

---

## 17. Open Questions

Only genuine, still-unresolved detail questions remain. Points already decided by this
revision are **not** listed:

- own samples vs public pool → **DECIDED: accessible public Audiotool Sample Pool**
- multi-select V1 vs later → **DECIDED: V1**
- batch limit → **DECIDED: max 8**

Open:

1. **Missing-V2 remediation mechanics:** is a later re-analysis that produces V2 position
   automatic, per-sample, or batch — and does the UI offer an explicit "re-analyze"
   affordance? (Defined as *possible later*, not implied; §15.1.)
2. **Multi-select gesture:** the exact UI mechanics for gathering multiple samples (map
   lasso, modifier-click, list checkboxes) are deferred to the Final UI/UX Design; the
   *behavior* (multi-select is V1, map and/or list, deselect, survives zoom/filter) is
   decided here (§9.3).
3. **Overlap visualization technique:** the concrete visual resolution of overlapping
   points is a Later UX feature; the V1 requirement (reachability) is decided here (§10).
4. **Owner-filter surface:** whether owner filtering is presented as a dedicated filter or
   as plain text search is a UI-detail decision, constrained by the existing architecture
   (owner queries supported); the *capability* is decided here.
5. **Tag-writing confirmation:** is writing/updating Audiotool tags ever desired? Currently
   **out of scope / read-only** (§11.4); only a confirmed product decision changes this.
6. **Cross-user live verification gap (from the FORMAL REVIEW F-02):** This is a
   **verification gap, not a confirmed technical impossibility.** Specifically:
   - Whether the real backend `samples.list()` returns samples owned by other users is
     **live UNPROVEN** in the current verification environment.
   - Whether the real Audiotool backend accepts a **foreign public sample's direct
     reference** in Machiniste is **live UNPROVEN**; only the offline POC validates the
     transaction shape.
   - **STEP16M Layer C (live Audiotool / OAuth / live Machiniste) is currently BLOCKED**
     (no authenticated live browser/Audiotool session was available). Closing this gap
     requires an authenticated live Layer-C run.
7. **Global worker / D1 production state:** the worker subproject typechecks and tests
   green, but its production deployment/state is not fully verified product behavior;
   the global-publish UX (gated on usage acceptance) is specified, and its production
   contingency (including live sample publish, which STEP16M reports as blocked) is Open.
8. **Machiniste project naming/templating** (§13) — acceptable defaults or user-provided
   names? Open.
9. **Large-library rendering strategy** — virtualization/culling vs eager render — is an
   implementation-phase optimization decision.
10. **Proximity semantics beyond V2 axes:** any notion of similarity beyond "similar
    characteristics along the defined V2 axes" (e.g. "sounds the same") is an open product
    question, explicitly **not** promised (§4.1).

> Note: the decided product questions above (public pool, multi-select V1, batch max 8)
> remain **closed**; the open items above are genuine unresolved details or verification
> gaps, not re-opened product decisions.

---

## 18. Explicit Non-Goals

STEP16R is explicitly **not** the following:

- **Not an implementation.** No source, test, config, formula, persistence, classification,
  API, or GUI code is changed. STEP16R produces only this specification, and only
  `STEP16R_SPEC.md` is modified by this step.
- **Not a redesign of the map model.** The V2 map position, its formula, and its axis
  semantics are FROZEN; STEP16R does not normalize, retune, or reinterpret coordinates.
- **Not a reintroduction of V1 fallback or on-read recompute.** Both are prohibited (§§3, 4,
  13).
- **Not a redesign of OAuth/Nexus/Machiniste.** The proven mechanism is assumed; only its
  product-facing behavior is described (§§12, 13).
- **Not permanent audio storage or caching.** Prohibited subsystem (§§3, 4, 8, 9, 14).
- **Not a DAW/editor.** No waveform editing, arrangement, dragging to arrange, or audio
  mangling (§14).
- **Not a metadata/tag-writer to Audiotool.** Metadata is read-only unless explicitly
  confirmed (§§11, 17).
- **Not a social/community platform.** No favorites, playlists, collections, sharing,
  follows, or profiles (§14).
- **Not a sample database / own copy of the pool.** SampleMap holds only a local index of
  metadata + analysis; the audio stays in Audiotool (§8).
- **Not the Final visual design.** The current GUI is a functional POC; final colors, fonts,
  spacing, and styling belong to a later Final UI/UX Design phase (§14), which this spec
  does not and must not pre-empt.
- **No invented overlap resolution.** Concrete overlap visualization is not invented here;
  only the V1 reachability requirement is defined (§10).

---

## 19. Acceptance Criteria

For the near-term V1 product (each is a user-observable, testable property; mapped to the
verified STEP16M flows and the corrected product definition):

- **AC-1 (Map renders indexed pool):** After indexing, every analyzed sample with a
  persisted V2 `mapPosition` appears as a selectable point at its persisted `{x,y}` —
  **including samples owned by other Audiotool users** (from the accessible public pool).
- **AC-2 (Determinism):** Reloading yields the same points in the same positions with the
  same DOM coordinates (16M-07, 16M-12).
- **AC-3 (No fabrication / Missing-V2):** No point is shown for a Missing-V2 record (no
  fallback, no recompute, no origin placement); the inspector shows **"Map position
  unavailable"** (§15.1).
- **AC-4 (Navigation):** Pan and zoom work across 1→2→4→8; points remain hit-testable
  within the 10px radius (§9.2).
- **AC-5 (Preview):** Selecting a point previews exactly that sample; one audio plays at a
  time; audio is never persisted (§9).
- **AC-6 (Search/filter):** Text search (name/owner/tags/class) and classification filter
  (exact 22-class taxonomy) return deterministic results; empty-match shows **"No samples
  match your search."** (§11).
- **AC-7 (Classification honesty):** Confidence is always visible; low-confidence samples
  are flagged; SampleMap never writes/tags back to Audiotool (§11.4).
- **AC-8 (Inspection):** The inspector shows the V1 field set (§11.1): owner/creator, name,
  sample ID, original tags (read-only), classification + confidence + secondaries,
  availability/visibility, analysis status, position (or "unavailable" for Missing-V2).
- **AC-9 (Multi-select):** The user can select up to 8 samples (on the map and/or list),
  deselect them, and the selection survives zoom changes and filtering; the selection is
  sent as a set, capped at 8 (§9.3).
- **AC-10 (Machiniste batch 1–8):** Sending a selection of 1–8 samples creates a Machiniste
  entity referencing them by **direct Audiotool sample reference** (no re-upload), with
  read-back verification. The UI selection is capped at 8 (a ninth cannot be added); the
  Machiniste service retains an independent **>8 defensive rejection** for callers that
  bypass the UI cap, which is **not** a regular UI flow (§9.3, §13).
- **AC-11 (Public-pool foreign sample full path):**
  - **Requirement:** A publicly accessible sample **owned by another Audiotool user** must be
    indexable, analyzable, mappable, inspectable, previewable, and insertable into Machiniste
    **by direct Audiotool sample reference, without copying the audio into SampleMap**
    (§§5, 12, 13).
  - **Current verification status: PARTIALLY VERIFIED / LIVE UNPROVEN.** The repository
    implements the owner-agnostic path and the direct-reference mechanism, and the offline
    POC validates the transaction shape. Real backend confirmation of foreign-sample
    listing and foreign-sample acceptance by Machiniste requires an authenticated live
    Layer-C run, which is currently **BLOCKED** (no live Audiotool session in this
    environment) — see §12.1 cross-user status and §17 OQ-6 / OQ-9.
- **AC-12 (Indexing UX):** Indexing over the accessible public pool is incremental,
  idempotent, and non-blocking; failures and unanalyzable inputs are reported explicitly
  (§12.2).
- **AC-13 (States):** Empty-pool, no-match, no-selection, local-unavailable,
  global-unavailable, inaccessible/private, and gone-sample states are all explicit and
  non-fatal (§15.2).
- **AC-14 (Empty-pool first-use):** First-use shows **"No analyzed samples yet."** with a
  path to connect/index, not a silent blank.
- **AC-15 (No audio persistence):** Across all scenarios, no audio bytes are stored by
  SampleMap; only metadata/analysis persist (§§8, 16).
- **AC-16 (Owner/creator):** Owner/creator is visible in the inspector and searchable/
  filterable where supported by the existing architecture (§§7, 11).

---

## 20. Verification Plan

- **Already verified by STEP16Q / STEP16M (baseline to keep green):** app test suite
  (540/32), worker suite (19/19), Playwright STEP16M (20/20 incl. 16M-07 determinism,
  16M-12 reload, Machiniste send/read-back), tsc 0 errors, vite build PASS, real-data
  11/11 acceptance checks.
- **For this spec's acceptance criteria**, verification is behavioral through the existing
  harness. Define scenarios for:

  **Public Pool**
  - own sample
  - sample from another (foreign public) user
  - inaccessible / private sample (shown as unavailable, not fabricated)

  **Analysis**
  - valid sample (analyzed → persisted V2 position)
  - failed analysis (reported at indexing layer)
  - Missing-V2 (no point; "Map position unavailable" in inspector)

  **Map**
  - persisted coordinates render at stored `{x,y}`
  - reload (same layout)
  - pan
  - zoom (1→2→4→8)
  - overlapping points remain selectable/reachable

  **Selection**
  - single
  - multiple
  - deselection
  - filter interaction (selection survives / set semantics)

  **Machiniste**
  - 1 sample (1–8 batch)
  - 8 samples (max — the UI selection cap; a ninth cannot be added at the UI layer)
  - service >8 defensive rejection (direct send() call bypassing the UI cap → rejected;
    not a regular UI flow)
  - read-back verification

  **Persistence**
  - reload browser / session
  - metadata survives
  - `mapPosition` survives
  - **no audio bytes persist** (AC-15, invariant)

- **Determinism check:** persisted `rec.mapPosition === computePosition(...)` (already used
  by `scripts/step16m-live-verify.ts`) remains the guard for AC-2/AC-3.
- **Verification is read-only for STEP16R:** this document only *specifies* checks; it does
  not add or run them in this phase.

---

## 21. Explicit Non-Goals (re-asserted as a dedicated boundary)

Re-stating the hard boundaries so implementation cannot misread this spec as permitting
changes outside its files:

- Only `STEP16R_SPEC.md` is delivered and modified by this step.
- No source, test, build, data-model, UI, or script changes are made.
- The STEP16Q map model/formula is frozen and unchanged.
- No audio is persisted; no local copy of the pool is created.
- No V1 fallback, no recompute, no fabricated positions.
- No invented overlap resolution (only reachability is required).
- No visual final design is produced here — that is a distinct later **Final UI/UX Design
  step**.

---

## 22. STOP CONDITION

This phase ends — and implementation must **NOT** begin — until the following together hold:

1. **This specification (`STEP16R_SPEC.md`) is complete, reviewed, and internally
   consistent**, covering all sections with the V1 / Later / Out-of-scope boundaries settled
   and no contradictions among: public pool vs own samples; multi-select vs Machiniste batch
   (1–8, >8 rejected); overlap behavior (reachability V1, visualization Later); persisted V2
   `mapPosition` (authoritative, no recompute); no V1 fallback; transient audio (no
   persistence); direct Audiotool sample references; V1 vs Later; and functional POC vs
   Final UI/UX Design.
2. **Zero unintended code/configuration change occurred during STEP16R.** Only
   `STEP16R_SPEC.md` was added/modified; the verified STEP16Q baseline (540 app tests,
   worker 19/19, STEP16M 20/20, tsc 0 errors, build PASS, 11/11 real-data checks) remains
   untouched.
3. **The product owner has confirmed** the corrected product definition (accessible public
   Audiotool Sample Pool, §5), the V1 scope (§14), the interaction/state definitions
   (§§9–13, 15), and the open questions (§17).
4. **The Final UI/UX Design step is understood as separate** (owns all visual styling,
   §14) so this spec's functional foundation is not mistaken for the final look.
5. **Open questions (§17) are acknowledged and triaged** (not necessarily all resolved).

Once the above hold, a successor phase (a Final UI/UX Design step and/or a V1 implementation
phase) may begin — explicitly **not** during STEP16R, and not by retroactively
reinterpreting this spec into code.

---

**STEP16R SPECIFICATION COMPLETE — IMPLEMENTATION NOT STARTED**
