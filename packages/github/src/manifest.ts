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
 * disagree — and `unit/manifest.test.ts` reads it back out of
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
 * The events the App subscribes to: the ones a delivery can be acted on for.
 *
 * `issues` is what makes discovery event-driven. **`push` is not here**, though
 * 0006's table names it: `verifyWebhook` drops every push delivery on purpose
 * (`webhook.ts:100` — a force-push already invalidates a gate verdict by
 * arithmetic, and acting on one would mean re-asking GitHub on every commit
 * anybody makes), so subscribing to it asks GitHub to send what this system
 * throws away. `unit/manifest.test.ts` reads this list against `webhook.ts`'s
 * own `ACTED_ON` rather than against a second copy.
 *
 * Declared even when the hook is inactive: the events an App subscribes to are
 * what it *would* deliver, and a person who later points it at a public address
 * should not have to come back and tick a box.
 */
export const MANIFEST_EVENTS = ["issues"] as const;

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
  /**
   * Where GitHub sends a person after they install the App, absolute — the
   * repository picker's return (#168). Absent, GitHub shows its own page and
   * the person has to find their way back, which the picker survives: it reads
   * the installations back from GitHub rather than from this redirect.
   */
  setupUrl?: string | null;
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
  setup_url?: string;
  /** Also come back when the repositories an installation covers are changed. */
  setup_on_update?: boolean;
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
    ...(options.setupUrl ? { setup_url: options.setupUrl, setup_on_update: true } : {}),
  };
}

/** Loopback, the three private IPv4 ranges, link-local, and their IPv6 kin. */
const LOCAL_ADDRESS = [
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^::$/,
  /^f[cd][0-9a-f]{2}:/,
  /^fe[89ab][0-9a-f]:/,
];

/**
 * Why GitHub could not deliver to this address, or null when it could.
 *
 * **A scheme is not a reachability check.** `https://localhost:3200/api/webhook`
 * is a perfectly good URL and is this machine, so a manifest carrying it asks
 * for an App with `hook_attributes.active: true` pointed somewhere GitHub
 * cannot resolve — deliveries fail on GitHub's side, where Lingtai cannot see
 * them, and the operator believes discovery is event-driven. That is
 * [0016 §4](../../../doc/decisions/0016-the-settled-model.md)'s complaint, and
 * it is worse than the inactive hook a blank field declares, because inactive
 * is true.
 *
 * So the host is read as well as the scheme: loopback, the private ranges, the
 * link-local one, the names that only resolve on a LAN, and a bare name with no
 * dot in it — GitHub resolves none of them. What is left is not *proof* the
 * address is reachable, which nothing on this side of the wire can be; it is
 * every address that is knowably not.
 */
export function unreachableWebhook(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url} is not a URL`;
  }
  if (parsed.protocol !== "https:") return "GitHub delivers over https:// and this is not";

  // `URL.hostname` keeps an IPv6 literal's brackets; the checks below want the
  // address itself.
  const raw = parsed.hostname.toLowerCase();
  const host = raw.startsWith("[") ? raw.slice(1, -1) : raw;
  const ipv6 = host.includes(":");

  if (host === "localhost" || host.endsWith(".localhost")) return `${parsed.hostname} is this machine`;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    return `${parsed.hostname} resolves on a local network and not on GitHub's`;
  }
  if (!ipv6 && !host.includes(".")) return `${parsed.hostname} is a bare name, which GitHub cannot resolve`;
  if (LOCAL_ADDRESS.some((range) => range.test(host))) {
    return `${parsed.hostname} is a loopback or private address, which GitHub cannot reach`;
  }
  return null;
}

/**
 * Where the form posts: a person's own account, or an organisation's.
 *
 * Two URLs and not a query parameter — GitHub's org form is a different page,
 * and an org whose owner role the person does not hold refuses on that page,
 * where Lingtai cannot see it. That refusal reaches this system as *the person
 * never came back*, which is why the caller treats a silence as an outcome.
 *
 * **The `state` goes on this URL and nowhere else.** It is the one value in
 * this flow that GitHub reads from the *query string* of `/settings/apps/new`
 * rather than from the posted body: the manifest is the form, and `state` is
 * the page the form is on. Carried as a hidden input beside the manifest it is
 * a value GitHub never sees, so the redirect comes back with `code` and no
 * `state` — and `finish` refuses every one of them, after the App has been
 * minted and the only copy of its private key destroyed. There is no error
 * anywhere on that path: each attempt leaves an orphan App and refuses
 * identically, which is why the placement is asserted here and in
 * `create-app.ts`'s `begin`.
 */
export function manifestFormAction(org?: string | null, state?: string | null): string {
  const page = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return state ? `${page}?state=${encodeURIComponent(state)}` : page;
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
