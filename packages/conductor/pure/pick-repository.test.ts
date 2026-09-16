/**
 * Step 0: picking a repository from what the App can see (#168).
 *
 * No network and no database: the reader is a fake that answers `GET`s from a
 * fixture and **fails any other method**, so every test here is also the test
 * that nothing is written — the assertion #161's proposal carries.
 */
import { describe, expect, it } from "vitest";
import type { ProjectState } from "@lingtai/domain";
import { GitHubError } from "@lingtai/github";
import {
  choose,
  installLink,
  listRepositories,
  setupReturn,
  verifiedInstallation,
} from "../src/pick-repository.ts";

const WRITE = { issues: "write", contents: "write", pull_requests: "write", metadata: "read" };

interface FakeInstallation {
  id: number;
  account: string;
  selection?: "all" | "selected";
  permissions?: Record<string, string>;
  repositories: string[];
}

function fakeReader(installations: FakeInstallation[], suspended: number[] = []) {
  const calls: string[] = [];
  return {
    calls,
    async request<T>(method: string, path: string, as: "app" | number): Promise<T> {
      calls.push(`${method} ${path} as ${as}`);
      if (method !== "GET") throw new Error(`the picker wrote to GitHub: ${method} ${path}`);
      const url = new URL(path, "https://api.github.com");
      const page = Number(url.searchParams.get("page") ?? "1");
      const raw = (i: FakeInstallation) => ({
        id: i.id,
        permissions: i.permissions ?? WRITE,
        account: { login: i.account },
        repository_selection: i.selection ?? "selected",
        html_url: `https://github.com/settings/installations/${i.id}`,
      });
      if (url.pathname === "/app/installations" && as === "app") {
        return (page === 1 ? installations.map(raw) : []) as T;
      }
      const one = /^\/app\/installations\/(\d+)$/.exec(url.pathname);
      if (one && as === "app") {
        const found = installations.find((i) => i.id === Number(one[1]));
        if (found === undefined) throw new GitHubError(404, path, "Not Found");
        return raw(found) as T;
      }
      if (url.pathname === "/installation/repositories" && typeof as === "number") {
        // A suspended installation's token is refused before any listing.
        if (suspended.includes(as)) throw new GitHubError(403, `/app/installations/${as}/access_tokens`, "This installation has been suspended");
        const i = installations.find((x) => x.id === as)!;
        return {
          repositories: (page === 1 ? i.repositories : []).map((name) => ({
            name,
            owner: { login: i.account },
            private: true,
          })),
        } as T;
      }
      throw new GitHubError(404, path, "Not Found");
    },
  };
}

const project = (name: string, owner: string | null, configHash: string | null): ProjectState => ({
  project: name,
  owner,
  base: "main",
  configHash,
  fromSha: null,
  refused: null,
  version: 1,
  lastSeq: 1n,
});

const INSTALL = "https://github.com/apps/lingtai-steven/installations/new";

describe("listRepositories", () => {
  it("lists what each installation can see, with GET and nothing else", async () => {
    const reader = fakeReader([
      { id: 7, account: "steven-zhc", repositories: ["lingtai", "nextloom-ai-admin"] },
      { id: 9, account: "acme", selection: "all", repositories: ["app"] },
    ]);

    const picker = await listRepositories({ reader, projects: [], installUrl: INSTALL });

    expect(picker.installations.map((l) => l.repositories.map((r) => r.slug))).toEqual([
      ["steven-zhc/lingtai", "steven-zhc/nextloom-ai-admin"],
      ["acme/app"],
    ]);
    expect(picker.installations[0]!.installation.htmlUrl).toBe("https://github.com/settings/installations/7");
    expect(reader.calls.every((c) => c.startsWith("GET "))).toBe(true);
    // The blunt endpoint, with the installation's token — there is no user token to use the finer one.
    expect(reader.calls).toContain("GET /installation/repositories?per_page=100&page=1 as 7");
  });

  it("shows a repository already on the log as such, rather than offering it twice", async () => {
    const reader = fakeReader([{ id: 7, account: "steven-zhc", repositories: ["lingtai", "admin", "fresh"] }]);

    const picker = await listRepositories({
      reader,
      projects: [project("lingtai", "steven-zhc", "abc"), project("admin", null, null)],
      installUrl: INSTALL,
    });

    expect(picker.installations[0]!.repositories.map((r) => [r.repo, r.onboarded])).toEqual([
      ["lingtai", "registered"],
      ["admin", "pending"],
      ["fresh", null],
    ]);
    expect(choose(picker, "steven-zhc/lingtai")).toMatchObject({ ok: false, why: /already onboarded/ });
  });

  it("is an empty list with an install link carrying a state when nothing is installed", async () => {
    const picker = await listRepositories({ reader: fakeReader([]), projects: [], installUrl: INSTALL });

    expect(picker.installations).toEqual([]);
    const link = new URL(picker.installUrl!);
    expect(`${link.origin}${link.pathname}`).toBe(INSTALL);
    expect(link.searchParams.get("state")).toMatch(/^[\w-]{16,}$/);
  });

  it("lists the installations that answer when one of them does not", async () => {
    const reader = fakeReader(
      [
        { id: 7, account: "steven-zhc", repositories: ["lingtai"] },
        { id: 9, account: "acme", repositories: ["app"] },
      ],
      [9],
    );

    const picker = await listRepositories({ reader, projects: [], installUrl: INSTALL });

    expect(picker.installations.map((l) => [l.installation.account, l.unanswered === null])).toEqual([
      ["steven-zhc", true],
      ["acme", false],
    ]);
    expect(picker.installations[1]!.unanswered).toMatch(/suspended/);
    expect(choose(picker, "steven-zhc/lingtai")).toMatchObject({ ok: true, slug: "steven-zhc/lingtai" });
    expect(choose(picker, "acme/app")).toMatchObject({ ok: false, why: /would not say what the App can see on acme/ });
  });

  it("does not call a same-named repository on another account onboarded when no owner was recorded", async () => {
    const reader = fakeReader([
      { id: 7, account: "steven-zhc", repositories: ["lingtai"] },
      { id: 9, account: "acme", repositories: ["lingtai"] },
    ]);

    const picker = await listRepositories({ reader, projects: [project("lingtai", null, "abc")], installUrl: INSTALL });

    expect(picker.installations.map((l) => l.repositories[0]!.onboarded)).toEqual(["unrecorded", "unrecorded"]);
    const choice = choose(picker, "acme/lingtai");
    expect(choice).toMatchObject({ ok: false, why: /cannot tell which it is/ });
    expect(!choice.ok && choice.why).not.toMatch(/already onboarded/);
    expect(!choice.ok && choice.why).toMatch(/lingtai add <owner>\/lingtai/);
  });

  it("names the missing scopes individually", async () => {
    const reader = fakeReader([
      { id: 7, account: "steven-zhc", permissions: { issues: "read", metadata: "read" }, repositories: ["lingtai"] },
    ]);
    const picker = await listRepositories({ reader, projects: [], installUrl: INSTALL });

    expect(picker.installations[0]!.gaps.map((g) => g.name)).toEqual(["issues", "contents", "pull_requests"]);
    const choice = choose(picker, "steven-zhc/lingtai");
    expect(choice).toMatchObject({
      ok: false,
      fix: { href: "https://github.com/settings/installations/7" },
    });
    expect(!choice.ok && choice.gaps.map((g) => g.name)).toEqual(["issues", "contents", "pull_requests"]);
  });
});

