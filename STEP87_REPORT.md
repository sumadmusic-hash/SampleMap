# STEP87 — Read-only diagnosis: why is the X axis of the map right-heavy?

**Status:** read-only analysis. **No repository file was modified. Nothing was committed.**
**Baseline commit:** `2828e98711bc6390f9276121b8e58dafb38c6b98` (`main` == `origin/main`, tree clean).

---

## 1. Which real dataset was used

The real corpus is **not** in the repository. It was read out of the running app's
browser IndexedDB, read-only:

| Source | How | Result |
|---|---|---|
| Local records | `samplemap` v4 / store `samples` in Chrome profile `127.0.0.1:5173` | **2474 records** |
| Global points | `GET /map?mapVersion=map-v2` on the live D1 worker (public read path, no token) | **1522 points** |

Extraction details and the reproducible snapshots are listed in §8. No fixture, no
synthetic record and no historical report was used as evidence for any number below.

Both real sources were processed with the **production functions**
`mapPoints()` → `globalMapPoints()` → `mergeMapPoints()` from
`src/ui/map/mapView.ts`, and `computeCanonicalSoundSpacePoint()` from
`src/analysis/soundSpaceProjector.ts`.

### Stage counts (real data, production code)

| Stage | Count |
|---|---|
| Records in IndexedDB (`samples`) | 2474 |
| Local points after `mapPoints()` | **2464** |
| — of which `sound-space-canonical` | 2463 |
| — of which `map-v2-legacy` (fallback) | 1 |
| Records with no `soundCharacter` (no point) | 1 |
| Global points after `globalMapPoints()` | **1522** |
| Merged points after `mergeMapPoints()` | **2472** |
| Duplicates removed by the merge | 1514 |

The merge removes 1514 of the 1522 global points: the global pool is almost entirely
the *same content* the local library already holds, so it adds only 8 genuinely new
points. The visible map is therefore, for all practical purposes, the **local** corpus.

---

## 2. The X formula is correct — verified

`src/analysis/soundSpaceProjector.ts:131-136` computes
`x = mean(tonality, 1 - noisiness)` over the dims that are present, and `y = brightness`.

Re-computed independently for every real record:

```
checked 2473   mismatch 0   →  allMatch: true   (max deviation 0.0)
```

**The formula is not the cause.** It is implemented exactly as specified.

---

## 3. Real distribution of X

### Statistics (all 2473 canonical local points)

| Series | n | min | p05 | median | mean | p95 | max | stdev |
|---|---|---|---|---|---|---|---|---|
| **X (canonical)** | 2473 | **0.3984** | 0.5296 | 0.8554 | **0.8222** | 0.9832 | 0.9982 | 0.1371 |
| X (local points) | 2464 | 0.3984 | 0.5296 | 0.8556 | 0.8223 | 0.9832 | 0.9982 | 0.1370 |
| X (global points) | 1522 | 0.0000 | 0.8023 | 0.9427 | **0.9194** | 1.0000 | 1.0000 | 0.1313 |
| X (merged) | 2472 | 0.3984 | 0.5296 | 0.8558 | 0.8227 | 0.9834 | 1.0000 | 0.1371 |
| tonality | 2473 | 0.1323 | 0.3219 | 0.7945 | **0.7485** | 0.9796 | 0.9975 | 0.1942 |
| noisiness | 2473 | 0.0009 | 0.0040 | 0.0849 | **0.1041** | 0.2659 | **0.3964** | 0.0845 |
| brightness (Y) | 2473 | 0.0000 | 0.0471 | 0.5363 | 0.5185 | 0.9377 | 1.0000 | 0.2702 |

Y is essentially perfectly centred (mean 0.5185, median 0.5363, stdev 0.2702).
**The skew is specific to the X axis.**

### X bins (canonical local points)

| Range | n | share |
|---|---|---|
| 0.00–0.10 | **0** | 0.0% |
| 0.10–0.25 | **0** | 0.0% |
| 0.25–0.40 | 1 | 0.04% |
| 0.40–0.50 | 75 | 3.0% |
| 0.50–0.60 | 184 | 7.4% |
| 0.60–0.75 | 314 | 12.7% |
| 0.75–0.90 | 1042 | 42.1% |
| 0.90–1.00 | 857 | 34.7% |

