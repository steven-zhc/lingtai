/**
 * Builders that emit today's events for 0120's and 0118's vocabulary — #473,
 * so a test can build a fixture by saying what a pass *ended with* rather
 * than transcribing the wire events a second time.
 *
 * Each one emits through `eventOf`/`holdOf` (`../src/adapters.ts`) rather
 * than a second mapping, so `read-model.ts`'s own round trip
 * (`stepOutcomesOf(aStepEnded(...))` etc.) is a claim about one pair of
 * functions agreeing with itself, not about two independent tables.
 */
import type { Action, Envelope, Finding, RunRef, Step, StepOutcome } from '../src/index.ts'
import { eventOf, holdOf, STEPS } from '../src/index.ts'
import type { Resolution, WaitReason } from '../src/wait.ts'
import { makeStream } from './support.ts'

/** The `pass` fields `holdOf` reads off the pass rather than the wait — fixed defaults, since no row's assertions read them back. */
const PASS = { branch: 'agent/473', base: 'main', findings: [] as readonly Finding[] }

function recipeEntryFor(action: Action): Record<string, unknown> {
  switch (action.plugin) {
    case 'run':
      return { name: action.name, run: 'true' }
    case 'agent':
      return { name: action.name, agent: 'claude-code' }
    case 'file':
      return { name: action.name, file: 'design.md' }
    case 'file-brief':
      return { name: action.name, 'file-brief': true }
    case 'watch':
      return { name: action.name, watch: ['**/*'], then: action.yields === 'verdict' ? 'fail' : 'request-approval' }
    case 'worktree':
      return { name: action.name, worktree: { base: 'main', submodules: false } }
    case 'merge':
      return { name: action.name, merge: { strategy: 'merge-commit' } }
    case 'queue':
      return { name: action.name, queue: {} }
    case 'human':
      return { name: action.name, human: 'merge this?' }
    default:
      throw new Error(`events.ts fixture: unrecognised plugin "${action.plugin}"`)
  }
}

/** One run's own stream, with the bookkeeping `stepOutcomesOf` reads kept beside the step events themselves. */
export interface RunFixture {
  readonly runId: string
  /** The run's own `makeStream` appender, for a builder that writes directly onto it (`aRoute`, a seeded `WorkItemClaimed`'s run). */
  readonly event: ReturnType<typeof makeStream>
  /** `StepOutcome`s ended so far, round included — what `stepOutcomesOf(events)` is expected to answer back. */
  readonly ended: StepOutcome[]
  /** `aStepEnded(outcome)` — the `StepRequested`/`StepStarted`/terminal triples `eventOf` writes, plus the run-level bookkeeping a `commit` yield needs to be read back. */
  aStepEnded(outcome: StepOutcome): Envelope[]
}

