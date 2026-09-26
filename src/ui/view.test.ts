import { describe, it, expect } from "vitest";
import { makeSample } from "../persistence/test-helpers";
import {
  detailView,
  detailMapPosition,
  mapPositionLabel,
  scanStatusLabel,
  analysisProgressLabels,
  resultView,
  durationLabel,
  classFilterOptions,
  SORT_OPTIONS,
  ANALYSIS_BUDGETS,
  hasActiveSearch,
  activeFilterCount,
  activeFilterSummary,
  sortLabel,
  emptyStateMessage,
  resultCountLabel,
  NO_ANALYZED_MESSAGE,
  NO_MATCH_MESSAGE,
  selectionCountLabel,
  selectionPillLabel,
  SEND_PANEL_HINT,
  shouldShowFirstUse,
} from "./view";

describe("SampleMap view : tags vs classification (INV-2)", () => {
  it("classification block is derived only from primaryClass/confidence/secondaryClasses", () => {
    const rec = makeSample("samples/a", {
      primaryClass: "kick",
      confidence: 0.93,
      secondaryClasses: [
        { class: "toms", confidence: 0.06 },
        { class: "snare", confidence: 0.01 },
      ],
      originalTags: ["pierre", "drum", "my-kick"], // unrelated textual metadata
    });
    const view = detailView(rec);
    expect(view.classification).toEqual({
      primaryClass: "kick",
      confidence: 0.93,
      secondaryClasses: [
        { class: "toms", confidence: 0.06 },
        { class: "snare", confidence: 0.01 },
      ],
    });
    // Tags never leak into the classification block.
    expect(view.classification.primaryClass).not.toBe("pierre");
    expect(view.classification).not.toHaveProperty("originalTags");
    // Tags are exposed separately.
    expect(view.originalTags).toEqual(["pierre", "drum", "my-kick"]);
  });

  it("result view keeps original tags distinct from the class label", () => {
    const rec = makeSample("samples/a", {
      primaryClass: "kick",
      originalTags: ["pierre"],
    });
    const view = resultView(rec);
    expect(view.primaryClass).toBe("kick");
    expect(view.originalTags).toEqual(["pierre"]);
    // secondary label is built from secondary classes, not tags.
    expect(view.secondaryLabel).toBe("toms");
  });
});

describe("SampleMap view : detail + result projection", () => {
  it("detail view carries name/owner/kind and only real feature fields", () => {
    const rec = makeSample("samples/a");
    const view = detailView(rec);
    expect(view.name).toBe("Hard Kick 01");
    expect(view.owner).toBe("alice");
    expect(view.kind).toBe("kick");
    expect(view.durationSeconds).toBe(0.4);
    expect(view.sampleRate).toBe(44100);
    expect(view.channels).toBe(2);
    expect(view.features).toMatchObject({
      rms: 0.2,
      peak: 0.9,
      spectralCentroid: 1200,
    });
    // Unknown/non-numeric fields are dropped, not invented.
    expect(view.features).not.toHaveProperty("bogusField");
  });

  it("detail view handles a record with no audio features gracefully", () => {
    const view = detailView(makeSample("samples/a", { audioFeatures: undefined }));
    expect(view.durationSeconds).toBe(0);
    expect(view.sampleRate).toBe(0);
    expect(view.features).toEqual({});
  });

  it("result view formats a semicolon-free secondary label and duration", () => {
    const view = resultView(makeSample("samples/a"));
    expect(view.secondaryLabel).toBe("toms");
    expect(view.durationLabel).toBe("0.40s");
    expect(view.status).toBe("analyzed");
  });
});

