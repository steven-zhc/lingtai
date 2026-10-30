import type { StepPlan } from '@lingtai/conductor/filter'
import {
  decideRoute,
  offerFor,
  STEPS,
  type Action,
  type Envelope,
  type JudgeReply,
  type Proposal,
  type Step,
} from '@lingtai/domain'
/**
 * What a running card says about *now*.
 *
 * Driven off the timeline #79 recorded against `ticket-lingtai-59`'s own log, which
 * is the whole of the complaint: at 17:23 the card read `1 passed · attempt 2`
 * while the truth was "the agent finished three minutes ago; the build gate is
 * 2m34s into a 20m budget". Every fact in that sentence is in the events below,
 * and none of it reached the card.
 *
 * **Since `#502`, `StepStarted` carries `{step, round}` alone** — 0120's own
 * Consequences: the board loses which action of a step is running, and with
 * it the per-action budget this file used to read while a point was still in
 * flight. What a `StepEnded` carries once the point is done is unchanged.
 */
import { describe, expect, it } from 'vitest'

import { AGENT, describeHeld, elapsed, foldProgress, type StepState } from '../src/lib/progress.ts'

let seq = 0n

function at(time: string, type: string, data: unknown): Envelope {
  seq += 1n
  return {
    seq,
    streamId: 'pass-59',
    version: Number(seq),
    type,
    schemaVer: 2,
    data,
    actor: 'conductor',
    causation: null,
    at: new Date(time),
  }
}

/** A `verdict`-yield action, the shape a gate's own check declares. */
function verdictAction(name: string, verdict: 'accepted' | 'refused', evidence: string): Action {
  return {
    plugin: 'run',
    name,
    onSha: 'b1b8694',
    evidence,
    yields: 'verdict',
    result: { _tag: 'Completed', assessment: { verdict, findings: [] } },
  }
}

const started = (step: Step, round = 0) => ({ runId: 'pass-59', step, round })
const ended = (step: Step, actions: Action[], round = 0) => ({ runId: 'pass-59', outcome: { step, round, actions } })

/**
 * This repository's own recipe, as `stepPlan` reduces it — every point present
 * and every duration already a number. That reduction has its own test in
 * `packages/conductor/unit/filter.test.ts`; this one is about what the fold
 * does with the answer.
 */
const PLAN: StepPlan = new Map([
  ['admit', []],
  ['prepared', [{ name: 'install', budgetMs: 10 * 60_000 }]],
  ['proposed', [{ name: 'build', budgetMs: 20 * 60_000 }]],
  ['merge', []],
  ['end', [{ name: 'close the ticket', budgetMs: null }]],
])

/** The run as the log recorded it, up to any point in that timeline. */
function timeline(): Envelope[] {
  seq = 0n
  return [
    at('2026-09-04T17:12:20Z', 'StepStarted', started('prepared')),
    at('2026-09-04T17:12:26Z', 'StepEnded', ended('prepared', [verdictAction('install', 'accepted', 'ok')])),
    at('2026-09-04T17:12:30Z', 'RunStarted', {
      ticketId: 'ticket-lingtai-59',
      invocation: { command: 'claude', args: [], tier: 'guarded', limits: { turns: 150, wallMs: 3_600_000 } },
    }),
    at('2026-09-04T17:12:30Z', 'StepsResolved', {
      runId: 'pass-59',
      configHash: 'abc',
      steps: STEPS.map((step) => ({
        step: step,
        actions: (PLAN.get(step) ?? []).map((a) => a.name),
      })),
    }),
    at('2026-09-04T17:20:42Z', 'RunProposedCompletion', { headSha: 'b1b8694' }),
    at('2026-09-04T17:20:42Z', 'RunFinished', {
      exitCode: 0,
      turns: 34,
      durationMs: 492_000,
      costUsd: 2.19,
    }),
    at('2026-09-04T17:20:43Z', 'StepStarted', started('proposed')),
  ]
}

const stateOf = (steps: readonly { step: string; state: StepState }[], step: string) =>
  steps.find((p) => p.step === step)?.state

