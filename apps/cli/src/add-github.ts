/**
 * What `lingtai add` checks, asks and writes before a GitHub project is
 * registered (#398, #399, #402), once a slug is known. Its own module because
 * `lingtai.ts`'s last lines call `main()` on import, so a unit test cannot
 * import this out of it.
 *
 * In order: `--land` against `--base`; then — before a single question is
 * asked or a single answer written: on a `gh` machine, whether the saved
 * login has `repo` and `workflow` and can push to the repository (#708); on an
 * App machine, whether the App is installed here and grants what Lingtai
 * needs (#402); then one `askRecipe` call (#431) asks the writer and
 * reviewer, the install and build commands, the ticket source and the kinds
 * (#396), the landing branch and the limits, in that order. **An absent
 * recipe is created once, with every one of those first-run answers and the
 * seeds below — `repo.base` and `env.plantAt` — rather than refused (#432).**
 * **Nothing is written here (#968):** the answers are
 * collected and returned, and `applySetup` writes them once, just before the registration. With
 * nothing configured at a terminal, every question below still runs: a recipe
 * written for a project whose App does not exist yet is what lets
 * `chooseFirstProject` offer to create it next, in the same run. With nothing
 * configured and no terminal, or a refused `github.auth`, it stops first. Null to go on to the
 * registration, or the exit code to stop with. A local project, and a
 * GitHub one picked on the board, reach none of this yet.
 */
import { checkGhAccessEffect, checkInstallationEffect, type GhAccess } from '@lingtai/conductor/onboard'
import { alreadyOnboarded, choose, type Choice, refusalLines } from '@lingtai/conductor/pick-repository'
import { sandboxHostHere } from '@lingtai/conductor/projects'
import { liveHistoryEffect } from '@lingtai/conductor/ticket-history'
import { githubApp, githubAuthKind, githubClientAuth, hasGitHubApp, stateDir } from '@lingtai/env'
import { createGitHubClient, GitHubFailed, type Installation, installationForRepo, parseSlug } from '@lingtai/github'
import {
  diskFiles,
  readRecipeKeyEffect,
  recipePath,
  type RecipeChange,
  type RecipeFiles,
  resolveSource,
} from '@lingtai/recipe'
import { type Answers, EMPTY_SETUP_READER, type Picker, type ProposalReaders, type SetupReader } from '@lingtai/setup'
import { askRuntimesEffect, proposeSetup, type RuntimeFound } from '@lingtai/setup'
import { liveMachineText, liveTrialBuild, previewSetup } from '@lingtai/setup'
import { Effect } from 'effect'

import { askClaudeTokenForRecipe, liveClaudeTokenWorld } from './claude-token.ts'
import { lift, recovering } from './exit.ts'
import { livePickerEffect } from './first-project.ts'
import { interactivity, liveAsk, liveSpin } from './prompt.ts'
import type { QuestionWorld } from './question.ts'
import { ADD_KEPT, askRecipeEffect, ENV_PLANT_AT } from './recipe-flow.ts'
import type { TrialOutcome } from './setup-build.ts'

/**
 * How this machine reaches the repository: through the App's installation on
 * it, or through the saved `gh` login, which has none.
 */
export type Reach = { kind: 'app'; installation: Installation } | { kind: 'gh' }

/**
 * The repository's default branch, through the same calls `checkInstallation`
 * and `add()` make to read it. Three callers read it, through the one
 * memoized `defaultBranch` closure below: the `repo.base` seed on an absent
 * file, where a null answers the *pass --base* refusal (#432); the fallback
 * for the land question's own default, where a failure is harmless, since a
 * question's `detected` is just one more thing a person can type past
 * (#399); and the ref `liveGithubReader` reads the repository's files at,
 * where a failure is not harmless — `null` there means nothing is read, and
 * `detectSetup` suggests no install or build command at all (see the comment
 * above `liveGithubReader`). Answered null on any failure either way; the
 * callers differ in what null costs them.
 *
 * `installation`, when the caller already asked GitHub for it — the early
 * check below has, and a second request would ask the same question again
 * for no reason (#402).
 */
const defaultBranchOf = (owner: string, repo: string, reach?: Reach): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if (reach?.kind === 'gh') {
      const client = yield* lift(() => createGitHubClient({ auth: { kind: 'gh' }, owner, repo }))
      return yield* lift(() => client.defaultBranch())
    }
    // `githubApp()` throws where no App is configured — the ordinary case, a defect here and answered null below.
    const auth = githubApp()
    const resolved = reach?.installation ?? (yield* lift(() => installationForRepo(auth, owner, repo)))
    const client = yield* lift(() => createGitHubClient({ auth, owner, repo, installation: resolved }))
    return yield* lift(() => client.defaultBranch())
  }).pipe(recovering(() => Effect.succeed(null)))

