import { createSign } from 'node:crypto'

/**
 * GitHub App authentication.
 *
 * An App, not a personal access token. A fine-grained PAT can do everything
 * Lingtai needs and can also be wrong in a way nothing reports: on
 * 2026-08-30 one covered the admin repository's *submodule* but not the
 * repository itself, and every CI run failed with a 403 that said nothing about
 * scope. Which repositories an App can reach is explicit in its installation,
 * so the same mistake is visible at install time rather than a day later.
 * See doc/decisions-archive/0006-github-app.md.
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
import { Data, Effect, Ref, Semaphore } from 'effect'

import type { BodyChanged } from './client.ts'

export const GITHUB_API = 'https://api.github.com'

export interface AppAuth {
  appId: string
  /** PEM. Never logged, never included in an error. */
  privateKey: string
}

export interface Installation {
  id: number
  /** `read` or `write` per permission name, as GitHub reports them. */
  permissions: Readonly<Record<string, string>>
  account: string
  /** `all`, or `selected` when the App was installed on specific repositories. */
  repositorySelection: string
  /**
   * The installation's own settings page — where its repositories and its
   * permissions are changed, so the page a missing repository or a missing
   * scope is fixed on (#168). Null only when GitHub did not send one.
   */
  htmlUrl: string | null
  /** The App's own slug, for its permissions page. Null only when GitHub did not send one. */
  appSlug: string | null
}

/** An installation as GitHub's JSON spells it. */
interface RawInstallation {
  id: number
  permissions: Record<string, string>
  account: { login?: string } | null
  repository_selection: string
  html_url?: string | null
  app_slug?: string | null
}

function toInstallation(raw: RawInstallation, owner = ''): Installation {
  return {
    id: raw.id,
    permissions: raw.permissions,
    account: raw.account?.login ?? owner,
    repositorySelection: raw.repository_selection,
    htmlUrl: raw.html_url ?? null,
    appSlug: raw.app_slug ?? null,
  }
}

export class GitHubFailed extends Data.TaggedError('GitHubFailed')<{
  readonly status: number
  readonly path: string
  readonly detail: string
}> {
  constructor(status: number, path: string, detail: string) {
    super({ status, path, detail })
  }

  override get message(): string {
    return `${this.status} on ${this.path}: ${this.detail}`
  }

  /** A 429, or a 403 whose detail says GitHub is throttling rather than refusing. */
  get rateLimited(): boolean {
    return this.status === 429 || (this.status === 403 && /rate limit/i.test(this.detail))
  }
}

/** The App is not installed on that repository — the failure 0006 exists to surface. */
export class NotInstalledError extends Data.TaggedError('NotInstalled')<{
  readonly owner: string
  readonly repo: string
}> {
  constructor(owner: string, repo: string) {
    super({ owner, repo })
  }

  override get message(): string {
    return (
      `the GitHub App is not installed on ${this.owner}/${this.repo}. ` +
      'Install it on that repository (Settings → GitHub Apps → Configure), ' +
      'then run lingtai add again.'
    )
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * A short-lived JWT identifying the App itself.
 *
 * `iat` is backdated by 60s because GitHub rejects a token whose `iat` is in its
 * future, and a laptop's clock drifts. `exp` is 9 minutes; GitHub's ceiling is
 * 10 and rejects anything over it.
 */
export function appJwt(auth: AppAuth, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: auth.appId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${signer.sign(auth.privateKey, 'base64url')}`
}

/** The promise face over every Effect in this package that a caller outside it still holds a promise for (#790). */
export function runGitHub<A>(
  effect: Effect.Effect<A, GitHubFailed | BodyChanged | NotInstalledError>,
  signal?: AbortSignal,
): Promise<A> {
  return Effect.runPromise(effect, { signal })
}

/** A rejection that is not already a `GitHubFailed` is one with status 0: no answer from GitHub. */
function failed(path: string) {
  return (err: unknown): GitHubFailed =>
    err instanceof GitHubFailed
      ? err
      : new GitHubFailed(0, path, (err as Error | null | undefined)?.message ?? String(err))
}

/** The App's JWT, as an Effect: it is signed per use, and a key that will not sign is a failure and not a throw. */
const appJwtEffect = (auth: AppAuth, path: string): Effect.Effect<string, GitHubFailed> =>
  Effect.try({ try: () => appJwt(auth), catch: failed(path) })

/**
 * One request to GitHub — the only place a header is built or a non-2xx is
 * turned into a `GitHubFailed`. A rejection from `fetch`, or a 2xx whose body
 * does not parse, is a `GitHubFailed` with status 0.
 */
export const githubJson = <T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Effect.Effect<T, GitHubFailed> =>
  Effect.gen(function* () {
    // One `tryPromise` owns the signal from the request to the last byte of the
    // body, so an interruption after the headers still aborts the transfer.
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${GITHUB_API}${path}`, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            // GitHub rejects a request with no User-Agent, with a message that
            // does not say so.
            'user-agent': 'lingtai',
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        }).then((response): Promise<{ ok: true; data: unknown } | { ok: false; status: number; text: string }> =>
          !response.ok
            ? response.text().then((text) => ({ ok: false, status: response.status, text }))
            : response.status === 204
              ? Promise.resolve({ ok: true, data: undefined })
              : response.json().then((data: unknown) => ({ ok: true, data })),
        ),
      catch: failed(path),
    })
    if (!result.ok) {
      let message = result.text.slice(0, 400)
      try {
        message = (JSON.parse(result.text) as { message?: string }).message ?? message
      } catch {
        // Not JSON. The raw prefix is more useful than nothing.
      }
      return yield* new GitHubFailed(result.status, path, message)
    }
    return result.data as T
  })

