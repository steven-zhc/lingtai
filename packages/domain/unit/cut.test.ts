import { describe, expect, it } from 'vitest'

import { cut, cutProse, TRIAGE_TEXT_MAX } from '../src/triage.ts'

describe('cut', () => {
  it('leaves what fits, and cuts the rest to the bound ending …', () => {
    expect(cut('abc')).toBe('abc')
    const out = cut('x'.repeat(TRIAGE_TEXT_MAX + 5))
    expect(out).toHaveLength(TRIAGE_TEXT_MAX)
    expect(out.endsWith('…')).toBe(true)
  })

  it('never ends on half a surrogate pair', () => {
    const out = cut('😀'.repeat(10), 6)
    expect(out).toBe('😀😀…')
  })
})

describe('cutProse', () => {
  it('cuts prose keys and leaves identifiers alone', () => {
    const long = 'x'.repeat(TRIAGE_TEXT_MAX + 1)
    const out = cutProse({
      summary: long,
      questions: [{ id: long, recommended: long, text: long }],
      fixes: [{ path: long }],
    }) as {
      summary: string
      questions: { id: string; recommended: string; text: string }[]
      fixes: { path: string }[]
    }
    expect(out.summary).toHaveLength(TRIAGE_TEXT_MAX)
    expect(out.questions[0]?.text).toHaveLength(TRIAGE_TEXT_MAX)
    expect(out.questions[0]?.id).toBe(long)
    expect(out.questions[0]?.recommended).toBe(long)
    expect(out.fixes[0]?.path).toBe(long)
  })
})
