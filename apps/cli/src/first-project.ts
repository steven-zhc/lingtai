/**
 * The first question `init` and `add` share (#394): a GitHub repository, or a
 * git checkout on this machine, which is its own remote.
 *
 * **One function, both callers.** `initCommand` and `addCommand` both call
 * `chooseFirstProject`, which asks through `question()` (#392) and the App
 * questions of #393's `askFirstProject`, and declares the slice of the world
 * it needs (`FirstProjectWorld`) rather than depending on `InitWorld` —
 * `question.ts` and `github-app.ts` already follow that rule, and `add` has no
 * `InitWorld` to depend on.
 *
 * **Remembering the answer is registering the project, not writing it down
 * twice.** Nothing machine-wide holds `local` or `github`; a project once
 * registered *is* the record, and `init`'s own printed list of what is
 * registered (`init.ts`) is how a machine with only local projects is told
 * how to add a GitHub one, rather than being asked the same question again.
 *
 * **The local branch writes nothing until everything has been checked.** The
 * directory is a git repository, it is the remote (0104 §15 — the merge lane
 * pushes back into the checkout, `packages/actions/src/merge-action.ts:47`; no
 * `origin` is needed), its name is not already
 * another project's, the base branch exists, and an agent can run here — only
 * then does `askRecipe` (#431) take `repo.base`, `repo.remote` and, on an
 * absent file, `env.plantAt` as its seeds, and ask the rest of the recipe's
 * questions — writing all of it, seeds and answers together, in the one
 * creation write an absent file gets (#432). **That seed's `base` is not
 * necessarily final**: `askLanding`, inside `askRecipe`, can still move
 * `repo.base` — so what follows is a re-read of the file for its actual
 * `repo.base`, a second `git rev-parse` for that base's sha when it moved,
 * `resolveLocalRecipe` reading the file back for its `configHash`, and
 * `register` (`addLocal` in `@lingtai/conductor/onboard`) appending
 * `ProjectConfigured` with `owner: null` against that final base, not the
 * one the seed wrote.
 *
 * **The GitHub branch is #393's App step, unchanged, plus the picker.** No App
 * configured runs `askFirstProject`'s App question and `waitForApp`; a slug
 * given or asked for is checked against `listRepositories` (`choose`,
 * `@lingtai/conductor/pick-repository`) and handed to `add`
 * (`@lingtai/conductor/onboard`) exactly as `lingtai add <owner>/<repo>` does
 * today.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { basename, join, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

import { exclusiveAdd } from '@lingtai/conductor/add-from-page'
import { addEffect, addLocalEffect, type Added, type AddOptions, type GithubReach } from '@lingtai/conductor/onboard'
import { alreadyOnboarded, choose, refusalLines, taken } from '@lingtai/conductor/pick-repository'
import { loadAllProjectsEffect, signedInHere } from '@lingtai/conductor/projects'
import { repositoryList } from '@lingtai/conductor/repository-list'
import { liveHistoryEffect } from '@lingtai/conductor/ticket-history'
import { held } from '@lingtai/daemon'
import type { ProjectState } from '@lingtai/domain'
import { boardHost, boardPort, boardReachHost, githubAuthKind, stateDir } from '@lingtai/env'
import type { Locker } from '@lingtai/env/lock'
import { ghStatusEffect, type GhStatus, type Installation, parseSlug } from '@lingtai/github'
import { readTasksEffect } from '@lingtai/projector'
import {
  baseOf,
  diskFiles,
  landOnBranchChanges,
  readRecipeKeyEffect,
  recipePath,
  resolveLocalRecipeEffect,
  resolveSource,
  type RecipeFiles,
  type ResolvedRecipe,
  type SignedIn,
} from '@lingtai/recipe'
import { mirrorPathFor } from '@lingtai/repo'
import { type Picker, type RepositoryList, type SetupReader } from '@lingtai/setup'
import { askRuntimesEffect, proposeSetup, type RuntimeFound } from '@lingtai/setup'
import {
  alreadyAddedSentence,
  applySetup,
  keptSentence,
  liveTrialBuild,
  previewSetup,
  SetupWriteError,
} from '@lingtai/setup'
import { Cause, Effect } from 'effect'

import { noRuntimesSignedInRefusal } from './agents.ts'
import { checkAppEffect, pollForApp, type AppCheck } from './app-check.ts'
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
import { askGithubAuthEffect, liveMachineText, writeGithubAuth } from './github-auth.ts'
import { waitForKeypress } from './keypress.ts'
import { acceptingDefaults, questionEffect, spunEffect, type QuestionWorld } from './question.ts'
import { ADD_KEPT, askRecipeEffect, ENV_PLANT_AT } from './recipe-flow.ts'
import type { TrialOutcome } from './setup-build.ts'
import { cardRecipe, type CardRecipe } from './setup-card.ts'

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

/** `pathExistsEffect`, for `init.ts` until CLI-22b. */
export function pathExists(path: string): Promise<boolean> {
  return Effect.runPromise(pathExistsEffect(path))
}

