/**
 * Which repositories a person can pick from, on either kind of machine (#969).
 *
 * On an App machine that is what the App's installations can see; on a `gh`
 * machine it is what the saved login can push to. Moved here from the
 * conductor's `pick-repository.ts` so the board's picker and `lingtai add`
 * ask one function.
 *
 * **Nothing is written.** Every read goes through a `GET`-only reader
 * (`AppReader`, `GhReader`), and the registered projects are handed in, already
 * reduced, so they can be *shown* as registered rather than offered twice.
 *
 * **A failed read is a failure, never an empty list.** The `gh` branch fails
 * the whole Effect with one sentence when a page does not answer: an empty
 * `repositories` with `more: false` always means *this login can push to
 * nothing*.
 */
import { randomBytes } from 'node:crypto'

import type { ProjectState } from '@lingtai/domain'
import {
  type AppReader,
  type GhReader,
  type GhStatus,
  type Installation,
  type PermissionGap,
  type VisibleRepository,
  appInstallations,
  ghScopeGap,
  installationRepositories,
  permissionGaps,
} from '@lingtai/github'
import { Effect } from 'effect'

/** One repository on the list, and whether the log already has it. */
export interface ListedRepository extends VisibleRepository {
  slug: string
  /**
   * `registered` has a recipe, `pending` is recorded and waiting for `Recheck` on
   * the board's pending card (#163, #182) — its recipe is already on this machine,
   * and nothing is written to the repository, so there is no pull request —
   * null is offered. A repository that is either of the first two is shown and
   * never offered — a second onboarding of it is a second stream's worth of
   * confusion about one repository.
   *
   * `unrecorded` is a project of this name registered before owners were, when
   * the list cannot vouch that this is the only account with that name — it can
   * see the name under more than one, or an installation would not answer, or
   * the list was cut short: the log cannot say which it is, so none is called
   * onboarded, and none is offered — a project is keyed by the name, so
   * onboarding either writes to that one stream.
   *
   * `taken` is a project of this name recorded under another owner, named in
   * `takenBy`. It is not this repository, and it is not offered either: `add`
   * would write this repository onto that project's stream.
   */
  onboarded: 'registered' | 'pending' | 'unrecorded' | 'taken' | null
  /** The owner of the project that already has this name, when `onboarded` is `taken`. */
  takenBy?: string
}

export interface ListedInstallation {
  installation: Installation
  /**
   * Why GitHub would not list this installation's repositories — a suspended
   * installation refuses its token — or null. One installation that will not
   * answer is a sentence under its own account, never the whole picker.
   */
  unanswered: string | null
  /** `permissionGaps`, named one by one — a gap here is a 403 in the middle of a merge. */
  gaps: PermissionGap[]
  repositories: ListedRepository[]
}

export interface Picker {
  /** Empty is the first-class *not installed yet* screen, not an error. */
  installations: ListedInstallation[]
  /** Where to install the App, with a `state` on it — null when the App's slug is not known. */
  installUrl: string | null
}

/** What a list is, by machine. */
export type RepositoryList =
  | { kind: 'app'; picker: Picker }
  | {
      kind: 'gh'
      login: string
      repositories: ListedRepository[]
      /** The listing stopped at the cap: there are more than these, and the person types `owner/repo` for the rest. */
      more: boolean
    }

/**
 * The install link, with an opaque `state`.
 *
 * `/installations/new` is the only App URL that carries `state` through; the
 * App's bare page drops it. It is sent and never required: the return is
 * resumable without it, so a `state` is a courtesy to whoever reads the setup
 * URL's query and not a check anything depends on.
 */
export function installLink(installUrl: string | null, state = randomBytes(16).toString('base64url')): string | null {
  if (installUrl === null) return null
  const url = new URL(installUrl)
  url.searchParams.set('state', state)
  return url.toString()
}

export const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase()

function onboardedAs(
  projects: readonly ProjectState[],
  repo: VisibleRepository,
  owners: ReadonlySet<string>,
  everyAnswered: boolean,
): Pick<ListedRepository, 'onboarded' | 'takenBy'> {
  // A project is keyed by the repository's name, whoever owns it — so the
  // match is on the name, and the owner only decides whether it is this one.
  const found = projects.find((p) => same(p.project, repo.repo))
  if (found === undefined) return { onboarded: null }
  if (found.owner !== null && !same(found.owner, repo.owner)) return { onboarded: 'taken', takenBy: found.owner }
  // `owner` is null on one registered before it was recorded, and then it only
  // says which repository it is when every read answered and one account has
  // that name.
  if (found.owner === null && (owners.size > 1 || !everyAnswered)) return { onboarded: 'unrecorded' }
  return { onboarded: found.configHash !== null ? 'registered' : 'pending' }
}

