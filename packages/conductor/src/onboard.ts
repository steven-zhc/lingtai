import { type ProjectState, isRegistered } from '@lingtai/domain'
import { baseProtectedRemedies, parsePayload } from '@lingtai/domain'
import { githubApp, githubAuthKind, githubClientAuth } from '@lingtai/env'
import { eventStore } from '@lingtai/event-store'
import {
  GitHubFailed,
  type GhRun,
  type Installation,
  NotInstalledError,
  REQUIRED_PERMISSIONS,
  createGitHubClient,
  gapRemedyLines,
  ghScopeGap,
  ghStatusEffect,
  installationForRepo,
  parseSlug,
  permissionGaps,
} from '@lingtai/github'
import { registerProject, recipePath, HOST_FOR_SAVING, loadProject } from '@lingtai/project'
import { branchOf, type ResolvedRecipe } from '@lingtai/recipe'
/**
 * `lingtai add <owner>/<repo>` — the whole of onboarding.
 *
 * Give it a repository slug and permissions; it does the rest. What it does
 * *not* do is take a configuration file: the recipe is this machine's,
 * `~/.lingtai/<project>/recipe.yml`, and nothing is read from or written to the
 * repository for it (0046 §3, #180).
 *
 * **`governing` below has no caller outside its tests.** It is 0005's read from
 * a branch, and since #180 neither `add` nor the board's `Recheck` reads a
 * recipe from a branch. Nothing depends on it; it is not a thing to extend.
 *
 * The order matters. Permissions are checked *before* anything is written, so a
 * half-onboarded project is not a state that exists. Checked twice, by two
 * callers: `lingtai add` checks before it asks a single question, through
 * `checkInstallation` (#402, `apps/cli/src/add-github.ts`); `add` below checks
 * again before it registers, which is what `recheck` relies on. The failure
 * this guards against is specific: a fine-grained PAT that covered the admin
 * repository's submodule but not the repository itself produced a day of 403s
 * on CI, and nothing anywhere said "wrong scope".
 *
 * The base is not this command's to decide, and `--base` is not a second way of
 * deciding it (#75). The recipe's own `branch.main` says what the base *is*.
 * Given no flag, or a remembered base, this adopts it; given a flag the recipe
 * contradicts, it refuses and names both, because a person typed something
 * specific and must not be silently overridden.
 *
 * **In the conductor rather than in the CLI, because it has two callers**
 * (#163). The board's `Recheck` finishes a pending project (#182) by checking
 * the installation, reading the machine's recipe and appending
 * `ProjectConfigured` — which is
 * precisely this function, and a second implementation of it behind a button
 * would be two ways of registering a project, free to disagree about the base,
 * the permissions checked, or what is said when there is still no recipe there.
 * `lingtai add` is still the command; this is what it runs. What the button
 * replays is the base the wizard recorded, and it arrives as the hint it is
 * rather than as a flag — `resumeOnboarding` below is that whole distinction.
 */
import { Effect } from 'effect'

import { taken } from './pick-repository.ts'
import { signedInHere } from './projects.ts'

/**
 * A port's promise as an Effect whose failure is the rejection itself, never a
 * wrapper: what a caller printed from the promise version is what it prints
 * from this (#1085).
 */
const lift = <A>(f: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: () => f(), catch: (e) => e as Error })

/** A synchronous throw as the same kind of failure. */
const attempt = <A>(f: () => A): Effect.Effect<A, Error> => Effect.try({ try: () => f(), catch: (e) => e as Error })

