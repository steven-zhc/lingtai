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
  readRecipeKey,
  recipePath,
  resolveSource,
} from '@lingtai/recipe'

import { type DetectedSetup, type SetupReader, detectSetup } from './detect-setup.ts'
import { type QuestionWorld, question } from './question.ts'

export type SetupWorld = QuestionWorld

/**
 * One command the trial run tried, and how it went. A command the trial never
 * reached is `not-run` and carries why, not evidence: nothing ran to produce any.
 */
export type TrialResult =
  | { command: string; outcome: 'passed' | 'failed'; evidence: string }
  | { command: string; outcome: 'not-run'; because: string }

/** What a trial hands back: its results, and whether the recipe declares any env. */
export interface TrialReport {
  results: TrialResult[]
  nothingDeclared: boolean
}

interface NamedRun {
  name: string
  run: string
}

export interface AskInstallAndBuildInput {
  project: string
  reader: SetupReader
  given: { install: string | null; build: string[] | null; check: 'yes' | 'no' | null }
  /** Null where there is nowhere to run it — logged, never run silently. */
  tryBuild: ((install: string | null, build: string[]) => Promise<TrialReport>) | null
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
async function currentRunActions(
  project: string,
  path: readonly string[],
  options: { home?: string; files?: RecipeFiles },
): Promise<NamedRun[]> {
  const value = await readRecipeKey(project, path, options)
  if (!Array.isArray(value)) return []
  return value.filter(isRunAction).map((a) => ({ name: String(a.name ?? ''), run: a.run }))
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
async function resolvedRunActions(
  project: string,
  step: 'prepared' | 'build',
  options: { home?: string; files?: RecipeFiles },
): Promise<NamedRun[] | null> {
  const files = options.files ?? diskFiles
  const path = recipePath(project, options.home)
  const text = await files.read(path)
  if (text === null) return null
  try {
    const actions = resolveSource(text, path, path).recipe.steps[step] as unknown[]
    return actions.filter(isRunAction).map((a) => ({ name: String(a.name ?? ''), run: a.run }))
  } catch {
    return null
  }
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
function nameForCommand(command: string, index: number, used: Set<string>): string {
  const m = /^(pnpm|yarn|npm|bun)\s+(?:run(?:-script)?\s+)?(.*)$/.exec(command.trim())
  let base = `check-${index + 1}`
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
  let name = base
  let n = 2
  while (used.has(name)) name = `${base}-${n++}`
  used.add(name)
  return name
}

function namedFromTyped(commands: readonly string[]): NamedRun[] {
  const used = new Set<string>()
  return commands.map((run, i) => ({ name: nameForCommand(run, i, used), run }))
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
      merged.push({ ...item, name: next!.name, run: next!.run })
    } else {
      merged.push(item)
    }
  }
  merged.push(...remaining)
  return merged
}

async function printFound(
  world: SetupWorld,
  detected: DetectedSetup,
  onPath: AskInstallAndBuildInput['onPath'],
): Promise<void> {
  if (onPath === undefined) return
  // The first word is the manager (`uv`, `poetry`, `pnpm`…). ruff, mypy and
  // pytest come from the project's environment after install, so they are not
  // probed; a probe that throws says nothing.
  const commands = [detected.install?.run, ...detected.build.map((b) => b.run)]
  const tools = new Set(commands.flatMap((c) => (c === undefined ? [] : [c.split(' ')[0]!])))
  for (const tool of tools) {
    try {
      if (!(await onPath(tool))) {
        world.log(`${tool} is not on this machine's PATH; the conductor runs these commands here`)
      }
    } catch {
      // extra information only
    }
  }
}

async function askInstall(
  world: SetupWorld,
  input: AskInstallAndBuildInput,
  detected: DetectedSetup,
): Promise<{ run: string | null; refused: string } | { run: string | null }> {
  const current = await currentRunActions(input.project, ['steps', 'prepared'], {
    home: input.home,
    files: input.files,
  })
  const currentRun = current[0]?.run ?? null

  const answer = await question(world, {
    name: 'the install command',
    flag: '--install <command>, or --install none',
    given: input.given.install,
    prompt: 'the install command',
    current: currentRun,
    detected: detected.install?.run ?? null,
    ...(currentRun === null && detected.install
      ? { why: [`install: ${detected.install.run} — ${detected.install.because}`] }
      : {}),
    fallback: '',
    validate: async (a) => (a === '' ? 'type a command, or none' : null),
    kept: input.kept,
  })
  if ('refused' in answer) return { run: null, refused: answer.refused }
  return { run: answer.answer === 'none' ? null : answer.answer }
}

/** Runs the trial build, prints its results, and decides whether a red one still writes. */
async function tryTheBuild(
  world: SetupWorld,
  input: AskInstallAndBuildInput,
  install: string | null,
  build: NamedRun[],
): Promise<{ ok: true; trial: TrialOutcome } | { refused: string }> {
  if (build.length === 0) return { ok: true, trial: { trial: 'not-run', because: 'no checks' } }
  if (input.tryBuild === null) {
    world.log(
      'the trial run was not run — no checkout on this machine; the first pass’s `build` is where these first run',
    )
    return { ok: true, trial: { trial: 'not-run', because: 'no checkout' } }
  }

  const check = await question(world, {
    name: 'the trial run',
    flag: '--check-build yes, or --check-build no',
    given: input.given.check,
    prompt: 'run these once against the base before writing them?',
    choices: ['yes', 'no'],
    fallback: 'yes',
    kept: input.kept,
  })
  if ('refused' in check) return { refused: check.refused }
  if (check.answer === 'no') return { ok: true, trial: { trial: 'not-run', because: 'declined' } }

  world.log('running the trial build — this can take minutes')
  let report: TrialReport
  const startedAt = Date.now()
  try {
    report = await input.tryBuild(
      install,
      build.map((b) => b.run),
    )
  } catch (err) {
    // Ctrl+C is not a result: the worktree is already gone, and a failed list
    // is not what was asked. Anything else is a bug and propagates.
    if (err instanceof Error && err.name === 'TrialInterrupted') {
      return { refused: `the trial run was interrupted. ${input.kept ?? 'Nothing was written'}` }
    }
    throw err
  }
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

  const decide = await question(world, {
    name: 'whether to write the failed build list',
    flag: '--check-build no',
    given: null,
    prompt: 'write them anyway, or edit the list?',
    choices: ['write', 'edit'],
    fallback: 'edit',
    kept: input.kept,
  })
  if ('refused' in decide) return { refused: decide.refused }
  if (decide.answer === 'edit') {
    return {
      refused: 'the trial build failed and the list was not written — rerun with --build to give a different list',
    }
  }
  return { ok: true, trial: { trial: 'failed-kept', command: firstFailed.command, ms } }
}

async function askBuild(
  world: SetupWorld,
  input: AskInstallAndBuildInput,
  detected: DetectedSetup,
): Promise<{ build: NamedRun[] } | { refused: string }> {
  const current = await currentRunActions(input.project, ['steps', 'build'], { home: input.home, files: input.files })

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
    const build = input.given.build[0] === 'none' ? [] : namedFromTyped(input.given.build)
    if (build.length === 0) world.log('nothing will check a diff before review')
    return { build }
  }