describe('where a run has got to', () => {
  it('names the point it is at, with no per-action budget to show', () => {
    const progress = foldProgress(timeline(), PLAN)

    // **Since `#502`**: `StepStarted` carries no action, so `now.label` is
    // the bare step — `stepOf` already reads a label's head rather than
    // assuming `point:action` — and there is no per-action budget to read
    // while the point is still in flight.
    expect(progress?.now?.label).toBe('proposed')
    expect(progress?.now?.since).toBe('2026-09-04T17:20:43.000Z')
    expect(progress?.now?.budgetMs).toBeNull()
  })

  it("measures elapsed from the run's first event, not from the agent's", () => {
    // The prepare gates run before `RunStarted`; a run that has spent six
    // minutes installing has spent six minutes.
    expect(foldProgress(timeline(), PLAN)?.since).toBe('2026-09-04T17:12:20.000Z')
  })

  it('is at the agent, against the wall clock as applied, while the agent runs', () => {
    const upToAgent = timeline().slice(0, 4)
    const progress = foldProgress(upToAgent, PLAN)

    expect(progress?.now?.label).toBe(AGENT)
    expect(progress?.now?.since).toBe('2026-09-04T17:12:30.000Z')
    // `RunStarted.invocation.limits`, which is the number the run will actually
    // be killed at — not a second reading of the recipe.
    expect(progress?.now?.budgetMs).toBe(3_600_000)
  })

  /**
   * The gap #79 measured: `RunFinished` at 17:20:42, `StepStarted` at 17:20:43.
   * Nothing is executing in between, and saying so beats saying the agent is.
   */
  it('says so when the agent has finished and no point has started', () => {
    const between = timeline().slice(0, 6)
    expect(foldProgress(between, PLAN)?.now).toBeNull()
  })

  /**
   * ADR 0016 §4: a point nobody configured is `skipped` and the skip is shown,
   * so that a point which *was* configured and did not run — Lingtai's bug — is
   * the only other way a point can be silent.
   */
  it('shows all ten steps, and which are done', () => {
    const steps = foldProgress(timeline(), PLAN)?.steps ?? []

    expect(steps.map((p) => p.step)).toEqual([...STEPS])
    expect(stateOf(steps, 'admit')).toBe('skipped')
    expect(stateOf(steps, 'prepared')).toBe('passed')
    expect(stateOf(steps, 'proposed')).toBe('running')
    expect(stateOf(steps, 'merge')).toBe('skipped')
    // Configured, not reached. Not the same fact as nothing being there.
    expect(stateOf(steps, 'end')).toBe('pending')
  })

  /**
   * `StepsResolved` is appended after `RunStarted`, which is after the prepare
   * gates — so for the first seconds of a run the log has no plan, and the
   * recipe is the only thing that can say a point exists.
   */
  it('names a configured point before StepsResolved has landed', () => {
    const first = timeline().slice(0, 2)
    const steps = foldProgress(first, PLAN)?.steps ?? []

    expect(stateOf(steps, 'proposed')).toBe('pending')
    expect(steps.find((p) => p.step === 'proposed')?.planned).toEqual(['build'])
    expect(stateOf(steps, 'merge')).toBe('skipped')
  })

  it('reads a failure at a point as failed, whatever else that point did', () => {
    const failed = [
      ...timeline(),
      at('2026-09-04T17:34:00Z', 'StepEnded', ended('proposed', [verdictAction('build', 'refused', '2 tests failed')])),
    ]
    const progress = foldProgress(failed, PLAN)

    expect(stateOf(progress?.steps ?? [], 'proposed')).toBe('failed')
    // The verdict ended the phase; nothing is executing.
    expect(progress?.now).toBeNull()
  })

  /**
   * **A question and a crash are two states on this rail** (`#296`, 0058 §3c).
   *
   * They were one — both `did-not-finish`, told apart by a `because` this fold
   * never sees — so a step waiting for an answer drew the hatch that means
   * *Lingtai's bug*. What a person does about the two is opposite: one is *look at
   * this, it broke* and the other is *answer this*.
   */
  it('reads a step that asked as asked, and a crash beside it as did-not-finish', () => {
    const askedAction: Action = {
      plugin: 'agent',
      name: 'build',
      onSha: 'b1b8694',
      evidence: '',
      yields: 'commit',
      result: { _tag: 'Completed', head: null, question: 'the ticket names two `base` values — which did you mean?' },
    }
    const asked = [...timeline(), at('2026-09-04T17:34:00Z', 'StepEnded', ended('proposed', [askedAction]))]
    expect(stateOf(foldProgress(asked, PLAN)?.steps ?? [], 'proposed')).toBe('asked')

    const crashedAction: Action = {
      plugin: 'agent',
      name: 'build',
      onSha: 'b1b8694',
      evidence: 'the turn budget was spent',
      yields: 'verdict',
      result: { _tag: 'Interrupted', cause: 'out-of-turns' },
    }
    const crashed = [...timeline(), at('2026-09-04T17:34:00Z', 'StepEnded', ended('proposed', [crashedAction]))]
    expect(stateOf(foldProgress(crashed, PLAN)?.steps ?? [], 'proposed')).toBe('did-not-finish')
  })

  /**
   * A person is not a timeout, and pretending otherwise answers both wrongly.
   *
   * `now.label` keeps `step:action` for a signoff — unlike a bare `StepStarted`,
   * a `SignoffRequested` fact carries its own action name off `StepEnded`'s
   * per-action breakdown, so there is a real action to name here.
   */
  it('puts no denominator on a point that is waiting for a person', () => {
    const signoffAction: Action = {
      plugin: 'human',
      name: 'read it',
      onSha: 'b1b8694',
      evidence: '',
      yields: 'signoff',
      result: { _tag: 'Completed', requested: { question: 'land this?' } },
    }
    const held = [...timeline().slice(0, 6), at('2026-09-04T17:21:00Z', 'StepEnded', ended('merge', [signoffAction]))]
    const progress = foldProgress(held, PLAN)

    expect(progress?.now?.label).toBe('merge:read it')
    expect(progress?.now?.budgetMs).toBeNull()
  })

  it('has nothing to say about a run with no events', () => {
    expect(foldProgress([], PLAN)).toBeNull()
  })

  /**
   * A recipe that would not resolve costs the denominators and not the card —
   * the same rule the Queued column follows when GitHub will not answer (#76).
   */
  it('still says where a run is when no recipe could be read', () => {
    const progress = foldProgress(timeline())

    expect(progress?.now?.label).toBe('proposed')
    expect(progress?.now?.budgetMs).toBeNull()
    // The plan the log recorded is still the plan.
    expect(stateOf(progress?.steps ?? [], 'prepared')).toBe('passed')
  })
})

