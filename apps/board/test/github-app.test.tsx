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
 * and never bytes**, and **the ending names `lingtai restart`** rather than
 * telling an operator the daemon is ready — which it is not, because the App ID
 * was fixed when that process started.
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
    configured: { appId: "1234567", slug: "lingtai-steven", from: "environment" },
    installUrl: "https://github.com/apps/lingtai-steven/installations/new",
  };

  it("offers no form at all, and offers the install link instead", () => {
    const out = html(CONFIGURED);

    expect(out).not.toContain('action="/setup/github-app/start"');
    expect(out).toContain("https://github.com/apps/lingtai-steven/installations/new");
  });

  /**
   * Created here, and this process started before it. Saying *configured* would
   * be true of the files and false of the daemon, so the sentence is the
   * restart.
   */
  it("says so from the log too, and names the restart that picks it up", () => {
    const out = html({
      ...CONFIGURED,
      configured: { appId: "1234567", slug: "lingtai-steven", from: "log" },
    });

    expect(out).toContain("lingtai restart");
  });
});

describe("the ending", () => {
  const CREATED: Offer = {
    ...OFFERING,
    offered: false,
    configured: { appId: "1234567", slug: "lingtai-steven", from: "log" },
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
    const out = html({ ...OFFERING, outcome: { ok: false, refusal: "the hour lapsed — start again", at: new Date() } });

    expect(out).toContain("the hour lapsed — start again");
    expect(out).toContain('action="/setup/github-app/start"');
  });
});