/** Which installation covers a repository, as an Effect. */
export const installationForRepoEffect = (
  auth: AppAuth,
  owner: string,
  repo: string,
): Effect.Effect<Installation, GitHubFailed | NotInstalledError> => {
  const path = `/repos/${owner}/${repo}/installation`
  return appJwtEffect(auth, path).pipe(
    Effect.flatMap((jwt) => githubJson<RawInstallation>('GET', path, jwt)),
    Effect.map((raw) => toInstallation(raw, owner)),
    // 404 here means "no installation covers this repository", which is not the
    // same as "no such repository" and reads very differently to whoever is
    // trying to onboard it.
    Effect.catchIf(
      (err) => err.status === 404,
      () => Effect.fail(new NotInstalledError(owner, repo)),
    ),
  )
}

/** Which installation covers a repository, and what it may do there. */
export function installationForRepo(
  auth: AppAuth,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<Installation> {
  return runGitHub(installationForRepoEffect(auth, owner, repo), signal)
}

/**
 * The permissions ADR 0006 settled on, and why each is needed.
 *
 * Checked at add time rather than discovered as a 403 in the middle of a run —
 * which is exactly how the PAT failure went unexplained for a day.
 */
export const REQUIRED_PERMISSIONS: { name: string; level: 'read' | 'write'; why: string }[] = [
  { name: 'issues', level: 'write', why: 'reading work items, writing agent:* labels and comments' },
  { name: 'contents', level: 'write', why: 'cloning, pushing agent/*, merging into base' },
  { name: 'pull_requests', level: 'write', why: 'opening and reading pull requests' },
  { name: 'workflows', level: 'write', why: 'pushing changes to .github/workflows' },
  { name: 'metadata', level: 'read', why: 'required by GitHub for any App' },
]

export interface PermissionGap {
  name: string
  need: string
  have: string
  why: string
}

/** Every required permission the installation does not actually grant. */
export function permissionGaps(installation: Installation): PermissionGap[] {
  const rank: Record<string, number> = { read: 1, write: 2, admin: 3 }
  return REQUIRED_PERMISSIONS.filter((r) => {
    const have = installation.permissions[r.name]
    return (rank[have ?? ''] ?? 0) < (rank[r.level] ?? 0)
  }).map((r) => ({
    name: r.name,
    need: r.level,
    have: installation.permissions[r.name] ?? 'none',
    why: r.why,
  }))
}

/**
 * What to do about a gap, in order. An installation can only accept what the
 * App already asks for, and a manifest applies only when an App is created — so
 * for an existing App the first step is the App's own permissions page.
 */
export function gapRemedyLines(appSlug: string | null, installationUrl: string | null): string[] {
  const appPage =
    appSlug === null
      ? "the App's permissions page (github.com/settings/apps, or the organisation's equivalent)"
      : `https://github.com/settings/apps/${appSlug}/permissions ` +
        `(an organisation's App: https://github.com/organizations/<org>/settings/apps/${appSlug}/permissions)`
  return [
    `1. If the App does not ask for them yet, add them at ${appPage}.`,
    `2. Then accept the new permissions on the installation: ${installationUrl ?? "the installation's settings page"}.`,
    'Then re-run.',
  ]
}

interface CachedToken {
  token: string
  expiresAtMs: number
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
 * ([0026](../../../doc/decisions-archive/0026-the-conversion-past-the-seam.md)).
 */
export const installationToken = (
  auth: AppAuth,
  installationId: number,
): Effect.Effect<Effect.Effect<string, GitHubFailed>> =>
  Effect.gen(function* () {
    const refreshing = yield* Semaphore.make(1)
    const cached = yield* Ref.make<CachedToken | null>(null)
    const path = `/app/installations/${installationId}/access_tokens`

    const fresh = Effect.map(Ref.get(cached), (c) =>
      c !== null && c.expiresAtMs - Date.now() > 60_000 ? c.token : null,
    )

    // `tryPromise` hands `fetch` a signal that aborts when the fiber is
    // interrupted, which is how a caller's signal stops the request itself.
    const fetchToken = appJwtEffect(auth, path).pipe(
      Effect.flatMap((jwt) => githubJson<{ token: string; expires_at: string }>('POST', path, jwt)),
      Effect.tap((raw) => Ref.set(cached, { token: raw.token, expiresAtMs: Date.parse(raw.expires_at) })),
      Effect.map((raw) => raw.token),
    )

    return Effect.flatMap(fresh, (token) =>
      token !== null
        ? Effect.succeed(token)
        : refreshing.withPermits(1)(
            // Checked again inside the permit: whoever was queued behind the one
            // request wants its answer, not another request.
            Effect.flatMap(fresh, (again) => (again !== null ? Effect.succeed(again) : fetchToken)),
          ),
    )
  })

/** One repository an installation can see. */
export interface VisibleRepository {
  owner: string
  repo: string
  private: boolean
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
  request<T>(method: 'GET', path: string, as: 'app' | number): Promise<T>
}

export function createAppReader(auth: AppAuth): AppReader {
  const tokens = new Map<number, Effect.Effect<string, GitHubFailed>>()
  // A miss yields between the `get` and the `set`, so two first reads for one
  // installation can each build a cache: one extra token request, once per reader.
  const readAsApp = <T>(method: string, path: string, as: 'app' | number): Effect.Effect<T, GitHubFailed> =>
    Effect.gen(function* () {
      if (method !== 'GET') return yield* Effect.die(new Error(`the App reader only reads: refused ${method} ${path}`))
      let token: string
      if (as === 'app') {
        token = yield* appJwtEffect(auth, path)
      } else {
        let source = tokens.get(as)
        if (source === undefined) {
          source = yield* installationToken(auth, as)
          tokens.set(as, source)
        }
        token = yield* source
      }
      return yield* githubJson<T>(method, path, token)
    })
  return {
    request: <T>(method: 'GET', path: string, as: 'app' | number) => runGitHub(readAsApp<T>(method, path, as)),
  }
}

/** GitHub's own page size ceiling, and how far a listing pages before it refuses. */
const PAGE = 100
const MAX_PAGES = 20

/**
 * Every installation of this App — the App's own report.
 *
 * `GET /app/installations`, with the App's JWT. This is also what an
 * `installation_id` arriving on the setup URL is checked against: an id that
 * is not in here is not one of this App's installations, whatever the query
 * string says.
 */
export const appInstallationsEffect = (reader: AppReader): Effect.Effect<Installation[], GitHubFailed> =>
  Effect.gen(function* () {
    const out: Installation[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const path = `/app/installations?per_page=${PAGE}&page=${page}`
      const raw = yield* Effect.tryPromise({
        try: () => reader.request<RawInstallation[]>('GET', path, 'app'),
        catch: failed(path),
      })
      out.push(...raw.map((r) => toInstallation(r)))
      if (raw.length < PAGE) return out
    }
    return yield* new GitHubFailed(
      0,
      '/app/installations',
      `more than ${MAX_PAGES * PAGE} installations — the listing is incomplete`,
    )
  })

export function appInstallations(reader: AppReader): Promise<Installation[]> {
  return Effect.runPromise(appInstallationsEffect(reader))
}

/**
 * What one installation can see.
 *
 * **`GET /installation/repositories`, the blunt endpoint, on purpose.** There
 * are two finer ones — `GET /user/installations` and
 * `GET /user/installations/{id}/repositories` answer *what can this person
 * see*, which is the better question — and both need a **user-to-server
 * token**, which Lingtai does not have: it has no user OAuth, and
 * [0045](../../../doc/decisions-archive/0045-one-team-one-conductor.md) names who is
 * asking as a separate epic. Under one team and one conductor, *what the App
 * can see* is the right answer rather than a compromise. Reach for the `/user/`
 * endpoints and there is no token to call them with.
 */
export const installationRepositoriesEffect = (
  reader: AppReader,
  installationId: number,
): Effect.Effect<VisibleRepository[], GitHubFailed> =>
  Effect.gen(function* () {
    const out: VisibleRepository[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const path = `/installation/repositories?per_page=${PAGE}&page=${page}`
      const raw = yield* Effect.tryPromise({
        try: () =>
          reader.request<{
            repositories: { name: string; owner: { login: string }; private: boolean }[]
          }>('GET', path, installationId),
        catch: failed(path),
      })
      out.push(...raw.repositories.map((r) => ({ owner: r.owner.login, repo: r.name, private: r.private })))
      if (raw.repositories.length < PAGE) return out
    }
    return yield* new GitHubFailed(
      0,
      '/installation/repositories',
      `installation ${installationId} can see more than ${MAX_PAGES * PAGE} repositories — the listing is incomplete`,
    )
  })

export function installationRepositories(reader: AppReader, installationId: number): Promise<VisibleRepository[]> {
  return Effect.runPromise(installationRepositoriesEffect(reader, installationId))
}
