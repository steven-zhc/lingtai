/**
 * 0120 §1's `Action`, typed by what it `yields`, and `StepOutcome`, a step
 * ending with every action it declared.
 *
 * Zod, not `Data.TaggedEnum`: 0101 §4 keeps `@lingtai/domain`'s only
 * dependency `zod`, and 0101 §1 wants events as zod schemas so a reader can
 * parse what the log actually holds. `_tag` is the discriminant on each
 * result union, matching the other unions here.
 *
 * Types only — nothing calls these yet. #464 puts `StepOutcome` on the log as
 * `StepEnded`.
 *
 * Imports from `vocabulary.ts` rather than from `events.ts`: `vocabulary.ts`
 * explains why a file here cannot import `events.ts` back without an ESM
 * cycle, and #464's `StepEnded` is the same situation this file is a leaf
 * for.
 */
import { z } from 'zod'

import { Finding, RefusalReason, Step } from './vocabulary.ts'

/**
 * A wait's own id, 0118 §6's. Declared here, branded, because nothing else
 * owns it yet.
 */
export const WaitId = z.string().brand<'WaitId'>()
export type WaitId = z.infer<typeof WaitId>

/** A `verdict` action's completed result: what a check or a reviewer found. */
export const Assessment = z.object({
  verdict: z.enum(['accepted', 'refused']),
  findings: z.array(Finding),
})
export type Assessment = z.infer<typeof Assessment>

/** A `design` action's drafted result. Both fields come from the same action (`action.ts:212`). */
export const Design = z.object({
  document: z.string(),
  /** `""` is "no design needed". */
  locator: z.string().optional(),
})
export type Design = z.infer<typeof Design>

/** A `merge` action's completed result: what the lane did with the diff. */
export const Integration = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('Integrated'), mergeSha: z.string() }),
  z.object({
    _tag: z.literal('Conflicted'),
    /**
     * `null` where the action's own result carries none — `actionOf` reaches
     * this off the merge action's `ActionResult.conflict`, which is only set
     * when the real lane refused with one (`#466`). Never `[]`/`''`: an
     * absent field and an empty one are different facts, and `Hold.Routed`'s
     * own fields are `null` for the same reason.
     */
    paths: z.array(z.string()).nullable(),
    baseSha: z.string().nullable(),
    headSha: z.string().nullable(),
  }),
  z.object({
    _tag: z.literal('IntegrationRefused'),
    reason: RefusalReason.exclude(['conflict']),
  }),
])
export type Integration = z.infer<typeof Integration>

/** An account wall, an unmet environment: nothing ran, and it was never going to. */
export const NeverStarted = z.object({
  _tag: z.literal('NeverStarted'),
  scope: z.enum(['conductor', 'work-item']),
})
export type NeverStarted = z.infer<typeof NeverStarted>

/** An earlier action in the step fell short, so this one did not run. */
export const NotReached = z.object({ _tag: z.literal('NotReached') })
export type NotReached = z.infer<typeof NotReached>

/** An agent action stopped mid-run, for one of these four causes. */
export const Interrupted = z.object({
  _tag: z.literal('Interrupted'),
  cause: z.enum(['crash', 'timeout', 'aborted', 'out-of-turns', 'out-of-usd']),
})
export type Interrupted = z.infer<typeof Interrupted>

/** The agent answered, and the machine could not read it. */
export const AnswerUnreadable = z.object({
  _tag: z.literal('AnswerUnreadable'),
  raw: z.string(),
})
export type AnswerUnreadable = z.infer<typeof AnswerUnreadable>

/** A mechanical operation did not happen: a file not kept, a tree not cut or not restored. */
export const NotDone = z.object({ _tag: z.literal('NotDone') })
export type NotDone = z.infer<typeof NotDone>

/** Not run: a person approved past it in that wait (0120 §6). */
export const Waived = z.object({
  _tag: z.literal('Waived'),
  waitId: WaitId,
})
export type Waived = z.infer<typeof Waived>

