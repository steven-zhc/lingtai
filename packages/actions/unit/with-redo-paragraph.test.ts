/** A recorded brief carries the new redo paragraph near its top, never two (#1246, #1404). */
import { describe, expect, it } from 'vitest'

import { ENDING_MARK, redoParagraph, withRedoParagraph } from '../src/index.ts'

describe('withRedoParagraph', () => {
  const now = redoParagraph({ why: 'a person asked to redo it', startedAt: 'a1', head: 'b2' })
  const open = `${ENDING_MARK} of JSON; says where.**\n**The second line.**\n\n`

  it('puts the paragraph at the top of a brief that has none, and leaves it alone with none to add', () => {
    expect(withRedoParagraph('the brief', now)).toBe(`${now}\n\nthe brief`)
    expect(withRedoParagraph(`${open}the brief`, now)).toBe(`${open}${now}\n\nthe brief`)
    expect(withRedoParagraph('the brief', null)).toBe('the brief')
  })

  it('replaces the paragraph a cut-off redo already carried, in the new layout', () => {
    const before = redoParagraph({ why: 'a crash', startedAt: 'x', head: 'y' })
    expect(withRedoParagraph(`${open}${before}\n\nthe brief`, now)).toBe(`${open}${now}\n\nthe brief`)
  })

  it('strips the trailing paragraph of a brief recorded before it moved, and places the new one at the top', () => {
    const before = redoParagraph({ why: 'a crash', startedAt: 'x', head: 'y' }).replace('below', 'above')
    expect(withRedoParagraph(`${open}the brief\n\n${before}`, now)).toBe(`${open}${now}\n\nthe brief`)
  })

  it('replaces it in place when a header or the recipe words come before it', () => {
    const before = redoParagraph({ why: 'a crash', startedAt: 'x', head: 'y' })
    const brief = `${open}# Header\n\nIntro.\n\n${before}\n\n## Findings\n\nbody`
    expect(withRedoParagraph(brief, now)).toBe(`${open}# Header\n\nIntro.\n\n${now}\n\n## Findings\n\nbody`)
  })

  it('keeps quoted text that merely starts alike, and the requirements after it', () => {
    const brief = 'Do this.\n\nThis step was interrupted (quoted); more text.\n\nAlso do that.'
    expect(withRedoParagraph(brief, now)).toBe(`${now}\n\n${brief}`)
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
        '    ```outcome\n    {"outcome": "Implemented"}\n    ```\n\nor another block as the brief below shows it.',
      ),
    ).toBe(true)
  })
  it('replaces a recorded brief that opens with the paragraph with exactly one', () => {
    const first = withRedoParagraph('brief', redoParagraph({ ...note, unread: 'one' }))
    const second = withRedoParagraph(first, redoParagraph({ ...note, unread: 'two' }))
    expect(second).toBe(`${redoParagraph({ ...note, unread: 'two' })}\n\nbrief`)
    expect(withRedoParagraph(first, redoParagraph(note))).toBe(`${redoParagraph(note)}\n\nbrief`)
  })
})
