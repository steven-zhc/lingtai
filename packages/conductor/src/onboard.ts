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
 * deciding it (#75). The recipe's own `repo.base` says what the base *is*.
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
import { type Envelope, type ProjectState, isRegistered, projectStream, reduceProject } from '@lingtai/domain'
import { STEPS, baseProtectedRemedies, parsePayload } from '@lingtai/domain'
import { githubApp, githubAuthKind, githubClientAuth } from '@lingtai/env'
import { eventStore } from '@lingtai/event-store'
import {
  GitHubError,
  type GhRun,
  type Installation,
  NotInstalledError,
  REQUIRED_PERMISSIONS,
  createGitHubClient,
  gapRemedyLines,
  ghScopeGap,
  ghStatus,
  installationForRepo,
  parseSlug,
  permissionGaps,
} from '@lingtai/github'
import {
  RECIPE_PATH,
  baseDivergence,
  baseOf,
  baseWrittenAt,
  boundsBesides,
  kindsOf,
  limitsFor,
  parseDuration,
  recipePath,
  resolveLocalRecipe,
  resolveRecipe,
  type ReadAtRef,
  type ResolvedRecipe,
} from '@lingtai/recipe'

import { passCeiling } from './filter.ts'
import { taken } from './pick-repository.ts'
import { signedInHere } from './projects.ts'

export interface AddOptions {
  slug: string
  /**
   * Where to *read the recipe from* — a bootstrap hint, not the base. The
   * recipe's `repo.base` decides that, and a `--base` disagreeing with it is
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
   * `repo.base` is adopted from it exactly as it is from the default branch.
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
 * moment a review corrected `repo.base` in the recipe PR — the card advising an
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
  register: (options: AddOptions, log: (line: string) => void) => Promise<number>
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
export async function recheck(
  recorded: { owner: string; project: string; base: string },
  deps: RecheckDeps = {
    installation: (owner, repo) => installationForRepo(githubApp(), owner, repo),
    register: add,
  },
): Promise<Rechecked> {
  const slug = `${recorded.owner}/${recorded.project}`
  let installation: Installation
  try {
    installation = await deps.installation(recorded.owner, recorded.project)
  } catch (err) {
    if (!(err instanceof NotInstalledError)) throw err
    return {
      ok: false,
      installed: false,
      detail:
        `the GitHub App is not installed on ${slug} — install it on that repository ` +
        '(Settings → GitHub Apps → Configure), then press Recheck. Nothing was written.',
    }
  }

  const said: string[] = []
  const code = await deps.register({ ...resumeOnboarding(recorded), installation }, (line) => said.push(line))
  if (code === 0) return { ok: true, detail: `${recorded.project} is live` }
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
  }
}

/** The recipe that governs, or the reason this command will not pick one. */
export type Governing =
  | { ok: true; resolved: ResolvedRecipe; adoptedFrom: string | null }
  | { ok: false; refusal: string }

/**
 * Find the recipe from a branch; take the base from the recipe.
 *
 * `from.ref` is only where to look. What comes back is resolved at
 * `baseOf(recipe)` and nowhere else, so the base recorded by `lingtai add` is
 * a copy of the file's and never a second decision beside it (#75). Three
 * outcomes, one per row of the ticket's table:
 *
 * - the file at `from.ref` declares that same branch — nothing to reconcile;
 * - it declares another and nobody named `from.ref` — bootstrap: read it again
 *   there, and take that;
 * - it declares another and a person named `from.ref` — refuse. Two people have
 *   now stated the base, and only one of them owns that decision under
 *   [0005](../../../doc/decisions-archive/0005-config-in-target-repo.md); this command
 *   is not entitled to overrule either of them silently.
 *
 * The first read throws (`RecipeMissingError`, `RecipeInvalidError`) so the
 * caller can say the "nothing named a base" sentence about it. The second is
 * returned as a refusal instead: it is a branch this command chose to follow,
 * and the message has to say that is what happened.
 */
export async function governing(
  read: ReadAtRef,
  from: { ref: string; named: boolean },
  slug: string,
): Promise<Governing> {
  const resolved = await resolveRecipe(read, from.ref)
  const declared = baseOf(resolved.recipe)
  // The key as this recipe writes it: `repo.base`, or `worktree:`'s at `admit`
  // where the setting has moved onto the step that owns it (`#268`).
  const wrote = baseWrittenAt(resolved.recipe)
  if (declared === from.ref) return { ok: true, resolved, adoptedFrom: null }

  if (from.named) {
    return {
      ok: false,
      refusal:
        `--base ${from.ref}, but ${RECIPE_PATH} there declares ${wrote}: ${declared}. ` +
        `--base says which branch to read the recipe from; ${wrote} says which branch ` +
        'it governs, and this command will not overrule either. ' +
        `Re-run without --base to take ${declared} from the recipe, ` +
        `or fix ${wrote} on ${from.ref}.`,
    }
  }

  let atDeclared: ResolvedRecipe
  try {
    atDeclared = await resolveRecipe(read, declared)
  } catch (err) {
    return {
      ok: false,
      refusal:
        `${RECIPE_PATH} on ${from.ref} declares ${wrote}: ${declared}, ` +
        `so the recipe was read from ${declared} — ${(err as Error).message}`,
    }
  }
  // The file it points at has to point at itself. A chain is not a bootstrap:
  // one hop is "the default branch is not the base", two is a recipe that
  // disagrees with the branch it is on, which is `baseDivergence` exactly.
  const divergence = baseDivergence(atDeclared, slug)
  if (divergence) return { ok: false, refusal: divergence }
  return { ok: true, resolved: atDeclared, adoptedFrom: from.ref }
}

/**
 * Steps 1 and 2 of onboarding, and the whole of what a check needs before a
 * recipe can be asked about or written: is the App installed on this
 * repository, and does it grant what Lingtai needs. Lifted out of `add` so
 * `askBeforeGithubAdd` (`apps/cli/src/add-github.ts`) can run it before it
 * asks a single question or writes a single answer (#402) — not just before
 * `add` reads or registers a recipe, which is as far as `add` alone ever
 * reached.
 *
 * `known` skips the lookup, exactly as `options.installation` does in `add`
 * below, but never the permission check: a `Recheck` or an early check that
 * already asked GitHub for the installation must not be allowed to also skip
 * asking whether it grants what Lingtai needs.
 *
 * Returns the installation on success, or null having already logged the same
 * lines `add` always has — `NotInstalledError`'s message, or the gap list
 * ending "Fix them in the App's settings, then re-run." Any other error is
 * rethrown rather than read as "not installed": a 502 is not a missing
 * installation, and swallowing it here would hide an outage behind onboarding
 * advice that does not apply.
 */
export async function checkInstallation(
  slug: string,
  log: (line: string) => void,
  known?: Installation,
  lookup: (owner: string, repo: string) => Promise<Installation> = (owner, repo) =>
    installationForRepo(githubApp(), owner, repo),
): Promise<Installation | null> {
  const { owner, repo } = parseSlug(slug)

  // 1. Is the App installed here at all? This is the question a PAT cannot be
  //    asked, and the reason 0006 chose an App.
  let installation = known
  try {
    installation ??= await lookup(owner, repo)
  } catch (err) {
    if (err instanceof NotInstalledError) {
      log(err.message)
      return null
    }
    throw err
  }
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
}

/** What a `gh` machine's login is allowed to do to one repository. */
export interface GhAccess {
  login: string
  defaultBranch: string | null
}

export interface GhAccessDeps {
  status: typeof ghStatus
  /** `GET /repos/{owner}/{repo}` with the saved login's token. */
  repository: (
    owner: string,
    repo: string,
  ) => Promise<{ archived?: boolean; default_branch?: string; permissions?: { push?: boolean } }>
}

const liveGhAccessDeps = (gh?: GhRun): GhAccessDeps => ({
  status: () => ghStatus(gh),
  repository: async (owner, repo) =>
    (await createGitHubClient({ auth: { kind: 'gh' }, owner, repo, ...(gh === undefined ? {} : { gh }) })).request(
      'GET',
      `/repos/${owner}/${repo}`,
    ),
})

/**
 * `checkInstallation`'s counterpart on a `gh` machine (ADR 0114 §8): the saved
 * login has `repo` and `workflow`, and can push to this repository. Logs its
 * lines and returns null having refused, as `checkInstallation` does; logs
 * nothing on success.
 *
 * Scopes are checked before the repository is read, because without `repo` a
 * private repository answers 404 and the refusal would blame visibility for
 * what is a missing scope. Each failure is named from the response's own
 * `message` and never guessed: a 404, an organisation's OAuth-app restriction,
 * SAML enforcement and any other 403 are four different sentences, and a read
 * that failed on the network is never reported as no access.
 */
export async function checkGhAccess(
  slug: string,
  log: (line: string) => void,
  deps: GhAccessDeps = liveGhAccessDeps(),
): Promise<GhAccess | null> {
  const { owner, repo } = parseSlug(slug)
  const status = await deps.status()
  if (!status.ok) {
    log(`${status.detail} — run \`gh auth login\``)
    return null
  }
  const gap = ghScopeGap(status)
  if (gap !== null) {
    log(gap)
    return null
  }
  let found: Awaited<ReturnType<GhAccessDeps['repository']>>
  try {
    found = await deps.repository(owner, repo)
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      log(`${slug} is not visible to ${status.login} — ${err.message}`)
    } else if (err instanceof GitHubError && err.status === 403 && /OAuth App access restrictions/i.test(err.message)) {
      log(
        `${owner} blocks the GitHub CLI's access to it (${err.message}); this organisation blocks the GitHub ` +
          "CLI's access — use the App (`--github-auth app`)",
      )
    } else if (err instanceof GitHubError && err.status === 403 && /SAML/i.test(err.message)) {
      log(
        `${slug} is behind ${owner}'s SAML single sign-on (${err.message}) — authorise gh's token for the ` +
          `${owner} organisation on GitHub, then run this again`,
      )
    } else if (err instanceof GitHubError && err.status === 403) {
      log(`${slug} is not visible to ${status.login} — ${err.message}`)
    } else {
      // A 5xx, a failed fetch, or `gh` signed out between the status and the token.
      log(`could not read ${slug} — ${(err as Error).message}`)
    }
    return null
  }
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
}

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
export async function baseProtection(
  request: Request,
  owner: string,
  repo: string,
  base: string,
): Promise<BaseProtection> {
  const ref = encodeURIComponent(base)
  const [branch, rules] = await Promise.allSettled([
    request<{ protected?: boolean }>('GET', `/repos/${owner}/${repo}/branches/${ref}`),
    request<{ type: string }[]>('GET', `/repos/${owner}/${repo}/rules/branches/${ref}`),
  ])
  if (branch.status === 'fulfilled' && branch.value.protected === true)
    return { kind: 'protected', by: 'a branch protection rule' }
  if (
    rules.status === 'fulfilled' &&
    Array.isArray(rules.value) &&
    rules.value.some((r) => !HARMLESS_RULES.has(r.type))
  ) {
    return { kind: 'protected', by: 'a ruleset' }
  }
  if (branch.status === 'rejected') return { kind: 'unknown', why: String(branch.reason?.message ?? branch.reason) }
  if (rules.status === 'rejected') return { kind: 'unknown', why: String(rules.reason?.message ?? rules.reason) }
  return { kind: 'not-protected' }
}

/** Says what `baseProtection` found, if it is worth saying. Never changes the outcome of `add`. */
export async function warnIfProtected(
  request: Request,
  owner: string,
  repo: string,
  base: string,
  log: (line: string) => void,
): Promise<void> {
  const found = await baseProtection(request, owner, repo, base)
  if (found.kind === 'protected') {
    log(`warning: ${base} is protected (${found.by}). ${baseProtectedRemedies(base)}`)
  } else if (found.kind === 'unknown') {
    log(`could not tell whether ${base} is protected (${found.why}). ${baseProtectedRemedies(base)}`)
  }
}

export interface AddDeps {
  auth: () => 'app' | 'gh' | null
  checkGh: (slug: string, log: (line: string) => void) => Promise<GhAccess | null>
  check: typeof checkInstallation
}

const liveAddDeps: AddDeps = {
  auth: () => githubAuthKind(),
  checkGh: (slug, log) => checkGhAccess(slug, log),
  check: checkInstallation,
}

export async function add(options: AddOptions, log = console.log, deps: AddDeps = liveAddDeps): Promise<number> {
  const { owner, repo } = parseSlug(options.slug)

  // On a `gh` machine there is no installation to ask for: the saved login's
  // scopes and its push right on this repository are the check.
  const onGh = deps.auth() === 'gh'
  let installation: Installation | undefined
  if (onGh) {
    if ((await deps.checkGh(options.slug, log)) === null) return 1
  } else {
    const found = await deps.check(options.slug, log, options.installation)
    if (found === null) return 1
    installation = found
  }

  const client = await createGitHubClient({
    auth: onGh ? { kind: 'gh' } : githubClientAuth(),
    owner,
    repo,
    ...(installation === undefined ? {} : { installation }),
  })
  log(`reading ${recipePath(repo)} — the recipe is this machine's, and nothing is read from the repository (0046 §3)`)

  // 3. The recipe, and with it the base — which is the recipe's, not this
  //    command's. A `--base` a person typed and the file contradicts is refused
  //    by name rather than overruled (#75); a remembered one is a hint, and the
  //    file's `repo.base` is adopted over it (#163).
  let resolved: ResolvedRecipe
  try {
    resolved = await resolveLocalRecipe(repo, { signedIn: signedInHere })
  } catch (err) {
    log((err as Error).message)
    return 1
  }
  if (options.base?.named && options.base.ref !== baseOf(resolved.recipe)) {
    const wrote = baseWrittenAt(resolved.recipe)
    log(
      `--base ${options.base.ref}, but ${recipePath(repo)} declares ${wrote}: ${baseOf(resolved.recipe)}. ` +
        "This command will not overrule either — re-run without --base to take the recipe's, " +
        `or fix ${wrote} in the file.`,
    )
    return 1
  }
  // Past this point these are one branch, and this one is the file's.
  const base = baseOf(resolved.recipe)
  log(`base: ${base} — the recipe's ${baseWrittenAt(resolved.recipe)}`)
  // The run's own settings, and each dispatching step's runtime (`#372`) — the
  // recipe's answer to *what will run*, read off it alone.
  for (const [key, from] of Object.entries(resolved.provenance ?? {})) {
    if (key.startsWith('runtime.') || /^steps\.[a-z]+\.agent$/.test(key)) log(`  ${key.padEnd(24)} ${from}`)
  }

  const fromSha = await client.refSha(base)
  await warnIfProtected((m, path) => client.request(m, path), owner, repo, base, log)
  log(`recipe: ${recipePath(repo)} for ${base}@${fromSha.slice(0, 7)} — hash ${resolved.configHash.slice(0, 12)}`)
  // All ten steps, including the empty ones. Onboarding is the first place a
  // person sees the shape of their workflow, and a step that is not mentioned
  // is exactly the thing that must not be invisible (ADR 0016 §4, 0061 §5).
  //
  // From `STEPS` rather than a list written here, which is what that tuple is
  // exported for: this line had its own copy of the five names, and renaming
  // one of them (0018) would have left onboarding printing a step that no
  // longer exists. Widening the set to ten (0058 §3) collected on that: this
  // line prints all ten without being touched.
  for (const step of STEPS) {
    const actions = resolved.recipe.steps[step]
    log(`  ${step.padEnd(9)} ${actions.length ? actions.map((a) => a.name).join(', ') : '(skipped)'}`)
  }
  // Printed here for the reason the empty points above are: a policy that is
  // only visible when it fires is one nobody can audit, and this one spends an
  // agent's worth of money on a failure without being asked again
  // ([0025](../../../doc/decisions-archive/0025-a-failure-buys-one-agent.md) §2).
  //
  // **The product, not the numbers that make it**
  // ([0039](../../../doc/decisions-archive/0039-the-worktree-is-the-whole-of-a-pass.md) §3).
  // There were two ceilings here and they were printed side by side, which told
  // a reader everything except the thing being decided: what one pass of this
  // project can cost. One sentence, from `passCeiling`, so this line and the
  // drain's cannot say different things about the same recipe.
  log(
    `  ${'a pass'.padEnd(9)} ${passCeiling({
      ...limitsFor(resolved.recipe, 'implement'),
      wallMs: parseDuration(limitsFor(resolved.recipe, 'implement').wall),
      // The steps bounded differently from `implement`, so `lingtai add` answers
      // *what do `proposed:` and `merge:` say today* about money too (`#314`).
      steps: boundsBesides(resolved.recipe, 'implement'),
    })}`,
  )
  log(`  runtime ${resolved.recipe.runtime.agent}, kinds ${kindsOf(resolved.recipe).join(' > ')}`)

  log(`  tier ${resolved.recipe.runtime.tier}`)

  const stream = projectStream(repo)
  const existing = await eventStore.read(stream)
  // The owner guard at the write itself: a check made earlier (the picker's, or
  // `runGithubBranch`'s under `gh`) can be passed by two adds at once, and the
  // append below is optimistic on the version read here, so this read is the
  // one that decides — a later add of the same name by another owner is refused
  // rather than written over the first's identity.
  const holder = otherOwner(existing, owner)
  if (holder !== null) {
    log(taken({ slug: options.slug, repo, takenBy: holder }))
    return 1
  }
  await eventStore.append(stream, existing.length === 0 ? 0 : existing[existing.length - 1]!.version, [
    {
      type: 'ProjectConfigured',
      actor: 'conductor',
      data: parsePayload('ProjectConfigured', {
        project: repo,
        owner,
        // A copy of the recipe's `repo.base`, not a decision taken beside it
        // (#75). Recorded rather than re-derived because a run must not have to
        // ask GitHub which branch governs it; later drift is caught by the run's
        // own refusal rather than manufactured here.
        base,
        configHash: resolved.configHash,
        fromSha,
      }),
    },
  ])

  log(registrationLine(existing, repo, resolved))
  return 0
}

/** Who already holds this project's stream, when it is not `owner` (compared in any case); else null. */
export function otherOwner(prior: readonly Envelope[], owner: string): string | null {
  const holder = reduceProject(prior).owner
  return holder !== null && holder.toLowerCase() !== owner.toLowerCase() ? holder : null
}

/**
 * The last line: *added*, or *updated* (#163).
 *
 * The question is whether this project was ever **configured**, and not whether
 * its stream has anything on it. A repository the wizard recorded already has
 * one event — `ProjectOnboardingStarted` — and has never been configured at
 * all, so counting events reports the first registration of every
 * wizard-onboarded repository as an update and swallows the tier-and-gates
 * summary onboarding exists to print. `isRegistered` is the line
 * `loadProjects` already draws, asked of the stream as it stood before this
 * append.
 */
export function registrationLine(prior: readonly Envelope[], repo: string, resolved: ResolvedRecipe): string {
  const before: ProjectState = reduceProject(prior)
  return isRegistered(before)
    ? `updated ${repo} — its ${prior.length} earlier event(s) are still on the record`
    : `added ${repo} — tier ${resolved.recipe.runtime.tier}, ${Object.values(resolved.recipe.steps).flat().length} action(s) across 5 steps`
}

/** What `chooseFirstProject`'s local branch (#394) has already resolved before it registers. */
export interface AddLocalOptions {
  project: string
  base: string
  configHash: string
  fromSha: string
}

/**
 * The directory branch of onboarding (#394): `owner: null`, no installation to
 * check and no permissions to ask GitHub for — the recipe was already read and
 * resolved by `chooseFirstProject`, which is why this takes it rather than
 * reading it again.
 *
 * The same stream-version append `add` makes, and the same `registrationLine`,
 * so the two ways of registering a project cannot disagree about either.
 */
export async function addLocal(
  options: AddLocalOptions,
  resolved: ResolvedRecipe,
  log: (line: string) => void = console.log,
): Promise<string> {
  const stream = projectStream(options.project)
  const existing = await eventStore.read(stream)
  await eventStore.append(stream, existing.length === 0 ? 0 : existing[existing.length - 1]!.version, [
    {
      type: 'ProjectConfigured',
      actor: 'conductor',
      data: parsePayload('ProjectConfigured', {
        project: options.project,
        owner: null,
        base: options.base,
        configHash: options.configHash,
        fromSha: options.fromSha,
      }),
    },
  ])
  const line = registrationLine(existing, options.project, resolved)
  log(line)
  return line
}
