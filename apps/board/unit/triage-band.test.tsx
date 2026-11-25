import type { AdvisedCause, Cause, TriageStatus, WaitReason } from '@lingtai/domain/wait'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TriageBand } from '../src/app/standing.tsx'
import { triageHeadLine, type MirrorHead } from '../src/lib/triage-head.ts'

function draw(status: TriageStatus, headLine?: string): string {
  const reason: WaitReason = { _tag: 'OwnQuestion', question: 'why?', by: 'person' }
  return renderToStaticMarkup(<TriageBand reason={reason} status={status} headLine={headLine} />)
}

function advised(cause: AdvisedCause): TriageStatus {
  return {
    _tag: 'Done',
    result: { _tag: 'TriageAdvised', cause, resolution: 'Close', summary: '<plain summary>', want: null },
  }
}

function answered(cause: Cause): TriageStatus {
  return { _tag: 'Done', result: { _tag: 'TriageAnswered', cause, summary: '<plain summary>', want: null } }
}

describe('a TriageAnswered band', () => {
  it('names the cause and its parts, and says no action was advised', () => {
    const html = draw(answered({ _tag: 'WrongApproach', why: 'the cache is the wrong layer' }))
    expect(html).toContain('The approach is wrong')
    expect(html).toContain('the cache is the wrong layer')
    expect(html).not.toContain('Triage advised')
  })

  it('draws a contradicting hunk with its reason', () => {
    const html = draw(
      answered({
        _tag: 'ConflictingHunks',
        hunks: [{ _tag: 'Contradicting', path: 'a.ts', line: 4, why: 'both sides delete it differently' }],
        total: 1,
      }),
    )
    expect(html).toContain('Contradicting · 1')
    expect(html).toContain('a.ts:4')
    expect(html).toContain('both sides delete it differently')
  })

  it('draws Unfinished, SetupBroken and a plan-less TicketTooBig', () => {
    expect(draw(answered({ _tag: 'Unfinished', addToBody: 'name the file' }))).toContain(
      'Add to the ticket: name the file',
    )
    expect(draw(answered({ _tag: 'SetupBroken', what: 'no token', repair: 'export it' }))).toContain(
      'no token — export it',
    )
    expect(draw(answered({ _tag: 'TicketTooBig', plan: null, spentOn: 'the parser' }))).toContain('the parser')
  })
})

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
    expect(draw(status)).not.toContain('cause-chip')
  })

  it('draws a failure without advice', () => {
    const html = draw({ _tag: 'Done', result: { _tag: 'TriageFailed', why: '<failed>' } })
    expect(html).toContain('&lt;failed&gt;')
    expect(html).not.toContain('Recommends')
    expect(html).not.toContain('cause-chip')
  })

  it.each([
    [{ at: '9876543210abcdef' }, 'Triage read abcdef1; mirror head, as of its last fetch: 9876543.'],
    [{ missing: true }, 'The branch is no longer in the mirror.'],
    [{ unreadable: 'git failed' }, 'Could not read the mirror: git failed'],
  ] as const)('shows the mirror warning beside a failed triage: %j', (mirror, warning) => {
    const html = draw(
      { _tag: 'Done', result: { _tag: 'TriageFailed', why: '<failed>' } },
      triageHeadLine('abcdef1234567890', mirror as MirrorHead) ?? undefined,
    )
    expect(html).toContain(warning)
    expect(html.match(/<p>/g)).toHaveLength(2)
    expect(html).toContain('triage-band--failed')
    expect(html).toContain('triage failed: “&lt;failed&gt;”')
  })

  it('draws questions as answer choices with the recommendation selected', () => {
    const html = draw(
      advised({
        _tag: 'UndecidedQuestion',
        questions: [
          {
            id: 'q',
            text: '<question>',
            answers: [
              { id: 'a', text: '<answer>' },
              { id: 'b', text: '<other answer>' },
            ],
            recommended: 'a',
          },
        ],
      }),
    )
    expect(html).toContain('<legend class="triage-choices-question">1. &lt;question&gt;</legend>')
    expect(html).toContain('<span class="triage-choice-text">&lt;answer&gt;</span>')
    expect(html).toContain('<span class="triage-choice-text">&lt;other answer&gt;</span>')
    expect(html).toContain('<span class="triage-choice-selected">Selected</span>')
    expect(html).toContain('<span class="triage-choice-recommended">Recommended</span>')
    expect(html).toContain('type="radio"')
    expect(html).toContain('checked="" value="a"')
    expect(html).toContain('&lt;plain summary&gt;')
  })

  it('draws each fix with its location', () => {
    const html = draw(
      advised({
        _tag: 'FixableLines',
        fixes: [
          { path: 'src/a.ts', line: 8, what: 'change this' },
          { path: 'src/b.ts', line: null, what: 'check that' },
        ],
      }),
    )
    expect(html).toContain('<ol class="triage-fixes">')
    expect(html).toContain(
      '<span class="triage-path">src/a.ts</span><span class="triage-line">:8</span></span><span>change this</span>',
    )
    expect(html).toContain('<span class="triage-path">src/b.ts</span></span><span>check that</span>')
    expect(html).toContain('title="src/a.ts:8"')
    expect(html).not.toContain('src/b.ts:?')
  })

  it('puts the cause chip on the head line, and the evidence once', () => {
    const html = draw(advised({ _tag: 'FixableLines', fixes: [{ path: 'src/a.ts', line: 8, what: 'change this' }] }))
    expect(html).toMatch(
      /<div class="triage-head"><span class="triage-label sec-h">Triage<\/span><p class="triage-cause /,
    )
    expect(html.match(/class="triage-evidence"/g)).toHaveLength(1)
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
    expect(html).toContain('Mechanical · 1')
    expect(html).toContain('Divergent · 1 question')
    expect(html).toContain('src/a.ts:4</span><span>Mechanical</span>')
    expect(html).toContain('src/b.ts:9</span><fieldset class="triage-choices">')
    expect(html).not.toContain('<details')
    expect(html).toContain('&lt;which behavior?&gt;')
    expect(html).toContain('keep A')
    expect(html).toContain('<span class="triage-choice-text">keep B</span>')
    expect(html).toContain('<span class="triage-choice-recommended">Recommended</span>')
    expect(html).toContain('checked="" value="b"')
  })

  it('draws an empty conflict list without inventing a hunk or a question', () => {
    const html = draw(advised({ _tag: 'ConflictingHunks', total: 0, hunks: [] }))
    expect(html).toContain('0 conflicting hunks')
    expect(html).not.toContain('triage-hunk-group')
    expect(html).not.toContain('start over from the new base')
  })

  it('keeps triage visible with a mirror-head line', () => {
    const html = draw(advised({ _tag: 'WrongApproach' }), 'mirror head, as of its last fetch: 9876543')
    expect(html).toContain('mirror head, as of its last fetch: 9876543')
    expect(html).toContain('The approach is wrong')
    expect(html.match(/mirror head, as of its last fetch/g)).toHaveLength(1)
  })

  it.each(['WrongApproach', 'TicketTooBig', 'SetupBroken'] as const)('%s has its summary alone', (_tag) => {
    const html = draw(advised({ _tag }))
    expect(html).not.toContain(_tag)
    expect(html).toContain('&lt;plain summary&gt;')
    expect(html).toContain('Recommends Close')
  })
})