/**
 * Every IO member returns an Effect; `ask`, `log` and `spin` are clack's and stay as `QuestionWorld` has them.
 * A rejection or a throw inside a member is a failure or a defect, and the refusals below treat both alike.
 */
export interface FirstProjectWorld extends QuestionWorld {
  git: (dir: string, args: readonly string[]) => Effect.Effect<GitResult, unknown>
  /** Whether a path exists — a seam so the unit tests never touch the disk (0060 §1). */
  exists: (path: string) => Effect.Effect<boolean, unknown>
  /** `loadAllProjects` — registered and pending alike, keyed by name. */
  projects: () => Effect.Effect<readonly ProjectState[], unknown>
  /** The lock an add is made under (`exclusiveAdd`): the machine's file lock unless a test hands one in. */
  locker?: Locker
  files: RecipeFiles
  /** `stateDir()` unless a test says otherwise. */
  home: string
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
      name: string
      remote: string
      base: string
      trial: TrialOutcome
      /** The recipe as written, for the summary card. */
      card: CardRecipe
      /** The project was already registered. */
      updated: boolean
      /** The runtimes this run already probed. */
      runtimes: readonly RuntimeFound[]
      /** Lines the card's closing prints, muted, after the groups. */
      hints: string[]
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
function conflictingFlags(flags: Record<string, string>, kept: string): string | null {
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
  if (auth !== undefined && local !== undefined) {
    return (
      `--github-auth ${auth}, but --local ${local} reaches no GitHub. Leave out --github-auth, or leave out ` +
      `--local. ${kept}`
    )
  }
  if (auth !== undefined && flags['project'] === 'local') {
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
  const base = flags['base']
  const land = flags['land']
  // `--land <branch>` and `--base` are different questions — where to read the
  // recipe from, and what it should land on — and a person who named both must
  // not have one silently overrule the other (#399, mirroring #75's rule for
  // `--base` against the recipe's own `repo.base`). Checked here, before
  // anything is written, rather than inside `askRecipe`, where `askLanding`
  // would otherwise overwrite the base question's own answer silently.
  if (base !== undefined && land !== undefined && land !== 'hold' && land !== base) {
    return `--land ${land} and --base ${base} name two different branches, and this command will not pick one silently. ${kept}`
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
      if (flags['github-auth'] !== undefined) {
        return {
          refused:
            `--github-auth ${flags['github-auth']}, but --project local reaches no GitHub. Leave out ` +
            `--github-auth, or pass --project github. ${kept}`,
        }
      }
      return { kind: 'local' as const }
    }
    return { kind: 'github' as const }
  })
}

/** The face of `chooseFirstProjectEffect` for `init.ts` and `add.ts`, which still await it (CLI-22a, CLI-22b). */
export function chooseFirstProject(
  world: FirstProjectWorld,
  flags: Record<string, string>,
  buildFlags: readonly string[] = [],
  deferRecipeFlags = false,
): Promise<FirstProjectOutcome> {
  return Effect.runPromise(chooseFirstProjectEffect(world, flags, buildFlags, deferRecipeFlags))
}

export function chooseFirstProjectEffect(
  world: FirstProjectWorld,
  flags: Record<string, string>,
  /** Every `--build <cmd>` on the command line, in order — `flags['build']` alone is only the last (#431 fix round, finding 3). */
  buildFlags: readonly string[] = [],
  /**
   * The caller will ask the recipe questions itself once a repository is picked
   * (`lingtai add`), so the GitHub branch is handed the flags without them. The
   * local branch still gets every flag: it asks the recipe here.
   */
  deferRecipeFlags = false,
): Effect.Effect<FirstProjectOutcome, unknown> {
  return Effect.gen(function* () {
    const conflict = conflictingFlags(flags, world.kept)
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
      if (app.configured && world.githubAppIsTheProject === true) {
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
          deferRecipeFlags
            ? Object.fromEntries(Object.entries(flags).filter(([n]) => !RECIPE_FLAGS.includes(n)))
            : flags,
          flags['github'] ?? null,
          appCheck,
        )
  })
}