export interface AddOptions {
  slug: string
  /**
   * Where to *read the recipe from* — a bootstrap hint, not the base. The
   * recipe's `branch.main` decides that, and a `--main` disagreeing with it is
   * refused rather than obeyed (#75). Defaults to the repository's own default
   * branch.
   *
   * `named` is whether a **person** said this branch, and it is the whole of
   * what earns that refusal: a typed `--base` must not be silently overruled,
   * and the way out of it is to re-run without the flag. A branch this system
   * *remembered* — the base a `ProjectOnboardingStarted` recorded, replayed by
   * the board's `Recheck` (#163) — is not named and must not be refused:
   * there is no flag for a button to omit, so the refusal would be permanent
   * and its advice would name something nobody typed. Remembered, the recipe's
   * `branch.main` is adopted from it exactly as it is from the default branch.
   */
  base?: { ref: string; named: boolean }
  /**
   * The installation, when the caller has already asked GitHub for it —
   * `recheck` has, and a second request would ask the same question twice.
   */
  installation?: Installation
  /** Containment floor. `guarded` is what the first project runs at (0007). */
}

/**
 * What finishing a recorded onboarding asks `add` for (#163).
 *
 * One function rather than an object literal at the call site, because the
 * field that matters is the one easiest to get wrong. The board's `Recheck` has
 * a `ProjectOnboardingStarted` and nothing else: the base on it was filled from
 * GitHub's default branch by the wizard, which makes it *exactly* the bootstrap
 * hint `--base` is not. Sent as a named base it would be refused for ever the
 * moment a review corrected `branch.main` in the recipe PR — the card advising an
 * operator to re-run without a flag that a button cannot omit. Sent as what it
 * is, the recipe decides the base, which is #75's rule and not an exception to
 * it.
 */
export function resumeOnboarding(recorded: { owner: string; project: string; base: string }): AddOptions {
  return { slug: `${recorded.owner}/${recorded.project}`, base: { ref: recorded.base, named: false } }
}

/** What pressing `Recheck` came to, in the sentences a person reads. */
export type Rechecked = { ok: true; detail: string } | { ok: false; installed: boolean; detail: string }

export interface RecheckDeps {
  /** `installationForRepo` against the App this machine has. */
  installation: (owner: string, repo: string) => Promise<Installation>
  /** `add`. */
  register: (options: AddOptions, log: (line: string) => void) => ReturnType<typeof addEffect>
}

/**
 * `Recheck`: is the App still installed on this repository, and if so, register
 * it (#182).
 *
 * **Pending waits for `Recheck`, not for a recipe landing in the repository**,
 * which 0046 §3 made impossible. And **not for an installation either**: the
 * wizard writes the recipe on this machine and records the project only through
 * a client built on the App's installation there, and refuses without one — so
 * every pending project had one when it was recorded. What can still refuse is
 * what `add` checks: the installation's permissions, the machine's recipe
 * (`~/.lingtai/config.yml` edited into something invalid since), and the
 * installation itself if it has been removed since. The installation is asked
 * first, and a repository the App can no longer see is answered in its own
 * sentence with nothing written, the card left where it was.
 *
 * Installed, it is `add` with the recorded base as the hint it is
 * (`resumeOnboarding`) and the installation just read, so GitHub is asked once:
 * the scopes, the machine's recipe, `ProjectConfigured`. Nothing here, and
 * nothing `add` does, writes to the repository.
 */
export function recheck(
  recorded: { owner: string; project: string; base: string },
  deps: RecheckDeps = liveRecheckDeps,
): Promise<Rechecked> {
  return Effect.runPromise(recheckEffect(recorded, deps))
}

const liveRecheckDeps: RecheckDeps = {
  installation: (owner, repo) => installationForRepo(githubApp(), owner, repo),
  register: (options, log) => addEffect(options, log),
}

