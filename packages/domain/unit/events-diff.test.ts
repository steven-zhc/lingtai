/** The release notes' *Events changed* section is a function of two manifests (#632). */
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { diffEvents, renderEventsChanged } from '../scripts/events-diff.ts'
import { generate, type EventsDoc } from '../scripts/events.ts'

const ev = (name: string, schemaVersion = 1, retired = false): EventsDoc['events'][number] => ({
  name,
  group: 'g',
  stream: [],
  schemaVersion,
  retired,
  at: [],
  summary: null,
  definition: '',
  sites: [],
  subscribers: `on: [${name}]`,
})
const doc = (...events: EventsDoc['events']): EventsDoc => ({ sha: 'x', events })

describe('diffEvents', () => {
  it('reports an added event', () => {
    expect(diffEvents(doc(ev('A')), doc(ev('A'), ev('B')))).toEqual({ added: ['B'], retired: [], bumped: [] })
  })

  it('reports an event retired by flag', () => {
    expect(diffEvents(doc(ev('A')), doc(ev('A', 1, true))).retired).toEqual(['A'])
  })

  it('reports an event removed outright as retired', () => {
    expect(diffEvents(doc(ev('A'), ev('B')), doc(ev('B'))).retired).toEqual(['A'])
  })

  it('reports a schema bump with both versions', () => {
    expect(diffEvents(doc(ev('A', 1)), doc(ev('A', 3))).bumped).toEqual([{ name: 'A', from: 1, to: 3 }])
  })

  it('reads a rename as a retirement plus an addition, never a rename', () => {
    expect(diffEvents(doc(ev('Old')), doc(ev('Old', 1, true), ev('New')))).toEqual({
      added: ['New'],
      retired: ['Old'],
      bumped: [],
    })
  })

  it('reads an un-retired event as added', () => {
    expect(diffEvents(doc(ev('A', 1, true)), doc(ev('A'))).added).toEqual(['A'])
  })

  it('does not report an already retired event again, nor a bump on a retired one', () => {
    expect(diffEvents(doc(ev('A', 1, true)), doc(ev('A', 2, true)))).toEqual({ added: [], retired: [], bumped: [] })
  })
})

describe('renderEventsChanged', () => {
  it('says first release when there is no previous manifest', () => {
    const s = renderEventsChanged({ previousTag: null, previous: null, next: doc(ev('A')) })
    expect(s).toBe('## Events changed\n\nFirst release with an events manifest.\n')
  })

  it('names the previous tag that has no asset', () => {
    const s = renderEventsChanged({ previousTag: 'v1.2.0', previous: null, next: doc(ev('A')) })
    expect(s).toContain('First release with an events manifest (v1.2.0 has none).')
  })

  it('says nothing changed', () => {
    const s = renderEventsChanged({ previousTag: 'v1', previous: doc(ev('A')), next: doc(ev('A')) })
    expect(s).toBe('## Events changed\n\nNo event changed since v1.\n')
  })

  it('lists each non-empty category', () => {
    const s = renderEventsChanged({
      previousTag: 'v1',
      previous: doc(ev('A', 2), ev('B')),
      next: doc(ev('A', 3), ev('B', 1, true), ev('C')),
    })
    expect(s).toContain('**Added**\n\n- `C`')
    expect(s).toContain('**Retired**\n\n- `B`')
    expect(s).toContain('- `A` 2 → 3')
  })
})

describe('generate with a ref', () => {
  it('names the ref in every link and keeps the commit as sha', () => {
    const root = join(__dirname, '..', '..', '..')
    const out = generate({ root, sha: 'abc123', ref: 'v0.0.0' })
    expect(out.sha).toBe('abc123')
    const links = out.events.flatMap((e) => [e.definition, ...e.sites])
    expect(links.length).toBeGreaterThan(0)
    for (const l of links) expect(l).toContain('/blob/v0.0.0/')
  })
})
