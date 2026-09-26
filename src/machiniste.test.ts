import { describe, it, expect } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import type { SampleMeta } from "@audiotool/nexus/api";
import { loadLibrarySampleIntoMachiniste } from "./machiniste";

/**
 * Machiniste integration POC (offline validation).
 *
 * Proves the DOCUMENT MECHANISM for loading a library sample into a Machiniste
 * channel via a direct reference — i.e. without downloading + re-uploading the
 * audio:
 *
 *   1. create a Sample entity whose `sampleName` references an existing
 *      library sample (`samples/{uuid}`) — no local audio file required.
 *   2. create a Machiniste.
 *   3. point a Machiniste channel's `sample` field (a NexusLocation pointer
 *      targeting TargetType.Sample) at that Sample entity.
 *   4. let the local WASM validator confirm the transaction is structurally
 *      valid, then read the value back.
 *
 * IMPORTANT: this validates structure/locally. Whether the real backend
 * accepts an arbitrary library sample NAME (e.g. another user's public sample)
 * without the audio being uploaded into the account must be confirmed with the
 * real authenticated run (see MACHINISTE_SAMPLE_ACCESS_POC.md).
 */

const LIBRARY_SAMPLE: SampleMeta = {
  name: "samples/9f2f9b3a-6c1d-4a8e-b2d3-1f0c6f3d9a2b",
  displayName: "Juul perc",
  description: "",
  ownerName: "users/another-user",
  favoritedByUser: false,
  numFavorites: 0,
  numUsages: 0,
  bpm: 0,
  kind: "one-shot",
  visibility: "public",
  tags: ["perc"],
  createTime: undefined,
  updateTime: undefined,
  durationSeconds: 1.0,
  mp3Url: "https://cdn/mp3",
  wavUrl: "https://cdn/wav",
  flacUrl: "https://cdn/flac",
  previewMp3Url: "https://cdn/preview",
  getWaveformUrl: () => "https://cdn/wave",
};

describe("Machiniste direct sample reference (offline document model)", () => {
  it("can create a Sample entity referencing a library sample name without a local file", async () => {
    const doc = await createOfflineDocument();
    await doc.modify((t) => {
      const sample = t.create("sample", {
        sampleName: LIBRARY_SAMPLE.name,
        uploadStartTime: 0n,
      });
      expect(sample.fields.sampleName.value).toBe(LIBRARY_SAMPLE.name);
    });
  });

  it("can create a Machiniste and a Sample, then point a channel at the Sample", async () => {
    const doc = await createOfflineDocument();
    await doc.modify((t) => {
      const machiniste = t.create("machiniste", {});
      const sample = t.create("sample", {
        sampleName: LIBRARY_SAMPLE.name,
        uploadStartTime: 0n,
      });
      const channel0 = machiniste.fields.channels.array[0];
      // Before: empty location.
      expect(channel0.fields.sample.value.isEmpty()).toBe(true);
      t.update(channel0.fields.sample, sample.location);
    });

    // Read back: the channel's sample field should now point at the Sample entity.
    const sampleEntity = doc.queryEntities.ofTypes("sample").getOne();
    const mach = doc.queryEntities.ofTypes("machiniste").getOne();
    expect(sampleEntity).toBeDefined();
    expect(mach).toBeDefined();
    const channel0 = mach!.fields.channels.array[0];
    expect(channel0.fields.sample.value.entityId).toBe(sampleEntity!.id);
    expect(channel0.fields.sample.value.isEmpty()).toBe(false);
  });

  it("can load a library sample reference into every channel", async () => {
    const doc = await createOfflineDocument();
    await doc.modify((t) => {
      const machiniste = t.create("machiniste", {});
      const sample = t.create("sample", {
        sampleName: LIBRARY_SAMPLE.name,
        uploadStartTime: 0n,
      });
      for (const ch of machiniste.fields.channels.array) {
        t.update(ch.fields.sample, sample.location);
      }
    });
    const mach = doc.queryEntities.ofTypes("machiniste").getOne()!;
    for (const ch of mach.fields.channels.array) {
      expect(ch.fields.sample.value.isEmpty()).toBe(false);
    }
  });

  it("a channel's sample field holds exactly one pointer (last write wins, still valid)", async () => {
    const doc = await createOfflineDocument();
    await doc.modify((t) => {
      const s1 = t.create("sample", { sampleName: "samples/a", uploadStartTime: 0n });
      const machiniste = t.create("machiniste", {});
      const s2 = t.create("sample", { sampleName: "samples/b", uploadStartTime: 0n });
      const ch = machiniste.fields.channels.array[0];
      t.update(ch.fields.sample, s1.location);
      t.update(ch.fields.sample, s2.location);
    });
    const mach = doc.queryEntities.ofTypes("machiniste").getOne()!;
    const finalSampleId = doc.queryEntities
      .ofTypes("sample")
      .get()
      .find((s) => s.fields.sampleName.value === "samples/b")!.id;
    expect(mach.fields.channels.array[0].fields.sample.value.entityId).toBe(finalSampleId);
  });
});

describe("loadLibrarySampleIntoMachiniste helper (offline)", () => {
  it("creates a Sample entity + points a channel at it via direct reference", async () => {
    const doc = await createOfflineDocument();
    const proc = await loadLibrarySampleIntoMachiniste(doc, LIBRARY_SAMPLE);
    expect(proc.errors).toEqual([]);
    expect(proc.created).toBe(true);
    expect(proc.directReferenceApplied).toBe(true);
    expect(proc.sampleEntityId).toBeDefined();
    expect(proc.machinisteId).toBeDefined();
    expect(proc.readBackMatches).toBe(true);
    expect(proc.channelSampleEntityId).toBe(proc.sampleEntityId);

    // The Sample entity in the document carries the library sample name.
    const sampleEntity = doc.queryEntities
      .ofTypes("sample")
      .getEntity(proc.sampleEntityId!);
    expect(sampleEntity).toBeDefined();
    expect(sampleEntity!.fields.sampleName.value).toBe(LIBRARY_SAMPLE.name);
  });

  it("loads the same library reference into a channel of an existing machiniste", async () => {
    const doc = await createOfflineDocument();
    await doc.modify((t) => {
      t.create("machiniste", {});
    });
    const mach = doc.queryEntities.ofTypes("machiniste").getOne()!;
    const proc = await loadLibrarySampleIntoMachiniste(doc, LIBRARY_SAMPLE);
    expect(proc.errors).toEqual([]);
    expect(proc.machinisteId).toBe(mach.id);
    expect(proc.directReferenceApplied).toBe(true);
    expect(proc.readBackMatches).toBe(true);
  });
});
