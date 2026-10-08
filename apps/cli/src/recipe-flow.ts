/**
 * `askRecipe` (#431, #432): every recipe question `init`'s local branch and
 * `lingtai add`'s GitHub branch both ask.
 *
 * **Two files, two shapes.** An existing file is edited one answer at a
 * time — written once here instead of twice, in `first-project.ts`'s
 * `runLocalBranch` and `add-github.ts`'s `askBeforeGithubAdd` — so a Ctrl+C
 * keeps what was answered (#392 decision 1). An absent file is created once:
 * the first four sections' answers are collected rather than written as they
 * are given, folded in with the caller's own `seeds`, and handed to
 * `setRecipe` in a single call, with a comment above every block (`SAID`,
 * below) — #395's rule that a new file is written once, by whoever collects
 * every first-run answer.
 *
 * **In order:** `askAgents`, `askInstallAndBuild` (with `tryBuild: null` —
 * nothing here spends money, #391), `askTickets`, `askKinds` — these four are
 * where the two shapes differ — then, once the file is known to exist (on
 * disk already, or just created), `askLanding`, `askLimits`.
 *
 * **This asks; it does not probe.** `at.runtimes` is already probed
 * (`AskAgentsAt`'s own rule, `agents.ts:108`), and `at.reader` is already
 * built for wherever the file lives — a local directory or a GitHub ref.
 */
import { paint } from '@lingtai/env/colour'
import { diskFiles, type RecipeChange, type RecipeFiles, recipePath, type Said, setRecipe } from '@lingtai/recipe'

import { askAgents } from './agents.ts'
import type { SetupReader } from './detect-setup.ts'
import { askLanding, askLimits } from './landing.ts'
import { acceptingDefaults, question, type QuestionWorld } from './question.ts'
import type { RuntimeFound } from './runtimes.ts'
import { askInstallAndBuild } from './setup-build.ts'
import { askKinds, askTickets } from './source.ts'

/**
 * What a refusal inside `askRecipe` says was kept, for `lingtai add`'s
 * GitHub branch: by the time any of these questions is asked, each earlier
 * answer is already in the recipe, and none of it is undone — what has not
 * happened is the registration.
 */
export const ADD_KEPT = 'The answers given above are kept in the recipe, and nothing was registered'

/**
 * Where the filtered env file is planted inside the worktree — the one
 * `env.plantAt` seed both `first-project.ts`'s local branch and
 * `add-github.ts`'s GitHub branch write on an absent file, so the two name
 * the same path rather than two literals that drift.
 */
export const ENV_PLANT_AT = '.env.local'

/**
 * The wizard's own sentence for each block, keyed by its dotted path —
 * printed as that section's heading before its questions, on both the
 * existing-file and the absent-file paths, and written as the comment above
 * the same block when a file is created (`write.ts`'s `setRecipe`, `said`).
 *
 * **Not every key here is guaranteed to exist, and this list does not claim
 * it is.** `source.tickets` is `TicketSource.optional()` with no schema
 * default (`recipe.ts:1108`) — only the explicit fallback below guarantees it
 * on the absent-file path. `repo` and `env` are required fields with no
 * default either; they exist only because both callers of `askRecipe` seed
 * them before asking anything. The rest — `runtime`, both `steps.implement`
 * and `steps.review`, `steps.prepared`, `steps.build` and `source.kinds` —
 * are written unconditionally by their own question on an absent file, for
 * reasons local to each (`agents.ts`, `setup-build.ts`, `askKinds` above).
 * `steps.proposed` and `runtime.limits` may genuinely be missing when
 * `write.ts`'s creation write runs — `askLanding`/`askLimits` have not asked
 * yet — and `write.ts`'s `commentWritten` leaves a block it is not there to
 * comment rather than inventing a value nobody chose (#432 fix round,
 * findings 2 and 3).
 */
export const SAID: Said = {
  runtime: "which agent's pass this is",
  'steps.implement': 'which agent writes the change',
  'steps.review': 'which agent, if any, reads it cold before it moves on',
  'steps.prepared': 'getting the worktree ready before the agent starts',
  'steps.build': 'what must pass before review',
  'source.tickets': "where this project's tickets live",
  'source.kinds': 'which labels are work, most wanted first',
  repo: 'the branch this project governs, and where it pushes',
  'steps.proposed': 'what happens once a pass is ready to land',
  'runtime.limits': 'what one pass may spend before it comes back to you',
  env: "what the agent's environment is filtered to",
}

