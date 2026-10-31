import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { EventsDoc } from '../../../../packages/domain/scripts/events.ts'
import { docRoot } from './docs'

/**
 * `/docs/events/` (#630): the manifest `doc/events.json` (#629), read at build
 * time the way the rest of `doc/` is — a projection, never a copy. The ten
 * steps come from `STEPS` and the one lane beside them is the generator's own
 * word for an event no step writes; no event or step is named in the page.
 */
export type EventEntry = EventsDoc['events'][number]

export { OUTSIDE } from './event-filter'

export async function readEvents(): Promise<EventsDoc> {
  return JSON.parse(await readFile(path.join(docRoot, 'events.json'), 'utf8')) as EventsDoc
}