/** One run, for `aStepEnded` and `aRoute` to write onto. */
export function aRun(runId: string): RunFixture {
  const event = makeStream(runId)
  const recipeSteps: Record<string, Array<Record<string, unknown>>> = {}
  const ended: StepOutcome[] = []
  let resolvedRecipe = false
  const roundsOpened = new Set<number>([0])

  /**
   * `stepOutcomesOf`'s own `round` reads off `FixRequested`, never off the
   * `StepOutcome` a builder is handed — so a round above 0 needs one opened
   * on the run before its own step events, the same as a real route does
   * (`conduct.ts`'s own `FixRequested`, ahead of the fixer's dispatch).
   */
  function openRound(round: number, onSha: string): Envelope[] {
    if (roundsOpened.has(round)) return []
    roundsOpened.add(round)
    return [event('FixRequested', { runId, round, of: round, action: 'reviewer', onSha, findings: [] })]
  }

  function declare(outcome: StepOutcome): void {
    const list = (recipeSteps[outcome.step] ??= [])
    for (const action of outcome.actions) {
      if (!list.some((entry) => entry.name === action.name)) list.push(recipeEntryFor(action))
    }
  }

  function stepsResolvedOnce(): Envelope[] {
    if (resolvedRecipe) return []
    resolvedRecipe = true
    return [
      event('StepsResolved', {
        runId,
        configHash: 'fixture',
        steps: STEPS.map((step) => ({ step, actions: (recipeSteps[step] ?? []).map((entry) => entry.name as string) })),
        recipe: { steps: recipeSteps },
      }),
    ]
  }

  /** The run-level bookkeeping a `commit`-yield action's own result needs behind it, so `commitContextFor` reads it back. */
  function contextFor(outcome: StepOutcome, action: Extract<Action, { yields: 'commit' }>): Envelope[] {
    if (outcome.round === 0) {
      if (action.result._tag === 'Completed' && action.result.head !== null) {
        return [event('RunProposedCompletion', { headSha: action.result.head })]
      }
      if (action.result._tag === 'Interrupted') {
        return [event('RunFailed', { kind: action.result.cause, detail: action.evidence })]
      }
      return []
    }
    if (action.result._tag === 'Completed') {
      return [
        event('FixApplied', {
          runId,
          round: outcome.round,
          headSha: action.result.head,
          turns: 1,
          costUsd: null,
          failure: null,
        }),
      ]
    }
    if (action.result._tag === 'Interrupted') {
      return [
        event('FixApplied', {
          runId,
          round: outcome.round,
          headSha: action.result.head,
          turns: 1,
          costUsd: null,
          failure: action.result.cause,
        }),
      ]
    }
    return []
  }

  return {
    runId,
    event,
    ended,

    aStepEnded(outcome: StepOutcome): Envelope[] {
      declare(outcome)
      ended.push(outcome)
      const envelopes: Envelope[] = [...stepsResolvedOnce()]
      const onSha = outcome.actions[0]?.onSha ?? 'a'.repeat(40)
      envelopes.push(...openRound(outcome.round, onSha))
      for (const action of outcome.actions) {
        if (action.yields === 'commit') envelopes.push(...contextFor(outcome, action))
      }
      for (const stepEvent of eventOf(outcome, runId)) {
        envelopes.push(event(stepEvent.type, stepEvent.data as never))
      }
      return envelopes
    },
  }
}

/** `WorkItemBlocked{hold}` — a `WaitReason` through `holdOf`, the same builder a real pass's hold goes through. */
export function aWait(
  itemStream: ReturnType<typeof makeStream>,
  reason: WaitReason,
  pass: { branch: string; base: string; findings: readonly Finding[] } = PASS,
): Envelope[] {
  return [itemStream('WorkItemBlocked', { hold: holdOf(reason, pass) })]
}

/** 0118 §1's table of resolutions, backwards: the event a person's answer writes. */
export function aResolution(
  itemStream: ReturnType<typeof makeStream>,
  resolution: Resolution,
  run?: { event: ReturnType<typeof makeStream>; step: Step; action: string; runId: string },
): Envelope[] {
  switch (resolution._tag) {
    case 'Approve': {
      if (run === undefined) throw new Error('aResolution(Approve, …) needs the run it approves')
      return [
        run.event('ApprovalGranted', {
          step: run.step,
          action: run.action,
          runId: run.runId,
          onSha: resolution.onSha,
          by: 'steven',
          note: 'looks right',
        }),
      ]
    }
    case 'Requeue':
      return [itemStream('WorkItemUnblocked', { by: 'steven', note: 'requeue' })]
    case 'EditBodyAndRequeue':
      // No event of its own today — writes the same `WorkItemUnblocked` an
      // ordinary requeue does (`approve.ts:555`; the design's own
      // `Watch out`).
      return [itemStream('WorkItemUnblocked', { by: 'steven', note: 'edited the body and requeued' })]
    case 'AnswerQuestion':
      return [itemStream('WorkItemUnblocked', { by: 'steven', note: resolution.choice })]
    case 'Close':
      return [itemStream('WorkItemClosed', { by: 'steven', reason: 'no longer wanted' })]
  }
}

