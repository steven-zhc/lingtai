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
 * **It writes nothing itself.** `askAgents` returns `{ changes }`, the same
 * `RecipeChange[]` shape `setRecipe` takes — the caller decides when to write
 * them, and whether that is one `setRecipe` call or one per question (see
 * `emit.ts`'s `CommentWouldBeLostError`, which only a caller writing two
 * fields of one commented action in the same call can hit).
 *
 * **A caller writing `steps.*` for the first time widens a preset's steps
 * into the file** (`write.ts`'s `widenStepsIfNeeded`). Showing that to a
 * person is the caller's line to print, not this module's.
 */
import { RuntimeId } from '@lingtai/domain'
import type { RecipeChange, RecipeFiles } from '@lingtai/recipe'
import { readRecipeKey } from '@lingtai/recipe'

import { question, type QuestionWorld } from './question.ts'
import type { RuntimeFound, RuntimeName } from './runtimes.ts'

/** The phrasing `init.ts`'s look lines already use for a runtime that cannot run. */
function whyMissing(r: RuntimeFound): string {
  return r.installed ? `${r.id} is installed and not signed in (${r.detail})` : `${r.id} is not installed`
}

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
  files?: RecipeFiles
}

/**
 * Asks which agent writes the change, on which model, whether a cold
 * reviewer reads it and which agent, and that reviewer's model — in that
 * order, each through #392's `question()`.
 *
 * A runtime this machine is not signed in to is never offered: every one
 * that is missing is logged, with why, before the first question, and
 * naming it anyway — by flag or by hand at a terminal — is refused with the
 * same reason. Nothing signed in at all is refused before any question.
 */
export async function askAgents(
  world: QuestionWorld,
  at: AskAgentsAt,
): Promise<{ changes: RecipeChange[] } | { refused: string }> {
  const signedIn = at.runtimes.filter((r) => r.signedIn)
  const signedInIds: string[] = signedIn.map((r) => r.id)
  for (const r of at.runtimes) {
    if (!r.signedIn) world.log(whyMissing(r))
  }
  if (signedInIds.length === 0) {
    return {
      refused:
        `no agent runtime is signed in on this machine — ${at.runtimes.map(whyMissing).join('; ')}. ` +
        'Sign in to one and try again; whether it is paid for is between you and its provider',
    }
  }

  const choiceList = signedInIds.join(', ')
  const refuseUnlessOffered =
    (extra = '') =>
    async (answer: string): Promise<string | null> => {
      if (signedInIds.includes(answer)) return null
      const found = at.runtimes.find((r) => r.id === answer)
      const why = found ? whyMissing(found) : `${answer} is not a runtime`
      return `${why} — sign in to it, or choose one of ${choiceList}${extra}`
    }

  const readOpts = { home: at.home, files: at.files }
  const implementAction = findAgentAction(await readRecipeKey(at.project, ['steps', 'implement'], readOpts))
  const reviewList = await readRecipeKey(at.project, ['steps', 'review'], readOpts)
  const reviewAction = findAgentAction(reviewList)

  const writingAgent = asRuntime(
    implementAction && typeof implementAction.action['agent'] === 'string'
      ? implementAction.action['agent']
      : await readRecipeKey(at.project, ['runtime', 'agent'], readOpts),
  )
  const currentAgent = writingAgent !== null && signedInIds.includes(writingAgent) ? writingAgent : null

  const agentAnswer = await question(world, {
    name: 'which agent writes the change',
    flag: `--agent <${choiceList}>`,
    given: at.flags.agent ?? null,
    prompt: `which agent writes the change (${choiceList})`,
    current: currentAgent,
    detected: signedInIds.length === 1 ? signedInIds[0]! : null,
    validate: refuseUnlessOffered(),
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

  const modelAnswer = await question(world, {
    name: 'which model the writer runs on',
    flag: '--model <name>',
    given: at.flags.model ?? null,
    prompt: "which model (empty for the runtime's own default)",
    current: currentModel,
    fallback: '',
  })
  if ('refused' in modelAnswer) return modelAnswer
  const writerModel = modelAnswer.answer

  // A different model, with no table of models anywhere in Lingtai, means a
  // different runtime (doc/design/398.md §1): with two signed in, the other
  // one; with one, there is nothing different *known* to be available.
  const otherSignedIn = signedInIds.filter((id) => id !== writer)
  const defaultReviewer = otherSignedIn[0] ?? writer

  const rawReviewer =
    reviewAction && typeof reviewAction.action['agent'] === 'string' ? (reviewAction.action['agent'] as string) : null
  // A reviewer this machine is signed out of is never offered — same rule as
  // the writer's `currentAgent` — so `defaultReviewer`'s detected value is
  // reached instead of a bracket the answer will only be refused for.
  const currentReviewer =
    rawReviewer !== null
      ? signedInIds.includes(rawReviewer)
        ? rawReviewer
        : null
      : Array.isArray(reviewList) && reviewList.length === 0
        ? 'none'
        : null

  const reviewerAnswer = await question(world, {
    name: 'a cold reviewer',
    flag: `--reviewer <${choiceList}|none>`,
    given: at.flags.reviewer ?? null,
    prompt: `does a cold reviewer read it, and which agent (${choiceList}, or none)`,
    current: currentReviewer,
    detected: defaultReviewer,
    validate: async (answer) => (answer === 'none' ? null : refuseUnlessOffered(', or none')(answer)),
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

  let reviewerModel = ''
  if (reviewer !== 'none') {
    if (otherSignedIn.length === 0) {
      world.log("the reviewer runs the writer's runtime, on its own default model, unless a model is named here")
    }
    const currentReviewerModel =
      reviewAction && reviewer === currentReviewer && typeof reviewAction.action['model'] === 'string'
        ? (reviewAction.action['model'] as string)
        : null
    const reviewerModelAnswer = await question(world, {
      name: "the reviewer's model",
      flag: '--reviewer-model <name>',
      given: at.flags.reviewerModel ?? null,
      prompt: "on which model (empty for the runtime's own default)",
      current: currentReviewerModel,
      fallback: '',
    })
    if ('refused' in reviewerModelAnswer) return reviewerModelAnswer
    reviewerModel = reviewerModelAnswer.answer
  }

  // `runtime.agent` is the pass's own runtime, resolved unconditionally
  // (`resolveAgent`, `packages/recipe/src/local.ts`) even where every step
  // names its own `agent:` — so it is written to the writer every time,
  // never only when the answer changed something. Suppressing it on an
  // enter-press that kept a *step's* own agent (which `currentAgent` may
  // have been read from, not `runtime.agent` itself) is exactly the recipe
  // that leaves `runtime.agent` absent, or stale, with two runtimes signed
  // in — the refusal the ticket's Watch out names.
  const changes: RecipeChange[] = [{ path: ['runtime', 'agent'], value: writer }]

  if (implementAction) {
    changes.push({ path: ['steps', 'implement', implementAction.index, 'agent'], value: writer })
    changes.push({
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
    changes.push({
      path: ['steps', 'review', reviewAction.index, 'model'],
      value: reviewerModel === '' ? undefined : reviewerModel,
    })
  } else {
    const action: Record<string, unknown> = { name: 'review', agent: reviewer, prompt: '' }
    if (reviewerModel !== '') action['model'] = reviewerModel
    changes.push({ path: ['steps', 'review'], value: [action] })
  }

  return { changes }
}