describe("SampleMap view : metadata slice (musical + community projection)", () => {
  it("projects bpm/numFavorites/numUsages from the record verbatim", () => {
    const view = detailView(
      makeSample("samples/a", {
        bpm: 128,
        numFavorites: 42,
        numUsages: 187,
      }),
    );
    expect(view.musical.bpm).toBe(128);
    expect(view.community.numFavorites).toBe(42);
    expect(view.community.numUsages).toBe(187);
  });

  it("bpm 0 is preserved raw in the view (rendered as — by the inspector)", () => {
    const view = detailView(makeSample("samples/a", { bpm: 0 }));
    expect(view.musical.bpm).toBe(0);
  });

  it("legacy records without the slice project nulls (never fabricated)", () => {
    const view = detailView(makeSample("samples/a"));
    expect(view.musical.bpm).toBeNull();
    expect(view.community.numFavorites).toBeNull();
    expect(view.community.numUsages).toBeNull();
  });

  it("exposes NO rating / popularity / quality score anywhere in the metadata blocks", () => {
    const view = detailView(
      makeSample("samples/a", {
        bpm: 128,
        numFavorites: 42,
        numUsages: 187,
      }),
    );
    expect(view.musical).not.toHaveProperty("rating");
    expect(view.musical).not.toHaveProperty("popularity");
    expect(view.musical).not.toHaveProperty("qualityScore");
    expect(view.community).not.toHaveProperty("rating");
    expect(view.community).not.toHaveProperty("popularityScore");
    expect(view.community).not.toHaveProperty("stars");
    // Raw counters only — never folded into confidence/relevance projection.
    expect(view.classification.confidence).toBe(0.9);
    expect(view.community.numFavorites).toBe(42);
    expect(view.community.numUsages).toBe(187);
  });
});

describe("SampleMap view : duration label + budget/taxonomy options", () => {
  it("formats durations deterministically", () => {
    expect(durationLabel(0)).toBe("0.00s");
    expect(durationLabel(0.82)).toBe("0.82s");
    expect(durationLabel(3)).toBe("3.00s");
    expect(durationLabel(NaN)).toBe("?s");
    expect(durationLabel(Infinity)).toBe("?s");
  });

  it("class filter options come from the taxonomy, not invented", () => {
    const opts = classFilterOptions();
    expect(opts.all.label).toBe("All");
    expect(opts.groups.map((g) => g.id)).toEqual(["drums", "musical", "other"]);
    const drums = opts.groups.find((g) => g.id === "drums")!;
    expect(drums.classes.length).toBeGreaterThan(0);
    // Every listed class is part of the flat taxonomy class list.
    for (const c of opts.classes) expect(opts.classes).toContain(c);
  });

  it("only the three controlled budgets are exposed (INV-3)", () => {
    expect(ANALYSIS_BUDGETS).toEqual([10, 100, 1000]);
  });

  it("sort options match the SearchEngine surface", () => {
    expect(SORT_OPTIONS.map((s) => s.id)).toEqual(["relevance", "confidence", "name", "analyzedAt"]);
  });
});

describe("SampleMap view : Step 15D search/filter projection", () => {
  it("hasActiveSearch detects each criterion", () => {
    expect(hasActiveSearch({ text: "", classes: [], minConfidence: undefined })).toBe(false);
    expect(hasActiveSearch({ text: "  ", classes: [], minConfidence: undefined })).toBe(false);
    expect(hasActiveSearch({ text: "808", classes: [], minConfidence: undefined })).toBe(true);
    expect(hasActiveSearch({ text: "", classes: ["kick"], minConfidence: undefined })).toBe(true);
    expect(hasActiveSearch({ text: "", classes: [], minConfidence: 0.5 })).toBe(true);
  });

  it("distinguishes the two Step-15D empty states", () => {
    // No filter -> "not analyzed yet"; active filter -> "no match".
    expect(emptyStateMessage(false)).toBe(NO_ANALYZED_MESSAGE);
    expect(emptyStateMessage(true)).toBe(NO_MATCH_MESSAGE);
    expect(NO_ANALYZED_MESSAGE).toBe("No analyzed samples yet.");
    expect(NO_MATCH_MESSAGE).toBe("No samples match your search.");
    expect(NO_ANALYZED_MESSAGE).not.toBe(NO_MATCH_MESSAGE);
  });

  it("formats a count label from the current results", () => {
    expect(resultCountLabel(0)).toBe("0 samples");
    expect(resultCountLabel(1)).toBe("1 sample");
    expect(resultCountLabel(127)).toBe("127 samples");
  });
});

