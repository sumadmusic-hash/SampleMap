# STEP 15G — LIVE VERIFICATION

## 1. Scope

Live-/Umgebungs-Verifikation der offenen technischen Fragen aus Step 15G —
**ausschließlich Verifikation und Dokumentation**. Keine Produktionsänderung:

- keine Änderung unter `src/`, keiner Production-Code
- keine Änderung von `SampleIndexRecord`
- kein Quality-Gate, kein Hashing, keine Content-Identity, keine Map-Dedupe
- keine UI-Änderungen, keine neuen npm-Abhängigkeiten, keine Test-Änderung
- Analysequelle `bootstrap.ts:71` unverändert
- Verifiziert: OQ-1 (WAV/FLAC-Verfügbarkeit), OQ-2 (WAV-Payload),
  OQ-3 (FLAC-Browser-Decode) plus WAV-vs-FLAC-Cross-Check.

Temporäre Testartefakte liefen außerhalb der Production-Architektur im
System-Temp und wurden nach dem Test vollständig gelöscht. Keine Audio-Datei
wurde persistiert (keine IndexedDB, kein Repo, keine Fixture).

---

## 2. Baseline

```text
Tests before:   267
Test files:     20
TypeScript:     tsc --noEmit clean
Build:          npm run build OK (nur bekannte chunk-size-Warnung)
```

Bestätigt am 2026-09-02 (vor und nach der Verifikation; Produktionsdateien
unverändert).

---

## 3. Authentication / Environment

- **Session:** echt authentifizierte Audiotool-Session über
  `@audiotool/nexus@0.0.17` mit **PAT-Auth** in Node
  (`createPATAuth` + `createNodeTransport` + `createDiskWasmLoader`).
  Das PAT wurde ausschließlich im Node-Prozess aus `.env` gelesen, **nie**
  in eine Webseite injiziert, nie geloggt.
- **SDK-Fläche:** `client.samples.list` (Pagination), `client.samples.download`
  (Formate `wav`/`flac`).
- **Zielbrowser (OQ-3):** gemäß bestehender Browser-Testumgebung — Google
  Chrome (headless), `Google Chrome 152.0.7977.65`, „Macintosh; Intel Mac OS X
  10_15_7“ (HeadlessChrome/152.0.0.0). Runtime-Test via CDP gegen eine
  lokale Testseite.
- **Testmenge:** 60 echte, öffentliche Samples (3 Seiten × 20) aus der
  Audiotool-Sample-Liste — diverse Besitzer (56 unterschiedliche Owner, darunter
  der eigene Account), 30 one-shot / 30 loop, 59 public / 1 unlisted,
  Durations 0.101 s … 33.699 s, WAV-Größen der Stichprobe 23 KB … 5.1 MB.

---

## 4. OQ-1 — WAV/FLAC Availability

### Ergebnis

```text
Samples inspected:         60
WAV available:             60/60
FLAC available:            60/60
At least one lossless:     60/60
Lossless unavailable:       0/60  (nur lossy/Preview vorhanden: 0/60)
```

- Alle 60 Samples tragen `wavUrl`, `flacUrl`, `mp3Url`, `previewMp3Url`
  (VERIFIED — URL-Präsenz in `SampleMeta`).
- Stichprobe deckt ein Shot/Loop, public/unlisted, 0.1 s–34 s, 56 Owner ab.
  **Grundsätzlich:** nur die geprüften 60. `NOT VERIFIED — population-wide
  availability unknown`.

### Status

```text
OQ-1:
60/60 getestete Samples hatten mindestens eine lossless Quelle.

VERIFIED for tested sample set (60).
NOT VERIFIED for entire Audiotool population.
```

---

## 5. OQ-2 — WAV Payload

### Ergebnis

Echte WAV-Downloads (`client.samples.download(…, {format:"wav"})`), Header
rein im Speicher geparst (RIFF/WAVE-Chunk, kein Parser aus dem Projekt nötig,
keine Dependency):

