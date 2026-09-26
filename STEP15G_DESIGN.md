# SAMPLEMAP V1 — STEP 15G DESIGN
## Audio Quality Gate · Audio Identity & Duplicate Handling

Status: **Design / Analyse — nichts implementiert.**
Baseline: 267 Tests / 20 Dateien, TypeScript clean, Build OK (unverändert).
Step-15G-§29 verbindliche Struktur: exakt die 20 Abschnitte dieses Dokuments.

Legende: **VERIFIED** = direkt am Code/den installierten Typen bestätigt · **NOT VERIFIED** = angenommen, jetzt nicht bestätigbar · **OPEN QUESTION** = offen · **DEFERRED** = später · **DECISION** = Designentscheidung dieses Steps.

---

## 1. Executive Summary

- **Quality Gate ist ein hartes Aufnahme-/Analyse-Gate** (DECISION, §5). Ein
  REJECT erzeugt kein SampleMap-Objekt: kein Map-Punkt, keine Klassifikation,
  kein Similarity-Beitrag, kein repräsentativer Klang. Die Audiotool-Referenz
  bleibt unverändert bestehen (§5).
- **Aktueller Befund (VERIFIED, unbefangen):** `browserFetchAudio` in
  `src/ui/bootstrap.ts:71` wählt die Analysequelle in der Reihenfolge
  `previewMp3Url || mp3Url || wavUrl || flacUrl` — d. h. die Pipeline analysiert
  derzeit **standardmäßig die verlustbehaftete MP3-Preview**. Das ist ein
  Architekturproblem und als solches dokumentiert. Es wird in Step 15G **nicht**
  behoben (§5).
- **Identity-Modell (DECISION, §6).** Drei getrennte Ebenen, die nie gemischt
  werden:
  1. Exact File Duplicate (§7) — byte-identische Datei (SHA-256 der transienten Bytes).
  2. Audio Content Identity (§6) — identischer Audioinhalt trotz technischer
     Dateiunterschiede (kanonischer PCM-Hash nach Decode).
  3. Perceptual Similarity (§8) — ähnlicher, aber nicht identischer Klang;
     keine Identität, V1 zurückgestellt.
- **Name ≠ Identität (DECISION, §6).** `samples/A…→Kick.wav` und
  `samples/B…→Kick.wav` sind verschiedene Namen; Identität entsteht nur aus
  Inhalt/Bytes.
- **Map Point = eindeutiger Klang, nicht Sample-ID (DECISION, §9).** Mehrere
  Audiotool-Referenzen können auf denselben Punkt zeigen; alle Referenzen
  bleiben für Machiniste erhalten (§13).
- **V1-Empfehlung (§16):** Analysequelle grundsätzlich lossless (WAV/FLAC);
  REJECT, wenn nur lossy verfügbar; Identity via SHA-256 (Datei) + kanonischem
  Content-Hash; kein ML, keine Cloud, keine neuen Abhängigkeiten, keine neuen
  DB-Felder in diesem Step.
- **Nichts implementiert (VERIFIED):** keine Produktionsdatei geändert.

---

## 2. Current Architecture

### 2.1 Pipeline (VERIFIED — `src/pipeline/analysisPipeline.ts`)

```
resolveSample (SampleMeta)
  ↓
fetchAudio  → FetchedAudio { bytes: ArrayBuffer; release(): void }  (transient)
  ↓
decode      → DecodedAudio { sampleRate, channels, mono, durationSeconds }
  ↓
extractFeatures → AudioFeatures (13 Werte)
  ↓
classify    → ClassOutput (primary/confidence/secondary)
  ↓
index.upsert → SampleIndexRecord
  ↓
release()
```

- `DecodedAudio` (VERIFIED, `src/audio/decodedAudio.ts`) trägt **kein
  Format/Codec** — nach dem Decode ist die Quelle nur noch an `sampleRate` /
  `channels` erkennbar. Formatwissen muss also **vor/bei fetch+decode**
  eingeholt werden.
- Die Browser-Decode-Implementierung ist `browserDecode` → Web-Audio
  `decodeAudioData` (VERIFIED, `src/ui/bootstrap.ts:46`).
- Idempotenz pro `(sampleId, analysisBuild)`, Analyse-Status
  `pending/analyzed/failed/gone`, Queue-Status zusätzlich `skipped`
  (VERIFIED, `queueStore.ts`).
- Audio-Bytes bleiben transient; `assertNoAudioBytes` schützt `IndexStore` und
  `QueueStore` (VERIFIED, `indexStore.ts`/`queueStore.ts`).

### 2.2 Validate-Quellen (VERIFIED — `node_modules/@audiotool/nexus/…/sample/v1/sample_pb.d.ts`)

`Sample` (Proto `audiotool.sample.v1.Sample`) setzt aus:

```
mp3Url          (MP3, lossy)
wavUrl          (WAV)
flacUrl         (FLAC)
previewMp3Url   (MP3, lossy, Preview-only)
```

- `SampleMeta` liefert **keine** verifizierten Felder `codec`, `bitrate`,
  `compressionQuality` (VERIFIED — solche Felder existieren im Typ nicht;
  NOT VERIFIED als „existieren woanders“).
- **Immutability (VERIFIED):** Protobuf-Kommentar zu `Sample.update_time`:
  „The underlying audio can't be changed.“ → Die Audio-Content-Identity kann
  nach erfolgreicher Berechnung als stabil betrachtet werden (§6/§7/§14).

### 2.3 Persistenz (VERIFIED — `src/persistence/indexStore.ts`)

- `SampleIndexRecord` enthält **keine** Felder `format`, `codec`, `quality`,
  `hash`, `audioIdentity`.
- Vorhandene Provenienz-Felder: `audioFeatures.sampleRate`,
  `audioFeatures.channels`, `analysisVersion` (`"features-v1"`),
  `analysisBuild` (`"smap-build-v1"`), `classificationVersion`
  (`"heuristic-v1"`).
- Record-Schlüssel: `sampleId` (= Audiotool-`samples/{uuid}`), genau **ein
  Record pro Audiotool-Referenz** heute (VERIFIED).
- Map-Position pro Record aus `tonalNoiseRatio`/`spectralCentroid`
  (`mapPosition`, `mapVersion="map-v1"`); Such-/Filter über
  `SampleMapSearchEngine`; Preview lauschender Asset über
  `previewUrlFor(record)?.previewMp3Url` (VERIFIED, `bootstrap.ts:139`).

---

## 3. Audio Quality Requirements

Anforderung (verbindlich): **Samples mit schlechten Codec-/Kompressionseigenschaften
werden nicht in SampleMap aufgenommen** — kein optionaler UI-Filter, sondern ein
hartes Gate (§5).

### 3.1 Kriterien — „Qualität“ ist hier technisch (DECISION)

- Gemessen wird die **Quell-/Kodierungsqualität** der bereitgestellten
  Audiotool-Quelle für die Analyse, **nicht** der Klangcharakter.
- Explizit **kein** REJECT-Grund ist ästhetische/musikalische Bewertung:
  - kein REJECT wegen „klingt hart“, „klingt leise“, „dirty/lo-fi ästhetik“,
    „rauschig“, „verrauscht“, „klingt billig“.
  - Kovarianz-Falle markiert: Geräusche (`noise`/`atmosphere`), hohe
    `spectralFlatness`, niedriges `tonalNoiseRatio`, kurze Preview-Attacken —
    das sind **Klangeigenschaften**, kein Qualitäts-Urteil.
- Das Gate operiert auf objektiv messbaren Größen (§4) und kennt nur
  **ACCEPT oder REJECT** (keine Graustufen, §5).

### 3.2 Verifizierbare Messgrößen (umgekehrt: NICHT verifizierbar)

| Größe | Status | Nutzen im Gate |
|-------|--------|----------------|
| Container/Quelle (wav/flac/mp3/preview) | VERIFIED (URL-Feld) | V1-Kernkriterium (§4) |
| `sampleRate`, `channels`, `duration` nach Decode | VERIFIED (DecodedAudio/Features) | Sanity-Check post-decode |
| echte Bitrate / Kodierqualität | NOT VERIFIED (kein Feld; Header-Parsing nötig) | DEFERRED (§17) |
| messbare Kompressionsartefakte (Geräusch-Boden, Bandlücken) | NOT VERIFIED (kein verifizierter Algorithmus/Grenzwert) | DEFERRED (§17) |

**DECISION:** Keine willkürlichen Grenzwerte als VERIFIED dokumentieren.
Kriterien, die Grenzwerte bräuchten, werden als DEFERRED geführt und in einem
späteren Schritt kalibriert.

---

## 4. Codec / Compression Analysis

### 4.1 Vorhandene Quellen (VERIFIED)

- Lossless: `wavUrl`, `flacUrl`.
- Lossy: `mp3Url`; Preview zusätzlich `previewMp3Url` (MP3).
- Notiz: „WAV“ und „FLAC“ bezeichnen Container; ob eine konkrete WAV-Datei
  PCM/DPCM trägt, ist aus dem URL-Feld nicht ablesbar (NOT VERIFIED,
  §18 OQ-2). Für V1 wird das URL-Feld als Container-Ausdruck verwendet.

### 4.2 Dekodierbarkeit im Zielbrowser (Analyse)