export const recheckEffect = Effect.fn('onboard.recheck')(function* (
  recorded: { owner: string; project: string; base: string },
  deps: RecheckDeps = liveRecheckDeps,
) {
  const slug = `${recorded.owner}/${recorded.project}`
  const installation = yield* lift(() => deps.installation(recorded.owner, recorded.project)).pipe(
    Effect.catch((err) => (err instanceof NotInstalledError ? Effect.succeed(null) : Effect.fail(err))),
  )
  if (installation === null) {
    return {
      ok: false,
      installed: false,
      detail:
        `the GitHub App is not installed on ${slug} — install it on that repository ` +
        '(Settings → GitHub Apps → Configure), then press Recheck. Nothing was written.',
    } satisfies Rechecked as Rechecked
  }

  const said: string[] = []
  const outcome = yield* deps.register({ ...resumeOnboarding(recorded), installation }, (line) => said.push(line))
  if (outcome.ok) return { ok: true, detail: `${recorded.project} is live` } satisfies Rechecked as Rechecked
  // **Everything it said, not the last line.** A permission gap is one line per
  // scope with what each is for; a rule here about which line is the refusal
  // would have to know which failure it was, and would be wrong the first time
  // `add` grows another. This is the transcript a person would have read in
  // the terminal.
  const why = said.filter((l) => l.trim() !== '').join('\n')
  return {
    ok: false,
    installed: true,
    detail: why === '' ? `${recorded.project} could not be registered` : why,
  } satisfies Rechecked as Rechecked
})

const liveLookup = (owner: string, repo: string): Promise<Installation> => installationForRepo(githubApp(), owner, repo)

export const checkInstallationEffect = Effect.fn('onboard.checkInstallation')(function* (
  slug: string,
  log: (line: string) => void,
  known?: Installation,
  lookup: (owner: string, repo: string) => Promise<Installation> = liveLookup,
) {
  const { owner, repo } = yield* attempt(() => parseSlug(slug))

  // 1. Is the App installed here at all? This is the question a PAT cannot be
  //    asked, and the reason 0006 chose an App.
  const installation =
    known ??
    (yield* lift(() => lookup(owner, repo)).pipe(
      Effect.catch((err) => {
        if (!(err instanceof NotInstalledError)) return Effect.fail(err)
        log(err.message)
        return Effect.succeed(null)
      }),
    ))
  if (installation === null) return null
  log(`installation ${installation.id} on ${installation.account} (${installation.repositorySelection})`)

  // 2. Does it grant what Lingtai actually needs? Named individually, with
  //    what each one is for — a gap here becomes a 403 in the middle of a merge.
  const gaps = permissionGaps(installation)
  if (gaps.length > 0) {
    log('the installation is missing permissions:')
    for (const g of gaps) log(`  ${g.name}: have ${g.have}, need ${g.need} — ${g.why}`)
    for (const line of gapRemedyLines(installation.appSlug, installation.htmlUrl)) log(line)
    return null
  }
  log(`permissions: ${describeRequired()}`)

  return installation
})

/** What a `gh` machine's login is allowed to do to one repository. */
export interface GhAccess {
  login: string
  defaultBranch: string | null
}

export interface GhAccessDeps {
  status: () => ReturnType<typeof ghStatusEffect>
  /** `GET /repos/{owner}/{repo}` with the saved login's token. */
  repository: (
    owner: string,
    repo: string,
  ) => Promise<{ archived?: boolean; default_branch?: string; permissions?: { push?: boolean } }>
}

const liveGhAccessDeps = (gh?: GhRun): GhAccessDeps => ({
  status: () => ghStatusEffect(gh),
  // A port's live value, not a function being converted: `.then` here is the promise port, lifted where it is called.
  repository: (owner, repo) =>
    createGitHubClient({ auth: { kind: 'gh' }, owner, repo, ...(gh === undefined ? {} : { gh }) }).then((client) =>
      client.request('GET', `/repos/${owner}/${repo}`),
    ),
})

