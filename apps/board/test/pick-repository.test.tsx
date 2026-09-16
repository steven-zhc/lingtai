/**
 * Step 0's repository picker, as markup (#168).
 *
 * The list, the lookup and the setup URL are asserted in
 * `packages/conductor/pure/pick-repository.test.ts`. What is here is what only
 * the render can get wrong: a registered repository drawn as a link to choose
 * it, no installation drawn as an error, a missing scope left unnamed.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Installation } from "@lingtai/github";
import { type Picker, choose } from "@lingtai/conductor/pick-repository";
import { type Loaded, RepositoryScreen } from "../src/app/setup/repository/page.tsx";

const installation = (over: Partial<Installation> = {}): Installation => ({
  id: 7,
  permissions: { issues: "write", contents: "write", pull_requests: "write", metadata: "read" },
  account: "steven-zhc",
  repositorySelection: "selected",
  htmlUrl: "https://github.com/settings/installations/7",
  ...over,
});

const INSTALL = "https://github.com/apps/lingtai-steven/installations/new?state=abc";

const picker: Picker = {
  installUrl: INSTALL,
  installations: [
    {
      installation: installation(),
      unanswered: null,
      gaps: [],
      repositories: [
        { owner: "steven-zhc", repo: "lingtai", private: true, slug: "steven-zhc/lingtai", onboarded: "registered" },
        { owner: "steven-zhc", repo: "fresh", private: true, slug: "steven-zhc/fresh", onboarded: null },
      ],
    },
  ],
};

const html = (loaded: Loaded, extra: { input?: string; installed?: number | null; requested?: boolean } = {}) =>
  renderToStaticMarkup(
    <RepositoryScreen
      loaded={loaded}
      input={extra.input ?? ""}
      choice={loaded.state === "listed" && extra.input ? choose(loaded.picker, extra.input) : null}
      installed={extra.installed ?? null}
      requested={extra.requested ?? false}
    />,
  );

describe("the list", () => {
  it("offers a repository to choose, and shows a registered one without offering it", () => {
    const out = html({ state: "listed", picker, logUnanswered: null });

    expect(out).toContain('href="/setup/repository?repo=steven-zhc%2Ffresh"');
    expect(out).not.toContain("repo=steven-zhc%2Flingtai");
    expect(out).toContain("already onboarded");
  });

  it("offers nothing while the log cannot say what is already onboarded", () => {
    const out = html({ state: "listed", picker, logUnanswered: "connection refused" });

    expect(out).not.toContain("?repo=");
    expect(out).toContain("connection refused");
  });

  it("writes nothing: the lookup is a GET form", () => {
    const out = html({ state: "listed", picker, logUnanswered: null });

    expect(out).toContain('method="GET"');
    expect(out).not.toMatch(/method="POST"/i);
  });
});

describe("no installation yet", () => {
  it("is a screen with the install link and what installing grants, not an error", () => {
    const out = html({ state: "listed", picker: { installUrl: INSTALL, installations: [] }, logUnanswered: null });

    expect(out).toContain(INSTALL.replace("&", "&amp;"));
    expect(out).toContain("pull_requests");
    expect(out).not.toContain('class="refusal"');
  });

  it("blames the log, not a hand-configured App, when the log cannot be read", () => {
    const out = html({ state: "listed", picker: { installUrl: null, installations: [] }, logUnanswered: "connection refused" });

    expect(out).toContain("connection refused");
    expect(out).not.toContain("configured by hand");
  });
});

describe("an installation that will not answer", () => {
  it("is named under its own account, and the others are still offered", () => {
    const out = html({
      state: "listed",
      picker: {
        ...picker,
        installations: [
          ...picker.installations,
          {
            installation: installation({ id: 9, account: "acme" }),
            unanswered: "GitHub 403: This installation has been suspended",
            gaps: [],
            repositories: [],
          },
        ],
      },
      logUnanswered: null,
    });

    expect(out).toContain("GitHub would not say what the App can see on acme — GitHub 403: This installation has been suspended");
    expect(out).toContain('href="/setup/repository?repo=steven-zhc%2Ffresh"');
  });
});

describe("a repository that is not on the list", () => {
  it("says why and links to the installation's own page", () => {
    const out = html({ state: "listed", picker, logUnanswered: null }, { input: "https://github.com/steven-zhc/other.git" });

    expect(out).toContain("steven-zhc/other is not one of them");
    expect(out).toContain('href="https://github.com/settings/installations/7"');
  });

  it("names each missing scope", () => {
    const gappy: Picker = {
      ...picker,
      installations: [
        {
          ...picker.installations[0]!,
          installation: installation({ permissions: { metadata: "read", issues: "read" } }),
          gaps: [
            { name: "issues", need: "write", have: "read", why: "labels" },
            { name: "contents", need: "write", have: "none", why: "pushing" },
          ],
        },
      ],
    };
    const out = html({ state: "listed", picker: gappy, logUnanswered: null }, { input: "steven-zhc/fresh" });

    expect(out).toContain("<code>issues</code>: have read, need write");
    expect(out).toContain("<code>contents</code>: have none, need write");
    expect(out).not.toContain("Chosen");
  });
});

describe("returning from GitHub", () => {
  it("names the installation only when it is on the App's own list", () => {
    expect(html({ state: "listed", picker, logUnanswered: null }, { installed: 7 })).toContain("Installed on steven-zhc");
    expect(html({ state: "listed", picker, logUnanswered: null }, { installed: 31337 })).not.toContain("Installed on");
  });

  it("says an owner has to approve a requested install", () => {
    expect(html({ state: "listed", picker, logUnanswered: null }, { requested: true })).toContain("owner has to approve");
  });
});
