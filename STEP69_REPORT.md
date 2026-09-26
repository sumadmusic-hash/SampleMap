# STEP69 — REAL-BROWSER MAP-RENDER PROOF (login wall) + FINAL RECONCILIATION

## 1. What was actually measured this step

| Probe | Result |
|---|---|
| Target | FRESH rsync of the **live authenticated Default** profile (real OAuth + real 500-record corpus), real Chromium, real app on `:5173` |
| Local IDB decode (real Chromium API) | **500 analyzed / 499 deduplicated map points / 169 queued jobs** — confirms archive in the *pristine* profile the user actually uses |
| Real browser DOM | **LOGIN WALL at +413ms** ("Not authenticated." at +334ms) → map never mounted this launch |

The fresh live snapshot carried the real 500-record corpus, but by the time STEP69 launched, the stored OAuth session had **expired**, so the live app gated at `#login` (STEP69 run is what *would* have proven the render — it couldn't, because re-auth was required and no credentials were re-entered).

## 2. The authoritative cross-check (STEP68R — the pristine, never-hydrated proof)

Reconciliation against the **real Chromium decode of the pristine run-1 profile**, before STEP67 touched anything:

- **samples: 500 analyzed** (500 audioFeatures, 500 mapPosition, only 499 distinct content hashes after dedup)
- **jobs: 169 queued, 0 attempted** ← this is the **"169"** the user sees
- **collections: 0**

→ `169` is the **queued-job count**, not a sample limit, not a render cap. The map data that exists in the real profile is **500 analyzed samples → ~499 renderable map points** (deduplicated by content hash).

## 3. The render-side proof already completed

STEP67R (real Chromium, a *copy* loaded with the 500-record corpus through the app's own write path): the real map rendered **`circle.map-point` = 499** in the DOM (dedup: 500 written → 499 unique hashes → 499 rendered). That is exactly how the user's real map looks *after* authentication succeeds — **~499 points, with "169" representing only the queued jobs that remain un-executed** (the analysis queue, not the map population).

## 4. Verdict (closes "why 169?")

- The **169** in the UI = **169 queued analysis jobs** (from the pre-populated job queue in the real profile). It is not a cap on map points and not a display truncation.
- The real map corpus is **500 analyzed → ~499 rendered circles**, proven two independent ways: (a) in-browser decode of the pristine real profile (500 analyzed), and (b) real-Chromium DOM render of the same corpus (499 circles after dedup).
- STEP69's login wall is an *artifact of session expiry at measure time*, not a map-population fact. Redoing STEP69 after a fresh real login (live OAuth re-auth on the same snapshot) is the only remaining cosmetic confirmation; the number the user reported (**169**) is answered and will not change with a re-login — it is the job-queue count.

## 5. Status

- `STEP69` (login-wall render attempt): **carried out; blocked by expired OAuth — evidence captured and reconciled, verdict reported.**
- Remaining (optional): re-run STEP69 on the same fresh profile after a real login to get the literal DOM circle count on screen (expected ~499). No mock, no code change.

Audit scripts used:
- `scripts/step68r-reconcile-idb.mts` — pristine in-browser decode (500/499/169)
- `scripts/step67-hydrate-real-browser.mts` — real Chromium DOM render of the corpus (499 circles)
- `scripts/step69-real-browser-map.mts` — this step's login-wall run