  const defaultList = current.length > 0 ? current : detected.build.length > 0 ? detected.build : null
  // What detection found explains a default only when the default came from it, not from the file's own list.
  const why =
    current.length > 0
      ? []
      : [
          ...detected.build.map((b) => `build (${b.name}): ${b.run} — ${b.because}`),
          ...detected.skipped.map((s) => `skipped \`${s.script}\`: ${s.why}`),
          ...detected.notes,
        ]

  if (defaultList !== null) {
    const answer = await question(world, {
      name: 'the build steps',
      flag: '--build <command> (repeatable), or --build none',
      given: null,
      prompt: 'run these before review? yes, or no to write your own',
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
    const answer = await question(world, {
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
  return { build: namedFromTyped(typed) }
}

export async function askInstallAndBuild(
  world: SetupWorld,
  input: AskInstallAndBuildInput,
): Promise<AskInstallAndBuildResult> {
  const detected = await detectSetup(input.reader)
  await printFound(world, detected, input.onPath)

  const install = await askInstall(world, input, detected)
  if ('refused' in install) return { refused: install.refused }

  const build = await askBuild(world, input, detected)
  if ('refused' in build) return { refused: build.refused }

  const tried = await tryTheBuild(world, input, install.run, build.build)
  if ('refused' in tried) return { refused: tried.refused }

  const changes: RecipeChange[] = []
  const fileOptions = { home: input.home, files: input.files }

  const effectiveInstall = await resolvedRunActions(input.project, 'prepared', fileOptions)
  const effectiveInstallRun = effectiveInstall?.[0]?.run ?? null
  if (effectiveInstall === null || install.run !== effectiveInstallRun) {
    const originalPrepared = (await readRecipeKey(input.project, ['steps', 'prepared'], fileOptions)) as
      | unknown[]
      | null
    const wanted = install.run === null ? [] : [{ name: 'install', run: install.run }]
    changes.push({ path: ['steps', 'prepared'], value: mergeRunActions(originalPrepared ?? [], wanted) })
  }

  const effectiveBuild = await resolvedRunActions(input.project, 'build', fileOptions)
  const sameBuild =
    effectiveBuild !== null &&
    effectiveBuild.length === build.build.length &&
    effectiveBuild.every((a, i) => a.run === build.build[i]!.run)
  if (!sameBuild) {
    const originalBuild = (await readRecipeKey(input.project, ['steps', 'build'], fileOptions)) as unknown[] | null
    changes.push({ path: ['steps', 'build'], value: mergeRunActions(originalBuild ?? [], build.build) })
  }

  return { changes, trial: tried.trial }
}
