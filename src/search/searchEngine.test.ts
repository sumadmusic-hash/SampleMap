import { describe, it, expect } from "vitest";
import { openTestDatabase } from "../persistence/test-helpers";
import { makeSample } from "../persistence/test-helpers";
import { SampleMapSearchEngine } from "./searchEngine";

/**
 * Seed a small, diverse, deterministic index snapshot and return an engine.
 * Records e (gone) and f (pending) are deliberately non-analysed so the default
 * status filtering can be verified.
 */
async function seed() {
  const handle = await openTestDatabase();
  const index = handle.index;
  const put = (
    id: string,
    overrides: Parameters<typeof makeSample>[1] = {},
  ) => index.put(makeSample(id, overrides));

  await put("samples/a", {
    name: "Hard Kick 01",
    owner: "alice",
    originalTags: ["pierre"],
    primaryClass: "kick",
    confidence: 0.9,
    analyzedAt: "2026-01-01T00:00:00.000Z",
  });
  await put("samples/b", {
    name: "Soft Snare",
    owner: "bob",
    originalTags: ["backbeat"],
    primaryClass: "snare",
    confidence: 0.6,
    analyzedAt: "2026-01-02T00:00:00.000Z",
  });
  await put("samples/c", {
    name: "Deep Sub Bass",
    owner: "carol",
    originalTags: ["808"],
    primaryClass: "bass",
    confidence: 0.95,
    analyzedAt: "2026-01-03T00:00:00.000Z",
  });
  await put("samples/d", {
    name: "Airy Vocal Chop",
    owner: "alice",
    originalTags: ["vox", "choir"],
    primaryClass: "vocal",
    confidence: 0.7,
    secondaryClasses: [{ class: "pad", confidence: 0.2 }],
    analyzedAt: "2026-01-04T00:00:00.000Z",
  });
  await put("samples/e", {
    name: "Broken Hit",
    owner: "xray",
    primaryClass: "kick",
    confidence: 0.2,
    status: "gone",
    analyzedAt: "2026-01-05T00:00:00.000Z",
  });
  await put("samples/f", {
    name: "Queued Pad",
    owner: "yankee",
    primaryClass: "pad",
    confidence: 0.5,
    status: "pending",
    analyzedAt: "2026-01-06T00:00:00.000Z",
  });
  await put("samples/g", {
    name: "Warm Pad",
    owner: "carol",
    primaryClass: "pad",
    confidence: 0.5,
    analyzedAt: "2026-01-07T00:00:00.000Z",
  });
  await put("samples/h", {
    name: "Deep House Loop",
    owner: "carol",
    primaryClass: "loop",
    confidence: 0.3,
    analyzedAt: "2026-01-08T00:00:00.000Z",
  });
  await put("samples/i", {
    name: "Deeply Sub",
    owner: "carol",
    primaryClass: "bass",
    confidence: 0.4,
    analyzedAt: "2026-01-09T00:00:00.000Z",
  });

  return { engine: new SampleMapSearchEngine(index), index };
}

const ids = (r: { record: { sampleId: string } }[]) =>
  r.map((x) => x.record.sampleId);

