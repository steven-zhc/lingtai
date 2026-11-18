/** A recorded brief ends with the new redo paragraph, never two (#1246). */
import { describe, expect, it } from 'vitest'

import { redoParagraph, withRedoParagraph } from '../src/index.ts'

describe('withRedoParagraph', () => {
  const now = redoParagraph({ why: 'a person asked to redo it', startedAt: 'a1', head: 'b2' })

  it('appends the paragraph to a brief that has none, and leaves it alone with none to add', () => {
    expect(withRedoParagraph('the brief', now)).toBe(`the brief\n\n${now}`)
    expect(withRedoParagraph('the brief', null)).toBe('the brief')
  })

  it('replaces the paragraph a cut-off redo already carried', () => {
    const before = redoParagraph({ why: 'a crash', startedAt: 'x', head: 'y' })
    expect(withRedoParagraph(`the brief\n\n${before}`, now)).toBe(`the brief\n\n${now}`)
  })
})
