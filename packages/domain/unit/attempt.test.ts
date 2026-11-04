import { describe, expect, it } from 'vitest'

import type { Action, StepOutcome, WaitId } from '../src/index.ts'
import { emptyAttempt, filesOf, stepsOn, reduceAttempt } from '../src/index.ts'
import { histories, lateHistories } from '../test/histories.ts'
import { makeStream, unknownEvent } from '../test/support.ts'

const started = {
  ticketId: 'ticket-nextloom-ai-admin-117',
  runtime: 'claude-code' as const,
  model: 'claude-opus-5',
  promptVersion: 'ticket@3',
  baseSha: 'base000',
  configHash: 'cfg123',
  worktree: '/tmp/wt/117',
  invocation: {
    command: 'claude',
    args: ['-p', '<prompt: recorded as RunPrompted>', '--output-format', 'stream-json', '--verbose'],
    tier: 'guarded' as const,
    limits: { turns: 150, wallMs: 3_600_000 },
  },
}

function verdictAction(name: string, onSha: string, result: Action['result'], evidence = ''): Action {
  return { plugin: 'run', name, onSha, evidence, yields: 'verdict', result } as Action
}

describe('reduceAttempt', () => {
  it('is pending until it starts', () => {
    expect(reduceAttempt([])).toEqual(emptyAttempt)
  })

  it("records the run's provenance, including the recipe it was bound to", () => {
    const e = makeStream('pass-01JX')
    const s = reduceAttempt([e('RunStarted', started)])

    expect(s.lifecycle.status).toBe('running')
    expect(s.promptVersion).toBe('ticket@3')
    // How it was invoked, and not only which runtime took it (#88).
    expect(s.invocation?.command).toBe('claude')
    expect(s.invocation?.tier).toBe('guarded')
    expect(s.invocation?.limits).toEqual({ turns: 150, wallMs: 3_600_000 })
  })

  /**
   * The prompt is the one input to a run that is not reconstructible from
   * anything else (#88), so the reducer carries it rather than only counting it.
   */
  it('carries the prompt itself, and still counts them', () => {
    const e = makeStream('pass-01JY')
    const s = reduceAttempt([
      e('RunStarted', started),
      e('RunPrompted', { promptVersion: 'ticket@3', bytes: 12, prompt: 'do the thing' }),
    ])

    expect(s.prompts).toBe(1)
    expect(s.prompt).toBe('do the thing')
  })

  it('says nothing about the text of a prompt recorded before it was kept', () => {
    const e = makeStream('pass-01JZ')
    // A v1 `RunPrompted`, upcast: the length survived, the document did not.
    const s = reduceAttempt([e('RunPrompted', { promptVersion: 'ticket@1911', bytes: 4593, prompt: null })])

    expect(s.prompts).toBe(1)
    expect(s.prompt).toBeNull()
  })

  /**
   * 132 guard trips across 56 of 73 runs — 77% of runs — went to stderr inside a
   * log nobody parsed. Counting them is the entire reason the event exists.
   */
  it('records compaction as a metric, not as noise', () => {
    const e = makeStream('pass-01JX')
    const s = reduceAttempt([
      e('RunStarted', started),
      e('RunContextExhausted', { turn: 41 }),
      e('RunContextExhausted', { turn: 88 }),
    ])

    // Two compactions means the item was scoped far too large.
    expect(s.compactedAtTurns).toEqual([41, 88])
  })

  it('lights up when the agent is waiting, and goes back to running on progress', () => {
    const e = makeStream('pass-01JX')
    const waiting = [e('RunStarted', started), e('RunAwaitingInput', { prompt: 'Which base?' })]

    expect(reduceAttempt(waiting).lifecycle).toEqual({
      status: 'awaiting-input',
      prompt: 'Which base?',
    })

    const moved = reduceAttempt([
      ...waiting,
      e('RunProducedDiff', {
        branch: 'agent/117',
        headSha: 'sha-a',
        files: 3,
        insertions: 40,
        deletions: 2,
      }),
    ])
    expect(moved.lifecycle.status).toBe('running')
    expect(moved.produced).toMatchObject({ files: 3, insertions: 40, deletions: 2 })
  })

  it('enters gating on a proposed completion and collects verdicts', () => {
    const e = makeStream('pass-01JX')
    const outcome: StepOutcome = {
      step: 'proposed',
      round: 0,
      actions: [
        verdictAction(
          'build',
          'sha-a',
          { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } },
          'exit 0',
        ),
        verdictAction(
          'review',
          'sha-a',
          {
            _tag: 'Completed',
            assessment: {
              verdict: 'refused',
              findings: [
                {
                  file: 'src/a.ts',
                  line: 12,
                  claim: 'check-then-write race',
                  failureScenario: 'two requests read 0, both write 1, one increment is lost',
                  severity: 'blocker' as const,
                },
              ],
            },
          },
          '1 finding',
        ),
      ],
    }
    const s = reduceAttempt([
      e('RunStarted', started),
      e('RunProposedCompletion', { headSha: 'sha-a' }),
      e('StepStarted', { runId: 'pass-01JX', step: 'proposed', round: 0 }),
      e('StepEnded', { runId: 'pass-01JX', outcome }),
    ])

    expect(s.lifecycle).toEqual({ status: 'gating', headSha: 'sha-a' })
    expect(s.steps['proposed:build']!.verdict).toBe('passed')
    expect(s.steps['proposed:review']!.verdict).toBe('failed')
    expect(s.steps['proposed:review']!.findings[0]!.failureScenario).toContain('increment is lost')
    expect(
      stepsOn(s)
        .map((g) => g.step)
        .sort(),
    ).toEqual(['proposed:build', 'proposed:review'])
  })

  /**
   * **The verdict that is not one** (`#133`).
   *
   * A gate whose agent never started judged nothing, and the reducer has to say
   * that rather than the two things it is not. `failed` puts a refusal of this
   * diff on the record where none was made — which is what happened — and
   * leaving it at `running`, which is what no third event at all would mean,
   * says a review is still going on hours after the run ended.
   */
  it('keeps a gate whose agent never started apart from one that refused', () => {
    const e = makeStream('pass-01JX')
    const outcome: StepOutcome = {
      step: 'proposed',
      round: 0,
      actions: [
        verdictAction(
          'review',
          'sha-a',
          { _tag: 'NeverStarted', scope: 'conductor' },
          "You've hit your session limit · resets 2pm (America/Chicago)",
        ),
      ],
    }
    const s = reduceAttempt([
      e('RunStarted', started),
      e('RunProposedCompletion', { headSha: 'sha-a' }),
      e('StepStarted', { runId: 'pass-01JX', step: 'proposed', round: 0 }),
      e('StepEnded', { runId: 'pass-01JX', outcome }),
    ])

    expect(s.steps['proposed:review']!.verdict).toBe('never-ran')
    expect(s.steps['proposed:review']!.findings).toEqual([])
    // The runtime's own words survive as what they are: evidence that the agent
    // never started, never evidence about the diff.
    expect(s.steps['proposed:review']!.evidence).toContain('session limit')
  })

  /**
   * The reason `onSha` is on every gate event. In the old system approval was a
   * label, and a label survives any amount of rewriting — so a force-push
   * inherited its own approval. Here a new head simply has no verdicts.
   */
  it('a force-push invalidates every verdict, without revoking anything', () => {
    const e = makeStream('pass-01JX')
    const outcome: StepOutcome = {
      step: 'proposed',
      round: 0,
      actions: [
        verdictAction(
          'build',
          'sha-a',
          { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } },
          'exit 0',
        ),
      ],
    }
    const mergeOutcome: StepOutcome = {
      step: 'merge',
      round: 0,
      actions: [
        {
          plugin: 'human',
          name: 'human',
          onSha: 'sha-a',
          evidence: '',
          yields: 'signoff',
          result: { _tag: 'Waived', waitId: 'wait-1' as WaitId },
        } as Action,
      ],
    }
    const approved = [
      e('RunStarted', started),
      e('RunProposedCompletion', { headSha: 'sha-a' }),
      e('StepStarted', { runId: 'pass-01JX', step: 'proposed', round: 0 }),
      e('StepEnded', { runId: 'pass-01JX', outcome }),
      e('StepStarted', { runId: 'pass-01JX', step: 'merge', round: 0 }),
      e('StepEnded', { runId: 'pass-01JX', outcome: mergeOutcome }),
    ]

    const before = reduceAttempt(approved)
    expect(
      stepsOn(before)
        .map((g) => g.step)
        .sort(),
    ).toEqual(['merge:human', 'proposed:build'])

    const after = reduceAttempt([...approved, e('RunProposedCompletion', { headSha: 'sha-b' })])
    expect(after.headSha).toBe('sha-b')
    // The verdicts are still on the record — they were made, and about what —
    // but none of them is about the diff now on the table.
    expect(stepsOn(after)).toEqual([])
    expect(after.steps['merge:human']!.onSha).toBe('sha-a')
  })

  it('records a waiver with no `by`/`reason` of its own — a person approved past it, named on the ticket stream', () => {
    const e = makeStream('pass-01JX')
    const outcome: StepOutcome = {
      step: 'proposed',
      round: 0,
      actions: [verdictAction('review', 'sha-a', { _tag: 'Waived', waitId: 'wait-1' as WaitId })],
    }
    const s = reduceAttempt([
      e('RunStarted', started),
      e('RunProposedCompletion', { headSha: 'sha-a' }),
      e('StepStarted', { runId: 'pass-01JX', step: 'proposed', round: 0 }),
      e('StepEnded', { runId: 'pass-01JX', outcome }),
    ])

    expect(s.steps['proposed:review']!.verdict).toBe('waived')
  })

  it('waits on a person — a signoff action with a live question', () => {
    const e = makeStream('pass-01JX')
    const outcome: StepOutcome = {
      step: 'merge',
      round: 0,
      actions: [
        {
          plugin: 'human',
          name: 'human',
          onSha: 'sha-a',
          evidence: '',
          yields: 'signoff',
          result: { _tag: 'Completed', requested: { question: 'Merge into develop?' } },
        } as Action,
      ],
    }
    const s = reduceAttempt([
      e('RunStarted', started),
      e('RunProposedCompletion', { headSha: 'sha-a' }),
      e('StepStarted', { runId: 'pass-01JX', step: 'merge', round: 0 }),
      e('StepEnded', { runId: 'pass-01JX', outcome }),
    ])

    expect(s.lifecycle).toEqual({
      status: 'awaiting-approval',
      step: 'merge:human',
      onSha: 'sha-a',
      question: 'Merge into develop?',
    })
  })

  it('keeps the receipt — turns and duration, no dollar figure (0110 §9)', () => {
    const e = makeStream('pass-01JX')
    const s = reduceAttempt([
      e('RunStarted', started),
      e('RunFinished', { exitCode: 0, turns: 63, durationMs: 4_210_000 }),
    ])

    expect(s.receipt).toEqual({ exitCode: 0, turns: 63, durationMs: 4_210_000 })
    expect(s.lifecycle.status).toBe('finished')
  })

  it('records a failure with its kind', () => {
    const e = makeStream('pass-01JX')
    const s = reduceAttempt([
      e('RunStarted', started),
      e('RunFailed', { kind: 'timeout' as const, detail: '2h wall clock' }),
    ])

    expect(s.lifecycle).toEqual({ status: 'failed', kind: 'timeout', detail: '2h wall clock' })
  })

  it('ignores an event type it has never heard of', () => {
    const e = makeStream('pass-01JX')
    const s = reduceAttempt([e('RunStarted', started), unknownEvent('pass-01JX', 2)])

    expect(s.lifecycle.status).toBe('running')
    expect(s.version).toBe(2)
  })
})