/** The flags only `askBeforeGithubAdd` consumes, which the board branch refuses. */
export const RECIPE_FLAGS = [
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
]

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

/** `askRecipeEffect`'s result — the same value `askRecipe` resolved to. */
type RecipeResult = Effect.Success<ReturnType<typeof askRecipeEffect>>

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
    let oldRemote = ''
    // Only `add --local` rewrites a landing: `init` supplies neither port, and its name guard stays as it was.
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
    const existingRemote = yield* readRecipeKeyEffect(name, ['repo', 'remote'], {
      home: world.home,
      files: world.files,
    })
    if (typeof existingRemote === 'string' && existingRemote !== remote) {
      // A checkout with no `origin` has only the top level to match.
      const got = yield* world.git(toplevel, ['remote', 'get-url', 'origin'])
      const origin = got.ok && got.stdout.trim() !== '' ? resolveRemote(got.stdout.trim(), toplevel) : null
      moving = ports !== null && origin !== null && existingRemote === origin
    }
    if (typeof existingRemote === 'string') oldRemote = existingRemote
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

    let fromSha = ''
    const proposedNow = yield* readRecipeKeyEffect(name, ['steps', 'proposed'], {
      home: world.home,
      files: world.files,
    })
    const currentProposed = Array.isArray(proposedNow) ? (proposedNow as unknown[]) : []
    // The base the recipe resolves: a `worktree:` at `admit` says it ahead of `repo.base` (`baseOf`), so that
    // is the one compared, moved and seeded below.
    const recipeOptions = { home: world.home, files: world.files }
    const admitNow = yield* readRecipeKeyEffect(name, ['steps', 'admit'], recipeOptions)
    const declaredAtAdmit = Array.isArray(admitNow)
      ? (admitNow as unknown[]).find(
          (entry): entry is { worktree: { base?: unknown } } =>
            typeof entry === 'object' && entry !== null && 'worktree' in entry,
        )
      : undefined
    const currentBase =
      declaredAtAdmit !== undefined
        ? declaredAtAdmit.worktree.base
        : yield* readRecipeKeyEffect(name, ['repo', 'base'], recipeOptions)
    // `lingtai-base` is made from the checked-out branch when absent. A `--land <branch>` with no `--base`
    // names the branch the person means to land on, and `askLanding` would move the base there anyway.
    const given = flags['land']
    const detected = flags['base'] === undefined && given !== undefined && given !== 'hold' ? given : LINGTAI_BASE
    // Set by `validate` when the answer is `lingtai-base` and absent: the branch to make it from.
    let source: string | null = null

    // Already added and the old remote is not what it names (#772): `lingtai add` refuses, naming the
    // recipe, before it asks anything. Only the move off the checkout's `origin` is a repair.
    if (found !== undefined && ports !== null && !moving) {
      return { refused: `${alreadyAddedSentence(found.project!, world.home)}. ${world.kept}` }
    }

    // Already added and a rerun of `init` (no ports): it says so and goes on, writing and registering
    // nothing — a machine whose first project is added must not fail. `lingtai add` was refused above.
    const initRerun = found !== undefined && ports === null && !moving
    if (initRerun) {
      world.log(`${found.project} is already added — its recipe is ${recipePath(found.project!, world.home)}`)
      const recipeAt = recipePath(name, world.home)
      const existing = yield* lift(() => world.files.read(recipeAt))
      if (existing !== null) {
        const recipe = resolveSource(existing, recipeAt, recipeAt).recipe
        return {
          ok: true as const,
          project: 'local' as const,
          name,
          remote,
          base: baseOf(recipe),
          trial: { trial: 'not-run' as const, because: 'no checks' },
          card: cardRecipe(recipe, toplevel),
          updated: true,
          runtimes: yield* world.runtimes(),
          hints: [],
        }
      }
    }

    // A detected answer, so `--defaults` takes it; the project, App and store questions are durable and stay unwrapped.
    const baseAnswer = yield* questionEffect(
      flags['defaults'] !== undefined ? { ...world, ...acceptingDefaults(world) } : world,
      {
        name: 'the base branch',
        flag: '--base <branch>',
        given: flags['base'] ?? null,
        prompt: "the branch this project's recipe governs and merges into",
        // `add --local` lands on `lingtai-base` unless a flag says otherwise (0104 §15): enter must not keep the recorded base.
        current: typeof currentBase === 'string' && ports === null ? currentBase : null,
        detected,
        kept: world.kept,
        ...(world.startOver === undefined ? {} : { startOver: world.startOver }),
        ...(world.command === undefined ? {} : { command: world.command }),
        validate: (answer) =>
          Effect.gen(function* () {
            source = null
            const check = yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${answer}^{commit}`])
            if (check.ok) {
              fromSha = check.stdout.trim()
              return null
            }
            if (answer !== LINGTAI_BASE) {
              return `${answer} is not a branch in ${toplevel} — ${(check.stderr || check.stdout).trim()}`
            }
            // Decides only: `validate` can run again on a refusal, so nothing is created here.
            const head = yield* world.git(toplevel, ['symbolic-ref', '--short', '-q', 'HEAD'])
            const branch = head.ok ? head.stdout.trim() : ''
            const tip =
              branch === ''
                ? null
                : yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
            if (tip === null || !tip.ok) {
              return (
                `${toplevel} has no branch checked out, and ${LINGTAI_BASE} is made from the one that is. ` +
                'Check out a branch, or pass --base <branch>'
              )
            }
            source = branch
            return null
          }),
      },
    )
    if ('refused' in baseAnswer) return { refused: baseAnswer.refused }
    const base = baseAnswer.answer

    // Probed once, before anything is written — an agent signed out of
    // nowhere is refused by name rather than discovered partway through
    // `askRecipe`'s own first question (#431).
    const runtimes = yield* world.runtimes()
    if (!runtimes.some((r) => r.signedIn)) {
      return { refused: noRuntimesSignedInRefusal(runtimes) }
    }

    // A move is the remote leaving the old one, or the base differing from the one recorded.
    const migrating =
      ports !== null &&
      typeof existingRemote === 'string' &&
      // Any rewrite of the recipe's landing is a move — whether or not the old remote was recognised as the checkout's `origin`.
      (existingRemote !== remote || (typeof currentBase === 'string' && currentBase !== base))
    // A repair of a registered project asks none of the questionnaire, so a flag that would answer one is
    // refused by name rather than dropped while the registration succeeds. `--land` is the base's own flag.
    if (found !== undefined && migrating) {
      const unread = [
        'agent',
        'model',
        'reviewer',
        'reviewer-model',
        'build',
        'check-build',
        'rounds',
        'wall',
        'budget',
        'tickets',
        'kinds',
      ].find((n) => flags[n] !== undefined)
      // `--install none` asks for no command, so a repair that adds none honours it; any other answer would be dropped.
      const installFlag = flags['install']
      // ... but not over a recipe that already names one, written or inherited from its preset.
      const recipeNow =
        installFlag === 'none' ? yield* lift(() => world.files.read(recipePath(name, world.home))) : null
      let prepared: unknown = null
      if (recipeNow !== null) {
        // Resolved as the repair will leave it (with the base and remote it supplies), so a recipe that
        // only fails to resolve for want of those is still read through its preset; one that still does not
        // resolve is taken to keep its install, never to have none.
        prepared = yield* refusingOn(
          previewSetup(
            { home: world.home, files: world.files },
            {
              project: name,
              changes: [
                { path: ['repo', 'base'], value: base },
                { path: ['repo', 'remote'], value: remote },
              ],
            },
          ).pipe(
            Effect.map((after): unknown => {
              const at = recipePath(name, world.home)
              return resolveSource(after, at, at).recipe.steps.prepared
            }),
          ),
          (): unknown => [null],
        )
      }
      const keepsInstall = Array.isArray(prepared) && prepared.length > 0
      const unapplied =
        unread ?? (installFlag !== undefined && (installFlag !== 'none' || keepsInstall) ? 'install' : undefined)
      const landFlag = flags['land']
      if (unapplied !== undefined || (landFlag !== undefined && landFlag !== base)) {
        const n = unapplied ?? 'land'
        return {
          refused:
            `--${n} ${flags[n]}, but ${name} is already added and this only moves its landing — its recipe is ` +
            `${recipePath(name, world.home)}, and it is edited there. Leave it out. ${world.kept}`,
        }
      }
    }
    // Every refusal of a move comes before the first write — the branch below is one.
    if (migrating && ports !== null) {
      world.log(
        `lands: ${oldRemote} ${typeof currentBase === 'string' ? currentBase : '(none)'} → this checkout, ${base}`,
      )
      const flying = yield* refusingOn(ports.inFlight(name), (error) => ({
        refused: `could not read the board to check for an attempt of ${name} in flight — ${errorText(error)}. ${world.kept}`,
      }))
      if ('refused' in flying) return flying
      if (flying.length > 0) {
        return {
          refused:
            `an attempt of ${name} is in flight (${flying.join(', ')}) — moving its landing under it would cut and land ` +
            `on two remotes. Run this again once they finish, or after lingtai shutdown. ${world.kept}`,
        }
      }
      const confirmed = yield* lift(() =>
        world.ask(`Move ${name}'s landing from ${oldRemote} to this checkout, and rebuild its mirror? [y/N]`, {
          message: `Move ${name}'s landing to this checkout?`,
          defaultValue: 'no',
          choices: ['yes', 'no'],
          kept: world.kept,
        }),
      )
      // `null` is no terminal: the line above is the record.
      if (confirmed !== null && !/^y(es)?$/i.test(confirmed.trim())) {
        return { refused: `${name}'s landing was not moved. ${world.kept}` }
      }
    }

    if (migrating && ports !== null) {
      // The mirror keeps the `origin` it was cloned with, so it is cloned again from the checkout.
      const removal = yield* refusingOn(ports.removeMirror(name).pipe(Effect.as(null)), (error) => ({
        refused:
          `could not remove the mirror of ${name} — ${errorText(error)}. The recipe was not changed, ` +
          `and no branch was made. ${world.kept}`,
      }))
      if (removal !== null) return removal
    }

    // After the runtimes probe, whose refusal says nothing was written; before `askRecipe`, whose trial build
    // cuts from a mirror of this checkout at `base`.
    let madeKept: string | null = null
    if (source !== null) {
      const made = yield* world.git(toplevel, ['branch', base, source])
      if (!made.ok) {
        return {
          refused: `could not make ${base} from ${source} in ${toplevel} — ${(made.stderr || made.stdout).trim()}. ${world.kept}`,
        }
      }
      const tip = yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${base}^{commit}`])
      if (!tip.ok) {
        return {
          refused:
            `could not read ${base} after making it from ${source} in ${toplevel} — ${(tip.stderr || tip.stdout).trim()}. ` +
            `No recipe was written, and nothing was registered; the branch ${base} is kept.`,
        }
      }
      fromSha = tip.stdout.trim()
      madeKept = `the branch ${base} made from ${source} in ${toplevel}`
    }

    const path = recipePath(name, world.home)
    const existingText = yield* lift(() => world.files.read(path))

    // `env.plantAt` has no schema default (`recipe.ts`'s `plantAt: z.string()`)
    // — a brand-new file needs it or it will not resolve at all, and nothing a
    // directory offers answers it either. Written only when there is no file
    // yet: an existing one already has it, possibly edited since, and a re-run
    // must not overwrite that silently. `source.kinds` is no longer seeded here
    // — `askRecipe`'s own `askKinds` always answers it on an absent file (#432).
    const seeds = [
      // `--land <branch>` is the unattended landing, so it takes a `human:` hold off `steps.proposed` as it does elsewhere.
      ...landOnBranchChanges(
        base,
        found !== undefined && flags['land'] !== undefined && flags['land'] !== 'hold' ? currentProposed : [],
        Array.isArray(admitNow) ? admitNow : null,
      ),
      { path: ['repo', 'remote'], value: remote },
      ...(existingText === null ? [{ path: ['env', 'plantAt'], value: ENV_PLANT_AT }] : []),
    ]

    // Not `world.kept`: that described the state before `askRecipe` writes
    // anything, and a refusal placed after its write must say what that write
    // left behind (#431 fix round, finding 3).
    const seededKept =
      `Nothing was written to ${path} and nothing was registered` + (madeKept === null ? '' : `; ${madeKept} is kept`)

    // What step 2 would show for this directory. `lingtai add --local` still
    // registers no owner and so still keeps `db` (`askTickets` refuses `github`
    // for it); the proposal's kinds are the part that reaches the questions.
    const proposal = yield* proposeSetup(
      { kind: 'local', path: toplevel },
      {
        setupReader: world.setupReader(toplevel),
        defaultBranch: () => Effect.succeed(base),
        runtimes: () => Effect.succeed(runtimes),
        history: (project) => world.history(project),
        // No `origin` is an answer (null); a git that failed is not.
        origin: (path) =>
          Effect.gen(function* () {
            const remotes = yield* world.git(path, ['remote'])
            if (!remotes.ok) return yield* Effect.fail(new Error(remotes.stderr.trim() || 'git remote failed'))
            if (!remotes.stdout.split('\n').some((r) => r.trim() === 'origin')) return null
            const url = yield* world.git(path, ['remote', 'get-url', 'origin'])
            if (!url.ok) return yield* Effect.fail(new Error(url.stderr.trim() || 'git remote get-url origin failed'))
            return url.stdout.trim() || null
          }),
      },
    )

    // A repair of a registered project (#772) changes what it moves and nothing else: no questionnaire,
    // so no answer can touch another setting of a recipe that is edited by hand.
    const repairOnly = found !== undefined && migrating
    const repairResult: RecipeResult = {
      ok: true,
      trial: { trial: 'not-run', because: 'no checks' },
      hints: [],
      answers: { project: name, changes: seeds },
    }
    // `askRecipe`'s own `history` is still a promise port (`askTickets`'s), so it is carried the caller's services.
    const services = yield* Effect.context<never>()
    const recipeResult = repairOnly
      ? repairResult
      : yield* askRecipeEffect(world, {
          project: name,
          local: true,
          proposal,
          runtimes,
          reader: world.setupReader(toplevel),
          flags,
          buildFlags,
          defaultBranch: () => Promise.resolve(base),
          // Over the draft the questions are answering, not the disk: a seed or an answer that moves the base
          // is what the trial must build (#968).
          tryBuild: (draft) =>
            liveTrialBuild({
              project: name,
              owner: '',
              repo: name,
              base,
              remote,
              home: world.home,
              files: draft,
            }),
          history: (project) => Effect.runPromiseWith(services)(world.history(project)),
          seeds,
          again: `lingtai add --local ${toplevel}`,
          keptBeforeWrite:
            madeKept === null ? world.kept : `No recipe was written, and nothing was registered; ${madeKept} is kept`,
          kept: seededKept,
          home: world.home,
          files: world.files,
        })
    if ('refused' in recipeResult) return { refused: recipeResult.refused }

    // `askLanding`, inside `askRecipe`, can move `repo.base` on a local
    // project (#431's Watch out) — re-read the file it left behind rather than
    // trust the `base` this function's own question settled.
    const previewedOrRefused = yield* refusingOn(
      previewSetup({ home: world.home, files: world.files }, recipeResult.answers).pipe(
        Effect.map((text) => ({ previewed: text })),
      ),
      (error) => ({ refused: `${errorText(error)}. ${ADD_KEPT}` }),
    )
    if ('refused' in previewedOrRefused) return previewedOrRefused
    const previewed = previewedOrRefused.previewed
    const finalRecipe = resolveSource(previewed, path, path).recipe
    const final = baseOf(finalRecipe)

    let finalFromSha = fromSha
    if (final !== base) {
      const check = yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${final}^{commit}`])
      if (!check.ok) {
        return {
          refused: `${final} is not a branch in ${toplevel} — ${(check.stderr || check.stdout).trim()}. ${ADD_KEPT}${madeKept === null ? '' : `; ${madeKept} is kept too`}`,
        }
      }
      finalFromSha = check.stdout.trim()
    }

    const resolved = yield* resolveLocalRecipeEffect(name, {
      home: world.home,
      signedIn: world.signedIn,
      base: final,
      // The recipe is still only a draft (`applySetup` is its one writer), so it is resolved over that text.
      read: (p) => (p === path ? Promise.resolve(previewed) : world.files.read(p)),
    })

    // `register`'s live implementation (`addLocal`, `onboard.ts` — the only place a directory gets a
    // `ProjectConfigured`) logs the "added"/"updated" line itself. It is the port `applySetup` is handed:
    // the recipe is written once, just before it.
    const appliedOrRefused = yield* refusingOn(
      Effect.suspend(() => {
        // Under the lock the board's Add takes; a project not yet registered is checked again inside it,
        // since another process may have added it since the read above.
        const write = applySetup(
          { home: world.home, files: world.files },
          recipeResult.answers,
          Effect.suspend(() =>
            world.register({
              project: name,
              owner: null,
              base: final,
              configHash: resolved.configHash,
              fromSha: finalFromSha,
              resolved,
            }),
          ).pipe(Effect.mapError((err) => (err instanceof Error ? err : new Error(String(err))))),
        )
        return exclusiveAdd(
          name,
          found !== undefined
            ? write
            : recoverWith(world.projects(), (err) =>
                Effect.fail(new SetupWriteError(`could not read the projects: ${errorText(err)}`)),
              ).pipe(
                Effect.flatMap((now) =>
                  now.some((p) => p.project?.toLowerCase() === name.toLowerCase())
                    ? Effect.fail(new SetupWriteError(alreadyAddedSentence(name, world.home)))
                    : write,
                ),
              ),
          world.locker,
        )
      }).pipe(Effect.map((applied) => ({ applied }))),
      // Before the write nothing is kept; after it, the recipe is, and a rerun
      // proceeds because *registered* is the test, not *the file exists*.
      (err) => ({
        refused: `${errorText(err)}${err instanceof SetupWriteError ? '' : ` — ${keptSentence(path)}`}`,
      }),
    )
    if ('refused' in appliedOrRefused) return appliedOrRefused
    const registration = appliedOrRefused.applied.registered
    return {
      ok: true as const,
      project: 'local' as const,
      name,
      remote,
      base: final,
      trial: recipeResult.trial,
      card: cardRecipe(finalRecipe, toplevel),
      updated: registration.updated,
      runtimes,
      hints: recipeResult.hints,
    }
  })
}

