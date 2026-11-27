/**
 * What `lingtai add` checks, asks and writes before a GitHub project is
 * registered (#398, #399, #402), once a slug is known. Its own module because
 * `lingtai.ts`'s last lines call `main()` on import, so a unit test cannot
 * import this out of it.
 *
 * In order: `--land` against `--main`; then — before a single question is
 * asked or a single answer written: on a `gh` machine, whether the saved
 * login has `repo` and `workflow` and can push to the repository (#708); on an
 * App machine, whether the App is installed here and grants what Lingtai
 * needs (#402); then one `askRecipe` call (#431) asks the writer and
 * reviewer, the install and build commands, the ticket source and the kinds
 * (#396), the landing branch and the limits, in that order. **An absent
 * recipe is created once, with every one of those first-run answers and the
 * seeds below — `branch.main` and `env.plantAt` — rather than refused (#432).**
 * **Nothing is written here (#968):** the answers are
 * collected and returned, and `applySetup` writes them once, just before the registration. With
 * nothing configured at a terminal, every question below still runs: a recipe
 * written for a project whose App does not exist yet is what lets
 * `chooseFirstProject` offer to create it next, in the same run. With nothing
 * configured and no terminal, or a refused `github.auth`, it stops first. Null to go on to the
 * registration, or the exit code to stop with. A local project, and a
 * GitHub one picked on the board, reach none of this yet.
 */
import { hostname } from 'node:os'

import {
  checkGhAccessEffect,
  checkInstallationEffect,
  type GhAccess,
  type GithubReach,
} from '@lingtai/conductor/onboard'
import { makePersonalBranch as sharedMakePersonalBranch } from '@lingtai/conductor/personal-branch'
import { alreadyOnboarded, choose, type Choice, refusalLines } from '@lingtai/conductor/pick-repository'
import { sandboxHostHere } from '@lingtai/conductor/projects'
import { liveHistoryEffect } from '@lingtai/conductor/ticket-history'
import { codexTextConfig, githubApp, githubAuthKind, githubClientAuth, hasGitHubApp, stateDir } from '@lingtai/env'
import {
  createGitHubClient,
  type GitHubClient,
  GitHubFailed,
  ghStatusEffect,
  type Installation,
  installationForRepo,
  liveGh,
  parseSlug,
} from '@lingtai/github'
import { draftRecipe, recipePath, type RecipeDraft } from '@lingtai/project'
import { type Recipe, type RecipeChange, resolveSource } from '@lingtai/recipe'
import {
  type Answers,
  type Asker,
  type Decided,
  EMPTY_SETUP_READER,
  type Entry,
  type Picker,
  type ProjectContext,
  type ProjectPorts,
  type ProposalReaders,
  type SetupReader,
  projectContext,
  projectList,
  runSetupList,
  summariseRecipe,
} from '@lingtai/setup'
import { askRuntimesEffect, proposeSetup, type RuntimeFound } from '@lingtai/setup'
import { previewSetup } from '@lingtai/setup'
import { Effect } from 'effect'

import { checkAppEffect } from './app-check.ts'
import { lift, recovering } from './exit.ts'
import { livePickerEffect } from './first-project.ts'
import { type GithubAuthAnswer } from './github-auth.ts'
import { askTokenFor, githubEntryFor, liveMachineWorld, machineSetup } from './machine-askers.ts'
import { projectAskers, liveTrialPort } from './project-askers.ts'
import { interactivity, liveAsk, liveSpin } from './prompt.ts'
import type { QuestionWorld } from './question.ts'
import {
  ADD_KEPT,
  changedLeftBehind,
  changedOf,
  ENV_PLANT_AT,
  fetchedRates,
  priceHints,
  SAID,
  toolOnPath,
} from './recipe-flow.ts'
import type { TrialOutcome } from './setup-build.ts'
import type { LeftBehind } from './setup-card.ts'

/**
 * How this machine reaches the repository: through the App's installation on
 * it, or through the saved `gh` login, which has none.
 */
