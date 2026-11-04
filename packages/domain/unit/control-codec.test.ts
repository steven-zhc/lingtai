/**
 * `ControlState`'s codec (0124 §1, #867): the state after every prefix of every
 * control history survives storage as text and as a parsed value, and a value of
 * another shape is refused by name.
 */
import { describe, expect, it } from 'vitest'

import type { Envelope } from '../src/index.ts'
import { ControlCodecError, decodeControl, emptyControl, encodeControl, reduceControlEvent } from '../src/index.ts'
import { histories, lateHistories, reducerFixtures } from '../test/histories.ts'

const streams: [string, readonly Envelope[]][] = [
  ...Object.entries(histories.control),
  ...Object.entries(lateHistories.control),
  ...Object.entries(reducerFixtures.control),
]

describe('decodeControl(encodeControl(s))', () => {
  for (const [name, events] of streams) {
    it(`is s after every prefix of ${name}`, () => {
      let s = emptyControl
      expect(decodeControl(encodeControl(s))).toStrictEqual(s)
      for (const event of events) {
        s = reduceControlEvent(s, event)
        expect(decodeControl(encodeControl(s))).toStrictEqual(s)
        expect(decodeControl(JSON.parse(encodeControl(s)))).toStrictEqual(s)
      }
    })
  }
})

describe('decodeControl refuses another shape, by name', () => {
  const full = JSON.parse(
    encodeControl(reducerFixtures.control.everyControlEvent.reduce(reduceControlEvent, emptyControl)),
  ) as Record<string, any>
  const without = (key: string) => {
    const { [key]: _gone, ...rest } = full
    return rest
  }
  const cases: [string, unknown, string][] = [
    ['not JSON', '{nope', 'not JSON'],
    ['a missing key', without('shutdown'), 'shutdown'],
    ['an extra key at the root', { ...full, extra: 1 }, 'extra'],
    ['an extra key inside requested.0', { ...full, requested: [{ ...full['requested'][0], extra: 1 }] }, 'requested.0'],
    ['a date that is not a date', { ...full, until: 'yesterday' }, 'until'],
    ['an unknown cause', { ...full, cause: 'nobody' }, 'cause'],
    [
      'an absent attempt in place of null',
      {
        ...full,
        discussions: [Object.fromEntries(Object.entries(full['discussions'][1]).filter(([k]) => k !== 'attempt'))],
      },
      'discussions.0.attempt',
    ],
  ]
  for (const [what, stored, path] of cases) {
    it(what, () => {
      expect(() => decodeControl(stored)).toThrow(ControlCodecError)
      expect(() => decodeControl(stored)).toThrow(path)
    })
  }
})
