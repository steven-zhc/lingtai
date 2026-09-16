/**
 * The wizard's first screen, as markup (#169).
 *
 * The fold — *is creation offered, and what is written* — is asserted in
 * `packages/conductor/pure/create-app.test.ts`. What is here is the half a fold
 * cannot catch, which is #101's rule: a page that offers the button anyway, or
 * one that renders a key, is a page whose data was right.
 *
 * Three claims, and each is a line in the ticket:
 * **an App already configured is offered no second one**, **the key is a path
 * and never bytes**, and **the ending names the restart of every process that
 * is now stale** rather than telling an operator the daemon is ready — which it
 * is not, because the App ID was fixed when that process started. There are two
 * such processes and `pnpm lingtai restart` is one of them: it is the daemon's,
 * and the board drawing this page has to be restarted on its own.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Offer } from "@lingtai/conductor/create-app";
import { GitHubAppScreen } from "../src/app/setup/github-app/page.tsx";

const PERMISSIONS = [
  { name: "issues", level: "write" as const, why: "reading work items, writing agent:* labels and comments" },
  { name: "metadata", level: "read" as const, why: "required by GitHub for any App" },
];

const OFFERING: Offer = {
  offered: true,
  configured: null,
  minted: null,
  unanswered: null,
  installUrl: null,
  keyPath: "~/.ssh/lingtai-agent.private-key.pem",
  suggestedName: "lingtai-steven",
  permissions: PERMISSIONS,
  outstanding: null,
  outcome: null,
};

const html = (offer: Offer) => renderToStaticMarkup(<GitHubAppScreen offer={offer} />);

describe("offering to create one", () => {
  /** It is a POST of a manifest, so the control is a form and never a link. */
  it("posts a form to this app's own route rather than linking to GitHub", () => {
    const out = html(OFFERING);

    expect(out).toContain('method="POST"');
    expect(out).toContain('action="/setup/github-app/start"');
    expect(out).not.toContain('href="https://github.com/settings/apps/new"');
  });

  /** Shown, and never asked: a person who cannot choose cannot choose wrong. */
  it("shows 0006's permissions and says they are not a question", () => {
    const out = html(OFFERING);

    expect(out).toContain("issues");
    expect(out).toContain("metadata");
    expect(out).toContain("You never choose them");
  });

  it("says where the key will go and at what mode", () => {
    const out = html(OFFERING);

    expect(out).toContain("~/.ssh/lingtai-agent.private-key.pem");
    expect(out).toContain("0600");
  });

  /** A `localhost` hook is an App whose deliveries fail silently (0016 §4). */
  it("says blank means inactive webhooks, and that nothing degrades", () => {
    const out = html(OFFERING);

    expect(out).toContain("inactive");
    expect(out).toContain("sweep");
  });

  /** The tab was closed, or GitHub refused the name where Lingtai cannot see it. */
  it("names a collision as the likely cause when a posted form never came back", () => {
    const out = html({
      ...OFFERING,
      outstanding: {
        name: "lingtai-steven",
        org: null,
        startedAt: new Date("2026-09-15T10:00:00Z"),
        state: "lapsed",
      },
    });

    expect(out).toContain("never came back");
    expect(out).toContain("already taken");
  });
});

describe("an App that already exists", () => {
  const CONFIGURED: Offer = {
    ...OFFERING,
    offered: false,
    configured: { appId: "1234567", slug: "lingtai-steven", where: "environment", file: null },
    minted: { appId: "1234567", slug: "lingtai-steven" },
    installUrl: "https://github.com/apps/lingtai-steven/installations/new",
  };

  it("offers no form at all, and offers the install link instead", () => {
    const out = html(CONFIGURED);

    expect(out).not.toContain('action="/setup/github-app/start"');
    expect(out).toContain("https://github.com/apps/lingtai-steven/installations/new");
  });

  /**
   * Written to the env file, and this process started before that line. Saying
   * *configured* alone would be true of the file and false of both processes
   * that have to use it, so the sentence is the restart.
   *
   * **And `lingtai restart` is the daemon's alone.** It drains and starts the
   * conductor (0042) and does not touch the board serving this page — so a
   * screen naming it by itself sends the operator to the one command that
   * cannot fix what they are reading: the board goes on answering *no GitHub
   * App configured* to Approve and Close (`actions.ts:73`, `:200`), and running
   * it again shows the identical sentence.
   */
  it("names the env file and both restarts, the board's first, when the file is what says so", () => {
    const out = html({
      ...CONFIGURED,
      configured: {
        appId: "1234567",
        slug: "lingtai-steven",
        where: "file",
        file: "/repo/.env.local",
      },
    });

    expect(out).toContain("/repo/.env.local");
    expect(out).toContain("pnpm --filter @lingtai/board dev");
    expect(out).toContain("lingtai restart");
    // The board is named as the stale process, and the daemon's command is not
    // offered as this one's remedy.
    expect(out).toContain("this board started before that line");
    expect(out).toContain("does not restart this board");
  });
});

