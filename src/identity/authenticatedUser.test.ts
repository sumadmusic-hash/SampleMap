/**
 * STEP64 — identity adapter regression tests.
 *
 * Covers the WHOAMI fast path (canonical `users/{slug}` from the OAuth/`GetWhoami`
 * boot is returned WITHOUT any client call) and the preserved legacy fallback
 * (project crawl + display-name route) for every non-canonical input.
 */
import { describe, it, expect, vi } from "vitest";
import {
  isCanonicalUserResource,
  resolveAuthenticatedUserId,
} from "./authenticatedUser";

interface FakeProject {
  name: string;
  userNames: string[];
  creatorName: string;
}
interface FakeUser {
  name: string;
  displayName: string;
}
type FakeProjectsResponse = { projects?: FakeProject[]; nextPageToken?: string };
type FakeUsersResponse = { users?: FakeUser[]; nextPageToken?: string };

interface Calls {
  listProjects: number;
  listUsers: number;
}

/** Fake identity client factory. Throws are surfaced by the adapter's guards. */
function fakeIdentityClient(opts: {
  projects?: (pageToken?: string) => Promise<FakeProjectsResponse> | Promise<Error>;
  users?: (filter?: string) => Promise<FakeUsersResponse>;
  calls?: Calls;
}): unknown {
  const calls: Calls = opts.calls ?? { listProjects: 0, listUsers: 0 };
  return {
    projects: {
      listProjects: vi.fn(async (req: { pageToken?: string }) => {
        calls.listProjects++;
        if (opts.projects) return opts.projects(req?.pageToken);
        return { projects: [], nextPageToken: undefined };
      }),
    },
    users: {
      listUsers: vi.fn(async (req: { filter?: string }) => {
        calls.listUsers++;
        if (opts.users) return opts.users(req?.filter);
        return { users: [], nextPageToken: undefined };
      }),
    },
  };
}

const soleProject = (name: string, member: string): FakeProject => ({
  name,
  userNames: [member],
  creatorName: member,
});
const multiMemberProject = (name: string, members: string[]): FakeProject => ({
  name,
  userNames: members,
  creatorName: members[0],
});

describe("isCanonicalUserResource (STEP64)", () => {
  it("accepts the exact users/{slug} form GetWhoami returns", () => {
    expect(isCanonicalUserResource("users/sumad")).toBe(true);
    expect(isCanonicalUserResource("users/alice")).toBe(true);
  });
  it("rejects display names, bare slugs, empty and non-strings", () => {
    expect(isCanonicalUserResource("sumad")).toBe(false);
    expect(isCanonicalUserResource("Unknown User")).toBe(false);
    expect(isCanonicalUserResource("users/")).toBe(false);
    expect(isCanonicalUserResource("")).toBe(false);
    expect(isCanonicalUserResource(undefined)).toBe(false);
    expect(isCanonicalUserResource(null as unknown as string)).toBe(false);
  });
});

describe("resolveAuthenticatedUserId — WHOAMI fast path (STEP64)", () => {
  it("returns the canonical whoami value directly and makes ZERO client calls", async () => {
    const calls: Calls = { listProjects: 0, listUsers: 0 };
    // Any adapter reaching the client here would explode the fake; we must
    // never touch the network on the canonical path.
    const client = fakeIdentityClient({
      projects: async () => {
        throw new Error("fast path must not call projects");
      },
      users: async () => {
        throw new Error("fast path must not call users");
      },
      calls,
    });
    const id = await resolveAuthenticatedUserId(
      client as Parameters<typeof resolveAuthenticatedUserId>[0],
      "users/sumad",
    );
    expect(id).toBe("users/sumad");
    expect(calls.listProjects).toBe(0);
    expect(calls.listUsers).toBe(0);
  });
});