describe('every question kind (#1255)', () => {
  // The recommended answer is the second the agent wrote.
  const question = {
    id: 'q',
    text: '<question>',
    answers: [
      { id: 'a', text: '<first>' },
      { id: 'b', text: '<second>' },
      { id: 'c', text: '<third>' },
    ],
    recommended: 'b',
  }
  const ordered = (html: string) => {
    const at = (s: string) => html.indexOf(`>${s}<`)
    expect(html).toContain('1. &lt;question&gt;')
    const order = ['&lt;second&gt;', '&lt;first&gt;', '&lt;third&gt;', 'My own answer'].map(at)
    expect(order.every((n) => n >= 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    // Recommended sits on the first rendered choice.
    expect(html.indexOf('Recommended')).toBeGreaterThan(order[0]!)
    expect(html.indexOf('Recommended')).toBeLessThan(order[1]!)
  }

  it('triage UndecidedQuestion', () => {
    ordered(draw(advised({ _tag: 'UndecidedQuestion', questions: [question] })))
  })

  it('a ConflictingHunks divergent hunk', () => {
    ordered(
      draw(
        advised({
          _tag: 'ConflictingHunks',
          total: 1,
          hunks: [{ _tag: 'Divergent', path: 'a.ts', line: 3, question }],
        }),
      ),
    )
  })
})