/** What every action carries, whatever it yields. */
export const ActionBase = z.object({
  /** `'run'`, `'agent'`, `'watch'`, `'file'`, …: open (0120 principle 8). */
  plugin: z.string(),
  /** As the recipe writes it. */
  name: z.string(),
  /** Where the branch stood when this action's turn came, run or not. */
  onSha: z.string(),
  /** What the plugin said, for a person; nothing branches on it; `""` when not run. */
  evidence: z.string(),
})
export type ActionBase = z.infer<typeof ActionBase>

const VerdictAction = ActionBase.extend({
  yields: z.literal('verdict'),
  result: z.discriminatedUnion('_tag', [
    z.object({ _tag: z.literal('Completed'), assessment: Assessment }),
    AnswerUnreadable,
    Interrupted,
    NeverStarted,
    Waived,
    NotReached,
  ]),
})

const SignoffAction = ActionBase.extend({
  yields: z.literal('signoff'),
  result: z.discriminatedUnion('_tag', [
    // `requested: null` — not triggered.
    z.object({ _tag: z.literal('Completed'), requested: z.object({ question: z.string() }).nullable() }),
    Waived,
    // A mechanical operation did not happen: the dependency a `watch:`/`human:`
    // reads before it can even ask (`deps.changedFiles()`, say) threw.
    NotDone,
    NotReached,
  ]),
})

const CommitAction = ActionBase.extend({
  yields: z.literal('commit'),
  result: z.discriminatedUnion('_tag', [
    // `head`: where a commit left the branch; `null`: nothing committed.
    z.object({ _tag: z.literal('Completed'), head: z.string().nullable(), question: z.string().nullable() }),
    // Committed part of it, then stopped.
    Interrupted.extend({ head: z.string().nullable() }),
    // A kept-run could not restore the tree (`kept-run-action.ts:80`).
    NotDone,
    NeverStarted,
    Waived,
    NotReached,
  ]),
})

const DesignAction = ActionBase.extend({
  yields: z.literal('design'),
  result: z.discriminatedUnion('_tag', [
    // `head`: a `file:` destination's own commit, where keeping the design
    // moved the branch. Absent for the drafting agent, which never commits.
    z.object({ _tag: z.literal('Drafted'), design: Design, head: z.string().nullable().optional() }),
    z.object({ _tag: z.literal('Asked'), question: z.string(), draft: z.string().nullable() }),
    AnswerUnreadable,
    Interrupted,
    NotDone,
    NeverStarted,
    Waived,
    NotReached,
  ]),
})

const WorktreeAction = ActionBase.extend({
  yields: z.literal('worktree'),
  result: z.discriminatedUnion('_tag', [
    z.object({ _tag: z.literal('Completed'), head: z.string() }),
    NotDone,
    Waived,
    NotReached,
  ]),
})

const MergeAction = ActionBase.extend({
  yields: z.literal('merge'),
  result: z.discriminatedUnion('_tag', [
    z.object({ _tag: z.literal('Completed'), integration: Integration }),
    Waived,
    NotReached,
  ]),
})

const NothingAction = ActionBase.extend({
  yields: z.literal('nothing'),
  // Did something; the pass asks only whether it did.
  result: z.discriminatedUnion('_tag', [z.object({ _tag: z.literal('Completed') }), NotDone, Waived, NotReached]),
})

/**
 * One operation on the world, typed by what it yields to its step (0120
 * principle 8). A plugin's own detail is its `evidence`, never a type.
 */
export const Action = z.discriminatedUnion('yields', [
  VerdictAction,
  SignoffAction,
  CommitAction,
  DesignAction,
  WorktreeAction,
  MergeAction,
  NothingAction,
])
export type Action = z.infer<typeof Action>

/** A step ending, with every action it declared, the ones not run included. */
export const StepOutcome = z.object({
  step: Step,
  round: z.number().int(),
  actions: z.array(Action),
})
export type StepOutcome = z.infer<typeof StepOutcome>