/**
 * `askRecipe`'s `reader`, over a GitHub ref — `has` through the raw contents
 * endpoint rather than `fileAt`, for `detect-setup.ts`'s own reason: the
 * contents API leaves `content` empty for a file between 1 and 100 MB, and a
 * `has` built on `fileAt` alone would call the biggest lockfiles absent.
 *
 * With no reach (no installation on an App machine), no ref, or any failure
 * building the client, every question still runs — an empty reader's `has` rejects rather than
 * resolving `false`, so `detectSetup` reads it as "could not tell" rather
 * than a confirmed absence (#431 fix round, finding 2); a detection
 * suggestion is never worth failing the whole setup over, and
 * `detectInstall`/`detectSetup` catch that rejection rather than letting it
 * reach this function's own caller.
 */
const liveGithubReader = (
  owner: string,
  repo: string,
  reach: Reach | undefined,
  ref: string | null,
): Effect.Effect<SetupReader> => {
  if (reach === undefined || ref === null) return Effect.succeed(EMPTY_SETUP_READER)
  return Effect.gen(function* () {
    const client = yield* lift(() =>
      reach.kind === 'gh'
        ? createGitHubClient({ auth: { kind: 'gh' }, owner, repo })
        : createGitHubClient({ auth: githubApp(), owner, repo, installation: reach.installation }),
    )
    return {
      has: (path) =>
        Effect.tryPromise({
          try: () => client.request('GET', `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`),
          catch: (err) => err,
        }).pipe(
          Effect.as(true),
          // A missing file is an answer; anything else (a 403, a 500) is not
          // one — `fileAt` draws the same line at `client.ts:420`, and
          // swallowing both the same way read a transient failure as a
          // confirmed absence (#431 fix round, finding 2).
          Effect.catchIf(
            (err) => err instanceof GitHubFailed && err.status === 404,
            () => Effect.succeed(false),
          ),
        ),
      read: (path) =>
        Effect.tryPromise(() => client.fileAt(path, ref)).pipe(Effect.orElseSucceed((): string | null => null)),
    } satisfies SetupReader
  }).pipe(recovering(() => Effect.succeed(EMPTY_SETUP_READER)))
}

export interface AskBeforeGithubAddDeps {
  check: typeof checkInstallationEffect
  /** The machine's elected auth — `null` where nothing is configured. Throws where `github.auth` is refused. */
  auth: () => 'app' | 'gh' | null
  /** Whether there is a terminal to ask at. */
  interactive: () => boolean
  /** On a `gh` machine, `check`'s counterpart: scopes, then `GET /repos` and `permissions.push`. */
  ghAccess: (slug: string, log: (line: string) => void) => Effect.Effect<GhAccess | null, unknown>
  /**
   * `choose()`'s own picker — asked only once `deps.check` has already
   * refused, to turn that refusal into the sentence and deep link
   * `runGithubBranch`'s slug path would have given it (#402 fix round 3,
   * `pick-repository.ts:199`). Never asked on the path that succeeds, so a
   * successful add costs no second request.
   */
  picker: () => Effect.Effect<Picker, unknown>
  files: RecipeFiles
  reader: (
    owner: string,
    repo: string,
    reach: Reach | undefined,
    ref: string | null,
  ) => Effect.Effect<SetupReader, unknown>
  ask: QuestionWorld['ask']
  spin?: QuestionWorld['spin']
  /** `askRecipe`'s `runtimes` — already probed, never by this function itself. */
  runtimes: () => Effect.Effect<readonly RuntimeFound[], unknown>
  /** `askRecipe`'s `history` — `ticket-<project>-*` streams already in the log for this project. */
  history: (project: string) => Effect.Effect<readonly string[], unknown>
  /** Asks for the sandboxed Claude Code token once the recipe is final (#1169); absent asks nothing, and it never refuses the add. */
  claudeToken?: (recipe: Parameters<typeof askClaudeTokenForRecipe>[1]) => Effect.Effect<void, unknown>
  /** The host check for the sandbox step (#1160), read only for a recipe that is new; absent asks no sandbox question. */
  sandboxHost?: () => NonNullable<ProposalReaders['host']>
}

