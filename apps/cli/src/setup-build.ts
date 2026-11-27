import { type RecipeDraft, recipePath } from '@lingtai/project'
/**
 * The two questions #397 asks over `detect-setup.ts`'s suggestion: the
 * install command at `steps.prepared`, and the build commands at
 * `steps.build` — both through #392's seam (`question.ts`), both returned
 * as `RecipeChange[]` for the caller to write with #395's `setRecipe`.
 *
 * **This writes nothing.** #395's own design settled that a new file is
 * written once, by whoever collects every first-run answer — #400, not
 * here. What this returns is handed to `setRecipe` by the caller, exactly
 * as `packages/recipe/unit/write.test.ts` hands a `RecipeChange[]` to it
 * directly.
 */
import { type RecipeChange, resolveSource } from '@lingtai/recipe'
import {
  type DetectedSetup,
  NO_CHECKOUT_LINE,
  type NamedRun,
  type SetupReader,
  type Trial,
  type TrialReport,
  type TrialResult,
  detectSetupEffect,
  installRefusal,
  isRunAction,
  mergeRunActions,
  namedFromTyped,
  resolvedRunActions,
} from '@lingtai/setup'
import { Effect } from 'effect'

import { lift, recovering } from './exit.ts'
import { type Answered, type QuestionWorld, questionEffect } from './question.ts'

export type SetupWorld = QuestionWorld

export type { Trial, TrialReport, TrialResult }

export interface AskInstallAndBuildInput {
  project: string
  reader: SetupReader
  /** A detection the caller already holds (a `Proposal`'s): used instead of reading the repository again. */
  detected?: DetectedSetup
  given: { install: string | null; build: string[] | null; check: 'yes' | 'no' | null }
  /** Null where there is nowhere to run it — logged, never run silently. */
  tryBuild: Trial | null
  /**
   * Whether the recipe file existed when `add` began. Where it did, every
   * earlier answer is already on disk, so "nothing is written yet" would be false.
   */
  recipeExisted?: boolean
  home?: string
  /** The recipe the answers so far have drafted. */
  draft: RecipeDraft
  /** `question.ts`'s `kept` — what a refusal below says is already written. */
  kept?: string
  /**
   * Whether `tool` is on this machine's PATH. Absent where nothing is checked.
   * The conductor runs build here, so a missing manager is worth a line; it
   * never changes what is suggested.
   */
  onPath?: (tool: string) => Promise<boolean>
}

/**
 * How the trial build went, for the summary card: one fact above the per-command
 * results. `ms` is wall time around the `tryBuild` call.
 */
export type TrialOutcome =
  | { trial: 'passed'; ms: number }
  | { trial: 'failed-kept'; command: string; ms: number }
  | { trial: 'not-run'; because: 'declined' | 'no checkout' | 'no checks' }

export type AskInstallAndBuildResult = { changes: RecipeChange[]; trial: TrialOutcome } | { refused: string }

/** The `run:` actions already at `path`, in file order — `[]` where the step is absent or writes none. */
function currentRunActions(draft: RecipeDraft, path: readonly string[]): NamedRun[] {
  const value = draft.get(path)
  if (!Array.isArray(value)) return []
  return value.filter(isRunAction).map((a) => ({ name: String(a.name ?? ''), run: a.run }))
}

function printFound(
  world: SetupWorld,
  detected: DetectedSetup,
  onPath: AskInstallAndBuildInput['onPath'],
): Effect.Effect<void, unknown> {
  if (onPath === undefined) return Effect.void
  // The first word is the manager (`uv`, `poetry`, `pnpm`…). ruff, mypy and
  // pytest come from the project's environment after install, so they are not
  // probed; Go's tools come from no such environment, so all of them are. An
  // entry whose first word is a shell builtin names its tool, and a wrapper's is `java`. Rust's `cargo fmt` and `cargo clippy` name `rustfmt` and `cargo-clippy`, rustup components that may be absent beside `cargo`. A probe that
  // throws says nothing.
  const commands = [
    detected.install === null ? undefined : { tool: detected.install.tool, run: detected.install.run },
    ...detected.build,
  ]
  const tools = new Set(commands.flatMap((c) => (c === undefined ? [] : [c.tool ?? c.run.split(' ')[0]!])))
  return Effect.forEach(
    tools,
    (tool) =>
      lift(() => onPath(tool)).pipe(
        Effect.flatMap((found) =>
          found
            ? Effect.void
            : Effect.sync(() =>
                world.log(`${tool} is not on this machine's PATH; the conductor runs these commands here`),
              ),
        ),
        // extra information only
        recovering(() => Effect.void),
      ),
    { discard: true },
  )
}