export type Reach = { kind: 'app'; installation: Installation } | { kind: 'gh' }

/**
 * The repository's default branch, through the same calls `checkInstallation`
 * and `add()` make to read it. Three callers read it, through the one
 * memoized `defaultBranch` closure below: the `branch.main` seed on an absent
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
const readDefaultBranch = (owner: string, repo: string, reach?: Reach): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    if (reach?.kind === 'gh') {
      const client = yield* lift(() => createGitHubClient({ auth: { kind: 'gh' }, owner, repo }))
      return yield* lift(() => client.defaultBranch())
    }
    // `githubApp()` throws where no App is configured — the ordinary case, a defect the caller names.
    const auth = githubApp()
    const resolved = reach?.installation ?? (yield* lift(() => installationForRepo(auth, owner, repo)))
    const client = yield* lift(() => createGitHubClient({ auth, owner, repo, installation: resolved }))
    return yield* lift(() => client.defaultBranch())
  })

/** The read above with its failure answered null; the seed alone looks at the failure (#1487). */
export const defaultBranchOf = (owner: string, repo: string, reach?: Reach): Effect.Effect<string | null> =>
  readDefaultBranch(owner, repo, reach).pipe(recovering(() => Effect.succeed(null)))

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

/** What this function asks of a GitHub client: the live one, or a test's. */
export type GithubClientPort = Pick<GitHubClient, 'branchExists' | 'request' | 'token' | 'refSha' | 'createBranch'>

export interface AskBeforeGithubAddDeps {
  /** The client the branch checks, the compare and the branch's making go through; absent builds the live one from `reach`. */
  client?: (owner: string, repo: string, reach: Reach | undefined) => Effect.Effect<GithubClientPort, unknown>
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
  claudeToken?: (recipe: Recipe, flags: Record<string, string>) => Effect.Effect<void, unknown>
  /**
   * How this machine reaches GitHub, asked where nothing (or `none`) is in force (0114 §1, #1487) — the machine
   * list's own GitHub entry, with `none` refused as an answer. Absent asks nothing, and `kind` stays null.
   */
  githubAuth?: (flags: Record<string, string>) => Effect.Effect<GithubAuthAnswer, unknown>
  /** Reads the default branch where the seed needs it; absent reads it live. */
  defaultBranch?: (owner: string, repo: string, reach: Reach) => Effect.Effect<string, unknown>
  /** The host check for the sandbox step (#1160), read only for a recipe that is new; absent asks no sandbox question. */
  sandboxHost?: () => NonNullable<ProposalReaders['host']>
}

export const liveGithubDeps: AskBeforeGithubAddDeps = {
  check: checkInstallationEffect,
  auth: () => githubAuthKind(),
  interactive: () => {
    const how = interactivity(false)
    return how.stdinIsTTY && how.stdoutIsTTY
  },
  ghAccess: (slug, log) => checkGhAccessEffect(slug, log),
  picker: livePickerEffect,
  reader: liveGithubReader,
  ask: liveAsk,
  spin: liveSpin,
  runtimes: askRuntimesEffect,
  history: liveHistoryEffect,
  sandboxHost: () => sandboxHostHere(),
  githubAuth: (flags) =>
    githubEntryFor(
      liveMachineWorld(
        { ask: liveAsk, spin: liveSpin, log: (line) => console.log(line) },
        { app: checkAppEffect, ghStatus: () => ghStatusEffect(), gh: liveGh },
      ),
      flags,
      ADD_KEPT,
    ),
  claudeToken: (recipe, flags) => {
    const setup = machineSetup(
      liveMachineWorld(
        { ask: liveAsk, spin: liveSpin, log: (line) => console.log(line) },
        { app: checkAppEffect, ghStatus: () => ghStatusEffect(), gh: liveGh },
      ),
      { githubRequired: false, command: 'lingtai add' },
    )
    return askTokenFor(setup, { log: (line) => console.log(line) }, flags, recipe)
  },
}