describe('AttemptState.step and implementRound (#822)', () => {
  const at = (runId = 'r') => makeStream(runId)

  it('StepStarted sets step, and its own StepEnded clears it', () => {
    const event = at()
    const begun = [event('StepStarted', { runId: 'r', step: 'build', round: 2 })]
    expect(reduceAttempt(begun).step).toEqual(expect.objectContaining({ step: 'build', round: 2 }))
    const ended = [...begun, event('StepEnded', { runId: 'r', outcome: { step: 'build', round: 2, actions: [] } })]
    expect(reduceAttempt(ended).step).toBeNull()
  })

  it('RunFailed leaves step', () => {
    const event = at()
    const state = reduceAttempt([
      event('StepStarted', { runId: 'r', step: 'review', round: 0 }),
      event('RunFailed', { kind: 'timeout', detail: 'wall' }),
    ])
    expect(state.step).toEqual(expect.objectContaining({ step: 'review', round: 0 }))
  })

  it('a non-implement start does not raise implementRound', () => {
    const event = at()
    const state = reduceAttempt([event('StepStarted', { runId: 'r', step: 'review', round: 3 })])
    expect(state.implementRound).toBe(0)
  })

  it('D12: a StepEnded for another step leaves step', () => {
    const state = reduceAttempt(lateHistories.attempt.stepEndedForAnother)
    expect(state.step).toEqual(expect.objectContaining({ step: 'implement', round: 0 }))
  })

  it('a FixRound route raises implementRound', () => {
    const state = reduceAttempt(lateHistories.attempt.fixRoundRouted)
    expect(state.implementRound).toBe(1)
    expect(state.step).toEqual(expect.objectContaining({ step: 'implement', round: 1 }))
  })

  it('a FixRound route is a round opened', () => {
    expect(reduceAttempt(lateHistories.attempt.fixRoundRouted).roundsOpened).toEqual([1])
  })

  it('D3: a failure stays a failure', () => {
    expect(reduceAttempt(histories.attempt.failedThenFinished).failure).toMatchObject({ kind: 'crash' })
  })

  it('a failure inside a step is the failure', () => {
    const state = reduceAttempt(lateHistories.attempt.failedInsideStep)
    expect(state.failure).toMatchObject({ kind: 'out-of-turns' })
    expect(state.step).toEqual(expect.objectContaining({ step: 'implement', round: 0 }))
    expect(state.receipt?.turns).toBe(30)
    expect(state.refusal).toBeNull()
  })

  it('the last refusal is kept', () => {
    expect(reduceAttempt(histories.attempt.fixRoundThenLanded).refusal?.key).toBe('review:cold')
  })

  it('route is the last PassRouted payload, whatever its next', () => {
    const history = lateHistories.attempt.fixRoundRouted
    const routed = history.findLast((e) => e.type === 'PassRouted')!
    expect(reduceAttempt(history).route).toEqual(routed.data)
    expect(reduceAttempt(history.filter((e) => e.type !== 'PassRouted')).route).toBeNull()
  })

  it('route is set when the route is not a FixRound too', () => {
    const history = lateHistories.attempt.fixRoundRouted
    const routed = history.findLast((e) => e.type === 'PassRouted')!
    const handed = {
      ...routed,
      data: {
        ...(routed.data as Record<string, unknown>),
        reply: { _tag: 'Selected', candidate: 'hand-to-person', why: 'a person decides' },
        decision: { _tag: 'Selected', candidate: 'hand-to-person' },
      },
    }
    const state = reduceAttempt(history.map((e) => (e === routed ? (handed as typeof e) : e)))
    expect(state.route).toEqual(handed.data)
    expect(state.roundsOpened).toEqual([])
  })
})

