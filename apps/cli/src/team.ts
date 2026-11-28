/**
 * The questions `lingtai add` and `init --local` ask about **who works on the
 * repository** (0130 §1–3): solo or team, in team mode the GitHub login when
 * this machine cannot know it, and the personal branch.
 *
 * Nothing here writes: each returns an answer, and the caller decides what it
 * means to write and when. The branch-name check is `personalBranchRefusal` in
 * `@lingtai/setup` — over the pure copy of git's rules in `@lingtai/recipe` — and never a git process:
 * `git check-ref-format --branch` expands `@{-1}` inside a repository and
 * exits 0 with another name.
 */
import { loginRefusal, personalBranchRefusal } from '@lingtai/setup'
import { Effect } from 'effect'

import { questionEffect, type QuestionWorld } from './question.ts'

export type Mode = 'team' | 'solo'

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
  input: { given: string | null; kept: string; current?: Mode | null },
): Effect.Effect<{ mode: Mode } | { refused: string }, unknown> =>
  questionEffect(world, {
    name: 'the mode',
    flag: '--mode team|solo',
    given: input.given,
    prompt: 'Does anyone else work on this repository?',
    choices: ['team', 'solo'],
    offerLabels: MODE_LABELS,
    fallback: 'team',
    ...(input.current == null ? {} : { current: input.current }),
    why: TEAM_GRAPH,
    kept: input.kept,
  }).pipe(Effect.map((a) => ('refused' in a ? a : { mode: a.answer as Mode })))

/** *your GitHub login* — asked only where nothing on this machine knows it. */
export const askLogin = (
  world: QuestionWorld,
  input: { given: string | null; kept: string; current?: string | null },
): Effect.Effect<{ login: string } | { refused: string }, unknown> =>
  questionEffect(world, {
    name: 'your GitHub login',
    flag: '--login <login>',
    given: input.given,
    prompt: 'your GitHub login — issues assigned to it are the ones taken',
    ...(input.current == null ? {} : { current: input.current }),
    validate: (answer) => Effect.succeed(loginRefusal(answer)),
    kept: input.kept,
  }).pipe(Effect.map((a) => ('refused' in a ? a : { login: a.answer })))

/** The personal branch's name, defaulting to `fallback` and checked before anything is made. */
export const askPersonal = (
  world: QuestionWorld,
  input: {
    given: string | null
    fallback: string
    main: string
    kept: string
    /** The recipe's own working branch, on a rerun: it is the default before `fallback` is. */
    current?: string | null
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
    ...(input.current == null ? {} : { current: input.current }),
    validate: (answer) => {
      const refusal = personalBranchRefusal(answer, input.main, input.fallback)
      if (refusal !== null) return Effect.succeed(refusal)
      return input.validate === undefined ? Effect.succeed(null) : input.validate(answer)
    },
    kept: input.kept,
  }).pipe(Effect.map((a) => ('refused' in a ? a : { personal: a.answer })))

/** The branch this project's recipe governs and merges into — a solo project's base. */
export const askBaseBranch = (
  world: QuestionWorld,
  input: {
    given: string | null
    current: string | null
    detected: string | null
    fallback?: string | undefined
    validate: (answer: string) => Effect.Effect<string | null, unknown>
    kept: string
    startOver?: string | undefined
    command?: string | undefined
  },
): Effect.Effect<{ answer: string } | { refused: string }, unknown> =>
  questionEffect(world, {
    name: 'the base branch',
    flag: '--main <branch>',
    given: input.given,
    prompt: "the branch this project's recipe governs and merges into",
    current: input.current,
    detected: input.detected,
    ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
    kept: input.kept,
    ...(input.startOver === undefined ? {} : { startOver: input.startOver }),
    ...(input.command === undefined ? {} : { command: input.command }),
    validate: input.validate,
  })

/**
 * Whether to make the personal branch that is not there yet, and from what. On GitHub it is cut from `origin/<from>`
 * and pushed; in a checkout it is cut from `from` there. A `no` is the caller's to refuse with.
 */
export const askMakeBranch = (
  world: QuestionWorld,
  input: {
    name: string
    from: string
    where: { github: true } | { checkout: string }
    given: string | null
    kept: string
  },
): Effect.Effect<{ answer: string } | { refused: string }, unknown> =>
  questionEffect(world, {
    name: 'making the personal branch',
    flag:
      'github' in input.where
        ? `--defaults, or make it yourself: git push origin origin/${input.from}:refs/heads/${input.name}`
        : `--defaults, or make it yourself: git branch ${input.name} ${input.from}`,
    given: input.given,
    prompt:
      'github' in input.where
        ? `${input.name} does not exist. Make it from origin/${input.from} and push it?`
        : `${input.name} does not exist in ${input.where.checkout}. Make it from ${input.from}?`,
    choices: ['yes', 'no'],
    fallback: 'yes',
    kept: input.kept,
  })
