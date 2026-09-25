/**
 * What an issue carries off the wire.
 *
 * The HTTP is stubbed — the behaviour under test is the *mapping* from GitHub's
 * shape to `Issue.dependencies`: two counts read, a missing summary kept as
 * null rather than zeroes, a malformed one refused.
 *
 * **What this cannot catch is the key name itself.** The fixture is written by
 * the same hand as the mapper and spells `issue_dependencies_summary` the same
 * way, so a typo in both would pass here. What catches that is live, not here:
 * a wrong key reads every issue as unsummarised, and `runnableNow` then says
 * `GitHub reported no issue dependencies for this repository` on every pass, in
 * `lingtai status`, in the daemon's log and on the board's Queued column (#131)
 * — loud rather than silent, which is the property this seam is built to have.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient, type AppAuth, type Installation } from "../src/index.ts";

// A real key, because the client signs a JWT before it asks for a token —
// nothing here is about the signing, but it has to succeed for the call to
// reach the stubbed endpoint at all.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const auth: AppAuth = { appId: "123456", privateKey };
const installation: Installation = {
  id: 1,
  permissions: {},
  account: "steven-zhc",
  repositorySelection: "selected",
  htmlUrl: null,
};

/** A raw issue as the REST list endpoint sends one, minus what nothing reads. */
function raw(over: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 1,
    title: "a ticket",
    body: "",
    labels: [{ name: "bug", color: "d73a4a" }],
    state: "open",
    html_url: "https://example.invalid/1",
    issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0, blocking: 0, total_blocking: 0 },
    ...over,
  };
}

/** The token endpoint, then one page of issues. */
function stub(issues: Record<string, unknown>[]) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: "ghs_x", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(issues), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("listOpenIssues", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function client() {
    return createGitHubClient({ auth, owner: "steven-zhc", repo: "lingtai", installation });
  }

  /**
   * Both counts, because they answer different questions. A chain that has not
   * started and a chain whose groundwork has landed are the same single number
   * if you only carry one of them.
   */
  it("reads how many open issues block one, and how many ever did", async () => {
    stub([
      raw({
        number: 123,
        issue_dependencies_summary: {
          blocked_by: 2,
          total_blocked_by: 3,
          blocking: 0,
          total_blocking: 0,
        },
      }),
    ]);

    const [issue] = await (await client()).listOpenIssues();

    expect(issue!.dependencies).toEqual({ blockedBy: 2, totalBlockedBy: 3 });
  });

  /**
   * Null rather than two zeroes. A GitHub that says nothing about dependencies
   * — a plan that does not expose them — must not read as *nothing blocks it*,
   * or every ticket in such a repository would be silently treated as clear.
   */
  it("is null when GitHub sends no summary at all", async () => {
    stub([raw({ number: 124, issue_dependencies_summary: null }), raw({ number: 125 })]);

    const issues = await (await client()).listOpenIssues();

    expect(issues[0]!.dependencies).toBeNull();
    // The second still answers, so one issue's silence is not read as the
    // repository's: `runnableNow` names the issues it is true of.
    expect(issues[1]!.dependencies).toEqual({ blockedBy: 0, totalBlockedBy: 0 });
  });

  it("refuses a summary that is not two numbers rather than repairing it", async () => {
    stub([raw({ number: 126, issue_dependencies_summary: { blocking: 0, total_blocking: 0 } })]);

    expect((await (await client()).listOpenIssues())[0]!.dependencies).toBeNull();
  });

  /**
   * Whose work a ticket is (#181), off the listing a pass already makes. One
   * request for the page and none per issue: a second request per candidate is
   * the cost `issue_dependencies_summary` was chosen to avoid.
   */
  it("reads the assignees off the listing, without a second request", async () => {
    stub([
      raw({ number: 181, assignees: [{ login: "alice" }, { login: "bob" }] }),
      raw({ number: 182, assignees: [] }),
      raw({ number: 183 }),
    ]);
    const answered = globalThis.fetch;
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      asked.push(String(url));
      return answered(url, init);
    });

    const issues = await (await client()).listOpenIssues();

    expect(issues.map((i) => i.assignees)).toEqual([["alice", "bob"], [], []]);
    expect(asked.filter((url) => url.includes("/issues"))).toHaveLength(1);
  });
});

/**
 * **What a sweep is answered with, and what it sends** (`#240`).
 *
 * `refs:` at `end` deletes a landed ticket's `agent/<n>-attempt-<k>` refs, and
 * two facts about this endpoint are the ones the deleting side is written
 * around. They are asserted here, at the seam, because each is a property of
 * GitHub's API rather than of the caller:
 *
 * - **A name comes back as `refs/heads/…` and goes out as `heads/…`.** A
 *   wrapper that answered the first and took the second would make every delete
 *   a 404 on `refs/refs/heads/…`, which is the kind of failure that shows up
 *   only against the live API.
 * - **No match is a 404 and not an empty array.** A ticket that landed before
 *   `#239` published any arm has no refs under its branch at all, and a throw
 *   there would make *nothing to do* read as *GitHub refused*.
 */
describe("the refs a landed ticket leaves", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The token endpoint, then whatever this test wants of the git-refs ones. */
  function stubRefs(answer: (url: string, init?: RequestInit) => Response) {
    const sent: { method: string; url: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_x", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      sent.push({ method: init?.method ?? "GET", url: String(url) });
      return answer(String(url), init);
    });
    return sent;
  }

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  async function client() {
    return createGitHubClient({ auth, owner: "steven-zhc", repo: "lingtai", installation });
  }

  it("answers ref names without the `refs/`, and deletes them under it", async () => {
    const sent = stubRefs((url, init) =>
      (init?.method ?? "GET") === "DELETE"
        ? new Response(null, { status: 204 })
        : json([
            { ref: "refs/heads/agent/240" },
            { ref: "refs/heads/agent/240-attempt-1" },
          ]),
    );
    const gh = await client();

    expect(await gh.matchingRefs("heads/agent/240")).toEqual([
      "heads/agent/240",
      "heads/agent/240-attempt-1",
    ]);

    await gh.deleteRef("heads/agent/240-attempt-1");
    expect(sent.at(-1)).toEqual({
      method: "DELETE",
      url: "https://api.github.com/repos/steven-zhc/lingtai/git/refs/heads/agent/240-attempt-1",
    });
  });

  it("reads a 404 as no ref matches, rather than as a failure", async () => {
    stubRefs(() =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect((await client()).matchingRefs("heads/agent/999")).resolves.toEqual([]);
  });
});
