/**
 * The manifest asks for 0006's permissions, **read from 0006** (#169).
 *
 * The same trick `packages/actions/test/tamper-watch.test.ts` uses for its
 * watch list, and for the same reason: a fixture written out here would be a
 * second copy of the table, free to agree with a decision that has moved on.
 * `doc/decisions/0006-github-app.md` is the canonical list — an ADR is a
 * decision and not a note — so it is parsed, and a manifest that asks for
 * something the ADR does not name fails here.
 *
 * That table is also the whole argument for the manifest flow. 0006 exists
 * because a fine-grained PAT covered a submodule and not the repository, with
 * nothing anywhere saying so; a manifest means the person never chooses
 * permissions, so the failure 0006 made *visible* becomes one that cannot
 * happen. A test that let the two drift would give that away quietly.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GitHubError } from "../src/app.ts";
import { ACTED_ON } from "../src/webhook.ts";
import {
  buildManifest,
  convertManifest,
  defaultPermissions,
  manifestFormAction,
  unreachableWebhook,
} from "../src/manifest.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * 0006's Decision table, as the ADR publishes it.
 *
 * `Issues | read + write` is `issues: write` in a manifest. The last row —
 * `Webhooks | issues, push` — is not a permission at all, and is skipped: the
 * events are read against `webhook.ts` instead (below).
 */
async function documented(): Promise<{ permissions: Record<string, string> }> {
  const md = await readFile(`${root}doc/decisions/0006-github-app.md`, "utf8");
  const rows = [...md.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm)]
    .map((m) => ({ name: m[1]!.trim(), level: m[2]!.trim() }))
    .filter((r) => r.name !== "Permission" && !/^-+$/.test(r.name));
  if (rows.length === 0) throw new Error("0006 has no permission table — the manifest has no source");

  const permissions: Record<string, string> = {};
  for (const row of rows) {
    if (row.name.toLowerCase() === "webhooks") continue;
    permissions[row.name.toLowerCase().replace(/\s+/g, "_")] = row.level.includes("write") ? "write" : "read";
  }
  return { permissions };
}

describe("the manifest asks for what 0006 decided", () => {
  it("declares exactly the ADR's permissions, at the ADR's levels", async () => {
    const { permissions } = await documented();

    expect(defaultPermissions()).toEqual(permissions);
  });

  /**
   * **Against the receiver, not the ADR.** 0006's row says `issues, push`, and
   * `webhook.ts:100` drops every `push` on purpose — so a subscription read off
   * the ADR asks GitHub to deliver what the receiver throws away. The events
   * worth subscribing to are the ones a delivery can be acted on for.
   */
  it("subscribes to exactly the events the receiver acts on, and not push", () => {
    const manifest = buildManifest({ name: "lingtai-x", redirectUrl: "http://127.0.0.1:3200/created" });

    expect(manifest.default_events).toEqual(Object.keys(ACTED_ON));
    expect(manifest.default_events).not.toContain("push");
  });

  it("is one team's own App, not a public one (0045)", () => {
    expect(buildManifest({ name: "lingtai-x", redirectUrl: "http://127.0.0.1:3200/created" }).public).toBe(false);
  });
});