const liveDeps: AskBeforeGithubAddDeps = {
  check: checkInstallationEffect,
  auth: () => githubAuthKind(),
  interactive: () => {
    const how = interactivity(false)
    return how.stdinIsTTY && how.stdoutIsTTY
  },
  ghAccess: (slug, log) => checkGhAccessEffect(slug, log),
  picker: livePickerEffect,
  files: diskFiles,
  reader: liveGithubReader,
  ask: liveAsk,
  spin: liveSpin,
  runtimes: askRuntimesEffect,
  history: liveHistoryEffect,
  sandboxHost: () => sandboxHostHere(),
  claudeToken: (recipe) =>
    askClaudeTokenForRecipe(
      liveClaudeTokenWorld({
        ask: liveAsk,
        log: (line) => console.log(line),
        machine: liveMachineText(),
        interactive: interactivity(false).stdinIsTTY && interactivity(false).stdoutIsTTY,
      }),
      recipe,
    ),
}

/** What the questions came to when the add goes on: the trial and the hints, for the card `add` ends on. */
export interface AskedBeforeAdd {
  trial: TrialOutcome
  hints: string[]
  /** The runtimes it probed, so the card does not probe them again. */
  runtimes: readonly RuntimeFound[]
  /** What the questions decided; nothing is on disk until `applySetup` writes it, just before the registration. */
  answers: Answers
}

/** An Effect settled to the value or what it threw: a failure and a defect alike, an interruption never. */
export const attempt = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.map((ok) => ({ ok }) as const),
    recovering((threw) => Effect.succeed({ threw } as const)),
  )