/**
 * The install command. `detected` is what detection found, drawn as the default and explained where nothing is in
 * force; null where this is a second time round, or nothing was found.
 */
export function askInstallCommand(
  world: SetupWorld,
  at: {
    given: string | null
    current: string | null
    detected: { run: string; because: string } | null
    validate: (answer: string) => Effect.Effect<string | null, unknown>
    kept?: string | undefined
  },
): Effect.Effect<Answered, unknown> {
  return questionEffect(world, {
    name: 'the install command',
    flag: '--install <command>, or --install none',
    given: at.given,
    prompt: 'the install command',
    current: at.current,
    detected: at.detected?.run ?? null,
    ...(at.current === null && at.detected ? { why: [`install: ${at.detected.run} — ${at.detected.because}`] } : {}),
    fallback: '',
    validate: at.validate,
    kept: at.kept,
  })
}

function askInstall(
  world: SetupWorld,
  input: AskInstallAndBuildInput,
  detected: DetectedSetup,
  /** The command just tried (null for none), when this is a second time round. */
  previous?: string | null,
): Effect.Effect<{ run: string | null; refused: string } | { run: string | null }, unknown> {
  return Effect.gen(function* () {
    const current = currentRunActions(input.draft, ['steps', 'prepared'])
    const again = previous !== undefined
    // A file that lists `prepared: []` has answered "no install": that is its value, not a missing one (#1473).
    const answeredNone = input.recipeExisted === true && Array.isArray(input.draft.get(['steps', 'prepared']))
    const currentRun = again ? (previous ?? 'none') : (current[0]?.run ?? (answeredNone ? 'none' : null))

    const answer = yield* askInstallCommand(world, {
      given: input.given.install,
      current: currentRun,
      detected: again ? null : detected.install,
      validate: (a) => Effect.succeed(installRefusal(a)),
      kept: input.kept,
    })
    if ('refused' in answer) return { run: null, refused: answer.refused }
    return { run: answer.answer === 'none' ? null : answer.answer }
  })
}

/** Whether to keep the list as it stands (`yes`), or write one's own (`no`). */
export function askKeepBuildList(
  world: SetupWorld,
  at: { given: string | null; why: readonly string[]; kept?: string | undefined },
): Effect.Effect<Answered, unknown> {
  return questionEffect(world, {
    name: 'the build steps',
    flag: '--build <command> (repeatable), or --build none',
    given: at.given,
    prompt: 'Each attempt runs these checks before review — keep this list? (yes / no to write your own)',
    choices: ['yes', 'no'],
    fallback: 'yes',
    why: at.why,
    kept: at.kept,
  })
}

/**
 * The commands a person types, one to a question, until an empty answer. `why` is drawn on the first only, and only
 * where no list was offered before it.
 */
export function askBuildCommands(
  world: SetupWorld,
  at: { why: readonly string[]; kept?: string | undefined },
): Effect.Effect<{ commands: string[] } | { refused: string }, unknown> {
  return Effect.gen(function* () {
    const typed: string[] = []
    for (;;) {
      const answer = yield* questionEffect(world, {
        name: 'a build command',
        flag: '--build <command> (repeatable), or --build none',
        given: null,
        prompt: 'a command that must pass before review — empty when done',
        fallback: '',
        ...(typed.length === 0 && at.why.length > 0 ? { why: at.why } : {}),
        kept: at.kept,
      })
      if ('refused' in answer) return { refused: answer.refused }
      if (answer.answer === '') break
      typed.push(answer.answer)
    }
    return { commands: typed }
  })
}

