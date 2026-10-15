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

import { wellFormed, type Action, type StepOutcome } from '../src/action.ts'
import { holdOf } from '../src/adapters.ts'
import { READ, releaseCauseOf, routesOf, stepOutcomesOf, waitsOf } from '../src/read-model.ts'
import {
  aClaim,
  aLanding,
  anIntegrationRefusal,
  aRelease,
  aResolution,
  aRoute,
  aRun,
  aWait,
  aWithdrawal,
} from '../test/events.ts'
import { makeStream } from '../test/support.ts'

const onSha = 'a'.repeat(40)

function outcomeOf(step: StepOutcome['step'], round: number, actions: Action[]): StepOutcome {
  return { step, round, actions }
}

/**
 * **The design's actual request**: "have a unit test assert that each one
 * [in `READ`] is produced by some builder." Asserting `READ.toContain(...)`
 * on a single name (as this test once did) checks `READ` against itself,
 * not against the builders — dropping a type from `READ`, or adding a fifth
 * type to a reader without listing it, left this green either way. Building
 * one slice that exercises every builder and comparing its own types against
 * `READ` is what actually holds the list to the code.
 */
it('READ names every type some builder in events.ts actually produces', () => {
  const run = aRun('run-read-coverage')
  const secondRun = aRun('run-read-coverage-2')
  const itemStream = makeStream('wi-read-coverage')
  const integrationStream = makeStream('int-read-coverage-main')

  const worktree: Action = {
    plugin: 'worktree',
    name: 'cut the branch',
    onSha,
    call: null,
    evidence: 'cut',
    yields: 'worktree',
    result: { _tag: 'Completed', head: onSha },
  }
  const interruptedCommit: Action = {
    plugin: 'agent',
    name: 'write the change',
    onSha,
    call: null,
    evidence: 'spent all turns with a partial diff',
    yields: 'commit',
    result: { _tag: 'Interrupted', cause: 'timeout', head: 'd'.repeat(40) },
  }
  const fixedCommit: Action = {
    plugin: 'agent',
    name: 'write the change',
    onSha: 'd'.repeat(40),
    call: null,
    evidence: 'committed the fix',
    yields: 'commit',
    result: { _tag: 'Completed', head: 'e'.repeat(40), question: null },
  }
  const neverStarted: Action = {
    plugin: 'agent',
    name: 'cold reviewer',
    onSha,
    call: null,
    evidence: 'account-wide wall',
    yields: 'verdict',
    result: { _tag: 'NeverStarted', scope: 'conductor' },
  }
  const refused: Action = {
    plugin: 'agent',
    name: 'tsc',
    onSha,
    call: null,
    evidence: 'type error',
    yields: 'verdict',
    result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
  }
  const askedForSignoff: Action = {
    plugin: 'human',
    name: 'approval',
    onSha,
    call: null,
    evidence: 'Merge this?',
    yields: 'signoff',
    result: { _tag: 'Completed', requested: { question: 'Merge this?' } },
  }
  const askedForDesign: Action = {
    plugin: 'agent',
    name: 'draft',
    onSha,
    call: null,
    evidence: 'which design wins?',
    yields: 'design',
    result: { _tag: 'Asked', question: 'which design wins?', draft: null },
  }
  const completedCommit: Action = {
    plugin: 'agent',
    name: 'write the change',
    onSha,
    call: null,
    evidence: 'committed',
    yields: 'commit',
    result: { _tag: 'Completed', head: 'f'.repeat(40), question: null },
  }

  const events = [
    ...aClaim(itemStream, run.runId),
    ...run.aStepEnded(outcomeOf('admit', 0, [worktree])),
    ...run.aStepEnded(outcomeOf('implement', 0, [interruptedCommit])),
    ...run.aStepEnded(outcomeOf('implement', 1, [fixedCommit])),
    ...run.aStepEnded(outcomeOf('review', 0, [neverStarted])),
    ...run.aStepEnded(outcomeOf('build', 0, [refused])),
    ...run.aStepEnded(outcomeOf('proposed', 0, [askedForSignoff])),
    ...run.aStepEnded(outcomeOf('design', 0, [askedForDesign])),
    ...secondRun.aStepEnded(outcomeOf('implement', 0, [completedCommit])),
    ...aResolution(
      itemStream,
      { _tag: 'Approve', onSha },
      { event: secondRun.event, step: 'proposed', action: 'approval', runId: secondRun.runId },
    ),
    ...aRoute(run, { from: 'proposed', to: 'claim', restart: 1, of: 2 }, itemStream),
    ...anIntegrationRefusal(integrationStream, 'wi-read-coverage', 'agent/read', { reason: 'dirty-base' }),
    ...aLanding(itemStream, 'c'.repeat(40)),
    ...aWait(itemStream, { _tag: 'OwnQuestion', question: 'which design?', by: 'steven' }),
    ...aWithdrawal(itemStream),
    ...aResolution(itemStream, { _tag: 'Close' }),
    ...aRelease(itemStream, run.runId),
  ]

  const types = new Set(events.map((e) => e.type))
  const missing = READ.filter((type) => !types.has(type))
  expect(missing).toEqual([])
})

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
    const events = [
      ...aClaim(itemStream, run.runId),
      ...run.aStepEnded(outcomeOf('merge', 0, [action])),
      ...aLanding(itemStream, mergeSha),
    ]
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
    const itemStream = makeStream('wi-473-1')
    const refused = anIntegrationRefusal(integrationStream, 'wi-473-1', 'agent/473', {
      reason: 'conflict',
      detail: 'both sides touched src/fix.ts',
      paths: ['src/fix.ts'],
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
    })
    const events = [...aClaim(itemStream, run.runId), ...run.aStepEnded(outcomeOf('merge', 0, [action])), ...refused]
    expect(stepOutcomesOf(events)).toEqual([{ ...outcomeOf('merge', 0, [action]), runId: run.runId }])
  })

  it('a merge refusal is matched by workItemId, not by the first refusal on the shared integration stream', () => {
    // The integration stream (`int-<project>-<base>`) is shared by every work
    // item on that base — an older refusal for a different item must not be
    // read as this run's own merge result.
    const integrationStream = makeStream('int-473-main')
    const itemStream = makeStream('wi-473-7')
    const older = anIntegrationRefusal(integrationStream, 'wi-473-999', 'agent/999', {
      reason: 'conflict',
      detail: 'not mine',
      paths: ['src/not-mine.ts'],
      baseSha: 'f'.repeat(40),
      headSha: 'e'.repeat(40),
    })
    const run = aRun('run-7')
    const action: Action = {
      plugin: 'merge',
      name: 'land the branch',
      onSha,
      call: null,
      evidence: 'dirty base',
      yields: 'merge',
      result: { _tag: 'Completed', integration: { _tag: 'IntegrationRefused', reason: 'dirty-base' } },
    }
    const ownRefusal = anIntegrationRefusal(integrationStream, 'wi-473-7', 'agent/7', {
      reason: 'dirty-base',
      detail: 'origin moved',
    })
    const events = [
      ...older,
      ...aClaim(itemStream, run.runId),
      ...run.aStepEnded(outcomeOf('merge', 0, [action])),
      ...ownRefusal,
    ]
    const [got] = stepOutcomesOf(events)
    expect(got?.actions[0]?.result).toEqual({
      _tag: 'Completed',
      integration: { _tag: 'IntegrationRefused', reason: 'dirty-base' },
    })
  })

  it("a second claim after a release reads its own refusal, never the first attempt's newer-looking one", () => {
    // The requeue-after-a-refusal path: run-1 conflicts, the item releases
    // and is reclaimed by run-2, and run-2's own refusal is a plain
    // `dirty-base` with no `paths`/`baseSha`/`headSha`. Picking "whichever
    // refusal is newest for this workItemId" (rather than bounding to each
    // attempt's own `StepFailed`) would read run-1's own conflict back onto
    // run-1's merge the moment run-2's later refusal lands on the shared
    // integration stream.
    const integrationStream = makeStream('int-473-main')
    const itemStream = makeStream('wi-473-7')
    const run1 = aRun('run-1')
    const conflictAction: Action = {
      plugin: 'merge',
      name: 'land the branch',
      onSha,
      call: null,
      evidence: 'conflict',
      yields: 'merge',
      result: {
        _tag: 'Completed',
        integration: { _tag: 'Conflicted', paths: ['src/mine.ts'], baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
      },
    }
    // `integrate.ts:240-253`'s own order: the lane appends `IntegrationRefused`
    // *before* returning to the caller, and `conduct.ts` only turns that
    // result into the merge step's own `StepFailed` afterwards — so each
    // refusal is built, as its own statement, ahead of the `aStepEnded` call
    // whose `StepFailed` it explains, the same relative order the real log
    // carries.
    const refusal1 = anIntegrationRefusal(integrationStream, 'wi-473-7', 'agent/7', {
      reason: 'conflict',
      detail: 'both sides touched src/mine.ts',
      paths: ['src/mine.ts'],
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
    })
    const events1 = [
      ...aClaim(itemStream, run1.runId),
      ...refusal1,
      ...run1.aStepEnded(outcomeOf('merge', 0, [conflictAction])),
    ]

    const run2 = aRun('run-2')
    const dirtyBaseAction: Action = {
      plugin: 'merge',
      name: 'land the branch',
      onSha,
      call: null,
      evidence: 'dirty base',
      yields: 'merge',
      result: { _tag: 'Completed', integration: { _tag: 'IntegrationRefused', reason: 'dirty-base' } },
    }
    const refusal2 = anIntegrationRefusal(integrationStream, 'wi-473-7', 'agent/7', {
      reason: 'dirty-base',
      detail: 'origin moved',
    })
    const events2 = [
      ...aRelease(itemStream, run1.runId),
      ...aClaim(itemStream, run2.runId),
      ...refusal2,
      ...run2.aStepEnded(outcomeOf('merge', 0, [dirtyBaseAction])),
    ]

    const all = [...events1, ...events2]
    const outcomes = stepOutcomesOf(all)
    const run1Merge = outcomes.find((o) => o.runId === run1.runId && o.step === 'merge')
    const run2Merge = outcomes.find((o) => o.runId === run2.runId && o.step === 'merge')
    expect(run1Merge?.actions[0]?.result).toEqual({
      _tag: 'Completed',
      integration: { _tag: 'Conflicted', paths: ['src/mine.ts'], baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
    })
    expect(run2Merge?.actions[0]?.result).toEqual({
      _tag: 'Completed',
      integration: { _tag: 'IntegrationRefused', reason: 'dirty-base' },
    })
  })

  it('a refusal never recorded (the store defect integrate.ts:280-283 names) is answered from the hold, not "unexpected"', () => {
    // When `IntegrationRefused` never reaches the integration stream — the
    // ordinary failure mode `integrate.ts`'s own comment names, because the
    // store is usually what is down — the true reason still sits on this
    // run's own `WorkItemBlocked.hold`. Here that hold is `Routed{when:
    // 'conflict'}`, the shape a conflict refusal takes once the router has
    // seen it (`holdOf`'s own `escalatedHold`).
    const run = aRun('run-1')
    const itemStream = makeStream('wi-473-1')
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
    const blocked = itemStream('WorkItemBlocked', {
      hold: {
        _tag: 'Routed',
        run: { runId: run.runId },
        when: 'conflict',
        why: 'agent/1 into main is waiting on you.',
        raw: 'both sides touched src/fix.ts',
        findings: [],
        paths: ['src/fix.ts'],
        baseSha: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
      },
    })
    const events = [...aClaim(itemStream, run.runId), ...run.aStepEnded(outcomeOf('merge', 0, [action])), blocked]
    const [got] = stepOutcomesOf(events)
    expect(got?.actions[0]?.result).toEqual({
      _tag: 'Completed',
      integration: { _tag: 'Conflicted', paths: ['src/fix.ts'], baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
    })
  })
})

describe('stepOutcomesOf and conduct.ts:4038\'s injected "unfixed"/"judge" pseudo-action', () => {
  it('reads an "unfixed" ApprovalRequested at `merge` as a signoff, never as the merge lane\'s own result', () => {
    // `conduct.ts` appends this `ApprovalRequested` directly — no
    // `StepRequested`/`StepStarted`, no recipe entry — at whichever step the
    // pass stopped at, which can be `merge` itself (a check declared before
    // the lane refused it). `STEP_DEFAULTS['merge']` must not claim it.
    const run = aRun('run-1')
    const events = [
      run.event('ApprovalRequested', {
        step: 'merge',
        action: 'unfixed',
        runId: run.runId,
        onSha,
        question: 'Merge agent/1 into main anyway?',
        artifacts: [],
      }),
    ]
    const [got] = stepOutcomesOf(events)
    expect(got?.actions[0]).toMatchObject({ plugin: 'conductor', yields: 'signoff' })
    expect(got?.actions[0]?.result).toEqual({
      _tag: 'Completed',
      requested: { question: 'Merge agent/1 into main anyway?' },
    })
  })

  it('reads a "judge" ApprovalRequested at `proposed` without throwing', () => {
    // No recipe entry and no `STEP_DEFAULTS['proposed']` — this used to throw.
    const run = aRun('run-1')
    const events = [
      run.event('ApprovalRequested', {
        step: 'proposed',
        action: 'judge',
        runId: run.runId,
        onSha,
        question: 'Merge agent/1 into main?',
        artifacts: [],
      }),
    ]
    expect(() => stepOutcomesOf(events)).not.toThrow()
    const [got] = stepOutcomesOf(events)
    expect(got?.actions[0]).toMatchObject({ plugin: 'conductor', yields: 'signoff' })
  })

  it('reads a `design` action with no `StepsResolved` on the run at all, without throwing', () => {
    // `StepsResolved` is only appended at `implement`'s own dispatch
    // (`conduct.ts:3016`) — a run that asks a question at `design` and stops
    // there, as row 11 of #461 does, never reaches it, so `recipeFor` answers
    // `undefined` and the recipe-entry lookup has nothing to find `draft` in.
    const run = aRun('run-1')
    const asked = 'which wins?'
    const events = [run.event('StepAsked', { step: 'design', action: 'draft', runId: run.runId, onSha, detail: asked })]
    expect(() => stepOutcomesOf(events)).not.toThrow()
    const [got] = stepOutcomesOf(events)
    expect(got?.actions[0]?.result).toEqual({ _tag: 'Asked', question: asked, draft: null })
  })

  it('splits the injected offer into its own `StepOutcome`, never behind the refusal it follows', () => {
    // 0120's own invariant (`action.ts:484-494`): at most one action in a
    // `StepOutcome` fails to clear, and nothing real follows it. A `check`
    // that refuses at `merge` and the injected `unfixed` offer right after
    // it share the same `step`/`round` on the wire (rows 9, 10a, 10b of
    // #461) — grouping them into one `StepOutcome` leaves the refusing
    // `check` neither last nor cleared, which `wellFormed` rejects.
    const run = aRun('run-1')
    const refusingCheck = run.event('StepFailed', {
      step: 'merge',
      action: 'check',
      runId: run.runId,
      onSha,
      evidence: 'blocker src/fix.ts:12',
      findings: [],
    })
    const injectedOffer = run.event('ApprovalRequested', {
      step: 'merge',
      action: 'unfixed',
      runId: run.runId,
      onSha,
      question: 'Merge agent/1 into main anyway?',
      artifacts: [],
    })
    const outcomes = stepOutcomesOf([refusingCheck, injectedOffer])
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]?.actions).toHaveLength(1)
    expect(outcomes[1]?.actions).toHaveLength(1)
    for (const outcome of outcomes) expect(wellFormed(outcome)).toBe(true)
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

  it('answers Approve for an earlier wait even when a later wait on the same item is requeued', () => {
    // approve.ts's own documented sequence (`approve.ts:318`, `:555`):
    // `Blocked{Human}` → `ApprovalGranted` on the run → the merge refuses →
    // `Blocked{MergeRefused, afterApproval: true}` → that second wait's own
    // requeue. The first wait's resolution must not be read off the second
    // wait's own `WorkItemUnblocked`.
    const itemStream = makeStream('wi-473-1')
    const run = aRun('run-1')
    const firstReason = {
      _tag: 'SignoffRequired' as const,
      run: { runId: run.runId },
      step: 'proposed' as const,
      action: 'approval',
      question: 'Merge this?',
    }
    const secondReason = {
      _tag: 'MergeRefused' as const,
      run: { runId: run.runId },
      reason: 'dirty-base' as const,
      raw: 'origin moved',
    }
    const events = [
      ...aWait(itemStream, firstReason),
      ...aResolution(
        itemStream,
        { _tag: 'Approve', onSha },
        { event: run.event, step: 'proposed', action: 'approval', runId: run.runId },
      ),
      ...aWait(itemStream, secondReason),
      ...aResolution(itemStream, { _tag: 'Requeue' }),
    ]
    const [firstWait, secondWait] = waitsOf(events)
    expect(firstWait?.resolution).toEqual({ _tag: 'Approve', onSha })
    expect(secondWait?.resolution).toEqual({ _tag: 'Requeue' })
  })

  it("carries the refusing StepFailed's own findings on CheckRefused, not an empty list", () => {
    // `Hold.CheckRed` itself carries no `findings` (`holdOf`'s own
    // `checkRedHold`) — the only place they can come from is the refusing
    // `StepFailed` on the run, which the design's own table names as their
    // source.
    const run = aRun('run-1')
    const itemStream = makeStream('wi-473-1')
    const finding = {
      file: 'src/fix.ts',
      line: 12,
      claim: 'off by one',
      failureScenario: 'n+1 reads past the end',
      severity: 'blocker' as const,
    }
    const stepFailed = run.event('StepFailed', {
      step: 'merge',
      action: 'a gate',
      runId: run.runId,
      onSha,
      evidence: 'blocker src/fix.ts:12',
      findings: [finding],
    })
    const blocked = itemStream('WorkItemBlocked', {
      hold: {
        _tag: 'CheckRed',
        run: { runId: run.runId },
        step: 'merge',
        why: 'blocker src/fix.ts:12',
        raw: 'blocker src/fix.ts:12',
      },
    })
    const [wait] = waitsOf([stepFailed, blocked])
    expect(wait?.reason).toMatchObject({ _tag: 'CheckRefused', findings: [finding] })
  })

  it("a different item's own unblock does not resolve this item's wait", () => {
    // One person requeuing `wi-p-8` must not read back as an answer to
    // `wi-p-7`'s own wait — `resolutionAfter` has to scope `WorkItemUnblocked`
    // by stream, not just by type, the way a projection folding every item's
    // events in one global `seq` order would see them interleaved.
    const thisItem = makeStream('wi-p-7')
    const otherItem = makeStream('wi-p-8')
    const reason = { _tag: 'FixerDisagrees' as const, run: { runId: 'run-1' }, said: 'the approach cannot work' }
    const events = [...aWait(thisItem, reason), ...aWithdrawal(otherItem, 'requeuing wi-p-8, not this one')]
    const [wait] = waitsOf(events)
    expect(wait?.resolution).toBeNull()
  })

  it("a different item's own block does not cut off this item's own resolution window", () => {
    // The mirror case: `wi-p-7` blocks, `wi-p-8` blocks, then `wi-p-7` is
    // unblocked. Bounding the search window by the next `WorkItemBlocked` of
    // any stream would read `wi-p-8`'s own block as the end of `wi-p-7`'s
    // window and miss `wi-p-7`'s real resolution sitting past it.
    const thisItem = makeStream('wi-p-7')
    const otherItem = makeStream('wi-p-8')
    const reason = { _tag: 'FixerDisagrees' as const, run: { runId: 'run-1' }, said: 'the approach cannot work' }
    const events = [
      ...aWait(thisItem, reason),
      ...aWait(otherItem, { _tag: 'FixerDisagrees' as const, run: { runId: 'run-2' }, said: 'unrelated' }),
      ...aResolution(thisItem, { _tag: 'Requeue' }),
    ]
    const [thisWait] = waitsOf(events)
    expect(thisWait?.resolution).toEqual({ _tag: 'Requeue' })
  })
})

describe('releaseCauseOf', () => {
  it('reads an ordinary restart off the PassRestarted immediately before it', () => {
    const run = aRun('run-1')
    const itemStream = makeStream('wi-473-1')
    const events = [
      ...aRoute(run, { from: 'proposed', to: 'claim', restart: 1, of: 2 }, itemStream),
      ...aRelease(itemStream, run.runId),
    ]
    expect(releaseCauseOf(events)).toEqual([{ _tag: 'Restart', restart: 1 }])
  })

  it("an unrelated item's event interleaved between the restart and the release does not hide the restart", () => {
    // `PassRestarted` lives on the work item's own stream (`conduct.ts:3936`)
    // — a second item appending in between, in global `seq` order, must not
    // make `releaseCauseOf` read the release as an ordinary failed pass.
    const run = aRun('run-1')
    const itemStream = makeStream('wi-p-7')
    const otherItem = makeStream('wi-p-8')
    const events = [
      ...aRoute(run, { from: 'proposed', to: 'claim', restart: 1, of: 2 }, itemStream),
      ...aClaim(otherItem, 'run-9'),
      ...aRelease(itemStream, run.runId),
    ]
    expect(releaseCauseOf(events)).toEqual([{ _tag: 'Restart', restart: 1 }])
  })

  it('answers null for an ordinary failed pass', () => {
    const itemStream = makeStream('wi-473-1')
    const claimed = aClaim(itemStream, 'run-1')
    const released = itemStream('WorkItemReleased', { runId: 'run-1', reason: 'the pass did not finish' })
    expect(releaseCauseOf([...claimed, released])).toEqual([null])
  })

  it('answers ClaimUnconfirmed when no claim preceded the release', () => {
    const itemStream = makeStream('wi-473-1')
    const released = itemStream('WorkItemReleased', { runId: 'run-1', reason: 'the append may have committed' })
    expect(releaseCauseOf([released])).toEqual([{ _tag: 'ClaimUnconfirmed' }])
  })
})