function announce(world: QuestionWorld, keys: readonly string[]): void {
  for (const key of keys) world.log(paint.muted(SAID[key]!))
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
  /** `wi-<project>-*` streams already in the log for this project — #396's `askTickets`. */
  history: (project: string) => Promise<readonly string[]>
  /**
   * The caller's own first-run answers — `repo.base`/`repo.remote`/`env.plantAt`
   * for a local project, `repo.base`/`env.plantAt` for a GitHub one. Written as
   * their own `setRecipe` call when the file already exists; folded into the
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
  home?: string
  files?: RecipeFiles
}

/** `setRecipe`, with its throw turned into the same `{refused}` shape every question here returns. */
async function writeOrRefuse(
  project: string,
  changes: readonly RecipeChange[],
  options: { home?: string; files?: RecipeFiles; said?: Said },
): Promise<{ ok: true } | { refused: string }> {
  if (changes.length === 0) return { ok: true }
  try {
    await setRecipe(project, changes, options)
    return { ok: true }
  } catch (err) {
    return { refused: (err as Error).message }
  }
}

export async function askRecipe(world: QuestionWorld, at: RecipeAt): Promise<{ ok: true } | { refused: string }> {
  const fileOptions = { home: at.home, files: at.files }
  const files = at.files ?? diskFiles
  const path = recipePath(at.project, at.home)

  // Asked first, ahead of the existing-file seed write below — nothing is
  // written yet on either path, so a refusal here always says
  // `at.keptBeforeWrite` (#433).
  const defaults = await question(world, {
    name: 'every default',
    flag: '--defaults',
    given: at.flags['defaults'] !== undefined ? 'yes' : null,
    prompt: 'use every default?',
    choices: ['yes', 'no'],
    fallback: 'yes',
    kept: at.keptBeforeWrite,
  })
  if ('refused' in defaults) return defaults
  const askWorld = defaults.answer === 'yes' ? acceptingDefaults(world) : world

  const existing = await files.read(path)
  const absent = existing === null

  if (!absent) {
    const wroteSeeds = await writeOrRefuse(at.project, at.seeds, fileOptions)
    if ('refused' in wroteSeeds) return wroteSeeds
  }

  // A refusal in any of the next four sections reaches no written file yet
  // on the absent path — `at.keptBeforeWrite` is what it says instead of
  // `at.kept` (#432's split).
  const askKept = absent ? at.keptBeforeWrite : at.kept
  const collected: RecipeChange[] = []

  announce(askWorld, ['runtime', 'steps.implement', 'steps.review'])
  const agents = await askAgents(askWorld, {
    project: at.project,
    runtimes: at.runtimes,
    flags: {
      agent: at.flags['agent'],
      model: at.flags['model'],
      reviewer: at.flags['reviewer'],
      reviewerModel: at.flags['reviewer-model'],
    },
    home: at.home,
    files: at.files,
    kept: askKept,
  })
  if ('refused' in agents) return agents
  if (absent) {
    collected.push(...agents.changes, ...agents.modelChanges)
  } else {
    const wroteAgentChanges = await writeOrRefuse(at.project, agents.changes, fileOptions)
    if ('refused' in wroteAgentChanges) return wroteAgentChanges
    const wroteModelChanges = await writeOrRefuse(at.project, agents.modelChanges, fileOptions)
    if ('refused' in wroteModelChanges) return wroteModelChanges
  }

  announce(askWorld, ['steps.prepared', 'steps.build'])
  const setup = await askInstallAndBuild(askWorld, {
    project: at.project,
    reader: at.reader,
    given: {
      install: at.flags['install'] ?? null,
      build: at.buildFlags.length === 0 ? null : [...at.buildFlags],
      check: null,
    },
    tryBuild: null,
    home: at.home,
    files: at.files,
    kept: askKept,
  })
  if ('refused' in setup) return setup
  if (absent) {
    collected.push(...setup.changes)
  } else {
    const wroteSetup = await writeOrRefuse(at.project, setup.changes, fileOptions)
    if ('refused' in wroteSetup) return wroteSetup
  }

  announce(askWorld, ['source.tickets'])
  const tickets = await askTickets(askWorld, at.project, at.local, at.flags['tickets'] ?? null, {
    home: at.home,
    files: at.files,
    history: at.history,
    kept: askKept,
  })
  if ('refused' in tickets) return tickets
  if (absent) {
    collected.push(...tickets.changes)
  } else {
    const wroteTickets = await writeOrRefuse(at.project, tickets.changes, fileOptions)
    if ('refused' in wroteTickets) return wroteTickets
  }

  announce(askWorld, ['source.kinds'])
  const kinds = await askKinds(askWorld, at.project, at.flags['kinds'] ?? null, {
    home: at.home,
    files: at.files,
    kept: askKept,
  })
  if ('refused' in kinds) return kinds
  if (absent) {
    collected.push(...kinds.changes)
  } else {
    const wroteKinds = await writeOrRefuse(at.project, kinds.changes, fileOptions)
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
    announce(askWorld, ['env'])
    const wrote = await writeOrRefuse(at.project, changes, { ...fileOptions, said: SAID })
    if ('refused' in wrote) return wrote
  }

  announce(askWorld, ['repo', 'steps.proposed'])
  const landed = await askLanding(askWorld, at.project, at.flags['land'] ?? null, {
    home: at.home,
    files: at.files,
    defaultBranch: at.defaultBranch,
    kept: at.kept,
  })
  if ('refused' in landed) return landed

  announce(askWorld, ['runtime.limits'])
  const limited = await askLimits(
    askWorld,
    at.project,
    { rounds: at.flags['rounds'], wall: at.flags['wall'], budget: at.flags['budget'] },
    { ...fileOptions, kept: at.kept },
  )
  if ('refused' in limited) return limited

  return { ok: true }
}
