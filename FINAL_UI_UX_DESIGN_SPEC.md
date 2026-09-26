# FINAL UI/UX DESIGN SPECIFICATION — SAMPLEMAP

**Version:** 1.1
**Status:** SPECIFICATION COMPLETE — IMPLEMENTATION NOT STARTED
**Scope:** Visual + Interaction Design (DESIGN ONLY)
**Binds:** Final UI/UX implementation of SampleMap
**Depends on:** STEP16Q (Technical / Map Foundation), STEP16R (Product & UX Foundation)

**Revision note — v1.1 (consistency and implementation-readiness patch):**
- Resolved focus vs selection semantics
- Deterministic overlap ordering
- Zoom-dependent overlap semantics
- Density rendering boundaries
- Classification filter matching
- Low-confidence threshold ownership
- Foreign-public integration verification wording
- Visibility vs availability terminology
- Missing-V2 reachability
- Result-list role
- Escape behavior
- Cross-platform reset shortcut
- Keyboard/map interaction

---

# 1. ABSOLUTE BOUNDARIES

## 1.1 This document is DESIGN ONLY

This specification defines the **visual and interaction design** of SampleMap from the
finalized `STEP16R_SPEC.md` product foundation. It does **not** change, and must **not**
be read as authorizing changes to:

* Source code
* Tests
* Build configuration
* Data model
* API
* Nexus integration
* Audiotool integration
* Analysis pipeline
* Classifier
* Map formulas
* Persistence
* Worker / concurrency
* Machiniste service

**Only the file `FINAL_UI_UX_DESIGN_SPEC.md` is created by this design phase.**

The design contract chain is:

```text
STEP16Q  (Technical / Map Foundation)
    ↓
STEP16R  (Product & UX Foundation)
    ↓
FINAL UI/UX DESIGN  (Visual + Interaction Design)   ← this document
    ↓
Implementation
```

STEP16Q and STEP16R are frozen. This document is the binding design contract that the
Implementation step must follow without re-inventing visual or UX decisions.

---

# 2. VERBINDICHE / BINDING BASIS

This document is grounded in the current authoritative state of the repository, including:

* **STEP16R_SPEC.md** — Product & UX Foundation (public sample pool, multi-select max 8,
  direct reference semantics, classification honesty, Missing-V2, search, filters, owner,
  preview, Machiniste, explicit states).
* **STEP16Q** — Technical / Map Foundation.
* **STEP16P_MAP_DESIGN.md** — Map formula design.
* **SAMPLEMAP_V1_SPEC.md** — V1 product scope.
* Current source facts (verified from the frozen repo):
  * Map viewport `MAP_WIDTH=800`, `MAP_HEIGHT=520`; zoom `1x/2x/4x/8x`
    (`MIN_ZOOM=1`, `MAX_ZOOM=8`, `ZOOM_STEP=2`, `DEFAULT_ZOOM=1`).
  * Point hit radius `POINT_HIT_RADIUS_PX=10`; drag threshold `DRAG_THRESHOLD_PX=4`.
  * Machiniste batch bound `MAX_BATCH_SLOTS=8`; service rejects `>8` defensively.
  * Classifier is a **22-class taxonomy**; classification is an **estimate**.
  * Preview is a **transient ObjectURL**, single-playing.
  * Persistent sample record carries `owner`, `visibility`
    (`public` / `unlisted` / `private` / `unknown`), `originalTags`, and `mapPosition?`.
  * `mapPosition` is **persisted and authoritative** (`mapVersion="map-v2"`); there is
    **no V1 fallback** and **no recompute** from `AudioFeatures`.

## 2.1 STEP16Q rules that remain untouched

These are **hard invariants** this design must never contradict:

* `mapPosition` is **persisted and authoritative**.
* `mapVersion = "map-v2"`.
* **No V1 fallback** — the legacy `mapPosition(features)` function was removed.
* **No reconstruction** of position from `AudioFeatures` on read.
* **No UI-side recomputation** of position. The UI only *renders* persisted coordinates.
* Missing-V2 means the sample has **no available position** — it is not placed anywhere.
* **Audio is not persisted** by the UI; audio is used transiently for analysis/preview.
* **No change** to the V2 formula.

---

# 3. DESIGN GOAL

SampleMap is a **high-quality, modern, professional sample-browsing application for
musicians and sound designers**.

The central idea:

> **Audiotool's public sample pool becomes a visual soundscape.**

SampleMap must **not** feel like an ordinary table-/file-browser app.

The most important visual element is:

# THE SAMPLE MAP

The map is **not merely an additional view**. It is the **primary navigation and
discovery mechanism**. The user should think intuitively:

```text
see
  ↓
discover a region
  ↓
select samples
  ↓
listen
  ↓
inspect details
  ↓
use in Audiotool
```

Everything else in the product exists to serve the map and this mental flow.

---

# 4. XO-INSPIRATION — BUT NOT A COPY

STEP16R defines SampleMap explicitly as a visual sample map of points (a soundscape).

The visual direction may borrow **concepts** from XO-style sample browsers:

* Samples as points.
* A spatial soundscape.
* Density as visual information.
* Fast exploration.
* Direct interaction.
* Visual grouping.

## What is adopted from XO-style concepts

| Concept | How SampleMap adopts it |
| --- | --- |
| Samples as points | Each analyzed sample is a map point at its persisted V2 position. |
| Spatial soundscape | Points populate a 2D tonal/brightness space. |
| Density as information | Region point-count is conveyed by overlap/glow/opacity (see §9). |
| Fast exploration | Hover-preview and one-click select; no modal walls. |
| Direct interaction | Click on point = inspect; double-click = preview; modifier = multi-select. |
| Visual grouping | Nearby timbres naturally cluster in map space. |

## What is deliberately different — and why

| XO-style tendency | SampleMap decision | Why it fits SampleMap |
| --- | --- | --- |
| Heavy 3D/parallax/emissive "instrument" look | Flat-to-subtle-depth 2D map, restrained glow | Position/selection clarity and long-session comfort; the map is a *browser*, not a synth. |
| Aggressive neon on black | Muted, professional dark palette with a single accent | Readable metadata, classification honesty, professional studio feel. |
| Cluster "bubbles"/automatic grouping | No invented cluster algorithm in V1 (§9) | STEP16R forbids inventing an algorithmic cluster feature; we only visualize existing points. |
| Decorative motion | Guideline-limited, purpose-driven motion (§29) | Interaction must aid orientation, not decorate. |

**SampleMap defines its own visual identity** — a calm, grounded, "sonic cartography"
aesthetic with one clear accent color — rather than reproducing any single product.

---

# 5. VISUAL IDENTITY

## 5.1 Color world

*Rationale:* The product runs for long, focus-heavy sessions (browsing/previewing samples).
Dark UI is preferred to reduce glare and make map density and selection states pop. The
palette is desaturated and professional, with **one** functional accent, plus a small,
semantically fixed set of status colors. Every color is also expressed as a design token
(§34).

### Core surface colors

| Token | Hex | Use |
| --- | --- | --- |
| `--bg-app` | `#0F1115` | Main application background. |
| `--bg-map` | `#13161C` | Map canvas background (slightly lighter than app bg to read as a "ground"). |
| `--bg-panel` | `#181C23` | Side panels (filter / inspector) and cards. |
| `--panel-raised` | `#1E232C` | Raised surfaces (hover of cards, popovers, toasts). |
| `--panel-strong` | `#14171D` | Nested/secondary inside panels. |
| `--border-weak` | `#232933` | Panel/card borders (default). |
| `--border-strong` | `#2E3642` | Hover/active borders. |

### Text colors

| Token | Hex | Use |
| --- | --- | --- |
| `--text-primary` | `#E7EAF0` | Primary text. |
| `--text-secondary` | `#A6AEB9` | Secondary text, metadata labels. |
| `--text-tertiary` | `#6B7380` | De-emphasized/captions/disabled-ish hints. |
| `--text-disabled` | `#3E4550` | Disabled elements. |

### Accent + state colors

| Token | Hex | Use |
| --- | --- | --- |
| `--accent` | `#4C8DFF` | Primary accent — highlights, primary action, primary interactive focus. |
| `--accent-hover` | `#6BA1FF` | Hover on accent elements. |
| `--selection` | `#FFB84D` | X-selected point/row accent (distinct from the blue accent). |
| `--selection-alt` | `#3A2A12` | Subtle selection fill/glow underlay. |
| `--hover` | `#8A93A3` | Hover outline/point stroke on the map. |
| `--warning` | `#E8B13A` | Warnings / low-confidence. |
| `--warning-bg` | `#2A2414` | Warning-tinted surface. |
| `--error` | `#E86A5A` | Errors. |
| `--error-bg` | `#2B1A17` | Error-tinted surface. |
| `--success` | `#4FBF7A` | Success / read-back OK. |
| `--success-bg` | `#16281D` | Success-tinted surface. |
| `--info` | `#56B6C2` | Informational (indexing activity). |
| `--low-conf` | `#C9A227` | Timbre-based low-confidence indication (§21). |
| `--missing-v2` | `#6B7380` | Missing-V2 identifier (map-grey (§22)). |

### Availability-state tokens

