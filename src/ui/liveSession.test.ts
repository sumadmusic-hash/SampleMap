import { describe, it, expect, vi } from "vitest";
import type { AudiotoolClient } from "@audiotool/nexus";
import {
  pickFirstProject,
  openFirstProject,
  listLiveProjects,
  openLiveProject,
} from "./liveSession";

/** A minimal fake SyncedDocument stub with a recordable start(). */
function fakeDoc() {
  const doc = { started: false, start: null as unknown as () => Promise<void> };
  doc.start = vi.fn(async () => {
    doc.started = true;
  }) as () => Promise<void>;
  return doc;
}

function fakeClient(opts: {
  projects?: Array<{ name: string; displayName?: string }>;
  openError?: boolean;
}) {
  const doc = fakeDoc();
  const client = {
    projects: {
      listProjects: vi.fn(async () => ({ projects: opts.projects ?? [] })),
    },
    open: vi.fn(async () => {
      if (opts.openError) throw new Error("open failed");
      return doc;
    }),
  };
  return { client: client as unknown as AudiotoolClient, doc };
}

describe("liveSession (step 16N glue)", () => {
  it("pickFirstProject returns the first entry that has a name", () => {
    const projects = [
      { name: "", displayName: "Empty" },
      { name: "project-b", displayName: "B" },
    ];
    expect(pickFirstProject(projects)?.name).toBe("project-b");
  });

  it("pickFirstProject returns undefined when nothing has a name", () => {
    expect(pickFirstProject([{ name: "" }])).toBeUndefined();
    expect(pickFirstProject([])).toBeUndefined();
  });

  it("openFirstProject lists, picks, opens and starts the first usable project", async () => {
    const { client, doc } = fakeClient({
      projects: [{ name: "proj-1", displayName: "One" }],
    });
    const result = await openFirstProject(client);
    expect(client.projects.listProjects).toHaveBeenCalledWith({ pageSize: 5 });
    expect(client.open).toHaveBeenCalledWith("proj-1");
    expect(result).toBe(doc);
    expect(doc.started).toBe(true);
  });

  it("openFirstProject returns undefined when the user has no project", async () => {
    const { client } = fakeClient({ projects: [] });
    expect(await openFirstProject(client)).toBeUndefined();
    expect(client.open).not.toHaveBeenCalled();
  });

  it("openFirstProject propagates a project-list / open failure", async () => {
    const { client } = fakeClient({ projects: [{ name: "p" }], openError: true });
    await expect(openFirstProject(client)).rejects.toThrow("open failed");
  });
});

/**
 * STEP85 — the project picker. `openFirstProject` keeps its exact behaviour;
 * the picker adds a list step and an explicitly named open.
 */
describe("liveSession project picker (STEP85)", () => {
  it("listLiveProjects returns every named project from the existing API", async () => {
    const { client } = fakeClient({
      projects: [
        { name: "proj-1", displayName: "One" },
        { name: "proj-2" },
      ],
    });
    const projects = await listLiveProjects(client);
    expect(client.projects.listProjects).toHaveBeenCalledWith({ pageSize: 5 });
    expect(projects.map((p) => p.name)).toEqual(["proj-1", "proj-2"]);
  });

  it("listLiveProjects drops unnamed entries so the picker never offers a blank choice", async () => {
    const { client } = fakeClient({
      projects: [{ name: "", displayName: "Broken" }, { name: "ok" }],
    });
    expect((await listLiveProjects(client)).map((p) => p.name)).toEqual(["ok"]);
  });

  it("listLiveProject returns an empty list instead of throwing on an API error", async () => {
    const client = {
      projects: {
        listProjects: vi.fn(async () => new Error("offline")),
      },
    } as unknown as AudiotoolClient;
    // The picker must degrade to "current project only", never block the mount.
    expect(await listLiveProjects(client)).toEqual([]);
  });

  it("openLiveProject opens and starts the EXACT requested project", async () => {
    const { client, doc } = fakeClient({ projects: [{ name: "proj-1" }] });
    const result = await openLiveProject(client, "proj-2");
    expect(client.open).toHaveBeenCalledWith("proj-2");
    expect(result).toBe(doc);
    expect(doc.started).toBe(true);
  });

  it("openLiveProject never calls open for an empty name", async () => {
    const { client } = fakeClient({ projects: [{ name: "proj-1" }] });
    expect(await openLiveProject(client, "")).toBeUndefined();
    expect(client.open).not.toHaveBeenCalled();
  });

  it("openFirstProject still opens the first project, not a picker-selected one", async () => {
    // Regression guard: the picker refactor must not change the default path.
    const { client, doc } = fakeClient({
      projects: [{ name: "proj-1" }, { name: "proj-2" }],
    });
    expect(await openFirstProject(client)).toBe(doc);
    expect(client.open).toHaveBeenCalledWith("proj-1");
  });
});