describe("choose", () => {
  const picker = () =>
    listRepositories({
      reader: fakeReader([{ id: 7, account: "steven-zhc", repositories: ["lingtai"] }]),
      projects: [],
      installUrl: INSTALL,
    });

  it("takes a pasted link in any shape, checked against the list", async () => {
    const p = await picker();
    for (const input of [
      "steven-zhc/lingtai",
      "https://github.com/steven-zhc/lingtai/tree/main",
      "git@github.com:steven-zhc/lingtai.git",
    ]) {
      expect(choose(p, input)).toMatchObject({ ok: true, slug: "steven-zhc/lingtai", installation: { id: 7 } });
    }
  });

  it("links a repository missing from a selected installation to that installation's page", async () => {
    const choice = choose(await picker(), "https://github.com/steven-zhc/other");

    expect(choice).toMatchObject({
      ok: false,
      why: /selected repositories, and steven-zhc\/other is not one of them/,
      fix: { href: "https://github.com/settings/installations/7" },
    });
  });

  it("sends an owner with no installation to the install link", async () => {
    const choice = choose(await picker(), "acme/app");

    expect(choice).toMatchObject({ ok: false, why: /not installed on acme/ });
    expect(!choice.ok && choice.fix?.href.startsWith(INSTALL)).toBe(true);
  });

  it("says what is wrong with something that is not a repository", async () => {
    expect(choose(await picker(), "lingtai")).toMatchObject({ ok: false, why: /is not owner\/repo/, fix: null });
  });
});

describe("the setup URL", () => {
  const reader = () => fakeReader([{ id: 7, account: "steven-zhc", repositories: ["lingtai"] }]);

  it("does not trust installation_id: one that is not this App's names nothing", async () => {
    expect(await verifiedInstallation(reader(), "7")).toBe(7);
    expect(await verifiedInstallation(reader(), "31337")).toBeNull();
    expect(await verifiedInstallation(reader(), "7; drop")).toBeNull();
    expect(
      await setupReturn(reader(), new URLSearchParams("installation_id=31337&setup_action=install&state=x")),
    ).toBe("/setup/repository");
  });

  /** An organisation owner's approval comes back with no `state`, and must still work. */
  it("works on a return with no state", async () => {
    const r = reader();
    const location = await setupReturn(r, new URLSearchParams("installation_id=7&setup_action=install"));

    expect(location).toBe("/setup/repository?installed=7");
    expect(r.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("says an owner has been asked when the install was only requested", async () => {
    expect(await setupReturn(reader(), new URLSearchParams("setup_action=request"))).toBe(
      "/setup/repository?requested=1",
    );
  });

  it("still lands on the picker when GitHub will not answer", async () => {
    const broken = {
      async request<T>(): Promise<T> {
        throw new GitHubError(502, "/app/installations/7", "Bad Gateway");
      },
    };
    expect(await setupReturn(broken, new URLSearchParams("installation_id=7"))).toBe("/setup/repository");
  });
});

describe("the reader", () => {
  it("is refused anything but GET by the fake, so a write would fail these tests", async () => {
    const r = fakeReader([]);
    await expect(r.request("POST", "/app/installations", "app")).rejects.toThrow(/wrote to GitHub/);
  });

  it("keeps an install link null when the App's slug is unknown", () => {
    expect(installLink(null)).toBeNull();
  });
});
