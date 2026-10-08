/**
 * `askRecipe` (#431): every recipe question `init`'s local branch and
 * `lingtai add`'s GitHub branch both ask, for a project whose recipe file
 * already exists — written once here instead of twice, in
 * `first-project.ts`'s `runLocalBranch` and `add-github.ts`'s
 * `askBeforeGithubAdd`.
 *
 * **In order:** `askAgents`, `askInstallAndBuild` (with `tryBuild: null` —
 * nothing here spends money, #391), `askTickets`, `askKinds`, `askLanding`,
 * `askLimits`. Each answer is written with `setRecipe` the moment it is
 * given, not collected for one write at the end (#392 decision 1) — a
 * Ctrl+C keeps what was answered.
 *
 * **This asks; it does not probe.** `at.runtimes` is already probed
 * (`AskAgentsAt`'s own rule, `agents.ts:108`), and `at.reader` is already
 * built for wherever the file lives — a local directory or a GitHub ref.
 */
import { type RecipeChange, type RecipeFiles, setRecipe } from '@lingtai/recipe'

import { askAgents } from './agents.ts'
import type { SetupReader } from './detect-setup.ts'
import { askLanding, askLimits } from './landing.ts'
import type { QuestionWorld } from './question.ts'
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

export interface RecipeAt {
  project: string
  /** A local project is never asked where its tickets come from (`askTickets`'s own rule). */
  local: boolean
  /** Already probed — this function never probes on its own. */
  runtimes: readonly RuntimeFound[]
  reader: SetupReader
  flags: Readonly<Record<string, string>>
  defaultBranch: () => Promise<string | null>
  /** `wi-<project>-*` streams already in the log for this project — #396's `askTickets`. */
  history: (project: string) => Promise<readonly string[]>
  /** `question.ts`'s `kept` — what a refusal here says is already written. */
  kept: string
  home?: string
  files?: RecipeFiles
}

/** `setRecipe`, with its throw turned into the same `{refused}` shape every question here returns. */
async function writeOrRefuse(
  project: string,
  changes: readonly RecipeChange[],
  options: { home?: string; files?: RecipeFiles },
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

  const agents = await askAgents(world, {
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
    kept: at.kept,
  })
  if ('refused' in agents) return agents
  const wroteAgentChanges = await writeOrRefuse(at.project, agents.changes, fileOptions)
  if ('refused' in wroteAgentChanges) return wroteAgentChanges
  const wroteModelChanges = await writeOrRefuse(at.project, agents.modelChanges, fileOptions)
  if ('refused' in wroteModelChanges) return wroteModelChanges

  const setup = await askInstallAndBuild(world, {
    project: at.project,
    reader: at.reader,
    given: {
      install: at.flags['install'] ?? null,
      build: at.flags['build'] === undefined ? null : [at.flags['build']],
      check: null,
    },
    tryBuild: null,
    home: at.home,
    files: at.files,
  })
  if ('refused' in setup) return setup
  const wroteSetup = await writeOrRefuse(at.project, setup.changes, fileOptions)
  if ('refused' in wroteSetup) return wroteSetup

  const tickets = await askTickets(world, at.project, at.local, at.flags['tickets'] ?? null, {
    home: at.home,
    files: at.files,
    history: at.history,
    kept: at.kept,
  })
  if ('refused' in tickets) return tickets
  const wroteTickets = await writeOrRefuse(at.project, tickets.changes, fileOptions)
  if ('refused' in wroteTickets) return wroteTickets

  const kinds = await askKinds(world, at.project, at.flags['kinds'] ?? null, {
    home: at.home,
    files: at.files,
    kept: at.kept,
  })
  if ('refused' in kinds) return kinds
  const wroteKinds = await writeOrRefuse(at.project, kinds.changes, fileOptions)
  if ('refused' in wroteKinds) return wroteKinds

  const landed = await askLanding(world, at.project, at.flags['land'] ?? null, {
    home: at.home,
    files: at.files,
    defaultBranch: at.defaultBranch,
  })
  if ('refused' in landed) return landed

  const limited = await askLimits(
    world,
    at.project,
    { rounds: at.flags['rounds'], wall: at.flags['wall'], budget: at.flags['budget'] },
    fileOptions,
  )
  if ('refused' in limited) return limited

  return { ok: true }
}