- Die Decode-Verantwortung ist Web-Audio `decodeAudioData` (VERIFIED).
- MP3/WAV/OGG/AAC werden von Chromium/Firefox/Safari-in-Web-Audio
  allgemein unterstützt; **FLAC via `decodeAudioData` ist in Chromium/Firefox
  vorhanden, in Safari nicht verifiziert** (NOT VERIFIED, §18 OQ-3).
- Konsequenz: Ein „nur FLAC“-Gate ist Website/Platform abhängig; V1 sollte
  WAV+FLAC als lossless akzeptieren und FLAC-Unterstützung im Zielbrowser
  verifizieren, bevor ausschließlich-FLAC-REJECT-Entscheidungen getroffen werden.

### 4.3 Lossy ≠ automatisch schlecht — aber schwer nachweisbar (Analyse)

- MP3 mit hoher Bitrate ist subjektiv oft transparent, aber
  - `SampleMeta` liefert keine Bitrate (NOT VERIFIED),
  - Bitraten-Erkennung bräuchte Container-/Header-Parsing der transienten
    Bytes (machbar, DEFERRED, §17),
  - „transparent“ ist kein verifizierter, reproduzierbar messbarer Wert.
- **DECISION:** Codec/Container *allein* reicht als V1-Kriterium, weil es
  objektiv aus dem URL-Feld bestimmbar ist (VERIFIED). Ob verlustbehaftete
  Quellen technisch akzeptabel sind, wird als DEFERRED geführt; der aktuelle
  Stand ist „V1: nur lossless“. Ein späterer lossy-Pfad benötigt verifizierte
  Bitrate-/Artefaktkriterien (§17) und einen eigenen Build-Bump (§15).

### 4.4 Kompressionsartefakte objektiv messen

- Analyseverfahren (Rauschboden im stillen Bereich, spektrale Bänder, aliasing)
  sind denkbar, aber **kein** im Projekt verifizierter Algorithmus/Grenzwert
  (NOT VERIFIED). → DEFERRED (§17). V1 verzichtet darauf und nutzt Container
  als Proxy.

---

## 5. Quality Gate Proposal

### 5.1 Zielarchitektur (DECISION, verbindlich)

```
Audiotool Sample
       ↓
Audio Source
       ↓
Codec / Compression Quality Gate
       ├── REJECT → kein SampleMap-Objekt
       ▼
    ACCEPT
       ↓
Feature Extraction
       ↓
Classification
       ↓
Audio Identity
       ↓
Map Point
```

REJECT bedeutet (verbindlich):
- erscheint nicht auf der Map,
- wird nicht klassifiziert,
- geht nicht in Similarity ein,
- wird nicht als repräsentativer Map-Klang verwendet.
- Die originale Audiotool-Referenz wird **nicht** verändert oder gelöscht.

### 5.2 Positionsentscheidung im Pipeline-Fluss (DECISION)

- Zweistufig:
  1. **Quell-Gate vor fetch:** Container-Alternativen (VERIFIED) wählen
     `wavUrl → flacUrl` (lossless) als Analysequelle; existiert keine lossless
     Quelle → **REJECT** (reason `codec-lossy`, Queue-Status `skipped`).
  2. **Post-Decode-Gate nach decode / vor extractFeatures:** Sanity-Kontrolle
     (`sampleRate>0`, `channels≥1`, plausible `duration`), um ungültige
     Dekodate abzuwehren — kein „ästhetisches“ Kriterium.
- Damit ist die Soll-Platzierung „decode → QUALITY GATE → extractFeatures“
  erfüllt, ergänzt um die formatbasierte Vorabentscheidung am fetch-Eingang.
- **Reihenfolge REJECT-Erfassung:** `skipped` im Queue-Job (existierender
  Status, VERIFIED) mit strukturiertem `error`/Reason-Code; **kein**
  `SampleIndexRecord` angelegt. So bleibt Idempotenz erhalten, ohne dass ein
  Map-Objekt entsteht.

### 5.3 Preview von Analysequelle trennen (DECISION)

- **Problem (VERIFIED):** heutige Auswahl `previewMp3Url || mp3Url || wavUrl
  || flacUrl` (bootstrap.ts) analysiert die Preview — verlustbehaftet und als
  Performance-Material gedacht.
- **Ziel:** Preview ist ausschließlich Wiedergabematerial
  (`previewUrlFor` → `previewMp3Url`, VERIFIED); Analyse verwendet eigenständig
  **lossless** `wavUrl|flacUrl`. Preview-Einsatz für die Analyse ist verboten.
- Nicht in Step 15G beheben (nur Zielarchitektur; §16 führt aus, welcher
  Schritt es umsetzt).

### 5.4 Verantwortung der Analyse bzgl. Quell-URL

- Audiotool liefert vier URL-Arten (VERIFIED). Die *Anwesenheit* von
  lossless-URLs bei Samples ist erforderlich für ACCEPT; ob jedes Sample mit
  Audio auch WAV/FLAC hat, gilt als **NOT VERIFIED** (§18 OQ-1).

