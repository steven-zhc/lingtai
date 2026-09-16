/**
 * Creating the App from a manifest, which is the first two thirds of 0006's
 * price (#169, [the design](../../../doc/design/creating-the-app.md)).
 *
 * 0006 chose an App over a token and listed the cost in its own Consequences —
 * *an App must be created, given a private key, and installed*. GitHub's
 * **manifest flow** collapses the first two into one click: Lingtai describes
 * the App it wants, a person names it on GitHub's own screen, and GitHub hands
 * the credentials back over the wire.
 *
 * ```
 * 1. a page that AUTO-SUBMITS A POST FORM   → `manifestFormAction`, `buildManifest`
 * 2. GitHub's own screen — a person clicks Create GitHub App
 * 3. a redirect back with ?code=…&state=…
 * 4. POST /app-manifests/{code}/conversions → `convertManifest`
 * ```
 *
 * **It is a POST, so step 1 cannot be a link.** Whatever hosts it has to serve
 * a form; there is no URL a person can simply be sent to. And all three network
 * steps have to finish inside one hour, which is GitHub's bound on the code and
 * not ours.
 *
 * **`default_permissions` is the whole argument for doing this at all.** 0006
 * exists because a fine-grained PAT covered a submodule and not the repository
 * and nothing anywhere said so. A manifest means the person never chooses
 * permissions, so they cannot choose them wrong: the failure 0006 made
 * *visible* becomes one it makes *impossible*. The table is
 * `REQUIRED_PERMISSIONS` — the same list `permissionGaps` checks an
 * installation against, so what is asked for and what is verified cannot
 * disagree — and `test/manifest.test.ts` reads it back out of
 * `doc/decisions/0006-github-app.md` rather than from a second copy here.
 *
 * This module knows nothing about where the credentials are kept. It builds the
 * manifest and performs the conversion; `@lingtai/conductor`'s `create-app.ts`
 * is what writes a key to disk and what may never print one.
 */
import { GITHUB_API, GitHubError, REQUIRED_PERMISSIONS } from "./app.ts";

/** Lingtai's own page. GitHub's form requires a homepage and nothing reads it. */
export const LINGTAI_URL = "https://github.com/steven-zhc/lingtai";

/**
 * 0006's last table row, which is a manifest field rather than a permission.
 *
 * `issues` is what makes discovery event-driven; `push` is what tells the
 * conductor a branch moved. Declared even when the hook is inactive: the events
 * an App subscribes to are what it *would* deliver, and a person who later
 * points it at a public address should not have to come back and tick two boxes.
 */
export const MANIFEST_EVENTS = ["issues", "push"] as const;

/** 0006's permission table as GitHub's manifest spells it. */
export function defaultPermissions(): Record<string, string> {
  return Object.fromEntries(REQUIRED_PERMISSIONS.map((p) => [p.name, p.level]));
}

export interface ManifestOptions {
  /** What the App will be called. Unique across the whole of GitHub. */
  name: string;
  /** Where GitHub sends the person back, absolute. The loopback is accepted. */
  redirectUrl: string;
  /**
   * A public address GitHub can reach, or null.
   *
   * Null declares the hook **inactive**, and that is the ordinary case rather
   * than a degradation: `work-loop.ts:21` settled it — *a webhook needs a
   * public address and this runs on a laptop: it is an optimisation, and an
   * optimisation must not be the only path*. Filling in a `localhost` URL would
   * produce an App whose deliveries fail silently from the first minute, which
   * is [0016 §4](../../../doc/decisions/0016-the-settled-model.md)'s complaint.
   */
  webhookUrl?: string | null;
  /** The homepage field. Overridable only so a test need not assert a constant twice. */
  url?: string;
}

/** The manifest, exactly as it is posted. */
export interface AppManifest {
  name: string;
  url: string;
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
  hook_attributes: { url: string; active: boolean };
}

/**
 * The App Lingtai asks for.
 *
 * `public: false` because this is one team's own App
 * ([0045](../../../doc/decisions/0045-one-team-one-conductor.md)) — the App is
 * created once per team, not once per person, and nobody outside it should be
 * able to install it.
 *
 * `hook_attributes.url` is required by GitHub even when the hook is inactive,
 * so an unreachable address is given with `active: false` beside it. That pair
 * is honest — *there is no address yet* — where a `localhost` URL with
 * `active: true` is a configured thing that does not work.
 */
export function buildManifest(options: ManifestOptions): AppManifest {
  const hook = options.webhookUrl ?? null;
  return {
    name: options.name,
    url: options.url ?? LINGTAI_URL,
    redirect_url: options.redirectUrl,
    public: false,
    default_permissions: defaultPermissions(),
    default_events: [...MANIFEST_EVENTS],
    hook_attributes: hook === null ? { url: `${LINGTAI_URL}#no-webhook`, active: false } : { url: hook, active: true },
  };
}

/**
 * Where the form posts: a person's own account, or an organisation's.
 *
 * Two URLs and not a query parameter — GitHub's org form is a different page,
 * and an org whose owner role the person does not hold refuses on that page,
 * where Lingtai cannot see it. That refusal reaches this system as *the person
 * never came back*, which is why the caller treats a silence as an outcome.
 */
export function manifestFormAction(org?: string | null): string {
  return org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
}

/**
 * What the conversion hands back, minus the two values Lingtai has no use for.
 *
 * `client_id` and `client_secret` are **dropped at this seam** rather than
 * carried and ignored. Lingtai has no OAuth flow — 0045 names user identity as
 * a separate epic — and a secret kept for a use that does not exist is a secret
 * with no owner. Dropping them here means no caller can write one by accident.
 */
export interface CreatedApp {
  /** The App ID — `LINGTAI_GITHUB_APP_ID`. */
  id: number;
  /** `https://github.com/apps/<slug>/installations/new` is #168's first screen. */
  slug: string;
  name: string;
  /** The receiver verifies signatures with this. */
  webhookSecret: string;
  /** The PEM. Never printed, never logged, never appended to the event log. */
  pem: string;
}

/**
 * Step 4: the temporary code, exchanged for the credentials.
 *
 * **Unauthenticated** — the code is the authentication, and it is good for one
 * hour and one call. A 404 or a 422 here is nearly always that hour having
 * lapsed, and the caller says so rather than repeating GitHub's wording.
 *
 * `fetch` is injectable because the whole of this module's behaviour worth
 * testing is on the other side of it, and a test that needed the network would
 * not be run.
 */
export async function convertManifest(
  code: string,
  deps: { fetch?: typeof fetch } = {},
): Promise<CreatedApp> {
  const path = `/app-manifests/${encodeURIComponent(code)}/conversions`;
  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(`${GITHUB_API}${path}`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      // GitHub rejects a request with no User-Agent, with a message that does
      // not say so.
      "user-agent": "lingtai",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    let message = body.slice(0, 400);
    try {
      message = (JSON.parse(body) as { message?: string }).message ?? message;
    } catch {
      // Not JSON. The raw prefix is more useful than nothing.
    }
    throw new GitHubError(response.status, path, message);
  }

  const raw = (await response.json()) as {
    id: number;
    slug: string;
    name: string;
    webhook_secret: string | null;
    pem: string;
  };
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    webhookSecret: raw.webhook_secret ?? "",
    pem: raw.pem,
  };
}
