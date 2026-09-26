import type { SyncedDocument } from "@audiotool/nexus";
import type { SampleMeta } from "@audiotool/nexus/api";
import { isSampleName, toSampleName } from "../library/sampleRef";
import type { AudiotoolSampleReference } from "../library/sampleRef";

/**
 * MachinisteService — SAMPLEMAP_V1_SPEC §10.
 *
 * Chain: `AudiotoolSampleReference → MachinisteService → Sample Entity →
 * MachinisteChannel.sample`.
 *
 * `send()` loads several library samples into several Machiniste slots in a
 * SINGLE `doc.modify(...)` transaction (atomic commit, one read-back pass),
 * using the real, verified POC mechanism (`src/machiniste.ts`):
 *
 *   - For each sample, create a document-local `Sample` entity whose immutable
 *     `sampleName` field references the library sample (`samples/{uuid}`) —
 *     NO audio bytes are downloaded, re-encoded or persisted; nothing audio is
 *     stored in IndexedDB or in this document. This is the "direct reference"
 *     path shown to work offline by the POC.
 *   - Point `MachinisteChannel[slot].sample` (a NexusLocation → Sample) at the
 *     newly created Sample entity.
 *
 * Constraints (per §10.2 / §20.10):
 *   - `samples[i]` is mapped to `slots[i]`; both arrays must have equal length.
 *   - A single `send` is bounded by `MAX_BATCH_SLOTS`; larger selections are
 *     the caller's responsibility to split into batches (bounded concurrency,
 *     no unbounded transaction fan-out).
 *   - After the transaction commits, the service performs a read-back per slot
 *     against committed `doc.queryEntities` state and reports per-slot
 *     `applied` / `readBackMatches` / `errors[]`.
 *
 * This service deliberately performs NO audio decoding, classification,
 * feature extraction, queueing or search — it only wires direct references.
 */

/** Maximum number of slots processed per single `send()` call (spec: 8→8). */
export const MAX_BATCH_SLOTS = 8;

/** Structural subset of the Nexus document used by this service. */
export type MachinisteDocument = Pick<
  SyncedDocument,
  "modify" | "queryEntities"
>;

/** A per-slot outcome of `send()`. */
export type MachinisteSlotResult = {
  /** The Machiniste channel index this slot mapped to. */
  slot: number;
  /** The canonical `samples/{uuid}` reference that was loaded. */
  sampleName: AudiotoolSampleReference;
  /** Whether the transaction applied for this slot (entity created + pointer set). */
  applied: boolean;
  /** Whether the committed read-back matches what we wrote (pointer + entity). */
  readBackMatches: boolean;
  /** id of the created document-local Sample entity (commit order). */
  sampleEntityId: string | undefined;
  /** structured, non-fatal per-slot errors (empty on success). */
  errors: string[];
};

/** Overall result of `send()`. */
export type MachinisteSendResult = {
  /** The Machiniste entity id the samples were sent to, if resolved. */
  machinisteId: string | undefined;
  /** Whether the transaction was committed (all-or-nothing). */
  committed: boolean;
  /** Per-slot outcomes, in send order. */
  slots: MachinisteSlotResult[];
  /** Structured failures that prevented committing the batch (empty on success). */
  errors: string[];
};

export class MachinisteNotFoundError extends Error {
  constructor(id: string) {
    super(`machiniste not found: ${id}`);
    this.name = "MachinisteNotFoundError";
  }
}

export class MachinisteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachinisteValidationError";
  }
}

/** Normalized per-slot plan built before the transaction. */
interface PlanSlot {
  slot: number;
  sampleName: AudiotoolSampleReference;
}

/** A slot whose Sample entity was created inside the committed transaction. */
interface CommittedSlot {
  slot: number;
  sampleName: AudiotoolSampleReference;
  entityId: string;
}

export class SampleMapMachinisteService {
  constructor(private readonly doc: MachinisteDocument) {}

