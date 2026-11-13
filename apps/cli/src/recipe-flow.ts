/**
 * `askRecipe` (#431, #432): every recipe question `init`'s local branch and
 * `lingtai add`'s GitHub branch both ask.
 *
 * **Two files, two shapes.** An existing file is edited one answer at a
 * time — written once here instead of twice, in `first-project.ts`'s
 * `runLocalBranch` and `add-github.ts`'s `askBeforeGithubAdd` — so a Ctrl+C
 * keeps what was answered (#392 decision 1). An absent file is created once:
 * the first four sections' answers are collected rather than written as they
 * are given, reduced in with the caller's own `seeds`, and handed to
 * `setRecipe` in a single call, with a comment above every block (`SAID`,
 * below) — #395's rule that a new file is written once, by whoever collects
 * every first-run answer.
 *
 * **In order:** `askAgents`, `askInstallAndBuild` (with the caller's
 * `tryBuild`, which runs the repository's own commands once and spends machine
 * time, never money, #436), `askTickets`, `askKinds` — these four are
 * where the two shapes differ — then, once the file is known to exist (on
 * disk already, or just created), `askLanding`, `askLimits`.
 *
 * **This asks; it does not probe.** `at.runtimes` is already probed
 * (`AskAgentsAt`'s own rule, `agents.ts:108`), and `at.reader` is already
 * built for wherever the file lives — a local directory or a GitHub ref.
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { type RateRow, shipped } from '@lingtai/domain/rate-card'
import { readJson, snapshotPath } from '@lingtai/projector'
import {
  baseOf,
  diskFiles,
  type RecipeChange,
  type RecipeFiles,
  recipePath,
  resolveSource,
  type Said,
  setRecipeEffect,
} from '@lingtai/recipe'
import { type Answers, draftFiles, ENV_PLANT_AT, SAID, type SetupReader } from '@lingtai/setup'
import type { Proposal, RuntimeFound } from '@lingtai/setup'
import { Effect } from 'effect'

import { askAgents } from './agents.ts'
import { lift, recovering } from './exit.ts'
import { askLanding, askLimits } from './landing.ts'
import { acceptingDefaults, questionEffect, type QuestionWorld } from './question.ts'
import { type AskInstallAndBuildInput, type TrialOutcome, askInstallAndBuild } from './setup-build.ts'
import { askKinds, askTickets } from './source.ts'

/**
 * What a refusal inside `askRecipe` says was kept, for `lingtai add`'s
 * GitHub branch: by the time any of these questions is asked, each earlier
 * answer is already in the recipe, and none of it is undone — what has not
 * happened is the registration.
 */
export const ADD_KEPT = 'Nothing was written and nothing was registered'

export { ENV_PLANT_AT, SAID }

/** Whether `tool` is an existing file in a directory on this process's PATH. */
function toolOnPath(tool: string): Promise<boolean> {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d !== '')
  const names = process.platform === 'win32' ? [tool, `${tool}.exe`, `${tool}.cmd`] : [tool]
  return Promise.resolve(dirs.some((dir) => names.some((name) => existsSync(join(dir, name)))))
}

export interface RecipeAt {
  project: string
  /** A local project is never asked where its tickets come from (`askTickets`'s own rule). */
  local: boolean
  /** Already probed — this function never probes on its own. */
  runtimes: readonly RuntimeFound[]
  reader: SetupReader
  flags: Readonly<Record<string, string>>
  /** Every `--build <cmd>` on the command line, in order — `flags['build']` alone is only the last (#431 fix round, finding 3). */
  buildFlags: readonly string[]
  defaultBranch: () => Promise<string | null>
  /**
   * What `proposeSetup` read: its values are the questions' fallbacks. A value
   * the file already has still wins — this replaces only what would have been
   * invented. Absent in a test that wants the plain defaults.
   */
  proposal?: Proposal
  /** The trial run (#436) — absent where there is no checkout to cut, and `setup-build.ts` then says so. */
  tryBuild?:
    | AskInstallAndBuildInput['tryBuild']
    | ((files: RecipeFiles) => NonNullable<AskInstallAndBuildInput['tryBuild']>)
  /** `ticket-<project>-*` streams already in the log for this project — #396's `askTickets`. */
  history: (project: string) => Promise<readonly string[]>
  /**
   * The caller's own first-run answers — `repo.base`/`repo.remote`/`env.plantAt`
   * for a local project, `repo.base`/`env.plantAt` for a GitHub one. Written as
   * their own `setRecipe` call when the file already exists; reduced into the
   * one creation write, alongside this function's own four sections' answers,
   * when it does not (#432).
   */
  seeds: readonly RecipeChange[]
  /** `question.ts`'s `kept` — what a refusal after a write says is already written. */
  kept: string
  /**
   * What a refusal says before any write this function makes — the absent
   * path's first four questions reach no written file yet, so a refusal
   * there must say what was true before this call, not `kept` (#432).
   */
  keptBeforeWrite: string
  /** The command that changes what the summary shows — `lingtai add --local <dir>`, `lingtai add <owner>/<repo>`. */
  again: string
  home?: string
  files?: RecipeFiles
  /** The prices fetched onto this machine, `null` where the file is there and cannot be read; defaults to the real snapshot, which under a test reads as none unless it has its own `LINGTAI_HOME` (#693). */
  rates?: () => readonly unknown[] | null
}

