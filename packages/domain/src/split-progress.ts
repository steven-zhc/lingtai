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
      /** The latest attempt's plan — the person's edited one. */
      plan: PayloadOf<'SplitStarted'>['plan']
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
  let done = false
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
        done = true
        break
    }
  }

  if (started === null) return { state: 'idle' }
  const base = { plan: started.plan, children: [...children.values()], links: [...links.values()] }
  if (done) return { state: 'done', ...base }
  if (failed !== null) return { state: 'failed', ...base, failed }
  return { state: started.instance === options.instance ? 'writing' : 'interrupted', ...base }
}
