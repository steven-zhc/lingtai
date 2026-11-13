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
import {
  diskFiles,
  type RecipeChange,
  type RecipeFiles,
  readRecipeKeyEffect,
  recipePath,
  resolveSource,
} from '@lingtai/recipe'
import {
  type DetectedSetup,
  type SetupReader,
  type Trial,
  type TrialReport,
  type TrialResult,
  detectSetupEffect,
} from '@lingtai/setup'
import { Effect } from 'effect'

import { lift, recovering } from './exit.ts'
import { type QuestionWorld, questionEffect } from './question.ts'

export type SetupWorld = QuestionWorld

export type { Trial, TrialReport, TrialResult }

interface NamedRun {
  name: string
  run: string
}

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
  files?: RecipeFiles
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

function isRunAction(value: unknown): value is NamedRun & Record<string, unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { run?: unknown }).run === 'string'
}

/** The `run:` actions already at `path`, in file order — `[]` where the step is absent or writes none. */
function currentRunActions(
  project: string,
  path: readonly string[],
  options: { home?: string; files?: RecipeFiles },
): Effect.Effect<NamedRun[], unknown> {
  return Effect.gen(function* () {
    const value = yield* readRecipeKeyEffect(project, path, options)
    if (!Array.isArray(value)) return []
    return value.filter(isRunAction).map((a) => ({ name: String(a.name ?? ''), run: a.run }))
  })
}

/**
 * The `run:` actions that would actually execute at `step` — the file's own,
 * or inherited from a preset the file `extends:` — or `null` where there is
 * no recipe yet or it does not resolve on its own. `currentRunActions` reads
 * the file's own raw key and is right for *what to show as a default*;
 * deciding whether an answer changes anything needs this instead, or an
 * answer that only restates what a preset already supplies reads as
 * unchanged and widening later pins the preset's value in anyway.
 *
 * `null` and `[]` are kept apart on purpose: `[]` is a confirmed "nothing
 * runs here today", and the caller may skip writing a change that would say
 * the same thing. `null` is "unknown" — the file does not exist yet, or does
 * not resolve without an answer this call has not been given (`extends:`
 * written by the same batch, elsewhere in a first-run call) — and the only
 * safe reading of "unknown" is "assume it differs", so the caller always
 * writes its answer explicitly rather than risk a later preset default
 * silently filling in what the person declined.
 */
function resolvedRunActions(
  project: string,
  step: 'prepared' | 'build',
  options: { home?: string; files?: RecipeFiles },
): Effect.Effect<NamedRun[] | null, unknown> {
  return Effect.gen(function* () {
    const files = options.files ?? diskFiles
    const path = recipePath(project, options.home)
    const text = yield* lift(() => files.read(path))
    if (text === null) return null
    try {
      const actions = resolveSource(text, path, path).recipe.steps[step] as unknown[]
      return actions.filter(isRunAction).map((a) => ({ name: String(a.name ?? ''), run: a.run }))
    } catch {
      return null
    }
  })
}

/** A flag that takes its value as a separate following token, e.g. `pnpm --filter web test`. */
const VALUE_FLAGS = /^(?:--filter|-F|--workspace|-w)$/
/**
 * pnpm's own spelling of `-w`/`--workspace`: short for `--workspace-root`, and
 * takes no value at all — unlike npm's `-w`/`--workspace <name>`, which `VALUE_FLAGS`
 * is otherwise right about.
 */
const PNPM_WORKSPACE_ROOT = /^(?:-w|--workspace-root)$/
/** A subcommand that runs an arbitrary following binary rather than naming the check itself. */
const PASSTHROUGH_SUBCOMMAND = /^(?:exec|dlx|x)$/

/**
 * The script a command invokes, when it is `<pm> [run[-script]] <script>`.
 * Walks past a `-F`/`--filter`-style flag's own value and past a passthrough
 * subcommand like `exec`, since either would otherwise be captured in place
 * of the check it actually names — a numbered name where nothing is left.
 */