```text
WAV payload inspected: 5
PCM WAV:                5/5     (audioFormat = 1)

samples/0001a13b… | RIFF/WAVE | PCM | 2ch  | 44100 Hz | 16 bit | data 113808 B
samples/0001a43b… | RIFF/WAVE | PCM | 2ch  | 48000 Hz | 16 bit | data  23364 B
samples/0001c0b8… | RIFF/WAVE | PCM | 2ch  | 44100 Hz | 16 bit | data 2472176 B
samples/0001e452… | RIFF/WAVE | PCM | 2ch  | 44100 Hz | 16 bit | data 5131636 B
samples/00028fa5… | RIFF/WAVE | PCM | 1ch  | 48000 Hz | 16 bit | data 229376 B
```

Alle 5 untersuchten Dateien sind echte unkomprimierte PCM-WAV.

### Status

```text
OQ-2:
VERIFIED for tested sample set (5/5 PCM).
NOT VERIFIED for entire Audiotool population (kein „WAV ist immer PCM“-Schluss).
```

---

## 6. OQ-3 — FLAC Browser Decode

### Ergebnis

Echte Audiotool-FLAC-Datei (`samples/0001a13b-074e-5245-a443-1e19971190bd`,
77.200 Bytes) transient geladen und im **echten Zielbrowser** via CDP
`AudioContext.decodeAudioData` dekodiert:

```text
Browser:            Google Chrome 152.0.7977.65 (HeadlessChrome/152.0.0.0)
OS:                 Macintosh; Intel Mac OS X 10_15_7
FLAC source:        echte Audiotool-FLAC (download(format="flac"))
download success:   YES (77200 Bytes)
decodeAudioData:    PASS (Success, ~6.5 ms)
decoded channels:   2      (Quelle: STREAMINFO 2)
decoded duration:   0.64517 s  (entspricht STREAMINFO 28452 samples)
decoded sampleRate: 96000 Hz   (!!!)
```

**Wichtige Beobachtung:** Der Brower resampled beim Decode auf die
AudioContext-Rate (`decodeAudioData` lieferte **96000 Hz**, obwohl die Datei
44100 Hz ist; Dauer blieb identisch 0.64517 s). Das bestätigt: die vom Browser
gelieferte `sampleRate` ist **kontextabhängig**, nicht dateiinhärent. Ein
späterer `contentHash` MUSS deshalb auf kanonischem, eigenem Resampling
aufgebaut werden — das war bereits die V1-Designaussage in
`STEP15G_DESIGN.md §6.2` und ist hiermit live bestätigt.

### Status

```text
OQ-3:
VERIFIED for Chromium 152 / Web-Audio (PASS).
NOT VERIFIED for non-Chromium target browsers (z. B. Safari FLAC-Unterstützung
und decode-Rate dort — außerhalb dieser Browser-Testumgebung).
```

---

## 7. WAV vs FLAC Cross-Check

Gleiches Sample (`samples/0001a13b…`), beide Formate heruntergeladen, nur
transient gehalten:

```text
FLAC STREAMINFO: 44100 Hz | 2 ch | 16 bps | 28452 totalSamples | 0.64517 s
WAV    Header:   44100 Hz | 2 ch | 16 bit | dataSize/blockAlign = 28452 frames
Browser decode:  Dauer 0.64517 s | 2 ch            (bei 96 kHz resampled)

Übereinstimmung: sampleRate, channels, bitTiefe, Frame-Anzahl (28452),
Dauer (0.64517 s) — WAV und FLAC repräsentieren offensichtlich dasselbe Audio.
```

Das ist eine **Metadata-/Header-Ebene**-Bestätigung. Ein byte-/PCM-genauer
Beweis der Inhaltsidentität ist explizit **nicht** Teil dieses Auftrags (kein
Content-Hash implementiert). Feststellung ist ausreichend für die 15G-Frage
„können WAV/FLAC auf denselben Audiocontent zeigen“.

