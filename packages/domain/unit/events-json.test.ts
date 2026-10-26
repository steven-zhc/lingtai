/**
 * `doc/events.json` is generated, and this holds it to the code (#629).
 *
 * The finder in `scripts/events.ts` is deliberately narrow, so the question this
 * file asks is not whether it finds everything but whether every event that is
 * written is accounted for: found, or listed in `ELSEWHERE` with the line. Make it red on purpose by deleting an `ELSEWHERE`
 * row and the failure names the event.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { describe, expect, it } from 'vitest'

import { ELSEWHERE, anchorLines, findAppendSites, generate, type EventsDoc } from '../scripts/events.ts'
import { EVENTS, RETIRED, type EventType } from '../src/index.ts'

const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const found = new Set(findAppendSites(root).map((s) => s.event))
const elsewhere = new Set(ELSEWHERE.map((r) => r.event))

type Row = { event: string; file: string; anchor: string }

/**
 * What is wrong with each row, by name: the anchor does not occur exactly once
 * in its file, or the one line it is on does not name the event as a string.
 */
function badRows(rows: readonly Row[], read: (file: string) => string): string[] {
  return rows.flatMap((r) => {
    const lines = anchorLines(read(r.file), r.anchor)
    if (lines.length !== 1)
      return [`${r.event} in ${r.file}: anchor ${JSON.stringify(r.anchor)} occurs ${lines.length} times, not once`]
    const line = read(r.file).split('\n')[lines[0]! - 1]!
    return line.includes(`'${r.event}'`) || line.includes(`"${r.event}"`)
      ? []
      : [`${r.event} in ${r.file}: line ${lines[0]} does not name it`]
  })
}

/** An event with what a line moving, the sha or a file moving cannot change taken out. */
const eventLevel = (e: EventsDoc['events'][number]) => {
  const { definition: _definition, sites, ...rest } = e
  return { ...rest, sites: sites.length }
}

/** The names of the events the two documents disagree about, in either direction. */
function staleEvents(committed: EventsDoc, fresh: EventsDoc): string[] {
  const a = new Map(committed.events.map((e) => [e.name, eventLevel(e)]))
  const b = new Map(fresh.events.map((e) => [e.name, eventLevel(e)]))
  return [...new Set([...a.keys(), ...b.keys()])].filter((name) => !isDeepStrictEqual(a.get(name), b.get(name)))
}

describe('events.json completeness', () => {
  it('every event that is not retired has an append site or an ELSEWHERE row', () => {
    const missing = (Object.keys(EVENTS) as EventType[]).filter(
      (e) => !RETIRED.has(e) && !found.has(e) && !elsewhere.has(e),
    )
    expect(missing, `no append site found and none listed: ${missing.join(', ')}`).toEqual([])
  })

  it('an ELSEWHERE row is for an event the finder does not find', () => {
    const stale = [...elsewhere].filter((e) => found.has(e))
    expect(stale, `the finder finds these now; delete their ELSEWHERE rows: ${stale.join(', ')}`).toEqual([])
  })

  it('an ELSEWHERE anchor occurs once in its file, on a line that names the event as a string', () => {
    expect(
      badRows(ELSEWHERE, (file) => readFileSync(join(root, file), 'utf8')),
      'fix the row in ELSEWHERE: its anchor must occur exactly once in the file',
    ).toEqual([])
  })

  it('an anchor that occurs twice is named, with its row', () => {
    const rows = [{ event: 'RunRequested', file: 'f.ts', anchor: "'RunRequested'" }]
    const text = "a('RunRequested')\nb('RunRequested')\n"
    expect(anchorLines(text, rows[0]!.anchor)).toEqual([1, 2])
    expect(badRows(rows, () => text)).toEqual([
      `RunRequested in f.ts: anchor "'RunRequested'" occurs 2 times, not once`,
    ])
  })

  it('an anchor keeps being found, one line lower, when a line is inserted above it', () => {
    const text = "x\nawait append('RunRequested', {})\n"
    expect(anchorLines(text, "append('RunRequested'")).toEqual([2])
    expect(anchorLines('\n' + text, "append('RunRequested'")).toEqual([3])
  })
})

describe('events.json is current', () => {
  const fresh = generate({ root, sha: '0'.repeat(40) })

  it('matches what the script generates at the level of the event', () => {
    const committed = JSON.parse(readFileSync(join(root, 'doc', 'events.json'), 'utf8')) as EventsDoc
    expect(
      staleEvents(committed, fresh),
      'doc/events.json is out of date for these events — run pnpm events:generate and commit the result',
    ).toEqual([])
  })

  it('does not go red for a line moving, a new sha, or a file moving', () => {
    const shifted: EventsDoc = {
      sha: '1'.repeat(40),
      events: fresh.events.map((e) => ({
        ...e,
        definition: e.definition.replace(/#L(\d+)/, (_, n) => `#L${Number(n) + 1}`),
        sites: e.sites.map((s) =>
          s
            .replace('/blob/' + '0'.repeat(40) + '/', '/blob/' + '1'.repeat(40) + '/')
            .replace(/#L(\d+)/, (_, n) => `#L${Number(n) + 1}`)
            .replace('/src/', '/lib/'),
        ),
      })),
    }
    expect(staleEvents(shifted, fresh)).toEqual([])
  })

  it('goes red, by name, for an event added without regenerating', () => {
    const name = fresh.events[0]!.name
    const stale: EventsDoc = { ...fresh, events: fresh.events.slice(1) }
    expect(staleEvents(stale, fresh)).toEqual([name])
  })

  it('goes red for a changed number of append sites', () => {
    const e = fresh.events.find((x) => x.sites.length > 0)!
    const stale: EventsDoc = {
      ...fresh,
      events: fresh.events.map((x) => (x === e ? { ...x, sites: x.sites.slice(1) } : x)),
    }
    expect(staleEvents(stale, fresh)).toEqual([e.name])
  })
})
