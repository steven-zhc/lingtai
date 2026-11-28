/** The project paths shared by init and add. Local questions walk @lingtai/setup's project list;
 * only checkout checks, branch creation and registration belong to this input. */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, join, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

import { exclusiveAdd } from '@lingtai/conductor/add-from-page'
import { addEffect, addLocalEffect, type Added, type AddOptions, type GithubReach } from '@lingtai/conductor/onboard'
import { alreadyOnboarded, choose, refusalLines, taken } from '@lingtai/conductor/pick-repository'
import { sandboxHostHere, signedInHere } from '@lingtai/conductor/projects'
import { repositoryList } from '@lingtai/conductor/repository-list'
import { liveHistoryEffect } from '@lingtai/conductor/ticket-history'
import { held } from '@lingtai/daemon'
import { isOpen, type ProjectState } from '@lingtai/domain'
import { boardHost, boardPort, boardReachHost, codexTextConfig, githubAuthKind, stateDir } from '@lingtai/env'
import { paint } from '@lingtai/env/colour'
import type { Locker } from '@lingtai/env/lock'
import type { EventStore } from '@lingtai/event-store/store'
import { ghStatusEffect, type GhStatus, type Installation, parseSlug } from '@lingtai/github'
import {
  HOST_FOR_SAVING,
  defaultStore,
  draftIn,
  draftRecipe,
  listPrs,
  modeSwitchMessage,
  loadAllProjectsEffect,
  recipePath,
  resolveDraftRecipeEffect,
} from '@lingtai/project'
import { readTasksEffect } from '@lingtai/projector'
import { branchOf, resolveSource, type Recipe, type ResolvedRecipe, type SignedIn } from '@lingtai/recipe'
import { mirrorPathFor } from '@lingtai/repo'
import { type Picker, type ProposalReaders, type RepositoryList, type SetupReader } from '@lingtai/setup'
import { askRuntimesEffect, NO_GITHUB_ORIGIN, proposeSetup, type RuntimeFound } from '@lingtai/setup'
import { applySetup, keptSentence, SetupWriteError } from '@lingtai/setup'
import {
  ENV_PLANT_AT,
  SAID,
  projectContext,
  projectList,
  runSetupList,
  type ProjectPorts,
  type ProjectContext,
  type Asker,
  type Decided,
  type Entry,
} from '@lingtai/setup'
import { Cause, Effect } from 'effect'

import { checkAppEffect, pollForAppEffect, type AppCheck } from './app-check.ts'
import { boardAtEffect } from './board.ts'
import { lift } from './exit.ts'
import {
  APP_WAIT_MS,
  appComeBackLine,
  askFirstProjectEffect,
  waitForAppEffect,
  type AppWaitResult,
  type AppWaitWorld,
} from './github-app.ts'
import { liveMachineText, writeGithubAuth } from './github-auth.ts'
import { waitForKeypress } from './keypress.ts'
import { askTokenFor, liveMachineWorld, machineSetup } from './machine-askers.ts'
import { projectAskers, liveTrialPort } from './project-askers.ts'
import { fetchedRates, toolOnPath } from './project-support.ts'
import { interactivity } from './prompt.ts'
import { questionEffect, spunEffect, type QuestionWorld } from './question.ts'
import { priceHints, summariseRecipe } from './recipe-flow.ts'
import type { TrialOutcome } from './setup-build.ts'
import { cardRecipe, type CardRecipe, type LeftBehind } from './setup-card.ts'
import type { Mode } from './team.ts'
import { ROUNDS_RETIRED, withoutProjectFlags } from './wizard-options.ts'

/** The branch a local project lands on, made from the checked-out one when absent (0104 §15). */
const LINGTAI_BASE = 'lingtai-base'

/**
 * A failure answered by `onFail`, as every `try { await … } catch` here was. A store failure is a defect
 * (0101 §6) that `Effect.catch` does not see, so this is `catchCause`; an interruption is let through, since
 * it was never a refusal to print. The error is `Cause.squash`'s — the object `runPromise` threw — so
 * `errorText` and `instanceof SetupWriteError` read what they always read.
 */
const recoverWith = <A, E, R, B, E2, R2>(
  self: Effect.Effect<A, E, R>,
  onFail: (err: unknown) => Effect.Effect<B, E2, R2>,
): Effect.Effect<A | B, E2, R | R2> =>
  self.pipe(
    Effect.catchCause((cause): Effect.Effect<B, E2, R2> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : onFail(Cause.squash(cause)),
    ),
  )

/** `recoverWith`, answering with a value. */
const refusingOn = <A, E, R, B>(
  self: Effect.Effect<A, E, R>,
  onFail: (err: unknown) => B,
): Effect.Effect<A | B, never, R> => recoverWith(self, (err) => Effect.succeed(onFail(err)))

/** `world.git(dir, args)` — never a shell string, so a path never has to be escaped. */
export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

export interface RegisterLocalPayload {
  project: string
  owner: null
  base: string
  configHash: string
  fromSha: string
  /** Already resolved by the caller, so `register` need not read the file again. */
  resolved: ResolvedRecipe
}

/** The move confirmation is asked only by the list's terminal input. */
export function askMoveLanding(
  world: QuestionWorld,
  at: { name: string; oldRemote: string; kept?: string | undefined },
) {
  return questionEffect(world, {
    name: 'moving the landing',
    flag: '--defaults',
    given: null,
    prompt: `Move ${at.name}'s landing from ${at.oldRemote} to this checkout, and rebuild its mirror?`,
    fallback: 'no',
    choices: ['yes', 'no'],
    kept: at.kept ?? 'Nothing was written',
  })
}

/**
 * `FirstProjectWorld.exists` over `node:fs`: only a path that is not there is
 * `false`. A directory that cannot be reached (EACCES on a parent) exists —
 * it is git's to say why it cannot be read, not ours to call it missing.
 */
export const pathExistsEffect = (path: string): Effect.Effect<boolean> =>
  refusingOn(Effect.tryPromise({ try: () => stat(path), catch: (e) => e }).pipe(Effect.map(() => true)), (error) => {
    const code = (error as NodeJS.ErrnoException).code
    return !(code === 'ENOENT' || code === 'ENOTDIR')
  })

/**
 * Every IO member returns an Effect; `ask`, `log` and `spin` are clack's and stay as `QuestionWorld` has them.
 * A rejection or a throw inside a member is a failure or a defect, and the refusals below treat both alike.
 */
