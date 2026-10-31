import type { RunOnceResult } from '@lingtai/conductor'
import { describe, expect, it } from 'vitest'

import { startIsVerbose } from '../src/commands.ts'
import { costWords, endingLine, takingLine } from '../src/conduct.ts'

const strip = (s: string): string => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const summary = (over: Record<string, unknown> = {}) => ({
  ref: '1',
  title: 'Add the next chapter',
  ran: [
    { step: 'implement', ending: 'passed' },
    { step: 'build', ending: 'passed' },
    { step: 'review', ending: 'passed' },
    { step: 'proposed', ending: 'held' },
  ],
  cost: { usd: 0.4005, unknown: 0 },
  ...over,
})

const held = (wait: string): RunOnceResult => ({
  ok: 'held',
  ticketId: 'ticket-p-1',
  runId: 'r',
  headSha: 'abc',
  step: 'proposed',
  summary: summary({ wait }),
})

describe('startIsVerbose', () => {
  it('keeps lingtai daemon verbose and makes a plain start quiet', () => {
    expect(startIsVerbose('daemon', false)).toBe(true)
    expect(startIsVerbose('start', false)).toBe(false)
    expect(startIsVerbose('start', true)).toBe(true)
  })
})

describe('endingLine', () => {
  it('says what a held signoff is waiting for, with the command', () => {
    const line = strip(endingLine(held('SignoffRequired'), { project: 'chapter-garden-a' })!)
    expect(line).toContain('#1  Add the next chapter — implement ✓ build ✓ review ✓')
    expect(line).toContain('$0.40')
    expect(line).toContain('waiting for you: lingtai approve chapter-garden-a --issue 1')
    expect(line).not.toContain('proposed')
  })

  it('ends a held question with the answer command', () => {
    expect(endingLine(held('OwnQuestion'), { project: 'p' })).toContain('lingtai answer p --issue 1')
  })

  it('ends a landed pass with the short sha', () => {
    const line = endingLine(
      { ok: true, ticketId: 't-1', runId: 'r', mergeCommit: 'abcdef0123', summary: summary() },
      { project: 'p' },
    )
    expect(line).toMatch(/landed in abcdef0$/)
  })

  it('ends a stopped pass with the stage and detail, and marks the refusing step', () => {
    const line = strip(
      endingLine(
        {
          ok: false,
          ticketId: 't-1',
          runId: 'r',
          stage: 'build',
          detail: 'tests\nfailed',
          summary: summary({ ran: [{ step: 'build', ending: 'refused' }] }),
        },
        { project: 'p' },
      )!,
    )
    expect(line).toContain('build ✗')
    expect(line).toMatch(/stopped at build: tests failed$/)
  })

  it('prints nothing for a pass declined before any work', () => {
    expect(
      endingLine({ ok: false, ticketId: 't', runId: null, stage: 'claim', detail: 'x' }, { project: 'p' }),
    ).toBeNull()
  })

  it('prefixes the project only when asked', () => {
    expect(endingLine(held('SignoffRequired'), { project: 'p', prefixed: true })).toMatch(/^p {2}#1/)
    expect(takingLine('1', 'T', 'p')).toBe('p  taking #1  T')
    expect(takingLine('1', '')).toBe('taking #1')
  })
})

describe('costWords', () => {
  it('never prints an unknown as zero', () => {
    expect(costWords({ usd: 0.4, unknown: 0 })).toBe('$0.40')
    expect(costWords({ usd: 0, unknown: 2 })).toBe('cost unknown')
    expect(costWords({ usd: 0.4, unknown: 1 })).toBe('$0.40 + 1 unknown')
  })
})
