/**
 * Which agent writes a project's change, and which cold-reviews it — both
 * per-project recipe questions since `cb241ca` (#398), asked through #392's
 * seam (`question.ts`) and written with #395's `setRecipe`.
 *
 * This file imports nothing from `init.ts` (#392's rule): `add` is this
 * module's other caller, and pulling in `board.ts` and the schema code for a
 * question `add` has no business asking about would be the thing #392 kept
 * out. `RuntimeFound` lives in `runtimes.ts` for the same reason.
 *
 * **It writes nothing itself.** `askAgents` returns `{ changes, modelChanges }`,
 * both the same `RecipeChange[]` shape `setRecipe` takes — the caller decides
 * when to write them, except the split itself is not the caller's to merge
 * back into one call: `changes` sets an existing action's `agent:` (or
 * creates the action outright), `modelChanges` sets that same action's
 * `model:` afterwards, in a second `setRecipe` call. Both land on
 * `steps.implement.<i>` or `steps.review.<i>` when an action already carries
 * `agent:`.
 *
 * **A caller writing `steps.*` for the first time widens a preset's steps
 * into the file** (`write.ts`'s `widenStepsIfNeeded`). Showing that to a
 * person is the caller's line to print, not this module's.
 */
import { everyRuntime } from '@lingtai/agent'
import { RuntimeId } from '@lingtai/domain'
import type { RecipeDraft } from '@lingtai/project'
import type { RecipeChange } from '@lingtai/recipe'
import { followedJudgeIndex, followWriterJudgeChanges, unboundedTurnsChange } from '@lingtai/recipe'
import {
  defaultAgents,
  leftoverRefusal,
  noRuntimesSignedInRefusal,
  offeredRuntimes,
  runtimeRefusal,
  whyMissing,
  type RuntimeFound,
  type RuntimeName,
} from '@lingtai/setup'
import { Effect } from 'effect'

import { questionEffect, type Answered, type QuestionWorld } from './question.ts'

