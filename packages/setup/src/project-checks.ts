/**
 * The checks a project question makes, each once (ADR 0125 §1): a function from
 * an answer — and the port it needs — to `null` or the sentence that refuses it.
 *
 * `lingtai add` and `init` call these from their `ask*` questions, and the
 * project list's descriptors call them too, so a run with no terminal refuses in
 * the same words. The wording is moved, never rewritten: the cli tests pin it.
 * Pure except `branchOnGithubRefusal`, whose port is a parameter.
 */
import { branchNameRefusal, isBuiltInJudge } from '@lingtai/recipe'
import { parseDuration } from '@lingtai/recipe/duration'
import { Effect } from 'effect'

import { remedyFor, runtimeStateSentence, type RuntimeFound } from './runtimes.ts'
import { GITHUB_LOGIN } from './setup-answers.ts'

/** `--rounds` became two bounds (0108 §8); every guard that would refuse it generically says this instead. */
export const ROUNDS_RETIRED =
  '--rounds is gone: it was two bounds, so write --refusal-fixes <n> (fixes after a build or review ' +
  'refusal) and --conflict-resolutions <n> (merge conflict resolutions), 0108 §8'

/** Why a project with work items in the log cannot change its ticket source. */
export const DIFFERENT_SOURCE_CLASH = 'a different source would number its own tickets into those same streams'

/** The phrasing `init.ts`'s look lines already use for a runtime that cannot run. */
export function whyMissing(r: RuntimeFound): string {
  return runtimeStateSentence(r.id, r.state, r.detail)
}

/**
 * Nothing signed in at all — shared with `first-project.ts`'s own pre-write
 * check (#431), so the two name the same gap the same way rather than two
 * sentences that drift.
 */
export function noRuntimesSignedInRefusal(runtimes: readonly RuntimeFound[]): string {
  return (
    `no agent runtime is signed in on this machine — ${runtimes.map(whyMissing).join('; ')}. ` +
    `${[...new Set(runtimes.map((r) => remedyFor(r.state)))].join(', or ')}, and try again; ` +
    'whether it is paid for is between you and its provider'
  )
}

/**
 * Why `answer` is not a runtime this write may name, or null. `signedIn` is the
 * offered list, in the order it is shown. The recipe's own runtime (`kept`) is
 * accepted whether or not it is signed in: a rerun that takes every default keeps
 * it (#1473). `orNone` is the reviewer's: `none` is an answer, and every refusal
 * says so.
 */
export function runtimeRefusal(
  answer: string,
  at: {
    signedIn: readonly string[]
    runtimes: readonly RuntimeFound[]
    kept: string | null
    orNone?: boolean
  },
): string | null {
  if (at.orNone === true && answer === 'none') return null
  if (at.signedIn.includes(answer)) return null
  if (at.kept !== null && answer === at.kept) return null
  const choiceList = at.signedIn.join(', ')
  const extra = at.orNone === true ? ', or none' : ''
  if (answer === '') return `no agent is chosen yet — choose one of ${choiceList}${extra}`
  const found = at.runtimes.find((r) => r.id === answer)
  if (!found) return `${answer} is not a runtime — choose one of ${choiceList}${extra}`
  return `${whyMissing(found)} — ${remedyFor(found.state)}, or choose one of ${choiceList}${extra}`
}

/**
 * Every `agent:` or runtime `judge:` action a write does not itself touch,
 * logged when its own runtime is still signed in and refused when it is not.
 *
 * `agentRefusal` (`conduct.ts:282`) reads every step's every action against
 * what is signed in — not only `steps.implement`'s and `steps.review`'s first
 * entry — so a second `agent:` left in `steps.implement`, or a runtime `judge:`
 * at `steps.proposed`, fails the very next pass. `fullyReplaced` names a step
 * whose whole list this write is about to overwrite, and `editedInPlace` names
 * the one action within a step this write edits where it stands. `keptRuntimes`
 * are signed-out runtimes the recipe already names and this write keeps (#1473).
 *
 * `log` holds the lines from before the first refusal, in the order they occur:
 * the caller prints them all and then returns the refusal.
 */
export function leftoverRefusal(
  steps: unknown,
  signedIn: readonly string[],
  editedInPlace: readonly { step: string; index: number }[],
  fullyReplaced: ReadonlySet<string>,
  keptRuntimes: ReadonlySet<string> = new Set(),
): { refused: string | null; log: string[] } {
  const log: string[] = []
  if (steps === null || typeof steps !== 'object') return { refused: null, log }
  for (const [step, list] of Object.entries(steps as Record<string, unknown>)) {
    if (fullyReplaced.has(step) || !Array.isArray(list)) continue
    for (let i = 0; i < list.length; i++) {
      if (editedInPlace.some((e) => e.step === step && e.index === i)) continue
      const item = list[i]
      if (item === null || typeof item !== 'object') continue
      const action = item as Record<string, unknown>
      const key: 'agent' | 'judge' | null =
        typeof action['agent'] === 'string'
          ? 'agent'
          : typeof action['judge'] === 'string' && !isBuiltInJudge(action['judge'])
            ? 'judge'
            : null
      if (key === null) continue
      const name = action[key] as string
      const actionName = typeof action['name'] === 'string' ? (action['name'] as string) : `steps.${step}[${i}]`
      if (signedIn.includes(name)) {
        log.push(
          `steps.${step}'s "${actionName}" also names ${key} ${name} — only the first agent: entry is asked ` +
            'about here, so this one is left as written',
        )
        continue
      }
      if (keptRuntimes.has(name)) {
        log.push(
          `steps.${step}'s "${actionName}" also names ${key} ${name}, which is not signed in here — it is the ` +
            "recipe's own, kept as written",
        )
        continue
      }
      return {
        refused:
          `steps.${step}'s "${actionName}" also names ${key} ${name}, which is not signed in here — only the ` +
          'first agent: entry is asked about here, so fix or remove that one by hand and run lingtai add again. ' +
          'Nothing was written',
        log,
      }
    }
  }
  return { refused: null, log }
}

