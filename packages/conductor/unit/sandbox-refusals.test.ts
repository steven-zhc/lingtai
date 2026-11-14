/** #1157: which reads count as a refused host, and what a step's outcome is told. */
import type { RefusedRead } from '@lingtai/sandbox'
import { describe, expect, it } from 'vitest'

import { makeRefusalCollector, refusedHostsOf, sandboxOutcomeOf } from '../src/sandbox-record.ts'

const entry = (host: string | null, port: number | null, extra: { telemetry?: boolean; line?: string } = {}) => ({
  host,
  port,
  ...(extra.line === undefined ? {} : { line: extra.line }),
  count: 1,
  firstAt: '2026-01-01T00:00:00.000Z',
  telemetry: extra.telemetry ?? false,
})
const entries = (list: ReturnType<typeof entry>[], complete = true): RefusedRead => ({
  kind: 'entries',
  entries: list,
  complete,
})

describe('refusedHostsOf', () => {
  it('drops telemetry hosts (0127 §17), and an all-telemetry step leaves the outcome without a sandbox', () => {
    const reads = [entries([entry('o1.ingest.sentry.io', 443, { telemetry: true })])]
    expect(refusedHostsOf(reads)).toEqual([])
    expect(sandboxOutcomeOf(reads)).toBeUndefined()
  })

  it('treats an unreadable read as no refusal', () => {
    const reads: RefusedRead[] = [{ kind: 'unreadable', reason: 'srt said nothing' }]
    expect(refusedHostsOf(reads)).toEqual([])
    expect(sandboxOutcomeOf(reads)).toBeUndefined()
  })

  it('counts an incomplete read that still saw a real host', () => {
    expect(refusedHostsOf([entries([entry('example.com', 443)], false)])).toEqual(['example.com:443'])
  })

  it('names a host without a port by itself, and an unparsed line by the line', () => {
    expect(refusedHostsOf([entries([entry('example.com', null), entry(null, null, { line: 'deny weird' })])])).toEqual([
      'example.com',
      'deny weird',
    ])
  })

  it('keeps each host once, in first-seen order, across reads', () => {
    const reads = [entries([entry('a.com', 443), entry('b.com', 80)]), entries([entry('a.com', 443)])]
    expect(sandboxOutcomeOf(reads)).toEqual({ refused: ['a.com:443', 'b.com:80'] })
  })
})

describe('makeRefusalCollector', () => {
  it('drains a step’s reads once, so a second visit sees only its own', () => {
    const collector = makeRefusalCollector()
    collector.record('build', entries([entry('a.com', 443)]))
    collector.record('review', entries([entry('b.com', 443)]))
    expect(refusedHostsOf(collector.drain('build'))).toEqual(['a.com:443'])
    expect(collector.drain('build')).toEqual([])
    collector.record('build', entries([entry('c.com', 443)]))
    expect(refusedHostsOf(collector.drain('build'))).toEqual(['c.com:443'])
    expect(refusedHostsOf(collector.drain('review'))).toEqual(['b.com:443'])
  })
})