/** A withdrawn `WorkItemUnblocked` — a person taking back an `OwnQuestion` asked before any run claimed the item. */
export function aWithdrawal(itemStream: ReturnType<typeof makeStream>, note = 'asked by mistake'): Envelope[] {
  return [itemStream('WorkItemUnblocked', { by: 'steven', note, withdrawn: true })]
}

/** `PassRouted`, plus the `FixRequested`/`PassRestarted` it is paired with — `routesOf`'s own reverse. */
export function aRoute(
  run: RunFixture,
  route: {
    from: Step
    to: Step | 'waiting'
    chose?: Step | 'waiting'
    why?: string
    ceiling?: 'rounds' | 'restarts' | null
    round?: number
    restart?: number
    of?: number
  },
): Envelope[] {
  const envelopes: Envelope[] = [
    run.event('PassRouted', {
      from: route.from,
      chose: route.chose ?? route.to,
      to: route.to,
      why: route.why ?? '',
      ceiling: route.ceiling ?? null,
    }),
  ]
  if (route.to === 'design' || route.to === 'implement') {
    envelopes.push(
      run.event('FixRequested', {
        runId: run.runId,
        round: route.round ?? 1,
        of: route.of ?? 1,
        action: 'reviewer',
        onSha: 'a'.repeat(40),
        findings: [],
      }),
    )
  } else if (route.to === 'claim') {
    envelopes.push(
      run.event('PassRestarted', {
        runId: run.runId,
        restart: route.restart ?? 1,
        of: route.of ?? 1,
        action: 'reviewer',
        rounds: 0,
        branch: 'agent/473',
        headSha: 'a'.repeat(40),
        findings: [],
      }),
    )
  }
  return envelopes
}

/** `WorkItemReleased` — 0120 §5's cause is read back off what came before it on the slice, never carried on the event itself. */
export function aRelease(
  itemStream: ReturnType<typeof makeStream>,
  runId: string,
  reason = 'the pass did not finish',
): Envelope[] {
  return [itemStream('WorkItemReleased', { runId, reason })]
}

/** `WorkItemClaimed` — the claim `releaseCauseOf` looks for since the item's last release or landing. */
export function aClaim(itemStream: ReturnType<typeof makeStream>, runId: string, worker = 'conductor:1'): Envelope[] {
  return [itemStream('WorkItemClaimed', { runId, worker, title: null, kind: null })]
}

/** `WorkItemLanded` — the merge sha `mergeResultFrom` (`read-model.ts`) reads back for a `merge` action's own `Integrated`. */
export function aLanding(itemStream: ReturnType<typeof makeStream>, mergeCommit: string, base = 'main'): Envelope[] {
  return [itemStream('WorkItemLanded', { mergeCommit, base })]
}

/** `IntegrationRefused` — the three optional fields `mergeResultFrom` reads back for a `Conflicted`/`IntegrationRefused` result. */
export function anIntegrationRefusal(
  integrationStream: ReturnType<typeof makeStream>,
  workItemId: string,
  branch: string,
  refusal: { reason: string; detail?: string; paths?: string[]; baseSha?: string; headSha?: string },
): Envelope[] {
  return [
    integrationStream('IntegrationRefused', {
      workItemId,
      branch,
      reason: refusal.reason,
      detail: refusal.detail ?? '',
      ...(refusal.paths === undefined ? {} : { paths: refusal.paths }),
      ...(refusal.baseSha === undefined ? {} : { baseSha: refusal.baseSha }),
      ...(refusal.headSha === undefined ? {} : { headSha: refusal.headSha }),
    } as never),
  ]
}

/** A bare `RunRef` — `{runId}` — for a `WaitReason`/`Hold` that needs one and nothing more; not an appender, `aRun` is what opens a stream. */
export function aRunRef(runId: string): RunRef {
  return { runId }
}