function runGithubBranch(
  world: FirstProjectWorld,
  flags: Record<string, string>,
  givenSlug: string | null,
  knownApp: AppCheck | null,
): Effect.Effect<FirstProjectOutcome, unknown> {
  return Effect.gen(function* () {
    // #396's two questions are asked only by `lingtai add`'s `askBeforeGithubAdd`
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
    // above — `init`'s GitHub branch never calls `askRecipe` at all. Refused
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
      'wall',
      'budget',
    ]
    const namedRecipeFlag = recipeFlagNames.find((name) => flags[name] !== undefined)
    if (namedRecipeFlag !== undefined) {
      return {
        refused:
          `--${namedRecipeFlag} ${flags[namedRecipeFlag]}, but a GitHub project asks none of askRecipe's questions ` +
          `here — lingtai add asks them once its recipe exists. Leave it out. ${world.kept}`,
      }
    }

    // How this machine reaches GitHub, ahead of any App question (0114 §1). A
    // `gh` machine never has the App asked about, so `GET /app` is not made for it.
    let app: AppCheck | null = knownApp
    if (app === null && world.github.auth?.() !== 'gh') app = yield* world.github.app()
    const decided = yield* askGithubAuthEffect(world, flags, app?.configured === true, world.kept, cancelFor(world))
    if ('refused' in decided) return { refused: decided.refused }

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
      const baseFlag = flags['base']
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
    const baseFlag = flags['base']
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

/** Exported for `init.ts`'s `liveInitWorld()` until CLI-22b — one real `git`, not two. */
export function liveGit(dir: string, args: readonly string[]): Promise<GitResult> {
  return Effect.runPromise(liveGitEffect(dir, args))
}

function liveOpen(url: string): Promise<boolean> {
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
   * already wrote something: `lingtai add <owner>/<repo>` runs
   * `askBeforeGithubAdd` first, which writes each answer as it is given
   * (#396–#399), so a refusal here must not tell the operator nothing was.
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
    open: liveOpen,
    appeared: pollForApp,
    pressed: (signal) => waitForKeypress(process.stdin, signal, 'running the same command again continues from here'),
  }
  const home = stateDir()

  return {
    ask: options.ask,
    ...(options.spin === undefined ? {} : { spin: options.spin }),
    log: options.log,
    git: liveGitEffect,
    exists: pathExistsEffect,
    projects: () => loadAllProjectsEffect(),
    files: diskFiles,
    home,
    signedIn: signedInHere,
    runtimes: askRuntimesEffect,
    setupReader: liveSetupReader,
    // `lingtai add` is the only caller. With a slug, `askBeforeGithubAdd`
    // has already written its answers, and `addCommand` says so (#402).
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
