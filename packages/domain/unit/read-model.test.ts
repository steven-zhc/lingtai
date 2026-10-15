/**
 * #473's read model, proved against its own builders: `stepOutcomesOf`
 * round-trips through `aStepEnded` for every `yields` × result cell
 * `eventOf` gives its own event to, and the cells that collapse onto one
 * event are asserted *as* losses rather than silently passed over.
 *
 * `routesOf`/`waitsOf`/`releaseCauseOf` are proved here against the
 * builders directly; #461's fixture (`what-a-pass-writes-today.test.ts`)
 * is where they are proved against a real pass's own events.
 */
import { describe, expect, it } from 'vitest'

import type { Action, StepOutcome } from '../src/action.ts'
import { holdOf } from '../src/adapters.ts'
import { releaseCauseOf, routesOf, stepOutcomesOf, waitsOf } from '../src/read-model.ts'
import { aRelease, aResolution, aRoute, aRun, aWait, aWithdrawal } from '../test/events.ts'
import { makeStream } from '../test/support.ts'

const onSha = 'a'.repeat(40)

function outcomeOf(step: StepOutcome['step'], round: number, actions: Action[]): StepOutcome {
  return { step, round, actions }
}

describe('stepOutcomesOf round-trips through aStepEnded', () => {
  it('a verdict action that passed', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'agent',
      name: 'cold reviewer',
      onSha,
      call: null,
      evidence: 'looks right',
      yields: 'verdict',
      result: { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } },
    }
    const outcome = outcomeOf('review', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a verdict action that refused, with findings', () => {
    const run = aRun('run-1')
    const finding = {
      file: 'src/fix.ts',
      line: 12,
      claim: 'off by one',
      failureScenario: 'n+1 reads past the end',
      severity: 'blocker' as const,
    }
    const action: Action = {
      plugin: 'agent',
      name: 'cold reviewer',
      onSha,
      call: null,
      evidence: 'blocker src/fix.ts:12',
      yields: 'verdict',
      result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [finding] } },
    }
    const outcome = outcomeOf('review', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a verdict action whose answer could not be read at all', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'agent',
      name: 'cold reviewer',
      onSha,
      call: null,
      evidence: 'I am not sure what to say here.',
      yields: 'verdict',
      result: { _tag: 'AnswerUnreadable', raw: 'I am not sure what to say here.' },
    }
    const outcome = outcomeOf('review', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a verdict action whose agent never started', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'agent',
      name: 'cold reviewer',
      onSha,
      call: null,
      evidence: 'account-wide wall',
      yields: 'verdict',
      result: { _tag: 'NeverStarted', scope: 'conductor' },
    }
    const outcome = outcomeOf('review', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('names the loss: a verdict Interrupted always reads back as cause "crash"', () => {
    // `StepDidNotFinish` carries no `cause` for a `verdict` action — the same
    // loss `verdictResultOf` (`adapters.ts:215`) accepts in the forward
    // direction, defaulted the same way (row 14d of #461's fixture).
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'agent',
      name: 'cold reviewer',
      onSha,
      call: null,
      evidence: 'spent all 5 turns reviewing',
      yields: 'verdict',
      result: { _tag: 'Interrupted', cause: 'timeout' },
    }
    const outcome = outcomeOf('review', 0, [action])
    const events = run.aStepEnded(outcome)
    const [got] = stepOutcomesOf(events)
    expect(got?.actions[0]?.result).toEqual({ _tag: 'Interrupted', cause: 'crash' })
  })

  it('a signoff action that passed with nothing asked', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'watch',
      name: 'tamper watch',
      onSha,
      call: null,
      evidence: 'nothing watched changed',
      yields: 'signoff',
      result: { _tag: 'Completed', requested: null },
    }
    const outcome = outcomeOf('proposed', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a signoff action that asked', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'human',
      name: 'approval',
      onSha,
      call: null,
      evidence: 'Merge this?',
      yields: 'signoff',
      result: { _tag: 'Completed', requested: { question: 'Merge this?' } },
    }
    const outcome = outcomeOf('proposed', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a commit action that committed, at round 0', () => {
    const run = aRun('run-1')
    const head = 'b'.repeat(40)
    const action: Action = {
      plugin: 'agent',
      name: 'write the change',
      onSha,
      call: null,
      evidence: `committed ${head.slice(0, 7)}`,
      yields: 'commit',
      result: { _tag: 'Completed', head, question: null },
    }
    const outcome = outcomeOf('implement', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a commit action that cleared having committed nothing (row 6 of #461)', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'agent',
      name: 'write the change',
      onSha,
      call: null,
      evidence: 'the agent produced no commits',
      yields: 'commit',
      result: { _tag: 'Completed', head: null, question: null },
    }
    const outcome = outcomeOf('implement', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a commit action whose own setup broke before any agent ran', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'agent',
      name: 'write the change',
      onSha,
      call: null,
      evidence: 'the hook was not wired: socket refused',
      yields: 'commit',
      result: { _tag: 'NotDone' },
    }
    const outcome = outcomeOf('implement', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a commit action that was interrupted, at round 0', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'agent',
      name: 'write the change',
      onSha,
      call: null,
      evidence: 'spent all 10 turns with no commit',
      yields: 'commit',
      result: { _tag: 'Interrupted', cause: 'out-of-turns', head: null },
    }
    const outcome = outcomeOf('implement', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a commit action that asked', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'agent',
      name: 'write the change',
      onSha,
      call: null,
      evidence: 'which design wins?',
      yields: 'commit',
      result: { _tag: 'Completed', head: null, question: 'which design wins?' },
    }
    const outcome = outcomeOf('implement', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a commit action in a fix round that committed (round 1)', () => {
    const run = aRun('run-1')
    const head = 'd'.repeat(40)
    const action: Action = {
      plugin: 'agent',
      name: 'write the change',
      onSha,
      call: null,
      evidence: `committed ${head.slice(0, 7)}`,
      yields: 'commit',
      result: { _tag: 'Completed', head, question: null },
    }
    const outcome = outcomeOf('implement', 1, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a design action that drafted', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'agent',
      name: 'draft',
      onSha,
      call: null,
      evidence: 'a two-paragraph design',
      yields: 'design',
      result: { _tag: 'Drafted', design: { document: 'a two-paragraph design' } },
    }
    const outcome = outcomeOf('design', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('a design action that asked', () => {
    const run = aRun('run-1')
    const asked = 'Which wins — the ticket or the hold rule?'
    const action: Action = {
      plugin: 'agent',
      name: 'draft',
      onSha,
      call: null,
      evidence: asked,
      yields: 'design',
      result: { _tag: 'Asked', question: asked, draft: null },
    }
    const outcome = outcomeOf('design', 0, [action])
    const events = run.aStepEnded(outcome)
    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: run.runId }])
  })

  it('names the loss: a design NotDone/Interrupted collapse, told apart by plugin', () => {
    // `StepDidNotFinish` on a `design` action carries no `_tag` either — an
    // `agent:` drafter that crashed and a `file:` destination that could
    // not write emit the same event. Disambiguated by `plugin`, which this
    // file has and `adapters.ts`'s forward direction does not need.
    const runAgent = aRun('run-agent')
    const agentAction: Action = {
      plugin: 'agent',
      name: 'draft',
      onSha,
      call: null,
      evidence: 'crashed mid-draft',
      yields: 'design',
      result: { _tag: 'Interrupted', cause: 'crash' },
    }
    const agentEvents = runAgent.aStepEnded(outcomeOf('design', 0, [agentAction]))
    expect(stepOutcomesOf(agentEvents)[0]?.actions[0]?.result).toEqual({ _tag: 'Interrupted', cause: 'crash' })

    const runFile = aRun('run-file')
    const fileAction: Action = {
      plugin: 'file',
      name: 'keep the design',
      onSha,
      call: null,
      evidence: 'could not write the locator',
      yields: 'design',
      result: { _tag: 'NotDone' },
    }
    const fileEvents = runFile.aStepEnded(outcomeOf('design', 0, [fileAction]))
    expect(stepOutcomesOf(fileEvents)[0]?.actions[0]?.result).toEqual({ _tag: 'NotDone' })
  })

  it('a nothing action that passed and one that did not', () => {
    const run = aRun('run-1')
    const passed: Action = {
      plugin: 'file-brief',
      name: 'read the design back',
      onSha,
      call: null,
      evidence: 'read fine',
      yields: 'nothing',
      result: { _tag: 'Completed' },
    }
    const refused: Action = {
      plugin: 'queue',
      name: 'take the ticket',
      onSha,
      call: null,
      evidence: 'another conductor holds this item',
      yields: 'nothing',
      result: { _tag: 'NotDone' },
    }
    const passedOutcome = outcomeOf('implement', 0, [passed])
    const refusedOutcome = outcomeOf('implement', 1, [refused])
    const events = [...run.aStepEnded(passedOutcome), ...run.aStepEnded(refusedOutcome)]
    expect(stepOutcomesOf(events)).toEqual([
      { ...passedOutcome, runId: run.runId },
      { ...refusedOutcome, runId: run.runId },
    ])
  })

  it('a worktree action, its head read off the next action this run opens', () => {
    const run = aRun('run-1')
    const cutHead = 'b'.repeat(40)
    const worktree: Action = {
      plugin: 'worktree',
      name: 'cut the branch',
      onSha,
      call: null,
      evidence: 'cut',
      yields: 'worktree',
      result: { _tag: 'Completed', head: cutHead },
    }
    const next: Action = {
      plugin: 'agent',
      name: 'write the change',
      onSha: cutHead,
      call: null,
      evidence: 'committed',
      yields: 'commit',
      result: { _tag: 'Completed', head: cutHead, question: null },
    }
    const events = [
      ...run.aStepEnded(outcomeOf('admit', 0, [worktree])),
      ...run.aStepEnded(outcomeOf('implement', 0, [next])),
    ]
    const [admitOutcome] = stepOutcomesOf(events)
    expect(admitOutcome?.actions[0]?.result).toEqual({ _tag: 'Completed', head: cutHead })
  })

  it('a merge action that landed', () => {
    const run = aRun('run-1')
    const mergeSha = 'c'.repeat(40)
    const action: Action = {
      plugin: 'merge',
      name: 'land the branch',
      onSha,
      call: null,
      evidence: 'merged',
      yields: 'merge',
      result: { _tag: 'Completed', integration: { _tag: 'Integrated', mergeSha } },
    }
    const itemStream = makeStream(`wi-473-1`)
    const landed = itemStream('WorkItemLanded', { mergeCommit: mergeSha, base: 'main' })
    const events = [...run.aStepEnded(outcomeOf('merge', 0, [action])), landed]
    expect(stepOutcomesOf(events)).toEqual([{ ...outcomeOf('merge', 0, [action]), runId: run.runId }])
  })

  it('a merge action that refused on a conflict', () => {
    const run = aRun('run-1')
    const action: Action = {
      plugin: 'merge',
      name: 'land the branch',
      onSha,
      call: null,
      evidence: 'conflict',
      yields: 'merge',
      result: {
        _tag: 'Completed',
        integration: { _tag: 'Conflicted', paths: ['src/fix.ts'], baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
      },
    }
    const integrationStream = makeStream('int-473-main')
    const refused = integrationStream('IntegrationRefused', {
      workItemId: 'wi-473-1',
      branch: 'agent/473',
      reason: 'conflict',
      detail: 'both sides touched src/fix.ts',
      paths: ['src/fix.ts'],
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
    })
    const events = [...run.aStepEnded(outcomeOf('merge', 0, [action])), refused]
    expect(stepOutcomesOf(events)).toEqual([{ ...outcomeOf('merge', 0, [action]), runId: run.runId }])
  })
})

