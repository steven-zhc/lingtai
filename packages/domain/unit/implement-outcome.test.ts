import { describe, expect, it } from 'vitest'

import { Action, cleared, type StepOutcome } from '../src/action.ts'
import { nextOf } from '../src/attempt-next.ts'
import { SpentFor } from '../src/events.ts'
import { ImplementOutcome, decideImplementOutcome, parseImplementOutcome, type Declared } from '../src/index.ts'
import { StoredJudgeWhen, JudgeWhen } from '../src/proposal.ts'
import { WaitReason } from '../src/wait.ts'

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
    expect(parseImplementOutcome(fence('{"outcome":"Implemented"}'))).toEqual({
      declared: { _tag: 'Implemented' },
      form: 'fence',
    })
  })
  it('answers none for no fence, not JSON, an unknown outcome and an unclosed fence', () => {
    expect(parseImplementOutcome('all good')).toBeNull()
    expect(parseImplementOutcome(null)).toBeNull()
    expect(parseImplementOutcome(fence('Disputed'))).toBeNull()
    expect(parseImplementOutcome(fence('{"outcome":"Done"}'))).toBeNull()
    expect(parseImplementOutcome('```outcome\n{"outcome":"Implemented"}')).toBeNull()
  })
  it('answers none for two fences that disagree, and the outcome for two that agree', () => {
    const a = fence('{"outcome":"Implemented"}')
    const b = fence(JSON.stringify({ outcome: 'Unclear', questions: [q] }))
    expect(parseImplementOutcome(a + b)).toBeNull()
    expect(parseImplementOutcome(a + a)).toEqual({ declared: { _tag: 'Implemented' }, form: 'fence' })
  })
  it('reads Disputed and Unclear in their shapes, and refuses an Unclear with no questions', () => {
    expect(parseImplementOutcome(fence('{"outcome":"Disputed","findings":[{"index":2,"why":"no"}]}'))).toEqual({
      declared: { _tag: 'Disputed', findings: [{ index: 2, why: 'no' }] },
      form: 'fence',
    })
    expect(parseImplementOutcome(fence(JSON.stringify({ outcome: 'Unclear', questions: [q] })))).toEqual({
      declared: { _tag: 'Unclear', questions: [q] },
      form: 'fence',
    })
    expect(parseImplementOutcome(fence('{"outcome":"Unclear","questions":[]}'))).toBeNull()
  })
  describe('the forms agents write (#1398)', () => {
    const imp = { _tag: 'Implemented' } as const
    const J = '{"outcome": "Implemented"}'
    it.each([
      ['a json fence', `done\n\`\`\`json\n${J}\n\`\`\``, 'json-fence'],
      ['a bare Implemented in an outcome fence', 'done\n```outcome\nImplemented\n```', 'bare-word'],
      ['a bare Implemented, CRLF', 'done\r\n```outcome \r\nImplemented\r\n```\r\n', 'bare-word'],
      ['the last line, unfenced', `all done.\n${J}`, 'last-line'],
      ['the last line, trailing blank lines', `all done.\n${J}\n\n`, 'last-line'],
    ] as const)('reads %s', (_n, text, form) => {
      expect(parseImplementOutcome(text)).toEqual({ declared: imp, form })
    })
    it('does not read a json fence that is not an outcome, and reads the outcome block after it', () => {
      const cfg = '```json\n{"name":"x"}\n```\n'
      expect(parseImplementOutcome(cfg)).toBeNull()
      expect(parseImplementOutcome(cfg + fence(J))).toEqual({ declared: imp, form: 'fence' })
    })
    it('is null where a json Implemented and an outcome Disputed disagree', () => {
      const d = fence('{"outcome":"Disputed","findings":[{"index":1,"why":"no"}]}')
      expect(parseImplementOutcome(`\`\`\`json\n${J}\n\`\`\`\n${d}`)).toBeNull()
    })
    it('is null for a bare Disputed, an unknown name in a json fence, and a last line that is no outcome', () => {
      expect(parseImplementOutcome(fence('Disputed'))).toBeNull()
      expect(parseImplementOutcome('```json\n{"outcome":"Done"}\n```')).toBeNull()
      expect(parseImplementOutcome('{"outcome":"Disputed"}')).toBeNull()
      expect(parseImplementOutcome('{"other":1}')).toBeNull()
    })
    it('is null where an unknown outcome name sits beside a valid block, in a json fence or on the last line', () => {
      const ok = fence(J)
      expect(parseImplementOutcome(`${ok}\n\`\`\`json\n{"outcome":"Done"}\n\`\`\``)).toBeNull()
      expect(parseImplementOutcome(`${ok}\n{"outcome":"Done"}`)).toBeNull()
    })
    it('does not read JSON inside an unclosed fence as a declaration', () => {
      expect(parseImplementOutcome(`done\n\`\`\`json\n${J}`)).toBeNull()
      expect(parseImplementOutcome(`done\n\`\`\`text\n${J}`)).toBeNull()
      expect(parseImplementOutcome(`${fence(J)}\n\`\`\`json\n${J}`)).toBeNull()
    })
    it('counts a json fence that ends the message once', () => {
      expect(parseImplementOutcome(`x\n\`\`\`json\n${J}\n\`\`\``)?.form).toBe('json-fence')
    })
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

  describe('AlreadyDone (#1251)', () => {
    const doneWhen = ['one', 'two']
    const answered: Declared = {
      _tag: 'AlreadyDone',
      items: [
        { item: 'one', evidence: 'a.ts:1' },
        { item: 'two', evidence: 'b.ts:2' },
      ],
    }
    const first = { ...base, head: 'a', doneWhen, offersAlreadyDone: true }

    it.each([
      ['head moved → Implemented', { ...first, declared: answered, head: 'b' }, 'Implemented'],
      ['unmoved, every item answered → AlreadyDone', { ...first, declared: answered }, 'AlreadyDone'],
      [
        'unmoved, an item with no evidence → AgentFailed',
        {
          ...first,
          declared: {
            _tag: 'AlreadyDone',
            items: [
              { item: 'one', evidence: 'x' },
              { item: 'two', evidence: ' ' },
            ],
          },
        },
        'AgentFailed',
      ],
      [
        'unmoved, an item left out → AgentFailed',
        { ...first, declared: { _tag: 'AlreadyDone', items: [{ item: 'one', evidence: 'x' }] } },
        'AgentFailed',
      ],
      [
        'a body with no Done-when section → AgentFailed',
        { ...first, declared: answered, doneWhen: null },
        'AgentFailed',
      ],
      [
        'a fix round does not offer it → AgentFailed',
        { ...first, declared: answered, offersAlreadyDone: false },
        'AgentFailed',
      ],
    ] as const)('%s', (_name, input, expected) => {
      expect(decideImplementOutcome(input as never)._tag).toBe(expected)
    })

    it('keeps the body’s own items in the body’s order, and ignores an item the body does not have', () => {
      const decided = decideImplementOutcome({
        ...first,
        declared: {
          _tag: 'AlreadyDone',
          items: [
            { item: 'extra', evidence: 'z' },
            { item: 'two  ', evidence: 'b.ts:2' },
            { item: 'one', evidence: 'a.ts:1' },
          ],
        },
      })
      expect(decided).toEqual({
        _tag: 'AlreadyDone',
        items: [
          { item: 'one', evidence: 'a.ts:1' },
          { item: 'two', evidence: 'b.ts:2' },
        ],
      })
    })

    it('is read from the block the agent ends its message with', () => {
      expect(
        parseImplementOutcome(fence('{"outcome":"AlreadyDone","items":[{"item":"one","evidence":"a.ts:1"}]}'))
          ?.declared,
      ).toEqual({ _tag: 'AlreadyDone', items: [{ item: 'one', evidence: 'a.ts:1' }] })
    })

    it('proposes AlreadyDone, with the base and the body version it carries', () => {
      const next = nextOf(
        {
          step: 'implement',
          round: 0,
          actions: [
            {
              name: 'a',
              plugin: 'agent',
              yields: 'commit',
              evidence: 'said',
              result: {
                _tag: 'Completed',
                head: null,
                question: null,
                outcome: { ...answered, baseSha: 'ba5e', bodyVersion: 3 },
              },
            },
          ],
        } as unknown as StepOutcome,
        { runId: 'r' },
      )
      expect(next).toEqual({
        _tag: 'Propose',
        proposal: { _tag: 'AlreadyDone', items: answered.items, baseSha: 'ba5e', bodyVersion: 3 },
      })
    })
  })

  it('an Unclear keeps its questions', () => {
    expect(decideImplementOutcome({ ...base, declared: unclear })).toEqual({ _tag: 'Unclear', questions: [q] })
  })
})