/** Whether to try the build list once now, on `base`. */
export function askTrial(
  world: SetupWorld,
  at: { given: string | null; base: string; recipeExisted: boolean; kept?: string | undefined },
): Effect.Effect<Answered, unknown> {
  const ending = at.recipeExisted ? 'This list is not written yet.' : 'Nothing is written yet.'
  return questionEffect(world, {
    name: 'the trial run',
    flag: '--check-build yes, or --check-build no',
    given: at.given,
    prompt: `Try them once now, on \`${at.base}\`, to see that they work? ${ending}`,
    choices: ['yes', 'no'],
    fallback: 'yes',
    kept: at.kept,
  })
}

type Tried =
  | { ok: true; trial: TrialOutcome }
  | { again: 'edit'; at: 'install' | 'build' }
  | { again: 'drop'; failed: string[] }
  | { refused: string }

/** What the trial loop is given: the answers so far, and what it needs to ask again and to say where the recipe is. */
export interface TrialLoopInput {
  /** Null where there is nowhere to run it — logged, never run silently. */
  trial: Trial | null
  install: string | null
  build: NamedRun[]
  given: { install: string | null; build: string[] | null; check: 'yes' | 'no' | null }
  recipeExisted: boolean
  /** Where the recipe is, for the line that says what a check that needs a variable should do. */
  recipeFile: string
  kept?: string | undefined
  /** The two questions the *edit* answer goes back to, each told what was just tried. */
  again: {
    install: (previous: string | null) => Effect.Effect<{ run: string | null } | { refused: string }, unknown>
    build: (previous: NamedRun[]) => Effect.Effect<{ build: NamedRun[] } | { refused: string }, unknown>
  }
}

/**
 * Runs the trial build, prints its results, and asks what to do with a red one:
 * keep the list, go back and edit it, or drop the checks that failed.
 * `asked` is false for the run `drop` repeats — choosing it was the question.
 */
function tryTheBuild(
  world: SetupWorld,
  at: Omit<TrialLoopInput, 'again'>,
  install: string | null,
  build: NamedRun[],
  asked: boolean,
): Effect.Effect<Tried, unknown> {
  return Effect.gen(function* () {
    if (build.length === 0) return { ok: true, trial: { trial: 'not-run', because: 'no checks' } }
    const trial = at.trial
    if (trial === null) {
      world.log(NO_CHECKOUT_LINE)
      return { ok: true, trial: { trial: 'not-run', because: 'no checkout' } }
    }

    if (asked) {
      const check = yield* askTrial(world, {
        given: at.given.check,
        base: yield* trial.base,
        recipeExisted: at.recipeExisted,
        kept: at.kept,
      })
      if ('refused' in check) return { refused: check.refused }
      if (check.answer === 'no') return { ok: true, trial: { trial: 'not-run', because: 'declined' } }
    }

    world.log('running the trial build — this can take minutes')
    const startedAt = Date.now()
    const ran = yield* trial
      .run(
        install,
        build.map((b) => b.run),
      )
      .pipe(
        Effect.map((report) => ({ report }) as const),
        // Ctrl+C is not a result: the worktree is already gone, and a failed list
        // is not what was asked. Anything else is a bug and propagates.
        Effect.catchIf(
          (err): err is Error => err instanceof Error && err.name === 'TrialInterrupted',
          () => Effect.succeed({ interrupted: true } as const),
        ),
      )
    if ('interrupted' in ran) {
      return { refused: `the trial run was interrupted. ${at.kept ?? 'Nothing was written'}` }
    }
    const report: TrialReport = ran.report
    const ms = Date.now() - startedAt
    const { results, nothingDeclared } = report
    // Colour is decided by what failed, never by what was not run.
    const firstFailed = results.find((r) => r.outcome === 'failed')
    if (firstFailed === undefined) return { ok: true, trial: { trial: 'passed', ms } }

    for (const r of results) {
      if (r.outcome === 'failed') world.log(`failed: ${r.command}\n${r.evidence}`)
      else if (r.outcome === 'not-run') world.log(`not run: ${r.command} — ${r.because}`)
    }
    if (nothingDeclared) {
      world.log(
        `the recipe declares no env, so these ran without any of your variables — if a check needs one, declare it under env: in ${at.recipeFile}`,
      )
    }

    // A failure is a check only when it names one of the list's commands. The
    // install, `env`, `git` and `cleanup` are not checks: dropping removes
    // nothing that fixes them, so only `edit` (back to the install) is offered.
    const checks = new Set(build.map((b) => b.run))
    const failed = results.filter((r) => r.outcome === 'failed').map((r) => r.command)
    const failedChecks = failed.filter((c) => checks.has(c) && c !== install)
    const failedOther = failed.filter((c) => c !== 'cleanup' && !failedChecks.includes(c))
    const canDrop = failedChecks.length > 0 && failedOther.length === 0

    const decide = yield* questionEffect(world, {
      name: 'what to do with the failed build list',
      flag: '--check-build no, or --build <command>',
      given: null,
      prompt: canDrop
        ? 'keep the list as it is, edit it, or drop the checks that failed?'
        : 'keep the list as it is, or edit it?',
      choices: canDrop ? ['edit', 'keep', 'drop'] : ['edit', 'keep'],
      fallback: 'edit',
      kept: at.kept,
    })
    if ('refused' in decide) return { refused: decide.refused }
    if (decide.answer === 'drop') return { again: 'drop', failed: failedChecks }
    if (decide.answer === 'edit') {
      const to = failedChecks.length > 0 && failedOther.length === 0 ? 'build' : 'install'
      if (to === 'build' && at.given.build !== null) {
        return {
          refused: 'the trial build failed and the list was not written — rerun with --build to give a different list',
        }
      }
      if (to === 'install' && at.given.install !== null) {
        return {
          refused:
            'the trial’s install failed and the list was not written — rerun with --install to give a different one',
        }
      }
      return { again: 'edit', at: to }
    }
    return { ok: true, trial: { trial: 'failed-kept', command: firstFailed.command, ms } }
  })
}