---

## 6. Audio Identity Model

### 6.1 Drei Ebenen, strikt getrennt (DECISION, verbindlich)

```
Exact File Duplicate   → gleiche Bytes (SHA-256 der transienten Datei)      (§7)
Audio Content Identity → gleicher Audioinhalt trotz Dateiunterschieden      (§6)
Perceptual Similarity  → ähnlicher, aber nicht identischer Klang             (§8)
```

Es ist verboten, die Ebenen zu mischen:
- `gleicher Name ≠ gleiche Identität` (VERIFIED-Referenzpunkt:
  `samples/{uuid}`-Name ist ein Bezeichner, kein Inhalt).
- `ähnlicher Klang ≠ identischer Klang` (Perceptual Similarity liefert keine
  Identity-Objekte).
- Identity wird **nicht** aus Tags, Namen, BPM-Ziffern, Klassifizierung oder
  Position abgeleitet.

### 6.2 Audio Content Identity — Definition (DECISION)

Zwei Samples haben dieselbe **Audio Content Identity**, wenn ihr dekodierter,
normalisierter Audioinhalt übereinstimmt — unabhängig von Container/Codec
(WAV vs. FLAC desselben Masters), Dateigröße oder URL.

Operative Bestimmung (Design des späteren Schritts):
1. Decode der *transienten* Bytes (Verbindung zu `FetchedAudio`),
2. Mono-Summation + Resampling auf eine kanonische Rate (Kandidat: ein
   konstanter `CONTENT_HASH_RATE`), 
3. deterministische PCM-Quantisierung,
4. `SHA-256` über das kanonisierte PCM → `contentHash`.
- **Immutability (VERIFIED):** Audio ist unveränderbar → `contentHash` ist
  nach Berechnung stabil; eine Verifikation ist nur bei Build/Brochen-Wahlen
  nötig (§14/§15).
- **Determinismus über Plattformen hinweg ist NICHT gesichert (NOT
  VERIFIED):** Web-Audio-Decode und Resampling können zwischen Browsern/Versionen
  minimal abweichen (Dithering, Downmix). Eingeschränkt: Der Implementierungs-Schritt
  muss identisches Ergebnis über Zielbrowser nachweisen (§20-Fall-3/4).
- Nichts davon wird in diesem Step implementiert.

### 6.3 Kantenfall-Deklarationen
- Identität ist eine Äquivalenzrelation auf ACCEPT-ten Samples; REJECT-ten
  Samples haben keine Identity (§5).
- Gleicher Inhalt in gleichem Container wird **primär** als Exact-File-Klasse
  geführt (§7), in verschiedenen Containern nur als Content-Identity-Klasse.
  Beide sind Ebenen für *denselben* Begriff „eindeutiger Klang“ (§9) — ein
  Map-Punkt repräsentiert die Audio-Content-Klasse; Exact-File ist ein
  Spezialfall der Content-Kongruenz bei bytegleicher Datei.

---

## 7. Exact Duplicate Model

- **Definition (DECISION):** Zwei Samples sind exact duplicates, wenn ihre
  Quelldateien **byte-identisch** sind (`SHA-256(fetchBytes) == SHA-256(fetchBytes')`
  über die transienten Bytes; kein Persistieren der Bytes — nur der 32-Byte-Hash).
- Abdeckung: identischer Upload in mehreren Audiotool-IDs; identischer Name
  (s. §6 `Name ≠ Identität`).
- **Nicht** abgedeckt: gleicher Inhalt in anderem Container (→ §6 Content
  Identity); ähnlicher, aber geänderter Klang (→ §8).
- **Konsequenz für Map/Modell:** Bytegleiche Samples erzeugen dieselben
  Features, dieselbe Position, dieselbe Klassifikation — sie fallen
  automatisch auf denselben Punkt (§9).
- **Status:** Modell definiert; Berechnung ist Aufgabe des Folge-Schritts (§16);
  SHA-256 ist über Browser-`crypto.subtle` verfügbar (VERIFIED als
  Plattformfähigkeit; Implementierung darin DEFERRED).

---

## 8. Perceptual Similarity Model

- **Definition (DECISION):** Perceptual Similarity beschreibt *Ähnlichkeit als
  Beziehung* zweier ACCEPT-ter Klänge, **keine Identität**. Ähnliche Klänge
  bilden **keine** Identity-Gruppe und erzeugen **keinen** Map-Punkt-Zusammenschluss.
- Verwendung (Zielbild, DEFERRED): „ähnliche Klänge finden“ in Suche/Exploration
  (Ranking), getrennt von Identity.
