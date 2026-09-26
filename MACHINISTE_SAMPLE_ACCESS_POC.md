# MACHINISTE_SAMPLE_ACCESS_POC

**Projekt:** SampleMap — Machiniste Integration POC
**Datum:** 2026-08-31
**SDK:** `@audiotool/nexus@0.0.17`

## Zweck

Untersucht die technische Frage:

> Kann eine Nexus-App ein vorhandenes Audiotool-Sample (z. B. ein öffentliches
> Sample eines anderen Users) **direkt** in einen Machiniste laden, ohne das
> Sample lokal als Datei zu speichern (Download → Upload)?

Das Ziel ist der Pfad:

```text
Audiotool Sample
      ↓ (direkte Referenz)
Machiniste Slot
```

Kein Download/Upload, kein lokaler Audio-Storage, keine KI/etc.

---

## API Discovery

Tatsächlich gefundene Nexus-APIs/Datenstrukturen in `@audiotool/nexus@0.0.17`:

| Ebene | Gefunden |
|-------|----------|
| High-Level API | `client.samples.list/get/download/upload`; `client.open(project)`; `client.projects.*` |
| Dokument-API | `SyncedDocument.modify/createTransaction/queryEntities/start/stop`; `TransactionBuilder.create/update` |
| Machiniste Entity | `Machiniste` (`machiniste`), `MachinistePattern` (`machinistePattern`) |
| Machiniste Channel | `MachinisteChannel` — Feld **`sample`** |
| Sample Entity | `Sample` (`sample`) — Feld **`sampleName`** |
| Pointer | `MachinisteChannel.sample: PrimitiveField<NexusLocation, "mut">` |

Relevante generierte Typen:
- `gen/.../entity/machiniste/v1/machiniste_pb.d.ts` / `machiniste_nexus.d.ts`
- `gen/.../entity/sample/v1/sample_nexus.d.ts`

---

## Machiniste Access

**JA — Machiniste kann gelesen/erstellt/verändert werden** (per Dokument-API).

- Erzeugen: `t.create("machiniste", {})`
- Lesen/Query: `doc/queryEntities.ofTypes("machiniste").get()`
- Felder ändern: `t.update(field, value)` (z. B. `displayName`, `isActive`, Channel-Parameter)

Das ist via `SyncedDocument.modify()` / `createTransaction()` verfügbar — sowohl im
Browser (`client.open` → `SyncedDocument`) als auch in Node (PAT) möglich.

---

## Sample Field

Das Sample eines Machiniste-Kanals wird referenziert über:

```text
MachinisteChannel.sample : PrimitiveField<NexusLocation, "mut">
    targets = TargetType.Sample  →  entities.Sample
```

- Es ist eine **`NexusLocation`** (ein Dokument-interner Pointer), **keine** rohe
  Sample-ID-Zeichenkette und kein `SampleMeta`.
- Der Pointer zeigt auf eine **documents-lokale `Sample`-Entity**.
- Die `Sample`-Entity hält den eigentlichen Backend-Namen in einem **immutable**
  Feld:

```text
Sample.sampleName : PrimitiveField<string, "immut">   // i.d.R. "samples/{uuid}"
Sample.uploadStartTime : PrimitiveField<bigint, "immut">
```

Also: **Referenzierung = eine documents-lokale `Sample`-Entity, deren `sampleName`
den Library-Sample-Namen trägt, + Machiniste-Channel-Pointer auf diese Entity.**

---

## Direct Reference

**Mechanismus — VERIFIZIERT (lokal/offline), Backend-Akzeptanz — OFFEN.**

Der direkte Referenz-Pfad (ohne Download/Upload) funktioniert **strukturell**:

1. `t.create("sample", { sampleName: "samples/<uuid>", uploadStartTime: 0n })`
2. `t.create("machiniste", {})` (oder vorhandenen verwenden)
3. `t.update(mach.fields.channels.array[0].fields.sample, sampleEntity.location)`

Dieses Vorgehen wurde gegen den **lokalen Nexus-WASM-Validator** verifiziert
(`createOfflineDocument` in Node): Die Transaktion ist gültig, und das Feld lässt
sich danach auslesen (Referenz zeigt auf die Sample-Entity). Siehe
`src/machiniste.ts` (`loadLibrarySampleIntoMachiniste`) und die Tests in
`src/machiniste.test.ts`.