/** Why `answer` is not a GitHub login (the shape: `GITHUB_LOGIN`), or null. */
export function loginRefusal(answer: string): string | null {
  return GITHUB_LOGIN.test(answer) ? null : `${answer} is not a GitHub login (letters, digits and single -)`
}

/** What a person's near miss becomes: git-safe characters only, or `fallback` where nothing sensible is left. */
export function madeSafe(answer: string, fallback: string): string {
  const candidate = answer
    .trim()
    .replace(/[^A-Za-z0-9/_.-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/.]+|[/.]+$/g, '')
  return candidate === '' || branchNameRefusal(candidate) !== null ? fallback : candidate
}

/**
 * Why `name` cannot be the personal branch, or null, in the words `lingtai add`
 * uses. `main` is compared ignoring case, as `refuseOnMeaning` does when the
 * recipe resolves. (`personalRefusal` is the board's own wording of the same
 * check; the two are not joined here.)
 */
export function personalBranchRefusal(name: string, main: string, fallback: string): string | null {
  const why = branchNameRefusal(name)
  if (why !== null) {
    const safe = madeSafe(name, fallback)
    return `git refuses ${JSON.stringify(name)}: it ${why} — use ${safe}?`
  }
  if (name.toLowerCase() === main.toLowerCase()) {
    return `${name} is the same branch as ${main}, ignoring case — name a different one for your own work`
  }
  return null
}

/** A landing branch is a name, or `hold`. */
export function landingBranchRefusal(answer: string): string | null {
  return answer.trim() === '' ? 'needs a branch name, or "hold"' : null
}

/** A count of fixes or resolutions: digits only, so 0 is a legal answer. */
export function wholeNumberRefusal(answer: string): string | null {
  return /^\d+$/.test(answer) ? null : 'that is not a whole number 0 or greater'
}

/** What one agent run may take, over `parseDuration`. */
export function wallRefusal(answer: string): string | null {
  try {
    return parseDuration(answer) > 0 ? null : 'must be a positive duration, like 30m'
  } catch {
    return 'that is not a duration like 30s, 15m or 2h'
  }
}

/** `--budget`'s "none", parsed the way the question accepts `5`, `5.00` and `$5`: the ceiling, null for none, or the refusal. */
export function parseBudget(answer: string): number | null | string {
  if (answer.trim().toLowerCase() === 'none') return null
  const n = Number(answer.trim().replace(/^\$/, ''))
  if (!Number.isFinite(n) || n <= 0) {
    return 'that is not a dollar amount — write a positive number like 5 or 5.00, or "none" for no ceiling'
  }
  return n
}

/** The install command is a command, or `none`. */
export function installRefusal(answer: string): string | null {
  return answer === '' ? 'type a command, or none' : null
}

/**
 * Whether `answer` is a branch on GitHub, or the sentence that says it is not.
 * `detected` is what GitHub or the recipe already named: only a different
 * answer is looked up. A read that fails is a refusal, never an absent value.
 */
export function branchOnGithubRefusal(
  answer: string,
  detected: string | null,
  branchExists: (name: string) => Effect.Effect<boolean | 'unreadable'>,
): Effect.Effect<string | null> {
  if (answer === detected) return Effect.succeed(null)
  return Effect.map(branchExists(answer), (exists) =>
    exists === 'unreadable'
      ? `could not read whether ${answer} exists on GitHub`
      : exists
        ? null
        : `${answer} is not a branch on GitHub`,
  )
}

/**
 * Why a project with work items in the log cannot take `--tickets <given>`, or
 * null: nothing in the log, no flag, or the flag names the source it has.
 */
export function sourceClashRefusal(at: {
  given: string | null
  project: string
  history: readonly string[]
  current: string
  kept: string
}): string | null {
  if (at.history.length === 0 || at.given === null || at.given === at.current) return null
  return (
    `--tickets ${at.given}, but ${at.project} already has work items in the log (${at.history.join(', ')}), ` +
    `numbered under source.tickets: ${at.current} — ${DIFFERENT_SOURCE_CLASH}. Leave out --tickets, or remove the project first. ${at.kept}`
  )
}