- Technik-Rahmen (Analyse, §16/§17):
  - nicht-ML-zuerst: zuerst deterministische, feature-basierte Ähnlichkeit
    (z. B. Distanz über normalisierte `AudioFeatures`; alle 13 Features sind
    VERIFIED vorhanden) als Kandidat;
  - erst wenn das nicht reicht: Fingerprint-/Embedding-Modell — dann
    ausdrücklich als neuer, abwägender Sub-Step, mit `DEPENDENCY CANDIDATE`
    (§16), nie still.
  - Kein Cloud-/Extern-ÄI (§16).
- **Heute:** nicht vorhanden, nichts implementieren. Ähnlichkeits-Anzeige darf
  niemals als „Duplikat erkannt“ interpretiert werden (Falsch-Positiv-Risiko §19).

---

## 9. Map Point Definition

- **DECISION:** Ein Map-Point repräsentiert einen **eindeutigen Klang**
  (Audio Content Identity-Klasse, §6), **nicht** eine Audiotool-Sample-ID.
- **Folge (DECISION):** Mehrere Audiotool-Referenzen können auf denselben
  Punkt zeigen (exact-file- oder content-identisch). Sie bleiben trotzdem für
  spätere Operationen (Machiniste, §13) einzeln erhalten.
- **Repräsentant (DECISION):** Die Punkt-Deskriptoren (`AudioFeatures`,
  Map-Position via `mapPosition`, Klassifikation) werden aus einem
  **Repräsentanten** der Gruppe abgeleitet, nicht gemittelt (deterministische
  Auswahl: niedrigste `samples/{uuid}`). So bleibt die Position eine reale
  Referenz-Aufnahme (Kein synthetischer Mittelpunkt).
- **Map-Versionierung:** `mapVersion="map-v1"` unverändert; die
  Punkt-Semantik (unique sound) wird als **Datenmodell-Anforderung** des späteren
  Schritts geführt (nicht `map-v2` heute).
- **Heutiger Ist-Zustand (VERIFIED):** ein Record/Punkt pro `sampleId`. Das
  ist eine bekannte Vereinfachung gegenüber der Ziel-Semantik; die
  Dedupe-Zusammenführung ist explizite Teilaufgabe des Folge-Schritts (§16),
  nicht dieses Steps.
- Rejected Samples: nie auf der Map (§5).

---

## 10. Classification Interaction

- **Heute (VERIFIED):** Genau eine Klassifikation pro Record
  (`HeuristicClassifier`, `version = "heuristic-v1"`, aus `AudioFeatures`).
- **Ziel (DECISION):** Es gibt weiterhin **eine** Klassifikation pro
  eindeutigem Klang — die des Repräsentanten (§9), abgeleitet aus dessen
  `AudioFeatures`. **Keine** unabhängige Einzelklassifikation der übrigen
  Referenzen der Gruppe. Damit bleibt Classification an Identity gekoppelt:
  `Audio Identity → Repräsentant → AudioFeatures → mapPosition() (unverändert)
  → Classification`.
- De facto Fusion: content-identical Klänge liefern bereits dieselben Features
  (gleiche normale PCM) → gleiche Position/Klasse. Die Regel dokumentiert nur
  den stabilen Grenzfall.
- Rejected: keine Klassifikation. Classification wird nie als
  Identity-Quelle verwendet (§6).

---

## 11. Search Interaction

- **Heute (VERIFIED):** `SampleMapSearchEngine` liest Record-Metadaten
  (Name, Tags, Klasse, Dauer, Status). Analyse-Status `pending/analyzed/…`.
- **Zieländerungen (DECISION, Design):**
  - **Rejected** Samples existieren nicht als Record → nicht durchsuchbar
    (natürliche Konsequenz des Gates, §5).
  - Suchergebnis bezieht sich weiter auf **Referenzen** (IDs); bei
    Identität-Gruppen (§9) kann derselbe Klang mehrfach vorkommen. Späterer
    Schritt: group-aware Ergebnisdarstellung (Dedupe + „N weitere Referenzen“)
    — dieser Schritt: nur Dokumentation der Auswirkung.
  - Suchbegriff „Typ/Status“, Filter nach Klasse/Dauer bleiben unverändert.
- **Keine Such-Implementierung** in diesem Step.

---

## 12. Inspector Interaction

- **Heute (VERIFIED):** Inspector zeigt ein Record (Name, Metadata, Tags,
  Klassifikation, Map-Position, Preview-Play).
- **Zieländerungen (DECISION, Design):**
  - Rejected: kein Inspector (kein Objekt).
  - Bei Identität-Gruppen zeigt der Inspector den **Repräsentanten** als
    Punkt-Deskriptor und listet synthetisch „Gruppenmitglieder“ (Anzahl
    Referenzen, Auswahl-Link auf jede konkrete Referenz für Machiniste/Play).
  - Preview-Play bleibt referenz-gebunden (jede Referenz spielt ihren eigenen
    Preview, VERIFIED: `previewUrlFor` → `previewMp3Url`).