/**
 * The trial build, and what to do with a red one, until it is kept, passed, declined or refused. A *drop* repeats the
 * run without asking again; an *edit* goes back to the question that can change what failed, through `again`, every
 * earlier answer kept. Returns what the list and the install are by then.
 */
export function runTrialLoop(
  world: SetupWorld,
  at: TrialLoopInput,
): Effect.Effect<{ install: string | null; build: NamedRun[]; trial: TrialOutcome } | { refused: string }, unknown> {
  return Effect.gen(function* () {
    let install = at.install
    let build = at.build
    let tried: Tried
    for (;;) {
      let asked = true
      for (;;) {
        tried = yield* tryTheBuild(world, at, install, build, asked)
        if ('again' in tried && tried.again === 'drop') {
          const failed: Set<string> = new Set(tried.failed)
          build = build.filter((b) => !failed.has(b.run))
          if (build.length === 0) world.log('nothing will check a diff before review')
          asked = false
          continue
        }
        break
      }
      if (!('again' in tried)) break
      if (tried.at === 'install') {
        const again = yield* at.again.install(install)
        if ('refused' in again) return { refused: again.refused }
        install = again.run
      }
      const again = yield* at.again.build(build)
      if ('refused' in again) return { refused: again.refused }
      build = again.build
    }
    if ('refused' in tried) return { refused: tried.refused }
    return { install, build, trial: tried.trial }
  })
}

