/**
 * STEP38 — Authenticated Audiotool identity adapter.
 * STEP62 — hardened: prefers a stable project-membership route, keeps the
 * display-name route as fallback, and cross-checks both when both signal.
 * STEP64 — OAuth whoami fast path: the browser/SDK auth boot ALREADY returns
 * the authenticated principal's stable resource id (`users/{slug}`) via
 * `AuthService/GetWhoami` (measured identical to the project-crawl result:
 * `users/sumad` == `users/sumad`). That authoritative value is used directly,
 * removing the full project crawl (~25 entries/RPC, every page, every reload)
 * from the startup critical path. The STEP62 projects + display-name routes are
 * preserved UNCHANGED as the fallback whenever the whoami value is absent or
 * not a canonical `users/{slug}` resource name.
 *
 * Analysis eligibility is user-relative: OWN samples (stable account id
 * `users/{slug}`, NOT the display name) are always eligible. Two independent
 * sources can yield that stable id from the existing Nexus SDK:
 *
 *   - PROJECTS (STEP62, preferred): `projects.listProjects` returns only
 *     projects where the caller has a role, and both `project.creatorName` and
 *     `project.userNames[]` are stable `users/{slug}` resource names. A
 *     SOLE-MEMBER project (`userNames.length === 1`) can only be listed when
 *     the caller IS that member, so its member is the authenticated user.
 *     Defense-in-depth: the caller must also be the `creatorName`, and every
 *     candidate across pages must agree — any ambiguity ⇒ unresolved.
 *   - DISPLAY NAME (fallback): the live browser client exposes
 *     `userName` (a display name), resolved to the stable id via ONE bounded
 *     `users.listUsers` CEL lookup on `user.display_name`, requiring an exact,
 *     unique match.
 *
 * When both routes answer, they MUST AGREE; a disagreement means the signals
 * contradict and the identity is treated as UNAVAILABLE (never claims own).
 *
 * Design rules:
 *   - Deterministic + bounded: at most ONE project tokens chain (fully
 *     paginated, same-page-safety) + exactly ONE `listUsers` request (never N
 *     guessing queries, never a crawl).
 *   - Safe-by-default: returns `undefined` when no route yields an identity.
 *     An unresolved identity means "own detection unavailable" — eligibility
 *     then evaluates every sample under FOREIGN rules and can never wrongly
 *     promote a foreign sample to own (§5).
 *   - PURE adapter boundary: it only produces a `users/{slug}` id. The
 *     comparison logic (which and whether a sample is own/eligible) lives in
 *     `src/analysis/eligibility.ts`.
 */
import type { AudiotoolClient } from "@audiotool/nexus";

/** The minimum surface this adapter needs (testable with a fake client). */
export type UserLookupClient = Pick<AudiotoolClient, "users">;

/** STEP62 — projects route additionally needs the projects service. */
export type IdentityClient = Pick<AudiotoolClient, "users" | "projects">;

const USER_RESOURCE_PREFIX = "users/";

/**
 * STEP64 — true iff `userName` is the canonical stable account resource name
 * `users/{slug}` (the exact form the auth `GetWhoami` RPC returns and the form
 * sample `ownerName` uses). Anything else (display names, `"Unknown User"`,
 * bare slugs, empty) is NOT authoritative and must take the legacy resolution
 * path.
 */
export function isCanonicalUserResource(
  userName: string | undefined,
): userName is string {
  return (
    typeof userName === "string" &&
    userName.length > USER_RESOURCE_PREFIX.length &&
    userName.startsWith(USER_RESOURCE_PREFIX)
  );
}

/** Escape a value into a safe single-argument CEL string literal. */
export function quoteDisplayName(displayName: string): string {
  return JSON.stringify(displayName);
}

/**
 * Resolve the authenticated user's stable account id (`users/{slug}`) via
 * project membership: any project the caller can list contains them in
 * `userNames`, so a project with exactly ONE member must be theirs. Requires
 * the sole member to also be the `creatorName` (defense-in-depth) and all
 * page-level candidates to agree. Returns `undefined` on ambiguity/error.
 */
export async function resolveAuthenticatedUserIdFromProjects(
  client: Pick<AudiotoolClient, "projects">,
): Promise<string | undefined> {
  const candidates = new Set<string>();
  let pageToken: string | undefined;
  try {
    do {
      const res = await client.projects.listProjects({ pageSize: 25, pageToken });
      if (res instanceof Error) return undefined;
      const projects = res.projects ?? [];
      for (const p of projects) {
        const members: string[] = p.userNames ?? [];
        const member = members.length === 1 ? members[0] : undefined;
        if (
          member !== undefined &&
          member.startsWith(USER_RESOURCE_PREFIX) &&
          p.creatorName === member
        ) {
          candidates.add(member);
        }
      }
      if (projects.length === 0) break;
      pageToken = res.nextPageToken || undefined;
    } while (pageToken);
  } catch {
    return undefined;
  }
  if (candidates.size !== 1) return undefined;
  return [...candidates][0];
}

/**
 * Resolve the authenticated user's stable account id (`users/{slug}`) from
 * their display name via `users.listUsers`. Returns `undefined` whenever the
 * identity is ambiguous or unavailable (never throws).
 */
async function resolveViaDisplayName(
  client: UserLookupClient,
  userName: string | undefined,
): Promise<string | undefined> {
  if (userName === undefined || userName.trim().length === 0) return undefined;

  let response;
  try {
    response = await client.users.listUsers({
      filter: `user.display_name == ${quoteDisplayName(userName)}`,
      pageSize: 2,
    });
  } catch {
    return undefined;
  }

  if (response instanceof Error) return undefined;
  const users = response?.users;
  if (!users || users.length !== 1) return undefined;

  const account = users[0];
  if (!account) return undefined;
  if (account.displayName !== userName) return undefined;
  if (typeof account.name !== "string" || !account.name.startsWith(USER_RESOURCE_PREFIX)) {
    return undefined;
  }
  return account.name;
}

/**
 * Resolve the authenticated user's stable account id (`users/{slug}`), or
 * `undefined` when no reliable identity exists. Combination rule: when BOTH
 * legacy routes produce an id they must agree exactly; when only one answers,
 * that one is used; when none answers, identity stays UNAVAILABLE. Never throws.
 *
 * STEP64 — fast path: a canonical OAuth `users/{slug}` (`GetWhoami`) value is
 * authoritative and returned immediately (no network). The legacy routes run
 * ONLY when that value is absent or not canonical.
 */
export async function resolveAuthenticatedUserId(
  client: IdentityClient,
  userName: string | undefined,
): Promise<string | undefined> {
  if (isCanonicalUserResource(userName)) {
    // STEP64 — OAuth whoami authoritative identity: no crawl, no listUsers.
    return userName;
  }
  const viaProjects = await resolveAuthenticatedUserIdFromProjects(client);
  const viaDisplayName = await resolveViaDisplayName(client, userName);
  if (viaProjects !== undefined && viaDisplayName !== undefined) {
    return viaProjects === viaDisplayName ? viaProjects : undefined;
  }
  return viaProjects ?? viaDisplayName;
}