- **Keine Inspector-Implementierung** in diesem Step.

---

## 13. Machiniste Interaction

- **Heute (VERIFIED):** Machiniste nutzt die direkte Referenz
  `AudiotoolSampleReference = "samples/{uuid}"`
  (`sampleRef.ts`, `SampleMapMachinisteService`); der Record führt
  `sampleId`/`name`.
- **Ziel (DECISION):**
  - Identity/Duplicate-Behandlung **ersetzt keine Referenz**. Alle
    Referenzen der Gruppe bleiben gültig und machiniste-fähig (direkter
    Pfad unverändert).
  - Der Map-Punkt zeigt auf den Repräsentanten (§9); der Drag-onto-Machiniste-
    Gesendete-`Audio` ist trotzdem die vom Nutzer „ausgewählte“ konkrete
    Referenz (entspricht heutigem Verhalten, Verifikation in früheren Steps).
  - Rejected: nicht machiniste-relevant (kein Objekt).
- **Keine Machiniste-Änderung** in diesem Step.

---

## 14. Persistence Proposal

- **Ist (VERIFIED):** `SampleIndexRecord` hat keine Felder `format`, `codec`,
  `quality`, `hash`, `audioIdentity`. Vorhanden: `audioFeatures.sampleRate`,
  `audioFeatures.channels`, `analysisVersion`, `analysisBuild`,
  `classificationVersion`.
- **Bedarf (DECISION, Design für den Folge-Schritt; nichts heute implementieren):**
  Zusätzliche **optionale** Metadatenfelder (keine Audio-Bytes):
  - `sourceFormat?: "wav" | "flac" | "mp3"` — welche Quelle analysiert wurde
    (als Gate-Nachweis);
  - `gateResult?: { verdict: "accepted" | "rejected"; reason?: string;
    gateVersion: string; rawSampleRate?: number; gateAppliedAt: string }`
    — Nachvollziehbarkeit; rejected Record wird **nicht** angelegt, der
    Vermerk lebt nur im Queue-Job §5.2 (eine persistierte rejected-Liste ist
    §17/§18 OQ-7).
  - `fileHash?: string` (hex SHA-256) — Exact-File-Klasse (§7);
  - `contentHash?: string` + `contentHashAlgorithmVersion` — Content-Klasse (§6);
  - `identity: { groupId?: string; representative?: boolean; members?: string[] }`
    — Gruppenzuordnung/Repräsentant (§9), primär am Repräsentanten gespeichert;
  - `identityAlgorithmVersion?: string` — §15.
  - Diese Felder sind reine primitive Metadaten → kompatibel mit
    `assertNoAudioBytes` (VERIFIED-Regel).
- **Immutability-Konsequenz (VERIFIED):** Hash/Identity einmal berechnet ist
  stabil; Neuberechnung nur bei `analysisBuild`-Wechsel (Idempotenz-Mechanik
  der Analyse bleibt unverändert).

---

## 15. Versioning

- Bestehende Versionsfelder (VERIFIED): `analysisVersion="features-v1"`,
  `classificationVersion="heuristic-v1"`, `mapVersion="map-v1"`,
  `ANALYSIS_BUILD="smap-build-v1"`.
- **Neue Versionsdimensionen (DECISION, Design):**
  - `gateVersion` — Version der Gate-Regeln (§14); jede Regeländerung bump.
  - `contentHashAlgorithmVersion` — algorithmische Hash-/Normalisierung-Version
    (Resampling-Rate, PCM-Quantisierung) (§6).
  - `identityAlgorithmVersion` — Gruppierungs-/Representanten-Regel (§9).
- **Regel (DECISION):** Wird ein Kriterium (z. B. „nur lossless“) später zu
  „lossy ab 256 kbps“ gelöst → `gateVersion`+`analysisBuild`-Bump, Rück-
  Einstufung von Bestand (= bestehende Funktion wird nicht still geändert,
  sondern revisiert klassifiziert). Keine stille Migration.
- Kein neues Persistenzschema in diesem Step (§14).

---

## 16. V1 Recommendation

Empfehlung für den **folgenden Implementierungsschritt** (Design, nicht heute):

1. **Content-Gate (hart):** Analysequelle = `wavUrl || flacUrl`; falls keine
   lossless Quelle → REJECT (Reason `codec-lossy`, Queue-Status `skipped`).
   Preview/MP3 nie als Analysequelle. Post-Decode-Sanity-Gate vor
   `extractFeatures`.
2. **Identity-Basis:** Berechne `fileHash` (SHA-256 der transienten Bytes)
   und `contentHash` (kanonisch normalisierte PCM, §6) transient; persistiere
   nur die Hex-Strings (§14).
