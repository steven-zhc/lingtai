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
 * and never bytes**, and **no screen names `lingtai restart`**. The App ID and
 * key path are read from `.env.local` on every call, so a created App is usable
 * at once in this board and in a running daemon — and `lingtai restart`
 * restarts only the daemon, so a sentence naming it would promise a fix for the
 * board it cannot deliver.
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

  /** Named by the file: usable as it stands, since the file is read per call. */
  it("names the env file, and no restart, when the file is what says so", () => {
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
    expect(out).toContain("configured with app 1234567");
    expect(out).not.toMatch(/restart/i);
  });
});

/**
 * **An App on the log is not a configured App**, and this is the screen that
 * says the difference.
 *
 * `GitHubAppCreated` is appended before the key file and the env file, so that
 * a write which fails leaves a record of the App it failed for. Rendered as a
 * configuration, that record turned exactly those failures into *created here*,
 * with no sentence anywhere saying the key never landed.
 */
describe("an App minted here whose credentials never landed", () => {
  const UNFINISHED: Offer = {
    ...OFFERING,
    offered: true,
    configured: null,
    minted: { appId: "1234567", slug: "lingtai-steven" },
  };

  it("does not read as configured, and does not send anyone to a restart", () => {
    const out = html(UNFINISHED);

    expect(out).toContain("not configured with it");
    expect(out).not.toContain("lingtai restart");
    expect(out).not.toContain("already configured");
  });

  /**
   * **It does not close the door** (#169). Withholding the form here left a
   * person whose key write failed with an App whose key cannot be fetched
   * again and a screen that would never let them make another.
   */
  it("still offers creation, and names the stranded App with its settings link and the way out", () => {
    const out = html(UNFINISHED);

    expect(out).toContain('action="/setup/github-app/start"');
    expect(out).toContain("App 1234567");
    expect(out).toContain('href="https://github.com/settings/apps/lingtai-steven"');
    expect(out).toContain("Private keys");
    expect(out).toContain("from step 2");
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

  it("says the App is usable now, and names no restart", () => {
    const out = html(CREATED);

    expect(out).toContain("nothing has to be restarted");
    expect(out).not.toContain("lingtai restart");
    expect(out).not.toContain("pnpm --filter @lingtai/board dev");
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

/**
 * **No screen names `lingtai restart`** (#169). It restarts the daemon and not
 * the board, and nothing here needs either: the env file is read per call. So
 * every state the setup route can render is rendered and grepped.
 */
describe("every screen of the setup route", () => {
  const minted = { appId: "1234567", slug: "lingtai-steven" };
  const at = new Date("2026-09-15T10:05:00Z");
  const screens: Record<string, Offer> = {
    offering: OFFERING,
    waiting: { ...OFFERING, outstanding: { name: "lingtai-steven", org: null, startedAt: at, state: "waiting" } },
    lapsed: { ...OFFERING, outstanding: { name: "lingtai-steven", org: null, startedAt: at, state: "lapsed" } },
    "configured, environment": {
      ...OFFERING,
      offered: false,
      configured: { ...minted, where: "environment", file: null },
      installUrl: "https://github.com/apps/lingtai-steven/installations/new",
    },
    "configured, file, by hand": {
      ...OFFERING,
      offered: false,
      configured: { appId: "1234567", slug: null, where: "file", file: "/repo/.env.local" },
    },
    unfinished: { ...OFFERING, minted },
    unanswered: { ...OFFERING, offered: false, unanswered: "connection refused" },
    created: {
      ...OFFERING,
      offered: false,
      configured: { ...minted, where: "file", file: "/repo/.env.local" },
      minted,
      outcome: {
        ok: true,
        ...minted,
        name: "lingtai-steven",
        keyPath: "~/.ssh/lingtai-agent.private-key.pem",
        envFile: "/repo/.env.local",
        webhookActive: true,
        warning: "the log did not record it (down)",
        at,
      },
    },
    "refused after minting": {
      ...OFFERING,
      minted,
      outcome: { ok: false, refusal: "the env file could not be written", minted, at },
    },
  };

  for (const [name, offer] of Object.entries(screens)) {
    it(`${name}: does not name lingtai restart`, () => {
      expect(html(offer)).not.toContain("lingtai restart");
    });
  }
});