  /**
   * Send `samples[i]` → `slots[i]` to a Machiniste in a single transaction.
   *
   * @param samples      library samples (SampleMeta or `samples/{uuid}` name).
   * @param machinisteId id of the target Machiniste entity.
   * @param slots        channel indices of the target Machiniste (parallel to samples).
   */
  async send(
    samples: ReadonlyArray<SampleMeta | AudiotoolSampleReference>,
    machinisteId: string,
    slots: ReadonlyArray<number>,
  ): Promise<MachinisteSendResult> {
    const result: MachinisteSendResult = {
      machinisteId: undefined,
      committed: false,
      slots: [],
      errors: [],
    };

    // --- Pre-validation (no Document touched yet) ---------------------------
    const planError = buildPlan(samples, slots);
    if (planError) {
      result.errors.push(planError);
      result.slots = toSlotResults(planSlots(samples, slots));
      return result;
    }
    const plan = planSlots(samples, slots);

    // --- Resolve the target Machiniste against committed state -------------
    const mach = resolveMachiniste(this.doc, machinisteId);
    if (!mach) {
      result.machinisteId = machinisteId;
      result.errors.push(new MachinisteNotFoundError(machinisteId).message);
      result.slots = toSlotResults(plan);
      return result;
    }
    result.machinisteId = mach.id;

    // --- Validate slots against the Machiniste's channel count ------------
    const available = mach.fields.channels.array.length;
    const badSlot = plan.find((p) => p.slot < 0 || p.slot >= available);
    if (badSlot) {
      result.errors.push(
        new MachinisteValidationError(
          `slot ${badSlot.slot} out of range [0, ${available - 1}]`,
        ).message,
      );
      result.slots = toSlotResults(plan);
      return result;
    }

    // --- Apply everything in ONE transaction (atomic commit) ---------------
    const created: CommittedSlot[] = [];
    try {
      await this.doc.modify((t) => {
        const tMach =
          t.entities.ofTypes("machiniste").getEntity(machinisteId) ??
          t.entities.ofTypes("machiniste").get().find((m) => m.id === machinisteId);
        if (!tMach) {
          throw new MachinisteNotFoundError(machinisteId);
        }
        for (const p of plan) {
          const sampleEntity = t.create("sample", {
            sampleName: p.sampleName,
            uploadStartTime: 0n,
          });
          const channel = tMach.fields.channels.array[p.slot];
          t.update(channel.fields.sample, sampleEntity.location);
          created.push({ slot: p.slot, sampleName: p.sampleName, entityId: sampleEntity.id });
        }
      });
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : String(e);
      result.errors.push(`transaction rejected: ${msg}`);
      result.slots = plan.map((p) => ({
        slot: p.slot,
        sampleName: p.sampleName,
        applied: false,
        readBackMatches: false,
        sampleEntityId: undefined,
        errors: [`transaction rejected: ${msg}`],
      }));
      return result;
    }
    result.committed = true;

    // --- Read-back per slot against committed state ------------------------
    const machAfter = resolveMachiniste(this.doc, machinisteId);
    for (const c of created) {
      let applied = true;
      let readBackMatches = false;
      const slotErrors: string[] = [];
      const channel = machAfter?.fields.channels.array[c.slot];
      const channelEntityId = channel?.fields.sample.value.entityId;
      const sampleEntity = this.doc.queryEntities
        .ofTypes("sample")
        .getEntity(c.entityId);
      const sampleEntityName = sampleEntity?.fields.sampleName.value;

      if (channelEntityId !== c.entityId) {
        applied = false;
        readBackMatches = false;
        slotErrors.push(
          `read-back mismatch: channel ${c.slot} points at ${channelEntityId ?? "(empty)"}, expected ${c.entityId}`,
        );
      } else if (!sampleEntity) {
        readBackMatches = false;
        slotErrors.push(`read-back mismatch: created Sample entity ${c.entityId} not found`);
      } else if (sampleEntityName !== c.sampleName) {
        readBackMatches = false;
        slotErrors.push(
          `read-back mismatch: Sample entity ${c.entityId} has sampleName ${sampleEntityName}, expected ${c.sampleName}`,
        );
      } else {
        readBackMatches = true;
      }

      result.slots.push({
        slot: c.slot,
        sampleName: c.sampleName,
        applied,
        readBackMatches,
        sampleEntityId: c.entityId,
        errors: slotErrors,
      });
    }

    return result;
  }
}

/** Resolve a Machiniste entity by id from committed document state. */
function resolveMachiniste(doc: MachinisteDocument, id: string): any {
  const q = doc.queryEntities.ofTypes("machiniste");
  const byId = (q.getEntity as (id: string) => any | undefined)?.call(q, id);
  if (byId) return byId;
  return q.get().find((m) => m.id === id) as any;
}

/** Validate lengths / batch size / references / slot indices; return error or undefined. */
function buildPlan(
  samples: ReadonlyArray<SampleMeta | AudiotoolSampleReference>,
  slots: ReadonlyArray<number>,
): string | undefined {
  if (samples.length === 0) {
    return new MachinisteValidationError("no samples given").message;
  }
  if (slots.length !== samples.length) {
    return new MachinisteValidationError(
      `samples.length (${samples.length}) !== slots.length (${slots.length})`,
    ).message;
  }
  if (samples.length > MAX_BATCH_SLOTS) {
    return new MachinisteValidationError(
      `batch of ${samples.length} exceeds MAX_BATCH_SLOTS=${MAX_BATCH_SLOTS}`,
    ).message;
  }
  for (const s of samples) {
    const name = toSampleName(s);
    if (!isSampleName(name)) {
      return new MachinisteValidationError(`invalid sample reference: ${name}`).message;
    }
  }
  for (const slot of slots) {
    if (!Number.isInteger(slot) || slot < 0) {
      return new MachinisteValidationError(`invalid slot index: ${slot}`).message;
    }
  }
  return undefined;
}

/** Build the [slot][sampleName] plan (used for both validation output and apply). */
function planSlots(
  samples: ReadonlyArray<SampleMeta | AudiotoolSampleReference>,
  slots: ReadonlyArray<number>,
): PlanSlot[] {
  return samples.map((s, i) => ({
    slot: slots[i]!,
    sampleName: toSampleName(s),
  }));
}

/** Represent a plan as non-applied slot results (used when we short-circuit). */
function toSlotResults(plan: PlanSlot[]): MachinisteSlotResult[] {
  return plan.map((p) => ({
    slot: p.slot,
    sampleName: p.sampleName,
    applied: false,
    readBackMatches: false,
    sampleEntityId: undefined,
    errors: [],
  }));
}
