/**
 * What an issue carries off the wire.
 *
 * The HTTP is stubbed — the behaviour under test is the *mapping*, and a typo
 * in a field name there is the one failure this whole seam can have. It would
 * not throw and it would not be slow: `issue_dependencies_summary` would simply
 * read as absent, every ticket would look clear, and the queue would go back to
 * taking a dependent one first with nothing to see (#131). That is a check
 * present, reported, and not looking at the thing you think it is — which is
 * `#58`, and is why this asserts on the key GitHub actually sends.
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
    // repository's: `runnableNow` is what decides the pass ran blind.
    expect(issues[1]!.dependencies).toEqual({ blockedBy: 0, totalBlockedBy: 0 });
  });

  it("refuses a summary that is not two numbers rather than repairing it", async () => {
    stub([raw({ number: 126, issue_dependencies_summary: { blocking: 0, total_blocking: 0 } })]);

    expect((await (await client()).listOpenIssues())[0]!.dependencies).toBeNull();
  });
});