export interface FirstProjectWorld extends QuestionWorld {
  /** Live inputs set this from the terminal; fake worlds default to an interactive input. */
  interactive?: boolean
  /**
   * The caller asks a GitHub project's questions itself once a repository is picked (`lingtai add`), so the GitHub
   * branch is handed the flags without the project's own, and the local branch still gets every one.
   */
  asksProjectQuestionsAfterThePick?: true
  git: (dir: string, args: readonly string[]) => Effect.Effect<GitResult, unknown>
  /** Whether a path exists — a seam so the unit tests never touch the disk (0060 §1). */
  exists: (path: string) => Effect.Effect<boolean, unknown>
  /** `loadAllProjects` — registered and pending alike, keyed by name. */
  projects: () => Effect.Effect<readonly ProjectState[], unknown>
  /** The lock an add is made under (`exclusiveAdd`): the machine's file lock unless a test hands one in. */
  locker?: Locker
  /** Who adds, on the recipe's event: `human:<user>`. */
  by: string
  /** The log the recipe's event goes to — the process's own when absent. */
  store?: EventStore
  /** `stateDir()` unless a test says otherwise. */
  home: string
  /**
   * Asks for the sandboxed Claude Code token once the recipe is final (#1169) — absent asks nothing. It never
   * refuses the add: the token belongs to the machine, not the project.
   */
  claudeToken?: (recipe: Recipe, flags: Record<string, string>) => Effect.Effect<void, unknown>
  /** The host check for the sandbox step (#1160), read only for a recipe that is new; absent asks no sandbox question. */
  sandboxHost?: () => NonNullable<ProposalReaders['host']>
  signedIn: SignedIn
  /** Every runtime, asked whether it is installed and signed in — never probed twice (`AskAgentsAt`'s own rule). */
  runtimes: () => Effect.Effect<readonly RuntimeFound[], unknown>
  /** `askRecipe`'s `reader`, for the local branch's `askInstallAndBuild` (#431) — a real directory, over `node:fs`. */
  setupReader: (dir: string) => SetupReader
  /** Appends `ProjectConfigured` and returns the "added" or "updated" line. */
  register: (payload: RegisterLocalPayload) => Effect.Effect<{ line: string; updated: boolean }, unknown>
  /** `ticket-<project>-*` streams already in the log for this project — #396's `askTickets`. */
  history: (project: string) => Effect.Effect<readonly string[], unknown>
  /**
   * The tickets of this project a pass is working now (`<project>#7`), asked of the board's own reduce. It
   * **fails** where the board cannot be read — a failed read is never "nothing in flight" (#772).
   */
  inFlight?: (project: string) => Effect.Effect<readonly string[], unknown>
  /** Removes `<home>/repos/<project>.git` so the next cut clones it from the recipe's `repo.remote`; an absent mirror succeeds (#772). */
  removeMirror?: (project: string) => Effect.Effect<void, unknown>
  /**
   * The clause a refusal here ends with in place of "Nothing was written" —
   * what is still true about what this caller already wrote before any
   * question here was asked (#394 finding 2). `init`'s own `chooseStore` has
   * already written `~/.lingtai/config.yml` by the time this runs, so its
   * `kept` is `'the store chosen above is kept'` (`question.ts`'s own
   * documented reason for the field); `lingtai add` writes nothing before
   * this, so its `kept` is `'Nothing was written'`, same as the default.
   */
  kept: string
  /** Said with `kept` when Ctrl+C stops the project, directory or base question; `init` only. */
  startOver?: string
  /** The command that was run, for the same line. */
  command?: string
  /**
   * `init`'s only (#393): a configured App already answers *is the project*,
   * so the question is refused past rather than asked, and `--project`/
   * `--github-app` naming anything else is refused by name. `lingtai add` has
   * none of this — a machine with an App configured for other projects can
   * still add a local one (#394's finding 5), so it always asks, skipping only
   * the now-moot "create the App" sub-question when one already answers.
   */
  githubAppIsTheProject?: boolean
  github: {
    /**
     * The machine's elected auth, or null where nothing is configured. Absent
     * reads as null. Throws where `github.auth` is refused.
     */
    auth?: () => 'app' | 'gh' | null
    /**
     * What the machine list answered for how this machine reaches GitHub, where this run asked it (`init`).
     * `pending`: `app` was chosen and is written only once the App exists. Absent where the caller (`add`)
     * asked it itself: the elected auth, or `--github-auth app`, is then the answer.
     */
    decided?: { auth: 'gh' | 'app' | 'none'; pending: boolean }
    /** `gh auth status` (#706) — asked only when the auth question is, or `--github-auth gh` is given. */
    ghStatus: () => Effect.Effect<GhStatus, unknown>
    /** Writes `github.auth` into `config.yml`, keeping every other key and comment (0114 §6). */
    writeAuth: (kind: 'gh' | 'app') => Effect.Effect<void, unknown>
    app: () => Effect.Effect<AppCheck, unknown>
    /** A board already running, or null — `add` starts none of its own. */
    boardUrl: () => Effect.Effect<string | null, unknown>
    waitForApp: (boardUrl: string) => Effect.Effect<AppWaitResult, unknown>
    picker: () => Effect.Effect<Picker, unknown>
    add: (options: AddOptions, log: (line: string) => void) => Effect.Effect<Added, unknown>
  }
}

export type FirstProjectOutcome =
  | {
      ok: true
      project: 'local'
      entries: readonly Entry[]
      name: string
      remote: string
      base: string
      trial: TrialOutcome
      /** The recipe as written, for the summary card. */
      card: CardRecipe
      /** The project was already registered. */
      updated: boolean
      /** A rerun whose answers changed nothing: no write, no registration (#1473). */
      unchanged?: boolean
      /** The runtimes this run already probed. */
      runtimes: readonly RuntimeFound[]
      /** Lines the card's closing prints, muted, after the groups. */
      hints: string[]
      /** What a change in this run left where it was, for the card (#1474). */
      leftBehind?: readonly LeftBehind[]
    }
  | {
      ok: true
      project: 'github'
      app: 'already' | AppWaitResult
      slug?: string
      auth?: 'gh'
      /** Set with `slug`: the project was already registered. */
      updated?: boolean
      /** Set with `slug`: what `add` warned about, printed before the card. */
      warnings?: readonly string[]
      /** Set with `slug`: how this machine reached GitHub, for the card's `github` row. */
      reach?: GithubReach
    }
  | { refused: string }

