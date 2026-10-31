import { describe, expect, it } from 'vitest'

import { decisionCommits, renderDecisions } from '../src/decisions-changed.ts'

describe('decisionCommits', () => {
  it('takes an NNNN: subject, in log order', () => {
    expect(decisionCommits(['0121: b', '0104: a'])).toEqual([
      { adr: '0121', sentence: 'b' },
      { adr: '0104', sentence: 'a' },
    ])
  })
  it('does not take docs(…), fix(0121): …, a missing colon, or a leading space', () => {
    expect(
      decisionCommits(['docs(design): x', 'fix(0121): y', '0121 without a colon', ' 0121: z', '121: w', '0121:z']),
    ).toEqual([])
  })
})

const files = ['doc/decisions/0104-local.md', 'doc/decisions/0118', 'doc/decisions/0121-cli.md', 'doc/decisions/zh']

describe('renderDecisions', () => {
  const base = { repo: 'o/r', tag: 'v2', prev: 'v1', files }
  it('groups by ADR, ascending, links the file at the tag, oldest sentence first', () => {
    const out = renderDecisions({
      ...base,
      commits: [
        { adr: '0121', sentence: 'newer' },
        { adr: '0104', sentence: 'only' },
        { adr: '0121', sentence: 'older' },
      ],
    })
    expect(out).toBe(
      [
        '## Decisions',
        '',
        '- [0104](https://github.com/o/r/blob/v2/doc/decisions/0104-local.md)',
        '  - only',
        '- [0121](https://github.com/o/r/blob/v2/doc/decisions/0121-cli.md)',
        '  - older',
        '  - newer',
        '',
      ].join('\n'),
    )
  })
  it('prints a number with no file unlinked, and never matches a directory', () => {
    const out = renderDecisions({
      ...base,
      commits: [
        { adr: '0097', sentence: 'x' },
        { adr: '0118', sentence: 'y' },
      ],
    })
    expect(out).toContain('- 0097 (no file at v2)')
    expect(out).toContain('- 0118 (no file at v2)')
  })
  it('prints nothing when nothing is in range', () => {
    expect(renderDecisions({ ...base, commits: [] })).toBe('')
  })
  it('says so when there is no earlier release', () => {
    expect(renderDecisions({ ...base, prev: undefined, commits: [] })).toBe(
      '## Decisions\n\nNo earlier release to compare against.\n',
    )
  })
})