/**
 * Whether an action cleared, derived from its yield and result alone (0120
 * §1's *Cleared when* table) — never stored. No `default`: with `strict` on,
 * a new `yields` or result `_tag` makes this non-exhaustive and
 * `pnpm typecheck` goes red rather than silently falling through.
 */
export function cleared(action: Action): boolean {
  switch (action.yields) {
    case 'verdict':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.assessment.verdict === 'accepted'
        case 'Waived':
          return true
        case 'AnswerUnreadable':
        case 'Interrupted':
        case 'NeverStarted':
        case 'NotReached':
          return false
      }
    case 'signoff':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.requested === null
        case 'Waived':
          return true
        case 'NotDone':
        case 'NotReached':
          return false
      }
    case 'commit':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.question === null
        case 'Waived':
          return true
        case 'Interrupted':
        case 'NotDone':
        case 'NeverStarted':
        case 'NotReached':
          return false
      }
    case 'design':
      switch (action.result._tag) {
        case 'Drafted':
          return true
        case 'Waived':
          return true
        case 'Asked':
        case 'AnswerUnreadable':
        case 'Interrupted':
        case 'NotDone':
        case 'NeverStarted':
        case 'NotReached':
          return false
      }
    case 'worktree':
      switch (action.result._tag) {
        case 'Completed':
          return true
        case 'Waived':
          return true
        case 'NotDone':
        case 'NotReached':
          return false
      }
    case 'merge':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.integration._tag === 'Integrated'
        case 'Waived':
          return true
        case 'NotReached':
          return false
      }
    case 'nothing':
      switch (action.result._tag) {
        case 'Completed':
          return true
        case 'Waived':
          return true
        case 'NotDone':
        case 'NotReached':
          return false
      }
  }
}

/** The last action in the step that is not `NotReached`, or `null` when every action is. */
export function decidingAction(outcome: StepOutcome): Action | null {
  const index = lastDecidingIndex(outcome.actions)
  return index === -1 ? null : outcome.actions[index]!
}

function lastDecidingIndex(actions: Action[]): number {
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i]!.result._tag !== 'NotReached') return i
  }
  return -1
}

/**
 * Whether the step cleared: the deciding action cleared, or the step had no
 * actions at all (0120:231-232).
 */
export function stepCleared(outcome: StepOutcome): boolean {
  const deciding = decidingAction(outcome)
  return deciding === null || cleared(deciding)
}

/**
 * The last `head` in the step, skipping a `null` one — a kept-run that
 * committed nothing after an agent that did commit leaves the agent's head
 * (0120:242-243). Four results carry one: `commit` `Completed`, `commit`
 * `Interrupted`, `worktree` `Completed`, and `design` `Drafted` — the last for
 * a `file:` destination alone, since the drafting agent never sets it.
 */
export function headOf(outcome: StepOutcome): string | null {
  let head: string | null = null
  for (const action of outcome.actions) {
    if (action.yields === 'commit' && (action.result._tag === 'Completed' || action.result._tag === 'Interrupted')) {
      if (action.result.head !== null) head = action.result.head
    } else if (action.yields === 'worktree' && action.result._tag === 'Completed') {
      head = action.result.head
    } else if (action.yields === 'design' && action.result._tag === 'Drafted') {
      if (action.result.head !== undefined && action.result.head !== null) head = action.result.head
    }
  }
  return head
}

/** The design of the step's last `Drafted` — a `file:` after an agent wins, with its locator. */
export function designOf(outcome: StepOutcome): Design | null {
  let design: Design | null = null
  for (const action of outcome.actions) {
    if (action.yields === 'design' && action.result._tag === 'Drafted') design = action.result.design
  }
  return design
}

/**
 * An `implement` whose actions all cleared and none of which carries a
 * `head` — read off the agent alone this would be wrong both ways: a
 * kept-run after it may commit a format, and a kept-run after a committing
 * agent may have nothing to commit (0120:240-243). An `implement` with no
 * actions answers `true`.
 */