describe('what an AlreadyDone arrival offers (#1251)', () => {
  it('is the check and a person — no fix round and no restart, there is no criterion yet — and a built-in answers it', async () => {
    const { offerFor, BUILT_IN_FOR } = await import('../src/index.ts')
    const offer = offerFor(
      {
        _tag: 'AlreadyDone',
        items: [{ item: 'it works', evidence: 'a.ts:1' }],
        baseSha: 'ba5e',
        bodyVersion: 2,
      },
      { refusalFixes: 2, newAttempts: 1, conflictResolutions: 2 },
      { rounds: 0, newAttempts: 0 },
    )
    expect(offer.available.map((c) => c.id)).toEqual(['check-done', 'hand-to-person'])
    expect(offer.available[0]!.next).toEqual({
      _tag: 'CheckDone',
      baseSha: 'ba5e',
      bodyVersion: 2,
      items: [{ item: 'it works', evidence: 'a.ts:1' }],
    })
    expect(BUILT_IN_FOR['already-done']).toBe('check-the-evidence')
  })
})

describe('nextOf an implement that declared', () => {
  const run = { runId: 'r' }
  const outcomeOf = (result: object): StepOutcome =>
    ({
      step: 'implement',
      round: 0,
      actions: [
        { name: 'a', plugin: 'agent', yields: 'commit', evidence: 'said', result: { _tag: 'Completed', ...result } },
      ],
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
      outcomeOf({
        head: null,
        question: null,
        outcome: { _tag: 'Disputed', findings: [{ index: 1, why: 'cannot happen' }] },
      }),
      run,
    )
    expect(next).toEqual({ _tag: 'Propose', proposal: { _tag: 'FixerDisagrees', said: 'finding 1: cannot happen' } })
  })
  it('Unclear proposes InputNeeded with its questions, commits kept', () => {
    const next = nextOf(outcomeOf({ head: 'h', question: 'x', outcome: { _tag: 'Unclear', questions: [q] } }), run)
    expect(next).toMatchObject({
      _tag: 'Propose',
      proposal: { _tag: 'InputNeeded', from: 'implement', questions: [q] },
    })
  })
})