describe("SampleMap view : Step 15E inspector", () => {
  it("detailView carries classification WITHOUT tags leaking in (INV-2)", () => {
    const rec = makeSample("samples/a", {
      originalTags: ["808", "kick", "analog"],
    });
    const d = detailView(rec);
    // Classification block from primaryClass/confidence/secondary only.
    expect(d.classification.primaryClass).toBe("kick");
    expect(d.classification).not.toHaveProperty("originalTags");
    expect(d.originalTags).toEqual(["808", "kick", "analog"]);
  });

  it("detailMapPosition returns the persisted V2 mapPosition only", () => {
    const rec = makeSample("samples/a", { mapPosition: { x: 0.4, y: 0.6 } });
    const pos = detailMapPosition(rec);
    expect(pos).toEqual({ x: 0.4, y: 0.6 });
  });

  it("detailMapPosition is undefined without a persisted mapPosition (Missing-V2)", () => {
    expect(detailMapPosition(makeSample("samples/a", { mapPosition: undefined }))).toBeUndefined();
  });
});

describe("SampleMap view : STEP16R E-P2 canonical copy projections", () => {
  it("mapPositionLabel renders the frozen Missing-V2 string exactly (DECISION #15)", () => {
    expect(mapPositionLabel(undefined)).toBe("Map position unavailable");
  });

  it("mapPositionLabel renders persisted V2 coordinates at 3 decimals (never recomputed)", () => {
    expect(mapPositionLabel({ x: 0.1, y: 0.2 })).toBe("X: 0.100  Y: 0.200");
    expect(mapPositionLabel({ x: 0.6556, y: 0.5398 })).toBe("X: 0.656  Y: 0.540");
  });

  it("analysis progress labels are final English product copy (no dev/German strings)", () => {
    expect(analysisProgressLabels({ analyzed: 4, failed: 0 }, 6)).toEqual({
      analyzed: "Analyzed: 4",
      failed: "Failed: 0",
      remaining: "Remaining: 6",
    });
    expect(analysisProgressLabels({ analyzed: 2, failed: 1 }, undefined)).toEqual({
      analyzed: "Analyzed: 2",
      failed: "Failed: 1",
      remaining: "Remaining: —",
    });
  });

  it("scan status labels surface human English states, never raw state names", () => {
    expect(scanStatusLabel("idle")).toBe("Idle");
    expect(scanStatusLabel("scanning")).toBe("Scanning");
    expect(scanStatusLabel("done")).toBe("Complete");
    expect(scanStatusLabel("error")).toBe("Failed");
  });
});

describe("SampleMap view : FINAL UI v1.1 action-bar selection projections", () => {
  it("selectionCountLabel states the cap on the single count surface (E-P3)", () => {
    expect(selectionCountLabel(0)).toBe("No samples selected");
    expect(selectionCountLabel(1)).toBe("1 of 8 selected");
    expect(selectionCountLabel(7)).toBe("7 of 8 selected");
    expect(selectionCountLabel(8)).toBe("8 of 8 selected (limit reached)");
    // Overshoot beyond the cap still reads as the full batch (clamped).
    expect(selectionCountLabel(20)).toBe("8 of 8 selected (limit reached)");
    expect(selectionCountLabel(0, 4)).toBe("No samples selected");
    expect(selectionCountLabel(4, 4)).toBe("4 of 4 selected (limit reached)");
  });

  it("selectionPillLabel shows a clamped N / 8 that can never overshoot the cap", () => {
    expect(selectionPillLabel(0)).toBe("0 / 8");
    expect(selectionPillLabel(1)).toBe("1 / 8");
    expect(selectionPillLabel(3)).toBe("3 / 8");
    expect(selectionPillLabel(7)).toBe("7 / 8");
    expect(selectionPillLabel(8)).toBe("8 / 8");
    // Overshoot + negatives clamp (spec §18.2: attempts are rejected, count
    // text must never display > 8).
    expect(selectionPillLabel(12)).toBe("8 / 8");
    expect(selectionPillLabel(-2)).toBe("0 / 8");
    expect(selectionPillLabel(4.9)).toBe("4 / 8");
  });

  describe("SampleMap view : STEP16R E-P3 selection/send polish projections", () => {
    it("SEND_PANEL_HINT is concise product copy with no German/dev tokens", () => {
      expect(SEND_PANEL_HINT).toBe(
        "The id must match an existing Machiniste; slots are numbered from the starting slot upward.",
      );
      expect(SEND_PANEL_HINT).not.toMatch(/Analysiert|Fehler|Verbleibend|DEBUG|TODO|XXX/i);
      expect(SEND_PANEL_HINT.length).toBeLessThan(160);
    });

    it("selectionCountLabel fills every boundary explicitly (0/1/7/8)", () => {
      const labels = [0, 1, 7, 8].map((n) => selectionCountLabel(n));
      expect(labels).toEqual([
        "No samples selected",
        "1 of 8 selected",
        "7 of 8 selected",
        "8 of 8 selected (limit reached)",
      ]);
    });
  });

  it("shouldShowFirstUse only in the true first-use state", () => {
    // Nothing indexed, no filter, scan untouched.
    expect(shouldShowFirstUse(0, "idle", false)).toBe(true);
    // Results exist -> ready state, no overlay.
    expect(shouldShowFirstUse(3, "idle", false)).toBe(false);
    // Active filter -> this is a matching empty state, not first use.
    expect(shouldShowFirstUse(0, "idle", true)).toBe(false);
    // Scan has run (or errored) -> not first use.
    expect(shouldShowFirstUse(0, "done", false)).toBe(false);
    expect(shouldShowFirstUse(0, "scanning", false)).toBe(false);
    expect(shouldShowFirstUse(0, "error", false)).toBe(false);
  });
});

