# STEP66 — Audit: Warum zeigt die Sample Map weniger als 200 Punkte, obwohl STEP65 mit 1.439 analysierten Samples arbeitet?

**Deliverable:** Finalbericht (Klassifikation A–E + genau EIN konkreter STEP67-Schritt). **Reiner Audit — keine Produktionsänderung.** Jede Aussage mit `FACT` (gemessen) / `CODE` (Quelltext) / `INFERENCE` (abgeleitet) / `UNKNOWN` (nicht verifizierbar) getaggt.

Messbasis (FACT): **realer Browser** (echtes Chrome mit Kopie des echten Chrome-Profils, echte OAuth-Session `users/sumad`, echter Live-Backend, Vite auf :5173) via `scripts/step66r-map-audit.mts` + direkte Probing des Live-D1-Workers. Zeitstempel: 2026-09-11.

Date: 2026-09-11

---

## 1. Executive Verdict

**Die sichtbare Map rendert aktuell 0 Punkte (leere Map mit „No analyzed samples yet."), nicht „weniger als 200".** `FACT` (realer Browser).

Ursache: **Die 1.439 Samples des STEP65-Korpus existieren ausschließlich als NDJSON-Exporte einer Headless-Analyse (STEP42/44/44.1/45) — sie sind nie in die Datenebene gelangt, die die Map liest.** Die Produktions-Datenebene enthält zum Zeitpunkt der Messung:

| Quelle der Map-Daten | Bestand (FACT) |
|---|---|
| Lokale IndexedDB (`samplemap.samples`, realer Browser) | **0 Records** (169 Jobs `queued`, keine analysiert) |
| Globaler D1-Worker `/map` (map-v2) | **1 Punkt** (Test-Kick `samples/16i-mapcheck-…`) |
| Globaler Read-Pfad im App-Boot | **nicht verdrahtet** (`VITE_GLOBAL_WORKER_URL` ungesetzt → „Global: idle", **kein `/map`-Request im Netzwerk**) |

⇒ 0 lokale + 0 globale Punkte → Emptystate. Die Antwort auf „Warum < 200?" ist: **Die Produktions-Map bekommt die Samples gar nicht (LOAD/AVAILABILITY-Ausfall), nicht weil sie gefiltert, für ungültig oder vom Renderer limitiert würden.**

**Verdict: A — LOAD/PAGINATION LIMIT** (im Sinne von „die Map erhält nur einen (hier: gar keinen) Teil der Samples" — die einschränkende Stufe ist die Verfügbarkeits-/Ladestufe der Datenplane, nicht Pagination im engeren Sinn). Detailierte Begründung in §10.

---

## 2. Production Map Data Path

Der echte, zurückverfolgte Produktionspfad (`CODE`):

| # | Stufe | Datei / Funktion | Ergebnis bei leerer Datenplane |
|---|---|---|---|
| 1 | Boot + Auth | `src/main.ts` (`mountLiveSampleMap`) → `src/ui/main.ts:27-50` `mountAuthenticated` | authentifiziert + Projekt geöffnet |
| 2 | **Lokale Records = Suchergebnis** | `src/ui/main.ts:46` `await app.refreshSearch()` → `src/ui/app.ts:886-908` → `deps.search.search(q)` (SuchenEngine, `src/search/searchEngine.ts:92-134`); Map nutzt `app.results` (`src/ui/render.ts:773`: `records: app.results.map(r => r.record)`) | Ohne Query → **limit-los alle analysierten Records** `CODE` |
| 3 | **Globale Records** | `src/ui/main.ts:48` `void app.refreshGlobalPoints()` → `src/ui/app.ts:1011-1049` (`queryMapViewport`, bbox, 2×500) | Nur wenn `globalIndex` gesetzt |
| 3a | `globalIndex`-Verdrahtung | `src/main.ts:200`: `globalIndex: readProviderFor(publishProvider, Boolean(GLOBAL_WORKER_URL))`; `src/global/liveProvider.ts:65-70`: ohne URL → `undefined` | **nicht verdrahtet** (`CODE`) |
| 4 | Map-Modell (dedup) | `src/ui/map/mapView.ts:327-380` `mapPoints()` (Gate: `status==="analyzed" && audioFeatures`, Position canonical V2 sonst `mapPosition`, Dedup per `contentHash`, Repräsentant lex-min) | 0 Records → 0 Punkte |
| 5 | Merge local + global | `src/ui/map/mapRender.ts:130-134` (`mapPoints` + `globalMapPoints` + `mergeMapPoints`) | 0 |
| 6 | Render | `mapRender.ts:136-143`: `points.length===0` → **Emptystate**, kein SVG; sonst 1 `<circle class="map-point">` pro Punkt, **kein Cap / kein slice** | Emptystate |

Kein Mock, keine reine Einheitsanalyse: Stufen 1–6 sind im realen Browser gemessen (FACT) bzw. direkt aus `CODE` verifiziert.

---

## 3. Population at Each Stage

Gleicher Korpus, gemessen (FACT real browser für Produktion; FACT-Skript für Korpus):

| Stufe | Anzahl | Davon ausgeschlossen | Grund |
|---|---:|---:|---|
| analysierte Samples (STEP65-Korpus) | **1.439** | — | Ausgangspunkt (NDJSON-Exporte, Headless-Analyse STEP42/44/44.1/45, `FACT`) |
| verfügbare/persistierte Samples (Produktion, lokale IDB) | **0** | 1.439 | Korpora sind **Out-of-Band** — nie in die Browser-IndexedDB gespeichert; Profil im STEP62-Zustand: 0 Samples, **169 Jobs queued** (nie analysiert) `FACT` |
| von API/D1 gelesen | **0** | 0 | Globaler Read nicht verdrahtet (`VITE_GLOBAL_WORKER_URL` fehlt); kein `/map`-Request `FACT` |
| nach Pagination | **0** | 0 | kein Request → keine Seiten |
| nach Filtern | **0** | 0 | keine Records vorhanden; Suchfilter/Statusfilter leer (kein Suchtext, keine Klassen, `relevance desc`) `FACT` |
| gültige `mapPosition` | Produktion **0** / Korpus **1.439** | 0 | Korpus: jedes der 1.439 hat `mapPosition` `FACT`; Produktion: keine Records |
| gültiger `SoundCharacter` | Produktion **0** / Korpus **1.439** | 0 | Korpus: jedes hat projektierbares `soundCharacter` `FACT` (STEP65) |
| nach Deduplication | Produktion **0** / Korpus **1.433** | 6 (nur Korpus) | 6 Hash-Kollisionen (geteilte Audio-Content-Identität) → 6 Webseiten-SampleIds ⇒ 1.433 eindeutige Kartenpunkte falls geladen `FACT` |
| an Map übergeben (local `app.results` + `globalPoints`) | **0** | 0 | leere Records (`0 samples`) + kein globaler Punkt |
| tatsächlich gerendert (DOM `<circle class="map-point">`) | **0** | 0 | `points.length===0` → Emptystate `FACT` |

**Jede Differenz erklärt (§15):** 1.439 → 0 fällt vollständig an der Stufe „verfügbare/persistierte Samples in Produktion". Kein Filter-, Validitäts- oder Dedup-Verlust wirksam.

---

## 4. Pagination / Backend Limits

Map-relevante Reads (Untersuchung aller, `CODE` + Live-Probe `FACT`):

**A. Lokale Suche (`src/search/searchEngine.ts:92-134`)**
* API: `IndexStore.getAll()` + In-Memory-Filter/Sort (`SearchEngine.search`)
* pageSize: **kein** paginiertes Lesen — `getAll()` liest den kompletten Index `CODE`
* pageToken: entfällt
* Lieferung pro „Seite": alle analysierten Records (Status-Filter default `["analyzed"]`), `limit` nur wenn gesetzt — App sendet **kein** Limit (`app.ts:893`) `CODE`
* Alle Seiten: ja, triviale 1 Seite
* Serverseitiges Limit: keines auf der lokalen Suche `CODE`

**B. Globale MAP (`/map`, `workers/d1-worker/src`)**
* API: `GET /map` (`index.ts:174-209`) → `CloudflareGlobalSampleIndex.queryMapViewport` (`provider.ts:415-491`)
* pageSize: Client fordert **500** (`GLOBAL_MAP_PAGE_LIMIT`, `app.ts:455`); Server caps mitsamt `maxMapLimit || 1000` (`index.ts:80`); Server-Default ohne `limit` = **200** (`index.ts:79`)
* pageToken: Base64-frei, **numerischer URL-Offset** via `cursor` (`provider.ts:438,581-585`)
* Einträge pro Seite: bis `min(clientLimit, maxMapLimit)`; Server liefert `limit+1` Zeilen um `hasMore` zu erkennen, gibt `limit` zurück `CODE`
* Folge-Seiten: Client loop `for page < GLOBAL_MAP_MAX_PAGES(2)` und bricht bei fehlendem `nextCursor` ab (`app.ts:1022-1039`) ⇒ **max. 1.000 globale Punkte pro Kamera-Bbox**
* Abbruch nach erster Seite: nur wenn `nextCursor` fehlt (≤ 500 identische/cursorfreie Ergebnisse) `CODE`
* Serverseitiges Limit: **ja** — `maxMapLimit || 1000`; `defaultMapLimit || 200` `CODE`
* Live-Probe: `/map?mapVersion=map-v2&…&limit=1000` → **1 Punkt**; `map-v1` → **10 Punkte** (nur e2e-/Test-Repräsentanten) `FACT`

**Kann die sichtbare Map überhaupt mehr als ~200 Samples bekommen? Ja — strukturell.**
* Lokal: unbegrenzt (`mapPoints` hat kein Limit, `CODE`) — 1.439 Korpus-Samples würden als ~1.433 Punkte gerendert.
* Global: fester Cap von 1.000 (2×500) reicht für „>200"; Server-Cap 1.000.
* Aktuell greift keiner der Caps, weil keine Daten vorhanden sind. Der Engpass ist **nicht** ein 200er-Limit irgendwo im Code (es existiert keins außer den Defaults `defaultMapLimit=200`, die nur ohne Client-Limit greifen und vom Client-`limit=500` übersteuert werden) `CODE`.

---

## 5. Filters

Vollständige Kategorisierung aller Filter, die Samples vor der Map entfernen:

| Name | Datei/Funktion | Bedingung | Vorher → Nachher | Entfernt |
|---|---|---|---|---|
| Status-Filter (Suche) | `searchEngine.ts:104` | `status` ∈ `["analyzed"]` (default) | Korpus: 1.439 → 1.439 (alle analysed) | 0 `FACT` |
| `audioFeatures`-Gate | `mapView.ts:331` | `!r.audioFeatures` → skip | 1.439 → 1.439 | 0 (alle haben Features, STEP65) `FACT` |
| Position-Gate | `mapView.ts:351-355` | weder projektierbares V2-`soundCharacter` noch `mapPosition` → skip (Missing-V2) | Korpus 1.439 → 1.439 | 0 `FACT`; Produktion: n/a (0 Records) |
| **mapVersion-Filter (Server)** | `provider.ts:422` | `map_version = ?` (map-v2) auf D1-`content` | D1 10 (map-v1 Test) → **1** (map-v2) | 9 (map-v1-Testzeilen, nie die 1.439) `FACT` |
| Bbox-Filter (Server) | `provider.ts:425-432` | `map_x/map_y` in xMin..xMax/yMin..yMax | bei vollem Viewport [0,1]²: alles | 0 `FACT` |
| primaryClass (Server) | `provider.ts:433-436` | nur falls gesetzt — Client sendet keins | — | 0 `CODE` |
| owner / visibility / status / version-Gate | — | **keine** solchen Filter im Map-Pfad | — | 0 `CODE` |
| Suchtext/`classes`/`minConfidence` | `app.ts:888-891` / `searchEngine.ts:105-113` | nur bei aktivem Such-/Filterzustand | initial leer | 0 `FACT` |
| max point count | s. §4 | lokal keines; global 1.000 | — | nur ab >1.000 global wirksam `CODE` |
| Tag-/Kategorie-/One-shot/loop-/Owner-UI-Filter auf der Map | — | nicht vorhanden (Keine Map-spezifischen Filterkomponenten) | — | 0 `CODE` |

**Verdrahtungshinweis (§5/§6):** Der einzige „Filter", der aktuell etwas ausschließt, ist die **Verfügbarkeit selbst**: `app.results` (lokale IDB) ist leer und der globale Read unverdrahtet. Das wird nicht durch einen Code-Filter verursacht, sondern durch fehlende persistierte Daten + fehlende Env-Verdrahtung.

---

## 6. Missing / Invalid Analysis

**Produktion (realer Browser, FACT):** Überschneidungen explizit:

* analysiert (`samples` gesamt): **0** → analysiert mit `audioFeatures`: **0** → mit `mapPosition`: **0** → projektierbar (V2 Canonical): **0** → nach Dedup: **0**
* Jobs: **169 queued** (0 analyzed, 0 failed, 0 gone) — kein abgeschlossener Analyseauftrag im Profil `FACT`

**Korpus (STEP65, FACT-Skript):**
* ohne `mapPosition`: **0**; ohne `soundCharacter`: **0**; ohne X/Y: **0** (1.439/1.439 haben beide Koordinaten); invalide Werte: 0 (alle im [0,1])
* fehlende Version: `contentHashVersion` bei allen 1.439 gesetzt (`pcm-v1`); sonstige Guard-Rows (`gatePassed` etc.) auf dem Korpus nicht anwendbar (ist ISD eines Headless-Exports) `INFERENCE`

→ Fehlende/invalide Analyzewerte sind **nicht** die Ursache: der Korpus wäre zu 100 % Karten-fähig; in Produktion existieren schlicht keine Records.

---

## 7. Deduplication

* Schlüssel: `AudioContentIdentity` = `(contentHashVersion, contentHash)`; Map-Key `"${contentHashVersion}:${contentHash}"` (`mapView.ts:332-337`, `audioContentIdentity.ts:31-33`) `CODE`
* UUIDs werden **nicht** als Identität verwendet — contentHash ist ein SHA-256 der kanonisierten PCM; `sampleId` wird nur zur Repräsentantenwahl (lex-min) verwendet `CODE`
* Gemessene Dedup-Wirkung (Korpus): 1.439 SampleIds → **1.433 eindeutige Identitäten** (6 Hash-Kollisionen = 6 Samplepaare mit identischem Audio, erwartungsgemäß auf einer Produktionsbibliothek) `FACT`
* Fälschlich-identisch-Risiko: bei korrektem `contentHash` + `contentHashVersion` kein Fehlerbild (identisches Audio ⇒ gleiches PCM ⇒ gleiche Karte). Korpus-Kollisionen sind echte Content-Duplikate `INFERENCE`
* Produktion: keine Dedup-Differenz messbar (0 Records) `FACT`

---

## 8. Actual Rendered Point Count

`scripts/step66r-map-audit.mts` — realer Browser, realer Profile-Zustand (FACT):

```
Map model points:  0   (local app.results = []; globalPoints = [] — global read unwired)
DOM/SVG point elements:  0  (<circle class="map-point"> in [data-testid="sample-map"] = 0)
Canvas draw calls / logical points:  0  (renderSampleMap drew the EMPTY branch: map-empty only)
```

Warum DOM ≠ Modell? Sie sind identisch (0 = 0). Kein Punkt wird geladen-und-nicht-gezeichnet: `mapRender.ts:136` rendert bei `points.length===0` garantiert keinen Punkt, sondern den Emptystate `CODE`. Das beantwortet §9: **„Daten werden gar nicht geladen" — nicht „geladen, aber nicht gezeichnet".** Zusätzlich: `map-empty` vorhanden, `sampleMapSvg`=0, `resultCount="0 samples"`, `#results-list`=0, Suchfeld leer, keine Klassen-Chips, `[data-testid="map-global-state"]="Global: idle"`, `map-zoom-label="100%"` (kein gezoomter/sichtbarer Ausschnitt-Filter) `FACT`.

---

## 9. STEP65 Corpus vs Production Map

* **STEP65-Korpus:** 1.439 Samples aus den NDJSON-Exporten `step42/step44-analysis.ndjson`, `step44.1/step44.1-analysis.ndjson`, `step45/step45-reclass-after.ndjson` — Ergebnisse einer **Headless-Analyse**, erzeugt mit demselben Pipeline-CODE, aber **nie** in die Browser-IndexedDB geschrieben und **nie** an den D1-Worker publiziert `FACT` (Dateien existieren; IDB leer; D1-Tabelle de facto leer).
* **Produktions-Map liest:** lokale IDB (`samples`) + (unverdrahtet) D1 `/map`.
* **Schnittmenge `STEP65 ∩ Map`:** die SAMPLE-IDs überlappen mit **0** (kein Korpus-Sample in IDB; kein Korpus-Repräsentant in D1 — D1 enthält ausschließlich Test-/e2e-Rows `16k-live-e2e`, `abc-alpha`, `16i-*`, `16j-*`) `FACT`.
* **`STEP65 \ Map` = 1.439.** Gründe, warum Korpus-Samples nicht auf der Map landen (`INFERENCE`, gestützt auf CODE+FACT):
  1. Es existiert kein Lade-Mechanismus, der NDJSON-Exporte in die Produktions-IDB importiert (der App-Importweg ist der echte Analyse-/Batch-Pipeline-Lauf im Browser, `mountAuthenticated` → Analyse) `CODE`.
  2. Das reale Profil befand sich im Messzeitpunkt im STEP62-Zustand (0 Samples, 169 queued, 0 Collections) – die 169 queued Jobs wurden nie ausgeführt `FACT`.
  3. Der globale Read-Pfad ist nicht verdrahtet (`VITE_GLOBAL_WORKER_URL` nicht in `.env`), und selbst verdrahtet wäre D1 faktisch leer (1 Kartenpunkt) `FACT`.

---

## 10. Root Cause Classification A–E

**Haupturteil: EIN Buchstabe — A — LOAD/PAGINATION LIMIT.**

* **A (LOAD): JA — einschlägig.** Die verfügbare/ladende Stufe der Produktions-Datenplane liefert der Map **0** der 1.439 Samples: lokale IDB leer + globaler Read unverdrahtet (+ D1 de facto leer). Kategoriegemäß „die Map bekommt nur einen kleinen Teil der Samples" – hier genau null.
* **B (FILTER): nein.** Kein Such-, Klassen-, Status-, Owner- oder Map-spezifischer Filter aktiv; die einzigen aktiven Gates (`status=analyzed`, `audioFeatures`, Position) verwerfen im Korpus 0 Samples und in Produktion „nichts" (keine Eingabe) `FACT/CODE`.
* **C (ANALYSIS/VALIDITY): nein.** 1.439/1.439 Korpus-Samples sind karten-fähig (mapPosition + SoundCharacter vorhanden, [0,1]-gültig) `FACT`.
* **D (RENDER LIMIT): nein.** `mapRender` zeichnet alle Punkte ohne Cap/slice; bei 0 Punkten kommt der Emptystate — kein Punkt wird geladen-und-nicht-gezeichnet `FACT/CODE`.
* **E (COMBINATION): nicht gewählt.** Sekundär wirksam, aber nicht ursächlich, sind globale Caps (Client 2×500, Server 1000) — sie hätten nur bei >1.000 globalen Punkten Bedeutung; heute greifen sie nicht (0 Daten).
* **Kurzantwort auf die Eingangsfrage:** *„Wir haben 1.439 analysierte Samples (als NDJSON-Korpus). Warum < 200 Punkte? Weil die produktechte Map diese 1.439 nicht als Daten kennt — lokale IndexedDB = 0 analysierte Samples und der globale `/map`-Read ist unverdrahtet/D1 leer. Die Zahl 1.439 ist real, aber mit der sichtbaren Karte verbunden über keinerlei Persistenz/Ladeweg."*

---

## 11. Exactly One Recommended STEP67

**STEP67 — „Datenebene der Produktions-Karte wiederherstellen und messen":**

Importiere die 1.439 validierten Analyse-Ergebnisse des STEP65-Korpus als echte Records in die lokale Produktions-IndexedDB (über den bestehenden Persistenz/Publish-Pfad der App, z. B. einen einmaligen, verification-gestützten `hydrate`-/Batch-Import-Job, der die NDJSON-Exporte in `samplemap.samples` realistisch überführt und anschließend den D1-Publish-Pfad nutzt), **und** setze `VITE_GLOBAL_WORKER_URL` in `.env`, damit der globale Read-Pfad (`refreshGlobalPoints` → `/map`) live die globale Karte nachlädt.

Abschluss des Schritts ist die erneute Messung mit `scripts/step66r-map-audit.mts`: erwartet werden **~1.433 gerenderte `<circle class="map-point">`** (= 1.439 deduplicierte Content-Identitäten), lokale IDB `samples > 0`, `map-global-state ≠ idle`. Nur daran ist „STEP67 erfolgreich" zu bemessen.

Begründung (rein aus dem Befund abgeleitet, keine Allzweck-UI-Empfehlung): Der einzige gemessene Engpass ist die **Verfügbarkeit der Daten in der Produktions-Datenebene** (0 persistierte Samples; globaler Read unverdrahtet; D1 faktisch leer). Kein Filters-, Pipeline-, Projektions- oder Rendering-Fix ist angezeigt (§14 sagt explizit: nur messen/analysieren — STEP67 bleibt Daten-Integration + Messung, keine Produktions-Codeänderung an Pagination/Limits/Filtern/Rendering).

---

## Anhang: Mess-Reset (Reproduzierbarkeit, alles `FACT`)

```
# Realer Browser-Audit (Profile-Kopie, echte OAuth, echter Live-Backend, Vite :5173):
npx tsx scripts/step66r-map-audit.mts
#   → IDB: samples=0, jobs=169 queued, collections=0; DOM: map-empty=1, circles=0; global=idle

# Live-D1-Worker:
curl "https://samplemap-d1-worker.sumadmusic.workers.dev/map?mapVersion=map-v2&xMin=0&xMax=1&yMin=0&yMax=1&limit=1000"   # 1 Punkt
curl "https://samplemap-d1-worker.sumadmusic.workers.dev/map?mapVersion=map-v1&xMin=0&xMax=1&yMin=0&yMax=1&limit=1000"   # 10 Testpunkte

# Korpus-Dedup/Validität (Node, siehe Scriptausgabe):
#   rows=1439, distinctContentHashes=1433, mit mapPosition=1439, mit soundCharacter=1439
```