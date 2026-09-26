# SAMPLE_ACCESS_POC

**Projekt:** Nexus Sample Access POC — Audiotool Sample Library
**Datum:** 2026-08-31
**SDK:** `@audiotool/nexus@0.0.17`

## Zweck

Dieser POC soll zuverlässig beantworten, welche Zugriffsrechte eine authentifizierte
Nexus-App auf die Audiotool Sample Library hat: Samples auflisten, Metadaten abrufen
und Audiodaten (WAV/FLAC/MP3/Preview) herunterladen und im Browser abspielen.

> **Wichtig zur Einordnung:** Dieser Bericht unterscheidet strikt zwischen
> **(A)** was durch lokale Ausführung *verifiziert* wurde (API-Existenz, Typen,
> Kompilierung, Unit-Tests, CLI-Lauf, Build, Dev-Server) und
> **(B)** was *einen realen, authentifizierten Audiotool-Account voraussetzt* und daher
> nur als **integrativer/manueler Schritt** dokumentiert ist (tatsächliche Sample-Listen,
> echte Downloads).
>
> Nichts, was Zugriff auf die Audiotool Sample Library betrifft, wird hier als Fakt
> behauptet, ohne dass es durch einen realen Lauf **mit gültigen Credentials** bestätigt
> wurde. Alles unter „Verifiziert“ ist nur der Code-/API-Nachweis.

---

## 1. Kann eine Nexus-App die Sample Library auflisten?

**PARTIAL (nur API-nachgewiesen, reale Liste ausstehend)**

`client.samples.list()` ist in der installierten API **vorhanden** und
typsicher aufrufbar (Code kompiliert, Unit-Tests für Pagination/parsing grün).
Ob echte Samples zurückkommen, muss mit einem authentifizierten Account bestätigt
werden (siehe Abschnitt „Offene Punkte“ — manueller Schritt).

---

## 2. Welche Samples sind sichtbar?

**Noch nicht real verifiziert** (benötigt authentifizierten Lauf).

Die API erweitert `SampleListOptions` um `filter` (CEL), `textSearch`, `orderBy`,
`pageSize` (Default 20) und `pageToken`. Jedes `SampleMeta` trägt `visibility`
(`"public"` oder `"unlisted"`) und `ownerName`. Der POC listet per Default die
erste Seite (20 Samples) und protokolliert `visibility` + `ownerName` pro Sample,
damit die Sichtbarkeits-Untersuchung aus Abschnitt 6 des Auftrags erledigt werden
kann, sobald echte Credentials vorliegen.

---

## 3. Kann die App Samples anderer User sehen?

**PARTIAL (noch nicht real verifiziert)**

`samples.list()` dokumentiert keine Einschränkung auf eigene Samples — `list`
liefert laut SDK Doku eine paginierte Search/List über die Library, und `SampleMeta`
enthält `ownerName`. Eine Bestätigung, dass effektiv Samples *anderer* User in der
Liste erscheinen, erfordert einen echten authentifizierten Lauf.

---

## 4. Kann die App die eigentlichen Audiodaten abrufen?

**PARTIAL (API vorhanden, Download real ausstehend)**

`samples.download(sample, { format })` existiert und gibt `Promise<Blob | Error>`
zurück. Der POC erzeugt daraus eine `ObjectURL` und setzt sie auf ein
HTML5-`<audio>`-Element. Ob ein echtes Blob heruntergeladen werden kann, hängt vom
authentifizierten Lauf ab.

---

## 5. Welche Formate funktionieren?

**Noch nicht real verifiziert.**

Die API definiert `SampleFormat = "flac" | "wav" | "mp3" | "preview"` (Default
`"flac"`). `SampleMeta` liefert die URLs `wavUrl`, `flacUrl`, `mp3Url`,
`previewMp3Url`. Die Verfügbarkeit wird im POC pro Sample geprüft und die
Download-Buttons entsprechend aktiviert.

---

## 6. Funktioniert die Wiedergabe im Browser?

**Noch nicht real verifiziert** (Integration/Manual).

Der Browser-POC setzt das heruntergeladene Blob via `URL.createObjectURL` auf ein
`<audio controls>`-Element. Das funktioniert nur gegen ein real heruntergeladenes
Blob und muss manuell im Browser geprüft werden.

---

## 7. Welche Permission-/Visibility-Grenzen existieren?

**Hinweise aus der dokumentierten API (zu bestätigen durch echten Lauf):**

- `SampleVisibility = "public" | "unlisted"` — es gibt laut Typ **keinen** sichtbaren
  `"private"`-Enum-Wert. Private Samples anderer User sind in `list()` nicht vorgesehen.
- `upload()` erlaubt `visibility?: "public" | "unlisted"` (Default `"unlisted"`).
- `delete()` ist dokumentiert auf eigene Samples + „nicht in Projekt verwendet“
  beschränkt.
- Es gibt keine öffentlich dokumentierte API, um private Samples zu erzwingen oder
  Zugriff auf fremde private Samples zu erhalten.

