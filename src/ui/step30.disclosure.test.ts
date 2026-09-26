/**
 * STEP32 — Progressive Disclosure Correction & UX Hardening — app-level tests
 * that lock in the SINGLE canonical state source: `app.progressiveDisclosure`.
 *
 * Coverage (§STEP32): the corrected three-flag model (inspectorUsed and
 * soundSpace removed — both are always-available surfaces), intent-driven
 * reveal (focus → similarity, genuine add → collection), monotonic latching,
 * the invariant that Sound Space/Inspector need no flag, the NO-DUPLICATE-
 * STATE-SOURCE guarantee (no `soundSpaceRevealed`/`progressiveDiscovery`
 * alias), and removal of the opaque "SD" reveal-all toggle
 * (`toggleDisclosureSurfaces` no longer exists).
 *
 * The rig is deliberately lightweight: the disclosure flags are latched
 * synchronously at the top of each open/add method, before any async surface
 * work, so no IndexedDB / corpus is required for the state-transition
 * invariant itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SampleMapApp } from "./app";
import type { SampleMapAppDeps } from "./app";
import { PreviewService } from "../preview/previewService";
import type { SampleMapMachinisteService } from "../machiniste/machinisteService";
import { createMemoryEp7ConsentStore } from "./ep7Consent";

const granted = () => {
  const store = createMemoryEp7ConsentStore();
  store.grant();
  return store;
};

function makeDeps(): SampleMapAppDeps {
  const search = { search: async () => [] } as unknown as SampleMapAppDeps["search"];
  const preview = {} as unknown as PreviewService;
  const machiniste = {} as unknown as SampleMapMachinisteService;
  const createRunner = (() => ({
    start: async () => undefined,
    pause: () => undefined,
    isRunning: () => false,
    isPaused: () => false,
  })) as unknown as SampleMapAppDeps["createRunner"];
  return {
    queue: { enqueue: async () => "added", countByStatus: async () => 0 } as never,
    search,
    preview,
    machiniste,
    createRunner,
    fetchPage: async () => ({ samples: [], nextPageToken: undefined }),
    known: { getUpdatedAt: async () => undefined },
    previewUrlFor: () => undefined,
    analysisBuild: "build-step32",
    ep7Consent: granted(),
  };
}

const ALL_FALSE = {
  discoveryUsed: false,
  collectionManagerUsed: false,
  similarityV2Used: false,
};

describe("STEP32 — progressive disclosure: initial state", () => {
  it("the three intent flags begin un-revealed (no dead flags)", () => {
    const app = new SampleMapApp(makeDeps());
    expect(app.progressiveDisclosure).toEqual(ALL_FALSE);
  });

  it("inspectorUsed and soundSpace no longer exist as disclosure flags", () => {
    const app = new SampleMapApp(makeDeps());
    const pd = app.progressiveDisclosure as unknown as Record<string, boolean>;
    expect("inspectorUsed" in pd).toBe(false);
    expect("soundSpace" in pd).toBe(false);
  });
});

describe("STEP32 — focus reveals similarity (P0)", () => {
  it("selectSample latches similarityV2Used on a real focus", () => {
    const app = new SampleMapApp(makeDeps());
    expect(app.progressiveDisclosure.similarityV2Used).toBe(false);
    const record = { sampleId: "samples/a", name: "A" } as never;
    app.selectSample(record);
    expect(app.progressiveDisclosure.similarityV2Used).toBe(true);
    expect(app.focusedSampleId).toBe("samples/a");
  });

  it("focusing reveals ONLY similarity (intent-specific, not collection)", () => {
    const app = new SampleMapApp(makeDeps());
    const record = { sampleId: "samples/a", name: "A" } as never;
    app.selectSample(record);
    expect(app.progressiveDisclosure).toEqual({
      ...ALL_FALSE,
      similarityV2Used: true,
    });
  });

  it("focusing an undefined (clear) does NOT latch similarity", () => {
    const app = new SampleMapApp(makeDeps());
    app.selectSample(undefined);
    expect(app.progressiveDisclosure.similarityV2Used).toBe(false);
  });
});

describe("STEP32 — add reveals collection (P1)", () => {
  it("a genuine add latches collectionManagerUsed", async () => {
    const app = new SampleMapApp(makeDeps());
    expect(app.progressiveDisclosure.collectionManagerUsed).toBe(false);
    await app.addToCollection("samples/a");
    expect(app.progressiveDisclosure.collectionManagerUsed).toBe(true);
    expect(app.collection.sampleIds).toContain("samples/a");
  });

  it("a duplicate re-add does NOT re-latch (already revealed stays revealed)", async () => {
    const app = new SampleMapApp(makeDeps());
    await app.addToCollection("samples/a");
    const afterFirst = app.progressiveDisclosure.collectionManagerUsed;
    await app.addToCollection("samples/a");
    expect(app.progressiveDisclosure.collectionManagerUsed).toBe(afterFirst);
    expect(app.collection.sampleIds).toEqual(["samples/a"]);
  });

  it("add latches ONLY collection (intent-specific, not similarity)", async () => {
    const app = new SampleMapApp(makeDeps());
    await app.addToCollection("samples/a");
    expect(app.progressiveDisclosure).toEqual({
      ...ALL_FALSE,
      collectionManagerUsed: true,
    });
  });

  it("add converges from multiple canonical paths on the same latch", async () => {
    // Simulates: Results "Add", Discovery "Add", Sound Space focused "Add" —
    // all route through app.addToCollection. Any first caller reveals the
    // collection exactly once.
    const appA = new SampleMapApp(makeDeps());
    await appA.addToCollection("samples/a");
    const appB = new SampleMapApp(makeDeps());
    await appB.addToCollection("samples/b");
    expect(appA.progressiveDisclosure.collectionManagerUsed).toBe(true);
    expect(appB.progressiveDisclosure.collectionManagerUsed).toBe(true);
  });
});

describe("STEP32 — Sound Space needs no disclosure flag", () => {
  it("openSoundSpace works and leaves disclosure flags untouched (no dead flag)", async () => {
    const app = new SampleMapApp(makeDeps());
    await app.openSoundSpace();
    expect(app.soundSpace.open).toBe(true);
    expect(app.progressiveDisclosure).toEqual(ALL_FALSE);
  });
});

describe("STEP32 — monotonic latching", () => {
  it("focusing another sample never resets the similarity flag", () => {
    const app = new SampleMapApp(makeDeps());
    app.selectSample({ sampleId: "samples/a", name: "A" } as never);
    app.selectSample({ sampleId: "samples/b", name: "B" } as never);
    expect(app.progressiveDisclosure.similarityV2Used).toBe(true);
  });

  it("openDiscovery latches exactly discoveryUsed", async () => {
    const app = new SampleMapApp(makeDeps());
    await app.openDiscovery();
    expect(app.progressiveDisclosure).toEqual({ ...ALL_FALSE, discoveryUsed: true });
  });
});

describe("STEP32 — the opaque SD reveal-all toggle is REMOVED", () => {
  it("the app instance exposes no toggleDisclosureSurfaces method", () => {
    const app = new SampleMapApp(makeDeps());
    const runtime = app as unknown as Record<string, unknown>;
    expect(typeof runtime.toggleDisclosureSurfaces).toBe("undefined");
  });

  it("source: app.ts + render.ts contain zero occurrences of the retired identifiers", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const appSrc = readFileSync(`${root}src/ui/app.ts`, "utf8");
    const renderSrc = readFileSync(`${root}src/ui/render.ts`, "utf8");
    for (const src of [appSrc, renderSrc]) {
      expect(src).not.toContain("toggleDisclosureSurfaces");
      expect(src).not.toContain("soundSpaceRevealed");
      expect(src).not.toContain("progressiveDiscovery");
      expect(src).not.toContain("inspectorUsed");
      expect(src).not.toContain("progressiveDisclosure.soundSpace");
    }
  });
});