import type { SyncedDocument } from "@audiotool/nexus";
import type { SampleMeta } from "@audiotool/nexus/api";

/**
 * Machiniste integration helpers.
 *
 * The mechanism: a Machiniste channel's `sample` field is a NexusLocation
 * pointer ("mut", targets TargetType.Sample). A document-local `Sample` entity
 * holds `sampleName` (the backend name `samples/{uuid}`) as an immutable field.
 *
 * To load an EXISTING library sample into a Machiniste without re-uploading the
 * audio, we create a Sample entity whose sampleName references the library
 * sample, then point a channel at it. This is the "direct reference" path.
 */

/** Structural subset of SyncedDocument/OfflineDocument used by these helpers. */
export type ModifyDocument = Pick<
  SyncedDocument,
  "modify" | "queryEntities"
>;

export type MachinisteTestResult = {
  sample: SampleMeta;
  sampleEntityId: string | undefined;
  machinisteId: string | undefined;
  channelSampleEntityId: string | undefined;
  directReferenceApplied: boolean;
  readBackMatches: boolean;
  created: boolean;
  errors: string[];
};

const ERR_NO_DURATION = "sample has no durationSeconds";

/**
 * Try to load a library sample into a Machiniste channel by direct reference.
 *
 * @param doc    the (synced or offline) document
 * @param sample the library sample to load (uses `sample.name` as sampleName)
 * @returns diagnostic result
 */
export async function loadLibrarySampleIntoMachiniste(
  doc: ModifyDocument,
  sample: SampleMeta,
): Promise<MachinisteTestResult> {
  const errors: string[] = [];
  const result: MachinisteTestResult = {
    sample,
    sampleEntityId: undefined,
    machinisteId: undefined,
    channelSampleEntityId: undefined,
    directReferenceApplied: false,
    readBackMatches: false,
    created: false,
    errors,
  };

  try {
    await doc.modify((t) => {
      // 1. Find an existing machiniste, or (prefer) create a fresh one so the
      //    test is self-contained and doesn't mutate someone's existing device.
      let machiniste = t.entities.ofTypes("machiniste").getOne();
      if (!machiniste) {
        machiniste = t.create("machiniste", {});
      }
      result.machinisteId = machiniste.id;

      // 2. Create a Sample entity that references the library sample by name.
      //    No local file / download needed — this is the direct reference.
      const sampleEntity = t.create("sample", {
        sampleName: sample.name,
        uploadStartTime: 0n,
      });
      result.sampleEntityId = sampleEntity.id;
      result.created = true;

      // 3. Point the first channel's sample field at the Sample entity.
      const channel0 = machiniste.fields.channels.array[0];
      t.update(channel0.fields.sample, sampleEntity.location);
      result.directReferenceApplied = true;

      // Read back within the transaction.
      result.channelSampleEntityId = channel0.fields.sample.value.entityId;
      result.readBackMatches = channel0.fields.sample.value.entityId === sampleEntity.id;
    });
  } catch (e) {
    errors.push(`transaction rejected: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!Number.isFinite(sample.durationSeconds)) {
    errors.push(`${ERR_NO_DURATION} (${sample.name})`);
  }

  return result;
}
