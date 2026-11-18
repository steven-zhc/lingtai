import { describe, expect, it } from 'vitest'
import { ImplementOutcome, decideImplementOutcome, parseImplementOutcome, type Declared } from '../src/index.ts'
import { nextOf } from '../src/attempt-next.ts'
import type { StepOutcome } from '../src/action.ts'
import { StoredJudgeWhen, JudgeWhen } from '../src/proposal.ts'
import { WaitReason } from '../src/wait.ts'
import { SpentFor } from '../src/events.ts'

const q = {
  id: 'q1',
  text: 'which?',
  answers: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
  ],
  recommended: 'a',
}
const fence = (body: string) => `done.\n\`\`\`outcome\n${body}\n\`\`\`\n`

describe('parseImplementOutcome', () => {
  it('reads the last outcome fence', () => {
    expect(parseImplementOutcome(fence('{"outcome":"Implemented"}'))).toEqual({ _tag: 'Implemented' })
  })
  it('answers none for no fence, not JSON, an unknown outcome and an unclosed fence', () => {
    expect(parseImplementOutcome('all good')).toBeNull()
    expect(parseImplementOutcome(null)).toBeNull()
    expect(parseImplementOutcome(fence('Implemented'))).toBeNull()
    expect(parseImplementOutcome(fence('{"outcome":"Done"}'))).toBeNull()
    expect(parseImplementOutcome('```outcome\n{"outcome":"Implemented"}')).toBeNull()
  })
  it('answers none for two fences that disagree, and the outcome for two that agree', () => {
    const a = fence('{"outcome":"Implemented"}')
    const b = fence(JSON.stringify({ outcome: 'Unclear', questions: [q] }))
    expect(parseImplementOutcome(a + b)).toBeNull()
    expect(parseImplementOutcome(a + a)).toEqual({ _tag: 'Implemented' })
  })
  it('reads Disputed and Unclear in their shapes, and refuses an Unclear with no questions', () => {
    expect(parseImplementOutcome(fence('{"outcome":"Disputed","findings":[{"index":2,"why":"no"}]}'))).toEqual({
      _tag: 'Disputed',
      findings: [{ index: 2, why: 'no' }],
    })
    expect(parseImplementOutcome(fence(JSON.stringify({ outcome: 'Unclear', questions: [q] })))).toEqual({
      _tag: 'Unclear',
      questions: [q],
    })
    expect(parseImplementOutcome(fence('{"outcome":"Unclear","questions":[]}'))).toBeNull()
  })
})

describe('decideImplementOutcome', () => {
  const base = { endedAbnormally: false, startedAt: 'a', head: 'b', findingsOffered: 0 }
  const implemented: Declared = { _tag: 'Implemented' }
  const disputed: Declared = { _tag: 'Disputed', findings: [{ index: 1, why: 'x' }] }
  const unclear: Declared = { _tag: 'Unclear', questions: [q] }

  it.each([
    ['ended abnormally', { ...base, declared: implemented, endedAbnormally: true }, 'AgentFailed'],
    ['nothing declared', { ...base, declared: null }, 'AgentFailed'],
    ['Implemented, head unmoved', { ...base, declared: implemented, head: 'a' }, 'AgentFailed'],
    ['Implemented, head moved (a WIP commit counts)', { ...base, declared: implemented }, 'Implemented'],
    ['Disputed in a fix round', { ...base, declared: disputed, findingsOffered: 2, head: 'a' }, 'Disputed'],
    ['Disputed at a first dispatch', { ...base, declared: disputed }, 'AgentFailed'],
    ['Disputed naming a finding not offered', { ...base, declared: disputed, findingsOffered: 0 }, 'AgentFailed'],
    ['Unclear, no commits', { ...base, declared: unclear, head: 'a' }, 'Unclear'],
    ['Unclear, with commits', { ...base, declared: unclear }, 'Unclear'],
  ] as const)('%s → %s', (_name, input, expected) => {
    expect(decideImplementOutcome(input)._tag).toBe(expected)
  })

  it('an Unclear keeps its questions', () => {
    expect(decideImplementOutcome({ ...base, declared: unclear })).toEqual({ _tag: 'Unclear', questions: [q] })
  })
})

describe('nextOf an implement that declared', () => {
  const run = { runId: 'r' }
  const outcomeOf = (result: object): StepOutcome =>
    ({
      step: 'implement',
      round: 0,
      actions: [{ name: 'a', plugin: 'agent', yields: 'commit', evidence: 'said', result: { _tag: 'Completed', ...result } }],
    }) as unknown as StepOutcome

  it('Implemented advances to build', () => {
    expect(nextOf(outcomeOf({ head: 'h', question: null, outcome: { _tag: 'Implemented' } }), run)).toEqual({
      _tag: 'Advance',
      to: 'build',
    })
  })
  it('AgentFailed is a redo by rule: a wait on the crash path', () => {
    const next = nextOf(outcomeOf({ head: null, question: null, outcome: { _tag: 'AgentFailed', why: 'w' } }), run)
    expect(next).toMatchObject({ _tag: 'WaitOnPerson', reason: { _tag: 'AgentCrashed', step: 'implement' } })
  })
  it('Disputed proposes FixerDisagrees with the why lines', () => {
    const next = nextOf(
      outcomeOf({ head: null, question: null, outcome: { _tag: 'Disputed', findings: [{ index: 1, why: 'cannot happen' }] } }),
      run,
    )
    expect(next).toEqual({ _tag: 'Propose', proposal: { _tag: 'FixerDisagrees', said: 'finding 1: cannot happen' } })
  })
  it('Unclear proposes InputNeeded with its questions, commits kept', () => {
    const next = nextOf(
      outcomeOf({ head: 'h', question: 'x', outcome: { _tag: 'Unclear', questions: [q] } }),
      run,
    )
    expect(next).toMatchObject({ _tag: 'Propose', proposal: { _tag: 'InputNeeded', from: 'implement', questions: [q] } })
  })
})

describe('what the log already holds', () => {
  it('a stored judge spend and wait at the retired reason still decode', () => {
    expect(SpentFor.parse({ _tag: 'Judge', when: 'nothing-produced' })).toEqual({ _tag: 'Judge', when: 'nothing-produced' })
    expect(StoredJudgeWhen.safeParse('nothing-produced').success).toBe(true)
    expect(JudgeWhen.safeParse('nothing-produced').success).toBe(false)
    expect(WaitReason.parse({ _tag: 'NothingProduced', run: { runId: 'r' }, said: null })._tag).toBe('NothingProduced')
  })
  it('a stored Completed with no outcome decodes', () => {
    expect(ImplementOutcome.safeParse({ _tag: 'AgentFailed' }).success).toBe(true)
  })
})
