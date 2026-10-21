import type { RootCause, TriageStatus, WaitReason } from '@lingtai/domain/wait'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TriageBand } from '../src/app/standing.tsx'

function draw(status: TriageStatus): string {
  const reason: WaitReason = { _tag: 'OwnQuestion', question: 'why?', by: 'person' }
  return renderToStaticMarkup(<TriageBand reason={reason} status={status} />)
}

function advised(cause: RootCause): TriageStatus {
  return {
    _tag: 'Done',
    result: { _tag: 'TriageAdvised', cause, resolution: 'Close', summary: '<plain summary>', want: null },
  }
}

describe('current wait triage band', () => {
  it.each(['NotNeeded', 'NotDeclared'] as const)('%s draws no band', (_tag) => {
    expect(draw({ _tag })).toBe('')
  })

  it.each([
    [{ _tag: 'Queued' }, 'triage is waiting to run'],
    [{ _tag: 'Running' }, 'triage is running'],
    [{ _tag: 'Interrupted' }, 'the daemon stopped during triage'],
  ] as const)('%s draws its progress', (status, words) => {
    expect(draw(status)).toContain(words)
  })

  it('draws a failure without advice', () => {
    const html = draw({ _tag: 'Done', result: { _tag: 'TriageFailed', why: '<failed>' } })
    expect(html).toContain('&lt;failed&gt;')
    expect(html).not.toContain('Recommends')
  })

  it('draws questions and their recommended answer as text', () => {
    const html = draw(
      advised({
        _tag: 'UndecidedQuestion',
        questions: [{ id: 'q', text: '<question>', answers: [{ id: 'a', text: '<answer>' }], recommended: 'a' }],
      }),
    )
    expect(html).toContain('&lt;question&gt;')
    expect(html).toContain('&lt;answer&gt; (recommended)')
    expect(html).toContain('&lt;plain summary&gt;')
  })

  it('draws each fix with its location', () => {
    expect(
      draw(advised({ _tag: 'FixableLines', fixes: [{ path: 'src/a.ts', line: 8, what: 'change this' }] })),
    ).toContain('src/a.ts:8 — change this')
  })

  it('draws a conflict count and the new-base recommendation past 20', () => {
    const html = draw(advised({ _tag: 'ConflictingHunks', total: 21, hunks: [] }))
    expect(html).toContain('21 conflicting hunks')
    expect(html).not.toContain('<details')
    expect(html).toContain('start over from the new base')
  })

  it('lists every hunk, opening only divergent ones with their questions', () => {
    const html = draw(
      advised({
        _tag: 'ConflictingHunks',
        total: 2,
        hunks: [
          { _tag: 'Mechanical', path: 'src/a.ts', line: 4 },
          {
            _tag: 'Divergent',
            path: 'src/b.ts',
            line: 9,
            question: {
              id: 'q',
              text: '<which behavior?>',
              answers: [
                { id: 'a', text: 'keep A' },
                { id: 'b', text: 'keep B' },
              ],
              recommended: 'b',
            },
          },
        ],
      }),
    )
    expect(html).toContain('<details><summary>src/a.ts:4 — Mechanical</summary></details>')
    expect(html).toContain('<details open=""><summary>src/b.ts:9 — Divergent</summary>')
    expect(html).toContain('&lt;which behavior?&gt;')
    expect(html).toContain('keep A')
    expect(html).toContain('keep B (recommended)')
  })

  it.each(['WrongApproach', 'TicketTooBig', 'SetupBroken'] as const)('%s has its summary alone', (_tag) => {
    const html = draw(advised({ _tag }))
    expect(html).toContain(_tag)
    expect(html).toContain('&lt;plain summary&gt;')
    expect(html).toContain('Recommends Close')
  })
})