/** A number is an exit code: the add stops there. Otherwise the add goes on. */
export const askBeforeGithubAddEffect = Effect.fn('add-github.askBeforeGithubAdd')(function* (
  slug: string,
  flags: Record<string, string>,
  deps: AskBeforeGithubAddDeps = liveDeps,
  /** Every `--build <cmd>` on the command line, in order — `flags['build']` alone is only the last (#431 fix round, finding 3). */
  buildFlags: readonly string[] = [],
): Effect.fn.Return<number | AskedBeforeAdd, unknown> {
  // Tier, gates and the base are the recipe's, in the managed repository, which
  // is why this takes a slug and — at most — the branch to find the file on.
  // `named`, because a person typed it here: a recipe that contradicts `--base`
  // is refused rather than adopted (#75), which is a refusal only a typed flag
  // may earn.
  const base = flags['base']
  const land = flags['land']
  // `--land <branch>` and `--base` are different questions — where to read the
  // recipe from, and what it should land on — and a person who named both must
  // not have one silently overrule the other (#399, mirroring #75's rule for
  // `--base` against the recipe's own `repo.base`).
  if (base !== undefined && land !== undefined && land !== 'hold' && land !== base) {
    console.error(
      `--land ${land} and --base ${base} name two different branches, and this command will not pick one ` +
        'silently. Nothing was written',
    )
    return 2
  }

  const { owner, repo } = parseSlug(slug)

  // Nothing configured at a terminal: there is nothing yet to check —
  // `checkInstallation`'s default lookup calls `githubApp()`, which throws
  // rather than answering "not installed". The questions below still run and
  // still write, exactly as this command did before #402: a recipe written for
  // a project whose App was never created is what lets `chooseFirstProject`
  // offer to create one next, in the same run. With no terminal and nothing
  // configured it is refused above, and a refused `github.auth` likewise.
  //
  // Is the App installed here at all, and does it grant what Lingtai needs —
  // checked before a single question is asked or a single answer written
  // (#402), when the App is the auth. The check prints nothing on
  // success; `add()` runs the same check again later and prints its own
  // lines through `runGithubBranch`'s `said`, and printing them here too
  // would show every successful add the same two lines twice.
  const elected = yield* attempt(Effect.try({ try: () => deps.auth(), catch: (err) => err }))
  if ('threw' in elected) {
    console.error(`${elected.threw.message}. Nothing was written`)
    return 1
  }
  let kind: 'app' | 'gh' | null = elected.ok
  // `--github-auth gh` answers the machine's question here too: the login is
  // checked below, before any recipe question, and `runGithubBranch` writes it.
  const authFlag = flags['github-auth']
  if (kind === null && authFlag === 'gh') kind = 'gh'
  if (kind === null && authFlag === undefined && !deps.interactive()) {
    console.error('no GitHub auth is configured here — run lingtai init. Nothing was written')
    return 1
  }

  // On a `gh` machine the saved login is the check: its scopes and its push
  // right on this repository, read before anything is asked or written. The
  // App is never consulted — a machine with a full App and `auth: gh` is a
  // `gh` machine. `reach` is how the repository is read from here on.
  let reach: Reach | undefined
  let ghDefaultBranch: string | null = null
  if (kind === 'gh') {
    const checked: string[] = []
    const read = yield* attempt(deps.ghAccess(slug, (line) => checked.push(line)))
    let access: GhAccess | null = null
    if ('threw' in read) checked.push(`could not check ${slug} — ${read.threw.message}`)
    else access = read.ok
    if (access === null) {
      console.error(`${checked.filter((l) => l.trim() !== '').join('\n')}. Nothing was written`)
      return 1
    }
    reach = { kind: 'gh' }
    ghDefaultBranch = access.defaultBranch
  }

  if (kind !== 'gh' && hasGitHubApp()) {
    const checked: string[] = []
    const looked = yield* attempt(deps.check(slug, (line) => checked.push(line)))
    if ('threw' in looked) {
      // `githubApp()`, inside `deps.check`'s lookup, rethrows anything that
      // is not `NotInstalledError` — a malformed key, a revoked key (401), an
      // unreachable GitHub. `runGithubBranch`'s own `app.configured &&
      // !app.ok` guard named this the same way before #402 moved the check
      // ahead of it on `lingtai add`'s path; `lingtai init` still reaches
      // that guard through `chooseFirstProject` (`init.ts:461`), which never
      // calls this function, so this is only the place *this* command
      // names it.
      console.error(
        `the GitHub App configured here does not answer — ${looked.threw.message}. Fix its credentials, or ` +
          'remove them, and run this again. Nothing was written',
      )
      return 1
    }
    const found = looked.ok
    if (found === null) {
      // `deps.check` only ever says *not installed* or *a gap*, never which
      // repository the App can see instead, or where to fix it — that is
      // `choose()`'s (`pick-repository.ts:199`), and `runGithubBranch`'s
      // slug path would have reached it had this check not refused first
      // (#402 fix round 3). Asked only here, on the refusal, so a
      // successful add still costs the one request `deps.check` already
      // made and nothing more.
      //
      // **Not for a project Lingtai already has.** There `choose()` answers
      // *already onboarded*, a sentence for the picker's offer-it-once
      // screen, and it would replace `checkInstallation`'s gap list, which
      // is the real reason for the exit 1 (#402 review, the guard
      // `first-project.ts` has for the same reason).
      const picked: Choice | null = yield* Effect.suspend(() => deps.picker()).pipe(
        Effect.map((picker) => (alreadyOnboarded(picker, slug) ? null : choose(picker, slug))),
        // A picker that would not answer, or threw, is no sentence of its own: the gap list stands.
        recovering(() => Effect.succeed(null)),
      )
      console.error(
        picked !== null && !picked.ok
          ? refusalLines(picked).join('\n')
          : checked.filter((l) => l.trim() !== '').join('\n'),
      )
      return 1
    }
    reach = { kind: 'app', installation: found }
  }

  // Which agent writes the change, and which cold-reviews it, is asked here —
  // before `add()` resolves the recipe — because `resolveLocalRecipe` throws
  // `AgentUnresolvedError` on a file naming no `runtime.agent` the moment more
  // than one runtime is signed in (`#398`). An absent recipe is created once
  // here, with every first-run answer and the seeds below (#432) — no flag is
  // refused for lack of a file any more.
  const path = recipePath(repo)
  const existing = yield* lift(() => deps.files.read(path))
  const world: QuestionWorld = {
    ask: deps.ask,
    ...(deps.spin === undefined ? {} : { spin: deps.spin }),
    log: (line) => console.log(line),
  }

  // Memoized, and shared with `askLanding`'s own `detected`, inside
  // `askRecipe` — asking GitHub for the default branch twice for one run is
  // one request nobody needed.
  const cachedDefaultBranch = yield* Effect.cached(defaultBranchOf(owner, repo, reach))
  const defaultBranch: Effect.Effect<string | null> =
    ghDefaultBranch !== null ? Effect.succeed(ghDefaultBranch) : cachedDefaultBranch

  let seeds: readonly RecipeChange[] = []
  if (existing === null) {
    const seedBase = base ?? (yield* defaultBranch)
    if (seedBase === null) {
      console.error(
        `${path} does not exist and there is no base branch to write into it: pass --base <branch>. Nothing was written`,
      )
      return 1
    }
    seeds = [
      { path: ['repo', 'base'], value: seedBase },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
      {
        path: ['steps', 'end'],
        value: [
          { name: 'close the ticket', when: 'landed', close: true },
          { name: 'close the ticket a person ended', when: 'closed', close: true },
        ],
      },
    ]
  } else {
    // A file that `extends:` a preset and writes no `steps:` of its own
    // inherits every step from the preset — the first `steps.*` answer below
    // pins that preset's steps into the file for good (`write.ts`'s
    // `widenStepsIfNeeded`). Named here, before `askRecipe`'s first question,
    // because showing that to a person is this caller's line to print, not
    // `agents.ts`'s.
    const extendsPreset = yield* readRecipeKeyEffect(repo, ['extends'])
    const stepsWritten = yield* readRecipeKeyEffect(repo, ['steps'])
    if (typeof extendsPreset === 'string' && stepsWritten === null) {
      console.log(
        `${path} extends ${extendsPreset} and writes no steps: of its own — the first answer here pins that ` +
          "preset's steps into the file, so a later change to the preset no longer reaches this project",
      )
    }
  }

  const runtimes = yield* deps.runtimes()
  const ref = base ?? (yield* defaultBranch)
  const reader = yield* deps.reader(owner, repo, reach, ref)

  const proposal = yield* proposeSetup(
    { kind: 'github', owner, repo },
    {
      setupReader: reader,
      defaultBranch: () => defaultBranch,
      runtimes: () => Effect.succeed(runtimes),
      history: (project) => deps.history(project),
      origin: () => Effect.succeed(null),
      // Only a recipe that is new is asked the sandbox step; an existing one never loads srt (#1160).
      ...(existing === null && deps.sandboxHost !== undefined ? { host: deps.sandboxHost() } : {}),
    },
  )

  // `askRecipe`'s `defaultBranch` is still a promise port (`landing.ts`, `init.ts`): run in this fiber's
  // services, and through the same memo, so one run still asks GitHub once (#402).
  const run = Effect.runPromiseWith(yield* Effect.context<never>())
  const recipeResult = yield* askRecipeEffect(world, {
    project: repo,
    local: false,
    proposal,
    runtimes,
    reader,
    flags,
    buildFlags,
    defaultBranch: () => run(defaultBranch),
    ...(reach === undefined || ref === null
      ? {}
      : {
          tryBuild: (draft: RecipeFiles) =>
            liveTrialBuild({
              project: repo,
              owner,
              repo,
              base: ref,
              // An Effect, run again by every git invocation: an installation token lasts an hour.
              token: lift(() =>
                createGitHubClient({
                  auth: reach?.kind === 'gh' ? { kind: 'gh' as const } : githubClientAuth(),
                  owner,
                  repo,
                  ...(reach?.kind === 'app' ? { installation: reach.installation } : {}),
                }),
              ).pipe(Effect.flatMap((client) => lift(() => client.token()))),
              files: draft,
            }),
        }),
    history: (project) => run(deps.history(project)),
    seeds,
    again: `lingtai add ${owner}/${repo}`,
    keptBeforeWrite: 'Nothing was written',
    kept: ADD_KEPT,
    files: deps.files,
  })
  // `addCommand` hands this same `flags` object to `chooseFirstProject` once
  // this function returns — deleted here, so that call's `runGithubBranch`
  // does not see them again and refuse what `askRecipe` already asked and
  // wrote (#396 fix round, finding 1; #431 fix round, finding 2).
  for (const name of [
    'tickets',
    'kinds',
    'agent',
    'model',
    'reviewer',
    'reviewer-model',
    'install',
    'build',
    'check-build',
    'land',
    'rounds',
    'wall',
    'budget',
    'sandbox',
    'sandbox-hosts',
  ]) {
    delete flags[name]
  }
  if ('refused' in recipeResult) {
    console.error(recipeResult.refused)
    return 1
  }
  if (deps.claudeToken !== undefined) {
    // The recipe is a draft until `applySetup` writes it, so its final form is the preview of the answers.
    const final = yield* attempt(
      previewSetup({ home: stateDir(), files: deps.files }, recipeResult.answers).pipe(
        Effect.map((text) => resolveSource(text, recipePath(repo), recipePath(repo)).recipe),
      ),
    )
    if ('ok' in final) yield* deps.claudeToken(final.ok).pipe(Effect.catch(() => Effect.void))
  }
  return { trial: recipeResult.trial, hints: recipeResult.hints, runtimes, answers: recipeResult.answers }
})