/** What the recipe, as written, will do with a change — the three facts a newcomer needs before anything is registered (#542). */
export interface Summary {
  checks: readonly string[]
  review: string | null
  landsUnattended: boolean
  base: string
  /** The model each agent action names, `null` where it names none (#693). */
  models: readonly { role: 'writer' | 'reviewer'; model: string | null }[]
}

/** The snapshot's rows; `null` where the file exists and is not a `{ rows: [...] }` document. */
function fetchedRates(): readonly unknown[] | null {
  const path = snapshotPath(process.env)
  if (path === null || !existsSync(path)) return []
  const doc = readJson(path) as { rows?: unknown } | undefined
  return Array.isArray(doc?.rows) ? doc.rows : null
}

/**
 * The lines that say which chosen models have no price yet (#693). A hint about
 * what this machine knows now, never a verdict: `init` does not fetch (#658).
 */
export function priceHints(models: Summary['models'], snapshot: readonly unknown[] | null): string[] {
  const lines: string[] = []
  const unreadable = snapshot === null
  const priced = (model: string) =>
    (snapshot ?? []).some((r) => typeof r === 'object' && r !== null && (r as Partial<RateRow>).model === model)
  const named = new Set<string>()
  for (const { model } of models) {
    if (model === null || named.has(model)) continue
    named.add(model)
    if (shipped(model) || priced(model)) continue
    lines.push(
      `${model} is not priced yet — the shipped rate card does not list it and no fetched price for it is on this machine${unreadable ? ' (the fetched-price snapshot there could not be read)' : ''}. The conductor fetches prices when it starts; check \`lingtai doctor\` after the first run.`,
    )
  }
  if (models.some((m) => m.model === null)) {
    lines.push('A role with no model is priced by the model its runtime reports on the first run.')
  }
  return lines
}

/** The file as it stands, read the way the pass will read it — never the answers held in memory. */
export const summariseRecipe = Effect.fn('recipe-flow.summariseRecipe')(function* (
  project: string,
  options: { home?: string; files?: RecipeFiles },
): Effect.fn.Return<Summary | { refused: string }, unknown> {
  const path = recipePath(project, options.home)
  const text = yield* lift(() => (options.files ?? diskFiles).read(path))
  if (text === null) return { refused: `no recipe at ${path} to summarise` }
  try {
    const { recipe } = resolveSource(text, path, path)
    const steps = recipe.steps as unknown as Record<string, readonly Record<string, unknown>[]>
    const checks = (steps['build'] ?? []).filter((a) => typeof a['run'] === 'string').map((a) => String(a['run']))
    const reviewer = (steps['review'] ?? []).find((a) => typeof a['agent'] === 'string')
    const writer = (steps['implement'] ?? []).find((a) => typeof a['agent'] === 'string')
    const modelOf = (role: 'writer' | 'reviewer', action: Record<string, unknown> | undefined) =>
      action === undefined
        ? []
        : [{ role, model: typeof action['model'] === 'string' && action['model'] !== '' ? action['model'] : null }]
    return {
      models: [...modelOf('writer', writer), ...modelOf('reviewer', reviewer)],
      checks,
      review: reviewer === undefined ? null : String(reviewer['agent']),
      landsUnattended: !(steps['proposed'] ?? []).some((a) => 'human' in a),
      base: baseOf(recipe),
    }
  } catch (err) {
    return { refused: (err as Error).message }
  }
})

/** `setRecipe`, with its throw turned into the same `{refused}` shape every question here returns. */
function writeOrRefuse(
  project: string,
  changes: readonly RecipeChange[],
  options: { home?: string; files?: RecipeFiles; said?: Said },
): Effect.Effect<{ ok: true } | { refused: string }> {
  if (changes.length === 0) return Effect.succeed({ ok: true })
  return setRecipeEffect(project, changes, options).pipe(
    Effect.map((): { ok: true } => ({ ok: true })),
    recovering((err) => Effect.succeed({ refused: err.message })),
  )
}