/** Why a combination of flags cannot both be obeyed, or null when they can. */
export function conflictingFlags(
  flags: Record<string, string>,
  kept: string,
  /** `init`'s: `--github-auth` is the machine list's flag, already answered before any project is, so no project kind conflicts with it. */
  githubAuthIsMachine = false,
): string | null {
  const local = flags['local']
  const github = flags['github']
  // A valueless flag parses as '' (`@effect/cli`'s empty option), and `git` run
  // in '' runs in this process's own directory — so `--local` alone would
  // register whatever repository the shell sits in (#394's review).
  if (local !== undefined && local.trim() === '') {
    return `--local needs the directory: --local <dir>. ${kept}`
  }
  if (github !== undefined && github.trim() === '') {
    return `--github needs the repository: --github <owner>/<repo>. ${kept}`
  }
  if (local !== undefined && github !== undefined) {
    return `--local ${local} and --github ${github} name two different projects. Pass one or the other. ${kept}`
  }
  if (local !== undefined && flags['project'] === 'github') {
    return `--local ${local}, but --project github names the other kind. Leave out --project, or leave out --local. ${kept}`
  }
  const auth = flags['github-auth']
  if (!githubAuthIsMachine && auth !== undefined && local !== undefined) {
    return (
      `--github-auth ${auth}, but --local ${local} reaches no GitHub. Leave out --github-auth, or leave out ` +
      `--local. ${kept}`
    )
  }
  if (!githubAuthIsMachine && auth !== undefined && flags['project'] === 'local') {
    return `--github-auth ${auth}, but --project local reaches no GitHub. Leave out --github-auth, or pass --project github. ${kept}`
  }
  if (auth === 'gh' && flags['github-app'] !== undefined && flags['github-app'] !== 'skip') {
    return (
      `--github-auth gh, but --github-app ${flags['github-app']} creates an App. Leave out --github-app, or ` +
      `pass --github-app skip. ${kept}`
    )
  }
  if (local !== undefined && flags['github-app'] !== undefined) {
    return (
      `--github-app ${flags['github-app']}, but --local ${local} creates no GitHub App. Leave out --github-app, ` +
      `or leave out --local. ${kept}`
    )
  }
  if (github !== undefined && flags['project'] === 'local') {
    return `--github ${github}, but --project local names the other kind. Leave out --project, or leave out --github. ${kept}`
  }
  if (flags['base'] !== undefined) return `--base is now --main: pass --main ${flags['base']}. ${kept}`
  const base = flags['main']
  const land = flags['land']
  // `--land <branch>` and `--main` are different questions — where to read the
  // recipe from, and what it should land on — and a person who named both must
  // not have one silently overrule the other (#399, mirroring #75's rule for
  // `--main` against the recipe's own `branch.main`). Checked here, before
  // anything is written, rather than inside `askRecipe`, where `askLanding`
  // would otherwise overwrite the base question's own answer silently.
  if (base !== undefined && land !== undefined && land !== 'hold' && land !== base) {
    return `--land ${land} and --main ${base} name two different branches, and this command will not pick one silently. ${kept}`
  }
  return null
}

/**
 * Just the project-kind half of #393's `askFirstProject` — asked on its own
 * when an App is already configured and `lingtai add` is the caller, since
 * the App sub-question ("create it now, or skip") is moot with one already
 * answering. `askFirstProject` itself is not split to produce this: its
 * contract is pinned by `github-app.test.ts`, which asks both questions every
 * time and must keep doing so.
 */
/** What Ctrl+C at a question prints beside `kept` — only what the world carries. */
function cancelFor(world: FirstProjectWorld): { startOver?: string; command?: string } {
  return {
    ...(world.startOver === undefined ? {} : { startOver: world.startOver }),
    ...(world.command === undefined ? {} : { command: world.command }),
  }
}

function askProjectKind(
  world: FirstProjectWorld,
  flags: Record<string, string>,
): Effect.Effect<{ kind: 'local' | 'github' } | { refused: string }, unknown> {
  return Effect.gen(function* () {
    const kept = world.kept
    const kind = yield* questionEffect(world, {
      name: 'the project',
      flag: '--project github, or --project local',
      given: flags['project'] ?? null,
      prompt: 'a GitHub project, or one on this machine only',
      fallback: 'github',
      choices: ['github', 'local'],
      kept,
      ...(world.startOver === undefined ? {} : { startOver: world.startOver }),
      ...(world.command === undefined ? {} : { command: world.command }),
    })
    if ('refused' in kind) return { refused: kind.refused }
    if (kind.answer === 'local') {
      if (flags['github-app'] !== undefined) {
        return {
          refused:
            `--github-app ${flags['github-app']}, but --project local creates no GitHub App. Leave out ` +
            `--github-app, or pass --project github. ${kept}`,
        }
      }
      return { kind: 'local' as const }
    }
    return { kind: 'github' as const }
  })
}

export function chooseFirstProjectEffect(
  world: FirstProjectWorld,
  flags: Record<string, string>,
  /** Every `--build <cmd>` on the command line, in order — `flags['build']` alone is only the last (#431 fix round, finding 3). */
  buildFlags: readonly string[] = [],
): Effect.Effect<FirstProjectOutcome, unknown> {
  return Effect.gen(function* () {
    const conflict = conflictingFlags(flags, world.kept, world.github.decided !== undefined)
    if (conflict !== null) return { refused: conflict }

    let kind: 'local' | 'github' | null =
      flags['local'] !== undefined ? 'local' : flags['github'] !== undefined ? 'github' : null
    // Fetched at most once here, and handed to `runGithubBranch` rather than
    // left for it to ask again — `world.github.app()` is a real call (`GET
    // /app`, or `init`'s already-fetched one), and asking it twice for one run
    // is a second one nobody needed.
    let appCheck: AppCheck | null = null

    if (kind === null && world.github.auth?.() === 'gh') {
      // No App to offer to create, and none to check: the project question only.
      const asked = yield* askProjectKind(world, flags)
      if ('refused' in asked) return { refused: asked.refused }
      kind = asked.kind
    } else if (kind === null) {
      const app = yield* world.github.app()
      appCheck = app
      if (app.configured && !app.ok) {
        return {
          refused:
            `the GitHub App configured here does not answer — ${app.why}. Fix its credentials, or remove them, ` +
            `and run this again. ${world.kept}`,
        }
      }
      // An App the machine was just told not to use (`--github-auth none`) answers nothing: the project is asked.
      if (app.configured && world.githubAppIsTheProject === true && world.github.decided?.auth !== 'none') {
        const namedProject = flags['project'] ?? null
        if (namedProject !== null && namedProject !== 'github') {
          return {
            refused:
              `--project ${namedProject}, but a GitHub App is already configured here — the project is github ` +
              `already. Remove the App first, or leave out --project. ${world.kept}`,
          }
        }
        if (flags['github-app'] !== undefined && flags['github-app'] !== 'skip') {
          return {
            refused:
              `--github-app ${flags['github-app']}, but a GitHub App is already configured here and none is ` +
              `created now. Leave out --github-app, or pass --github-app skip. ${world.kept}`,
          }
        }
        kind = 'github'
      } else if (app.configured) {
        // The project question is still asked — unlike `init`, a machine with
        // an App configured for other projects can still add a local one
        // (#394's finding 5) — but the "create the App" sub-question is moot
        // with one already answering, so an explicit request for one is refused
        // rather than silently obeyed, and nothing beyond that is asked.
        if (flags['github-app'] !== undefined && flags['github-app'] !== 'skip') {
          return {
            refused:
              `--github-app ${flags['github-app']}, but a GitHub App is already configured here and none is ` +
              `created now. Leave out --github-app, or pass --github-app skip. ${world.kept}`,
          }
        }
        const asked = yield* askProjectKind(world, flags)
        if ('refused' in asked) return { refused: asked.refused }
        kind = asked.kind
      } else {
        // The project question only: how this machine reaches GitHub is asked
        // next, in `runGithubBranch`, ahead of the App's create-or-skip — which
        // `askFirstProject` would otherwise ask first.
        const asked = yield* askProjectKind(world, flags)
        if ('refused' in asked) return { refused: asked.refused }
        kind = asked.kind
      }
    }

    return yield* kind === 'local'
      ? runLocalBranch(world, flags, buildFlags, flags['local'] ?? null)
      : runGithubBranch(
          world,
          world.asksProjectQuestionsAfterThePick === true ? withoutProjectFlags(flags) : flags,
          flags['github'] ?? null,
          appCheck,
        )
  })
}

