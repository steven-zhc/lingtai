import { describe, expect, it } from 'vitest'

import { triageAnswersText, triageQuestionsOf } from '../src/triage.ts'

const q = (id: string, recommended = 'a') => ({
  id,
  text: `${id}?`,
  answers: [
    { id: 'a', text: 'yes' },
    { id: 'b', text: 'no' },
  ],
  recommended,
})

describe('triageAnswersText (#921)', () => {
  const undecided = { _tag: 'UndecidedQuestion', questions: [q('one'), q('two', 'b')] }

  it('takes the recommended answers with no picks', () => {
    expect(triageAnswersText(undecided)).toEqual({ ok: true, text: '- one? — yes\n- two? — no' })
  })

  it('takes a pick over the recommendation', () => {
    expect(triageAnswersText(undecided, { 1: 'a' })).toEqual({ ok: true, text: '- one? — yes\n- two? — yes' })
  })

  it('refuses an answer id or an index triage does not have', () => {
    expect(triageAnswersText(undecided, { 0: 'zzz' })).toMatchObject({ ok: false })
    expect(triageAnswersText(undecided, { 5: 'a' })).toMatchObject({ ok: false })
  })

  it('asks only the divergent hunks, each naming path:line (path alone when line is null)', () => {
    const cause = {
      _tag: 'ConflictingHunks',
      hunks: [
        { _tag: 'Mechanical', path: 'm.ts', line: 1 },
        { _tag: 'Divergent', path: 'd.ts', line: 7, question: q('x') },
        { _tag: 'Divergent', path: 'e.ts', line: null, question: q('y') },
      ],
    } as never
    expect(triageQuestionsOf(cause)).toHaveLength(2)
    expect(triageAnswersText(cause)).toEqual({ ok: true, text: '- `d.ts:7` — x? — yes\n- `e.ts` — y? — yes' })
  })

  it('is empty for a cause with no questions', () => {
    expect(triageAnswersText({ _tag: 'FixableLines' })).toEqual({ ok: true, text: '' })
  })
})
