import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PREFIXES, renderStreams, spliceStreams, type EventsDoc } from '../scripts/events.ts'
import { STREAM_ID_PATTERN } from '../src/envelope.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const committed = JSON.parse(readFileSync(join(root, 'doc', 'events.json'), 'utf8')) as EventsDoc
const reference = readFileSync(join(root, 'doc', 'reference.md'), 'utf8')

describe("reference.md's stream section", () => {
  it('is what doc/events.json renders to', () => {
    expect(
      spliceStreams(reference, renderStreams(committed)) === reference,
      'doc/reference.md stream section is out of date — run pnpm events:generate and commit the result',
    ).toBe(true)
  })

  it("covers exactly StreamId's prefixes", () => {
    const group = /^\^\(([^)]*)\)-/.exec(STREAM_ID_PATTERN.source)?.[1] ?? ''
    const fromRegex = group.split('|').map((p) => `${p}-`)
    expect(Object.keys(PREFIXES).sort()).toEqual(fromRegex.sort())
  })

  it('names only prefixes the manifest uses, and uses every one', () => {
    const used = new Set(committed.events.flatMap((e) => e.stream))
    expect([...used].sort()).toEqual(Object.keys(PREFIXES).sort())
  })

  it('refuses markers that are missing, doubled or reversed', () => {
    const section = renderStreams(committed)
    expect(() => spliceStreams('no markers', section)).toThrow(/doc\/reference\.md/)
    expect(() => spliceStreams('<!-- streams:end -->\n<!-- streams:begin -->', section)).toThrow()
    expect(() => spliceStreams(`${reference}\n<!-- streams:begin -->`, section)).toThrow()
  })

  it('throws for a type on several prefixes with no note', () => {
    const doc = { events: [{ name: 'Nope', stream: ['pass-', 'chat-'], retired: false }] }
    expect(() => renderStreams(doc)).toThrow(/no MULTI note/)
  })
})