describe('what the log already holds', () => {
  it('a stored judge spend and wait at the retired reason still decode', () => {
    expect(SpentFor.parse({ _tag: 'Judge', when: 'nothing-produced' })).toEqual({
      _tag: 'Judge',
      when: 'nothing-produced',
    })
    expect(StoredJudgeWhen.safeParse('nothing-produced').success).toBe(true)
    expect(JudgeWhen.safeParse('nothing-produced').success).toBe(false)
    expect(WaitReason.parse({ _tag: 'NothingProduced', run: { runId: 'r' }, said: null })._tag).toBe('NothingProduced')
  })
  it('a stored Completed with no outcome decodes, and a legacy question still reads as asked', () => {
    const row = (result: object) => ({
      name: 'a',
      plugin: 'agent',
      onSha: 'o',
      yields: 'commit',
      evidence: '',
      result: { _tag: 'Completed', ...result },
    })
    const legacy = Action.parse(row({ head: 'h', question: null }))
    expect(legacy.yields === 'commit' && legacy.result._tag === 'Completed' && legacy.result.outcome).toBeFalsy()
    expect(cleared(legacy)).toBe(true)
    expect(cleared(Action.parse(row({ head: null, question: 'which?' })))).toBe(false)
    expect(ImplementOutcome.safeParse({ _tag: 'AgentFailed' }).success).toBe(true)
  })
})

describe('the stored outcome and the account-limit reader', () => {
  const run = { runId: 'r' }
  it('an AgentFailed wait never carries the agent’s prose in its detail', () => {
    const said = 'the test expects "You have hit your usage limit"'
    const next = nextOf(
      {
        step: 'implement',
        round: 0,
        actions: [
          {
            name: 'a',
            plugin: 'agent',
            yields: 'commit',
            evidence: said,
            result: {
              _tag: 'Completed',
              head: null,
              question: null,
              outcome: { _tag: 'AgentFailed', why: 'no outcome' },
            },
          },
        ],
      } as unknown as StepOutcome,
      run,
    )
    expect(JSON.stringify(next)).not.toContain('usage limit')
  })
})