describe("SampleMap view : STEP16R E-P4 structured filter projections", () => {
  const none = { text: "", classes: [], minConfidence: undefined };

  it("default filter state: no criteria active, empty summary", () => {
    expect(activeFilterCount(none)).toBe(0);
    expect(activeFilterSummary(none)).toBe("");
    expect(hasActiveSearch(none)).toBe(false);
    expect(activeFilterCount({ text: "  ", classes: [], minConfidence: undefined })).toBe(0);
  });

  it("active class label distinguishes a class token from a group token", () => {
    expect(activeFilterCount({ text: "", classes: ["kick"], minConfidence: undefined })).toBe(1);
    expect(activeFilterSummary({ text: "", classes: ["kick"], minConfidence: undefined })).toBe(
      "Class: kick",
    );
    expect(activeFilterSummary({ text: "", classes: ["drums"], minConfidence: undefined })).toBe(
      "Group: Drums",
    );
  });

  it("active confidence label shows the actual threshold value", () => {
    const st = { text: "", classes: [], minConfidence: 0.6 };
    expect(activeFilterCount(st)).toBe(1);
    expect(activeFilterSummary(st)).toBe("Confidence ≥ 0.6");
  });

  it("combined criteria count together and summarize in a stable order", () => {
    const st = { text: "808", classes: ["kick"], minConfidence: 0.65 };
    expect(activeFilterCount(st)).toBe(3);
    expect(activeFilterSummary(st)).toBe(
      'Query: "808" · Class: kick · Confidence ≥ 0.65',
    );
  });

  it("active sort label maps each supported mode deterministically", () => {
    expect(sortLabel("relevance")).toBe("Relevance");
    expect(sortLabel("confidence")).toBe("Confidence");
    expect(sortLabel("name")).toBe("Name");
    expect(sortLabel("analyzedAt")).toBe("Analyzed At");
    expect(sortLabel("unknown")).toBe("unknown");
  });

  it("clear-state projection: resetting the criteria empties summary + count", () => {
    const active = { text: "kick", classes: ["snare"], minConfidence: 0.5 };
    expect(activeFilterSummary(active)).not.toBe("");
    expect(activeFilterCount(active)).toBe(3);
    const cleared = { text: "", classes: [], minConfidence: undefined };
    expect(activeFilterSummary(cleared)).toBe("");
    expect(activeFilterCount(cleared)).toBe(0);
  });

  it("grouped class presentation exposes every existing class exactly once (22)", () => {
    const opts = classFilterOptions();
    const groupLabels = opts.groups.map((g) => g.label);
    expect(groupLabels).toEqual(["Drums", "Musical", "Other"]);
    const inGroups = opts.groups.flatMap((g) => [...g.classes]);
    expect(inGroups).toHaveLength(22);
    expect(new Set(inGroups).size).toBe(22); // no duplicates
    expect(inGroups).toEqual(opts.classes); // groups cover the whole taxonomy
    expect(opts.groups.map((g) => g.id)).toEqual(["drums", "musical", "other"]);
    expect(opts.groups[0].classes).toEqual([
      "kick", "snare", "clap", "hihat", "openhat", "tom", "cymbal", "percussion",
    ]);
    expect(opts.groups[2].classes).toEqual(["vocal", "fx", "atmosphere", "noise", "loop", "other"]);
  });
});