/**
 * What a held item's budget line reads off (`#415`): the highest round a
 * bought fix spent. `FixRequested`/`FixApplied`/`FixDeclined` are gone
 * (`#502`) — a round is bought by `PassRouted{decision: Selected{candidate:
 * 'fix-lines'}}`, read through `boardFactOf`'s own `RoundOpened` fact.
 *
 * **The ceiling (`of`) is gone from this fold too** (0110-adjacent, `#502`):
 * `RouteOffer` never stored `policy.rounds`, only what it decided from it, so
 * there is nothing on the event for `roundsOf` to read — it stays `null`,
 * same as a caller with no recipe to fall back on.
 */
describe('rounds spent against the ceiling', () => {
  const roundOpened = (step: 'proposed' | 'merge', output: string) => {
    const proposal: Proposal = { _tag: 'CheckRefused', from: step, output }
    const offer = offerFor(proposal, { rounds: 3, restarts: 1 }, { rounds: 0, restarts: 0 })
    const reply: JudgeReply = { _tag: 'Selected', candidate: 'fix-lines', why: 'the lines, not the approach' }
    return { runId: 'pass-59', offer, reply, decision: decideRoute(offer, reply) }
  }

  it('reads the round a PassRouted FixRound named, with no ceiling on the event', () => {
    const withRound = [
      ...timeline(),
      at('2026-09-04T17:34:00Z', 'StepEnded', ended('proposed', [verdictAction('build', 'refused', '2 tests failed')])),
      at('2026-09-04T17:34:01Z', 'PassRouted', roundOpened('proposed', '2 tests failed')),
    ]

    expect(foldProgress(withRound, PLAN)?.rounds).toEqual({ spent: 1, of: null })
  })

  it('stays at the round already spent when a later escalation buys no further round', () => {
    const escalated: Proposal = { _tag: 'FixerDisagrees', said: 'two agents disagreed' }
    const offer = offerFor(escalated, { rounds: 3, restarts: 1 }, { rounds: 1, restarts: 0 })
    const declined = [
      ...timeline(),
      at('2026-09-04T17:34:00Z', 'StepEnded', ended('proposed', [verdictAction('build', 'refused', '2 tests failed')])),
      at('2026-09-04T17:34:01Z', 'PassRouted', roundOpened('proposed', '2 tests failed')),
      at('2026-09-04T17:48:02Z', 'PassRouted', {
        runId: 'pass-59',
        offer,
        reply: { _tag: 'NotAsked' },
        decision: decideRoute(offer, { _tag: 'NotAsked' }),
      }),
    ]

    expect(foldProgress(declined, PLAN)?.rounds).toEqual({ spent: 1, of: null })
  })

  it('is zero and names no ceiling on a run that never bought a round', () => {
    expect(foldProgress(timeline(), PLAN)?.rounds).toEqual({ spent: 0, of: null })
  })
})