**76.8% of all points sit right of 0.75.** The left half of the map (x < 0.50)
holds 76 of 2473 points = **3.1%**.

### Thresholds

| Threshold | local | global | merged |
|---|---|---|---|
| `x < 0.25` | **0** | 22 | **0** |
| `x < 0.10` | **0** | 22 | **0** |
| `x > 0.75` | 1894 | 1497 | 1902 |

The 22 global points below 0.25 are a separate population (§6) and are all but
eliminated by the merge, so **no point in the visible map is ever left of 0.40**.

### Tonality / noisiness bins

| Range | tonality | noisiness |
|---|---|---|
| 0.00–0.10 | 0 | **1403** |
| 0.10–0.25 | 40 | 902 |
| 0.25–0.40 | 195 | 168 |
| 0.40–0.50 | 131 | 0 |
| 0.50–0.60 | 69 | 0 |
| 0.60–0.75 | 503 | 0 |
| 0.75–0.90 | **987** | 0 |
| 0.90–1.00 | **548** | 0 |

Noisiness **never exceeds 0.3964**. Tonality piles up above 0.60 (1535 of 2473 = 62%).

---

## 4. The two structural bounds that make the left half unreachable

The X formula averages two inputs. Each of them is bounded away from the left edge
by the upstream analysis, not by the projector.

### 4a. `1 - noisiness` can never drop below 0.6036

`noisiness` is computed in `src/analysis/soundCharacter.ts:124-128` as
`weightedMean([flatness, 1 - harmonicity, zeroCrossingRate/0.5], [0.5, 0.3, 0.2])`.

Measured mean contribution of each term over the real corpus:

| Term | weight | mean value | mean contribution | share of noisiness |
|---|---|---|---|---|
| `spectralFlatness` | **0.5** | 0.002681 | 0.00134 | **1.3%** |
| `1 - harmonicity` | 0.3 | 0.2774 | 0.08321 | 80.0% |
| `zeroCrossingRate / 0.5` | 0.2 | 0.0979 | 0.01958 | 18.8% |

The reproduction is exact (max abs error 0.0 across 2473 records), so this is the
production arithmetic — but the **50%-weight term is numerically dead**.

`spectralFlatness` is normalized with `RANGES.flatness = {lo: 0, hi: 1}`
(`src/analysis/soundCharacter.ts:72`), so `norm()` is the identity. The real
observed range of that feature is **[0.000040, 0.032650]** — mean 0.0027, and
**98.4% of all records are below 0.01**. The range was sized for a flatness
feature that would span [0,1] on real audio; it does not. The consequence is
that noisiness is driven almost entirely by `1 - harmonicity`, which is
likewise small because the corpus is mostly pitched material.

Even the literal sample named `White Noise` only reaches noisiness **0.347**
(flatness 0.0045 → contributes 0.0022 of that 0.347).

**Result: `1 - noisiness >= 0.6036` for every record in the corpus.**

### 4b. `tonality` cannot fall below 0.42 whenever a pitch was detected

`tonality = weightedMean([pitchConfidence, harmonicity], [0.6, 0.4])`
(`src/analysis/soundCharacter.ts:121`).

`pitchConfidence` is produced in `src/audio/v2Dsp.ts`:

```
:502   const accepted = best > 0 && bestCm < V2_DSP_CONFIG.pitchCmndfThreshold;  // 0.3
:511   acceptedConf.push(clamp01(1 - bestCm));
```

A frame is only accepted when its CMNDF dip is **below 0.3**, and the confidence is
then `1 - bestCm`. So whenever `pitchConfidence` exists at all, it is **> 0.7 by
construction**. Confirmed on the real data: n=2014, **min 0.7018**, mean 0.8423.

With weight 0.6 this puts a hard floor under tonality:

- records **with** `pitchConfidence` (n=2014): tonality mean **0.8212**, min **0.5284**
- records **without** it (n=459): tonality mean **0.4298**, min 0.1323

**Result: `tonality >= 0.6 * 0.7 + 0.4 * 0 = 0.42` for 81.4% of the corpus.**

### Combined effect on X

```
with pitch (81.4%):    x >= mean(0.42,   0.6036) = 0.5118
without pitch (18.6%): x >= mean(0.00,   0.6036) = 0.3018
```

The observed minimum is **0.3984**. `x < 0.25` is **mathematically unreachable**
for this corpus — the bound is structural, not statistical. No amount of data,
discovery or global population can fill the left quarter of the map.

---

## 5. Is the ranking at least plausible? Yes.

The **order** is correct. The 15 lowest-X records, with their audio metadata:

| x | harmonicity | flatness | centroid Hz | zcr | class | name |
|---|---|---|---|---|---|---|
| 0.3984 | 0.1440 | 0.004497 | 9859.6 | 0.2201 | fx | White Noise |
| 0.4013 | 0.1323 | 0.005783 | 9258.7 | 0.1662 | percussion | THMA_Hat_32 |
| 0.4062 | 0.2088 | 0.005972 | 16048.9 | 0.3901 | openhat | Trap Open Hi Hat |
| 0.4189 | 0.2025 | 0.012619 | 13471.8 | 0.2981 | percussion | JY_TopLoop_126_019 |
| 0.4197 | 0.1873 | 0.006928 | 12219.7 | 0.2517 | openhat | noise ride |
| 0.4236 | 0.1788 | 0.007833 | 9467.8 | 0.2035 | percussion | AS_DH_2_ch |
| 0.4403 | 0.2403 | 0.008995 | 9095.2 | 0.3184 | guitar | TT_Open_Hi Hat1 |
| 0.4411 | 0.1852 | 0.009935 | 8586.6 | 0.1339 | percussion | Synth Percussion 24 |
| 0.4447 | 0.2074 | 0.009250 | 8856.2 | 0.1891 | snare | DTM_Snare_032 |
| 0.4467 | 0.2130 | 0.003002 | 11781.2 | 0.2048 | percussion | {o} Shaker |
| 0.4470 | 0.2280 | 0.010275 | 10708.3 | 0.2428 | hihat | TR8.Chat_03 |
| 0.4500 | 0.2060 | 0.003634 | 9834.5 | 0.1650 | percussion | OFV shaker 1 |
| 0.4605 | 0.2002 | 0.003736 | 4485.6 | 0.0938 | noise | vinyl hiss |
| 0.4618 | 0.2380 | 0.010859 | 9352.1 | 0.2011 | fx | DTM_Glitch_027 |

The leftmost points are hi-hats, shakers, noise rides, vinyl hiss and glitches —
exactly what a "Noisy" pole should contain. They are the only pitch-less,
low-harmonicity, high-zero-crossing records in the set (corpus harmonicity
mean 0.7226, median 0.7657). Among the 40 lowest-X records: 25 percussion,
3 snare, 2 fx, 2 openhat, 2 guitar, 2 hihat, 2 clap, 1 cymbal, 1 noise.

**Diagnosis: the axis is semantically correct but scale-compressed.** The corpus
occupies x ∈ [0.40, 1.00] instead of [0, 1].

---

## 6. The global pool is a different axis, not a missing population

The 1522 global points are **not** canonical sound-space points. They are
`map-v2` positions served by D1 and are passed through `globalMapPoints()`
(`src/ui/map/mapView.ts:517-531`), which copies `gp.x`/`gp.y` verbatim.

Their distribution:

- x mean **0.9194**, median 0.9427, stdev 0.1313 — even more extreme than local
- **526 points at exactly x = 1.0**, 22 at exactly x = 0.0
- 98.4% of the points above 0.75
- decile 8, 9 and 10 are all exactly 1.0000

This is a **saturated, differently-scaled axis** (`map-v2` is the older weighted
projection, not the sound-space tonality axis). It is not evidence of a larger,
noisier population that the local library is missing — and since the merge drops
1514 of 1522 as duplicates, the global pool changes the visible map by 8 points.