export function changedNothing(outcome: StepOutcome): boolean {
  if (outcome.step !== 'implement') return false
  return outcome.actions.every((action) => cleared(action)) && headOf(outcome) === null
}

/**
 * Which `yields` a step accepts (0120 §1's *Legality* table). `claim` and
 * `end` are not in that table and accept nothing. No `default`, for the same
 * reason as {@link cleared}.
 *
 * **`merge`'s ordering is enforced elsewhere, not here.** This function says
 * only that `merge` accepts `signoff` and `merge`; it does not encode that
 * the lane is last (`packages/recipe/src/recipe.ts:2314-2315`, 0065 §8,
 * `#270`) or that the only `signoff` legal there is the one `--no-merge`
 * injects, never a recipe's own (`humanPlugin.at` and `watchPlugin.at` do not
 * serve `merge`, `recipe.ts:719,736`). A second encoding here would be a
 * second place for that rule to live, and nothing calls `accepts` yet.
 */
export function accepts(step: Step, yields: Action['yields']): boolean {
  switch (step) {
    case 'claim':
    case 'end':
      switch (yields) {
        case 'verdict':
        case 'signoff':
        case 'commit':
        case 'design':
        case 'worktree':
        case 'merge':
        case 'nothing':
          return false
      }
    case 'admit':
      switch (yields) {
        case 'worktree':
        case 'nothing':
          return true
        case 'verdict':
        case 'signoff':
        case 'commit':
        case 'design':
        case 'merge':
          return false
      }
    case 'prepared':
      switch (yields) {
        case 'verdict':
        case 'nothing':
          return true
        case 'signoff':
        case 'commit':
        case 'design':
        case 'worktree':
        case 'merge':
          return false
      }
    case 'design':
      switch (yields) {
        case 'design':
        case 'nothing':
          return true
        case 'verdict':
        case 'signoff':
        case 'commit':
        case 'worktree':
        case 'merge':
          return false
      }
    case 'implement':
      switch (yields) {
        case 'commit':
        case 'nothing':
          return true
        case 'verdict':
        case 'signoff':
        case 'design':
        case 'worktree':
        case 'merge':
          return false
      }
    case 'build':
    case 'review':
      switch (yields) {
        case 'verdict':
          return true
        case 'signoff':
        case 'commit':
        case 'design':
        case 'worktree':
        case 'merge':
        case 'nothing':
          return false
      }
    case 'proposed':
      switch (yields) {
        case 'verdict':
        case 'signoff':
          return true
        case 'commit':
        case 'design':
        case 'worktree':
        case 'merge':
        case 'nothing':
          return false
      }
    case 'merge':
      switch (yields) {
        case 'verdict':
        case 'signoff':
        case 'merge':
          return true
        case 'commit':
        case 'design':
        case 'worktree':
        case 'nothing':
          return false
      }
  }
}

/**
 * The invariant 0120:229-233 states: at most one action in a step fails to
 * clear, and the rest after it are `NotReached`. `decidingAction` finds the
 * last non-`NotReached` action by construction, so "everything after it is
 * `NotReached`" holds trivially — this checks the three parts that do not:
 * every action before the deciding one cleared, a `NotReached` follows only
 * a deciding action that did not clear, and a non-empty outcome has a
 * deciding action at all (it is not all `NotReached`).
 *
 * #464's builder of `StepEnded` is what has to keep this true; the other
 * step-level functions above take a well-formed outcome and do not check it
 * themselves.
 */
export function wellFormed(outcome: StepOutcome): boolean {
  const actions = outcome.actions
  if (actions.length === 0) return true

  const index = lastDecidingIndex(actions)
  if (index === -1) return false

  const deciding = actions[index]!
  const before = actions.slice(0, index)
  const after = actions.slice(index + 1)

  if (!before.every((action) => cleared(action))) return false
  if (after.length > 0 && cleared(deciding)) return false

  return true
}