function asRuntime(value: unknown): RuntimeName | null {
  if (typeof value !== 'string') return null
  const parsed = RuntimeId.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The first list item that names an `agent:`, and where it stands — or null. */
function findAgentAction(list: unknown): { index: number; action: Record<string, unknown> } | null {
  if (!Array.isArray(list)) return null
  const index = list.findIndex((item) => item !== null && typeof item === 'object' && 'agent' in (item as object))
  return index === -1 ? null : { index, action: list[index] as Record<string, unknown> }
}

export interface AskAgentsAt {
  project: string
  /** `init.ts`'s `runtimes` probe result — this function never probes on its own. */
  runtimes: readonly RuntimeFound[]
  flags: { agent?: string; model?: string; reviewer?: string; reviewerModel?: string }
  home?: string
  /** The recipe the answers so far have drafted. */
  draft: RecipeDraft
  /** `question.ts`'s `kept` — what a refusal below says is already written. */
  kept?: string
}

/**
 * Asks which agent writes the change, on which model, whether a cold
 * reviewer reads it and which agent, and that reviewer's model — in that
 * order, each through #392's `question()`.
 *
 * A runtime this machine is not signed in to is not offered as a new choice:
 * every one that is missing is logged, with why, before the first question,
 * and naming it anyway — by flag or by hand at a terminal — is refused with
 * the same reason. The one exception is the recipe's own writer or reviewer
 * (#1473): it stays the default, is accepted as the answer that keeps it, and
 * an action left beside it that names the same runtime is not refused either,
 * so a successful result does not mean every runtime it kept is signed in.
 * Nothing signed in at all is refused before any question.
 */
/**
 * The two control rows of a model select. Their values start with a NUL, which
 * no model name carries, so a model that is spelled like the words shown for
 * them is still a model; the words are the labels.
 */
export const RUNTIME_DEFAULT = '\u0000runtime-default'
export const ANOTHER = '\u0000another'
const MODEL_LABELS: Readonly<Record<string, string>> = {
  [RUNTIME_DEFAULT]: "the runtime's own default",
  [ANOTHER]: 'another — type its name',
}

/**
 * A model is a choice: the runtime's own default (written as no `model:`), the
 * one the recipe already names, or another, which asks for its name. A flag
 * answers as it is, `''` included, and never reaches the choice.
 */
export const askModel = Effect.fn('agents.askModel')(function* (
  world: QuestionWorld,
  q: {
    name: string
    flag: string
    given: string | null
    prompt: string
    current: string | null
    kept?: string | undefined
    validate?: (answer: string) => Effect.Effect<string | null, unknown>
  },
): Effect.fn.Return<Answered, unknown> {
  if (q.given !== null) return yield* questionEffect(world, q)
  // The offer's own words (the runtime's default, *another*) are not model names: `validate` judges what is typed.
  const { validate, ...asked } = q
  const picked = yield* questionEffect(world, {
    ...asked,
    offer: [RUNTIME_DEFAULT, ...(q.current === null ? [] : [q.current]), ANOTHER],
    offerLabels: MODEL_LABELS,
    show: (value) => MODEL_LABELS[value] ?? value,
    fallback: RUNTIME_DEFAULT,
  })
  if ('refused' in picked) return picked
  if (picked.answer === RUNTIME_DEFAULT) return { answer: '' }
  if (picked.answer !== ANOTHER) return picked
  return yield* questionEffect(world, {
    name: q.name,
    flag: q.flag,
    given: null,
    prompt: 'which model — its name',
    validate: (a) =>
      a === ''
        ? Effect.succeed("a model needs a name — or choose the runtime's own default")
        : validate === undefined
          ? Effect.succeed(null)
          : validate(a),
    kept: q.kept,
  })
})

/** What a question here is validated by: null accepts, a string is why not. */
type Validate = (answer: string) => Effect.Effect<string | null, unknown>

/**
 * Which agent writes the change. `offered` is `offeredRuntimes`' answer — what is signed in and can be proposed — and
 * is what the words list; the select shows it in the enum's own order (#313, doc/design/398.md:43), with the recipe's
 * own writer beside it where that is not signed in.
 */
export function askWriter(
  world: QuestionWorld,
  at: {
    given: string | null
    offered: readonly RuntimeName[]
    current: RuntimeName | null
    fallback?: string | undefined
    detected: string | null
    validate: Validate
    kept?: string | undefined
  },
): Effect.Effect<Answered, unknown> {
  const choiceList = at.offered.join(', ')
  const offer = RuntimeId.options.filter((id) => at.offered.includes(id))
  return questionEffect(world, {
    name: 'which agent writes the change',
    flag: `--agent <${choiceList}>`,
    given: at.given,
    prompt: `which agent writes the change (${choiceList})`,
    offer: at.current !== null && !offer.includes(at.current) ? [...offer, at.current] : offer,
    current: at.current,
    ...(at.fallback === undefined ? {} : { fallback: at.fallback }),
    detected: at.detected,
    validate: at.validate,
    kept: at.kept,
  })
}

/** Whether a cold reviewer reads the change, and which agent: an offered runtime, or `none`. */
export function askReviewer(
  world: QuestionWorld,
  at: {
    given: string | null
    offered: readonly RuntimeName[]
    current: string | null
    fallback?: string | undefined
    detected: string | null
    validate: Validate
    kept?: string | undefined
  },
): Effect.Effect<Answered, unknown> {
  const choiceList = at.offered.join(', ')
  const offer: string[] = RuntimeId.options.filter((id) => at.offered.includes(id))
  return questionEffect(world, {
    name: 'a cold reviewer',
    flag: `--reviewer <${choiceList}|none>`,
    given: at.given,
    prompt: `does a cold reviewer read it, and which agent (${choiceList}, or none)`,
    offer: [
      ...offer,
      ...(at.current !== null && at.current !== 'none' && !offer.includes(at.current) ? [at.current] : []),
      'none',
    ],
    current: at.current,
    ...(at.fallback === undefined ? {} : { fallback: at.fallback }),
    detected: at.detected,
    validate: at.validate,
    kept: at.kept,
  })
}

/** Which model the writer runs on. */
export function askWriterModel(
  world: QuestionWorld,
  at: { given: string | null; current: string | null; kept?: string | undefined; validate?: Validate },
): Effect.Effect<Answered, unknown> {
  return askModel(world, {
    name: 'which model the writer runs on',
    flag: "--model <name>, or --model ''",
    given: at.given,
    prompt: 'which model',
    current: at.current,
    kept: at.kept,
    ...(at.validate === undefined ? {} : { validate: at.validate }),
  })
}

/** Which model the reviewer runs on. */
export function askReviewerModel(
  world: QuestionWorld,
  at: { given: string | null; current: string | null; kept?: string | undefined; validate?: Validate },
): Effect.Effect<Answered, unknown> {
  return askModel(world, {
    name: "the reviewer's model",
    flag: "--reviewer-model <name>, or --reviewer-model ''",
    given: at.given,
    prompt: 'on which model',
    current: at.current,
    kept: at.kept,
    ...(at.validate === undefined ? {} : { validate: at.validate }),
  })
}

export const askAgents = Effect.fn('agents.askAgents')(function* (
  world: QuestionWorld,
  at: AskAgentsAt,
): Effect.fn.Return<{ changes: RecipeChange[]; modelChanges: RecipeChange[] } | { refused: string }, unknown> {
  // Not an agent that runs only at `implement` (#1298): the wizard proposes none, so it offers none.
  const signedInIds: string[] = offeredRuntimes(at.runtimes)
  for (const r of at.runtimes) {
    if (!r.signedIn) world.log(whyMissing(r))
  }
  if (signedInIds.length === 0) {
    return { refused: noRuntimesSignedInRefusal(at.runtimes) }
  }

  // The recipe's own runtime is accepted as an answer whether or not it is signed in: a rerun that takes
  // every default keeps it (#1473), and any other signed-out runtime is still refused.
  const refuse =
    (kept: string | null, orNone = false) =>
    (answer: string): Effect.Effect<string | null> =>
      Effect.succeed(runtimeRefusal(answer, { signedIn: signedInIds, runtimes: at.runtimes, kept, orNone }))

  const implementAction = findAgentAction(at.draft.get(['steps', 'implement']))
  const reviewList = at.draft.get(['steps', 'review'])
  const reviewAction = findAgentAction(reviewList)

  const writingAgent = asRuntime(
    implementAction && typeof implementAction.action['agent'] === 'string'
      ? implementAction.action['agent']
      : at.draft.get(['runtime', 'agent']),
  )
  // The recipe's own value, signed in or not: the `whyMissing` line above says when it is not.
  const currentAgent = writingAgent

  const agentAnswer = yield* askWriter(world, {
    given: at.flags.agent ?? null,
    offered: offeredRuntimes(at.runtimes),
    current: currentAgent,
    detected: defaultAgents(signedInIds).writer,
    validate: refuse(currentAgent),
    kept: at.kept,
  })
  if ('refused' in agentAnswer) return agentAnswer
  const writer = agentAnswer.answer as RuntimeName

  // A model belongs to the agent it was written beside: offer it back only
  // when the writer answer kept that same agent, never carried onto another
  // one the operator just switched to.
  const currentModel =
    implementAction && writer === currentAgent && typeof implementAction.action['model'] === 'string'
      ? (implementAction.action['model'] as string)
      : null

  const modelAnswer = yield* askWriterModel(world, {
    given: at.flags.model ?? null,
    current: currentModel,
    kept: at.kept,
  })
  if ('refused' in modelAnswer) return modelAnswer
  const writerModel = modelAnswer.answer

  // A different model, with no table of models anywhere in Lingtai, means a
  // different runtime (doc/design/398.md §1): with two signed in, the other
  // one; with one, there is nothing different *known* to be available.
  const otherSignedIn = signedInIds.filter((id) => id !== writer)
  const defaultReviewer = otherSignedIn[0] ?? writer // = defaultAgents(...).reviewer for the default writer

  const rawReviewer =
    reviewAction && typeof reviewAction.action['agent'] === 'string' ? (reviewAction.action['agent'] as string) : null
  // The recipe's own reviewer is the default whether or not it is signed in (#1473), as the writer's is.
  const currentReviewer =
    rawReviewer !== null ? asRuntime(rawReviewer) : Array.isArray(reviewList) && reviewList.length === 0 ? 'none' : null

  const reviewerAnswer = yield* askReviewer(world, {
    given: at.flags.reviewer ?? null,
    offered: offeredRuntimes(at.runtimes),
    current: currentReviewer,
    detected: defaultReviewer,
    validate: refuse(currentReviewer, true),
    kept: at.kept,
  })
  if ('refused' in reviewerAnswer) return reviewerAnswer
  const reviewer = reviewerAnswer.answer

  // The question asks nothing when no reviewer is chosen — but a flag beside
  // `none` is still a flag, never silently ignored (#391).
  if (reviewer === 'none' && at.flags.reviewerModel !== undefined) {
    return {
      refused:
        "--reviewer-model names a model for a reviewer --reviewer none says there isn't one. " + 'Nothing was written',
    }
  }

  // Only the first `agent:` entry in `steps.implement` and in `steps.review`
  // is ever rewritten below — the one `question()` above asked about in each —
  // and, since #1519, the findings judge init itself wrote at `steps.proposed`:
  // the first `findings` judge (the only one `judgeDeclaredAt` reads) when it
  // names the recipe's writer. It follows the writer instead of being a leftover.
  // Every other action, in either step or in any other, is left exactly as
  // written when its own step's list is not being replaced wholesale —
  // `leftoverRefusal` is what checks that is still safe to leave.
  const editedInPlace: { step: string; index: number }[] = []
  const fullyReplaced = new Set<string>()
  if (implementAction) editedInPlace.push({ step: 'implement', index: implementAction.index })
  else fullyReplaced.add('implement')
  if (reviewer === 'none') fullyReplaced.add('review')
  else if (reviewAction) editedInPlace.push({ step: 'review', index: reviewAction.index })
  else fullyReplaced.add('review')

  // A rerun's findings judge follows the writer (#1523): the first one, when it names the recipe's writer, is
  // edited or removed by `followWriterJudgeChanges` below and so is not a leftover. A new recipe's judge is
  // written after its landing (`recipe-flow.ts`), so its hold stays first.
  const proposedNow = at.draft.get(['steps', 'proposed'])
  const rerun = at.draft.text() !== null
  const followedAt = rerun ? followedJudgeIndex(Array.isArray(proposedNow) ? proposedNow : null, writingAgent) : null
  if (followedAt !== null) editedInPlace.push({ step: 'proposed', index: followedAt })

  const keptRuntimes = new Set<string>()
  if (writingAgent !== null && writer === writingAgent) keptRuntimes.add(writingAgent)
  if (currentReviewer !== null && currentReviewer !== 'none' && reviewer === currentReviewer) {
    keptRuntimes.add(currentReviewer)
  }
  const leftover = leftoverRefusal(at.draft.get(['steps']), signedInIds, editedInPlace, fullyReplaced, keptRuntimes)
  for (const line of leftover.log) world.log(line)
  if (leftover.refused !== null) return { refused: leftover.refused }

  let reviewerModel = ''
  if (reviewer !== 'none') {
    if (otherSignedIn.length === 0) {
      world.log("the reviewer runs the writer's runtime, on its own default model, unless a model is named here")
    }
    const currentReviewerModel =
      reviewAction && reviewer === currentReviewer && typeof reviewAction.action['model'] === 'string'
        ? (reviewAction.action['model'] as string)
        : null
    const reviewerModelAnswer = yield* askReviewerModel(world, {
      given: at.flags.reviewerModel ?? null,
      current: currentReviewerModel,
      kept: at.kept,
    })
    if ('refused' in reviewerModelAnswer) return reviewerModelAnswer
    reviewerModel = reviewerModelAnswer.answer
  }

  // `runtime.agent` is the pass's own runtime, resolved unconditionally
  // (`resolveAgent`, `packages/recipe/src/local.ts`) even where every step
  // names its own `agent:`, so it is written whenever the writer changes and
  // whenever it is absent — the refusal the ticket's Watch out names. A rerun
  // that kept the writer leaves a `runtime.agent` somebody set by hand alone.
  // Only where the answer is not the recipe's own writer, or `runtime.agent` is absent: a hand-edited
  // `runtime.agent` beside an unchanged `steps.implement` writer is a separate setting, kept (#1473).
  const changes: RecipeChange[] = []
  if (writer !== writingAgent || at.draft.get(['runtime', 'agent']) === null) {
    changes.push({ path: ['runtime', 'agent'], value: writer })
  }
  if (rerun)
    changes.push(...followWriterJudgeChanges(writingAgent, writer, Array.isArray(proposedNow) ? proposedNow : null))
  // A runtime that cannot hold a turn count (#547) is not asked to promise one:
  // the schema's default of 300 is nobody's choice, and doctor would fail it
  // for ever. Decided from `enforces` and not from the runtime's name, and only
  // where the file does not already declare `turns` — a number somebody wrote
  // stays a number, and stays red.
  const writerCapabilities = everyRuntime().find((r) => r.capabilities.id === writer)?.capabilities
  if (
    writerCapabilities !== undefined &&
    !writerCapabilities.enforces.includes('turns') &&
    at.draft.get(['runtime', 'limits', 'run', 'turns']) === null &&
    // On an existing file only a writer that changed adds it: a rerun that takes every default writes nothing.
    writer !== writingAgent
  ) {
    changes.push(unboundedTurnsChange())
  }
  const modelChanges: RecipeChange[] = []

  if (implementAction) {
    changes.push({ path: ['steps', 'implement', implementAction.index, 'agent'], value: writer })
    modelChanges.push({
      path: ['steps', 'implement', implementAction.index, 'model'],
      value: writerModel === '' ? undefined : writerModel,
    })
  } else {
    const action: Record<string, unknown> = { name: 'write the change', agent: writer, prompt: '' }
    if (writerModel !== '') action['model'] = writerModel
    changes.push({ path: ['steps', 'implement'], value: [action] })
  }

  if (reviewer === 'none') {
    changes.push({ path: ['steps', 'review'], value: [] })
  } else if (reviewAction) {
    changes.push({ path: ['steps', 'review', reviewAction.index, 'agent'], value: reviewer })
    modelChanges.push({
      path: ['steps', 'review', reviewAction.index, 'model'],
      value: reviewerModel === '' ? undefined : reviewerModel,
    })
  } else {
    const action: Record<string, unknown> = { name: 'review', agent: reviewer, prompt: '' }
    if (reviewerModel !== '') action['model'] = reviewerModel
    changes.push({ path: ['steps', 'review'], value: [action] })
  }

  return { changes, modelChanges }
})