describe('describeHeld', () => {
  it('says the rounds spent against their ceiling, and the restarts left against theirs', () => {
    expect(describeHeld({ granted: [], spent: 2, roundsOf: 3, restarts: 1, restartsOf: 2 })).toBe(
      '2 of 3 rounds · 1 restart left',
    )
  })

  /** A ceiling nothing bought and a ceiling nothing configured are one fact, and `0 of 0` reads as a typo of it. */
  it('reads a zero ceiling as none, never as 0 of 0', () => {
    expect(describeHeld({ granted: [], spent: 0, roundsOf: 0, restarts: 0, restartsOf: 0 })).toBe('no rounds')
  })

  it('leaves out a restarts ceiling of 0 with none taken, and keeps the others', () => {
    expect(describeHeld({ granted: [], spent: 0, roundsOf: 2, restarts: 0, restartsOf: 0 })).toBe('0 of 2 rounds')
    expect(describeHeld({ granted: [], spent: 0, roundsOf: 2, restarts: 0, restartsOf: 2 })).toBe(
      '0 of 2 rounds · 2 restarts left',
    )
    expect(describeHeld({ granted: [], spent: 0, roundsOf: 2, restarts: 3, restartsOf: 0 })).toBe(
      '0 of 2 rounds · no restarts left',
    )
  })

  it('never reads restarts left below zero', () => {
    expect(describeHeld({ granted: [], spent: 0, roundsOf: 0, restarts: 3, restartsOf: 2 })).toBe(
      'no rounds · 0 restarts left',
    )
  })

  /**
   * A ceiling that could not be read (a recipe that will not resolve) is a
   * different fact from a ceiling that was read as zero, and the two must not
   * print the same sentence (`#415`): the first says nothing about what was
   * bought, the second says there was never anything to buy.
   */
  it('reads a null ceiling as unknown, never as zero', () => {
    expect(describeHeld({ granted: [], spent: 1, roundsOf: null, restarts: 1, restartsOf: null })).toBe(
      '1 rounds · 1 restart',
    )
  })
})

/**
 * A round a person granted (#573) is named by its own `RunSpent`'s `for.grant`,
 * and is neither one of the automatic rounds nor matched to a `WaitResolved`.
 */
describe('human-granted rounds', () => {
  const opened = (spentRounds: number) => {
    const proposal: Proposal = { _tag: 'CheckRefused', from: 'proposed', output: 'red' }
    const offer = offerFor(proposal, { rounds: 5, restarts: 1 }, { rounds: spentRounds, restarts: 0 })
    const reply: JudgeReply = { _tag: 'Selected', candidate: 'fix-lines', why: 'the lines' }
    return { runId: 'pass-59', offer, reply, decision: decideRoute(offer, reply) }
  }
  const spent = (round: number, costUsd: number | null, grant?: string) =>
    at('2026-09-04T17:50:00Z', 'RunSpent', {
      for: { _tag: 'Action', step: 'implement', name: 'agent', round, ...(grant ? { grant } : {}) },
      runtime: 'claude-code',
      turns: 1,
      durationMs: 1,
      usage: [],
      costUsd,
    })
  const automatic = () => [
    ...timeline(),
    at('2026-09-04T17:34:01Z', 'PassRouted', opened(0)),
    spent(1, 0.5),
    at('2026-09-04T17:40:01Z', 'PassRouted', opened(1)),
    spent(2, 0.5),
  ]

  it('takes a granted round out of the automatic count and bills it on its own', () => {
    // Both histories: the granted lap opened a round (3) or wrote none.
    for (const withOpened of [true, false]) {
      const events = [
        ...automatic(),
        spent(3, 1.416, 'wait-1'),
        ...(withOpened ? [at('2026-09-04T17:55:00Z', 'PassRouted', opened(2))] : []),
      ]
      const progress = foldProgress(events, PLAN)
      expect(progress?.rounds.spent).toBe(2)
      expect(progress?.granted).toEqual([{ round: 3, waitId: 'wait-1', costUsd: 1.416 }])
      expect(
        describeHeld({
          spent: progress!.rounds.spent,
          granted: progress!.granted,
          roundsOf: 2,
          restarts: 0,
          restartsOf: 1,
        }),
      ).toBe('2 of 2 rounds · round 3 granted, $1.42 · 1 restart left')
    }
  })

  it('reads a granted round whose cost was not said as unknown, never $0.00', () => {
    const progress = foldProgress([...automatic(), spent(3, null, 'wait-1')], PLAN)
    expect(
      describeHeld({
        spent: progress!.rounds.spent,
        granted: progress!.granted,
        roundsOf: 2,
        restarts: 1,
        restartsOf: 1,
      }),
    ).toBe('2 of 2 rounds · round 3 granted, cost unknown · 0 restarts left')
  })

  it('has none where no RunSpent names a grant', () => {
    expect(foldProgress(automatic(), PLAN)?.granted).toEqual([])
  })
})

/**
 * The unit a live phase is read in. `inWords` answers *when* a countdown ends
 * and says "under a minute" for the first sixty seconds of a twenty-minute
 * gate, which is the one stretch where the seconds are all that is moving.
 */
describe('the stopwatch', () => {
  it('counts seconds, then minutes and seconds, then hours and minutes', () => {
    expect(elapsed(41_000)).toBe('41s')
    expect(elapsed(154_000)).toBe('2m34s')
    expect(elapsed(3_600_000 + 7 * 60_000)).toBe('1h07m')
  })

  it('never counts backwards past zero', () => {
    expect(elapsed(-5_000)).toBe('0s')
  })
})
