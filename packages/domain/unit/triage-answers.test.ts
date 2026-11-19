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
    expect(triageAnswersText(undecided)).toMatchObject({ ok: true, text: '- one? — yes\n- two? — no' })
  })

  it('takes a pick over the recommendation', () => {
    expect(triageAnswersText(undecided, { 1: 'a' })).toMatchObject({ ok: true, text: '- one? — yes\n- two? — yes' })
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
    expect(triageAnswersText(cause)).toMatchObject({ ok: true, text: '- `d.ts:7` — x? — yes\n- `e.ts` — y? — yes' })
  })

  it('is empty for a cause with no questions', () => {
    expect(triageAnswersText({ _tag: 'FixableLines' })).toMatchObject({ ok: true, text: '' })
  })
})

describe('triageAnswersText picks (#924)', () => {
  it('records the id each line was built from, defaults included', () => {
    expect(
      triageAnswersText({ _tag: 'UndecidedQuestion', questions: [q('one'), q('two', 'b')] }, { 0: 'b' }),
    ).toMatchObject({
      picks: [
        { index: 0, answerId: 'b' },
        { index: 1, answerId: 'b' },
      ],
    })
  })
})

describe('an own answer (#1255)', () => {
  const undecided = { _tag: 'UndecidedQuestion', questions: [q('one'), q('two', 'b')] }

  it('is written verbatim and recorded as written', () => {
    const r = triageAnswersText(undecided, { 0: { own: ' my words ' } })
    expect(r).toEqual({
      ok: true,
      text: '- one? —  my words \n- two? — no',
      picks: [
        { index: 0, own: ' my words ' },
        { index: 1, answerId: 'b' },
      ],
    })
  })

  it('keeps a newline inside its list item', () => {
    expect(triageAnswersText(undecided, { 0: { own: 'a\nb' } })).toMatchObject({ text: '- one? — a\n  b\n- two? — no' })
  })

  it('is never read as an unknown answer id, even when it equals none of them', () => {
    expect(triageAnswersText(undecided, { 0: { own: 'zzz' } })).toMatchObject({ ok: true })
  })

  it.each(['', '  \n '])('refuses %j with its own words, not "triage changed"', (own) => {
    const r = triageAnswersText(undecided, { 1: { own } })
    expect(r).toMatchObject({ ok: false })
    expect(r.ok === false && r.detail).toContain('question 2 has no answer written')
    expect(r.ok === false && r.detail).not.toContain('triage changed')
  })

  it('mixes ids, own answers and absent picks, and composes the same twice', () => {
    const picks = { 0: 'b', 1: { own: 'else' } }
    const a = triageAnswersText(undecided, picks)
    expect(a).toMatchObject({ text: '- one? — no\n- two? — else' })
    expect(triageAnswersText(undecided, picks)).toEqual(a)
  })

  it('refuses an own answer to a question past the end', () => {
    expect(triageAnswersText(undecided, { 5: { own: 'x' } })).toMatchObject({ ok: false })
  })
})
