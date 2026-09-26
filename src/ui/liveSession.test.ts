import { describe, it, expect, vi } from "vitest";
import type { AudiotoolClient } from "@audiotool/nexus";
import { pickFirstProject, openFirstProject } from "./liveSession";

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