function nameForCommand(command: string, used: Set<string>): string {
  const m = /^(pnpm|yarn|npm|bun)\s+(?:run(?:-script)?\s+)?(.*)$/.exec(command.trim())
  // A typed command that is no `<manager> <script>` is named by itself: whitespace
  // collapsed, cut to 40 characters with `…`.
  const whole = command.trim().replace(/\s+/g, ' ')
  let base = whole.length > 40 ? `${whole.slice(0, 39)}…` : whole
  if (m) {
    const manager = m[1]
    const tokens = m[2]!.split(/\s+/).filter((t) => t !== '')
    let i = 0
    while (i < tokens.length && tokens[i]!.startsWith('-')) {
      const takesValue = VALUE_FLAGS.test(tokens[i]!) && !(manager === 'pnpm' && PNPM_WORKSPACE_ROOT.test(tokens[i]!))
      i += takesValue ? 2 : 1
    }
    if (i < tokens.length && PASSTHROUGH_SUBCOMMAND.test(tokens[i]!)) i += 1
    const candidate = tokens[i]
    if (candidate !== undefined && /^[\w:.-]+$/.test(candidate)) base = candidate
  }
  // `:` is reserved for the conductor's own actions; the recipe refuses it in a name.
  base = base.replaceAll(':', '-')
  let name = base
  let n = 2
  while (used.has(name)) name = `${base}-${n++}`
  used.add(name)
  return name
}

/**
 * The names `mergeRunActions` keeps from `original` when `wantedRuns` are
 * written: every non-`run:` action's name, and the name of each `run:` entry
 * whose text matches a wanted one. Beside the merge so the two cannot drift.
 */
function keptNames(
  original: unknown[],
  wantedRuns: readonly string[],
): { byRun: Map<string, string>; all: Set<string> } {
  const byRun = new Map<string, string>()
  const all = new Set<string>()
  for (const item of original) {
    const name = (item as { name?: unknown } | null)?.name
    if (typeof name !== 'string') continue
    if (!isRunAction(item)) all.add(name)
    else if (wantedRuns.includes(item.run)) {
      all.add(name)
      if (!byRun.has(item.run)) byRun.set(item.run, name)
    }
  }
  return { byRun, all }
}

function namedFromTyped(commands: readonly string[], original: unknown[]): NamedRun[] {
  const kept = keptNames(original, commands)
  const used = new Set(kept.all)
  return commands.map((run) => ({ name: kept.byRun.get(run) ?? nameForCommand(run, used), run }))
}

/**
 * `original` with its `run:` entries replaced by `wanted`, in place — every
 * other action keeps its position. A `wanted` entry is matched against
 * `original` by its `run:` text, not by where either sits in its list — an
 * action removed or reordered ahead of it must not make it look unchanged.
 * A match keeps the original's other fields (`timeout`, `env`) too, rather
 * than being rebuilt bare; an entry with no match in `original` is new and
 * gets none.
 */