| Token | Hex | Use |
| --- | --- | --- |
| `--avail-public` | `#4FBF7A` | Public sample owner/availability badge. |
| `--avail-unlisted` | `#56B6C2` | Unlisted badge. |
| `--avail-private` | `#E8B13A` | Private badge. |
| `--avail-unknown` | `#8A93A3` | Unknown availability badge. |
| `--avail-unavailable` | `#6B7380` | Unavailable reference. |
| `--avail-gone` | `#E86A5A` | Gone (deleted in Audiotool). |

*Rule:* Availability badges are small, secondary, and never dominate the map. Most map
points show **no** availability color at rest (§23) to keep density readable.

---

## 5.2 Typography

*Rationale:* A professional, neutral, highly legible UI sans (with tabular numerals for
numeric/confidence values). A monospace face is used **only** for the sample ID (a stable,
scan-anchor value) — not as a general body font.

| Token | Family / Spec | Use |
| --- | --- | --- |
| `--font-ui` | system UI stack: `Inter, -apple-system, "Segoe UI", Roboto, sans-serif` | Body, labels, buttons. |
| `--font-mono` | `"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace` | Sample ID, numeric/confidence table values. |

### Type scale

| Token | Size / Weight / Line-height | Use |
| --- | --- | --- |
| `--h-display` | `20px / 600 / 1.25` | App/Header title. |
| `--h-section` | `13px / 600 / 1.4` | Panel section headings (UPPERCASE, tracked `0.06em`). |
| `--body` | `13px / 400 / 1.5` | Body text. |
| `--metadata` | `11px / 400 / 1.4` | Metadata labels/values. |
| `--button` | `13px / 500 / 1.2` | Button text. |
| `--map-label` | `11px / 500 / 1.3`, tracked `0.03em` | Axis labels (TONAL/NOISY/BRIGHT/DARK). |
| `--insp-label` | `11px / 500 / 1.3` | Inspector field labels. |
| `--numeric` | `12px / 500 / 1.3`, `font-variant-numeric: tabular-nums` | Numeric values (counts, coordinates). |
| `--conf-id` | `12px / 600 / 1.3`, tabular | Primary confidence value. |
| `--mono-id` | `11px / 400 / 1.4`, mono | Sample ID. |

Hierarchy intent: one clear heading per panel, body for the sample name (most important
row text), metadata for support, tabular numerals so counts/confidence don't jitter.

---

## 5.3 Spacing

A modular **4px** grid scale. Consistent gaps between adjacent elements, groups, and
sections.

```text
space-1  =  4px
space-2  =  8px
space-3  = 12px
space-4  = 16px
space-5  = 24px
space-6  = 32px
```

*Within* a panel: `space-2` between siblings, `space-3` between label/value pairs,
`space-4` between logical groups, `space-5` between sections.
*Between* layout regions: `space-4`/`space-5`.

---

## 5.4 Borders / Radius / Shadows

Consistent, restrained. No random mixing.

| Token | Value | Use |
| --- | --- | --- |
| `--radius-sm` | `6px` | Badges, chips, small controls. |
| `--radius-md` | `10px` | Panels, inspector, filter panel, table rows. |
| `--radius-map` | `12px` | Map canvas frame. |
| `--radius-full` | `999px` | Pills, selection count, action bar indicator. |
| `--border-w` | `1px` | All borders. |
| `--shadow-panel` | `0 1px 2px rgb(0 0 0 / .35)` | Panels/canvas. |
| `--shadow-pop` | `0 8px 24px rgb(0 0 0 / .45)` | Popovers/toasts. |
| `--shadow-focus` | `0 0 0 2px rgb(76 141 255 / .40)` | Keyboard focus ring. |

### Selected-state treatment
* Point: enlarged radius + `--selection` stroke + subtle `--selection-alt` glow, distinct
  from the blue accent.
* Row: full-row `--selection-alt` background tint + `--selection` left border (`2px`).

### Hover-state treatment
* Map point: `--hover` outline (±10–14% radius bump) — always reversible.
* Card/row: `--panel-raised` background + `--border-strong`.

---

# 6. GLOBAL APPLICATION LAYOUT

The default **large-desktop** shell. (Responsive behavior in §27.)

```text
+----------------------------------------------------------------+
| HEADER                                    [ search ]  [Connect] |
+----------------+-------------------------+--------------------+
|                |                         |                    |
|   NAV /        |      SAMPLE MAP          |     INSPECTOR      |
|   FILTER       |   (primary surface)      |                    |
|   panel        |                         |                    |
|                |                         |                    |
+----------------+-------------------------+--------------------+
|  STATUS / SELECTION / ACTION BAR                                 |
+----------------------------------------------------------------+
```

## Regions

### Header
* **Left:** Product mark + wordmark `SampleMap`; connection status dot; index status.
* **Center/Left:** Primary search bar (§12) — search is *global*, above panel context.
* **Right:** Reserved actions: e.g. `Refresh index`, `Settings`, and a `Connect Audiotool`
  / connection indicator (first-use, §24/§25).

### Navigation / Filter panel (left)
* Narrow (~240px default, resizable down to 200px).
* Sections: **Classification filters** (§13), then a compact **Owner** quick-filter (§14).
* Collapsible. Collapse does not clear filters.

### Sample Map (center)
* The dominant region (≥60% of app width on large desktop).
* Primary navigation/discovery surface (§7–§11).
* Empty states overlay here (§25).

### Inspector (right)
* Fixed right rail (~300–340px). Shows the **focused** sample's details (§15).
* Shows selection group summary when multiple are selected (§17).

### Status / Selection / Action Bar (bottom)
* Left: contextual status text (count, activity, errors) — §6 Status.
* Right: **Selection + Action bar** (§18): selection count + `Add to Machiniste`.
* Always visible. Shows `0` when nothing selected.

## Navigation (top-level)
In V1 the map is the primary navigation; there is **one** top-level mode: Browser (Map).
No tab-switching between map/list as equal peers — the result list (see Result-List role,
§6) and inspector are integrated panels, not rival nav destinations.

## Primary action
`Add to Machiniste` (§18) — the single primary action, surfaced only when ≥1 sample is
selected, anchored in the action bar.

## Status area
Bottom-left line communicates state without alerting: indexing progress, "X samples",
current filter count, or a non-alarmist error hint with a link to retry (§26).

## Result-List role (binding)

The **result list** (`SampleList`) is an **integrated secondary result surface**, **not a
fourth permanent column** and **not a separate List mode** (there is only one top-level mode:
Browser/Map, see Navigation above).

* On large desktop the **map remains dominant**; the result list stays out of the main flow.
* The result list is available as an **integrated overlay/drawer/panel** associated with
  search/filter results — invoked from search/filter, the overlap `+N more` fan, or the
  Missing-V2 / owner views.
* It must **not permanently consume the majority of the map area**.
* The **map remains the primary navigation surface**; the result list is the
  **keyboard/accessibility alternative to the visual map** (§28.2).
* It uses the **same underlying filtered result set** as the map (single source of truth).
* It does **not** create a second, independent selection model — selecting rows toggles the
  same selection set as the map (§17.1).

---

# 7. SAMPLE MAP — CENTRAL EXPERIENCE

The map is the **primary, dominant** element — the "ground" of the application.

## 7.1 Coordinate presentation

The map renders **persisted** coordinates:

```text
x ∈ [0,1]
y ∈ [0,1]
```

* The UI **never recomputes** `x`/`y` from features (§2.1).
* Rendering maps `x → width`, `y → height` of the canvas as **pure linear projection**
  (no formula change, no transformation beyond the standardized render transform).
* Missing-V2 samples have **no point** (§22).

The map canvas viewport is `800×520` logical units (from STEP16Q), scaled to the region;
zoom/pan transform the camera, never the underlying coordinates (§11).

## 7.2 Axis presentation

*Rationale:* The product labels describe the two perceptual directions of the V2 space.
We must not suggest a stronger acoustic claim than STEP16Q/STEP16R permit — the labels are
**orientation aids** on a *timbral* space, not calibrated acoustic scales.

**Horizontal axis** (bottom of map):
```text
TONAL ───────────── NOISY
```

**Vertical axis** (left/right edge, bottom-up orientation):
```text
        BRIGHT
          │
          │
          │
DARK
```

*Binding orientation:* **Bottom-left = DARK + TONAL; top-right = BRIGHT + NOISY.**
`y` increases upward (brightness up), `x` increases rightward (noisiness rightward).
This matches the vertical label order DARK→BRIGHT reading bottom-up.

*Presentation rules:*
* Axis labels are small, quiet (`--map-label`, `--text-tertiary`), placed at panel edges;
  they must **not** dominate or imply measurement precision.
* A single subtle arrow or tick only — **no numeric calibration scale**.
* A mouseover/help note may state: *"Position is an impression of timbre, not a precise
  acoustic measurement."* (§20 tooltip).

---

# 8. SAMPLE POINT DESIGN

## 8.1 Base point

| Property | Value |
| --- | --- |
| Size | `6px` radius at 100% zoom (scales inversely with zoom so on-screen size is stable: `6/zoom`, clamped to `≥4px`). |
| Shape | Circle (`<circle>`), consistent radius. |
| Color | `--bg-map`-tinted neutral — a desaturated slate `#3A4252` at rest; color is **reserved for state**, not idle decoration. |
| Base fill opacity | `0.85`; stroke `rgba(0,0,0,0.35)`, `1px` for the resting outline. |

## 8.2 State treatments (priority order)

Visual priority is fixed:

