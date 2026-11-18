import type { Root } from '@lingtai/conductor/why-nothing-runs'
import type { Lock } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WhyNothingRuns } from '../src/app/queued-stream.tsx'
import { whyLine } from '../src/lib/why-line.ts'

const account = (named: Extract<Lock, { kind: 'account' }>['named']): Lock => ({
  kind: 'account',
  account: 'claude-code',
  by: 'lingtai',
  since: new Date(2026, 10, 16, 18, 0),
  until: new Date(2026, 10, 16, 23, 20),
  untilFrom: 'message',
  said: 'limit reached',
  named,
})

const lockRoot = (lock: Lock): Root => ({
  root: 'lock',
  sentence: 'Claude Code reset 23:20 — lingtai account lift claude-code — see above',
  tickets: [1, 2],
  lock,
})

describe('whyLine (#1216)', () => {
  it('sends a lock root up to the banner and names the limit without its reset or Lift', () => {
    const line = whyLine('lingtai', lockRoot(account({ kind: '5-hour', resetsAt: new Date(2026, 10, 16, 23, 20) })))
    expect(line.tone).toBe('lock')
    expect(line.segments).toEqual([{ kind: 'text', text: "held by Claude Code's 5-hour limit — see above" }])
  })

  it('names a monthly spend limit as such, and an unnamed limit as a usage limit', () => {
    expect(whyLine('p', lockRoot(account({ kind: 'monthly-spend', resetsAt: null }))).segments[0]).toEqual({
      kind: 'text',
      text: "held by Claude Code's monthly spend limit — see above",
    })
    expect(whyLine('p', lockRoot(account(null))).segments[0]).toEqual({
      kind: 'text',
      text: "held by claude-code's usage limit — see above",
    })
  })

  it('names the ceiling and a pause, and nothing dated', () => {
    const ceiling: Lock = {
      kind: 'ceiling',
      since: new Date(),
      day: '2026-11-16',
      reportedUsd: 90,
      estimatedUsd: 10,
      ceilingUsd: 100,
      until: new Date(),
    }
    expect(whyLine('p', lockRoot(ceiling)).segments[0]).toEqual({
      kind: 'text',
      text: "held by today's spend ceiling — see above",
    })
    const paused: Lock = { kind: 'paused', by: 'sam', since: new Date() }
    expect(whyLine('lingtai', lockRoot(paused)).segments[0]).toEqual({
      kind: 'text',
      text: "held by lingtai's pause — see above",
    })
  })

  it('colours a red base red and the daemon down, with the command as code', () => {
    const base: Root = {
      root: 'base-red',
      sentence: 'main is red at abc1234 (`pnpm test`); 2 tickets wait for it',
      tickets: [1, 2],
    }
    const line = whyLine('p', base)
    expect(line.tone).toBe('red')
    expect(line.segments.map((s) => s.kind)).toEqual(['text', 'code', 'text'])
    expect(whyLine('p', { root: 'no-daemon', sentence: 'the daemon is not running', tickets: [1] }).tone).toBe('down')
  })

  it('links the ticket a chain ends at only when it waits on a person', () => {
    const chain = (waits: boolean): Root => ({
      root: 'chain',
      sentence: '3 tickets wait on #7, which waits on you',
      tickets: [1, 2, 3],
      on: { ref: 7, waits },
    })
    const person = whyLine('p', chain(true))
    expect(person.tone).toBe('person')
    expect(person.segments).toContainEqual({ kind: 'ticket', text: '#7', ref: 7 })
    const other = whyLine('p', chain(false))
    expect(other.tone).toBe('')
    expect(other.segments.every((s) => s.kind === 'text')).toBe(true)
  })
})

describe('WhyNothingRuns (#1216)', () => {
  const why = {
    project: 'lingtai',
    why: {
      roots: [
        lockRoot(account({ kind: '5-hour', resetsAt: null })),
        { root: 'chain', sentence: 'x', tickets: [3, 4], on: { ref: 9, waits: false } } as Root,
      ],
    },
  }

  it('draws the first root, the count of the others, and no project name for one project', () => {
    const out = renderToStaticMarkup(<WhyNothingRuns why={[why]} showProject={false} />)
    expect(out).toContain('class="whynot lock"')
    expect(out).toContain('why nothing runs')
    expect(out).toContain('held by Claude Code&#x27;s 5-hour limit — see above')
    expect(out).toContain('and 2 more for other reasons')
    expect(out).not.toContain('<strong>')
    expect(out).not.toContain('lingtai account lift')
  })

  it('prefixes the project when several are in view, and draws nothing for none', () => {
    expect(renderToStaticMarkup(<WhyNothingRuns why={[why]} showProject />)).toContain('<strong>lingtai: </strong>')
    expect(renderToStaticMarkup(<WhyNothingRuns why={[]} showProject={false} />)).toBe('')
  })
})