/** What the questions came to when the add goes on: the trial and the hints, for the card `add` ends on. */
export interface GithubAnswers {
  trial: TrialOutcome
  hints: string[]
  /** The runtimes it probed, so the card does not probe them again. */
  runtimes: readonly RuntimeFound[]
  /** What the questions decided; nothing is on disk until `applySetup` writes it, just before the registration. */
  answers: Answers
  /** `app` was answered here and writes nothing until the App exists: `chooseFirstProject` is told, so it does not ask again. */
  githubAuth?: 'app'
  /** What a change to the retained recipe left where it was, for the card (#1474). */
  leftBehind?: readonly LeftBehind[]
  /** How the repository was read here, in the shape the card and the labels take; absent while the App is yet to be made. */
  reach?: GithubReach
  /** What the project list asked and wrote, in its own order: the entries the runner returned. */
  entries: readonly Entry[]
}

/** An Effect settled to the value or what it threw: a failure and a defect alike, an interruption never. */
export const attempt = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.map((ok) => ({ ok }) as const),
    recovering((threw) => Effect.succeed({ threw } as const)),
  )

/** `refs/heads/<name>` at the tip of `<from>`: read first, then made, so a failed read makes nothing. */
export const makePersonalBranch = (
  client: Pick<GitHubClient, 'refSha' | 'createBranch'>,
  name: string,
  from: string,
): Effect.Effect<void, unknown> =>
  sharedMakePersonalBranch(
    {
      refSha: (n) => lift(() => client.refSha(n)),
      createBranch: (n, sha) => lift(() => client.createBranch(n, sha)),
    },
    name,
    from,
  ).pipe(Effect.asVoid)

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A number is an exit code: the add stops there. Otherwise the add goes on. */
export const githubProjectAnswersEffect = Effect.fn('add-github.githubProjectAnswers')(function* (
  slug: string,
  flags: Record<string, string>,
  deps: AskBeforeGithubAddDeps = liveGithubDeps,
  /** Every `--build <cmd>` on the command line, in order — `flags['build']` alone is only the last (#431 fix round, finding 3). */
  buildFlags: readonly string[] = [],
  /** What a refusal says is already true: `add`'s sentence, or `init`'s own. */
  kept: string = ADD_KEPT,
): Effect.fn.Return<number | GithubAnswers, unknown> {
  // Tier, gates and the base are the recipe's, in the managed repository, which
  // is why this takes a slug and — at most — the branch to find the file on.
  // `named`, because a person typed it here: a recipe that contradicts `--main`
  // is refused rather than adopted (#75), which is a refusal only a typed flag
  // may earn.
  if (flags['base'] !== undefined) {
    console.error(`--base is now --main: pass --main ${flags['base']}. Nothing was written`)
    return 2
  }
  const base = flags['main']
  const land = flags['land']
  // `--land <branch>` and `--main` are different questions — where to read the
  // recipe from, and what it should land on — and a person who named both must
  // not have one silently overrule the other (#399, mirroring #75's rule for
  // `--main` against the recipe's own `branch.main`).
  if (base !== undefined && land !== undefined && land !== 'hold' && land !== base) {
    console.error(
      `--land ${land} and --main ${base} name two different branches, and this command will not pick one ` +
        'silently. Nothing was written',
    )
    return 2
  }

  const { owner, repo } = parseSlug(slug)

  // Nothing configured at a terminal: there is nothing yet to check —
  // `checkInstallation`'s default lookup calls `githubApp()`, which throws
  // rather than answering "not installed". With a terminal and nothing
  // configured, how this machine reaches GitHub is asked first (#1487); on `app`
  // the questions below still run with `--main`, as before #402: a recipe
  // written for a project whose App was never created is what lets
  // `chooseFirstProject` offer to create one next, in the same run. With no
  // terminal and nothing configured it is refused above, naming the flag, and a
  // refused `github.auth` likewise.
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
  const authFlag = flags['github-auth']
  // `app` answered here: it writes nothing until the App exists, and is told on to `chooseFirstProject`.
  let appChosen = false
  // Nothing in force, or `none`, is the one case this asks (#1487): the machine list's own GitHub entry, with
  // `none` refused as an answer — a GitHub project needs a way to reach GitHub. The entry checks `gh` and writes it.
  if (kind === null) {
    if (deps.githubAuth !== undefined) {
      const answered = yield* attempt(deps.githubAuth(flags))
      if ('threw' in answered) {
        console.error(`${errorText(answered.threw)}. Nothing was written`)
        return 1
      }
      if ('refused' in answered.ok) {
        console.error(answered.ok.refused)
        return 1
      }
      if (answered.ok.auth === 'gh') kind = 'gh'
      else if (answered.ok.auth === 'app') appChosen = true
    } else if (authFlag === 'gh') kind = 'gh'
    else if (authFlag === 'app') appChosen = true
  }

  // On a `gh` machine the saved login is the check: its scopes and its push
  // right on this repository, read before anything is asked or written. The
  // App is never consulted — a machine with a full App and `auth: gh` is a
  // `gh` machine. `reach` is how the repository is read from here on.
  let reach: Reach | undefined
  let ghDefaultBranch: string | null = null
  // The person this machine's `gh` is signed in as; an App acts for nobody, so it is `null` there.
  let ghLogin: string | null = null
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
    ghLogin = access.login === '' ? null : access.login
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
  // Inside an add the file is read as a draft: nothing is recorded or written until `applySetup`.
  const onDisk = yield* draftRecipe(repo)
  const existing = onDisk.text()
  const world: QuestionWorld = {
    ask: deps.ask,
    ...(deps.spin === undefined ? {} : { spin: deps.spin }),
    log: (line) => console.log(line),
  }

  // Memoized, and shared with `askLanding`'s own `detected`, inside
  // `askRecipe` — asking GitHub for the default branch twice for one run is
  // one request nobody needed.
  // The read keeps its error, once: the seed names it, the other two callers take it as null (#1487).
  const readOnce = yield* Effect.cached(
    (reach === undefined
      ? Effect.fail(
          new Error(
            'no GitHub App is configured here yet — the App is created after these questions, or pass --github-auth gh',
          ),
        )
      : (deps.defaultBranch ?? readDefaultBranch)(owner, repo, reach)
    ).pipe(Effect.result),
  )
  const cachedDefaultBranch: Effect.Effect<string | null> = readOnce.pipe(
    Effect.map((read) => (read._tag === 'Success' ? read.success : null)),
  )
  const defaultBranch: Effect.Effect<string | null> =
    ghDefaultBranch !== null ? Effect.succeed(ghDefaultBranch) : cachedDefaultBranch
  // The list's own port keeps the failure: it is the list's refusal, never an absent value (#1525).
  const defaultBranchPort: Effect.Effect<string | null, unknown> =
    ghDefaultBranch !== null
      ? Effect.succeed(ghDefaultBranch)
      : readOnce.pipe(
          Effect.flatMap((read) =>
            read._tag === 'Success' ? Effect.succeed(read.success) : Effect.fail(read.failure),
          ),
        )

  // A new recipe starts from these; `branch.main` is the `branch` entry's, from the default-branch port.
  const seeds: readonly RecipeChange[] =
    existing !== null
      ? []
      : [
          { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
          {
            path: ['steps', 'end'],
            value: [
              { name: 'close the ticket', when: 'landed', close: true },
              { name: 'close the ticket a person ended', when: 'closed', close: true },
            ],
          },
        ]
  if (existing !== null) {
    // A file that `extends:` a preset and writes no `steps:` of its own
    // inherits every step from the preset — the first `steps.*` answer below
    // pins that preset's steps into the file for good (`write.ts`'s
    // `widenStepsIfNeeded`). Named here, before `askRecipe`'s first question,
    // because showing that to a person is this caller's line to print, not
    // `agents.ts`'s.
    const extendsPreset = onDisk.get(['extends'])
    const stepsWritten = onDisk.get(['steps'])
    if (typeof extendsPreset === 'string' && stepsWritten === null) {
      console.log(
        `${path} extends ${extendsPreset} and writes no steps: of its own — the first answer here pins that ` +
          "preset's steps into the file, so a later change to the preset no longer reaches this project",
      )
    }
  }

  const runtimes = yield* deps.runtimes()
  // A rerun reads the repository at the base the recipe names, never at GitHub's default (and so needs no lookup of it).
  const savedMain = existing === null ? null : onDisk.get(['branch', 'main'])
  const ref = base ?? (typeof savedMain === 'string' && savedMain !== '' ? savedMain : yield* defaultBranch)
  const reader = yield* deps.reader(owner, repo, reach, ref)

  const proposal = yield* proposeSetup(
    { kind: 'github', owner, repo },
    {
      setupReader: reader,
      defaultBranch: () => defaultBranch,
      runtimes: () => Effect.succeed(runtimes),
      history: (project) => deps.history(project),
      origin: () => Effect.succeed(null),
      // The sandbox step is asked wherever the host is read, on a rerun too (#1474).
      ...(deps.sandboxHost !== undefined ? { host: deps.sandboxHost() } : {}),
    },
  )

  // Built per call, as the trial build's `token` is: an installation token lasts an hour. A test hands its own.
  const githubClient = (): Effect.Effect<GithubClientPort, unknown> =>
    deps.client !== undefined
      ? deps.client(owner, repo, reach)
      : lift(() =>
          createGitHubClient({
            auth: reach?.kind === 'gh' ? { kind: 'gh' as const } : githubClientAuth(),
            owner,
            repo,
            ...(reach?.kind === 'app' ? { installation: reach.installation } : {}),
          }),
        )

  const ports: ProjectPorts = {
    project: repo,
    local: false,
    checkout: null,
    knownLogin: ghLogin,
    hostname: hostname(),
    defaultBranch: defaultBranchPort,
    // An exact ref, never `matchingRefs`: `foundry-pr-7` existing is not `foundry` existing.
    branchExists: (name) =>
      githubClient().pipe(
        Effect.flatMap((client) => lift(() => client.branchExists(name))),
        recovering(() => Effect.succeed('unreadable' as const)),
      ),
    // `base...head` is what `head` has that `base` does not; a compare that fails is `null`, said on the card.
    // The compare answers 30 commits a page by default and at most 250 in all, whatever `total_commits` says: this
    // pages through what it will give, and a list shorter than the total ends in a line that says how many are
    // not listed, so a partial list is never presented as the whole.
    commitsOnlyIn: (base, head) =>
      Effect.gen(function* () {
        const client = yield* githubClient()
        const lines: string[] = []
        let total = 0
        for (let page = 1; page <= 3; page++) {
          const r = yield* lift(() =>
            client.request<{ total_commits?: number; commits?: { sha: string; commit: { message: string } }[] }>(
              'GET',
              `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=${page}`,
            ),
          )
          const commits = r.commits ?? []
          total = r.total_commits ?? total
          lines.push(...commits.map((c) => `${c.sha.slice(0, 9)} ${c.commit.message.split('\n')[0] ?? ''}`.trim()))
          if (commits.length < 100 || lines.length >= total) break
        }
        if (total > lines.length) {
          lines.push(
            `… and ${total - lines.length} more not listed — git log --oneline origin/${base}..origin/${head} lists them all`,
          )
        }
        return lines
      }).pipe(recovering(() => Effect.succeed(null))),
    reader,
    runtimes: Effect.succeed(runtimes),
    history: (project) => deps.history(project),
    proposal,
    codexText: Effect.try(() => codexTextConfig() !== undefined),
    onPath: (tool) => lift(() => toolOnPath(tool)),
    ...(reach === undefined || ref === null
      ? {}
      : {
          trial: liveTrialPort(world, {
            project: repo,
            owner,
            repo,
            // An Effect, run again by every git invocation: an installation token lasts an hour.
            token: githubClient().pipe(Effect.flatMap((client) => lift(() => client.token()))),
          }),
        }),
  }

  // Each question's hints print before it is asked, as they did when each step said its own: the list only collects
  // them. The cursor never splices the array — the entries push onto it.
  const asker = projectAskers(world)
  let printed = 0
  const flushLog = (ctx: ProjectContext) => {
    for (; printed < ctx.log.length; printed++) console.log(ctx.log[printed])
  }
  const askers = Object.fromEntries(
    Object.entries(asker).map(([id, ask]) => [
      id,
      (decided: Decided<ProjectContext>) => {
        flushLog(decided.ctx)
        return ask(decided)
      },
    ]),
  ) as Record<string, Asker<ProjectContext>>

  const ctx = projectContext({ start: onDisk, buildFlags, flags, ports, kept, seeds })
  const walked = yield* runSetupList(
    projectList(ports),
    {
      interactive: deps.interactive(),
      defaults: flags['defaults'] !== undefined,
      flags,
      askers,
      log: (line) => console.log(line),
      // Nothing is written until the list ends, so a Ctrl+C keeps no recipe — whatever `append` marked as pending.
      kept: () => ({ kept }),
    },
    ctx,
  )
  flushLog(ctx)
  if (walked.refused !== undefined) {
    // A refusal the list's own questions made says what is kept; one a port's read made (the default branch) does not.
    console.error(walked.refused.includes(kept) ? walked.refused : `${walked.refused}. ${kept}`)
    return 1
  }
  // Read before the write: it is the recipe as the run began that says what moved.
  const changed = changedOf(onDisk, ctx.answers)
  // The one write: every answer is held in `ctx.pending` until the list is answered to its end.
  if (ctx.pending.length > 0) {
    const set = yield* attempt(onDisk.set(ctx.pending))
    if ('threw' in set) {
      console.error(`${errorText(set.threw)}. ${kept}`)
      return 1
    }
  }
  const answers: Answers = { project: repo, changes: onDisk.changes(), said: SAID }
  // After every question and before `applySetup` writes the recipe: a crash between them leaves a branch and no
  // project, and the next add finds the branch *exists* and uses it. Never retried: a 422 is read as *exists*.
  const make = ctx.answers.make
  if (make !== undefined) {
    const { name, from } = make
    const made = yield* attempt(githubClient().pipe(Effect.flatMap((client) => makePersonalBranch(client, name, from))))
    if ('threw' in made) {
      console.error(
        `could not make ${name} from origin/${from} — ${made.threw instanceof Error ? made.threw.message : String(made.threw)}. Nothing was written and nothing was registered`,
      )
      return 1
    }
    console.log(`made ${name} from origin/${from} and pushed it`)
  }
  if (deps.claudeToken !== undefined) {
    // The recipe is a draft until `applySetup` writes it, so its final form is the preview of the answers.
    const final = yield* attempt(
      previewSetup({ home: stateDir() }, answers).pipe(
        Effect.map((text) => resolveSource(text, recipePath(repo), recipePath(repo)).recipe),
      ),
    )
    if ('ok' in final) yield* deps.claudeToken(final.ok, flags).pipe(Effect.catch(() => Effect.void))
  }
  const finalText = onDisk.text()
  const hints: string[] = (() => {
    if (finalText === null) return []
    try {
      return priceHints(summariseRecipe(resolveSource(finalText, path, path).recipe).models, fetchedRates())
    } catch {
      return []
    }
  })()
  return {
    trial: ctx.answers.trial ?? { trial: 'not-run', because: 'no checks' },
    hints,
    runtimes,
    answers,
    entries: walked.entries,
    ...(changedLeftBehind(changed, slug).length === 0 ? {} : { leftBehind: changedLeftBehind(changed, slug) }),
    ...(reach === undefined
      ? {}
      : {
          reach:
            reach.kind === 'gh'
              ? ({ kind: 'gh', login: ghLogin } as const)
              : ({ kind: 'app', slug: reach.installation.appSlug ?? null } as const),
        }),
    ...(appChosen && authFlag !== 'app' ? { githubAuth: 'app' as const } : {}),
  }
})