/** Which accounts the list can see each repository name under. */
function ownersByName(repositories: Iterable<VisibleRepository>): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>()
  for (const r of repositories) {
    const name = r.repo.toLowerCase()
    owners.set(name, (owners.get(name) ?? new Set()).add(r.owner.toLowerCase()))
  }
  return owners
}

/** One entry of `GET /user/repos`, as far as this reads it. */
interface RawRepository {
  name: string
  owner: { login: string }
  private: boolean
  archived?: boolean | null
  permissions?: { push?: boolean } | null
}

const PAGE = 100
/** 1000 repositories, ten requests: past that the person types `owner/repo`. */
const MAX_PAGES = 10
const AFFILIATION = 'owner,collaborator,organization_member'

export interface ListOptions {
  /** Every project stream reduced — registered and pending alike (`loadAllProjects`). */
  projects: readonly ProjectState[]
  /** `githubAuthKind()` — the caller reads it, this does not read env. */
  auth: 'app' | 'gh'
  app?: {
    reader: AppReader
    /** `offerCreation().installUrl` — the App's own install page, or null. */
    installUrl: string | null
  }
  gh?: {
    /** `ghStatus()`, injected so a test needs no `gh`. */
    status: () => Promise<GhStatus>
    reader: GhReader
  }
}

const listApp = (options: ListOptions, app: NonNullable<ListOptions['app']>) =>
  Effect.gen(function* () {
    const installations = yield* Effect.tryPromise({
      try: () => appInstallations(app.reader),
      catch: (err) => err as Error,
    })
    const fetched = yield* Effect.all(
      installations.map((installation) =>
        Effect.tryPromise({
          try: () => installationRepositories(app.reader, installation.id),
          catch: (err) => err as Error,
        }).pipe(
          Effect.match({
            onSuccess: (repositories) => ({ installation, repositories, unanswered: null as string | null }),
            onFailure: (err) => ({ installation, repositories: [] as VisibleRepository[], unanswered: err.message }),
          }),
        ),
      ),
      { concurrency: 'unbounded' },
    )
    const owners = ownersByName(fetched.flatMap((f) => f.repositories))
    const everyAnswered = fetched.every((f) => f.unanswered === null)
    const listed = fetched.map(({ installation, repositories, unanswered }) => ({
      installation,
      unanswered,
      gaps: permissionGaps(installation),
      repositories: repositories.map((r) => ({
        ...r,
        slug: `${r.owner}/${r.repo}`,
        ...onboardedAs(options.projects, r, owners.get(r.repo.toLowerCase())!, everyAnswered),
      })),
    }))
    const picker: Picker = { installations: listed, installUrl: installLink(app.installUrl) }
    return { kind: 'app', picker } as RepositoryList
  })

const listGh = (options: ListOptions, gh: NonNullable<ListOptions['gh']>) =>
  Effect.gen(function* () {
    const status = yield* Effect.tryPromise({ try: () => gh.status(), catch: (err) => err as Error })
    // The sentences `checkGhAccess` gives: this is the same machine failing the same way.
    if (!status.ok) return yield* Effect.fail(new Error(`${status.detail} — run \`gh auth login\``))
    // Without `repo`, private repositories vanish from `/user/repos` and the list
    // would look short rather than wrong.
    const gap = ghScopeGap(status)
    if (gap !== null) return yield* Effect.fail(new Error(gap))

    const fetched: RawRepository[] = []
    let more = false
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = yield* gh.reader.request<RawRepository[]>(
        `/user/repos?affiliation=${AFFILIATION}&per_page=${PAGE}&page=${page}`,
      )
      fetched.push(...raw)
      if (raw.length < PAGE) break
      if (page === MAX_PAGES) more = true
    }
    // Archived first: an archived repository can still report the caller's role
    // as push. A null `permissions` is unknown, which is not *can push*.
    const pushable = fetched
      .filter((r) => r.archived !== true && r.permissions?.push === true)
      .map((r) => ({ owner: r.owner.login, repo: r.name, private: r.private }))
    const owners = ownersByName(pushable)
    const repositories: ListedRepository[] = pushable.map((r) => ({
      ...r,
      slug: `${r.owner}/${r.repo}`,
      // A capped list cannot vouch that one account owns a name.
      ...onboardedAs(options.projects, r, owners.get(r.repo.toLowerCase())!, !more),
    }))
    return { kind: 'gh', login: status.login, repositories, more } as RepositoryList
  })

/**
 * The repositories to pick from: the App's installations, or the ones the `gh`
 * login can push to, chosen by `options.auth`.
 */
export function listRepositories(options: ListOptions): Effect.Effect<RepositoryList, Error> {
  if (options.auth === 'app') {
    return options.app === undefined
      ? Effect.fail(new Error('listRepositories: an App machine was given no App reader'))
      : listApp(options, options.app)
  }
  return options.gh === undefined
    ? Effect.fail(new Error('listRepositories: a gh machine was given no gh reader'))
    : listGh(options, options.gh)
}
