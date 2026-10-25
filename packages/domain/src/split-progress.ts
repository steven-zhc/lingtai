/**
 * What a split write has done and whether it is still going (#608), folded off
 * the parent's stream: `SplitStarted`, one `SplitChildWritten` or
 * `SplitLinkWritten` per read-back write, then `TicketSplit` or `SplitFailed`.
 *
 * **Interrupted is derived, never written.** A `SplitStarted` with nothing
 * terminal after it is *writing* only if its `instance` is the asker's own;
 * otherwise the writer is gone — the reading triage makes of an unfinished
 * attempt. Scoped to one `waitId`, because a parent can wait again and plan
 * keys repeat. Order is stream position, never `at`.
 */
import type { Envelope } from './envelope.ts'
import type { PayloadOf, SplitChild } from './events.ts'
import type { Dependency } from './split.ts'

export type SplitProgressState = 'writing' | 'interrupted' | 'failed' | 'done'

export type SplitProgress =
  | { state: 'idle' }
  | {
      state: SplitProgressState
      /** The latest attempt's plan — the person's edited one; null for a split written before #608, which has no `SplitStarted`. */
      plan: PayloadOf<'SplitStarted'>['plan'] | null
      /** Every child any attempt of this wait wrote, de-duplicated by key. */
      children: SplitChild[]
      /** Every child-to-child link any attempt wrote, de-duplicated. */
      links: Dependency[]
      failed?: { step: string; detail: string }
    }

export function splitProgressOf(
  events: readonly Envelope[],
  options: { waitId: string; instance: string },
): SplitProgress {
  let started: PayloadOf<'SplitStarted'> | null = null
  let failed: { step: string; detail: string } | null = null
  let done: PayloadOf<'TicketSplit'> | null = null
  const children = new Map<string, SplitChild>()
  const links = new Map<string, Dependency>()

  for (const e of [...events].sort((a, b) => a.version - b.version)) {
    const data = e.data as { waitId?: string }
    if (data.waitId !== options.waitId) continue
    switch (e.type) {
      case 'SplitStarted':
        started = e.data as PayloadOf<'SplitStarted'>
        failed = null
        break
      case 'SplitChildWritten': {
        const { key, number, id } = e.data as PayloadOf<'SplitChildWritten'>
        // A key now naming another issue makes every link written for it stale.
        if (children.get(key)?.number !== number && children.has(key))
          for (const [k, l] of links) if (l.ticket === key || l.blockedBy === key) links.delete(k)
        children.set(key, { key, number, id })
        break
      }
      case 'SplitLinkWritten': {
        const { ticket, blockedBy } = e.data as PayloadOf<'SplitLinkWritten'>
        links.set(`${ticket}\u0000${blockedBy}`, { ticket, blockedBy })
        break
      }
      case 'SplitFailed': {
        const { step, detail } = e.data as PayloadOf<'SplitFailed'>
        failed = { step, detail }
        break
      }
      case 'TicketSplit':
        done = e.data as PayloadOf<'TicketSplit'>
        break
    }
  }

  // The terminal record is the list that was written, so it wins over the progress that led up to it.
  if (done !== null)
    return {
      state: 'done',
      plan: started?.plan ?? null,
      children: done.children.map(({ key, number, id }) => ({ key, number, id })),
      links: done.blockedBy.map(({ ticket, blockedBy }) => ({ ticket, blockedBy })),
    }
  if (started === null) return { state: 'idle' }
  const base = { plan: started.plan, children: [...children.values()], links: [...links.values()] }
  if (failed !== null) return { state: 'failed', ...base, failed }
  return { state: started.instance === options.instance ? 'writing' : 'interrupted', ...base }
}