function askBuild(
  world: SetupWorld,
  input: AskInstallAndBuildInput,
  detected: DetectedSetup,
  /** The list just tried, when this is a second time round. */
  previous?: NamedRun[],
): Effect.Effect<{ build: NamedRun[] } | { refused: string }, unknown> {
  return Effect.gen(function* () {
    const originalBuild = input.draft.get(['steps', 'build']) as unknown[] | null
    const current = previous ?? currentRunActions(input.draft, ['steps', 'build'])

    if (input.given.build !== null) {
      if (input.given.build.includes('none') && input.given.build.length > 1) {
        return { refused: '--build none cannot be combined with another --build value' }
      }
      // `--build` with no value right after it — forgotten before another flag,
      // or last on the line — parses to `''` rather than being dropped (both
      // `init.ts`'s `parseArgs` does this
      // deliberately, so a forgotten value is seen rather than silently
      // absorbed). `''` is not a command: refuse by name instead of writing a
      // `run: ""` that `command.ts` would execute as `sh -c ''`, exiting 0
      // having checked nothing (#431 fix round, finding 2).
      if (input.given.build.includes('')) {
        return { refused: '--build takes a command, or none — not empty' }
      }
      const build = input.given.build[0] === 'none' ? [] : namedFromTyped(input.given.build, originalBuild ?? [])
      if (build.length === 0) world.log('nothing will check a diff before review')
      return { build }
    }

    // A file that lists `build: []` (or no `run:` in it) has answered "no checks": detection does not refill it (#1473).
    const answeredNone =
      previous === undefined && input.recipeExisted === true && current.length === 0 && Array.isArray(originalBuild)
    const defaultList =
      current.length > 0 ? current : !answeredNone && detected.build.length > 0 ? detected.build : null
    // What detection found explains a default only when the default came from it, not from the file's own list.
    const why =
      current.length > 0 || previous !== undefined || answeredNone
        ? []
        : [
            ...detected.build.map((b) => `build (${b.name}): ${b.run} — ${b.because}`),
            ...detected.skipped.map((s) => `skipped \`${s.script}\`: ${s.why}`),
            ...detected.notes,
          ]

    if (defaultList !== null) {
      const answer = yield* askKeepBuildList(world, { given: null, why, kept: input.kept })
      if ('refused' in answer) return { refused: answer.refused }
      if (answer.answer === 'yes') return { build: defaultList.map(({ name, run }) => ({ name, run })) }
    }

    const typed = yield* askBuildCommands(world, { why: defaultList === null ? why : [], kept: input.kept })
    if ('refused' in typed) return { refused: typed.refused }
    if (typed.commands.length === 0) world.log('nothing will check a diff before review')
    return { build: namedFromTyped(typed.commands, originalBuild ?? []) }
  })
}

export function askInstallAndBuildEffect(
  world: SetupWorld,
  input: AskInstallAndBuildInput,
): Effect.Effect<AskInstallAndBuildResult, unknown> {
  return Effect.gen(function* () {
    const detected = input.detected ?? (yield* detectSetupEffect(input.reader))
    yield* printFound(world, detected, input.onPath)

    const install = yield* askInstall(world, input, detected)
    if ('refused' in install) return { refused: install.refused }

    const build = yield* askBuild(world, input, detected)
    if ('refused' in build) return { refused: build.refused }

    const looped = yield* runTrialLoop(world, {
      trial: input.tryBuild,
      install: install.run,
      build: build.build,
      given: input.given,
      recipeExisted: input.recipeExisted === true,
      recipeFile: recipePath(input.project, input.home),
      kept: input.kept,
      again: {
        install: (previous) => askInstall(world, input, detected, previous),
        build: (previous) => askBuild(world, input, detected, previous),
      },
    })
    if ('refused' in looped) return { refused: looped.refused }

    const changes: RecipeChange[] = []
    const resolved = resolvedFromDraft(input)

    const effectiveInstall = resolvedRunActions(resolved, 'prepared')
    const effectiveInstallRun = effectiveInstall?.[0]?.run ?? null
    if (effectiveInstall === null || looped.install !== effectiveInstallRun) {
      const originalPrepared = input.draft.get(['steps', 'prepared']) as unknown[] | null
      const wanted = looped.install === null ? [] : [{ name: 'install', run: looped.install }]
      changes.push({ path: ['steps', 'prepared'], value: mergeRunActions(originalPrepared ?? [], wanted) })
    }

    const effectiveBuild = resolvedRunActions(resolved, 'build')
    const sameBuild =
      effectiveBuild !== null &&
      effectiveBuild.length === looped.build.length &&
      effectiveBuild.every((a, i) => a.run === looped.build[i]!.run)
    if (!sameBuild) {
      const originalBuild = input.draft.get(['steps', 'build']) as unknown[] | null
      changes.push({ path: ['steps', 'build'], value: mergeRunActions(originalBuild ?? [], looped.build) })
    }

    return { changes, trial: looped.trial }
  })
}

/** The draft's text resolved on its own, or null where there is none or it does not resolve yet. */
function resolvedFromDraft(input: AskInstallAndBuildInput) {
  const path = recipePath(input.project, input.home)
  const text = input.draft.text()
  if (text === null) return null
  try {
    return resolveSource(text, path, path).recipe
  } catch {
    return null
  }
}
