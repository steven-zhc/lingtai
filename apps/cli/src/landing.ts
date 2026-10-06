/**
 * `lingtai add`'s setup questions (#399): land on a branch or hold every pass,
 * then the limits — rounds, wall, and a spend ceiling in money.
 *
 * Asked before `add()` runs, never inside it (`onboard.ts`'s `add` has a
 * second caller, the board's Recheck, which must never ask a question), and
 * only when the project's recipe file already exists — `add()`'s own refusal
 * speaks for an absent one, and nothing here seeds a file that cannot resolve
 * on its own (#395).
 *
 * Each answer is one `setRecipe` call, written the moment it is given (#392
 * decision 1, #391 — *a Ctrl+C keeps what was answered*). The pure half of
 * each write — the answer turned into `RecipeChange[]` — is `@lingtai/recipe`'s
 * `answers.ts`, so the conductor's own test can apply the same change set and
 * prove it holds or lands a pass, not only that it resolves.
 */
import { createInterface } from 'node:readline/promises'

import { passCeiling } from '@lingtai/conductor/ceiling'
import { paint } from '@lingtai/env/colour'
import {
  type RecipeFiles,
  budgetChange,
  ceilingOf,
  diskFiles,
  landingChanges,
  parseDuration,
  readRecipeKey,
  recipePath,
  resolveSource,
  roundsChange,
  setRecipe,
  wallChange,
} from '@lingtai/recipe'

import { type QuestionWorld, question } from './question.ts'

/** `console` and `stdin`, for `addCommand` — no TTY answers every question null (#392). */
export function liveQuestionWorld(): QuestionWorld {
  return {
    log: (line) => console.log(line),
    ask: async (prompt) => {
      if (!process.stdin.isTTY) return null
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await rl.question(prompt)
      } finally {
        rl.close()
      }
    },
  }
}

export interface LandingDeps {
  home?: string
  files?: RecipeFiles
  /** The repository's default branch — asked only when nothing else answers it. */
  defaultBranch: () => Promise<string | null>
}

type Answered = { ok: true } | { refused: string }

async function resolvedFile(
  project: string,
  options: { home?: string; files?: RecipeFiles },
): Promise<
  | {
      text: string
      proposed: readonly Record<string, unknown>[]
      limits: { turns: number; wall: string; rounds: number; restarts: number; usd?: number }
      agent: string
    }
  | { refused: string }
> {
  const files = options.files ?? diskFiles
  const path = recipePath(project, options.home)
  const text = await files.read(path)
  if (text === null) return { refused: `no recipe at ${path} — lingtai add reads this project's own refusal for that` }
  let resolved
  try {
    resolved = resolveSource(text, path, path)
  } catch (err) {
    return { refused: (err as Error).message }
  }
  return {
    text,
    proposed: resolved.recipe.steps.proposed,
    limits: ceilingOf(resolved.recipe),
    agent: resolved.recipe.runtime.agent,
  }
}

/**
 * **Land on a branch, or hold every pass for a person** — `--land <branch>|hold`.
 *
 * `current` is `'hold'` when the resolved recipe already carries a `human:`
 * at `proposed` (a preset's counts, same as a person's own), else whatever
 * the file writes at `repo.base`. `detected` is the repository's default
 * branch, asked only when neither answers it.
 */
export async function askLanding(
  world: QuestionWorld,
  project: string,
  land: string | null,
  deps: LandingDeps,
): Promise<Answered> {
  const options = { home: deps.home, files: deps.files }
  const file = await resolvedFile(project, options)
  if ('refused' in file) return file

  const currentlyHolds = file.proposed.some((action) => 'human' in action)
  const currentBase = await readRecipeKey(project, ['repo', 'base'], options)
  const current = currentlyHolds ? 'hold' : typeof currentBase === 'string' ? currentBase : null
  const detected = await deps.defaultBranch()

  const result = await question(world, {
    name: 'the landing',
    flag: '--land <branch>|hold',
    given: land,
    prompt: 'land this on which branch, or "hold" to hold every pass for a person',
    current,
    detected,
  })
  if ('refused' in result) return result

  const hadSteps = (await readRecipeKey(project, ['steps'], options)) !== null
  const currentProposed = await readRecipeKey(project, ['steps', 'proposed'], options)
  const changes = landingChanges(
    result.answer === 'hold' ? { land: 'hold' } : { land: result.answer },
    Array.isArray(currentProposed) ? currentProposed : null,
  )
  const written = await setRecipe(project, changes, options)
  if (written.written && !hadSteps && changes.some((c) => c.path[0] === 'steps')) {
    world.log(
      paint.muted(
        `${recipePath(project, deps.home)} had no steps: of its own — writing steps.proposed pins every other ` +
          'step this file was inheriting from its preset, in the file, alongside it',
      ),
    )
  }
  world.log(
    result.answer === 'hold'
      ? paint.pass('landing       hold — every pass stops at proposed for a person')
      : paint.pass(`landing       ${result.answer}`),
  )
  return { ok: true }
}