describe("webhooks are declared inactive rather than pointed at localhost", () => {
  it("is inactive with no public address, which is the ordinary case", () => {
    const manifest = buildManifest({ name: "lingtai-x", redirectUrl: "http://127.0.0.1:3200/created" });

    expect(manifest.hook_attributes.active).toBe(false);
    // Whatever it carries, it is not this machine: an App pointed at a laptop
    // is one whose deliveries fail silently from the first minute (0016 §4).
    expect(manifest.hook_attributes.url).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("takes a public address when there is one", () => {
    const manifest = buildManifest({
      name: "lingtai-x",
      redirectUrl: "http://127.0.0.1:3200/created",
      webhookUrl: "https://lingtai.example.com/api/webhook",
    });

    expect(manifest.hook_attributes).toEqual({
      url: "https://lingtai.example.com/api/webhook",
      active: true,
    });
  });
});

/**
 * The half a scheme test cannot do. `https://localhost:3200/api/webhook` is a
 * well-formed `https://` URL and is this machine: an App created with it has
 * `active: true` and deliveries that fail on GitHub's side where Lingtai cannot
 * see them, which is 0016 §4's complaint and the state the caller's own comment
 * says is refused.
 */
describe("an address GitHub cannot reach", () => {
  it("refuses this machine however it is spelled, https:// and all", () => {
    for (const url of [
      "https://localhost:3200/api/webhook",
      "https://LOCALHOST/api/webhook",
      "https://board.localhost/api/webhook",
      "https://127.0.0.1:3200/api/webhook",
      "https://[::1]:3200/api/webhook",
      "https://0.0.0.0/api/webhook",
    ]) {
      expect(unreachableWebhook(url), url).not.toBeNull();
    }
  });

  it("refuses the private ranges and the names that only resolve on a LAN", () => {
    for (const url of [
      "https://192.168.1.14:3200/api/webhook",
      "https://10.0.0.5/api/webhook",
      "https://172.20.3.9/api/webhook",
      "https://169.254.1.1/api/webhook",
      "https://[fd00::1]/api/webhook",
      "https://[fe80::1]/api/webhook",
      "https://steven-laptop.local/api/webhook",
      "https://board.internal/api/webhook",
      "https://board/api/webhook",
    ]) {
      expect(unreachableWebhook(url), url).not.toBeNull();
    }
  });

  it("still refuses a scheme GitHub does not deliver over, and a non-URL", () => {
    expect(unreachableWebhook("http://lingtai.example.com/api/webhook")).not.toBeNull();
    expect(unreachableWebhook("lingtai.example.com/api/webhook")).not.toBeNull();
  });

  /** And takes a public address, which is the whole point of the field. */
  it("takes an address on the public internet", () => {
    expect(unreachableWebhook("https://lingtai.example.com/api/webhook")).toBeNull();
    expect(unreachableWebhook("https://203.0.113.7/api/webhook")).toBeNull();
    expect(unreachableWebhook("https://172.15.0.1/api/webhook")).toBeNull();
    expect(unreachableWebhook("https://172.32.0.1/api/webhook")).toBeNull();
  });
});

describe("where the form posts", () => {
  it("is the person's own account, or the organisation's own page", () => {
    expect(manifestFormAction(null)).toBe("https://github.com/settings/apps/new");
    expect(manifestFormAction("acme")).toBe("https://github.com/organizations/acme/settings/apps/new");
  });

  /**
   * **The one value GitHub reads from the query string.** The manifest is the
   * posted body and `state` is the page it is posted to: carried as a hidden
   * input beside the manifest, GitHub never sees it and has nothing to echo, so
   * the redirect back carries `code` and no `state` — and `finish` refuses
   * every return after the App has been minted and its only private key
   * destroyed. Nothing on that path errors; it just never completes.
   */
  it("carries the state in the query string, where GitHub takes it from", () => {
    expect(manifestFormAction(null, "s-1")).toBe("https://github.com/settings/apps/new?state=s-1");
    expect(manifestFormAction("acme", "s-1")).toBe(
      "https://github.com/organizations/acme/settings/apps/new?state=s-1",
    );
    // `randomBytes(…).toString("base64url")` needs no escaping and a state that
    // did would be one GitHub echoed back as a different string.
    expect(new URL(manifestFormAction(null, "a+b/c=d")).searchParams.get("state")).toBe("a+b/c=d");
  });
});

describe("the conversion", () => {
  const response = {
    id: 123456,
    slug: "lingtai-steven",
    name: "lingtai-steven",
    client_id: "Iv1.abc",
    client_secret: "s3cr3t-oauth",
    webhook_secret: "wh-secret",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n",
    owner: { login: "steven-zhc" },
  };

  const fakeFetch = (body: unknown, status = 200): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

  /**
   * **The OAuth pair is dropped at the seam and not merely unused.** Lingtai has
   * no OAuth flow — 0045 names user identity as a separate epic — and a secret
   * kept for a use that does not exist is a secret with no owner. Dropped here,
   * no caller can write one by accident.
   */
  it("keeps four values and drops client_id and client_secret", async () => {
    const created = await convertManifest("code-1", { fetch: fakeFetch(response) });

    expect(Object.keys(created).sort()).toEqual(["id", "name", "pem", "slug", "webhookSecret"]);
    expect(JSON.stringify(created)).not.toContain("s3cr3t-oauth");
    expect(JSON.stringify(created)).not.toContain("Iv1.abc");
  });

  it("sends the code unauthenticated, which is what the code is for", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const spy = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(response), { status: 200 });
    }) as unknown as typeof fetch;

    await convertManifest("code-1", { fetch: spy });

    expect(seen!.url).toBe("https://api.github.com/app-manifests/code-1/conversions");
    expect(seen!.init?.method).toBe("POST");
    expect(JSON.stringify(seen!.init?.headers)).not.toContain("authorization");
  });

  /** The hour, lapsed. The caller turns this into a sentence; here it is a status. */
  it("throws with GitHub's status when the code is spent", async () => {
    await expect(
      convertManifest("old-code", { fetch: fakeFetch({ message: "Not Found" }, 422) }),
    ).rejects.toBeInstanceOf(GitHubError);
  });
});