---

## 7. Where the asymmetry first appears

Comparing the stages (local vs global), the shift is already fully present in the
**local canonical** points and is not introduced by the merge:

| Stage | mean x | median x | share x>0.75 | share x<0.25 |
|---|---|---|---|---|
| canonical local (production projector) | 0.8222 | 0.8554 | 76.8% | 0.0% |
| after `mergeMapPoints` | 0.8227 | 0.8558 | 76.8% | 0.0% |

The projector reproduces the corpus faithfully; the corpus is already
right-concentrated because of §4a and §4b. **The projector is not at fault.**

Counterfactuals on the real 2473 records (illustrative only, nothing was changed):

| Variant | min x | median | mean | x<0.25 | x>0.75 |
|---|---|---|---|---|---|
| A production (baseline) | 0.3984 | 0.8554 | 0.8222 | 0.0% | 76.8% |
| B flatness rescaled to the observed [0, 0.033] | 0.3254 | 0.8387 | 0.8023 | 0.0% | 71.9% |
| C tonality from harmonicity only (drop pitchConfidence) | 0.3984 | 0.8396 | 0.8093 | 0.0% | 68.4% |
| D both | 0.3254 | 0.8247 | 0.7894 | 0.0% | 63.8% |

Rescaling alone does not restore the left half — the two bounds are independent,
and both must be addressed for the axis to use its full range.

---

## 8. Answer, and how the data was obtained

**The right-heavy X axis is caused by the `tonality` and `noisiness` inputs, not by
the projector, not by the population, and not by the global/merge stage.**

Two structural bounds in `src/analysis/soundCharacter.ts` cap the reachable X range:

1. **`RANGES.flatness = {lo: 0, hi: 1}` (line 72) is mis-sized for real audio.**
   Real `spectralFlatness` spans [0.00004, 0.0327], mean 0.0027. The 0.5-weight
   term of `noisiness` therefore contributes 1.3% of its intended magnitude, and
   noisiness never exceeds 0.3964 → `1 - noisiness >= 0.6036` always.
2. **`pitchConfidence` is acceptance-gated** (`src/audio/v2Dsp.ts:502,511`): it is
   `1 - bestCm` and only recorded when `bestCm < 0.3`, so it is > 0.7 whenever it
   exists. At weight 0.6 this floors `tonality` at 0.42 for 81.4% of the corpus.

Consequently x = mean(tonality, 1 - noisiness) is confined to [0.40, 1.00] in
practice; **x < 0.25 and x < 0.10 are unreachable for any population**. The
ranking within that range is correct and plausible (leftmost = hi-hats, shakers,
noise, vinyl hiss), so the defect is one of **scale calibration**, not semantics.

### Reproduction

```bash
# local corpus (read-only, no network, no non-local requests attempted)
# -> 2474 records, 2464 local points, 2463 canonical + 1 legacy
# global corpus
curl "https://samplemap-d1-worker.sumadmusic.workers.dev/map?mapVersion=map-v2&xMin=0&xMax=1&yMin=0&yMax=1&limit=500"
# -> 1522 points over 4 pages
```

Working directory for all temporary artifacts (nothing inside the repository):
`/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step87/`
— `samples.ndjson` (2474 records), `global-all.json` (1522 points),
`analysis.json` (full per-record table incl. all extremes and features).

### Notes on method

- The corpus was extracted from a **copy** of the Chrome profile
  (`rsync` of the IndexedDB directory), opened with real Chrome 154 in headless
  mode. Chrome for Testing 153 refuses the store with
  `IndexedDB backing store had unknown schema`; Chrome 154 (the version that
  wrote it) opens it cleanly. Two earlier snapshots were discarded because they
  had been contaminated by an initial read that created an empty v1 store.
- The dump route was verified to attempt **0 non-local requests**, so no
  re-analysis, re-fetch or write against the live backend occurred.
- The `.env` publish token was not used and is not reproduced here.