export const checkGhAccessEffect = Effect.fn('onboard.checkGhAccess')(function* (
  slug: string,
  log: (line: string) => void,
  deps: GhAccessDeps = liveGhAccessDeps(),
) {
  const { owner, repo } = yield* attempt(() => parseSlug(slug))
  const status = yield* deps.status()
  if (!status.ok) {
    log(`${status.detail} — run \`gh auth login\``)
    return null
  }
  const gap = ghScopeGap(status)
  if (gap !== null) {
    log(gap)
    return null
  }
  const read = yield* lift(() => deps.repository(owner, repo)).pipe(
    Effect.map((found) => ({ found }) as const),
    Effect.catch((err) => Effect.succeed({ err } as const)),
  )
  if ('err' in read) {
    const err = read.err
    if (err instanceof GitHubFailed && err.status === 404) {
      log(`${slug} is not visible to ${status.login} — ${err.message}`)
    } else if (
      err instanceof GitHubFailed &&
      err.status === 403 &&
      /OAuth App access restrictions/i.test(err.message)
    ) {
      log(
        `${owner} blocks the GitHub CLI's access to it (${err.message}); this organisation blocks the GitHub ` +
          "CLI's access — use the App (`--github-auth app`)",
      )
    } else if (err instanceof GitHubFailed && err.status === 403 && /SAML/i.test(err.message)) {
      log(
        `${slug} is behind ${owner}'s SAML single sign-on (${err.message}) — authorise gh's token for the ` +
          `${owner} organisation on GitHub, then run this again`,
      )
    } else if (err instanceof GitHubFailed && err.status === 403) {
      log(`${slug} is not visible to ${status.login} — ${err.message}`)
    } else {
      // A 5xx, a failed fetch, or `gh` signed out between the status and the token.
      log(`could not read ${slug} — ${(err as Error).message}`)
    }
    return null
  }
  const found = read.found
  // Before `permissions.push`: an archived repository can still report the
  // caller's role as push.
  if (found.archived === true) {
    log(`${slug} is archived, so nothing can be pushed to it — unarchive it on GitHub first`)
    return null
  }
  if (found.permissions?.push !== true) {
    log(`you (${status.login}) cannot push to ${slug} — ask for write access, or add a repository you can push to`)
    return null
  }
  return { login: status.login, defaultBranch: found.default_branch ?? null }
})

/** `issues, contents, pull requests, workflows write; metadata read`, from the table the check uses. */
function describeRequired(): string {
  const levels = [...new Set(REQUIRED_PERMISSIONS.map((r) => r.level))].sort().reverse()
  return levels
    .map(
      (l) =>
        `${REQUIRED_PERMISSIONS.filter((r) => r.level === l)
          .map((r) => r.name.replace(/_/g, ' '))
          .join(', ')} ${l}`,
    )
    .join('; ')
}

/** What reading the base's protection came to. `unknown` is never *not protected*. */
export type BaseProtection =
  | { kind: 'protected'; by: string }
  | { kind: 'not-protected' }
  | { kind: 'unknown'; why: string }

type Request = <T>(method: string, path: string) => Promise<T>

/**
 * Rules that never refuse a fast-forward push of a merge commit. Every other
 * type — `required_linear_history` among them, since the lane makes a merge
 * commit — and every type not named here counts as protection, so a rule this
 * code has not heard of errs on the warn side.
 */
const HARMLESS_RULES = new Set(['deletion', 'non_fast_forward', 'creation'])

/**
 * Whether `base` refuses a direct push, from the two reads an installation can
 * make without admin permission (#662). Either saying yes is `protected`; a
 * failed read is `unknown` unless the other already said yes.
 */
export const baseProtectionEffect = Effect.fn('onboard.baseProtection')(function* (
  request: Request,
  owner: string,
  repo: string,
  base: string,
) {
  const ref = encodeURIComponent(base)
  // Both reads run, and neither one's failure fails the other.
  const settle = <A>(read: () => Promise<A>) =>
    lift(read).pipe(
      Effect.map((value) => ({ ok: true, value }) as const),
      Effect.catch((reason) => Effect.succeed({ ok: false, reason } as const)),
    )
  const [branch, rules] = yield* Effect.all(
    [
      settle(() => request<{ protected?: boolean }>('GET', `/repos/${owner}/${repo}/branches/${ref}`)),
      settle(() => request<{ type: string }[]>('GET', `/repos/${owner}/${repo}/rules/branches/${ref}`)),
    ],
    { concurrency: 2 },
  )
  if (branch.ok && branch.value.protected === true)
    return { kind: 'protected', by: 'a branch protection rule' } as BaseProtection
  if (rules.ok && Array.isArray(rules.value) && rules.value.some((r) => !HARMLESS_RULES.has(r.type))) {
    return { kind: 'protected', by: 'a ruleset' } as BaseProtection
  }
  if (!branch.ok) return { kind: 'unknown', why: String(branch.reason?.message ?? branch.reason) } as BaseProtection
  if (!rules.ok) return { kind: 'unknown', why: String(rules.reason?.message ?? rules.reason) } as BaseProtection
  return { kind: 'not-protected' } as BaseProtection
})