describe('routesOf', () => {
  it('folds a fix-lines route back to implement', () => {
    const run = aRun('run-1')
    const events = aRoute(run, { from: 'review', to: 'implement', why: 'blocker src/fix.ts:12' })
    expect(routesOf(events)).toEqual([
      {
        runId: run.runId,
        from: 'review',
        decision: { _tag: 'Selected', candidate: 'fix-lines' },
        next: { _tag: 'FixRound', to: 'implement', round: 1 },
      },
    ])
  })

  it('folds a restart back to claim', () => {
    const run = aRun('run-1')
    const events = aRoute(run, { from: 'proposed', to: 'claim', why: 'start over', restart: 1, of: 2 })
    expect(routesOf(events)).toEqual([
      {
        runId: run.runId,
        from: 'proposed',
        decision: { _tag: 'Selected', candidate: 'restart' },
        next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } },
      },
    ])
  })

  it('folds an escalation with a spent ceiling', () => {
    const run = aRun('run-1')
    const events = aRoute(run, { from: 'proposed', to: 'waiting', chose: 'implement', ceiling: 'rounds' })
    expect(routesOf(events)).toEqual([
      {
        runId: run.runId,
        from: 'proposed',
        decision: {
          _tag: 'Escalated',
          because: {
            _tag: 'CandidateUnavailable',
            excluded: { id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'rounds' } },
          },
        },
        next: { _tag: 'HandToPerson' },
      },
    ])
  })

  it('skips an ordinary advance', () => {
    const run = aRun('run-1')
    const events = aRoute(run, { from: 'review', to: 'proposed' })
    expect(routesOf(events)).toEqual([])
  })
})