### Status

```text
WAV/FLAC cross-check:
VERIFIED on metadata level (identical duration/sampleRate/channels/frames).
NOT VERIFIED on content level (no content hash, out of scope).
```

---

## 8. Current Analysis Source

Bestätigt (unverändert):

```text
CURRENT = previewMp3Url ││ mp3Url ││ wavUrl ││ flacUrl    (bootstrap.ts:71)
```

```text
CURRENT = Preview/MP3 can be selected before lossless
TARGET  = WAV/FLAC must be selected independently for analysis
```

**Aktueller Befund CONFIRMED:** Die bestehende Pipeline kann die
verlustbehaftete Preview als Analysequelle wählen. Nichts wurde geändert.

---

## 9. Verified Facts

1. 60/60 getestete echte Samples besitzen `wavUrl` + `flacUrl` + `mp3Url` +
   `previewMp3Url` (VERIFIED, 60-Sample-Liste).
2. `wavUrl` liefert echte RIFF/WAVE-PCM-Dateien: 5/5, `audioFormat=1`
   (PCM), 16 bit; 44100/48000 Hz; mono+stereo (VERIFIED, 5 Downloads).
3. `decodeAudioData` dekodiert eine echte Audiotool-FLAC-Datei in
   Chrome 152 erfolgreich (PASS, 0.64517 s, 2 ch) mit Resampling auf die
   Kontext-Rate (96000 Hz beobachtet) (VERIFIED, Runtime-Test).
4. WAV und FLAC desselben Samples stimmen in sr/ch/bits/Frames/Dauer überein
   (VERIFIED, Header-/Metadata-Ebene).