describe('AttemptState instants and the recorded plan (#827)', () => {
  const last = <T>(xs: readonly T[], type: string) =>
    [...xs].reverse().find((e) => (e as { type: string }).type === type) as { at: Date }

  it('step.since is the last StepStarted, agentStartedAt the RunStarted, openedAt the first event', () => {
    const events = lateHistories.attempt.fixRoundRouted
    const state = reduceAttempt(events)
    expect(state.step?.since).toEqual(last(events, 'StepStarted').at)
    expect(state.agentStartedAt).toEqual(events.find((e) => e.type === 'RunStarted')!.at)
    expect(state.openedAt).toEqual(events[0]!.at)
  })

  it('D10: laneWaitedAt is the MergeLaneWaited at', () => {
    const events = lateHistories.attempt.laneWaited
    expect(reduceAttempt(events).laneWaitedAt).toEqual(events.find((e) => e.type === 'MergeLaneWaited')!.at)
  })

  it('askedAt is the signoff StepEnded at, and stays after the lifecycle moves on', () => {
    const events = histories.attempt.signoffRequestedThenLifecycle
    const state = reduceAttempt(events)
    expect(state.askedAt).toEqual(events.find((e) => e.type === 'StepEnded')!.at)
    expect(state.lifecycle.status).not.toBe('awaiting-approval')
  })

  it('D10: resolved holds the hash and the ten steps', () => {
    const state = reduceAttempt(lateHistories.attempt.planResolved)
    expect(state.resolved?.configHash).toBe('cfg-plan')
    expect(state.resolved?.steps).toHaveLength(10)
  })
})

describe('filesOf and promptMeta (#828)', () => {
  it('filesOf gives each path once, in first-touch order, with its last op', () => {
    const e = makeStream('run-files')
    const state = reduceAttempt([
      e('RunTouchedFile', { path: 'a.ts', op: 'write' }),
      e('RunTouchedFile', { path: 'b.ts', op: 'edit' }),
      e('RunTouchedFile', { path: 'a.ts', op: 'delete' }),
    ])
    expect(filesOf(state)).toEqual([
      { path: 'a.ts', op: 'delete' },
      { path: 'b.ts', op: 'edit' },
    ])
  })

  it('promptMeta matches the last RunPrompted', () => {
    const e = makeStream('run-prompt-meta')
    expect(reduceAttempt([]).promptMeta).toBeNull()
    const state = reduceAttempt([
      e('RunPrompted', { promptVersion: 'ticket@1', bytes: 5, prompt: 'one' }),
      e('RunPrompted', { promptVersion: 'ticket@2', bytes: 9, prompt: 'two' }),
    ])
    expect(state.promptMeta).toEqual({ version: 'ticket@2', bytes: 9 })
  })
})