describe("resolveAuthenticatedUserId — legacy fallback (STEP62, unchanged)", () => {
  it("falls back to the project crawl for a bare display name / non-canonical input", async () => {
    const calls: Calls = { listProjects: 0, listUsers: 0 };
    const client = fakeIdentityClient({
      projects: async () => ({
        projects: [soleProject("projects/a", "users/sumad")],
        nextPageToken: undefined,
      }),
      users: async () => ({ users: [] }),
      calls,
    });
    const id = await resolveAuthenticatedUserId(
      client as Parameters<typeof resolveAuthenticatedUserId>[0],
      "sumad",
    );
    expect(id).toBe("users/sumad");
    expect(calls.listProjects).toBe(1);
    expect(calls.listUsers).toBe(1);
  });

  it("falls back for undefined OAuth identity", async () => {
    const calls: Calls = { listProjects: 0, listUsers: 0 };
    const client = fakeIdentityClient({
      projects: async () => ({
        projects: [soleProject("projects/a", "users/legacy")],
      }),
      users: async () => ({ users: [] }),
      calls,
    });
    const id = await resolveAuthenticatedUserId(
      client as Parameters<typeof resolveAuthenticatedUserId>[0],
      undefined,
    );
    expect(id).toBe("users/legacy");
    expect(calls.listProjects).toBe(1);
  });

  it("falls back for a display name that matches no canonical user (project crawl resolves)", async () => {
    const calls: Calls = { listProjects: 0, listUsers: 0 };
    const client = fakeIdentityClient({
      projects: async () => ({
        projects: [
          multiMemberProject("projects/shared", ["users/a", "users/b"]),
          soleProject("projects/own", "users/sumad"),
        ],
        nextPageToken: undefined,
      }),
      users: async () => ({ users: [] }),
      calls,
    });
    const id = await resolveAuthenticatedUserId(
      client as Parameters<typeof resolveAuthenticatedUserId>[0],
      "Unknown User",
    );
    expect(id).toBe("users/sumad");
  });

  it("returns undefined when NO project yields a unique sole-member candidate", async () => {
    const calls: Calls = { listProjects: 0, listUsers: 0 };
    const client = fakeIdentityClient({
      projects: async () => ({
        projects: [multiMemberProject("projects/shared", ["users/a", "users/b"])],
        nextPageToken: undefined,
      }),
      users: async () => ({ users: [] }),
      calls,
    });
    const id = await resolveAuthenticatedUserId(
      client as Parameters<typeof resolveAuthenticatedUserId>[0],
      undefined,
    );
    expect(id).toBeUndefined();
  });

  it("returns undefined on a project-list error (adapter is safe-by-default)", async () => {
    const calls: Calls = { listProjects: 0, listUsers: 0 };
    const client = fakeIdentityClient({
      projects: async () => new Error("boom"),
      users: async () => ({ users: [] }),
      calls,
    });
    const id = await resolveAuthenticatedUserId(
      client as Parameters<typeof resolveAuthenticatedUserId>[0],
      undefined,
    );
    expect(id).toBeUndefined();
  });

  it("keeps pagination agreement: candidates across pages must agree", async () => {
    const calls: Calls = { listProjects: 0, listUsers: 0 };
    let page = 0;
    const client = fakeIdentityClient({
      projects: async () => {
        page++;
        return {
          projects:
            page === 1
              ? [soleProject("projects/a", "users/x")]
              : [soleProject("projects/b", "users/y")],
          nextPageToken: page === 1 ? "tok" : undefined,
        };
      },
      users: async () => ({ users: [] }),
      calls,
    });
    const id = await resolveAuthenticatedUserId(
      client as Parameters<typeof resolveAuthenticatedUserId>[0],
      undefined,
    );
    // Two different sole-member candidates → ambiguous → undefined.
    expect(id).toBeUndefined();
    expect(calls.listProjects).toBe(2);
  });

  it("uses the display-name route as fallback when the display name maps uniquely", async () => {
    const calls: Calls = { listProjects: 0, listUsers: 0 };
    const client = fakeIdentityClient({
      projects: async () => ({ projects: [] }),
      users: async () => ({
        users: [{ name: "users/sumad", displayName: "Sumad" }],
      }),
      calls,
    });
    const id = await resolveAuthenticatedUserId(
      client as Parameters<typeof resolveAuthenticatedUserId>[0],
      "Sumad",
    );
    expect(id).toBe("users/sumad");
  });

  it("keeps the cross-check: projects and display-name disagree → identity unavailable", async () => {
    const calls: Calls = { listProjects: 0, listUsers: 0 };
    const client = fakeIdentityClient({
      projects: async () => ({
        projects: [soleProject("projects/a", "users/sumad")],
      }),
      users: async () => ({
        users: [{ name: "users/other", displayName: "Sumad" }],
      }),
      calls,
    });
    const id = await resolveAuthenticatedUserId(
      client as Parameters<typeof resolveAuthenticatedUserId>[0],
      "Sumad",
    );
    expect(id).toBeUndefined();
  });
});