/**
 * **An App on the log is not a configured App**, and this is the screen that
 * says the difference.
 *
 * `GitHubAppCreated` is appended before the key file and the env file, so that
 * a write which fails leaves a record of the App it failed for. Rendered as a
 * configuration, that record turned exactly those failures into *created here,
 * run `lingtai restart`* — and the restart would find `LINGTAI_GITHUB_APP_ID`
 * unset and do nothing, with no sentence anywhere saying the key never landed.
 */
describe("an App minted here whose credentials never landed", () => {
  const UNFINISHED: Offer = {
    ...OFFERING,
    offered: false,
    configured: null,
    minted: { appId: "1234567", slug: "lingtai-steven" },
  };

  it("does not read as configured, and does not send anyone to a restart", () => {
    const out = html(UNFINISHED);

    expect(out).toContain("not configured with it");
    expect(out).not.toContain("lingtai restart");
    expect(out).not.toContain("already configured");
  });

  it("draws no form, and points at a new key rather than a second App", () => {
    const out = html(UNFINISHED);

    expect(out).not.toContain('action="/setup/github-app/start"');
    expect(out).toContain("Private keys");
    expect(out).toContain("doc/operating.md");
  });
});

/**
 * The half of this a fold cannot catch: the data said *unknown*, and what
 * matters is that the markup does not read as *nothing is configured*.
 */
describe("a log that would not answer", () => {
  const UNANSWERED: Offer = {
    ...OFFERING,
    offered: false,
    unanswered: "connection terminated unexpectedly",
  };

  it("draws no form, and says the question could not be answered", () => {
    const out = html(UNANSWERED);

    expect(out).not.toContain('action="/setup/github-app/start"');
    expect(out).toContain("cannot tell whether an App was already created here");
    expect(out).toContain("connection terminated unexpectedly");
  });

  /** *Nothing is configured* is the sentence that gets a second App minted. */
  it("does not claim nothing is configured", () => {
    const out = html(UNANSWERED);

    expect(out).not.toContain("already configured");
    expect(out).not.toContain("step 0 — Lingtai talks to GitHub");
  });
});

describe("the ending", () => {
  const CREATED: Offer = {
    ...OFFERING,
    offered: false,
    configured: { appId: "1234567", slug: "lingtai-steven", where: "file", file: "/repo/.env.local" },
    minted: { appId: "1234567", slug: "lingtai-steven" },
    installUrl: "https://github.com/apps/lingtai-steven/installations/new",
    outcome: {
      ok: true,
      appId: "1234567",
      slug: "lingtai-steven",
      name: "lingtai-steven",
      keyPath: "~/.ssh/lingtai-agent.private-key.pem",
      envFile: "/repo/.env.local",
      webhookActive: false,
      warning: null,
      at: new Date("2026-09-15T10:05:00Z"),
    },
  };

  it("names lingtai restart and does not claim the running daemon has the App", () => {
    const out = html(CREATED);

    expect(out).toContain("lingtai restart");
    expect(out).toContain("Nothing running has this App yet");
    expect(out).not.toMatch(/\bready\b/);
  });

  /**
   * **The board is one of the two stale processes, and it is the one the person
   * is looking at.** `pnpm lingtai restart` drains and starts the *daemon*
   * (0042) and never touches this process, so an ending that named it alone
   * would be handing the operator a command that cannot fix what they just
   * read: they run it, click Approve, and `approveCard`'s `hasGitHubApp()`
   * answers *no GitHub App configured* off the same snapshot
   * (`apps/board/src/app/actions.ts:73`, `closeCard` at `:200`) — with nothing
   * on the page or in the docs naming the board, so they run it again and see
   * the identical sentence.
   */
  it("names the board's own restart, and says the daemon's command is not it", () => {
    const out = html(CREATED);

    expect(out).toContain("pnpm --filter @lingtai/board dev");
    expect(out).toContain("this board included");
    expect(out).toContain("it does not restart this board");
    // The board's is first: it is the process drawing this page.
    expect(out.indexOf("pnpm --filter @lingtai/board dev")).toBeLessThan(out.indexOf("lingtai restart"));
  });

  /** The path, never the key — a page cannot render what it was never handed. */
  it("prints the path of the key and nothing that looks like one", () => {
    const out = html(CREATED);

    expect(out).toContain("~/.ssh/lingtai-agent.private-key.pem");
    expect(out).not.toContain("BEGIN");
  });

  it("hands over to installing it, which is a different act", () => {
    const out = html(CREATED);

    expect(out).toContain("https://github.com/apps/lingtai-steven/installations/new");
    expect(out).toContain("Creating is not installing");
  });

  it("says a refusal in the server's own words and offers the form again", () => {
    const out = html({ ...OFFERING, outcome: { ok: false, refusal: "the hour lapsed — start again", minted: null, at: new Date() } });

    expect(out).toContain("the hour lapsed — start again");
    expect(out).toContain('action="/setup/github-app/start"');
  });
});