/** Git recognises a URL (`scheme://…`) and scp-style (`[user@]host:path`) — everything else is a path. */
function isUrlOrScpLike(remote: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(remote) || /^[^@/\s]+@[^/\s]+:/.test(remote)
}

/** `origin` as git stores it, resolved to an absolute path when it is a relative one. */
function resolveRemote(remote: string, top: string): string {
  return isUrlOrScpLike(remote) ? remote : resolvePath(top, remote)
}

/**
 * `FirstProjectWorld.inFlight` over the board: `held` over `readTasksEffect`, not `inFlight()`, whose
 * `.catch(() => [])` would turn a failed read into "nothing in flight" (#772).
 */
export const liveInFlightEffect = (project: string): Effect.Effect<string[], unknown> =>
  readTasksEffect({}).pipe(
    Effect.map((tasks) => held(tasks.filter((card) => card.project.toLowerCase() === project.toLowerCase()))),
  )

/** `FirstProjectWorld.removeMirror` over `node:fs`. */
export const liveRemoveMirrorEffect = (project: string, home: string): Effect.Effect<void, unknown> =>
  Effect.tryPromise({ try: () => rm(mirrorPathFor(project, home), { recursive: true, force: true }), catch: (e) => e })

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function runLocalBranch(
  world: FirstProjectWorld,
  flags: Record<string, string>,
  buildFlags: readonly string[],
  givenDir: string | null,
): Effect.Effect<FirstProjectOutcome, unknown> {
  return Effect.gen(function* () {
    const dirAnswer = yield* questionEffect(world, {
      name: 'the directory',
      flag: '--local <dir>',
      given: givenDir,
      prompt: 'the directory of the repository on this machine',
      kept: world.kept,
      ...(world.startOver === undefined ? {} : { startOver: world.startOver }),
      ...(world.command === undefined ? {} : { command: world.command }),
      validate: (answer) => Effect.succeed(answer.trim() === '' ? 'a directory is needed' : null),
    })
    if ('refused' in dirAnswer) return { refused: dirAnswer.refused }
    const dir = resolvePath(dirAnswer.answer)
    if (!(yield* world.exists(dir))) return { refused: `${dir} does not exist. ${world.kept}` }

    const top = yield* world.git(dir, ['rev-parse', '--show-toplevel'])
    if (!top.ok) {
      const detail = (top.stderr || top.stdout).trim()
      return { refused: `${dir} is not a git repository${detail === '' ? '' : ` — ${detail}`}. ${world.kept}` }
    }
    const toplevel = top.stdout.trim()

    // The checkout itself is the remote (0104 §15): nothing a pass makes leaves the machine.
    const remote = toplevel
    const name = basename(toplevel)

    // Case-insensitive, like `pick-repository.ts`'s own `same()`: on a
    // case-insensitive filesystem (macOS's default APFS), `recipePath` below
    // resolves a differently-cased name to the same file, so a `===` compare
    // would let a second, differently-cased directory slip past this guard and
    // overwrite that file (#394 finding 4).
    const registered = yield* world.projects()
    const found = registered.find((p) => p.project !== null && p.project.toLowerCase() === name.toLowerCase())
    // True when the recipe names the remote the old `add --local` wrote — the checkout's own `origin` — so this
    // run moves its landing to the checkout (0104 §15, #772).
    let moving = false
    // Both commands supply the move's board and mirror ports; an input without them cannot redirect a project.
    const ports =
      world.inFlight !== undefined && world.removeMirror !== undefined
        ? { inFlight: world.inFlight, removeMirror: world.removeMirror }
        : null
    if (found !== undefined && found.owner !== null) {
      return {
        refused:
          `a project called ${name} is already registered as ${found.owner}/${name}, and a project is keyed by its ` +
          `name — pick another directory, or remove that project first. Its recipe is ${recipePath(found.project!, world.home)}, and it is edited there. ${world.kept}`,
      }
    }
    // Read for an unregistered recipe too: one the old `add` wrote and never registered still has a mirror to rebuild.
    // One read of the file for the whole flow, as a draft: inside an add nothing is recorded or written until `applySetup`.
    const onDisk = yield* draftRecipe(name, { home: world.home })
    const existingRemote = onDisk.get(['repo', 'remote'])
    if (typeof existingRemote === 'string' && existingRemote !== remote) {
      // A checkout with no `origin` has only the top level to match.
      const got = yield* world.git(toplevel, ['remote', 'get-url', 'origin'])
      const origin = got.ok && got.stdout.trim() !== '' ? resolveRemote(got.stdout.trim(), toplevel) : null
      moving = ports !== null && origin !== null && existingRemote === origin
    }
    if (found !== undefined && found.owner === null) {
      // `repo.remote` is optional in the schema (`recipe.ts`), so a project
      // registered before owners were recorded — #352's `unrecorded` state —
      // may have none at all. Missing is never treated as a match: there is
      // nothing here to confirm this directory is the same project, and
      // proceeding would silently re-point an existing GitHub project's stream
      // at this local directory.
      if (existingRemote !== remote && !moving) {
        return {
          refused:
            typeof existingRemote === 'string'
              ? `a project called ${name} is already registered with repo.remote: ${existingRemote}, and ${toplevel} ` +
                `is its own remote now — a project is keyed by its name, and registering this directory would silently ` +
                `redirect it to this one. Remove the existing project first, or rename this directory. ${world.kept}`
              : `a project called ${name} is already registered with no repo.remote recorded — it may be a project ` +
                'registered before owners were, and there is nothing here to confirm this directory is the same one ' +
                `— and a project is keyed by its name, so registering ${toplevel} here would silently redirect it ` +
                `to this directory instead. Remove the existing project first, or rename this directory. ${world.kept}`,
        }
      }
    }

    const path = recipePath(name, world.home)
    const fileText = onDisk.text()
    const fileMode: Mode = onDisk.get(['mode']) === 'team' ? 'team' : 'solo'
    if (fileText !== null) {
      try {
        resolveSource(fileText, path, path)
      } catch (error) {
        return { refused: `${path} does not resolve — ${errorText(error)}. ${world.kept}` }
      }
    }
    if (found !== undefined) world.log(`${name} is already added — its recipe is ${path}`)

    // A move must not change the remote under a running attempt. A failed board read is never an empty board.
    const migrating = ports !== null && typeof existingRemote === 'string' && existingRemote !== remote
    if (migrating && ports !== null) {
      const flying = yield* refusingOn(ports.inFlight(name), (error) => ({
        refused: `could not read the board to check for an attempt of ${name} in flight — ${errorText(error)}. ${world.kept}`,
      }))
      if ('refused' in flying) return flying
      if (flying.length > 0)
        return {
          refused: `an attempt of ${name} is in flight (${flying.join(', ')}) — moving its landing under it would cut and land on two remotes. Run this again once they finish, or after lingtai shutdown. ${world.kept}`,
        }
    }
    const runtimes = yield* world.runtimes()
    const reader = world.setupReader(toplevel)
    const proposal = yield* proposeSetup(
      { kind: 'local', path: toplevel },
      {
        setupReader: reader,
        defaultBranch: () => Effect.succeed(LINGTAI_BASE),
        runtimes: () => Effect.succeed(runtimes),
        history: world.history,
        ...(world.sandboxHost === undefined ? {} : { host: world.sandboxHost() }),
        origin: (dir) =>
          Effect.gen(function* () {
            const remotes = yield* world.git(dir, ['remote'])
            if (!remotes.ok) return yield* Effect.fail(new Error(remotes.stderr.trim() || 'git remote failed'))
            if (!remotes.stdout.split('\n').some((r) => r.trim() === 'origin')) return null
            const url = yield* world.git(dir, ['remote', 'get-url', 'origin'])
            if (!url.ok) return yield* Effect.fail(new Error(url.stderr.trim() || 'git remote get-url origin failed'))
            return url.stdout.trim() || null
          }),
      },
    )
    if (
      proposal.tickets.known &&
      !proposal.tickets.because.startsWith('kept:') &&
      proposal.tickets.because !== NO_GITHUB_ORIGIN
    ) {
      world.log(paint.muted(`tickets       db — ${proposal.tickets.because}`))
    }
    const tips = new Map<string, string>()
    const localPorts: ProjectPorts = {
      project: name,
      local: true,
      checkout: remote,
      knownLogin: null,
      hostname: '',
      reader,
      proposal,
      runtimes: Effect.succeed(runtimes),
      history: world.history,
      codexText: Effect.try(() => codexTextConfig() !== undefined),
      onPath: (tool) => lift(() => toolOnPath(tool)),
      defaultBranch: Effect.gen(function* () {
        const head = yield* world.git(toplevel, ['symbolic-ref', '--short', '-q', 'HEAD'])
        if (!head.ok) {
          const detail = (head.stderr || head.stdout).trim()
          return yield* Effect.fail(
            new Error(
              detail ||
                `${toplevel} has no branch checked out, and ${LINGTAI_BASE} is made from the one that is. Check out a branch, or pass --main <branch>`,
            ),
          )
        }
        return head.stdout.trim() || null
      }),
      branchExists: (branch) =>
        Effect.gen(function* () {
          const tip = yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
          if (tip.ok) {
            tips.set(branch, tip.stdout.trim())
            return true
          }
          const detail = (tip.stderr || tip.stdout).trim()
          // rev-parse reports a missing exact ref this way. Other failures (permissions, corrupt refs, IO) keep git's words.
          if (/Needed a single revision|unknown revision|not a valid (object|ref)|bad revision/i.test(detail))
            return false
          return yield* Effect.die(new Error(detail || `could not read ${branch} in ${toplevel}`))
        }).pipe(Effect.orDie),
      commitsOnlyIn: (base, head) =>
        world.git(toplevel, ['rev-list', '--oneline', `${base}..${head}`]).pipe(
          Effect.map((r) => (r.ok ? r.stdout.split('\n').filter((l) => l.trim() !== '') : null)),
          Effect.catch(() => Effect.succeed(null)),
        ),
      trial: liveTrialPort(world, { project: name, owner: '', repo: name, remote, home: world.home }),
    }
    let printed = 0
    const flushLog = (ctx: ProjectContext) => {
      for (; printed < ctx.log.length; printed++) world.log(ctx.log[printed]!)
    }
    const askers = Object.fromEntries(
      Object.entries(projectAskers(world)).map(([id, ask]) => [
        id,
        (d: Decided<ProjectContext>) => {
          flushLog(d.ctx)
          return ask(d)
        },
      ]),
    ) as Record<string, Asker<ProjectContext>>
    const ctx = projectContext({
      start: onDisk,
      flags,
      buildFlags,
      ports: localPorts,
      kept: world.kept,
      seeds: [
        ...(existingRemote === remote ? [] : [{ path: ['repo', 'remote'], value: remote }]),
        ...(fileText === null ? [{ path: ['env', 'plantAt'], value: ENV_PLANT_AT }] : []),
      ],
    })
    const walked = yield* runSetupList(
      projectList(localPorts),
      {
        interactive: world.interactive ?? true,
        defaults: flags['defaults'] !== undefined,
        flags,
        askers,
        log: world.log,
        kept: () => ({ kept: world.kept }),
      },
      ctx,
    )
    flushLog(ctx)
    if (walked.refused !== undefined)
      return { refused: walked.refused.includes(world.kept) ? walked.refused : `${walked.refused}. ${world.kept}` }
    // The whole list has finished. This is the sole draft set; interruption above has no write or branch to keep.
    yield* onDisk.set(ctx.pending)
    const finalText = onDisk.text()!
    const recipe = resolveSource(finalText, path, path).recipe
    const base = branchOf(recipe)
    const trial = ctx.answers.trial ?? { trial: 'not-run' as const, because: 'no checks' as const }
    const hints = priceHints(summariseRecipe(recipe).models, fetchedRates())
    const common = {
      ok: true as const,
      project: 'local' as const,
      name,
      remote,
      base,
      trial,
      card: cardRecipe(recipe, toplevel),
      runtimes,
      hints,
      entries: walked.entries,
    }
    if (found !== undefined && onDisk.changes().length === 0) return { ...common, updated: true, unchanged: true }

    // A team-to-solo switch checks PRs before making anything; changeRecipe repeats the check at its write.
    const switching = fileText !== null && fileMode === 'team' && ctx.answers.mode === 'solo'
    if (switching) {
      const store = world.store ?? (yield* defaultStore())
      const prs = yield* refusingOn(listPrs(name, store).pipe(Effect.map((listed) => ({ listed }))), (error) => ({
        refused: `could not read the PRs of ${name} — ${errorText(error)}. ${world.kept}`,
      }))
      if ('refused' in prs) return prs
      const open = prs.listed.filter(isOpen)
      const draft = draftIn(prs.listed)
      if (open.length > 0 || draft.length > 0)
        return {
          refused: `${modeSwitchMessage(String(fileText === null ? 'main' : (resolveSource(fileText, path, path).recipe.branch.personal ?? 'main')), open, draft)}. ${world.kept}`,
        }
    }
    const make = ctx.answers.make
    const makeBranch = Effect.gen(function* () {
      if (make === undefined) return
      const made = yield* world.git(toplevel, ['branch', make.name, make.from])
      if (!made.ok)
        return yield* Effect.fail(
          new Error(
            `could not make ${make.name} from ${make.from} in ${toplevel} — ${(made.stderr || made.stdout).trim()}. ${world.kept}`,
          ),
        )
      tips.delete(make.name)
    })
    if (!switching) yield* makeBranch
    if (world.claudeToken !== undefined) yield* world.claudeToken(recipe, flags).pipe(Effect.catch(() => Effect.void))
    if (migrating && ports !== null) {
      const removal = yield* refusingOn(ports.removeMirror(name).pipe(Effect.as(null)), (error) => ({
        refused: `could not remove the mirror of ${name} — ${errorText(error)}. The recipe was not changed. ${world.kept}`,
      }))
      if (removal !== null) return removal
    }
    const resolved = yield* resolveDraftRecipeEffect(name, finalText, {
      home: world.home,
      signedIn: world.signedIn,
      ...HOST_FOR_SAVING,
      base,
    })
    const readTip = Effect.gen(function* () {
      const tip = yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${base}^{commit}`])
      if (!tip.ok)
        return yield* Effect.fail(
          new Error(`${base} is not a branch in ${toplevel} — ${(tip.stderr || tip.stdout).trim()}`),
        )
      tips.set(base, tip.stdout.trim())
    })
    if (!(switching && make?.name === base) && !tips.has(base)) yield* readTip
    const registration = yield* exclusiveAdd(
      name,
      applySetup(
        { home: world.home, by: world.by, store: world.store },
        { project: name, changes: onDisk.changes(), said: SAID },
        Effect.gen(function* () {
          if (switching) yield* makeBranch
          if (!tips.has(base)) yield* readTip
          return yield* world.register({
            project: name,
            owner: null,
            base,
            configHash: resolved.configHash,
            fromSha: tips.get(base)!,
            resolved,
          })
        }),
      ),
      world.locker,
    ).pipe(
      recoverWith((error) =>
        Effect.fail(error instanceof SetupWriteError ? error : new Error(`${errorText(error)}; ${keptSentence(path)}`)),
      ),
    )
    const leftBehind: LeftBehind[] = []
    const oldBase = fileText === null ? null : branchOf(resolveSource(fileText, path, path).recipe)
    if (switching && oldBase !== null)
      leftBehind.push({ what: `${oldBase} was left as it is — nothing on it is waiting to reach main` })
    if (oldBase !== null && make?.from === oldBase)
      leftBehind.push({
        what: `${make.name} was made from ${oldBase} at ${(tips.get(base) ?? '').slice(0, 9)} — ${oldBase} is kept and may be deleted`,
      })
    if (oldBase !== null && oldBase !== base && make?.name !== base) {
      const commits = yield* localPorts.commitsOnlyIn(base, oldBase)
      const command = `git -C ${toplevel} rev-list --oneline ${base}..${oldBase}`
      const listing =
        commits === null
          ? `the commits could not be read — ${command} lists them`
          : commits.length === 0
            ? 'none'
            : `${commits.length} commit${commits.length === 1 ? '' : 's'}: ${commits.join(' · ')}`
      leftBehind.push({
        what: `${base} existed and was left as it was — the commits only ${oldBase} has: ${listing}`,
        command,
      })
    }
    return { ...common, updated: registration.registered.updated, ...(leftBehind.length === 0 ? {} : { leftBehind }) }
  }).pipe(recoverWithLocal(world))
}

/** Preserve read and write failures by name, and let interruption leave the pending list alone. */
const recoverWithLocal =
  (world: FirstProjectWorld) =>
  <A>(effect: Effect.Effect<A, unknown>) =>
    refusingOn(effect, (error) => ({
      refused:
        errorText(error).includes('was not written') ||
        errorText(error).includes('was written') ||
        errorText(error).includes('is kept and nothing was registered')
          ? errorText(error)
          : `${errorText(error)}. ${world.kept}`,
    }))

function runGithubBranch(
  world: FirstProjectWorld,
  flags: Record<string, string>,
  givenSlug: string | null,
  knownApp: AppCheck | null,
): Effect.Effect<FirstProjectOutcome, unknown> {
  return Effect.gen(function* () {
    // #396's two questions are asked only by `lingtai add`'s `githubProjectAnswers`
    // (`lingtai.ts`), once a recipe already exists — never by the board wizard
    // this branch drives (#399's scope: "a GitHub one picked on the board …
    // reach[es] none of this yet"). Refused by name instead of silently
    // discarded, the same reason the `--github-app` check below exists.
    if (flags['tickets'] !== undefined || flags['kinds'] !== undefined) {
      const named = flags['tickets'] !== undefined ? `--tickets ${flags['tickets']}` : `--kinds ${flags['kinds']}`
      return {
        refused:
          `${named}, but a GitHub project asks neither question here — lingtai add asks both once its recipe ` +
          `exists. Leave it out. ${world.kept}`,
      }
    }

    // `askRecipe`'s own flags (#431) are asked only once `lingtai add` already
    // has a recipe to write them into, same reason as `--tickets`/`--kinds`
    // above — `init --project github`, with no slug, never calls `askRecipe`; `init --github <owner>/<repo>` and
    // `lingtai add` reach it through `githubProjectEffect` and never through here. Refused
    // by name instead of silently discarded (#431 fix round, finding 2).
    const recipeFlagNames = [
      'agent',
      'model',
      'reviewer',
      'reviewer-model',
      'install',
      'build',
      'check-build',
      'land',
      'rounds',
      'refusal-fixes',
      'conflict-resolutions',
      'wall',
      'budget',
    ]
    const namedRecipeFlag = recipeFlagNames.find((name) => flags[name] !== undefined)
    if (flags['rounds'] !== undefined) return { refused: `${ROUNDS_RETIRED}. ${world.kept}` }
    if (namedRecipeFlag !== undefined) {
      return {
        refused:
          `--${namedRecipeFlag} ${flags[namedRecipeFlag]}, but a GitHub project asks none of askRecipe's questions ` +
          `here — lingtai add asks them once its recipe exists. Leave it out. ${world.kept}`,
      }
    }

    // How this machine reaches GitHub was answered by the machine list, ahead of any App question (0114 §1).
    // A `gh` machine never has the App asked about, so `GET /app` is not made for it.
    let app: AppCheck | null = knownApp
    const elected = world.github.auth?.() ?? null
    const decided: { auth: 'gh' | 'app' | 'none'; pending: boolean } =
      world.github.decided ??
      (elected !== null
        ? { auth: elected, pending: false }
        : flags['github-auth'] === 'none'
          ? { auth: 'none', pending: false }
          : flags['github-auth'] === 'gh'
            ? { auth: 'gh', pending: false }
            : // Nothing elected and nothing decided for it: `app` is the one way left, and is written once the App exists.
              { auth: 'app', pending: true })
    if (decided.auth === 'none') {
      return {
        refused:
          'a GitHub project needs a way to reach GitHub, and github.auth is none here — run lingtai init ' +
          `--github-auth gh, or --github-auth app. ${world.kept}`,
      }
    }
    if (decided.auth !== 'gh') app ??= yield* world.github.app()

    if (decided.auth === 'gh') {
      // The saved `gh` login is the whole of the auth: no App to ask about or
      // create, no board to wait on, no picker (`livePicker` reads the App), and
      // no installation — `add()` checks the login's access itself.
      if (flags['github-app'] !== undefined && flags['github-app'] !== 'skip') {
        return {
          refused:
            `--github-app ${flags['github-app']}, but github.auth is gh here and no App is created. Leave out ` +
            `--github-app, or pass --github-app skip. ${world.kept}`,
        }
      }
      if (givenSlug === null)
        return { ok: true as const, project: 'github' as const, app: 'already' as const, auth: 'gh' as const }
      // The picker's `taken` guard, which this branch skips: a project is keyed by
      // the repository's name, so another owner's repository of the same name
      // would be written onto the existing project's stream.
      const { owner: givenOwner, repo: givenRepo } = parseSlug(givenSlug)
      const holder = (yield* world.projects()).find((p) => p.project?.toLowerCase() === givenRepo.toLowerCase())
      if (holder !== undefined && holder.owner !== null && holder.owner.toLowerCase() !== givenOwner.toLowerCase()) {
        return { refused: taken({ slug: givenSlug, repo: givenRepo, takenBy: holder.owner }) }
      }
      const said: string[] = []
      const baseFlag = flags['main']
      const added = yield* spunEffect(
        world,
        `registering ${givenSlug}`,
        world.github.add(
          {
            slug: givenSlug,
            installation: undefined,
            base: baseFlag === undefined ? undefined : { ref: baseFlag, named: true },
          },
          (line) => said.push(line),
        ),
      )
      if (!added.ok) {
        return { refused: said.filter((l) => l.trim() !== '').join('\n') || `${givenSlug} could not be registered` }
      }
      return {
        ok: true as const,
        project: 'github' as const,
        app: 'already' as const,
        slug: givenSlug,
        auth: 'gh' as const,
        updated: added.updated,
        warnings: added.warnings,
        reach: added.reach,
      }
    }

    app ??= yield* world.github.app()
    if (app.configured && !app.ok) {
      return {
        refused:
          `the GitHub App configured here does not answer — ${app.why}. Fix its credentials, or remove them, and ` +
          `run this again. ${world.kept}`,
      }
    }

    // A slug given directly — `--github <owner>/<repo>`, or `add`'s positional
    // — reaches here with `kind` already settled as `github`, bypassing the
    // `--github-app` contradiction checks above (`chooseFirstProject`'s
    // `kind === null` branches), which never ran. Checked again here instead,
    // so the flag is refused rather than silently discarded on that path too
    // (#394 finding 8).
    if (app.configured && flags['github-app'] !== undefined && flags['github-app'] !== 'skip') {
      return {
        refused:
          `--github-app ${flags['github-app']}, but a GitHub App is already configured here and none is created ` +
          `now. Leave out --github-app, or pass --github-app skip. ${world.kept}`,
      }
    }

    let appOutcome: 'already' | AppWaitResult = 'already'

    if (!app.configured) {
      const asked = yield* askFirstProjectEffect(world, { ...flags, project: 'github' }, world.kept, cancelFor(world))
      if ('refused' in asked) return { refused: asked.refused }
      const appAnswer = asked.project === 'github' ? asked.app : 'create'

      const boardUrl = yield* world.github.boardUrl()
      if (boardUrl === null) {
        return {
          refused:
            'no board is running here to create the GitHub App on — start one with lingtai init --project github, ' +
            `or lingtai board, then run this again. ${world.kept}`,
        }
      }

      if (appAnswer === 'skip') {
        world.log(appComeBackLine(boardUrl, 'skipped'))
        return { ok: true as const, project: 'github' as const, app: { skipped: true as const } }
      }

      const waited = yield* world.github.waitForApp(boardUrl)
      if (!('made' in waited)) return { ok: true as const, project: 'github' as const, app: waited }
      appOutcome = waited
      // Written only now that the App exists: `app` ahead of one would make the
      // next `add` take an App check that throws rather than saying "not installed".
      if (decided.pending) {
        const failed = yield* refusingOn(world.github.writeAuth('app').pipe(Effect.as(null)), (err) => ({
          refused: `${(err as Error).message}. ${world.kept}`,
        }))
        if (failed !== null) return failed
      }
    }

    if (givenSlug === null) return { ok: true as const, project: 'github' as const, app: appOutcome }

    const picker = yield* world.github.picker()
    // `choose()`'s "already onboarded" is written for the picker's offer-it-once
    // screen, not for re-running `lingtai add` on a project this is — the
    // `registrationLine` "updated" path (#163), and `unrecorded()`'s own advice
    // to run exactly this command for the owner it names. `add()` resolves the
    // installation itself (`installationForRepo`), so the given owner is the
    // disambiguation rather than something `choose()` has to confirm first.
    let installation: Installation | undefined
    if (!alreadyOnboarded(picker, givenSlug)) {
      const picked = choose(picker, givenSlug)
      if (!picked.ok) {
        // `add()`'s own gap listing (`onboard.ts:267-271`) never runs on this
        // path — `choose` refused before `add` was ever called — so the detail
        // it would have printed is reduced into the refusal here instead (#394
        // finding: a scope gap must not come back as one bare sentence).
        return { refused: refusalLines(picked).join('\n') }
      }
      installation = picked.installation
    }

    // Collected rather than logged as they arrive (the success path prints `warnings` only, #755): on a refusal, the caller
    // prints `refused` itself (`initCommand`'s `refuse()`, `addCommand`'s
    // `console.error`), and logging each line here too printed the whole
    // failure twice (#394 finding 7). On success only the warnings are printed, ahead of the card.
    const said: string[] = []
    const baseFlag = flags['main']
    const added = yield* spunEffect(
      world,
      `registering ${givenSlug}`,
      world.github.add(
        {
          slug: givenSlug,
          installation,
          base: baseFlag === undefined ? undefined : { ref: baseFlag, named: true },
        },
        (line) => said.push(line),
      ),
    )
    if (!added.ok) {
      return { refused: said.filter((l) => l.trim() !== '').join('\n') || `${givenSlug} could not be registered` }
    }
    return {
      ok: true as const,
      project: 'github' as const,
      app: appOutcome,
      slug: givenSlug,
      updated: added.updated,
      warnings: added.warnings,
      reach: added.reach,
    }
  })
}

