/**
 * #1253: a design agent asks in triage's shape. What is stored before it reads as `questions: []` with the old text in
 * `said`, through an upcaster and never rewritten on the log; what an agent may ask is two to four answers a question.
 */
import { describe, expect, it } from 'vitest'

import {
  AskedQuestions,
  InputNeeded,
  SCHEMA_VER,
  askedText,
  parseStoredPayload,
  type TriageQuestion,
} from '../src/index.ts'
import { WaitReason } from '../src/wait.ts'

const run = { runId: 'run-1' }
const question = (extra: Partial<TriageQuestion> = {}): TriageQuestion => ({
  id: 'q1',
  text: 'Which wins?',
  answers: [
    { id: 'a', text: 'the hold' },
    { id: 'b', text: 'nothing holds' },
  ],
  recommended: 'a',
  ...extra,
})
const old = { _tag: 'AgentQuestion', run, step: 'design', question: 'which of the two?' }
const read = { _tag: 'AgentQuestion', run, step: 'design', questions: [], said: 'which of the two?' }

describe('askedText', () => {
  it('is the prose where there are no questions', () => {
    expect(askedText({ questions: [], said: 'rename to X or Y?' })).toBe('rename to X or Y?')
    expect(askedText({ questions: [] })).toBe('')
  })

  it('numbers the questions, lists the answers and marks the recommended one', () => {
    expect(askedText({ questions: [question(), question({ id: 'q2', text: 'And then?', recommended: 'b' })] })).toBe(
      [
        '1. Which wins?',
        '   - the hold (recommended)',
        '   - nothing holds',
        '2. And then?',
        '   - the hold',
        '   - nothing holds (recommended)',
      ].join('\n'),
    )
  })
})

describe('what an agent may ask', () => {
  it('is one to five questions of two to four answers, with a recommended one that names an answer', () => {
    expect(AskedQuestions.safeParse([question()]).success).toBe(true)
    expect(AskedQuestions.safeParse([]).success).toBe(false)
    expect(AskedQuestions.safeParse(Array.from({ length: 6 }, () => question())).success).toBe(false)
    expect(AskedQuestions.safeParse([question({ answers: [{ id: 'a', text: 'only' }] })]).success).toBe(false)
    expect(AskedQuestions.safeParse([question({ recommended: 'z' })]).success).toBe(false)
  })

  it('is a bar on the writer: a stored question of one answer still reads', () => {
    const stored = question({ answers: [{ id: 'a', text: 'only' }] })
    expect(InputNeeded.safeParse({ _tag: 'InputNeeded', from: 'design', questions: [stored] }).success).toBe(true)
  })

  it('never stores a question with neither questions nor the prose it was asked in', () => {
    expect(InputNeeded.safeParse({ _tag: 'InputNeeded', from: 'design', questions: [] }).success).toBe(false)
    expect(InputNeeded.safeParse({ _tag: 'InputNeeded', from: 'implement', questions: [], said: 'x?' }).success).toBe(
      true,
    )
    expect(WaitReason.safeParse({ _tag: 'AgentQuestion', run, step: 'design', questions: [] }).success).toBe(false)
  })
})

describe('WaitStarted 2 → 3', () => {
  it('reads an AgentQuestion with its old text in `said`', () => {
    expect(SCHEMA_VER.WaitStarted).toBe(3)
    expect(parseStoredPayload('WaitStarted', 2, { waitId: 'wait-1', reason: old })).toEqual({
      waitId: 'wait-1',
      reason: read,
    })
  })

  it('reads a ProposedEscalated{InputNeeded} the same way', () => {
    const reason = (proposal: object) => ({ _tag: 'ProposedEscalated', run, proposal, because: { _tag: 'NotAsked' } })
    expect(
      parseStoredPayload('WaitStarted', 2, {
        waitId: 'wait-1',
        reason: reason({ _tag: 'InputNeeded', from: 'design', question: 'which?' }),
      }),
    ).toEqual({
      waitId: 'wait-1',
      reason: reason({ _tag: 'InputNeeded', from: 'design', questions: [], said: 'which?' }),
    })
  })

  it('reads the reason an AgentCrashed stands in for, in `standing`', () => {
    const crashed = (standing: object) => ({
      _tag: 'AgentCrashed',
      run,
      step: 'implement',
      cause: 'crash',
      detail: 'died',
      standing,
    })
    expect(
      parseStoredPayload('WaitStarted', 2, { waitId: 'wait-2', reason: crashed({ waitId: 'wait-1', reason: old }) }),
    ).toEqual({ waitId: 'wait-2', reason: crashed({ waitId: 'wait-1', reason: read }) })
    const escalated = { _tag: 'ProposedEscalated', run, because: { _tag: 'NotAsked' } }
    expect(
      parseStoredPayload('WaitStarted', 2, {
        waitId: 'wait-2',
        reason: crashed({
          waitId: 'wait-1',
          reason: { ...escalated, proposal: { _tag: 'InputNeeded', from: 'implement', question: 'q?' } },
        }),
      }),
    ).toEqual({
      waitId: 'wait-2',
      reason: crashed({
        waitId: 'wait-1',
        reason: { ...escalated, proposal: { _tag: 'InputNeeded', from: 'implement', questions: [], said: 'q?' } },
      }),
    })
  })

  it('leaves a row already in the new shape, and any other reason, as it was', () => {
    const now = { waitId: 'wait-1', reason: { ...read, questions: [question()], said: undefined } }
    expect(parseStoredPayload('WaitStarted', 3, now)).toEqual(now)
    const other = { waitId: 'wait-2', reason: { _tag: 'OwnQuestion', question: 'why?', by: 'me' } }
    expect(parseStoredPayload('WaitStarted', 2, other)).toEqual(other)
  })
})

describe.each(['ProposalRouted', 'PassRouted'] as const)('%s 2 → 3', (type) => {
  const routed = (proposal: object) => ({
    runId: 'run-1',
    offer: { proposal, ended: { version: 3, action: 'design' }, available: [], unavailable: [] },
    reply: { _tag: 'NotAsked' },
    decision: { _tag: 'Escalated', because: { _tag: 'NotAsked' } },
  })

  it("reads an InputNeeded offer's old question as `said`", () => {
    expect(SCHEMA_VER[type]).toBe(3)
    expect(parseStoredPayload(type, 2, routed({ _tag: 'InputNeeded', from: 'design', question: 'which?' }))).toEqual(
      routed({ _tag: 'InputNeeded', from: 'design', questions: [], said: 'which?' }),
    )
  })

  it('leaves any other proposal as it was', () => {
    const other = routed({ _tag: 'ReviewFindings' })
    expect(parseStoredPayload('ProposalRouted', 2, other)).toEqual(other)
  })
})
