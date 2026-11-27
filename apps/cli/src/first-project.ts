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
 * then does `askRecipe` (#431) take `branch.main`, `repo.remote` and, on an
 * absent file, `env.plantAt` as its seeds, and ask the rest of the recipe's
 * questions — writing all of it, seeds and answers together, in the one
 * creation write an absent file gets (#432). **That seed's `base` is not
 * necessarily final**: `askLanding`, inside `askRecipe`, can still move
 * `branch.main` — so what follows is a re-read of the file for its actual
 * `branch.main`, a second `git rev-parse` for that base's sha when it moved,
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
import { boardHost, boardPort, boardReachHost, githubAuthKind, stateDir } from '@lingtai/env'
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
  type RecipeDraft,
  loadAllProjectsEffect,
  recipePath,
  resolveDraftRecipeEffect,
} from '@lingtai/project'
import { readTasksEffect } from '@lingtai/projector'
import {
  branchOf,
  landOnBranchChanges,
  resolveSource,
  type Recipe,
  type ResolvedRecipe,
  type SignedIn,
} from '@lingtai/recipe'
import { mirrorPathFor } from '@lingtai/repo'
import { type Picker, type ProposalReaders, type RepositoryList, type SetupReader } from '@lingtai/setup'
import {
  askRuntimesEffect,
  NO_GITHUB_ORIGIN,
  noRuntimesSignedInRefusal,
  proposeSetup,
  type RuntimeFound,
} from '@lingtai/setup'
import {
  alreadyAddedSentence,
  applySetup,
  keptSentence,
  liveTrialBuild,
  previewSetup,
  SetupWriteError,
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
import { onCancelExit } from './prompt.ts'
import { acceptingDefaults, questionEffect, spunEffect, type QuestionWorld } from './question.ts'
import { ADD_KEPT, askRecipeEffect, ENV_PLANT_AT } from './recipe-flow.ts'
import type { TrialOutcome } from './setup-build.ts'
import { cardRecipe, type CardRecipe, type LeftBehind } from './setup-card.ts'
import { askMode, askPersonal, type Mode } from './team.ts'
import { HANDED_OFF_FLAGS, ROUNDS_RETIRED } from './wizard-options.ts'

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
 * Whether to move `name`'s landing from `oldRemote` to this checkout and rebuild its mirror. A raw `world.ask`, as it
 * always was: the answer is `yes` or `no`, and no terminal (`null`) is `yes` — the line the caller printed above it is
 * the record. What a `no` refuses with is the caller's.
 */
export function askMoveLanding(
  world: Pick<QuestionWorld, 'ask'>,
  at: { name: string; oldRemote: string; kept?: string | undefined },
): Effect.Effect<'yes' | 'no', unknown> {
  return lift(() =>
    world.ask(`Move ${at.name}'s landing from ${at.oldRemote} to this checkout, and rebuild its mirror? [y/N]`, {
      message: `Move ${at.name}'s landing to this checkout?`,
      defaultValue: 'no',
      choices: ['yes', 'no'],
      kept: at.kept,
    }),
  ).pipe(Effect.map((confirmed) => (confirmed === null || /^y(es)?$/i.test(confirmed.trim()) ? 'yes' : 'no')))
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

/** What an interrupted rerun wrote but could not register: the recipe is on disk, and this says why it is not registered. */
class KeptNotRegistered extends Error {}

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
  /**
   * The caller will ask the recipe questions itself once a repository is picked
   * (`lingtai add`), so the GitHub branch is handed the flags without them. The
   * local branch still gets every flag: it asks the recipe here.
   */
  deferRecipeFlags = false,
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
          deferRecipeFlags
            ? Object.fromEntries(Object.entries(flags).filter(([n]) => !HANDED_OFF_FLAGS.includes(n)))
            : flags,
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
    // One read of the file for the whole flow, as a draft: inside an add nothing is recorded or written until `applySetup`.
    const onDisk = yield* draftRecipe(name, { home: world.home })
    const existingRemote = onDisk.get(['repo', 'remote'])
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
    const proposedNow = onDisk.get(['steps', 'proposed'])
    const currentProposed = Array.isArray(proposedNow) ? (proposedNow as unknown[]) : []
    // The base the recipe resolves (`branchOf`), which is the one compared, moved and seeded below. Null where
    // there is no file yet or it does not resolve: the answer is then the detected one, never a raw path.
    const currentBase = ((): string | null => {
      const text = onDisk.text()
      if (text === null) return null
      try {
        return branchOf(resolveSource(text, name, name).recipe)
      } catch {
        return null
      }
    })()
    // `lingtai-base` is made from the checked-out branch when absent. A `--land <branch>` with no `--main`
    // names the branch the person means to land on, and `askLanding` would move the base there anyway.
    const given = flags['land']
    const detected = flags['main'] === undefined && given !== undefined && given !== 'hold' ? given : LINGTAI_BASE
    // Set by `validate` when the answer is `lingtai-base` and absent: the branch to make it from.
    let source: string | null = null

    // Already added and the old remote is not what it names (#772): `lingtai add` refuses, naming the
    // recipe, before it asks anything. Only the move off the checkout's `origin` is a repair.
    if (found !== undefined && ports !== null && !moving) {
      return { refused: `${alreadyAddedSentence(found.project!, world.home)}. ${world.kept}` }
    }

    // Already added and a rerun of `init` (no ports): it takes the first run's path, with the recipe's values as
    // the defaults (#1473). A recipe that does not resolve is refused by name before any question — falling back
    // to the system's defaults would have a person's Enter rewrite a broken file. `lingtai add` was refused above.
    if (found !== undefined && ports === null && !moving) {
      const recipeAt = recipePath(found.project!, world.home)
      world.log(`${found.project} is already added — its recipe is ${recipeAt}`)
      const existing = onDisk.text()
      if (existing !== null) {
        try {
          resolveSource(existing, recipeAt, recipeAt)
        } catch (error) {
          return { refused: `${recipeAt} does not resolve — ${errorText(error)}. ${world.kept}` }
        }
      }
    }

    // Solo or team (0130 §1), asked here and not inside `askRecipe`, because the branch below is made before it
    // runs. A rerun asks it as a first run does, with the file's mode as the default (#1474); `--defaults` takes
    // that default, and team where there is no file. A repair of a registered project (#772) asks nothing.
    const fileText = onDisk.text()
    const lingtaiWorld = flags['defaults'] !== undefined ? { ...world, ...acceptingDefaults(world) } : world
    const fileMode: Mode = onDisk.get(['mode']) === 'team' ? 'team' : 'solo'
    let mode: Mode = fileMode
    if (!(found !== undefined && ports !== null)) {
      const asked = yield* askMode(lingtaiWorld, {
        given: flags['mode'] ?? null,
        kept: world.kept,
        current: fileText === null ? null : fileMode,
      })
      if ('refused' in asked) return { refused: asked.refused }
      mode = asked.mode
    }
    // Where a rerun is, the branch the recipe works on now: a new one is cut from it when it is absent (#1474).
    const rerunBase: string | null =
      fileText !== null && ports === null && typeof currentBase === 'string' ? currentBase : null
    const rerunBaseExists = function* () {
      if (rerunBase === null) return false
      const check = yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${rerunBase}^{commit}`])
      return check.ok
    }
    // A team project's `branch.main` is the branch checked out, or `--main` (0130 §2); never `lingtai-base`.
    let mainBranch: string | null = null
    if (mode === 'team') {
      const landFlag = flags['land']
      if (landFlag !== undefined && landFlag !== 'hold') {
        return {
          refused: `a team project lands on branch.personal, not on ${landFlag} — pass --personal <branch> to name it. ${world.kept}`,
        }
      }
      const fileMain = onDisk.get(['branch', 'main'])
      const head = yield* world.git(toplevel, ['symbolic-ref', '--short', '-q', 'HEAD'])
      const checkedOut = head.ok ? head.stdout.trim() : ''
      // A solo file's `branch.main` is its working branch, which is not a team's main.
      mainBranch = flags['main'] ?? (fileMode === 'team' && typeof fileMain === 'string' ? fileMain : checkedOut)
      if (mainBranch === '') {
        return {
          refused: `${toplevel} has no branch checked out, and a team project's main is the one that is. Check out a branch, or pass --main <branch>. ${world.kept}`,
        }
      }
      const mainTip = yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${mainBranch}^{commit}`])
      if (!mainTip.ok) {
        return {
          refused: `${mainBranch} is not a branch in ${toplevel} — ${(mainTip.stderr || mainTip.stdout).trim()}. ${world.kept}`,
        }
      }
    }

    // A detected answer, so `--defaults` takes it; the project, App and store questions are durable and stay unwrapped.
    const baseAnswer =
      mode === 'team' && mainBranch !== null
        ? yield* askPersonal(lingtaiWorld, {
            given: flags['personal'] ?? null,
            fallback: typeof currentBase === 'string' && ports === null ? currentBase : LINGTAI_BASE,
            ...(fileMode === 'team' && rerunBase !== null ? { current: rerunBase } : {}),
            main: mainBranch,
            kept: world.kept,
            validate: (answer) =>
              Effect.gen(function* () {
                source = null
                const check = yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${answer}^{commit}`])
                if (check.ok) {
                  fromSha = check.stdout.trim()
                  return null
                }
                // Decides only: `validate` can run again on a refusal, so nothing is created here. On a rerun the
                // new branch is cut from the old one, which holds what landed and has not reached main (#1474).
                source = (yield* Effect.suspend(() => Effect.gen(rerunBaseExists))) ? rerunBase : mainBranch
                return null
              }),
          }).pipe(Effect.map((a) => ('refused' in a ? a : { answer: a.personal })))
        : yield* questionEffect(flags['defaults'] !== undefined ? { ...world, ...acceptingDefaults(world) } : world, {
            name: 'the base branch',
            flag: '--main <branch>',
            given: flags['main'] ?? null,
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
                if (rerunBase !== null && (yield* Effect.suspend(() => Effect.gen(rerunBaseExists)))) {
                  source = rerunBase
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
                    'Check out a branch, or pass --main <branch>'
                  )
                }
                source = branch
                return null
              }),
          })
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
        'refusal-fixes',
        'conflict-resolutions',
        'wall',
        'budget',
        'tickets',
        'kinds',
      ].find((n) => flags[n] !== undefined)
      // `--install none` asks for no command, so a repair that adds none honours it; any other answer would be dropped.
      const installFlag = flags['install']
      // ... but not over a recipe that already names one, written or inherited from its preset.
      const recipeNow = installFlag === 'none' ? onDisk.text() : null
      let prepared: unknown = null
      if (recipeNow !== null) {
        // Resolved as the repair will leave it (with the base and remote it supplies), so a recipe that
        // only fails to resolve for want of those is still read through its preset; one that still does not
        // resolve is taken to keep its install, never to have none.
        prepared = yield* refusingOn(
          previewSetup(
            { home: world.home },
            {
              project: name,
              changes: [
                { path: ['branch', 'main'], value: base },
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
      if (flags['rounds'] !== undefined) return { refused: `${ROUNDS_RETIRED}. ${world.kept}` }
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
      const moved = yield* askMoveLanding(world, { name, oldRemote, kept: world.kept })
      // The refusal is the caller's, so it can be worded where the answer is.
      if (moved === 'no') {
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
    let madeFrom: string | null = null
    let madeName: string | null = null
    let madeSha = ''
    const makeBranch = (keptText: string = world.kept) =>
      Effect.gen(function* () {
        if (source === null) return null
        const made = yield* world.git(toplevel, ['branch', base, source])
        if (!made.ok) {
          return {
            refused:
              `could not make ${base} from ${source} in ${toplevel} — ${(made.stderr || made.stdout).trim()}. ${keptText}`.trim(),
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
        madeFrom = source
        madeName = base
        madeSha = fromSha
        return null
      })
    // Team to solo is refused by `changeRecipe` while a draft holds a ticket or a PR is open (0130 §1), and that
    // check runs at the write, after this branch is made: so it is read first, and a refusal makes nothing.
    const switching = fileText !== null && ports === null && fileMode === 'team' && mode === 'solo'
    // A branch a refused switch would have made is made after `changeRecipe`'s own check, inside the write, so a
    // draft recorded after the read above leaves no branch behind (0130 §1).
    const lateBranch = switching && source !== null
    if (switching) {
      const store = world.store ?? (yield* defaultStore())
      const prs = yield* refusingOn(listPrs(name, store).pipe(Effect.map((listed) => ({ listed }))), (error) => ({
        refused: `could not read the PRs of ${name} — ${errorText(error)}. ${world.kept}`,
      }))
      if ('refused' in prs) return prs
      const open = prs.listed.filter(isOpen)
      const draft = draftIn(prs.listed)
      if (open.length > 0 || draft.length > 0) {
        const personal = onDisk.get(['branch', 'personal'])
        return {
          refused: `${modeSwitchMessage(typeof personal === 'string' ? personal : (rerunBase ?? 'main'), open, draft)}. ${world.kept}`,
        }
      }
    }
    // A team project's personal branch is made only after every question is answered, and only once the person
    // said yes: the trial build below cuts at `branch.main`, which is where the branch would be cut from anyway.
    const deferBranch = mode === 'team' && source !== null
    if (deferBranch) {
      const confirmed = yield* questionEffect(lingtaiWorld, {
        name: 'making the personal branch',
        flag: `--defaults, or make it yourself: git branch ${base} ${source}`,
        given: flags['defaults'] !== undefined ? 'yes' : null,
        prompt: `${base} does not exist in ${toplevel}. Make it from ${source}?`,
        choices: ['yes', 'no'],
        fallback: 'yes',
        kept: world.kept,
      })
      if ('refused' in confirmed) return { refused: confirmed.refused }
      if (confirmed.answer === 'no') {
        return {
          refused:
            `${base} was not made — nothing was written and nothing was registered. ` +
            `Make it yourself with: git branch ${base} ${source}, then run this again. ${world.kept}`,
        }
      }
    } else if (!lateBranch) {
      const refusal = yield* makeBranch()
      if (refusal !== null) return refusal
    }
    // Until the branch is made, a deferred one is cut at the main it would be made from.
    // `source` is what `validate` decided: main on a first run, the old working branch on a rerun that has one.
    const deferredFrom = (source as string | null) ?? mainBranch
    const trialBase = (deferBranch || lateBranch) && deferredFrom !== null ? deferredFrom : base

    const path = recipePath(name, world.home)
    const existingText = onDisk.text()

    // `env.plantAt` has no schema default (`recipe.ts`'s `plantAt: z.string()`)
    // — a brand-new file needs it or it will not resolve at all, and nothing a
    // directory offers answers it either. Written only when there is no file
    // yet: an existing one already has it, possibly edited since, and a re-run
    // must not overwrite that silently. `source.kinds` is no longer seeded here
    // — `askRecipe`'s own `askKinds` always answers it on an absent file (#432).
    const seeds = [
      // `--land <branch>` is the unattended landing, so it takes a `human:` hold off `steps.proposed` as it does elsewhere.
      ...landOnBranchChanges(
        // A team project's `branch.main` is the checked-out branch; the branch made above is `branch.personal`.
        mode === 'team' && mainBranch !== null ? mainBranch : base,
        found !== undefined && flags['land'] !== undefined && flags['land'] !== 'hold' ? currentProposed : [],
      ),
      ...(mode === 'team'
        ? [
            { path: ['mode'], value: 'team' },
            { path: ['branch', 'personal'], value: base },
          ]
        : // Solo is the absent key, so a team file moving to solo is the one case that has to say it (#1474).
          fileText !== null && fileMode === 'team'
          ? [
              { path: ['mode'], value: 'solo' },
              // Both are read only in team mode, and a recipe that keeps either does not resolve. The branch itself,
              // its commits and any open PR are the person's, and are not touched.
              { path: ['branch', 'personal'], value: undefined },
              ...(onDisk.get(['pr']) === null ? [] : [{ path: ['pr'], value: undefined }]),
            ]
          : []),
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
        // Asked on a rerun too (#1474); a repair of a registered project (#772) asks none of the questionnaire.
        ...(!(found !== undefined && migrating) && world.sandboxHost !== undefined
          ? { host: world.sandboxHost() }
          : {}),
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

    // A local directory keeps `db`; where its origin is on GitHub the proposal's own line says how to
    // take that repository's issues. The no-origin and kept: lines are not that hint.
    if (
      proposal.tickets.known &&
      !proposal.tickets.because.startsWith('kept:') &&
      proposal.tickets.because !== NO_GITHUB_ORIGIN
    ) {
      world.log(paint.muted(`tickets       db — ${proposal.tickets.because}`))
    }

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
    let answeredDraft: RecipeDraft | null = null
    // A rerun's Ctrl+C keeps what was answered (#392): the draft's changes are written once, through
    // `applySetup`, as the first thing an interruption does. A rerun that changed nothing writes nothing.
    // The recipe the registration last read from disk: what the card and the lines after it describe, because
    // another rerun may have written it since the preview (#1474).
    let finalFromSha = fromSha
    let settled: { recipe: ReturnType<typeof resolveSource>['recipe']; base: string } | null = null
    // Registers the recipe as the write left it: its base must exist and is what the registration names, since
    // each pass refuses a recipe that does not name the registered base.
    const registerWritten = (written: string, known: { base: string; sha: string } | null) =>
      Effect.gen(function* () {
        const recipe = resolveSource(written, path, path).recipe
        const writtenBase = branchOf(recipe)
        let writtenSha = known?.sha ?? ''
        if (known === null || writtenBase !== known.base) {
          const tip = yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${writtenBase}^{commit}`])
          if (!tip.ok) {
            return yield* Effect.fail(
              new Error(
                `${writtenBase} is not a branch in ${toplevel} — ${(tip.stderr || tip.stdout).trim()}; ${keptSentence(path)}`,
              ),
            )
          }
          writtenSha = tip.stdout.trim()
        }
        const writtenResolved = yield* resolveDraftRecipeEffect(name, written, {
          home: world.home,
          signedIn: world.signedIn,
          ...HOST_FOR_SAVING,
          base: writtenBase,
        })
        settled = { recipe, base: writtenBase }
        return yield* world.register({
          project: name,
          owner: null,
          base: writtenBase,
          configHash: writtenResolved.configHash,
          fromSha: writtenSha,
          resolved: writtenResolved,
        })
      })
    // An interruption writes what was answered, and registers it as a finished rerun does: a branch that was
    // deferred is made first (it was confirmed above), so the recipe never names one that does not exist, and a
    // moved base is registered again.
    const keepAnswered = Effect.suspend(() => {
      const answered = answeredDraft?.changes() ?? []
      if (answered.length === 0) return Effect.succeed<string | null>(null)
      // Under the lock every other add and rerun takes: the recipe it reads back and the registration it makes are
      // one critical section, so a rerun that finished meanwhile is not overwritten by this one's older read.
      return exclusiveAdd(
        name,
        applySetup(
          { home: world.home, by: world.by, store: world.store },
          { project: name, changes: answered },
          Effect.gen(function* () {
            if (deferBranch || lateBranch) {
              const refusal = yield* makeBranch('')
              if (refusal !== null) return yield* Effect.fail(new KeptNotRegistered(refusal.refused))
            }
            const written = (yield* draftRecipe(name, { home: world.home })).text()
            if (written === null) return yield* Effect.fail(new KeptNotRegistered(`${path} could not be read back`))
            yield* registerWritten(written, null).pipe(
              Effect.mapError((err) => new KeptNotRegistered(err instanceof Error ? err.message : String(err))),
            )
          }),
        ),
        world.locker,
      ).pipe(
        Effect.map((): string | null => `What you answered was written to ${path}`),
        // `applySetup` says what is on disk: "was not written" before the write, "was written but not recorded"
        // after it. That sentence is kept as it came; only a failure it did not describe is reported as unknown.
        Effect.catchCause((cause) => {
          const failure = Cause.squash(cause)
          return Effect.fail(
            failure instanceof KeptNotRegistered
              ? new Error(`what you answered was written to ${path}, but it was not registered: ${failure.message}`)
              : failure instanceof SetupWriteError
                ? new Error(`what you answered: ${failure.message}`)
                : new Error(`whether what you answered was saved to ${path} is not known: ${Cause.pretty(cause)}`),
          )
        }),
      )
    })
    const askingRecipe = askRecipeEffect(world, {
      project: name,
      onDraft: (draft) => {
        answeredDraft = draft
      },
      local: true,
      // Decided above, before the branch was made; `askRecipe` asks no mode of a local project.
      mode,
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
          base: trialBase,
          remote,
          home: world.home,
          // A deferred branch does not exist yet, and the draft names it at `branch.personal`, which the
          // trial prefers to its fallback: the trial reads it as the main it would be cut from.
          // A team-to-solo switch to a branch not yet made names it at `branch.main`, which the trial prefers to
          // its fallback in solo mode: that one is read as the old working branch, until the draft names another.
          draft:
            (deferBranch || lateBranch) && deferredFrom !== null
              ? {
                  path: draft.path,
                  set: (changes) => draft.set(changes),
                  get: (key) => {
                    const joined = key.join('.')
                    if (deferBranch && joined === 'branch.personal') return deferredFrom
                    if (lateBranch && joined === 'branch.main' && draft.get(key) === base) return deferredFrom
                    return draft.get(key)
                  },
                  text: () => draft.text(),
                  changes: () => draft.changes(),
                }
              : draft,
        }),
      history: (project) => Effect.runPromiseWith(services)(world.history(project)),
      seeds,
      again: `lingtai add --local ${toplevel}`,
      keptBeforeWrite:
        madeKept === null ? world.kept : `No recipe was written, and nothing was registered; ${madeKept} is kept`,
      kept: seededKept,
      home: world.home,
    })
    const recipeResult = repairOnly
      ? repairResult
      : found !== undefined && existingText !== null
        ? yield* Effect.acquireUseRelease(
            Effect.sync(() => onCancelExit(() => Effect.runPromiseWith(services)(keepAnswered))),
            () =>
              askingRecipe.pipe(
                Effect.onInterrupt(() =>
                  keepAnswered.pipe(
                    Effect.catch((error) => Effect.sync(() => world.log(error.message))),
                    Effect.asVoid,
                  ),
                ),
              ),
            (release) => Effect.sync(release),
          )
        : yield* askingRecipe
    if ('refused' in recipeResult) return { refused: recipeResult.refused }
    if (deferBranch) {
      const refusal = yield* makeBranch()
      if (refusal !== null) return refusal
    }

    // A rerun whose answers changed nothing (the draft holds only sets that changed the text) writes nothing and
    // registers nothing: no `ProjectConfigured`, no `ProjectRecipeChanged` (#1473).
    if (found !== undefined && !repairOnly && existingText !== null && recipeResult.answers.changes.length === 0) {
      const kept = resolveSource(existingText, path, path).recipe
      return {
        ok: true as const,
        project: 'local' as const,
        name,
        remote,
        base: branchOf(kept),
        trial: recipeResult.trial,
        card: cardRecipe(kept, toplevel),
        updated: true,
        unchanged: true,
        runtimes,
        hints: recipeResult.hints,
      }
    }

    // `askLanding`, inside `askRecipe`, can move `branch.main` on a local
    // project (#431's Watch out) — re-read the file it left behind rather than
    // trust the `base` this function's own question settled.
    const previewedOrRefused = yield* refusingOn(
      previewSetup({ home: world.home }, recipeResult.answers).pipe(Effect.map((text) => ({ previewed: text }))),
      (error) => ({ refused: `${errorText(error)}. ${ADD_KEPT}` }),
    )
    if ('refused' in previewedOrRefused) return previewedOrRefused
    const previewed = previewedOrRefused.previewed
    const finalRecipe = resolveSource(previewed, path, path).recipe
    const final = branchOf(finalRecipe)
    if (world.claudeToken !== undefined && !repairOnly) {
      yield* world.claudeToken(finalRecipe, flags).pipe(Effect.catch(() => Effect.void))
    }

    // The branch of a team-to-solo switch, made once the write has passed `changeRecipe`'s check.
    const makeLate = Effect.gen(function* () {
      if (!lateBranch) return
      const refusal = yield* makeBranch('')
      if (refusal !== null) return yield* Effect.fail(new Error(refusal.refused))
      if (final === base) finalFromSha = fromSha
    })
    if (final !== base) {
      const check = yield* world.git(toplevel, ['rev-parse', '--verify', `refs/heads/${final}^{commit}`])
      if (!check.ok) {
        return {
          refused: `${final} is not a branch in ${toplevel} — ${(check.stderr || check.stdout).trim()}. ${ADD_KEPT}${madeKept === null ? '' : `; ${madeKept} is kept too`}`,
        }
      }
      finalFromSha = check.stdout.trim()
    }

    const resolved = yield* resolveDraftRecipeEffect(name, previewed, {
      home: world.home,
      signedIn: world.signedIn,
      ...HOST_FOR_SAVING,
      base: final,
      // The recipe is still only a draft (`applySetup` is its one writer), so it is resolved over that text.
    })

    // `register`'s live implementation (`addLocal`, `onboard.ts` — the only place a directory gets a
    // `ProjectConfigured`) logs the "added"/"updated" line itself. It is the port `applySetup` is handed:
    // the recipe is written once, just before it.
    const appliedOrRefused = yield* refusingOn(
      Effect.suspend(() => {
        // Under the lock the board's Add takes; a project not yet registered is checked again inside it,
        // since another process may have added it since the read above.
        const write = applySetup(
          { home: world.home, by: world.by, store: world.store },
          recipeResult.answers,
          // Registered from the file `applySetup` has just written, under the lock: the preview above was read
          // before it, and another rerun may have changed the recipe since (its base, its mode).
          Effect.gen(function* () {
            yield* makeLate
            const written = (yield* draftRecipe(name, { home: world.home })).text()
            if (written === null || written === previewed) {
              settled = { recipe: finalRecipe, base: final }
              return yield* world.register({
                project: name,
                owner: null,
                base: final,
                configHash: resolved.configHash,
                fromSha: finalFromSha,
                resolved,
              })
            }
            return yield* registerWritten(written, { base: final, sha: finalFromSha })
          }).pipe(Effect.mapError((err) => (err instanceof Error ? err : new Error(String(err))))),
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
    // Everything said below is about the recipe the registration read, which another rerun may have rewritten
    // since the preview: its base, its mode and its card are that recipe's, not the preview's.
    const landed = settled ?? { recipe: finalRecipe, base: final }
    const landedRecipe = landed.recipe
    const landedBase = landed.base
    const landedMode: Mode = landedRecipe.mode === 'team' ? 'team' : 'solo'

    // What this rerun's changes left where they were (#1474). Read after the write, so a `git` that fails
    // cannot refuse a change already made: the line says it could not read, and gives the command.
    const leftBehind: LeftBehind[] = []
    const commitsIn = (range: string) =>
      Effect.gen(function* () {
        const listed = yield* world.git(toplevel, ['rev-list', '--oneline', range])
        return listed.ok ? listed.stdout.split('\n').filter((l) => l.trim() !== '') : null
      })
    const listing = (commits: string[] | null, range: string, none: string): string =>
      commits === null
        ? `the commits could not be read — git -C ${toplevel} rev-list --oneline ${range} lists them`
        : commits.length === 0
          ? none
          : `${commits.length} commit${commits.length === 1 ? '' : 's'}: ${commits.join(' · ')}`
    if (fileText !== null && ports === null) {
      if (fileMode === 'team' && landedMode === 'solo') {
        // Written only because nothing was pending (0130 §1): everything on the personal branch has reached `main`,
        // so there is no git command to give. The branch is the person's and is left as it is.
        const personal = rerunBase
        if (personal !== null) {
          leftBehind.push({ what: `${personal} was left as it is — nothing on it is waiting to reach main` })
        }
      }
      // The branch made is the working branch the person answered, which is not always the one the recipe lands
      // on (`askLanding` can pick another): each line names its own branch.
      if (rerunBase !== null && madeName !== null && madeFrom === rerunBase) {
        leftBehind.push({
          what: `${madeName} was made from ${rerunBase} at ${madeSha.slice(0, 9)} — ${rerunBase} is kept and may be deleted`,
        })
      }
      if (rerunBase !== null && landedBase !== rerunBase && landedBase !== madeName) {
        const range = `${landedBase}..${rerunBase}`
        leftBehind.push({
          what: `${landedBase} existed and was left as it was — the commits only ${rerunBase} has: ${listing(yield* commitsIn(range), range, 'none')}`,
          command: `git -C ${toplevel} rev-list --oneline ${range}`,
        })
      }
    }
    return {
      ok: true as const,
      project: 'local' as const,
      name,
      remote,
      base: landedBase,
      trial: recipeResult.trial,
      card: cardRecipe(landedRecipe, toplevel),
      updated: registration.updated,
      runtimes,
      hints: recipeResult.hints,
      ...(leftBehind.length === 0 ? {} : { leftBehind }),
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