// ------------------------------------------------------------- live world --

const execFileAsync = promisify(execFile)

/** One real `git`, for `liveFirstProjectWorld` and (through `liveGit`) `init.ts`. */
export const liveGitEffect = (dir: string, args: readonly string[]): Effect.Effect<GitResult> =>
  refusingOn(
    Effect.tryPromise({ try: () => execFileAsync('git', args as string[], { cwd: dir }), catch: (e) => e }).pipe(
      Effect.map(({ stdout, stderr }): GitResult => ({ ok: true, stdout, stderr })),
    ),
    (err): GitResult => {
      const failed = err as { stdout?: string; stderr?: string; message: string }
      return { ok: false, stdout: failed.stdout ?? '', stderr: failed.stderr ?? failed.message }
    },
  )

/** Opens a browser; false when none could be. Never rejects. */
export function liveOpen(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

const liveInstallUrlEffect = (): Effect.Effect<string | null> =>
  checkAppEffect().pipe(
    Effect.map((app) => (app.configured && app.ok ? `https://github.com/apps/${app.slug}/installations/new` : null)),
  )

/**
 * The picker of the App's installations: `liveRepositoryListEffect('app')`, with today's throw as a failure.
 */
export const livePickerEffect = (): Effect.Effect<Picker, unknown> =>
  liveRepositoryListEffect('app').pipe(
    Effect.flatMap((list) =>
      list.kind !== 'app' ? Effect.fail(new Error('the App picker was given a gh list')) : Effect.succeed(list.picker),
    ),
  )

/**
 * What a person can pick from on this machine (#969): the App's installations,
 * or the repositories the saved `gh` login can push to. Fails with the
 * sentence to print when the read failed — never an empty list.
 */
export const liveRepositoryListEffect = (auth: 'app' | 'gh'): Effect.Effect<RepositoryList, Error> =>
  Effect.gen(function* () {
    // `repositoryList`'s `installUrl` is still a promise port, so it is carried this fiber's services.
    const services = yield* Effect.context<never>()
    return yield* repositoryList(auth, {
      installUrl: () => Effect.runPromiseWith(services)(liveInstallUrlEffect()),
    })
  })

/**
 * `askRecipe`'s `reader`, for a local directory: `has` over `node:fs`'s
 * `existsSync` (never `read`-then-check — a file that cannot be read for some
 * other reason must not read as "not here" the way `read` returning null
 * would make it), `read` returning null on anything that is not ENOENT too,
 * since a detection suggestion is never worth throwing over.
 *
 * Exported for `init.ts`'s `liveInitWorld()` — one real reader, not two.
 */
export function liveSetupReader(dir: string): SetupReader {
  return {
    has: (path) => Effect.sync(() => existsSync(join(dir, path))),
    read: (path) =>
      Effect.tryPromise(() => readFile(join(dir, path), 'utf8')).pipe(Effect.orElseSucceed((): string | null => null)),
  }
}

export interface LiveFirstProjectOptions {
  ask: QuestionWorld['ask']
  spin?: QuestionWorld['spin']
  log: (line: string) => void
  /**
   * What a refusal says was kept. `Nothing was written` unless the caller
   * already wrote something. `lingtai add <owner>/<repo>` runs
   * `githubProjectAnswers` first, but its answers are a pending draft that
   * `applySetup` writes only just before the registration they belong to; what
   * it has already written is the machine's own `github.auth`, so a refusal
   * here says what was kept only for that.
   */
  kept?: string
}

/**
 * `lingtai add`'s live seam — everything `chooseFirstProject` asks of the
 * world, built for real: a real `git`, the real log (`loadAllProjects`,
 * `addLocal`), the real recipe files, and the real GitHub App. `init` builds
 * its own from `InitWorld` and does not call this.
 *
 * The board is found with `boardAt(boardPort())`, since `add` starts none of
 * its own, and the App wait skips on a keypress (`waitForKeypress`, in
 * `keypress.ts` so `init` and `add` share one).
 */
export function liveFirstProjectWorld(options: LiveFirstProjectOptions): FirstProjectWorld {
  const appWait: Pick<AppWaitWorld, 'open' | 'appeared' | 'pressed'> = {
    open: (url) => lift(() => liveOpen(url)),
    appeared: pollForAppEffect,
    pressed: () =>
      Effect.tryPromise({
        try: (signal) => waitForKeypress(process.stdin, signal, 'running the same command again continues from here'),
        catch: (e) => e,
      }),
  }
  const home = stateDir()

  return {
    interactive: interactivity(false).stdinIsTTY && interactivity(false).stdoutIsTTY,
    ask: options.ask,
    ...(options.spin === undefined ? {} : { spin: options.spin }),
    log: options.log,
    git: liveGitEffect,
    exists: pathExistsEffect,
    projects: () => loadAllProjectsEffect(),
    by: `human:${userInfo().username}`,
    home,
    sandboxHost: () => sandboxHostHere(),
    claudeToken: (recipe, flags) => {
      const machine = machineSetup(
        liveMachineWorld(
          { ask: options.ask, log: options.log, ...(options.spin === undefined ? {} : { spin: options.spin }) },
          { app: checkAppEffect, ghStatus: () => ghStatusEffect() },
        ),
        { githubRequired: false, command: 'lingtai add' },
      )
      return askTokenFor(machine, options, flags, recipe)
    },
    signedIn: signedInHere,
    runtimes: askRuntimesEffect,
    setupReader: liveSetupReader,
    // `lingtai add` is the only caller. With a slug, `githubProjectAnswers`
    // holds its answers as a pending draft, written by `applySetup` just before
    // the registration, so a refusal before that keeps none of them.
    kept: options.kept ?? 'Nothing was written',
    register: (payload) =>
      addLocalEffect(
        {
          project: payload.project,
          base: payload.base,
          configHash: payload.configHash,
          fromSha: payload.fromSha,
        },
        payload.resolved,
      ),
    history: liveHistoryEffect,
    inFlight: liveInFlightEffect,
    removeMirror: (project) => liveRemoveMirrorEffect(project, home),
    github: {
      auth: () => githubAuthKind(),
      ghStatus: () => ghStatusEffect(),
      writeAuth: (kind) =>
        Effect.try({ try: () => writeGithubAuth(liveMachineText(), join(home, 'config.yml'), kind), catch: (e) => e }),
      app: checkAppEffect,
      boardUrl: () => boardAtEffect(boardPort(), boardReachHost(boardHost())),
      waitForApp: (boardUrl) => waitForAppEffect({ log: options.log, ...appWait }, boardUrl, { waitMs: APP_WAIT_MS }),
      picker: livePickerEffect,
      add: (opts: AddOptions, log) => addEffect(opts, log),
    },
  }
}