```text
Position  >  Selection  >  Hover  >  Playback  >  Classification  >  Confidence
```

**Position** — always first (the map's core). Never obscured by state.
**Selection** — highest state prominence: `--selection` stroke + enlarged radius + soft
`--selection-alt` glow. Code-selected points' appearance overrides hover/playback.
**Hover** — `--hover` outline + 10–14% radius bump, reversible.
**Playback** — a pulsing ring (`--accent`) around the point; subtle, non-blocking.
**Classification** — encoded via a small color dot only when user turns on "color by class"
(optional density aid, §8.4). Never the default idle color.
**Confidence** — reflected by a thin inner ring or reduced opacity only for low-confidence
points (§21); never by idle color.

### State matrix for a point

| State | Fill | Stroke | Radius | Extras |
| --- | --- | --- | --- | --- |
| Rest | `#3A4252` | `rgba(0,0,0,.35)` | base | — |
| Hover | `#3A4252` | `--hover` | base × 1.1 | cursor pointer |
| Selected | `#FFB84D`-tinted `#6B5A2A` | `--selection` | base × 1.35 | soft `--selection-alt` glow |
| Playing | `#3A4252` | `--accent` | base | pulse ring `--accent` |
| Low-confidence | `#3A4252` | `--low-conf` | base | 1px `--low-conf` inner ring |
| Missing-V2 | *(no point on map)* | — | — | see §22 / result list |
| Unavailable | `--avail-unavailable` | `--border-weak` | base | reduced opacity `0.45`, dashed hover |
| Disabled (filtered-out) | hidden from map | — | — | see §8.3 / §13 |

## 8.3 Filtered-out points

When a filter/search is active, non-matching samples are **hidden from the map** (not greyed
and cluttering density). Selected-but-filtered samples are addressed in §17 ("hidden
selected items after filtering").

## 8.4 Optional visual coding (classification)

Enabled via "Color by class" toggle (default **off**, to preserve density clarity):
* Map color = a class-group hue (Drums / Musical / Other top-level groups, §13). Muted
  hues, low saturation so position remains dominant.
* When toggled on, a compact legend shows the 3 groups; clicking a legend chip toggles that
  class-visibility sub-filter (§13).

## 8.5 Confidence coding + density coding

* **Confidence** is never the primary visual; encoded via the low-confidence inner ring only.
* **Density** is conveyed by overlap/glow/opacity (§9), not by point size.

---

# 9. SAMPLE DENSITY

STEP16R defines density as a *discovery aid*. The design conveys density using the **points
that actually exist** — **no invented algorithmic cluster feature in V1**.

*Rationale:* We must not manufacture clusters. We show the existing point cloud's shape.

## 9.1 Visualization approach

Density is expressed through:
* **Overlap & stacking** of co-located points (§10) — nearby timbres pile up.
* **Local glow/opacity**: regions with many points show a faint `--accent`-tinted ambient
  glow whose intensity rises with local count. Implemented as an offscreen low-res
  "density tint" layer blended under points — *a rendering of real points*, not clustering.
* **Info affordance**: hovering a dense region shows a transient readout: `+N samples here`
  (contextual spread, §10).

## 9.2 Rules
* Density is always **subtle** and **below** the point layer in visual priority (per §8.2).
* No auto-grouping circles, no "cluster count labels" invented by an algorithm.
* The user can toggle density tint on/off; default **on but subtle** (it aids discovery).

## 9.3 Density tint is a transient rendering effect only (binding)

Density tint is a **transient visual rendering effect only**. It must:

* **never be persisted**;
* **never modify `mapPosition`**;
* **never modify `SampleIndexRecord`**;
* **never affect classification**;
* **never affect filtering**;
* **never affect selection**;
* **never affect Machiniste operations**;
* **never create persistent clusters**;
* **never be exposed as sample metadata**.

It is calculated **only** from currently rendered/visible sample positions for visual
presentation. This is **not** a clustering algorithm and must not be implemented as one.

---

# 10. OVERLAPPING SAMPLES

STEP16R deliberately did not prescribe a technique. This spec now binds the V1 solution.

## 10.1 Chosen solution: contextual spread (fan-out)

**The V1 overlap technique is a lens-based "contextual spread":**

* Samples that appear overlapped in **screen space** (see §10.2) are represented at rest by a
  **single anchor point** with a small count badge `·N` when N > 1.
* **On hover or selection** of that anchor, the stack **fans out** locally in a small arc
  (up to 8 visible) around the anchor, each fanned point clickable.

*Guarantee:* **Every sample record remains reachable.** No record is hidden behind an
irrecoverable stack; the fan reveals all overlapped members.

## 10.1.1 Overlap is a presentation-layer operation (binding)

Overlap detection is evaluated **in screen space** using the current camera transform and
`POINT_HIT_RADIUS_PX`. It is a **rendering/interaction aid only** and:

* **never changes persisted `mapPosition`**;
* **never persists a cluster relationship**;
* **never changes any sample metadata**;
* **never creates a new classification**;
* **does not affect search/filter semantics**;
* **does not affect selection membership**;
* **does not affect Machiniste behavior**.

Consequently, **two samples may appear overlapped at one zoom level and separated at
another** — this is expected and correct, because overlap is a function of the camera, not
of the persisted coordinates.

## 10.2 How to recognize an overlap
* Anchor shows a subtle `·N` count badge next to/on the point (most reliable cue).
* Hovering reveals the fan.

## 10.3 On hover
* The overlapped family fans out locally (arc spread radius ≈ `24–36px`).
* Failed/absent preview is still selectable — fan members are full points.

## 10.3.1 Deterministic fan ordering (binding)

An overlap anchor does **not** implicitly represent a random or "top" sample. When an anchor
is activated:

1. The contextual fan opens.
2. **Members are ordered deterministically by `sampleId` ascending.**
3. The first member receives keyboard/accessibility focus when appropriate (e.g., on
   keyboard-open of the fan).
4. The user can explicitly select **any** fan member.
5. Clicking a fan member selects/focuses that **exact** sample.

The anchor itself must **never cause nondeterministic sample selection**. The ordering is
**presentation-only** and does **not** modify persisted sample data.

## 10.4 On click
* Clicking a **fan member** focuses that specific sample (and toggles selection only with
  the modifier — see §17). The fan member explicitly identifies one record; never a stack.
* Clicking the **anchor** opens the fan for inspection; it does **not** select an arbitrary
  member. Selecting a member always requires an explicit action on that member.
* Anchors never select all members at once.

## 10.5 Selecting sample #2/#3/#4
* The fan lists members ordered by `sampleId` ascending, with short identities (name or
  class+id). Clicking a specific fan member focuses exactly that record.
* Multi-select: hold modifier and click each fan member to add them one-by-one (§17).
* If the fan exceeds 8, the remaining are reachable via an explicit `+N more` chip on the
  fan that opens the contextual result list filtered to those overlapped samples.

## 10.6 Preview
* Double-click a specific fan member to preview that exact sample (single-playing, §16).
* The fan closes on preview start for that member; its point shows the playing pulse.

## 10.7 Multi-selection
* Any number of distinct fan members can be multi-selected (≤8 total selection, §17).
* Selecting members across overlapped stacks is fully supported; each is a distinct record.

---

# 11. ZOOM & NAVIGATION

Zoom steps are the production progression **1x → 2x → 4x → 8x** (`ZOOM_STEP=2`,
`1 ≤ zoom ≤ 8`).

## 11.1 Controls
* **Map-bottom-right zoom stack:** `+`, zoom level readout (`2x`), `−`, and a `Reset`
  (`⌘/Ctrl + 0`).
* **Wheel/trackpad:** zoom toward the **cursor position** (scroll up = zoom in).
* **Trackpad pinch:** multi-touch pinch zoom (cursor-centered).

## 11.2 Zoom center
Zoom is anchored to the **cursor/locus point**, keeping the focused region stable.

## 11.3 Pan
* Drag on the map (with or without the Space key held) pans the map; Space + drag is the
  canonical modifier pan for keyboard-first users (§28).
* Trackpad two-finger scroll pans when an axis filter/shortcut isn't stealing it.
* Pan boundaries: clamp so the map can't be lost — the content always retains ≥30% overlap
  with the visible viewport.
* A pointer drag must **not accidentally trigger point selection or focus**; it only pans
  once the pointer exceeds `DRAG_THRESHOLD_PX=4`, and it must not conflict with point
  hit-testing (§8/§28). A click without drag still hits points; a drag past the threshold
  pans and suppresses the click.

## 11.4 Boundaries
`MIN_ZOOM=1`, `MAX_ZOOM=8`; at the boundary, further input is ignored (no bounce-back
decoration).

## 11.5 Reset view
`⌘ + 0` on macOS / `Ctrl + 0` on Windows/Linux (cross-platform binding) — or the `Reset`
button — restores `DEFAULT_ZOOM=1` and centers origin (0,0 at bottom-left).

## 11.6 Visual transitions
Camera moves animate at ~180ms ease-out, **except** during wheel/pinch which track the input
directly (no lag). Selection markers (in decorative space) animate with the camera so the
"where am I" relation stays clear.

## 11.7 Selection preservation
**The selection is never lost on zoom/pan.** Selection is stored as a set of sample IDs
(independent of camera). Selected points re-render at their persisted coordinates at the
new zoom. A bottom status line always shows the selection count (§18) so even if points
scroll out of view, the user knows the selection persists.

---

# 12. SEARCH

## 12.1 Position & size
The search bar lives in the **header** (global, ~320px wide, flexible). It applies
immediately across the whole sample set.

## 12.2 Placeholder
`Search name, owner, or tag…`

Search covers (per STEP16R search fields): **Sample Name**, **Owner**, **Tags**,
**Classification** (class names/drum-category keywords).

## 12.3 Behavior
* **Keys:** typing filters live (debounced ~150ms). `Enter` = confirm/keep filter and focus
  map. `Esc` = *per §28 priority* (closes a dialog/fan if open; otherwise does not modify
  the query, and does not clear search).
* **Autofocus (binding):** search is **not** automatically focused on initial application
  load; `⌘/Ctrl + F` focuses it (§28).
* **Clear button:** an `×` appears when the field is non-empty; click clears the query.

## 12.4 Active state
A subtle `--accent` border + focus ring while the query is active; a matching count hint
under the bar or in status (`N results`).

## 12.5 Feedback
While searching, the map filters to matches (non-matches hidden, §8.3) and the result
list shows the subset; the status line shows `N results`.

## 12.6 No-result state
When zero matches:

> **No samples match your search.**

This exact string is canonical and used for **both** the map empty state and the result
list empty state (per STEP16R F-03).

*Sub-line (non-normative, actionable):* `Try a tag like "snare" or an owner name.`
Show a `Clear search` action and keep filters visible.

---

# 13. FILTER SYSTEM

## 13.1 Panel & grouping

The left **Filter panel** presents the classification taxonomy in **three groups**:

* **Drums:** kick, snare, clap, hihat, openhat, tom, cymbal, percussion
* **Musical:** bass, synth, piano, guitar, strings, keys, pad, lead
* **Other:** vocal, fx, atmosphere, noise, loop, other

Each group is a collapsible heading (collapsed by default, expandable). Under each, classes
are rendered as filter **chips**.

## 13.2 Selected state
* An active chip: filled `--accent` background + white text + checkmark.
* Inactive chip: `--panel-strong` background, `--text-secondary`.

## 13.3 Reset
* A `Clear filters` link at the top of the filter panel (appears when any filter active).
* `Esc` **does not** clear filters — per §28, `Esc` only closes dialogs/popovers, then
  clears the selection. Use the explicit `Clear filters` to reset filters. No destructive
  surprises.

## 13.4 Combined filters — matching semantics

Filters compose as **OR-within-a-group, AND-across-groups** (a common, predictable model):

* Classification filters **match against the complete persisted classification result** for
  a sample, **including its primary class and its persisted secondary classes**.
* Therefore selecting `snare` matches samples whose persisted classification includes
  `snare` (as primary **or** any persisted secondary class).
* Selecting `snare` + `clap` within Drums uses OR.
* Selecting conditions from separate groups uses AND.
* **Filtering does not recompute classification** — it only inspects the persisted result.

If the data model represents secondary classes in a specific persisted form (e.g., a set or
array on the sample record), filtering evaluates against that persisted representation
without changing it. The UI invents no new classifier behavior.

## 13.5 Active-filter indicators
* Header of filter section shows `·3 active` when enabled.
* Filter panel section headings highlight when they contain an active chip.
* The status bar shows a compact summary of active filters with individual `×` removals.

## 13.6 Interaction with map
Applying a filter updates the map to show only matching points (non-matches hidden, §8.3).
The result list updates too.

## 13.7 Interaction with selection
**Filters never delete a selection.** If a selected sample is filtered out of view, it:
* Remains in the selection set and the action bar count.
* Is visibly marked in the selection list as "hidden by filter" (§17.5) so nothing is
  silently dropped.

---

# 14. OWNER / CREATOR UX

The owner/creator is a **first-class, neutral identity** — never presented as an error or a
"restricted user."

*Principle:* A foreign sample owner (another Audiotool user) is a **normal, valid sample**,
just like own public samples. Owner is metadata, not a limitation.

## 14.1 Inspector
Display owner as a labeled field `Owner` with a neutral icon (a simple user glyph) and the
owner's display name in `--text-secondary`. A public-availability badge may sit beside it
(§23). No lock icon, no "external/foreign" warning styling.

## 14.2 Result list
Each row shows a small owner label (name or short handle) under the sample name in
`--text-secondary`. Rows for foreign owners look identical to own rows.

## 14.3 Search
Owner is a searchable field (§12): typing an owner name matches it.

## 14.4 Filter
A compact **Owner** quick-filter section in the filter panel: `All`, `My samples`, and the
top recent/known owners, plus a text input to filter by owner. Selecting an owner restricts
the set. Composite with classification filters (owner acts like an additional AND group).

## 14.5 Owner metadata hierarchy
Owner is **secondary** to the sample name and class in visual weight — it supports identity
but never dominates (§30). Ordering support: the sample list can also sort by owner.

## 14.6 Foreign public sample verification wording (binding)

Foreign public samples are **valid product scope** and must be presented as **normal
samples**. However, live end-to-end verification of *every* foreign-public path — including
foreign-public discovery through `samples.list()` and foreign-public sample → Machiniste
acceptance — remains an **integration verification gap** documented in STEP16R/STEP16M. The
UI must therefore provide **normal runtime error handling** and must **not imply guaranteed
Machiniste success** for every sample.

This must **not** be expressed as a product limitation:
* Do **not** describe foreign samples as "restricted."
* Do **not** add a foreign-sample warning.
* Do **not** change product scope.
* Do **not** claim the integration is impossible.
* Do **not** surface the verification gap as a special user-facing limitation.

The UI simply handles successful and unsuccessful runtime operations honestly (§19/§26).

---

# 15. INSPECTOR

The Inspector is the **right rail** showing the **focused** sample. It must feel like a
polished product detail panel, **not a debugger**.

## 15.1 When shown / Focus vs Selection

The Inspector shows the **focused** sample. **Focus** and **selection** are distinct
concepts (see binding rule, §17.1):
* **Focus** = the single sample whose details the Inspector displays; changed by clicking a
  map point, list row, or fan member.
* **Selection** = the (optional) batch of samples to add to Machiniste; changed only by
  explicit toggle actions (§17.1).
* Focus may change **without** changing the selection, and the selection may contain
  samples **other than** the currently focused one.
* The Inspector shows the focused sample's details; when a selection exists it also shows a
  **selection summary** (§17.3) with a back link to the last focused single sample.

## 15.2 Content & order (single)

Grouped and ordered for scanning:

1. **Sample name** (heading, `--body`/display weight) — the identity anchor.
2. **Owner** (`Owner` field; §14).
3. **Classification block** (§20): primary class + confidence (headline), then secondary
   class bars.
4. **Preview control** (§16) — play/stop + progress.
5. **Selection row** — `Add to selection` button (pushes the focused sample into the
   selection) (§17.1); plus the primary `Add to Machiniste` action (§18).
6. **Details group** (collapsible, default open): Sample ID (mono), original tags (chips),
   map position, visibility, runtime availability, analysis status.
7. **Confidence help** tooltip (§20).

## 15.3 Labels, values, hierarchy
* Field pattern: `--insp-label` (11px, uppercase-ish secondary) above the value.
* Values: `--body` for name, `--metadata` for ID/position, `--numeric` for coordinates.
* Buttons: single primary (`Add to Machiniste`), secondary (`Add to selection` / `Preview`).

## 15.4 Inspector field list (V1)
| Field | Value |
| --- | --- |
| name | Sample display name |
| owner | Owner display name + availability badge |
| sample ID | Mono ID (copyable) |
| original tags | Tag chips |
| classification | Primary class + confidence + secondary classes |
| confidence | Tabular %, with state (low) |
| secondary classes | Bars below primary |
| map position | `x, y` coordinates (read-only, V2); `Map position unavailable` if Missing-V2 (§22) |
| visibility | public / unlisted / private / unknown (persisted metadata) |
| availability | available / unavailable / gone (runtime status §23) |
| analysis status | Analyzed / Pending / Failed / Missing-V2 |

---

# 16. PREVIEW EXPERIENCE

## 16.1 Single-playing semantics (binding)
```text
Sample A plays
↓
Sample B selected
↓
Sample A stops
↓
Sample B plays
```
Only **one** sample plays at a time. Selecting/playing a new sample stops the previous.

## 16.2 Audio is ephemeral
Audio is used transiently (ObjectURL); the UI **never persists audio files** (§2.1).

## 16.3 Play button
* In Inspector: a round `Play` icon button (toggles to `Stop` while playing).
* On map: **double-click** a point to preview that sample.

## 16.4 Stop
Clicking `Stop`, or starting any other sample, stops playback. Selecting a new sample does
**not** auto-play it (principle "Hear before acting" — §36) — user must trigger preview.

## 16.5 Playing indicator & progress
* Playing point: `--accent` pulse ring (§8.2).
* Inspector: progress bar (thin, `--accent`), duration readout (tabulated).
* Result-list row: a small `♪` glyph on the playing row.

## 16.6 Hover behavior
Hover a point → a small transient **preview tooltip** with `Play` affordance (does not
auto-play — no surprise audio). Auto-play on hover is **off** in V1.

## 16.7 Keyboard behavior
`Space` = play/stop the focused/previewed sample (§28). `P` also plays preview.

## 16.8 Error state
If a sample's audio can't load: show a non-alarmist inspector hint (`Unable to load preview`)
+ `retry`. The sample remains selectable/usable (§26).

---

# 17. MULTI-SELECTION

V1 selection cap: **maximum 8 samples** (Mirrors `MAX_BATCH_SLOTS=8`).

## 17.1 Interaction model — Focus vs Selection (binding)

**Focus** and **selection** are distinct, independent concepts:

* **Single click on a map point = focus only.** Focusing a sample displays it in the
  Inspector.
* **Single click does NOT modify the batch selection.**
* **⌘/Ctrl-click** (macOS `⌘`, Windows/Linux `Ctrl`) = **toggle selection membership**.
* **Result-list checkbox** = toggle selection membership.
* **Inspector `Add to selection` button** = add the **focused** sample to the selection.
* **Selection exists independently from focus.**
* **Focus may change without changing the selection.**
* **The selection may contain samples other than the currently focused sample.**
* **If there is no selection, clicking a sample does NOT implicitly create a selection.**

Chosen interaction model: modifier-click toggle, plus the inspector selection button, plus
checkbox-style selection in the result list.
* Lasso is **out of V1 scope** (Overlaps + density make it ambiguous); later/optional.

*Rationale:* This combination is fast, unambiguous, desktop-friendly, and overlap-compatible
(you can modifier-click individual fan members — §10).

### Concrete interactions
* **Single click** a point → **focus only** (§15.1); never modifies selection.
* **⌘/Ctrl-click** a point/row → **toggle** membership in the batch selection.
* **Row checkbox** in the result list → toggle membership (mirrors modifier, discoverable).
* **Inspector `Add to selection` button** → push the **focused** sample into the batch.
* **At 8 selected**, additional select attempts are **ignored** (the UI cap); a non-blocking
  hint appears once: `Selection limit reached (8).` The service's `>8` guard remains a
  defensive invariant, not a normal-flow UI state.

## 17.2 Selected point appearance
`--selection` stroke + enlarged radius + soft glow (§8.2 / §5.4).

## 17.3 Selected list appearance
The Inspector switches to a **selection summary**: a scrollable list of the selected
samples (name + class + owner), each with an individual `×` to remove, and a `Clear all`.

## 17.4 Selection count
Persistent count in the action bar: `N / 8` (§18). Always visible.

## 17.5 Clear / deselect
* `Clear all` in the selection summary or action bar.
* `Esc` clears the entire selection only when no modal/dialog or contextual fan/popover is
  open (priority order per §28.1). `Esc` **does not** clear search or filters.
* Removing a member: `×` on its row, or ⌘/Ctrl-click again.

## 17.6 Hidden selected items after filtering
If a filter/search hides a selected sample: it stays in the selection set and count, and is
listed in the selection summary with a `• hidden by filter` note (not dropped).
§13.7.

## 17.7 Zoom behavior
Selection survives zoom/pan unchanged (§11.7). Zooming to 8x may separate samples that
appear overlapped at lower zoom (overlap is screen-space only, §10.1.1); individual selected
members remain individually clickable in the fan.

---

# 18. SELECTION ACTION BAR

A fixed bottom bar, always visible, showing **selection** state + primary action. It keys
off the **selection** set (§17.1), never off focus — a focused-but-unselected sample shows
`0 selected`.

## 18.1 Count states (binding)
| State | Bar shows |
| --- | --- |
| 0 selected | `No samples selected` (secondary) + `Add to Machiniste` **disabled** |
| 1 selected | `1 selected` + single-name summary + `Add to Machiniste` **enabled** |
| 2–7 selected | `N selected` + compact list count + `Add to Machiniste` **enabled** |
| 8 selected | `8 selected (max)` + `Add to Machiniste` **enabled** |

The user always understands: **"How many samples have I selected?"** — the count is a
persistent, clearly-styled `N / 8` pill.

## 18.2 Primary action
Button labeled:
> **Add to Machiniste**

(Product semantics §37 — a *reference*, not an upload/copy.)

### Disabled states
* `0 selected` → disabled, dimmed, tooltip `Select samples to add references to Machiniste`.
* Selected set empty after filtering → still enabled (selection persists under filter).

### Loading
While sending: button disabled, shows a spinner + `Adding references…`; `Stop`/cancel not
offered mid-batch (atomic, fast).

### Success
Toast: `Added N reference(s) to Machiniste.` (green `--success`); the action bar returns to
`0 selected`. Read-back is confirmed (§19).

### Error
Toast in `--error` with an actionable message and `Retry` (§19 / §26).

---

# 19. MACHINISTE UX

The Machiniste hand-off must feel like the **natural completion** of the browsing flow:

```text
Find → Preview → Select → Add to Machiniste → Confirm
```

## 19.1 Product semantics (binding)
The UI must **never suggest SampleMap copies audio**.

> Add **reference** to Machiniste — not "upload sample" / "copy sample."

Successful message (canonical):
> **Added N reference(s) to Machiniste.**

*Runtime honesty (binding):* The UI must **not imply guaranteed Machiniste success** for
every sample — including foreign-public samples, whose end-to-end verification remains a
documented integration gap (§14.6). Success/failure is reported honestly per operation
(§19.6–§19.7, §26).

## 19.2 Loading
Button spinner + `Adding references…`; action bar and inspector disabled during send.
Selection is locked (not removable) mid-send.

## 19.3 Validation failure
If a selected sample can't be referenced (e.g., availability `gone`; §23): the send blocks
in the inspector/bar and lists the problem samples with a clear reason + `Remove`/`Retry`
per the ambiguous set. Non-alarmist (§26).

## 19.4 Unavailable sample
A sample with `unavailable`/`gone` state is excluded from the send; the confirmation
mentions it plainly: `1 sample skipped (no longer available)` — no alarm.

## 19.5 Usage-acceptance gate
On **first** `Add to Machiniste`, show a one-time, non-technical confirmation dialog:
* Text (canonical): `This adds references to audiotool samples in your Machiniste document.
  No audio is uploaded or copied from SampleMap.`
* Primary: `Continue` · Secondary: `Cancel`.
This is a consent step (documented in STEP16R as a usage-acceptance gate), stored as a
preference thereafter.

## 19.6 Read-back failure
After the send, read-back confirms the reference was created. On mismatch (read-back
failure): non-alarmist error + `Retry`. `Added` success is only shown after successful
read-back.

## 19.7 Partial failure
If technically supported and a subset fails (e.g., 6 of 8 succeeded): report
`Added 6 of 8 references` and list the failed ones for `Retry` — never a silent partial
success. If read-back cannot distinguish partial failures, treat as full failure with
`Retry` instead of guessing.

---

# 20. CLASSIFICATION UX

Classification is an **estimate**. The language must build trust **without false certainty**.

## 20.1 Presentation

In the inspector (and optionally in rows), show, in a refined layout:

```text
KICK                    87%        (primary, prominent)
SNARE       ██████░░    6%
PERCUSSION  ████░░░░    4%
OTHER       ███░░░░░    3%
```

Concretely:
* **Primary class** — bold, `--body` weight, with a large tabular %.
* **Secondary classes** — thin proportional bars (width ∝ confidence), `--text-secondary`.
* Only show a bounded set of secondary classes (cap list at 3–4) for legibility; this is a
  presentation cap, not a classification change.

## 20.2 Low confidence (threshold ownership)
The UI **does not define or invent** the low-confidence threshold. It **consumes** the
existing classifier/configuration threshold already defined by the application and only
**renders** the resulting low-confidence state. There is no hard-coded numeric threshold in
the UI, no new classifier rule, and no UI-side confidence calculation.
* When the application marks a sample low-confidence, the UI shows: primary % tinted
  `--low-conf` and a small `≈` or `low` tag with tooltip:
  `Low confidence — position and class are estimates.`

## 20.3 Tooltip / help
An info tooltip near the classification headline:
> `Classification is an estimate, not a ground truth.`

## 20.4 Map indication
Low-confidence points show the thin `--low-conf` inner ring only (§8.2); no alarm.

## 20.5 Inspector indication
The inspector always explicitly labels the value as `confidence` and shows the estimate
disclaimer (§20.3). No "verified"/"correct" language (§37).

---

# 21. LOW CONFIDENCE

*Meaning:* **Classification is uncertain.** Never implies the sample is broken.

Low-confidence is **determined by the application's existing classifier/configuration
threshold** (§20.2); the UI only renders the resulting state.

* **Map:** thin `--low-conf` inner ring (§8.2); position stays valid and prominently
  rendered (position is independent of confidence).
* **Inspector:** `--low-conf`-tinted % + `low confidence` tag + tooltip (§20.2).
* **Result list:** optional small `low` tag on the row.
* **Availability/health:** unaffected — a low-confidence sample is fully playable and
  selectable.

---

# 22. MISSING-V2

Missing-V2 must be visually **unambiguous**.

**Missing-V2 samples have no map position and therefore never receive a fabricated map
point, placeholder coordinate, or fallback coordinate.** No UI operation may reconstruct
their position from `AudioFeatures` (§2.1).

* **Map:** **no point.** The sample is not placed anywhere — there is **no fake position**
  and **no visual placeholder position** (§2.1).
* **Inspector:** the position field reads:
  > **Map position unavailable**
  in `--text-tertiary`. If the sample is otherwise available, all other features work.

## 22.1 Reachability of Missing-V2 samples outside the map

Their **absence from the map is intentional.** Missing-V2 records remain **findable**
outside the map:
* They appear in the **result list** when search/filter matches them (list is not
  position-gated).
* They are reachable via **search**, **classification filters**, and **owner filters**.
* A `Show samples without map position` toggle in the filter panel surfaces them; when on,
  a small `No map position` panel/badge lists them.
* They are selectable (they can be added to Machiniste) and fully inspectable.

---

# 23. AVAILABILITY STATES

## 23.0 Visibility vs Runtime Availability (binding)

These are **distinct concepts** and must be kept separated in the UI and in this spec:

* **Visibility** — persisted Audiotool metadata: `public`, `unlisted`, `private`, `unknown`.
* **Runtime availability** — the current ability to use/reference the sample:
  `available`, `unavailable`, `gone`.

Rules:
* **Do not treat "foreign owner" as an availability state** (§14).
* **Do not infer availability solely from ownership** — a foreign public sample's
  availability is determined at runtime, not by who owns it.

## 23.1 Visibility states (persisted metadata)
| State | Meaning | Badge |
| --- | --- | --- |
| public | Persisted Audiotool visibility: public | green dot + `public` (default, may be hidden) |
| unlisted | Persisted Audiotool visibility: unlisted | teal dot + `unlisted` |
| private | Persisted Audiotool visibility: private | amber dot + `private` |
| unknown | Persisted visibility unknown | grey dot + `unknown` |

*Visibility badges appear where identity matters (inspector/rows); they are **not** a
health signal and do not affect the map point.*

## 23.2 Runtime availability states (current status)
| State | Meaning | Badge/Map impact |
| --- | --- | --- |
| available | Can be used/referenced now | none (normal) |
| unavailable | Known not usable/referenceable | grey outline + `unavailable`; point reduced opacity `0.45` |
| gone | No longer exists in Audiotool | red dot + `gone`; excluded from selects; small warning badge if focused |

*Rules:*
* `unavailable`/`gone` are the **only** states that visually affect the point, and only
  subtly.
* Runtime availability is reported honestly at operation time (§19.1, §26); it is not
  predicted from visibility or ownership.

---

# 24. INDEXING EXPERIENCE

Indexing is a first-run (and refresh) workflow.

```text
Connect Audiotool
→ Start indexing
→ Progress
→ Samples appear progressively
```

## 24.1 Progressive map
The map should already show results during indexing: analyzed samples appear **as they
finish**, progressively filling the soundscape. Points animate in gently (per §29).

## 24.2 Progress indicator & counts
A non-blocking indexing banner (top of status bar / a slim overlay on the map corner):

* Progress bar (`--info`) with `%`.
* Live counts:
  * **Analyzed** (green count)
  * **Pending**
  * **Failed** (only if >0, `--error`-tinted, with `Retry failed`)
* A **current activity** line (secondary, e.g. `Analyzing synth … 3 of 40`).

## 24.3 Completion state
When done: banner transitions to `Index complete` (`--success`) then dismisses; the status
bar shows the final `N samples`. Failed items are persisted as `Failed` state and retryable.

---

# 25. FIRST-USE EXPERIENCE

## 25.1 Empty state (canonical)
> **No analyzed samples yet.**

It must immediately answer:
1. **What SampleMap does** — *"Your public Audiotool samples, arranged as an explorable
   soundscape."*
2. **Why the map is empty** — *"Nothing has been indexed yet."*
3. **What to do** — one primary action: `Connect Audiotool & start indexing`.

## 25.2 Layout
Centered on the map region: icon + headline + one-line explanation + a single primary
button. No technical detail. Optional secondary link: `What is the soundscape?`.

---

# 26. ERROR STATES

A consistent, non-technical, actionable error system: **understandable, not alarming.**

| Scenario | Message (user-facing) | Action |
| --- | --- | --- |
| Audiotool connection | `Could not connect to Audiotool.` | `Reconnect` |
| Indexing | `Indexing was interrupted.` | `Resume indexing` |
| Sample unavailable | `This sample is no longer available in Audiotool.` | `OK` (keep browsing) |
| Preview | `Unable to load preview.` | `Retry` |
| Machiniste | `Could not add the reference to Machiniste.` | `Retry` |
| Read-back | `Adding succeeded but could not be confirmed.` | `Retry` |
| Local index | `The local index could not be read.` | `Rebuild index` |
| Global unavailable | `SampleMap is unavailable.` (full screen) | `Reload` |

*All errors:* shown as toasts (`--error` border + `--error-bg`) or inline; never raw stack
traces; always with an action. Non-alarmist tone (no "FATAL"/excessive red glow).

---

# 27. RESPONSIVE / WINDOW BEHAVIOR

The product is primarily a **desktop browser app**. Mobile is **NOT V1** (explicitly out of
scope).

## 27.1 Breakpoints

| Size | Min width | Behavior |
| --- | --- | --- |
| Large desktop | ≥1280px | Full three-column shell; map ≥60% width. |
| Normal desktop | 1024–1279px | Shell compresses; filter panel may collapse to icon-rail; inspector ≥300px. |
| Small desktop | 768–1023px | Filter panel **collapses to an overlay drawer** (hamburger); inspector becomes a **bottom drawer**; map fills most of the height. |

Below 768px: **unsupported (mobile out of V1)** — show a minimal "desktop browser only"
notice, or degrade gracefully; explicitly documented as out of V1.

## 27.2 Region minimums / behavior
* **Map:** minimum 420px width, ≥480px tall; realistically resizes to fill.
* **Inspector:** 300–340px wide; collapses to drawer under 1024px.
* **Filters:** 200–240px; drawer under 1024px.
* **Search:** header, flexible, min 200px.
* **Action bar:** full-width bottom, always visible (count pill + action).

---

# 28. KEYBOARD & ACCESSIBILITY

## 28.1 Keyboard shortcuts

### Escape priority (binding)
`Esc` resolves in the following **priority order** (first match wins):
1. If a **modal/dialog** is open → `Esc` **closes the dialog**.
2. Else if a **contextual fan/popover** is open → `Esc` **closes it**.
3. Else → `Esc` **clears the current selection**.
4. `Esc` **does NOT clear search**.
5. `Esc` **does NOT clear filters**.

### Shortcut table
| Key | Action |
| --- | --- |
| `Tab` | Move focus through controls in visible order. |
| `Enter` | Activate focused control / confirm search. |
| `Esc` | Per the priority order above (dialog → fan/popover → selection). |
| `Space` (sample focused) | Play/stop focused sample preview (§16). |
| `Space` + drag (map) | Pan the map (§11.3); a plain map drag may also pan past `DRAG_THRESHOLD_PX`. |
| `P` | Play preview of focused sample. |
| `↑ ↓ ← →` | Move focus/map camera between nearby points (with zoom). |
| `⌘/Ctrl + F` | Focus search. |
| `⌘/Ctrl + 0` | Reset map zoom/view (§11.5) — macOS `⌘`, Windows/Linux `Ctrl`. |

Modifier-click for multi-select (§17) is also keyboard-reachable via focus + `Space` or a
dedicated `toggle selection` action (`⌘/Ctrl + Enter` on a focused point).

## 28.2 Accessibility basics
* **Focus states:** visible `--shadow-focus` ring on every interactive element; never only
  mouse.
* **Contrast:** primary text meets ≥7:1; secondary ≥4.5:1; status colors have AA-adjusted
  backgrounds for non-decorative text.
* **Labels:** every control has an accessible label (aria-label/assoc). Icon-only buttons
  (play, close, ×) carry labels.
* **Screen-reader semantics:** canvas gets a semantically structured aria-describedby +
  an offscreen live region announcing selection count and model changes; points are grouped
  with role semantics where feasible; the result list is a real list.
* **Keyboard reachability:** all actions reachable by keyboard; the map has a focusable
  alternative (result list) so no info is canvas-only.
* Color is never the sole signal — every color state has an icon/text/label supplement
  (e.g., selection count text, playing `♪`, low-confidence tag).

---

# 29. MICRO-INTERACTIONS

Only motion that aids **orientation**. Durations qualitative.

| Scenario | Behavior | Duration / curve |
| --- | --- | --- |
| Point hover | Quick radius/outline fade-in | ~90ms ease-out |
| Selection transition | Selected point grows + glow fades in | ~120ms ease-out |
| Preview transition | Playing pulse ring appears; stop fades | ~140ms |
| Panel transition | Filter/inspector drawer slides in | ~200ms ease-out |
| Zoom transition | Camera animates (except wheel/pinch) | ~180ms ease-out |
| Indexing appearance | Point fades+scales in as analyzed | ~180ms ease-out |
| Success feedback | Toast + action confirms | ~220ms |
| Error feedback | Toast slides up subtly (not flashing) | ~200ms |

*Rule:* No decorative/repetitive motion. `prefers-reduced-motion` → all animations reduce
to opacity-only or none.

---

# 30. VISUAL HIERARCHY

Fixed priority (with the one map-allowed deviation, the Selection, promoted — this is the
intended app-wide hierarchy):

```text
1. Sample Map            (primary surface; the "ground")
2. Current selection     (never lost; action bar + colored points)
3. Preview               (playing state is clearly visible, but subtle)
4. Search / filter       (always accessible header/panel)
5. Inspector             (right rail detail, secondary to the map)
6. Machiniste action     (single primary CTA in the action bar)
7. Metadata              (owner, tags, availability at the inspector level)
8. Secondary information (IDs, exact coords, confidence bars)
```

*Deviations & rationale:*
* **Selection (#2) promoted above the map's own density cues** — because batch-add to
  Machiniste is the core completion action; selection must always be legible over background
  points.
* **Merge note:** availability/missing-v2 are informative but stay visually quiet (low in
  hierarchy) to serve the calm browsing ideal.

---

# 31. FINAL USER FLOW

## 31.1 Ideal V1 flow

```text
CONNECT
  ↓
INDEX
  ↓
MAP
  ↓
EXPLORE        (see regions, density)
  ↓
SEARCH / FILTER
  ↓
HOVER          (preview tooltip / fan-out overlap)
  ↓
PREVIEW        (double-click / play)
  ↓
INSPECT        (click → FOCUS the sample in the inspector)
  ↓
SELECT         (⌘/Ctrl-click / checkbox / Add-to-selection; ≤8)
  ↓
ADD TO MACHINISTE
  ↓
READ-BACK SUCCESS  ("Added N reference(s) to Machiniste.")
```

*Note:* **Focus** (click → inspector) and **selection** (modifier-click / checkbox /
`Add to selection`) are distinct steps. Clicking a sample only focuses it; it becomes part
of the batch selection only via an explicit select action (§17.1), unless previously added.

## 31.2 Alternative paths (all supported)

```text
Map → Preview → Add
List → Preview → Add
Search → Inspect → Add
```

All paths converge on the same selection set + action bar — there is **one** selection and
**one** primary add action regardless of entry point.

---

# 32. DESIGN STATES MATRIX

*Note:* "Selection" column describes the **batch selection** set (§17.1) — independent of
the focused sample. A focused-but-unselected sample keeps the selection column at its
current value (e.g., `0`). "Inspector" shows the focused sample's details plus a selection
summary when a selection exists.

| State | Map | Inspector | Preview | Selection | Action |
| --- | --- | --- | --- | --- | --- |
| First use | Empty-state overlay (`No analyzed samples yet.`) | hidden | — | 0 | `Connect Audiotool & start indexing` |
| Indexing | Progressive points fade in | shown for focused | — | count live | indexing banner; add disabled until ≥1 |
| Ready | Full point cloud | focused sample | — | N (0 if none) | add enabled if selection>0 |
| Searching | non-matches hidden; matches visible | focused | — | selection persists (independent of focus) | add reflects filtered selection |
| No results | `No samples match your search.` | — | — | 0 or persistent | `Clear search` |
| Selected | points `--selection` | selection summary *(focused sample may be a different row than the selected set)* | — | N | add enabled |
| Multi-selected | ≥2 `--selection` points | selection list | — | N/8 | add enabled |
| Playing | `--accent` pulse | progress bar | single-playing | N (unaffected) | unaffected |
| Low confidence | `--low-conf` ring | % tinted + tag | normal | N (unaffected) | unaffected |
| Missing-V2 | no point | `Map position unavailable` | normal | selectable | addable |
| Unavailable | dim point | badge | load may fail | excludable | skipped w/ note |
| Machiniste loading | lock selection | disabled controls | — | locked | spinner `Adding references…` |
| Machiniste success | unchanged | read-back OK | — | 0 (cleared) | toast `Added N…` |
| Machiniste error | unchanged | inline/toast | — | preserved | `Retry` |
| Global unavailable | full-screen notice | — | — | preserved | `Reload` |

---

# 33. COMPONENT INVENTORY

For each: purpose, visibility, key states, interactions, dependencies.

| Component | Purpose | Visibility | Key states | Interactions | Depends on |
| --- | --- | --- | --- | --- | --- |
| `AppShell` | 3-column+bar layout | Always | — | region resize | Header, FilterPanel, MapCanvas, Inspector, ActionBar |
| `Header` | Brand, search, connect | Always | connected/connecting | search, connect | SearchBar |
| `SearchBar` | Global query | Always | idle/active/no-result | typing, clear, shortcut ⌘F | Search engine |
| `FilterPanel` | Classification+owner filters | Left / drawer | collapsed, active chips | chips, clear, owner | taxonomy |
| `MapCanvas` | Primary map surface | Center | empty/ready/zoomed | pan, zoom, reset | MapPoint, DensityLayer, OverlapController |
| `MapPoint` | A single sample point | On map | rest/hover/selected/playing/low/dim | click/dblclick/modifier | record |
| `DensityLayer` | Subtle density tint | Under points | on/off | toggle | positions |
| `OverlapController` | Contextual spread of overlaps | At anchors | rest(fan closed)/fan | hover, fan member click | Fan members |
| `SampleList` | Integrated secondary result surface (overlay/drawer/panel), not a permanent 4th column; keyboard/accessibility alternative to the map (§6) | On demand (search/filter/overlap/Missing-V2) | empty/filled | scroll, row select | SampleRow, shared filtered set + shared selection model |
| `SampleRow` | One list item | In list | rest/hover/selected/playing/low | click, checkbox, preview | record |
| `Inspector` | Detail rail | Right / drawer | single/selection-summary | inspect | PreviewControl, ClassificationBadge, Confidence*, Inspector fields |
| `PreviewControl` | Play/stop + progress | Inspector/rows | idle/playing/error | play/stop | audio service |
| `ClassificationBadge` | Primary class + % | Inspector/rows | normal/low | tooltip | taxonomy |
| `ConfidenceIndicator` | Confidence % + state | Inspector | normal/low | tooltip | application low-confidence state (§20.2) |
| `SelectionBar` (`ActionBar`) | Count + primary action | Bottom, always | 0/1/2–7/8, loading | add to Machiniste | selection set |
| `MachinisteButton` | The primary add CTA | Action bar | disabled/enabled/loading/success/error | submit | Machiniste service |
| `Toast` | Transient feedback | Top-right | info/success/error | auto-dismiss | events |
| `EmptyState` | First-use / no-result | Map region | first-use/no-results | CTA | — |
| `LoadingState` | Indexing banner | Map corner/top | indexing/complete | pause/retry | indexing |
| `ErrorState` | Error surfaces | Inline/toast/full | retryable | retry | handlers |

---

# 34. DESIGN TOKENS

Complete, implementation-ready token set (directly reusable in the Implementation step).

## 34.1 Colors (see §5.1 for values)
```
colors.surface.bg-app | bg-map | bg-panel | panel-raised | panel-strong
colors.border.weak | strong
colors.text.primary | secondary | tertiary | disabled
colors.accent | accent-hover | selection | selection-alt | hover
colors.status.warning/warning-bg | error/error-bg | success/success-bg | info | low-conf | missing-v2
colors.availability.public|unlisted|private|unknown|unavailable|gone
```

## 34.2 Typography
```
typography.family.ui | mono
typography.size.h-display=20 | h-section=13 | body=13 | metadata=11 | button=13 |
  map-label=11 | insp-label=11 | numeric=12 | conf=12 | mono-id=11
typography.weight.{400,500,600}
typography.lh.{1.2,1.25,1.3,1.4,1.5}
typography.tracking.{0}
typography.tabular=true (numeric/conf)
```

## 34.3 Spacing
```
spacing.1=4 | .2=8 | .3=12 | .4=16 | .5=24 | .6=32
```

## 34.4 Radius / Borders / Shadows
```
radius.sm=6 | md=10 | map=12 | full=999
border.width=1
shadow.panel | pop | focus
```

## 34.5 Opacity
```
opacity.disabled=0.5
opacity.unavailable=0.45
opacity.point-rest=0.85
opacity.density-min=0.06 | max=0.18   (density tint)
```

## 34.6 Motion
```
motion.dur.hover=90ms | select=120 | preview=140 | panel=200 | zoom=180 | indexIn=180 | feed=220
motion.curve.ease-out (all)
motion.reduce=true → opacity-only
```

## 34.7 Z-index
```
z.background=0 | map=10 | density=5 | points=20 | overlay=30 | header=40 |
  actionbar=35 | drawer=50 | toast=60 | modal=70 | focus-ring=200
```

---

# 35. IMPLEMENTATION HANDOFF

## What must be implemented
* AppShell (3-column + action bar) per §6.
* Full design-token system (§34) as the single source of styling constants.
* Map rendering of persisted V2 points with pan/zoom (1x/2x/4x/8x), camera, reset (§7/§11).
* Point states, density tint, overlap contextual spread (§8/§9/§10).
* Search, filters, owner UX (§12/§13/§14).
* Inspector, preview (single-playing, ephemeral), multi-selection ≤8, action bar,
  Machiniste flow, classification/confidence, missing-v2, availability (§15–§23).
* First-use, indexing, error states, responsive, keyboard/accessibility, motion
  (§24–§29).

## What must NOT be implemented
* No changes to any backend/service/persistence/classifier/formula (STEP16Q frozen).
* No V1 fallback, no recompute, no position fabrication.
* No audio persistence by the UI.
* No algorithmic cluster feature (§9).
* No lasso selection in V1 (§17).
* No mobile layout (out of V1, §27).
* No auto-play on hover (§16).

## Which STEP16R rules are binding
Public pool; multi-select max 8; direct reference semantics; classification honesty;
Missing-V2; search; filters; owner; preview; Machiniste; explicit states; canonical
no-match text `No samples match your search.`; canonical Machiniste success `Added N
reference(s) to Machiniste.`

## Which design decisions are NOW binding
* Overlap solution = contextual spread/fan-out (§10), with **deterministic fan ordering by
  `sampleId` ascending** and zoom-dependent (screen-space) overlap (§10.1.1, §10.3.1).
* Multi-select interaction = modifier-click + checkbox + inspector add (no lasso) (§17).
* **Focus and selection are distinct** — single click focuses only; selection changes only
  via explicit actions (§17.1).
* Selection cap mirrors `MAX_BATCH_SLOTS=8` (§17.1).
* Dark professional palette, single accent, mono only for IDs (§5.1/§5.2).
* Classification-encoded color default OFF (§8.4).
* Density tint default ON but subtle, and is a **transient rendering effect only**
  (§9.2/§9.3 — never persisted, never clustered).
* Availability never dominates the map; **visibility (persisted) vs runtime availability**
  are distinct (§23).
* Missing-V2 never receives a fabricated/placeholder position and is never reconstructed
  from `AudioFeatures` (§22).
* Foreign-public samples are normal product scope with honest runtime error handling, not a
  restriction and not guaranteed Machiniste success (§14.6, §19.1).
* Result list is an **integrated secondary surface**, not a separate List mode and not a
  4th permanent column (§6).
* `Esc` priority: dialog → fan/popover → clear selection; never clears search/filters (§28).
* Low-confidence is **consumed**, not computed, by the UI (§20.2).
* Search is **not auto-focused** on load; `⌘/Ctrl + F` focuses it (§12, §28).
* Toolbar semantics and message copy (§37).

## Which details remain Later/Optional
* Lasso selection.
* Mobile layout (explicitly out of V1).
* Color-by-class legend rich interaction (beyond the 3-group legend).
* Advanced density visualizations beyond the subtle tint.
* Partial-failure read-back granularity (if not feasible, fall back to full-failure+Retry).

## Genuine Open Questions (design-level; not blocking)

Only questions that genuinely cannot be determined from the existing product/repository
constraints remain:

1. Whether the owner quick-filter ("My samples" / specific owners) needs **pagination** for
   owners with very many samples. This is a **scale/implementation concern**, not a design
   blocker — the panel renders whatever list is provided.

Settled (no longer open):
* **Low-confidence threshold** — consumed from the application's existing
  classifier/configuration threshold (§20.2); the UI defines/invents none.
* **Search autofocus** — defined as a design decision: search is **not** automatically
  focused on initial application load; `⌘/Ctrl + F` focuses it (§12).
* **Responsive panel widths / auto-collapse** — provisional defaults in §27 are sufficient
  for implementation; they are presentation constants, not open product questions.

---

# 36. DESIGN PRINCIPLES

1. **Map first.** The map is the primary surface; everything else supports it.
2. **Discover visually.** Density, regions, and spatial timbre drive discovery.
3. **Hear before acting.** Preview is always available; nothing auto-plays uninvited.
4. **Metadata supports, never dominates.** Owner/tags/IDs stay secondary.
5. **Classification is an estimate.** Confidence is shown honestly, never as certainty.
6. **Selection is always visible.** The count and set persist across search/filter/zoom.
7. **Position is authoritative & never recomputed.** The UI renders, it does not derive.
8. **Audiotool remains the source of truth.** SampleMap references; it never owns/copies.
9. **No hidden state.** Availability, missing-v2, failed, and low-confidence are explicit.
10. **No destructive surprises.** Esc clears selection, never filters; add is always
    confirmable; nothing lost on zoom.
11. **Fast interaction over decoration.** Motion only aids orientation (§29).
12. **Calm over gimmick.** Restrained palette, subtle density, professional tone.

---

# 37. IMPORTANT PRODUCT SEMANTICS

The spec and the UI must consistently use these terms:

### Correct
> Audiotool sample reference
> Add to Machiniste
> public sample
> sample owner / creator
> SampleMap local index

### Avoid
> upload sample
> copy sample
> SampleMap owns the sample
> SampleMap stores the audio
> classification is correct
> map position is recalculated

*Rationale:* This linguistic consistency is part of the design — it keeps the product's
contract honest (reference, not ownership) and its claims humble (estimate, not truth).

---

# 38. FINAL QUALITY REVIEW (checklist — passed)

## STEP16Q
- [x] No formula change anywhere in the spec.
- [x] No position recomputation in the UI.
- [x] No V1 fallback; no fabricated/placeholder position (§22).
- [x] No audio persistence by the UI (§16/§2.1).
- [x] `mapVersion="map-v2"` respected; coordinates rendered, never derived.

## STEP16R
- [x] Public pool incl. foreign owners as normal state (§14).
- [x] Multi-select max 8 binding (§17); service `>8` is defensive only (§17.1).
- [x] Direct reference semantics + canonical messages (§19/§37).
- [x] Classification honesty (§20/§21).
- [x] Missing-V2 (§22).
- [x] Search + canonical no-match text (§12; `No samples match your search.`).
- [x] Filters, owner, preview, Machiniste, explicit states — all present.

## Design
- [x] No contradictory interactions; all paths converge on one selection + one action (§31).
- [x] No contradictory states (matrix consistent, §32).
- [x] No missing primary actions.
- [x] Visually unambiguous selection states (§5.4/§8/§18).
- [x] Overlaps remain reachable (fan-out guarantees, §10).
- [x] Search/filter affect selection correctly (persist + "hidden by filter", §13.7/§17.6).
- [x] Zoom affects selection correctly (persists, §11.7/§17.7).
- [x] Single click never auto-creates a selection (focus vs selection distinct, §17.1/§15.1/§18/§31/§32).
- [x] No undefined "top sample" remains; overlap ordering is deterministic by `sampleId` (§10.3.1).
- [x] Overlap is never persisted; it is a screen-space presentation aid (§10.1.1).
- [x] Density tint is never presented as a clustering feature and is never persisted (§9.3).
- [x] No invented low-confidence threshold; the UI consumes the application's state (§20.2/§21).
- [x] No claim that foreign-public Machiniste integration is fully live-verified (§14.6/§19.1).
- [x] Owner/foreign status is never treated as a restriction (§14.6).
- [x] Missing-V2 never reconstructs position from `AudioFeatures` (§22).
- [x] No separate List mode; result list is an integrated secondary surface (§6).
- [x] `Esc` behavior is consistent everywhere (dialog → fan → selection; never clears search/filters).
- [x] `⌘/Ctrl + 0` cross-platform reset is consistent (§11/§28).

---

# 39. OUTPUT
This document (`FINAL_UI_UX_DESIGN_SPEC.md`) is the complete, professional, self-contained
design specification. It is written so that another AI can implement the SampleMap UI
**without inventing fundamental visual or UX decisions.**

---

# 40. ABSOLUTE STOP CONDITION
This phase created **only** `FINAL_UI_UX_DESIGN_SPEC.md`. No implementation, no source
changes, no tests, no build, no edits to STEP16R or STEP16Q, and no additional files.

---

# CLOSING REPORT

```text
# FINAL UI/UX DESIGN SPEC v1.1 — COMPLETE

Status:
SPECIFICATION COMPLETE — IMPLEMENTATION NOT STARTED

Version:
1.1

File:
FINAL_UI_UX_DESIGN_SPEC.md

STEP16Q:
UNCHANGED

STEP16R:
UNCHANGED

Source:
UNCHANGED

Tests:
NOT RUN

Build:
NOT RUN

Corrections (v1.1):
- Resolved focus vs selection semantics (§15, §17, §18, §31, §32)
- Deterministic overlap ordering by sampleId (§10.3.1)
- Zoom-dependent, screen-space, presentation-only overlap (§10.1.1)
- Density tint constrained to a transient rendering effect, not clustering (§9.3)
- Explicit classification filter matching against persisted primary+secondary classes (§13.4)
- Low-confidence threshold consumed from application, not invented by UI (§20.2, §21)
- Foreign-public verification-gap wording; no restriction, no guaranteed success (§14.6, §19.1)
- Visibility vs runtime availability distinguished (§23)
- Missing-V2 reachability + no position reconstruction clarified (§22)
- Result-list role defined as integrated secondary surface, not a 4th column/List mode (§6)
- Escape priority dialog → fan → selection; never clears search/filters (§13, §17, §28)
- Cross-platform reset shortcut ⌘/Ctrl + 0 (§11, §28)
- Space/Space+drag pan vs point selection; DRAG_THRESHOLD_PX (§11.3, §28)

Design coverage:
- Visual identity
- Application layout
- Sample Map
- Points
- Density
- Overlap
- Zoom / Pan
- Search
- Filters
- Inspector
- Preview
- Multi-selection
- Machiniste
- Classification
- Confidence
- Missing-V2
- Availability
- Indexing
- Empty states
- Error states
- Accessibility
- Responsive behavior
- Motion
- Component inventory
- Design tokens
- Implementation handoff

Remaining genuine open questions:
1. Whether the owner quick-filter needs pagination for owners with very many samples —
   a scale/implementation concern, not a design blocker.

Settled (no longer open): low-confidence threshold (consumed from application),
search autofocus (off on load; ⌘/Ctrl + F focuses), responsive panel widths (provisional
presentation constants in §27).

STOP — awaiting explicit authorization for implementation.
```
