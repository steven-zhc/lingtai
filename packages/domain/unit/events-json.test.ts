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

import { describe, expect, it } from 'vitest'

import { ELSEWHERE, findAppendSites, generate, type EventsDoc } from '../scripts/events.ts'
import { EVENTS, RETIRED, type EventType } from '../src/index.ts'

const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const found = new Set(findAppendSites(root).map((s) => s.event))
const elsewhere = new Set(ELSEWHERE.map((r) => r.event))

const SHA = /\/blob\/[0-9a-f]{40}\//g
const normalised = (doc: EventsDoc): EventsDoc =>
  JSON.parse(JSON.stringify(doc).replace(SHA, '/blob/SHA/')) as EventsDoc

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

  it('an ELSEWHERE site names its event on that line', () => {
    const wrong = ELSEWHERE.filter((r) => {
      const at = r.site.lastIndexOf(':')
      const line =
        readFileSync(join(root, r.site.slice(0, at)), 'utf8').split('\n')[Number(r.site.slice(at + 1)) - 1] ?? ''
      return !line.includes(`'${r.event}'`) && !line.includes(`"${r.event}"`)
    })
    expect(
      wrong.map((r) => `${r.event} at ${r.site}`),
      'the line moved or the row is wrong; fix the site in ELSEWHERE',
    ).toEqual([])
  })
})

describe('events.json is current', () => {
  it('matches what the script generates, with the sha taken out', () => {
    const committed = JSON.parse(readFileSync(join(root, 'doc', 'events.json'), 'utf8')) as EventsDoc
    const fresh = generate({ root, sha: '0'.repeat(40) })
    expect(
      normalised({ ...committed, sha: '0'.repeat(40) }),
      'doc/events.json is out of date — run pnpm events:generate and commit the result',
    ).toEqual(normalised(fresh))
  })
})