type Recipe = { ok: true; trial: TrialOutcome; hints: string[]; answers: Answers } | { refused: string }

export function askRecipe(world: QuestionWorld, at: RecipeAt): Promise<Recipe> {
  return Effect.runPromise(askRecipeEffect(world, at))
}

export const askRecipeEffect = Effect.fn('recipe-flow.askRecipe')(function* (
  world: QuestionWorld,
  at: RecipeAt,
): Effect.fn.Return<Recipe, unknown> {
  const path = recipePath(at.project, at.home)
  // Every answer lands in this draft and nowhere else: `applySetup` (#968) is the one
  // writer of the file, so a refusal anywhere below leaves the disk as it was.
  const draft = draftFiles(at.files ?? diskFiles, path)
  const files: RecipeFiles = draft
  const fileOptions = { home: at.home, files }

  // Asked first, ahead of the existing-file seed write below — nothing is
  // written yet on either path, so a refusal here always says
  // `at.keptBeforeWrite` (#433).
  const defaults = yield* questionEffect(world, {
    name: 'every default',
    flag: '--defaults',
    given: at.flags['defaults'] !== undefined ? 'yes' : null,
    prompt: 'use every default?',
    choices: ['yes', 'no'],
    fallback: 'yes',
    kept: at.keptBeforeWrite,
  })
  // A refusal here can only mean the question went unanswered — `given` is
  // either 'yes' or null (`at.flags['defaults']`), and 'yes' always accepts,
  // so the only way to land in `{refused}` is no `--defaults` flag and no
  // terminal to ask at. That is not a reason to stop the run: a headless run
  // whose every later question is already answered by a flag must still
  // succeed, and one whose own flag is missing must be refused by that
  // question's own name, not this one's (#433 fix round, findings 1 and 2).
  const askWorld = 'answer' in defaults && defaults.answer === 'yes' ? acceptingDefaults(world) : world

  const existing = yield* lift(() => files.read(path))
  const absent = existing === null

  if (!absent) {
    const wroteSeeds = yield* writeOrRefuse(at.project, at.seeds, fileOptions)
    if ('refused' in wroteSeeds) return wroteSeeds
  }

  // A refusal in any of the next four sections reaches no written file yet
  // on the absent path — `at.keptBeforeWrite` is what it says instead of
  // `at.kept` (#432's split).
  const askKept = absent ? at.keptBeforeWrite : at.kept
  const collected: RecipeChange[] = []

  const agents = yield* askAgents(askWorld, {
    project: at.project,
    runtimes: at.runtimes,
    flags: {
      agent: at.flags['agent'],
      model: at.flags['model'],
      reviewer: at.flags['reviewer'],
      reviewerModel: at.flags['reviewer-model'],
    },
    home: at.home,
    files,
    kept: askKept,
  })
  if ('refused' in agents) return agents
  if (absent) {
    collected.push(...agents.changes, ...agents.modelChanges)
  } else {
    const wroteAgentChanges = yield* writeOrRefuse(at.project, agents.changes, fileOptions)
    if ('refused' in wroteAgentChanges) return wroteAgentChanges
    const wroteModelChanges = yield* writeOrRefuse(at.project, agents.modelChanges, fileOptions)
    if ('refused' in wroteModelChanges) return wroteModelChanges
  }

  const setup = yield* lift(() =>
    askInstallAndBuild(askWorld, {
      project: at.project,
      reader: at.reader,
      ...(at.proposal?.detected.known === true ? { detected: at.proposal.detected.value } : {}),
      given: {
        install: at.flags['install'] ?? null,
        build: at.buildFlags.length === 0 ? null : [...at.buildFlags],
        // Keyed on the world and not on the flag, so a person who typed `yes` at
        // "use every default?" is held to it as `--defaults` is: no scripted or
        // defaulted setup runs minutes of somebody's build (#436).
        check: (at.flags['check-build'] as 'yes' | 'no' | undefined) ?? (askWorld !== world ? 'no' : null),
      },
      tryBuild: typeof at.tryBuild === 'function' ? at.tryBuild(files) : (at.tryBuild ?? null),
      recipeExisted: !absent,
      onPath: toolOnPath,
      home: at.home,
      files,
      kept: askKept,
    }),
  )
  if ('refused' in setup) return setup
  const trial = setup.trial
  // Said only once the write that carries the list has happened, never when it was chosen.
  const sayKept = () => {
    if (trial.trial === 'failed-kept') {
      askWorld.log(
        `kept the list as tried — it goes into ${recipePath(at.project, at.home)} when the project is added; nothing is written yet`,
      )
    }
  }
  if (absent) {
    collected.push(...setup.changes)
  } else {
    const wroteSetup = yield* writeOrRefuse(at.project, setup.changes, fileOptions)
    if ('refused' in wroteSetup) return wroteSetup
    sayKept()
  }

  const tickets = yield* askTickets(askWorld, at.project, at.local, at.flags['tickets'] ?? null, {
    home: at.home,
    files,
    history: at.history,
    kept: askKept,
  })
  if ('refused' in tickets) return tickets
  if (absent) {
    collected.push(...tickets.changes)
  } else {
    const wroteTickets = yield* writeOrRefuse(at.project, tickets.changes, fileOptions)
    if ('refused' in wroteTickets) return wroteTickets
  }

  const kinds = yield* askKinds(askWorld, at.project, at.flags['kinds'] ?? null, {
    home: at.home,
    files,
    kept: askKept,
    ...(at.proposal?.kinds.known === true ? { kindsFallback: at.proposal.kinds.value } : {}),
  })
  if ('refused' in kinds) return kinds
  if (absent) {
    collected.push(...kinds.changes)
  } else {
    const wroteKinds = yield* writeOrRefuse(at.project, kinds.changes, fileOptions)
    if ('refused' in wroteKinds) return wroteKinds
  }

  if (absent) {
    const all = [...at.seeds, ...collected]
    // `source.tickets` has no schema default (`recipe.ts:1108`) — a project
    // that pressed enter on `askTickets`'s own current answer wrote no change
    // at all. Fall back to `tickets.current` — the source `askTickets`
    // actually decided, history included, never a bare `'github'` literal:
    // a project read off an absent file whose log already has `db`-sourced
    // work items must keep that source, not have it silently overridden
    // (#432 fix round, finding 1).
    const changes = all.some((c) => c.path.join('.') === 'source.tickets')
      ? all
      : [...all, { path: ['source', 'tickets'], value: tickets.current }]
    const wrote = yield* writeOrRefuse(at.project, changes, { ...fileOptions, said: SAID })
    if ('refused' in wrote) return wrote
    sayKept()
  }

  const landed = yield* askLanding(askWorld, at.project, at.flags['land'] ?? null, {
    home: at.home,
    files,
    defaultBranch: at.defaultBranch,
    kept: at.kept,
  })
  if ('refused' in landed) return landed

  const limited = yield* askLimits(
    askWorld,
    at.project,
    { rounds: at.flags['rounds'], wall: at.flags['wall'], budget: at.flags['budget'] },
    { ...fileOptions, kept: at.kept },
  )
  if ('refused' in limited) return limited

  // Last, and read back from the file: every registration follows this function (#542).
  const summary = yield* summariseRecipe(at.project, fileOptions)
  if ('refused' in summary) return summary
  const hints = priceHints(summary.models, (at.rates ?? fetchedRates)())

  // Only the defaults can reach here without anyone having looked: a person who
  // typed an answer, or named `--build none` or `--land <branch>`, chose it.
  const unseenEmptyBuild = summary.checks.length === 0 && at.buildFlags.length === 0
  const unseenUnattended = summary.landsUnattended && at.flags['land'] === undefined
  if (askWorld !== world && (unseenEmptyBuild || unseenUnattended)) {
    // Asked of `world`, never `askWorld`: a terminal that accepted every default still stops to read.
    const lands = `an attempt lands on ${summary.base || 'the base branch'} with no one asking`
    const asks =
      unseenEmptyBuild && unseenUnattended
        ? `nothing checks a diff before review, and ${lands}`
        : unseenEmptyBuild
          ? 'nothing checks a diff before review'
          : lands
    const confirmed = yield* questionEffect(world, {
      name: 'registering with these defaults',
      flag: '--defaults, or --build <cmd>|none and --land <branch>|hold to choose explicitly',
      given: at.flags['defaults'] !== undefined ? 'yes' : null,
      prompt: `${asks} — register anyway?`,
      choices: ['yes', 'no'],
      fallback: 'yes',
      kept: at.kept,
    })
    if ('refused' in confirmed) return confirmed
    if (confirmed.answer === 'no') {
      return {
        refused: 'stopped before registering — nothing was written and nothing was registered',
      }
    }
  }

  return { ok: true, trial, hints, answers: { project: at.project, changes: draft.changes(), said: SAID } }
})