3. **Persistenz-Delta:** optionale Felder aus §14; `analysisBuild`
   auf `smap-build-v2` o. ä., `gateVersion`/`contentHashAlgorithmVersion`
   gesetzt. Durchgängig `assertNoAudioBytes`-Kompatibilität.
4. **Gruppen-Modell:** im selben Schritt oder als Teilstück Map-Punkt =
   eindeutiger Klang (§9) mit Repräsentanten-Regel; Such-/Inspector-Ansicht
   (§11/§12) folgen danach als eigener Sichtbarkeits-Schritt.
5. **Machiniste:** unverändert (§13).
6. **Tests:** reine-`AudioFeatures`-basierte Hash-/Gate-Einheiten,
   Pipeline-Integration mit Fake-`FetchedAudio` (wav/flac-only),
   Idempotenz-/Build-Bump-Case.

**Nicht-ML/keine Cloud (DECISION):** V1 nutzt hashes + vorhandene Features;
keine Embeddings, kein externer Dienst, keine neuen npm-Abhängigkeiten.
Höchstens dokumentierte `DEPENDENCY CANDIDATE` (falls Perceptual Similarity
später einen Fingerprinter verlangt — §8/§17): z. B. Chromaprint-artige
Fingerprints oder Essentia-basierte Merkmale nach Prüfung — ausdrücklich nicht Teil von V1.

---

## 17. Deferred / Future Work

- `codec-lossy` Fallback mit Bitrate-/Header-Parsing und verifizierten
  lossy-Grenzen (§4/§5). (DEPENDENCY CANDIDATES: MP3-Header-Leser; keine neue
  Dep heute.)
- Perceptual Similarity Engine + UI („ähnliche Klänge“) — regular, feature-
  basiert zuerst, Embeddings nur als begründeter Folge-Schritt (§8).
- Messung von Kompressionsartefakten mit kalibrierten Grenzwerten (§4.4). 
- FLAC-`decodeAudioData`-Unterstützung im Zielbrowser verifizieren (§4.2/OQ-3).
- „hat jedes Sample WAV/FLAC?“-Verifikation (OQ-1); ggf. Audiotool-
  Zusatz-Information oder Download-Probe.
- Map-Punkt-Gruppierung & Repräsentanten-Sichtbarkeit in Map/Inspector/Suche
  (§9/§11/§12).
- Persistierte rejected-Liste oder ausschließlich Queue-Vermerk (§14/OQ-7).
- Machiniste-Gruppenverhalten (nur wenn Nutzer Anforderung später; heute
  unverändert, §13).

---

## 18. Open Questions

1. **OQ-1 (NOT VERIFIED):** Hat jedes Audiotool-Sample mit Audio auch WAV/FLAC
   (Verfügbarkeit lossless)? Nur per Live-Session prüfbar.
2. **OQ-2 (NOT VERIFIED):** Enthält jede `wavUrl` tatsächlich PCM (nicht z. B.
   ADPCM)? URL-Feld verrät Container, nicht Inhalts-Codierung.
3. **OQ-3 (NOT VERIFIED):** Dekodiert der Zielbrowser FLAC via
   `decodeAudioData` zuverlässig (Firefox/Chromium ja — Safari unbekannt)?
4. **OQ-4 (OPEN):** Determinismus von `contentHash` über Browsern/Versionen
   (Resampler/Dither)? Muss der Folge-Schritt empirisch klären (§6.2).
5. **OQ-5 (OPEN):** Welche konkrete kanonische Resampling-Rate/Quantisierung
   für `contentHash`? (Kandidat 22050 Hz-Mono; Abnahme im Folge-Schritt.)
6. **OQ-6 (OPEN):** Sollen exact-file-Klassensamples eine *administrative*
   opt-out-Möglichkeit im Map-View erhalten (ein Punkt pro ID heute vs.
   gebündelt)? -> Nutzerentscheid, nicht-gate.
7. **OQ-7 (OPEN):** Sollen REJECT-Vermerke (Reason) dauerhaft gespeichert
   oder nur als Queue-`skipped` (mit Idempotenz) geführt werden?
8. **OQ-8 (OPEN):** Repräsentanten-Regel — niedrigste UUID vs. erst-analysiert?
   Beide deterministisch; Empfehlung niedrigste UUID (§9).
9. **OQ-9 (NOT VERIFIED):** Bandbreite/Kosten zusätzlicher lossless-Downloads
   für Analyse (WAV/FLAC größer als Preview) — per Live-Messung.
10. **OQ-10 (OPEN):** Preview ist *Performance-Wiedergabe*-Material (VERIFIED
    Einsatz); ob Audiotool Preview-Kodierung ggf. doch Quasi-Identisch ist, ist
    fürs Gate irrelevant (Preview bleibt verboten als Quelle, §5.3).

