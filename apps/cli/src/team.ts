/**
 * The questions `lingtai add` and `init --local` ask about **who works on the
 * repository** (0130 §1–3): solo or team, in team mode the GitHub login when
 * this machine cannot know it, and the personal branch.
 *
 * Nothing here writes: each returns an answer, and the caller decides what it
 * means to write and when. The branch-name check is `branchNameRefusal` — the
 * pure copy of git's rules in `@lingtai/recipe` — and never a git process:
 * `git check-ref-format --branch` expands `@{-1}` inside a repository and
 * exits 0 with another name.
 */
import { branchNameRefusal } from '@lingtai/recipe'
import { Effect } from 'effect'

import { questionEffect, type QuestionWorld } from './question.ts'

export type Mode = 'team' | 'solo'

/** A GitHub login: 1–39 alphanumerics and single hyphens, none at either end. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

const MODE_LABELS: Readonly<Record<Mode, string>> = {
  team: 'Team — Lingtai stays on your branch; the team sees your work as a PR you send (recommended)',
  solo: 'Solo — just me: each ticket lands on main by itself',
}

/** The drawing under the question; `liveAsk` hangs each line on clack's gutter. */
const TEAM_GRAPH: readonly string[] = [
  '',
  'main          ─●─────────────────●─   ← you merge the PR',
  '                ╲               ╱',
  'your branch      ●───●───●─────┘    ← Lingtai lands each ticket here',
  '',
  'main only moves through the PR you send.',
]

/** *Does anyone else work on this repository?* — Team first, and the default. */
export const askMode = (
  world: QuestionWorld,
  input: { given: string | null; kept: string },
): Effect.Effect<{ mode: Mode } | { refused: string }, unknown> =>
  questionEffect(world, {
    name: 'the mode',
    flag: '--mode team|solo',
    given: input.given,
    prompt: 'Does anyone else work on this repository?',
    choices: ['team', 'solo'],
    offerLabels: MODE_LABELS,
    fallback: 'team',
    why: TEAM_GRAPH,
    kept: input.kept,
  }).pipe(Effect.map((a) => ('refused' in a ? a : { mode: a.answer as Mode })))

/** *your GitHub login* — asked only where nothing on this machine knows it. */
export const askLogin = (
  world: QuestionWorld,
  input: { given: string | null; kept: string },
): Effect.Effect<{ login: string } | { refused: string }, unknown> =>
  questionEffect(world, {
    name: 'your GitHub login',
    flag: '--login <login>',
    given: input.given,
    prompt: 'your GitHub login — issues assigned to it are the ones taken',
    validate: (answer) =>
      Effect.succeed(
        GITHUB_LOGIN.test(answer) ? null : `${answer} is not a GitHub login (letters, digits and single -)`,
      ),
    kept: input.kept,
  }).pipe(Effect.map((a) => ('refused' in a ? a : { login: a.answer })))

/** What a person's near miss becomes: git-safe characters only, or `fallback` where nothing sensible is left. */
function madeSafe(answer: string, fallback: string): string {
  const candidate = answer
    .trim()
    .replace(/[^A-Za-z0-9/_.-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/.]+|[/.]+$/g, '')
  return candidate === '' || branchNameRefusal(candidate) !== null ? fallback : candidate
}

/**
 * Why `name` cannot be the personal branch, or null. `main` is compared ignoring
 * case, as `refuseOnMeaning` does when the recipe resolves — a refusal here says
 * the same thing in its own words.
 */
export function personalRefusal(name: string, main: string, fallback: string): string | null {
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

/** The personal branch's name, defaulting to `fallback` and checked before anything is made. */
export const askPersonal = (
  world: QuestionWorld,
  input: {
    given: string | null
    fallback: string
    main: string
    kept: string
    /** More to refuse on, for a caller that can read the repository — never creating anything. */
    validate?: (answer: string) => Effect.Effect<string | null, unknown>
  },
): Effect.Effect<{ personal: string } | { refused: string }, unknown> =>
  questionEffect(world, {
    name: 'the personal branch',
    flag: '--personal <branch>',
    given: input.given,
    prompt: 'the branch Lingtai works on, which is yours alone',
    fallback: input.fallback,
    validate: (answer) => {
      const refusal = personalRefusal(answer, input.main, input.fallback)
      if (refusal !== null) return Effect.succeed(refusal)
      return input.validate === undefined ? Effect.succeed(null) : input.validate(answer)
    },
    kept: input.kept,
  }).pipe(Effect.map((a) => ('refused' in a ? a : { personal: a.answer })))