5. Audio ist immutable (Protobuf-Doku `Sample.update_time`: „The underlying
   audio can't be changed.“) → analysierbar nur transient; keine Datei
   persistiert (VERIFIED, Paket-Typen + Testverhalten).
6. Baseline: 267/20 Tests, tsc clean, Build OK; keine Produktionsdatei
   geändert (VERIFIED).

## 10. Not Verified

- Population-weite Verfügbarkeit von WAV/FLAC (nur 60 getestet).
- „WAV ist immer PCM“ population-weit (nur 5 Header geprüft).
- FLAC-Decode in Safari/anderen Nicht-Chromium-Browsern dieses Targets
  (nicht in der Browser-Testumgebung vorhanden).
- Content-genaue Identität WAV vs. FLAC (kein Hash — außerhalb Scopes).
- Ob die MP3-Preview denselben Inhalt wie WAV/FLAC trägt (nicht getestet,
  fürs Gate irrelevant — Preview bleibt als Quelle verboten).
- Cross-Browser-Determinismus eines späteren `contentHash` (Resampling →
  eigene kanonische Verarbeitung nötig; empirisch zu bestätigen in 15H).
- Echte Bandbreite/Kosten lossless-Downloads in der App (nur einzelne
  Download-Proben hier).
- Bitrates-/Codec-Detaildaten in `SampleMeta` (existieren nicht als Felder;
  Header-Parsing nötig).

## 11. Remaining Open Questions

- OQ-A (aus OQ-3): Welche konkrete kanonische Resampling-Rate nutzt der
  spätere `contentHash` (Datei ist 44100 Hz; Browser liefert kontextabhängig
  anderes)? → 15H-Entscheid, Kalibrierung nötig.
- OQ-B: Marginalia — braucht der Implementierungsschritt die WAV-Parsing-/
  FLAC-Header-Erkennung nur zur Gate-Diagnose oder zur Quellvalidierung?
- OQ-C: Ab welcher lossy-Bitrate wäre eine Ausnahme technisch akzeptabel
  (definieren + kalibrieren; V1 bleibt lossless-only)?
- OQ-D: Reicht für 15H die URL-Präsenz (`wavUrl`/`flacUrl`) als ACCEPT-Kriterium
  oder soll zusätzlich post-Download eine Mini-Header-Prüfung erfolgen (robust
  gegen leere/kaputte Downloads — heute simplify mit `download-was-ok`)?
- OQ-E (unverändert aus 15G): Population-Verfügbarkeit (OQ-1), Safari-FLAC
  (OQ-3 dort), persistierte rejected-Liste vs. Queue-`skipped`, Repräsentanten-
  Regel, Content-Hash-Determinismus.

## 12. Impact on Step 15H

- **Gate-Quelle:** 15H kann deterministisch `wavUrl`→`flacUrl` als Analysequelle
  setzen; bei fehlender lossless-URL REJECT (Queue-Status `skipped`, Reason
  `codec-lossy`). OQ-1 spricht dafür, dass lossless fast immer verfügbar ist —
  kein Massen-REJECT zu erwarten (Caveat: Population nicht bewiesen).
- **Gate-Kriterium:** URL-Container (VERIFIED verfügbar) + optionale
  Post-Decode-Sanity; kein Artefakt-Erkennung in V1.
- **contentHash (Kritisch):** Browser-Decode ist kontextabhängig resampled
  (VERIFIED: 96 kHz statt 44100 Hz). Der 15H-`contentHash` MUSS aus
  **kanonisch normalisiertem PCM** entstehen (eigenes Resampling + Downmix +
  Quantisierung), nie aus `audioFeatures` und nie aus der rohen
  Context-`sampleRate`. Empirischer Cross-Browser-Test in 15H erforderlich.
- **Idempotenz/Pipeline:** `analysisBuild`-Bump, Gate im Fluss vor
  `extractFeatures`, Audio bleibt transient (`FetchedAudio.release()`),
  `assertNoAudioBytes` unangetastet.
- **Kein Hash aus Features:** `Audio Content Identity MUST NOT be derived from
  AudioFeatures`, siehe §13.

## 13. Recommendation

```text
RECOMMENDATION

OQ-1 sufficiently verified for implementation:
YES — 60/60 der Stichprobe lossless-fähig. Population-Caveat bleibt
      dokumentiert (NOT VERIFIED population-wide).

OQ-2 sufficiently verified:
YES — 5/5 echte WAV = PCM. Population-Caveat bleibt dokumentiert.

OQ-3 sufficiently verified:
YES für Zielbrowser (Chromium 152) — FLAC decodeAudioData PASS.
Nicht-Chromium (Safari) bleibt NOT VERIFIED → Vorzeichen im 15H-Design
      (notfalls WAV als lossless-Primärquelle).

WAV/FLAC cross-check:
VERIFIED (Metadata-Ebene). Content-Ebene NOT VERIFIED (kein Hash, wie erlaubt).

Current preview-analysis problem:
CONFIRMED (bootstrap.ts:71 wählt preview-first; unverändert).

Content-hash-from-features:
FORBIDDEN (Audio Content Identity MUST NOT be derived from AudioFeatures;
contentHash kommt später aus decoded canonical PCM — nichts implementiert).

Proceed to Step 15H:
YES — mit den dokumentierten Caveats (Population-WAV/FLAC-Verfügbarkeit,
  Safari-FLAC, kanonisches Resampling für contentHash) und unter strikter
  Beibehaltung der 15G-Designvorgaben.
```

### Konträr-Hinweis (keine Übertreibung)

Die 60er-Stichprobe erlaubt **keinen** All-Quantoren-Schluss über die gesamte
Audiotool-Bibliothek. 15H muss REJECT robust behandeln (skipped-Vermerk +
Diagnose), falls real Samples ohne lossless-Quelle auftauchen.

*Ende Step-15G-Live-Verifikation. Kein Produktionscode geändert, keine neuen
Dependencies, keine Audio-Bytes persistiert, temporäre Artefakte gelöscht.*