describe('waitsOf', () => {
  it('round-trips a hold through holdOf, _tag for _tag', () => {
    const itemStream = makeStream('wi-473-1')
    const reason = { _tag: 'OwnQuestion' as const, question: 'which design?', by: 'steven' }
    const events = aWait(itemStream, reason)
    const [wait] = waitsOf(events)
    expect(wait?.reason).toEqual(reason)
    expect(holdOf(wait!.reason, { branch: 'agent/473', base: 'main', findings: [] })._tag).toBe(
      holdOf(reason, { branch: 'agent/473', base: 'main', findings: [] })._tag,
    )
  })

  it('reads a Routed{findings} hold back as ProposedEscalated/ReviewFindings', () => {
    const itemStream = makeStream('wi-473-1')
    const finding = {
      file: 'src/fix.ts',
      line: 12,
      claim: 'off by one',
      failureScenario: 'n+1 reads past the end',
      severity: 'blocker' as const,
    }
    const reason = {
      _tag: 'ProposedEscalated' as const,
      run: { runId: 'run-1' },
      proposal: { _tag: 'ReviewFindings' as const, findings: [finding] },
      because: { _tag: 'NotAsked' as const },
    }
    const events = aWait(itemStream, reason)
    const [wait] = waitsOf(events)
    const rebuiltHold = holdOf(wait!.reason, { branch: 'agent/473', base: 'main', findings: [] })
    const storedHold = holdOf(reason, { branch: 'agent/473', base: 'main', findings: [] })
    expect(rebuiltHold._tag).toBe(storedHold._tag)
    expect((rebuiltHold as { when?: string }).when).toBe((storedHold as { when?: string }).when)
  })

  it('answers the Resolution once one lands: Requeue', () => {
    // Not an `OwnQuestion`: an unwithdrawn unblock of one of those is always
    // `AnswerQuestion` (the next `it`), since the two write the same event
    // and nothing but `withdrawn` tells a requeue from an answer there.
    const itemStream = makeStream('wi-473-1')
    const reason = { _tag: 'FixerDisagrees' as const, run: { runId: 'run-1' }, said: 'the approach cannot work' }
    const events = [...aWait(itemStream, reason), ...aResolution(itemStream, { _tag: 'Requeue' })]
    const [wait] = waitsOf(events)
    expect(wait?.resolution).toEqual({ _tag: 'Requeue' })
  })

  it('answers the Resolution once one lands: AnswerQuestion', () => {
    const itemStream = makeStream('wi-473-1')
    const reason = { _tag: 'OwnQuestion' as const, question: 'which design?', by: 'steven' }
    const events = [
      ...aWait(itemStream, reason),
      ...aResolution(itemStream, { _tag: 'AnswerQuestion', choice: 'the simpler one' }),
    ]
    const [wait] = waitsOf(events)
    expect(wait?.resolution).toEqual({ _tag: 'AnswerQuestion', choice: 'the simpler one' })
  })

  it('answers Close', () => {
    const itemStream = makeStream('wi-473-1')
    const reason = { _tag: 'OwnQuestion' as const, question: 'which design?', by: 'steven' }
    const events = [...aWait(itemStream, reason), ...aResolution(itemStream, { _tag: 'Close' })]
    const [wait] = waitsOf(events)
    expect(wait?.resolution).toEqual({ _tag: 'Close' })
  })

  it('reads a withdrawn unblock as Requeue, never AnswerQuestion', () => {
    const itemStream = makeStream('wi-473-1')
    const reason = { _tag: 'OwnQuestion' as const, question: 'which design?', by: 'steven' }
    const events = [...aWait(itemStream, reason), ...aWithdrawal(itemStream)]
    const [wait] = waitsOf(events)
    expect(wait?.resolution).toEqual({ _tag: 'Requeue' })
  })

  it('answers Approve off the run it grants on', () => {
    const itemStream = makeStream('wi-473-1')
    const run = aRun('run-1')
    const reason = {
      _tag: 'SignoffRequired' as const,
      run: { runId: run.runId },
      step: 'proposed' as const,
      action: 'approval',
      question: 'Merge this?',
    }
    const events = [
      ...aWait(itemStream, reason),
      ...aResolution(
        itemStream,
        { _tag: 'Approve', onSha },
        { event: run.event, step: 'proposed', action: 'approval', runId: run.runId },
      ),
    ]
    const [wait] = waitsOf(events)
    expect(wait?.resolution).toEqual({ _tag: 'Approve', onSha })
  })
})

describe('releaseCauseOf', () => {
  it('reads an ordinary restart off the PassRestarted immediately before it', () => {
    const run = aRun('run-1')
    const itemStream = makeStream('wi-473-1')
    const events = [
      ...aRoute(run, { from: 'proposed', to: 'claim', restart: 1, of: 2 }),
      ...aRelease(itemStream, run.runId),
    ]
    expect(releaseCauseOf(events)).toEqual([{ _tag: 'Restart', restart: 1 }])
  })

  it('answers null for an ordinary failed pass', () => {
    const itemStream = makeStream('wi-473-1')
    const claimed = itemStream('WorkItemClaimed', { runId: 'run-1', worker: 'conductor:1', title: null, kind: null })
    const released = itemStream('WorkItemReleased', { runId: 'run-1', reason: 'the pass did not finish' })
    expect(releaseCauseOf([claimed, released])).toEqual([null])
  })

  it('answers ClaimUnconfirmed when no claim preceded the release', () => {
    const itemStream = makeStream('wi-473-1')
    const released = itemStream('WorkItemReleased', { runId: 'run-1', reason: 'the append may have committed' })
    expect(releaseCauseOf([released])).toEqual([{ _tag: 'ClaimUnconfirmed' }])
  })
})
