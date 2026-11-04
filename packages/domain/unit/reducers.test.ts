/**
 * The version table (0124 §3, #867). A reducer's result over its fixture is
 * hashed; the hash is committed beside the version it belongs to; a result that
 * no longer matches fails here, naming the reducer.
 *
 * The hash is over the encoded state after every prefix of the fixture, joined
 * with newlines, so a change to a case that a later event overwrites still
 * reaches it. The clock is not part of it: a reducer's state is a function of
 * the events alone (0124 §2).
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { REDUCERS } from '../src/index.ts'
import type { Envelope, Reducer } from '../src/index.ts'
import { COVERS, reducerFixtures } from '../test/histories.ts'
import versions from './reducer-versions.json' with { type: 'json' }

const FIXTURE: Record<string, readonly Envelope[]> = { control: reducerFixtures.control.everyControlEvent }

function hashOver(reducer: Reducer<unknown>, events: readonly Envelope[]): string {
  let s = reducer.initial
  const encoded = [reducer.encode(s)]
  for (const e of events) {
    s = reducer.reduceEvent(s, e)
    encoded.push(reducer.encode(s))
  }
  return createHash('sha256').update(encoded.join('\n')).digest('hex')
}

describe('REDUCERS', () => {
  for (const [key, reducer] of Object.entries(REDUCERS) as [string, Reducer<unknown>][]) {
    it(`${key}: is registered under its own name`, () => {
      expect(reducer.name).toBe(key)
    })

    it(`${key}: has a fixture`, () => {
      expect(
        FIXTURE[reducer.name],
        `\`${reducer.name}\` is registered and has no fixture in reducers.test.ts`,
      ).toBeDefined()
    })

    it(`${key}: its fixture holds every type it handles`, () => {
      const covers = (COVERS as Record<string, readonly string[]>)[reducer.name]
      expect(covers, `COVERS has no key for \`${reducer.name}\``).toBeDefined()
      const seen = new Set((FIXTURE[reducer.name] ?? []).map((e) => e.type as string))
      expect(
        covers!.filter((t) => !seen.has(t)),
        `the \`${reducer.name}\` fixture lacks these event types`,
      ).toEqual([])
    })

    it(`${key}: its result over the fixture is the committed row for version ${reducer.version}`, () => {
      const table = (versions as Record<string, Record<string, string>>)[reducer.name] ?? {}
      const built = hashOver(reducer, FIXTURE[reducer.name] ?? [])
      const row = table[String(reducer.version)]
      expect(
        row,
        `\`${reducer.name}\` (version ${reducer.version}): its result over its fixture is not the committed one. ` +
          `Raise \`${reducer.name}Reducer.version\`, add a row for the new version ("${built}" is the hash now) to reducer-versions.json, ` +
          `never edit an existing row (0124 §3).`,
      ).toBe(built)
    })

    it(`${key}: the table has no row above the current version`, () => {
      const table = (versions as Record<string, Record<string, string>>)[reducer.name] ?? {}
      const above = Object.keys(table).filter((v) => Number(v) > reducer.version)
      expect(above, `\`${reducer.name}\` was lowered below a committed version`).toEqual([])
    })
  }
})
