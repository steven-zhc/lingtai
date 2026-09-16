/**
 * GitHub App authentication.
 *
 * An App, not a personal access token. A fine-grained PAT can do everything
 * Lingtai needs and can also be wrong in a way nothing reports: on
 * 2026-08-30 one covered the admin repository's *submodule* but not the
 * repository itself, and every CI run failed with a 403 that said nothing about
 * scope. Which repositories an App can reach is explicit in its installation,
 * so the same mistake is visible at install time rather than a day later.
 * See doc/decisions/0006-github-app.md.
 *
 * Two credentials, two lifetimes:
 *
 *   app JWT             signed locally with the private key, ~9 minutes,
 *                       identifies the *App* and can only read installations
 *   installation token  fetched with that JWT, ~1 hour, identifies the App
 *                       *on one repository* and is what every real call uses
 *
 * Callers never see either. `tokenFor()` hands back a valid installation token
 * and refreshes it before it expires, so "token refresh is transparent" is a
 * property of the type rather than something every call site remembers.
 *
 * No dependency for the JWT: `node:crypto` signs RS256, which is the whole of
 * what GitHub asks for.
 */
import { Cause, Effect, Exit } from "effect";
import { createSign } from "node:crypto";

export const GITHUB_API = "https://api.github.com";

export interface AppAuth {
  appId: string;
  /** PEM. Never logged, never included in an error. */
  privateKey: string;
}

export interface Installation {
  id: number;
  /** `read` or `write` per permission name, as GitHub reports them. */
  permissions: Readonly<Record<string, string>>;
  account: string;
  /** `all`, or `selected` when the App was installed on specific repositories. */
  repositorySelection: string;
  /**
   * The installation's own settings page — where its repositories and its
   * permissions are changed, so the page a missing repository or a missing
   * scope is fixed on (#168). Null only when GitHub did not send one.
   */
  htmlUrl: string | null;
}

/** An installation as GitHub's JSON spells it. */
interface RawInstallation {
  id: number;
  permissions: Record<string, string>;
  account: { login?: string } | null;
  repository_selection: string;
  html_url?: string | null;
}

function toInstallation(raw: RawInstallation, owner = ""): Installation {
  return {
    id: raw.id,
    permissions: raw.permissions,
    account: raw.account?.login ?? owner,
    repositorySelection: raw.repository_selection,
    htmlUrl: raw.html_url ?? null,
  };
}

export class GitHubError extends Error {
  override readonly name = "GitHubError";
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(`${status} on ${path}: ${message}`);
    this.status = status;
    this.path = path;
  }
}

/** The App is not installed on that repository — the failure 0006 exists to surface. */
export class NotInstalledError extends Error {
  override readonly name = "NotInstalledError";
  readonly owner: string;
  readonly repo: string;

