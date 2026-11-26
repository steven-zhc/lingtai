/**
 * `TicketState`'s codec (0124 §1, #833): the state after every prefix of every
 * ticket history survives storage as text (SQLite) and as a parsed value
 * (Postgres `jsonb`), and a value of another shape is refused by name.
 *
 * A fixture payload that carried an explicit `undefined` key would fail the
 * round trip without a defect in the codec — a real log cannot hold one, since
 * payloads come back from JSON — so such a failure is the fixture's to fix.
 */
import { describe, expect, it } from 'vitest'

import type { Envelope } from '../src/index.ts'
import { reduceTicketEvent, decodeTicket, emptyTicket, encodeTicket } from '../src/index.ts'
import { histories, lateHistories, scenarios } from '../test/histories.ts'

const streams: [string, readonly Envelope[]][] = [
  ...Object.entries(histories.ticket),
  ...Object.entries(lateHistories.ticket),
  ...Object.entries(scenarios).map(([name, s]) => [name, s.ticket] as [string, readonly Envelope[]]),
]

describe('decodeTicket(encodeTicket(s))', () => {
  for (const [name, events] of streams) {
    it(`is s after every prefix of ${name}`, () => {
      let s = emptyTicket
      expect(decodeTicket(encodeTicket(s), 'ticket_report')).toStrictEqual(s)
      for (const event of events) {
        s = reduceTicketEvent(s, event)
        expect(decodeTicket(encodeTicket(s), 'ticket_report')).toStrictEqual(s)
        expect(decodeTicket(JSON.parse(encodeTicket(s)), 'ticket_report')).toStrictEqual(s)
      }
    })
  }

  it('keeps lastSeq a bigint and holds it as a string', () => {
    const s = streams.flatMap(([, e]) => e).reduce(reduceTicketEvent, emptyTicket)
    expect(typeof s.lastSeq).toBe('bigint')
    expect(typeof JSON.parse(encodeTicket(s)).lastSeq).toBe('string')
  })
})

describe('decodeTicket refuses another shape', () => {
  const good = JSON.parse(encodeTicket(streams.flatMap(([, e]) => e).reduce(reduceTicketEvent, emptyTicket)))

  it('names the field and the rebuild when a field is missing', () => {
    const { waits: _waits, ...rest } = good
    expect(() => decodeTicket(rest, 'ticket_report', 'ticket-x-1')).toThrow(
      /ticket-x-1.*waits.*lingtai projection rebuild ticket_report/s,
    )
  })

  it('refuses a lastSeq stored as a number', () => {
    expect(() => decodeTicket({ ...good, lastSeq: 12 }, 'ticket_report')).toThrow(
      /lastSeq.*lingtai projection rebuild ticket_report/s,
    )
  })

  it('refuses a field the nested event schemas would strip', () => {
    const withWait = streams.flatMap(([, e]) => e).reduce(reduceTicketEvent, emptyTicket)
    expect(withWait.waits.length).toBeGreaterThan(0)
    const bad = structuredClone(good)
    bad.waits[0].reason.fromAnotherShape = 1
    expect(() => decodeTicket(bad, 'ticket_report', 'ticket-x-1')).toThrow(
      /waits\.0\.reason\.fromAnotherShape.*lingtai projection rebuild ticket_report/s,
    )
    const own = structuredClone(good)
    own.waits[0].reason = { _tag: 'OwnQuestion', question: 'q', extra: 'x' }
    expect(() => decodeTicket(own, 'ticket_report')).toThrow(/rebuild/)
  })

  it('refuses an inherited-looking key such as __proto__ inside a reason', () => {
    const own = structuredClone(good)
    own.waits[0].reason = JSON.parse('{"_tag":"OwnQuestion","question":"q","__proto__":{}}')
    expect(() => decodeTicket(own, 'ticket_report')).toThrow(/rebuild/)
    expect(() => decodeTicket(JSON.stringify(own), 'ticket_report')).toThrow(/rebuild/)
  })

  it('refuses a field it does not know, null, and text that is not JSON', () => {
    expect(() => decodeTicket({ ...good, extra: 1 }, 'ticket_report')).toThrow(/rebuild/)
    expect(() => decodeTicket(null, 'ticket_report')).toThrow(/ticket_state.*rebuild/s)
    expect(() => decodeTicket('{nope', 'ticket_report')).toThrow(/not JSON.*rebuild/s)
  })
})

describe('a row written before #1268', () => {
  it('is refused naming the rebuild, never read as zero new attempts', () => {
    const { newAttempts: _gone, ...rest } = JSON.parse(encodeTicket(emptyTicket)) as Record<string, unknown>
    const old = { ...rest, restarts: [{ after: 'r1', restart: 1 }] }
    expect(() => decodeTicket(old, 'task_view')).toThrow(/lingtai projection rebuild task_view/)
  })
})

describe('a wait resolution keeps its at (#1495)', () => {
  const env = (seq: bigint, type: string, data: unknown, at: string) =>
    ({ seq, streamId: 'ticket-x-1', version: 1, type, schemaVer: 1, data, at: new Date(at) }) as unknown as Envelope
  const waitId = 'wait-1'
  const state = [
    env(
      1n,
      'WaitStarted',
      { waitId, reason: { _tag: 'OwnQuestion', question: 'q', by: 'steven' } },
      '2026-11-25T05:09:00Z',
    ),
    env(
      2n,
      'WaitResolved',
      { waitId, resolution: { _tag: 'Close' }, by: 'human:steven', note: 'done' },
      '2026-11-25T05:11:00Z',
    ),
  ].reduce(reduceTicketEvent, emptyTicket)

  it('reads the WaitResolved time back through encode and decode', () => {
    expect(state.waits[0]?.resolution?.at).toEqual(new Date('2026-11-25T05:11:00Z'))
    const back = decodeTicket(JSON.parse(encodeTicket(state)), 'ticket_report')
    expect(back.waits[0]?.resolution?.at).toEqual(new Date('2026-11-25T05:11:00Z'))
  })

  it('refuses a version-15 row whose resolution has no at', () => {
    const old = JSON.parse(encodeTicket(state))
    delete old.waits[0].resolution.at
    expect(() => decodeTicket(old, 'ticket_report')).toThrow(/rebuild/)
  })
})
