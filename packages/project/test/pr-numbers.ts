/**
 * A test that builds `pr-{project}-{n}` streams by hand must also record the number, as every write in `pr.ts` does
 * (ADR 0131 §1): a reader finds the highest PR on the project stream and never probes. This is that record, for a PR a
 * test appended to a stream itself; a test that goes through `pr.ts`'s writes needs none of it.
 */
import { projectStream, reduceProject } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store/store'

/** Records `n` as the project's highest PR unless the project already records `n` or more. */
export async function recordPrNumber(store: EventStore, project: string, n: number): Promise<void> {
  const state = reduceProject(await store.read(projectStream(project)))
  if (state.highestPr !== null && state.highestPr >= n) return
  await store.append(projectStream(project), state.version, [
    { type: 'ProjectPrNumbered', actor: 'conductor', data: { n } },
  ])
}
