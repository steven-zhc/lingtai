/**
 * `AttemptState`'s codec (0124 §1, #844): the state after every prefix of every run
 * history survives storage as text (SQLite) and as a parsed value (Postgres
 * `jsonb`), and a value of another shape is refused by name.
 */
import { describe, expect, it } from 'vitest'

import type { Envelope } from '../src/index.ts'
import { reduceAttemptEvent, decodeRun, emptyAttempt, encodeRun } from '../src/index.ts'
import { histories, lateHistories, lateScenarios, scenarios } from '../test/histories.ts'

const streams: [string, readonly Envelope[]][] = [
  ...Object.entries(histories.attempt),
  ...Object.entries(lateHistories.attempt),
  ...Object.entries({ ...scenarios, ...lateScenarios }).flatMap(([name, s]) =>
    s.runs.map((events, i) => [`${name}.run${i}`, events] as [string, readonly Envelope[]]),
  ),
]

describe('decodeRun(encodeRun(s))', () => {
  let largest = 0
  for (const [name, events] of streams) {
    it(`is s after every prefix of ${name}`, () => {
      let s = emptyAttempt
      expect(decodeRun(encodeRun(s), 'task_view')).toStrictEqual(s)
      for (const event of events) {
        s = reduceAttemptEvent(s, event)
        const encoded = encodeRun(s)
        largest = Math.max(largest, Buffer.byteLength(encoded))
        expect(decodeRun(encoded, 'task_view')).toStrictEqual(s)
        expect(decodeRun(JSON.parse(encoded), 'task_view')).toStrictEqual(s)
      }
    })
  }

  it('keeps lastSeq a bigint and holds it as a string', () => {
    const s = streams[0]![1].reduce(reduceAttemptEvent, emptyAttempt)
    expect(typeof s.lastSeq).toBe('bigint')
    expect(typeof JSON.parse(encodeRun(s)).lastSeq).toBe('string')
  })

  it('records the largest encoded state across the fixtures', () => {
    // So the cost of storing the whole state is on record (#844): printed, not asserted.
    console.info(`largest encoded AttemptState across the fixtures: ${largest} bytes`)
    expect(largest).toBeGreaterThan(0)
  })
})

describe('decodeRun keeps a finding’s optional fields', () => {
  it('round-trips class and reachableBecause on a step finding', () => {
    const base = streams.flatMap(([, e]) => e).reduce(reduceAttemptEvent, emptyAttempt)
    const finding = { file: 'a.ts', line: 3, claim: 'c', failureScenario: 'f', severity: 'major' as const }
    const s = {
      ...base,
      steps: {
        'review:cold': {
          step: 'review',
          onSha: 'sha-1',
          by: null,
          reason: null,
          verdict: 'failed' as const,
          evidence: null,
          findings: [{ ...finding, class: 'k', reachableBecause: 'r' }, finding],
        },
      },
    }
    expect(decodeRun(encodeRun(s), 'task_view')).toStrictEqual(s)
  })
})

describe('decodeRun refuses another shape', () => {
  const good = JSON.parse(encodeRun(streams.flatMap(([, e]) => e).reduce(reduceAttemptEvent, emptyAttempt)))

  it('names the run and the rebuild when a field is missing', () => {
    const { steps: _steps, ...rest } = good
    expect(() => decodeRun(rest, 'task_view', 'pass-x')).toThrow(/pass-x.*steps.*lingtai projection rebuild task_view/s)
  })

  it('refuses a lastSeq stored as a number', () => {
    expect(() => decodeRun({ ...good, lastSeq: 12 }, 'task_view')).toThrow(
      /lastSeq.*lingtai projection rebuild task_view/s,
    )
  })

  it('refuses text that is not JSON', () => {
    expect(() => decodeRun('{', 'task_view', 'pass-x')).toThrow(/not JSON.*lingtai projection rebuild task_view/s)
  })
})

describe('a stored step without summary or clipped (#893)', () => {
  it('decodes and re-encodes identically', () => {
    const base = JSON.parse(encodeRun(emptyAttempt))
    const step = {
      step: 'review:x',
      onSha: 'a',
      by: null,
      reason: null,
      verdict: 'passed',
      evidence: null,
      findings: [],
    }
    const stored = JSON.stringify({ ...base, steps: { 'review:x': step } })
    expect(encodeRun(decodeRun(stored, 'task_view'))).toBe(stored)
    const withSummary = JSON.stringify({
      ...base,
      steps: { 'review:x': { ...step, summary: 'It moves.', clipped: { read: 1, of: 2 } } },
    })
    expect(encodeRun(decodeRun(withSummary, 'task_view'))).toBe(withSummary)
  })
})