/** `--budget`'s "none", parsed the way the question accepts `5`, `5.00` and `$5`. */
function parseBudget(answer: string): number | null | string {
  if (answer.trim().toLowerCase() === 'none') return null
  const n = Number(answer.trim().replace(/^\$/, ''))
  if (!Number.isFinite(n) || n <= 0) {
    return 'that is not a dollar amount — write a positive number like 5 or 5.00, or "none" for no ceiling'
  }
  return n
}

export interface LimitsFlags {
  rounds?: string
  wall?: string
  budget?: string
}

/**
 * **The limits: rounds, wall and a spend ceiling, each narrowed only when the
 * answer differs from what the recipe resolves to now** — pressing enter on
 * an inherited default must not pin it into the file (`write.ts`'s
 * `readRecipeKey` comment, #392).
 */
export async function askLimits(
  world: QuestionWorld,
  project: string,
  flags: LimitsFlags,
  options: { home?: string; files?: RecipeFiles },
): Promise<Answered> {
  const file = await resolvedFile(project, options)
  if ('refused' in file) return file
  const { limits } = file

  const rounds = await question(world, {
    name: 'rounds',
    flag: '--rounds <n>',
    given: flags.rounds ?? null,
    prompt: 'how many times a pass sends the agent back — 0 means every refusal goes straight to you',
    current: String(limits.rounds),
    validate: async (answer) => (/^\d+$/.test(answer) ? null : 'that is not a whole number 0 or greater'),
  })
  if ('refused' in rounds) return rounds

  const wall = await question(world, {
    name: 'wall',
    flag: '--wall <duration>',
    given: flags.wall ?? null,
    prompt: 'what one agent run may take, like 30m or 2h',
    current: limits.wall,
    validate: async (answer) => {
      try {
        return parseDuration(answer) > 0 ? null : 'must be a positive duration, like 30m'
      } catch {
        return 'that is not a duration like 30s, 15m or 2h'
      }
    },
  })
  if ('refused' in wall) return wall

  const budget = await question(world, {
    name: 'the spend ceiling',
    flag: '--budget <dollars>|none',
    given: flags.budget ?? null,
    prompt: 'a dollar ceiling per agent run, like $5, or "none" for no ceiling',
    current: limits.usd === undefined ? 'none' : String(limits.usd),
    show: (value) => (value === 'none' ? 'none' : `$${Number(value).toFixed(2)}`),
    validate: async (answer) => {
      const parsed = parseBudget(answer)
      return typeof parsed === 'string' ? parsed : null
    },
  })
  if ('refused' in budget) return budget

  const roundsValue = Number(rounds.answer)
  const usdValue =
    budget.answer.trim().toLowerCase() === 'none' ? null : Number(budget.answer.trim().replace(/^\$/, ''))

  const changes = [
    ...(roundsValue === limits.rounds ? [] : [roundsChange(roundsValue)]),
    ...(wall.answer === limits.wall ? [] : [wallChange(wall.answer)]),
    ...((usdValue ?? null) === (limits.usd ?? null) ? [] : [budgetChange(usdValue)]),
  ]
  await setRecipe(project, changes, options)

  const finalLimits = {
    ...limits,
    rounds: roundsValue,
    wall: wall.answer,
    usd: usdValue ?? undefined,
  }
  world.log(
    paint.muted(`  ${'a pass'.padEnd(9)} ${passCeiling({ ...finalLimits, wallMs: parseDuration(finalLimits.wall) })}`),
  )
  if (file.agent !== 'claude-code' && finalLimits.usd !== undefined) {
    world.log(
      paint.muted(
        `${file.agent} cannot hold a dollar ceiling on one run — runtime.limits.usd is written, and reported absent at that runtime (#370)`,
      ),
    )
  }
  return { ok: true }
}