Der POC erzwingt **keine** Umgehung: Er nutzt ausschließlich die offiziellen
`client.samples.*`-Methoden. Keine Scraping-/Reverse-Engineering-/Auth-Umgehung.

---

## 8. Welche API-Funktionen wurden tatsächlich verwendet?

Verwendete Funktionen (alle aus `@audiotool/nexus@0.0.17`, importiert aus
`@audiotool/nexus` bzw. `@audiotool/nexus/api` / `@audiotool/nexus/node`):

| Funktion | Typ / Signatur | Zweck |
|----------|----------------|-------|
| `audiotool({clientId, redirectUrl, scope})` | Browser-OAuth (PKCE) | Auth im Browser-POC |
| `createAudiotoolClient({auth, transport, wasm})` | Client-Factory | Auth im Node-CLI-POC |
| `createPATAuth(pat)` | `AuthProvider` | PAT-Auth |
| `createNodeTransport()` | `TransportFactory` | Node-Transport |
| `createDiskWasmLoader()` | `WasmLoader` | Node-WASM |
| `client.samples.list(options?)` | `(SampleListOptions? , AbortSignal?) => Promise<SampleListResult \| Error>` | Liste/Suche |
| `client.samples.get(sample)` | `(string \| SampleMeta \| NexusEntity) => Promise<SampleMeta \| Error>` | Einzelnes Sample |
| `client.samples.download(sample, {format})` | `(string \| SampleMeta, {format?: SampleFormat}, AbortSignal?) => Promise<Blob \| Error>` | Audiodaten |
| `URL.createObjectURL(blob)` | Browser-API | Blob → ObjectURL für `<audio>` |

Relevante Typen (aus `@audiotool/nexus/api`): `SampleMeta`, `SamplePending`,
`SamplesAPI`, `SampleListOptions`, `SampleListResult`, `SampleFormat`,
`SampleKind` (`"one-shot" | "loop"`), `SampleVisibility` (`"public" | "unlisted"`).

---

## 9. Welche Probleme sind noch offen?

1. **Reale Verifikation fehlt:** Es wurde noch kein echt authentifizierter Lauf
   ausgeführt (kein Browser-OAuth-Token, kein PAT, keine echte Sample-Liste oder
   echter Download). Das ist der entscheidende ausstehende Schritt.
2. **Client-ID erforderlich:** Für den Browser-POC braucht man eine Client-ID von
   `https://developer.audiotool.com/applications` (in `.env` als
   `VITE_AUDIOTOOL_CLIENT_ID`, Redirect auf `http://127.0.0.1:5173/`).
3. **Scope:** Der verwendete Scope (`project:write` im Beispiel) könnte für Sample-
   Zugriff angepasst werden müssen — unklar, ob es einen spezifischen Sample-Scope
   gibt. Echter Lauf klärt das.
4. **Build-bedingtes Tree-Shaking:** Bei leerem `VITE_AUDIOTOOL_CLIENT_ID` eliminiert
   der Produktions-Build den SDK-Pfad (env wird zur Build-Zeit ersetzt). Für den
   Prod-Build muss die Env-Variable beim Build gesetzt sein; für `npm run dev` wird
   sie zur Laufzeit aus `.env` gelesen.
5. **Formate real testen:** FLAC/MP3/Preview-Tauglichkeit und Playback wurden nur
   als Code eingerichtet, nicht gegen echte Bytes verifiziert.

---

# Verifiziert (lokaler Nachweis)

- `@audiotool/nexus@0.0.17` installiert; API `client.samples` mit `list`, `get`,
  `download`, `upload`, `delete` ist in den Type-Definitionen vorhanden.
- TypeScript (`tsc --noEmit`): **fehlerfrei**.
- Build (`vite build`): **erfolgreich** (mit gesetztem Env: SDK-Bundle ~685 kB;
  mit leerem Env nur Fehlerzweig, da gemäß Syntax korrekt).
- Unit-Tests (`vitest run`): **26/26 bestanden** — list-Parsing, Metadaten,
  Pagination, Format-Handling, Fehlerbehandlung.
- Dev-Server (`vite`): **startet** auf `http://localhost:5173/`.
- Node-CLI (`npm run sample` bei fehlendem `AT_PAT`): **valide ablehnend** mit
  klarer Fehlermeldung.

# Noch ausstehend (integrativ/manuell)

- Echten OAuth-Login oder PAT verwenden, `npm run dev` (Browser) bzw.
  `AT_PAT=… npm run sample` (Node) ausführen und die Sample-Zugriffe real bestätigen.

# Verzeichnisstruktur

```
sample-access-poc/
├── index.html            Browser-GUI (Vite)
├── .env.example          Vorlage für Client-ID/Scope
├── src/
│   ├── sample-api.ts     Geteilte, browserunabhängige Logik + Typ-Parser (testbar)
│   ├── sample-api.test.ts Unit-Tests (26)
│   ├── main.ts           Browser-Entry: OAuth + list/get/download/play
│   ├── cli.ts            Node-CLI via PAT: list/get/download
│   └── vite-env.d.ts
├── vite.config.ts
├── tsconfig.json
└── package.json
```
