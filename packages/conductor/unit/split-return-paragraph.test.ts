import { describe, expect, it } from 'vitest'

import { splitReturnParagraph } from '../src/prompt.ts'

describe('splitReturnParagraph (#1263)', () => {
  const children = [
    { number: 11, title: 'first', stateReason: 'completed' as const },
    { number: 12, title: 'second', stateReason: 'not_planned' as const },
    { number: 13, title: 'third', stateReason: null },
  ]

  it('names every child and how it closed, a null reason as not reported', () => {
    const text = splitReturnParagraph(children, ['a'])
    expect(text).toContain('#11 first — closed as completed')
    expect(text).toContain('#12 second — closed as not planned')
    expect(text).toContain('#13 third — closed, reason not reported')
    expect(text).toContain('declare `AlreadyDone`')
  })

  it('says a child this pass did not read', () => {
    expect(splitReturnParagraph([{ number: 9, title: null, stateReason: null }], ['a'])).toContain(
      '#9 — closed; title and reason not read on this pass',
    )
  })

  it('forbids AlreadyDone where the ticket has no Done when section', () => {
    const text = splitReturnParagraph(children, null)
    expect(text).toContain('no `## Done when` section')
    expect(text).toContain('`Unclear`')
  })
})