/** Says what `baseProtection` found, if it is worth saying. Never changes the outcome of `add`. */
export const warnIfProtectedEffect = Effect.fn('onboard.warnIfProtected')(function* (
  request: Request,
  owner: string,
  repo: string,
  base: string,
  log: (line: string) => void,
) {
  const found = yield* baseProtectionEffect(request, owner, repo, base)
  if (found.kind === 'protected') {
    log(`warning: ${base} is protected (${found.by}). ${baseProtectedRemedies(base)}`)
  } else if (found.kind === 'unknown') {
    log(`could not tell whether ${base} is protected (${found.why}). ${baseProtectedRemedies(base)}`)
  }
})

export interface AddDeps {
  auth: () => 'app' | 'gh' | null
  checkGh: (slug: string, log: (line: string) => void) => ReturnType<typeof checkGhAccessEffect>
  check: (
    slug: string,
    log: (line: string) => void,
    known?: Installation,
    lookup?: (owner: string, repo: string) => Promise<Installation>,
  ) => ReturnType<typeof checkInstallationEffect>
}

const liveAddDeps: AddDeps = {
  auth: () => githubAuthKind(),
  checkGh: (slug, log) => checkGhAccessEffect(slug, log),
  check: (slug, log, known, lookup) => checkInstallationEffect(slug, log, known, lookup),
}

/** How this machine reached GitHub for an add: the saved `gh` login (unknown when it said none), or the App. */
export type GithubReach = { kind: 'gh'; login: string | null } | { kind: 'app'; slug: string | null }

/**
 * What `add` came to. `log` is the whole transcript — every line it and its
 * checks said — and a refusal and Recheck's detail are built from it. A success
 * prints none of it: it prints `warnings`, which are reported here separately so
 * nothing downstream tells a warning from the rest by its words (#755).
 */
export type Added = { ok: true; updated: boolean; warnings: readonly string[]; reach: GithubReach } | { ok: false }

