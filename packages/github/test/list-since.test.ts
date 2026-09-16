/**
 * `listIssuesSince`, with GitHub stubbed (`#137`).
 *
 * The ticket store reads *not listed* as *does not exist* and opens an issue,
 * so the property is completeness: every issue created in the window is
 * listed however many older issues were touched in it, and a listing that
 * cannot be complete throws rather than answering short.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "../src/index.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const since = new Date("2026-09-10T12:00:00Z");

interface Raw {
  number: number;
  created_at: string;
  updated_at: string;
}

/**
 * A repository whose issues are `raw`, answering the listing endpoint the way
 * GitHub does: filtered by `updated_at >= since`, sorted and paged as asked.
 */
function stubRepo(raw: Raw[]) {
  const pages: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/access_tokens")) {
      return Response.json({ token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    }
    pages.push(url.search);
    const q = url.searchParams;
    const floor = Date.parse(q.get("since")!);
    const dir = q.get("direction") === "asc" ? 1 : -1;
    const per = Number(q.get("per_page"));
    const page = Number(q.get("page"));
    const listed = raw
      .filter((r) => Date.parse(r.updated_at) >= floor)
      .sort((a, b) => dir * (Date.parse(a.created_at) - Date.parse(b.created_at)))
      .slice((page - 1) * per, page * per)
      .map((r) => ({ ...r, title: `#${r.number}`, body: "", labels: [], state: "open", html_url: `https://x/${r.number}` }));
    return Response.json(listed);
  });
  return pages;
}

const client = () =>
  createGitHubClient({
    auth: { appId: "1", privateKey },
    owner: "o",
    repo: "r",
    installation: { id: 1, permissions: {}, account: "o", repositorySelection: "selected", htmlUrl: null },
  });

const at = (minutes: number) => new Date(since.getTime() + minutes * 60_000).toISOString();

describe("listIssuesSince", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists an issue created in the window when more than a thousand older issues were updated in it", async () => {
    // 1,500 old issues commented on and relabelled since, and the one that matters.
    const old = Array.from({ length: 1500 }, (_, i) => ({ number: i + 1, created_at: at(-100_000 + i), updated_at: at(30) }));
    const pages = stubRepo([...old, { number: 1900, created_at: at(60), updated_at: at(60) }]);
    const issues = await (await client()).listIssuesSince(since);
    expect(issues.map((i) => i.number)).toEqual([1900]);
    // And it stopped at the window's edge rather than paging through the old ones.
    expect(pages).toHaveLength(1);
  });

  it("lists every issue created in the window across pages, oldest first", async () => {
    const recent = Array.from({ length: 250 }, (_, i) => ({ number: i + 1, created_at: at(i), updated_at: at(i) }));
    stubRepo(recent);
    const listed = await (await client()).listIssuesSince(since);
    expect(listed.map((i) => i.number)).toEqual(recent.map((r) => r.number));
  });

  it("throws rather than answering short when the window is larger than it will page", async () => {
    const recent = Array.from({ length: 5100 }, (_, i) => ({ number: i + 1, created_at: at(i), updated_at: at(i) }));
    stubRepo(recent);
    await expect((await client()).listIssuesSince(since)).rejects.toThrow(/incomplete/);
  });
});