function mergeRunActions(original: unknown[], wanted: NamedRun[]): unknown[] {
  const remaining = [...wanted]
  const merged: unknown[] = []
  for (const item of original) {
    if (isRunAction(item)) {
      const i = remaining.findIndex((w) => w.run === item.run)
      if (i === -1) continue
      const [next] = remaining.splice(i, 1)
      merged.push({ ...item, run: next!.run })
    } else {
      merged.push(item)
    }
  }
  merged.push(...remaining)
  return merged
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

function askInstall(
  world: SetupWorld,
  input: AskInstallAndBuildInput,
  detected: DetectedSetup,
  /** The command just tried (null for none), when this is a second time round. */
  previous?: string | null,
): Effect.Effect<{ run: string | null; refused: string } | { run: string | null }, unknown> {
  return Effect.gen(function* () {
    const current = yield* currentRunActions(input.project, ['steps', 'prepared'], {
      home: input.home,
      files: input.files,
    })
    const again = previous !== undefined
    const currentRun = again ? (previous ?? 'none') : (current[0]?.run ?? null)

    const answer = yield* questionEffect(world, {
      name: 'the install command',
      flag: '--install <command>, or --install none',
      given: input.given.install,
      prompt: 'the install command',
      current: currentRun,
      detected: again ? null : (detected.install?.run ?? null),
      ...(!again && currentRun === null && detected.install
        ? { why: [`install: ${detected.install.run} — ${detected.install.because}`] }
        : {}),
      fallback: '',
      validate: (a) => Effect.succeed(a === '' ? 'type a command, or none' : null),
      kept: input.kept,
    })
    if ('refused' in answer) return { run: null, refused: answer.refused }
    return { run: answer.answer === 'none' ? null : answer.answer }
  })
}

type Tried =
  | { ok: true; trial: TrialOutcome }
  | { again: 'edit'; at: 'install' | 'build' }
  | { again: 'drop'; failed: string[] }
  | { refused: string }

/**
 * Runs the trial build, prints its results, and asks what to do with a red one:
 * keep the list, go back and edit it, or drop the checks that failed.
 * `asked` is false for the run `drop` repeats — choosing it was the question.
 */
function tryTheBuild(
  world: SetupWorld,
  input: AskInstallAndBuildInput,
  install: string | null,
  build: NamedRun[],
  asked: boolean,
): Effect.Effect<Tried, unknown> {
  return Effect.gen(function* () {
    if (build.length === 0) return { ok: true, trial: { trial: 'not-run', because: 'no checks' } }
    const trial = input.tryBuild
    if (trial === null) {
      world.log(
        'the trial run was not run — no checkout on this machine; the first attempt’s `build` is where these first run',
      )
      return { ok: true, trial: { trial: 'not-run', because: 'no checkout' } }
    }

    if (asked) {
      const base = yield* trial.base
      const ending = input.recipeExisted === true ? 'This list is not written yet.' : 'Nothing is written yet.'
      const check = yield* questionEffect(world, {
        name: 'the trial run',
        flag: '--check-build yes, or --check-build no',
        given: input.given.check,
        prompt: `Try them once now, on \`${base}\`, to see that they work? ${ending}`,
        choices: ['yes', 'no'],
        fallback: 'yes',
        kept: input.kept,
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
      return { refused: `the trial run was interrupted. ${input.kept ?? 'Nothing was written'}` }
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
        `the recipe declares no env, so these ran without any of your variables — if a check needs one, declare it under env: in ${recipePath(input.project, input.home)}`,
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
      kept: input.kept,
    })
    if ('refused' in decide) return { refused: decide.refused }
    if (decide.answer === 'drop') return { again: 'drop', failed: failedChecks }
    if (decide.answer === 'edit') {
      const at = failedChecks.length > 0 && failedOther.length === 0 ? 'build' : 'install'
      if (at === 'build' && input.given.build !== null) {
        return {
          refused: 'the trial build failed and the list was not written — rerun with --build to give a different list',
        }
      }
      if (at === 'install' && input.given.install !== null) {
        return {
          refused:
            'the trial’s install failed and the list was not written — rerun with --install to give a different one',
        }
      }
      return { again: 'edit', at }
    }
    return { ok: true, trial: { trial: 'failed-kept', command: firstFailed.command, ms } }
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
    const originalBuild = (yield* readRecipeKeyEffect(input.project, ['steps', 'build'], {
      home: input.home,
      files: input.files,
    })) as unknown[] | null
    const current =
      previous ??
      (yield* currentRunActions(input.project, ['steps', 'build'], { home: input.home, files: input.files }))

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

    const defaultList = current.length > 0 ? current : detected.build.length > 0 ? detected.build : null
    // What detection found explains a default only when the default came from it, not from the file's own list.
    const why =
      current.length > 0 || previous !== undefined
        ? []
        : [
            ...detected.build.map((b) => `build (${b.name}): ${b.run} — ${b.because}`),
            ...detected.skipped.map((s) => `skipped \`${s.script}\`: ${s.why}`),
            ...detected.notes,
          ]

    if (defaultList !== null) {
      const answer = yield* questionEffect(world, {
        name: 'the build steps',
        flag: '--build <command> (repeatable), or --build none',
        given: null,
        prompt: 'Each attempt runs these checks before review — keep this list? (yes / no to write your own)',
        choices: ['yes', 'no'],
        fallback: 'yes',
        why,
        kept: input.kept,
      })
      if ('refused' in answer) return { refused: answer.refused }
      if (answer.answer === 'yes') return { build: defaultList.map(({ name, run }) => ({ name, run })) }
    }

    const typed: string[] = []
    for (;;) {
      const answer = yield* questionEffect(world, {
        name: 'a build command',
        flag: '--build <command> (repeatable), or --build none',
        given: null,
        prompt: 'a command that must pass before review — empty when done',
        fallback: '',
        ...(defaultList === null && typed.length === 0 && why.length > 0 ? { why } : {}),
        kept: input.kept,
      })
      if ('refused' in answer) return { refused: answer.refused }
      if (answer.answer === '') break
      typed.push(answer.answer)
    }
    if (typed.length === 0) world.log('nothing will check a diff before review')
    return { build: namedFromTyped(typed, originalBuild ?? []) }
  })
}

export function askInstallAndBuildEffect(
  world: SetupWorld,
  input: AskInstallAndBuildInput,
): Effect.Effect<AskInstallAndBuildResult, unknown> {
  return Effect.gen(function* () {
    const detected = input.detected ?? (yield* detectSetupEffect(input.reader))
    yield* printFound(world, detected, input.onPath)

    let install = yield* askInstall(world, input, detected)
    if ('refused' in install) return { refused: install.refused }

    let build = yield* askBuild(world, input, detected)
    if ('refused' in build) return { refused: build.refused }

    let tried: Tried
    for (;;) {
      let asked = true
      for (;;) {
        tried = yield* tryTheBuild(world, input, install.run, build.build, asked)
        if ('again' in tried && tried.again === 'drop') {
          const failed: Set<string> = new Set(tried.failed)
          build = { build: build.build.filter((b) => !failed.has(b.run)) }
          if (build.build.length === 0) world.log('nothing will check a diff before review')
          asked = false
          continue
        }
        break
      }
      if (!('again' in tried)) break
      // edit: back to the question that can change what failed, every earlier answer kept.
      if (tried.at === 'install') {
        install = yield* askInstall(world, input, detected, install.run)
        if ('refused' in install) return { refused: install.refused }
      }
      build = yield* askBuild(world, input, detected, build.build)
      if ('refused' in build) return { refused: build.refused }
    }
    if ('refused' in tried) return { refused: tried.refused }

    const changes: RecipeChange[] = []
    const fileOptions = { home: input.home, files: input.files }

    const effectiveInstall = yield* resolvedRunActions(input.project, 'prepared', fileOptions)
    const effectiveInstallRun = effectiveInstall?.[0]?.run ?? null
    if (effectiveInstall === null || install.run !== effectiveInstallRun) {
      const originalPrepared = (yield* readRecipeKeyEffect(input.project, ['steps', 'prepared'], fileOptions)) as
        | unknown[]
        | null
      const wanted = install.run === null ? [] : [{ name: 'install', run: install.run }]
      changes.push({ path: ['steps', 'prepared'], value: mergeRunActions(originalPrepared ?? [], wanted) })
    }

    const effectiveBuild = yield* resolvedRunActions(input.project, 'build', fileOptions)
    const sameBuild =
      effectiveBuild !== null &&
      effectiveBuild.length === build.build.length &&
      effectiveBuild.every((a, i) => a.run === build.build[i]!.run)
    if (!sameBuild) {
      const originalBuild = (yield* readRecipeKeyEffect(input.project, ['steps', 'build'], fileOptions)) as
        | unknown[]
        | null
      changes.push({ path: ['steps', 'build'], value: mergeRunActions(originalBuild ?? [], build.build) })
    }

    return { changes, trial: tried.trial }
  })
}
