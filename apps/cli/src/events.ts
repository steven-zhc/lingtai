/**
 * `lingtai events` (#633): the events this version writes, from the manifest
 * `doc/events.json` (#629) inlined at import — from the source that is the
 * checkout's file, and bundled it is inlined by esbuild, the way `version.ts`
 * inlines `package.json`. Nothing here reads a store, a project or the network.
 */
import { STEPS } from '@lingtai/domain'

import manifest from '../../../doc/events.json' with { type: 'json' }
import type { EventsDoc } from '../../../packages/domain/scripts/events.ts'
import { keyValues, section, table } from './output.ts'

export type EventEntry = EventsDoc['events'][number]

/** The manifest of the installed version, as committed. */
export const events: EventsDoc = manifest as EventsDoc

/** Events by the step they are written at, in the order of `STEPS` and `outside` last; empty sections are left out. */
export function eventsBySection(doc: EventsDoc): [string, EventEntry[]][] {
  return [...STEPS, 'outside']
    .map((at): [string, EventEntry[]] => [at, doc.events.filter((e) => e.at.includes(at))])
    .filter(([, list]) => list.length > 0)
}

export function renderEvents(doc: EventsDoc, options: { columns?: number | undefined } = {}): string[] {
  return eventsBySection(doc).flatMap(([at, list], i) => [
    ...(i > 0 ? [''] : []),
    section(at, [
      ...table(
        ['event', 'v', 'stream', 'defined', 'appended'],
        list.map((e) => [e.name, String(e.schemaVersion), e.stream.join(' '), e.definition, e.sites.join(' ')]),
        options,
      ),
    ]),
  ])
}

export function renderEvent(event: EventEntry): string[] {
  const pairs: (readonly [string, string])[] = [
    ['group', event.group],
    ['stream', event.stream.join(' ')],
    ['schema', String(event.schemaVersion)],
    ['retired', event.retired ? 'yes' : 'no'],
    ['at', event.at.join(', ') || '—'],
    ...(event.summary === null ? [] : [['summary', event.summary] as const]),
    ['defined', event.definition],
    ...event.sites.map((site) => ['appended', site] as const),
    ['subscribers', event.subscribers],
  ]
  return [section(event.name, keyValues(pairs))]
}

/** An exact match first, then a case-insensitive one. */
export function findEvent(doc: EventsDoc, name: string): EventEntry | undefined {
  return doc.events.find((e) => e.name === name) ?? doc.events.find((e) => e.name.toLowerCase() === name.toLowerCase())
}

/** The manifest's own body for `--json`: the whole list, or the one event in the same shape. */
export function eventsJson(doc: EventsDoc, only?: EventEntry): Record<string, unknown> {
  return { ...doc, events: only === undefined ? doc.events : [only] }
}