export const addEffect = Effect.fn('onboard.add')(function* (
  options: AddOptions,
  log: (line: string) => void = console.log,
  deps: AddDeps = liveAddDeps,
) {
  const { owner, repo } = yield* attempt(() => parseSlug(options.slug))
  const warnings: string[] = []

  // On a `gh` machine there is no installation to ask for: the saved login's
  // scopes and its push right on this repository are the check.
  const onGh = (yield* attempt(() => deps.auth())) === 'gh'
  let installation: Installation | undefined
  let reach: GithubReach
  if (onGh) {
    const access = yield* deps.checkGh(options.slug, log)
    if (access === null) return { ok: false } as Added
    reach = { kind: 'gh', login: access.login === '' ? null : access.login }
  } else {
    const found = yield* deps.check(options.slug, log, options.installation)
    if (found === null) return { ok: false } as Added
    installation = found
    reach = { kind: 'app', slug: found.appSlug }
  }

  const client = yield* lift(() =>
    createGitHubClient({
      auth: onGh ? { kind: 'gh' } : githubClientAuth(),
      owner,
      repo,
      ...(installation === undefined ? {} : { installation }),
    }),
  )

  // 3. The recipe, and with it the base — which is the recipe's, not this
  //    command's. A `--base` a person typed and the file contradicts is refused
  //    by name rather than overruled (#75); a remembered one is a hint, and the
  //    file's `branch.main` is adopted over it (#163).
  const local = yield* loadProject(repo, { signedIn: signedInHere, ...HOST_FOR_SAVING, store: eventStore }).pipe(
    Effect.map((loaded) => ({ recipe: loaded.recipe }) as const),
    Effect.catch((err) => Effect.succeed({ err } as const)),
  )
  if ('err' in local) {
    log(local.err.message)
    return { ok: false } as Added
  }
  const resolved: ResolvedRecipe = local.recipe
  // `--main` names `branch.main` in either mode; in team mode `branchOf` is the personal branch, a different thing.
  if (options.base?.named && options.base.ref !== resolved.recipe.branch.main) {
    const wrote = 'branch.main'
    log(
      `--main ${options.base.ref}, but ${recipePath(repo)} declares ${wrote}: ${resolved.recipe.branch.main}. ` +
        "This command will not overrule either — re-run without --main to take the recipe's, " +
        `or fix ${wrote} in the file.`,
    )
    return { ok: false } as Added
  }
  // Past this point these are one branch, and this one is the file's.
  const base = branchOf(resolved.recipe)
  const fromSha = yield* lift(() => client.refSha(base))
  yield* warnIfProtectedEffect(
    (m, path) => client.request(m, path),
    owner,
    repo,
    base,
    (line) => {
      warnings.push(line)
      log(line)
    },
  )

  const data = yield* attempt(() =>
    parsePayload('ProjectConfigured', {
      project: repo,
      owner,
      // A copy of the recipe's `branch.main`, not a decision taken beside it
      // (#75). Recorded rather than re-derived because a run must not have to
      // ask GitHub which branch governs it; later drift is caught by the run's
      // own refusal rather than manufactured here.
      base,
      configHash: resolved.configHash,
      fromSha,
    }),
  )
  // The owner guard runs inside `registerProject`, on the read whose version the append uses, so two adds of one
  // name by two owners cannot write over the first's identity.
  const registered = yield* registerProject(repo, data, { store: eventStore })
  if (registered.kind === 'taken') {
    log(taken({ slug: options.slug, repo, takenBy: registered.holder }))
    return { ok: false } as Added
  }

  return { ok: true, updated: isRegistered(registered.before), warnings, reach } as Added
})

/**
 * The last line: *added*, or *updated* (#163).
 *
 * The question is whether this project was ever **configured**, and not whether
 * its stream has anything on it. A repository the wizard recorded already has
 * one event — `ProjectOnboardingStarted` — and has never been configured at
 * all, so counting events reports the first registration of every
 * wizard-onboarded repository as an update and swallows the registration
 * summary onboarding exists to print. `isRegistered` is the line
 * `loadProjects` already draws, asked of the stream as it stood before this
 * append.
 */
export function registrationLine(
  before: ProjectState,
  priorEvents: number,
  repo: string,
  resolved: ResolvedRecipe,
): string {
  return isRegistered(before)
    ? `updated ${repo} — its ${priorEvents} earlier event(s) are still on the record`
    : `added ${repo} — ${Object.values(resolved.recipe.steps).flat().length} action(s) across 5 steps`
}

/** What `chooseFirstProject`'s local branch (#394) has already resolved before it registers. */
export interface AddLocalOptions {
  project: string
  base: string
  configHash: string
  fromSha: string
}

export const addLocalEffect = Effect.fn('onboard.addLocal')(function* (
  options: AddLocalOptions,
  resolved: ResolvedRecipe,
  log: (line: string) => void = () => {},
) {
  const data = yield* attempt(() =>
    parsePayload('ProjectConfigured', {
      project: options.project,
      owner: null,
      base: options.base,
      configHash: options.configHash,
      fromSha: options.fromSha,
    }),
  )
  const registered = yield* registerProject(options.project, data, { store: eventStore })
  // `owner: null` has no identity to guard, so `taken` cannot be the answer here.
  if (registered.kind === 'taken')
    return yield* Effect.die(new Error(`${options.project} is held by ${registered.holder}`))
  const line = registrationLine(registered.before, registered.priorEvents, options.project, resolved)
  log(line)
  return { line, updated: isRegistered(registered.before) }
})