---

## 19. Risks

- **Falsch-REJECT:** Samples ohne lossless-URL (OQ-1) fielen aus — bei hoher
  Quote wäre SampleMap praktisch leer. Mitigation: OQ-1-Verifikation + klarer
  Reason + Queue-Vermerk (nicht Datenverlust).
- **Content-Hash-Drifts:** browser-decode-Varianz (OQ-4) kann gruppenbrechen/
  -verkleben. Mitigation: kanonische Normalisierung, plattform-übergreifender
  Test, Algorithmus-Versionierung (§15).
- **Falsche Zusammenführung:** faux Content-Identität (gleiche PCM durch
  Dither-Downmix) → zusammengeführte Punkte. Mitigation: konservative Rate,
  Repräsentanten-Regel, jederzeit auflösbar durch Versions-Bump.
- **Map-Churn:** Umschaltung auf Gruppen-Semantik verschiebt bestehende Punkte
  (ein Punkt pro ID → pro Klang). Mitigation: klar begrenzter Visual-Schritt
  nach §16-Punkt4, `map-v2` nur bewusst.
- **Bandbreite:** lossless-Downloads für Analyse (OQ-9). Mitigation:
  Analyse-Budgets (`10/100/1000`, VERIFIED) unverändert; concurrency 1.
- **Nicht-Gate-Risiko (gegenseitig):** Quality-Gate als *Filter* misszuverstehen
  (ästhetisch). Mitigations-Anker: Definition §3, REJECT-Set §5 — Kriterium nur
  Containerkodierung.
- **Wahlbarkeitsfehler:** „MP3 immer schlecht“ wäre falsch in beide Richtungen;
  deshalb V1-Entscheidung „nur lossless“ + expliziter DEFERRED-Pfad (§4/§17),
  keine Pseudo-Präzision.

---

## 20. Acceptance Criteria for Implementation

Der Folge-Schritt (Umsetzung) ist fertig, wenn **alle** gelten:

1. Analysequelle ist `wavUrl|flacUrl`; `browserFetchAudio`-Äquivalent wählt
   lossless (Test mit Fake-`FetchedAudio` + Real-Fetch in Browser-Probe).
2. Quality Gate (hart): Sample ohne lossless → REJECT; kein `SampleIndexRecord`,
   kein Map-Punkt, keine Klassifikation; Queue-Status `skipped` mit Reason
   `codec-lossy`; Audiotool-Referenz unangetastet.
3. Preview wird für Analyse nie verwendet (Test: auch wenn nur
   `previewMp3Url` existiert → REJECT).
4. `fileHash` + `contentHash` werden transient berechnet und nur as Hex
   persistiert; `assertNoAudioBytes` bleibt grün (Invarianten-Test).
5. Content-Identity deterministisch im Zielbrowser; Byte-identische Datei → 
   exact-Match, WAV==FLAC desselben Masters → Content-Match, anderer Klang →
   kein Match. (Test-Fall-Arsenal.)
6. `Name ≠ Identität`: zwei verschiedene `samples/…`-Namen mit identischem
   Inhalt werden als ein Klang gruppiert; zwei gleichnamige unterschiedliche
   Klänge **nicht**.
7. Map-Punkt repräsentiert einen Klang; mehrere Referenzen zeigen auf denselben
   Punkt; Repräsentanten-Deskriptoren deterministisch; Rejected nie auf Map.
8. Classification ist single per Klang (= Repräsentant); keine per-Referenz-
   Klassifizierung; Classification ändert Identity nie.
9. Such-/Inspector-Auswirkungen dokumentiert und (falls visuell) wie §16-4
   umgesetzt; Machiniste-Referenzen aller Gruppe identisch nutzbar (Test
   `SampleMapMachinisteService` mit Mehrfach-Referenzen eines Klangs).
10. Persistenzschema um optionale Felder erweitert (defaults rückwärts-
    kompatibel), `analysisBuild` gebumpft, `gateVersion`/
    `contentHashAlgorithmVersion` gesetzt.
11. Keine ML-/Cloud-, keine neuen npm-Abhängigkeiten; DEPENDENCY CANDIDATES
    nur dokumentiert.
12. Bestehende Funktionen unverändert mitgrün: Tech-Stack-Baseline (bisher
    267/20 Tests, `tsc` clean, `npm run build`) mindestens stabil.
13. Versionsregeln (§15) nachweisbar; keine stille Reklassifikation.
14. Verifikations-Bericht des Schritts (inkl. NOT VERIFIED-Checks OQ-1/2/3/9
    im Browser) wie in §32 gefordert.

---

*Ende Step-15G-Design. Keine Produktionsdatei wurde geändert; kein Code
hinzugefügt.*