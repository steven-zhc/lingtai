import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { STEPS } from '@lingtai/domain'

import type { EventsDoc } from '../../../../packages/domain/scripts/events.ts'
import { docRoot } from './docs'

/**
 * `/docs/events/` (#630): the manifest `doc/events.json` (#629), read at build
 * time the way the rest of `doc/` is — a projection, never a copy. The ten
 * steps come from `STEPS` and the one lane beside them is the generator's own
 * word for an event no step writes; no event or step is named in the page.
 */
export type EventEntry = EventsDoc['events'][number]

export const OUTSIDE = 'outside'

export async function readEvents(): Promise<EventsDoc> {
  return JSON.parse(await readFile(path.join(docRoot, 'events.json'), 'utf8')) as EventsDoc
}

/**
 * Events by the step they are written at, `STEPS` in order and `outside` last; an event at several steps is in each.
 * An event with no `at` at all — the retired ones nothing writes any more — is in `outside`, so none is dropped.
 */
export function bySection(doc: EventsDoc): [string, EventEntry[]][] {
  return [...STEPS, OUTSIDE].map((at): [string, EventEntry[]] => [
    at,
    doc.events.filter((e) => e.at.includes(at) || (at === OUTSIDE && e.at.length === 0)),
  ])
}