describe("SampleMapSearchEngine", () => {
  it("empty search returns analyzed records only", async () => {
    const { engine } = await seed();
    const out = await engine.search({});
    expect(ids(out)).toEqual([
      "samples/c", // 0.95
      "samples/a", // 0.90
      "samples/d", // 0.70
      "samples/b", // 0.60
      "samples/g", // 0.50
      "samples/i", // 0.40
      "samples/h", // 0.30
    ]);
    // gone (e) and pending (f) are excluded by default.
    expect(ids(out)).not.toContain("samples/e");
    expect(ids(out)).not.toContain("samples/f");
  });

  it("searches by sample name", async () => {
    const { engine } = await seed();
    expect(ids(await engine.search({ text: "snare" }))).toEqual(["samples/b"]);
    expect(ids(await engine.search({ text: "warm pad" }))).toEqual(["samples/g"]);
  });

  it("searches by original tag", async () => {
    const { engine } = await seed();
    expect(ids(await engine.search({ text: "808" }))).toEqual(["samples/c"]);
    expect(ids(await engine.search({ text: "choir" }))).toEqual(["samples/d"]);
  });

  it("searches by owner", async () => {
    const { engine } = await seed();
    const out = await engine.search({ text: "alice" });
    expect(ids(out)).toEqual(["samples/a", "samples/d"]);
  });

  it("is case-insensitive", async () => {
    const { engine } = await seed();
    expect(ids(await engine.search({ text: "SNARE" }))).toEqual(["samples/b"]);
    expect(ids(await engine.search({ text: "Deep" }))).toEqual([
      "samples/c",
      "samples/h",
      "samples/i",
    ]);
    expect(ids(await engine.search({ text: "KICK" }))).toEqual(["samples/a"]);
  });

  it("matches every token (AND semantics) for a token query", async () => {
    const { engine } = await seed();
    // "soft snare" -> tokens soft + snare, both present only in b.
    expect(ids(await engine.search({ text: "soft snare" }))).toEqual([
      "samples/b",
    ]);
    // "deep" alone matches c, h, i.
    expect(ids(await engine.search({ text: "deep" }))).toEqual([
      "samples/c",
      "samples/h",
      "samples/i",
    ]);
  });

  it("filters by primaryClass", async () => {
    const { engine } = await seed();
    expect(ids(await engine.search({ classes: ["kick"] }))).toEqual([
      "samples/a",
    ]);
  });

  it("filters by secondaryClass", async () => {
    const { engine } = await seed();
    // pad matches g (primary) and d (secondary).
    const out = await engine.search({ classes: ["pad"] });
    expect(ids(out).sort()).toEqual(["samples/d", "samples/g"]);
  });

  it("accepts multiple classes (OR)", async () => {
    const { engine } = await seed();
    const out = await engine.search({ classes: ["kick", "snare"] });
    expect(ids(out).sort()).toEqual(["samples/a", "samples/b"]);
  });

  it("accepts taxonomy group names (drums)", async () => {
    const { engine } = await seed();
    const out = await engine.search({ classes: ["drums"] });
    expect(ids(out).sort()).toEqual(["samples/a", "samples/b"]);
  });

  it("filters by minConfidence", async () => {
    const { engine } = await seed();
    const out = await engine.search({ minConfidence: 0.8 });
    expect(ids(out)).toEqual(["samples/c", "samples/a"]);
  });

  it("sorts by confidence descending by default (and explicitly)", async () => {
    const { engine } = await seed();
    const out = await engine.search({ sortBy: "confidence" });
    expect(ids(out)).toEqual([
      "samples/c",
      "samples/a",
      "samples/d",
      "samples/b",
      "samples/g",
      "samples/i",
      "samples/h",
    ]);
  });

  it("sorts by name ascending", async () => {
    const { engine } = await seed();
    const out = await engine.search({ sortBy: "name", sortDir: "asc" });
    expect(ids(out)).toEqual([
      "samples/d", // Airy Vocal Chop
      "samples/h", // Deep House Loop
      "samples/c", // Deep Sub Bass
      "samples/i", // Deeply Sub
      "samples/a", // Hard Kick 01
      "samples/b", // Soft Snare
      "samples/g", // Warm Pad
    ]);
  });

  it("sorts by analyzedAt ascending", async () => {
    const { engine } = await seed();
    const out = await engine.search({ sortBy: "analyzedAt", sortDir: "asc" });
    expect(ids(out)).toEqual([
      "samples/a",
      "samples/b",
      "samples/c",
      "samples/d",
      "samples/g",
      "samples/h",
      "samples/i",
    ]);
  });

  it("sorts by relevance, blending text strength with confidence", async () => {
    const { engine } = await seed();
    const out = await engine.search({ text: "deep", sortBy: "relevance" });
    // c "Deep Sub Bass": exact token -> high text score + conf 0.95
    // h "Deep House Loop": exact token, conf 0.3
    // i "Deeply Sub": prefix token ("deep" ~ "deeply"), conf 0.4
    expect(ids(out)).toEqual(["samples/c", "samples/h", "samples/i"]);
    expect(out[0].score).toBeGreaterThan(out[1].score);
    expect(out[1].score).toBeGreaterThan(out[2].score);
  });

  it("applies a result limit", async () => {
    const { engine } = await seed();
    const out = await engine.search({ sortBy: "confidence", limit: 3 });
    expect(ids(out)).toEqual(["samples/c", "samples/a", "samples/d"]);
    expect(out.length).toBe(3);
  });

  it("excludes gone samples by default but returns them when requested", async () => {
    const { engine } = await seed();
    expect(ids(await engine.search({ text: "broken" }))).toEqual([]);
    const gone = await engine.search({ statuses: ["gone"] });
    expect(ids(gone)).toEqual(["samples/e"]);
  });

  it("only reads the index and never mutates it", async () => {
    const { engine, index } = await seed();
    const before = (await index.getAll()).map((r) => JSON.stringify(r));
    const search1 = await engine.search({ text: "pad" });
    const search2 = await engine.search({ text: "pad" });
    const after = (await index.getAll()).map((r) => JSON.stringify(r));
    expect(ids(search1).sort()).toEqual(["samples/g"]);
    expect(after).toEqual(before);
    expect(await index.count()).toBe(before.length);
    // The engine itself is read-only: identical (unchanged) input -> unchanged output.
    expect(search1).toEqual(search2);
  });

  it("is deterministic: identical query yields identical results", async () => {
    const { engine } = await seed();
    const q = { text: "deep", sortBy: "relevance" } as const;
    const out1 = await engine.search(q);
    const out2 = await engine.search(q);
    expect(out1).toEqual(out2);
  });
});
