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

  it('keeps quoted text that merely starts alike, and the requirements after it', () => {
    const brief = 'Do this.\n\nThis step was interrupted (quoted); more text.\n\nAlso do that.'
    expect(withRedoParagraph(brief, now)).toBe(`${brief}\n\n${now}`)
  })
})

describe('redoParagraph with an unreadable outcome (#1398)', () => {
  const note = { why: 'the agent did not finish: x', startedAt: 'aaa', head: 'bbb' }
  it('quotes the tail and the block, and leaves a crash redo as it was', () => {
    expect(redoParagraph(note)).not.toContain('No outcome')
    const p = redoParagraph({ ...note, unread: 'all done\n```\nImplemented' })
    expect(p).toContain('    all done\n    ```\n    Implemented')
    expect(p).toContain('No outcome could be read from it.')
    expect(
      p.endsWith(
        '    ```outcome\n    {"outcome": "Implemented"}\n    ```\n\nor another block as the brief above shows it.',
      ),
    ).toBe(true)
  })
  it('replaces a recorded brief that ends in the paragraph with exactly one', () => {
    const first = withRedoParagraph('brief', redoParagraph({ ...note, unread: 'one' }))
    const second = withRedoParagraph(first, redoParagraph({ ...note, unread: 'two' }))
    expect(second).toBe(`brief\n\n${redoParagraph({ ...note, unread: 'two' })}`)
    expect(withRedoParagraph(first, redoParagraph(note))).toBe(`brief\n\n${redoParagraph(note)}`)
  })
})