**Wichtige offene Frage:** Ob der reale Backend-Server einen `sampleName` akzeptiert,
der auf ein **fremdes Libraries-Sample** verweist (also ohne dass die Audiodaten in
den Account hochgeladen wurden), ist **nicht** durch lokale Validierung entscheidbar —
das erfordert einen echten authentifizierten Lauf (Browser-OAuth oder Node-PAT gegen
ein echtes Projekt). Siehe „Verdict“ und „Offene Punkte“.

---

## Cross-user Sample

**Nicht real verifiziert.**

Der POC verwendet ein öffentliches Sample, dessen `ownerName` sich von dem ersten
gelisteten unterscheidet (plausibel fremder User). Ob die direkte Referenz auf ein
*fremdes* Libraries-Sample vom Backend akzeptiert wird, muss real getestet werden
(Browser-Button „Machiniste Direct-Reference Test“ bzw. `--machiniste <project>`).

---

## Runtime Verification

**Struktur/Rücklesen — VERIFIZIERT (offline).**

Nach dem Setzen wird die Referenz erneut ausgelesen und verglichen:
`channel.fields.sample.value.entityId === sampleEntity.id`. Das funktioniert in der
Offline-Umgebung (`readBackMatches: true`).

**Playback/akustische Verifikation im echten Machiniste — OFFEN** (realer Lauf nötig).

---

## Download/Upload Fallback

Falls direkte Referenzierung am Backend scheitert: **Download → Upload ist möglich.**

- Download: `client.samples.download(sample, { format: "flac"|"wav"|... })` → `Blob`
- Re-Upload als neues Sample: `client.samples.upload({ file, displayName, ... })`
- Danach `t.insertSample(upload)` in die Timeline, bzw. ein neues `Sample`-Entity...

Diese Fallback-Ketten sind technisch vorhanden (die Download-Seite ist bereits im
vorherigen POC belegt). Sie sind aber **nicht** das bevorzugte Ziel (würde das Sample
duplizieren / Speicher erfordern).

---

## Verdict

### B — MACHINISTE ACCESS CONFIRMED, BUT DIRECT SAMPLE REFERENCE UNKNOWN

Begründung:
- **Machiniste-Kontrolle:** bestätigt (lesen/erzeugen/ändern über Dokument-API).
- **Direkte Referenz — mechanisch:** die Nexus-Datenstruktur unterstützt eine
  documents-lokale `Sample`-Entity mit einem library-`sampleName` und einen
  Machiniste-Channel-Pointer darauf (per WASM-Validator lokal bestätigt).
- **Direkte Referenz — real gegen fremdes Libraries-Sample:** **unbekannt** —
  benötigt einen echten authentifizierten Lauf, um zu bestätigen, dass das Backend
  einen fremden `sampleName` ohne Upload akzeptiert.

Es ist also **weder** „DIRECT SAMPLE REFERENCE CONFIRMED“ (A) noch
„DOWNLOAD/UPLOAD REQUIRED“ (C) eindeutig belegt — der entscheidende Nachweis steht aus.

---

## Tests

```text
npm test           → 32/32 bestanden
npx tsc --noEmit   → fehlerfrei
npm run build      → erfolgreich
```

Existing tests (26 Sample-API) unverändert grün; neu: 6 Machiniste-Tests (offline).

---

## Konkrete Implementierung

- `src/machiniste.ts` — enthält `loadLibrarySampleIntoMachiniste(doc, sample)` +
  `ModifyDocument`-Typ.
- `src/machiniste.test.ts` — Offline-/WASM-Validierung des direkten Referenz-Mechanismus.
- `src/main.ts` — Browser-POC: nach Login + Sample-Auswahl ein **opt-in**-Button
  „Machiniste Direct-Reference Test“ (öffnet erstes Projekt, führt den Test aus,
  liest zurück, stoppt).
- `src/cli.ts` — Node-PAT-Variante: `npm run sample -- --machiniste <project>`.

---

## Offene Punkte

1. **Realer Backend-Lauf** gegen echte Projekt + fremdes Libraries-Sample zur
   Bestätigung der `sampleName`-Akzeptanz (Browser-Button oder `--machiniste`).
2. Akustisches/verifiziertes Abspielen im echten Machiniste.
3. Ob für die direkte Referenz `uploadStartTime` gesetzt werden muss (aktuell `0n`).
4. Scope für Projekt-Schreibzugriff ggf. klären.