  constructor(owner: string, repo: string) {
    super(
      `the GitHub App is not installed on ${owner}/${repo}. ` +
        "Install it on that repository (Settings → GitHub Apps → Configure), " +
        "then run lingtai add again.",
    );
    this.owner = owner;
    this.repo = repo;
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A short-lived JWT identifying the App itself.
 *
 * `iat` is backdated by 60s because GitHub rejects a token whose `iat` is in its
 * future, and a laptop's clock drifts. `exp` is 9 minutes; GitHub's ceiling is
 * 10 and rejects anything over it.
 */
export function appJwt(auth: AppAuth, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: auth.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(auth.privateKey, "base64url")}`;
}

async function githubJson<T>(
  path: string,
  init: RequestInit & { token: string; tokenKind: "bearer" },
): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      // GitHub rejects a request with no User-Agent, with a message that does
      // not say so.
      "user-agent": "lingtai",
      authorization: `Bearer ${init.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
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
  return (await response.json()) as T;
}

/** Which installation covers a repository, and what it may do there. */
export async function installationForRepo(
  auth: AppAuth,
  owner: string,
  repo: string,
): Promise<Installation> {
  try {
    const raw = await githubJson<RawInstallation>(`/repos/${owner}/${repo}/installation`, {
      token: appJwt(auth),
      tokenKind: "bearer",
    });
    return toInstallation(raw, owner);
  } catch (err) {
    // 404 here means "no installation covers this repository", which is not the
    // same as "no such repository" and reads very differently to whoever is
    // trying to onboard it.
    if (err instanceof GitHubError && err.status === 404) throw new NotInstalledError(owner, repo);
    throw err;
  }
}

/**
 * The permissions ADR 0006 settled on, and why each is needed.
 *
 * Checked at add time rather than discovered as a 403 in the middle of a run —
 * which is exactly how the PAT failure went unexplained for a day.
 */
export const REQUIRED_PERMISSIONS: { name: string; level: "read" | "write"; why: string }[] = [
  { name: "issues", level: "write", why: "reading work items, writing agent:* labels and comments" },
  { name: "contents", level: "write", why: "cloning, pushing agent/*, merging into base" },
  { name: "pull_requests", level: "write", why: "opening and reading pull requests" },
  { name: "metadata", level: "read", why: "required by GitHub for any App" },
];

export interface PermissionGap {
  name: string;
  need: string;
  have: string;
  why: string;
}

/** Every required permission the installation does not actually grant. */
export function permissionGaps(installation: Installation): PermissionGap[] {
  const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
  return REQUIRED_PERMISSIONS.filter((r) => {
    const have = installation.permissions[r.name];
    return (rank[have ?? ""] ?? 0) < (rank[r.level] ?? 0);
  }).map((r) => ({
    name: r.name,
    need: r.level,
    have: installation.permissions[r.name] ?? "none",
    why: r.why,
  }));
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * A source of valid installation tokens for one repository, as an `Effect`.
 *
 * Refreshes a minute before expiry rather than on a 401, so a token never
 * expires mid-merge — the one moment where retrying is least welcome.
 *
 * **One refresh at a time**, and that is the part that changed. A burst of
 * calls after expiry should not become a burst of token requests; it used to be
 * an in-flight promise cleared in a `.finally()`, which covers the two endings
 * a promise has and no others. A semaphore's permit is released when the effect
 * *leaves*, interruption included, and the second check inside the permit is
 * what turns "one at a time" into "one request"
 * ([0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)).
 */
export function installationToken(
  auth: AppAuth,
  installationId: number,
): Effect.Effect<string, GitHubError> {
  let cached: CachedToken | null = null;
  const refreshing = Effect.runSync(Effect.makeSemaphore(1));
  const fresh = () => cached !== null && cached.expiresAtMs - Date.now() > 60_000;

  const fetchToken = Effect.tryPromise({
    try: async () => {
      const raw = await githubJson<{ token: string; expires_at: string }>(
        `/app/installations/${installationId}/access_tokens`,
        { method: "POST", token: appJwt(auth), tokenKind: "bearer" },
      );
      cached = { token: raw.token, expiresAtMs: Date.parse(raw.expires_at) };
      return raw.token;
    },
    catch: (err) =>
      err instanceof GitHubError
        ? err
        : new GitHubError(0, `/app/installations/${installationId}/access_tokens`, (err as Error).message),
  });

  return Effect.suspend(() =>
    fresh()
      ? Effect.succeed(cached!.token)
      : refreshing.withPermits(1)(
          // Checked again inside the permit: whoever was queued behind the one
          // request wants its answer, not another request.
          Effect.suspend(() => (fresh() ? Effect.succeed(cached!.token) : fetchToken)),
        ),
  );
}

/**
 * The same source, as the `() => Promise<string>` that `TokenSource` means.
 *
 * `git` passes it to a child process's environment and the board calls it from
 * a server action; neither has a runtime to run an `Effect` in. The rejection
 * is the `GitHubError` itself rather than a fiber's wrapper, because a caller
 * that reads `.status` should not have to know which face it took.
 */
export function createTokenSource(
  auth: AppAuth,
  installationId: number,
): () => Promise<string> {
  const token = installationToken(auth, installationId);
  return async function tokenFor(): Promise<string> {
    const exit = await Effect.runPromiseExit(token);
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  };
}

/** One repository an installation can see. */
export interface VisibleRepository {
  owner: string;
  repo: string;
  private: boolean;
}

/**
 * Reading what the App can see, and nothing else (#168).
 *
 * **`GET` is the only method on it**, and the type says so: this is the
 * surface the repository picker is allowed, and the picker writes nothing. A
 * test hands it a fake that fails any other method, the assertion #161's
 * proposal carries.
 *
 * `as` is who asks: `"app"` is the App's JWT, which can read the App's own
 * installations and nothing inside them; a number is that installation's token.
 * Minting that token is a `POST` to `/app/installations/{id}/access_tokens`,
 * and it lives beneath this seam on purpose — it is authentication, it changes
 * nothing anyone can see, and every `GET` in this system already pays for one.
 */
export interface AppReader {
  request<T>(method: "GET", path: string, as: "app" | number): Promise<T>;
}

export function createAppReader(auth: AppAuth): AppReader {
  const tokens = new Map<number, () => Promise<string>>();
  return {
    async request<T>(method: "GET", path: string, as: "app" | number): Promise<T> {
      if (method !== "GET") throw new Error(`the App reader only reads: refused ${method} ${path}`);
      let token: string;
      if (as === "app") {
        token = appJwt(auth);
      } else {
        let source = tokens.get(as);
        if (source === undefined) {
          source = createTokenSource(auth, as);
          tokens.set(as, source);
        }
        token = await source();
      }
      return githubJson<T>(path, { method, token, tokenKind: "bearer" });
    },
  };
}

/** GitHub's own page size ceiling, and how far a listing pages before it refuses. */
const PAGE = 100;
const MAX_PAGES = 20;

/**
 * Every installation of this App — the App's own report.
 *
 * `GET /app/installations`, with the App's JWT. This is also what an
 * `installation_id` arriving on the setup URL is checked against: an id that
 * is not in here is not one of this App's installations, whatever the query
 * string says.
 */
export async function appInstallations(reader: AppReader): Promise<Installation[]> {
  const out: Installation[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = await reader.request<RawInstallation[]>(
      "GET",
      `/app/installations?per_page=${PAGE}&page=${page}`,
      "app",
    );
    out.push(...raw.map((r) => toInstallation(r)));
    if (raw.length < PAGE) return out;
  }
  throw new Error(`more than ${MAX_PAGES * PAGE} installations — the listing is incomplete`);
}

/**
 * What one installation can see.
 *
 * **`GET /installation/repositories`, the blunt endpoint, on purpose.** There
 * are two finer ones — `GET /user/installations` and
 * `GET /user/installations/{id}/repositories` answer *what can this person
 * see*, which is the better question — and both need a **user-to-server
 * token**, which Lingtai does not have: it has no user OAuth, and
 * [0045](../../../doc/decisions/0045-one-team-one-conductor.md) names who is
 * asking as a separate epic. Under one team and one conductor, *what the App
 * can see* is the right answer rather than a compromise. Reach for the `/user/`
 * endpoints and there is no token to call them with.
 */
export async function installationRepositories(
  reader: AppReader,
  installationId: number,
): Promise<VisibleRepository[]> {
  const out: VisibleRepository[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = await reader.request<{
      repositories: { name: string; owner: { login: string }; private: boolean }[];
    }>("GET", `/installation/repositories?per_page=${PAGE}&page=${page}`, installationId);
    out.push(...raw.repositories.map((r) => ({ owner: r.owner.login, repo: r.name, private: r.private })));
    if (raw.repositories.length < PAGE) return out;
  }
  throw new Error(`installation ${installationId} can see more than ${MAX_PAGES * PAGE} repositories — the listing is incomplete`);
}
