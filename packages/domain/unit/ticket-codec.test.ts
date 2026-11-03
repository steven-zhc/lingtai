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
import { applyTicket, decodeTicket, emptyTicket, encodeTicket } from '../src/index.ts'
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
        s = applyTicket(s, event)
        expect(decodeTicket(encodeTicket(s), 'ticket_report')).toStrictEqual(s)
        expect(decodeTicket(JSON.parse(encodeTicket(s)), 'ticket_report')).toStrictEqual(s)
      }
    })
  }

  it('keeps lastSeq a bigint and holds it as a string', () => {
    const s = streams.flatMap(([, e]) => e).reduce(applyTicket, emptyTicket)
    expect(typeof s.lastSeq).toBe('bigint')
    expect(typeof JSON.parse(encodeTicket(s)).lastSeq).toBe('string')
  })
})

describe('decodeTicket refuses another shape', () => {
  const good = JSON.parse(encodeTicket(streams.flatMap(([, e]) => e).reduce(applyTicket, emptyTicket)))

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

  it('refuses a field it does not know, null, and text that is not JSON', () => {
    expect(() => decodeTicket({ ...good, extra: 1 }, 'ticket_report')).toThrow(/rebuild/)
    expect(() => decodeTicket(null, 'ticket_report')).toThrow(/ticket_state.*rebuild/s)
    expect(() => decodeTicket('{nope', 'ticket_report')).toThrow(/not JSON.*rebuild/s)
  })
})
