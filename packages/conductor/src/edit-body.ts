/**
 * Writing a wait's answer into the ticket's body, then requeuing (#422, 0118
 * §6). `upsertSection` (`body-section.ts`, #446) is the pure half — one
 * section per key, found by a marker; this is the other half nothing called
 * before this ticket: finding the issue, writing the section through
 * `tellGitHub`, and reading the body back to find out whether it landed.
 *
 * **The body is written first, and a failed write resolves nothing.**
 * `writeSection` never throws and never appends `WaitResolved` itself —
 * `editBodyAndRequeueHolding` is what decides, from `writeSection`'s own
 * result, whether `resolveWaitHolding` is called at all.
 */
import { ticketReducer, ticketStream, type WaitId } from '@lingtai/domain'
import { allowedResolutions, requeueNote } from '@lingtai/domain/wait'
import { type EventStore, eventStore, log, type SnapshotReadOptions } from '@lingtai/event-store'

import { deciding } from './approve.ts'
import { describeReason, resolveWaitHolding } from './resolve-wait.ts'
import { readState } from './snapshot-state.ts'
import type { IssueChannel } from './tell.ts'
import { writeSection } from './write-section.ts'

export type { IssueChannel } from './tell.ts'
export { writeSection, type WriteSectionResult } from './write-section.ts'

export interface EditBodyAndRequeueResult {
  ok: boolean
  ticketId: string
  reason?: string
  /** Whether the body carries the answer — set even when the resolve step itself refused. */
  written: boolean
  detail: string
}

export interface EditBodyAndRequeueOptions extends SnapshotReadOptions {
  project: string
  issue: number
  waitId: WaitId
  /** The person's answer — the section's text, not the analysis. */
  text: string
  by: string
  note?: string
  github: IssueChannel
  store?: EventStore
}

/**
 * Writing a wait's answer into the body, then resolving the wait as
 * `EditBodyAndRequeue` (#422, 0118 §6/§11).
 *
 * One decision at a time, the same lock `approve()` and `requeue()` take
 * (`deciding`, `approve.ts`) — see their own comments for why the log cannot
 * serialise this on its own.
 */
export async function editBodyAndRequeue(options: EditBodyAndRequeueOptions): Promise<EditBodyAndRequeueResult> {
  const store = options.store ?? eventStore
  const ticketId = ticketStream(options.project, options.issue)
  return deciding(
    ticketId,
    () => ({
      ok: false,
      ticketId,
      reason: 'busy',
      written: false,
      detail: `${ticketId} is being decided by someone else right now — an approval may be merging it. Reload and read it again`,
    }),
    () =>
      editBodyAndRequeueHolding(options, store, ticketId, {
        snapshots: options.snapshots ?? (options.store === undefined ? log.snapshots : undefined),
        writer: options.writer,
      }),
  )
}

/** Exported for the unit half alone — see `requeueHolding`'s own comment in `approve.ts`. */
export async function editBodyAndRequeueHolding(
  options: EditBodyAndRequeueOptions,
  store: EventStore,
  ticketId: string,
  read: SnapshotReadOptions = {},
): Promise<EditBodyAndRequeueResult> {
  // **Refuse before writing** (0118 §6): a body edited for a refusal it was
  // always going to get is a body changed for nothing.
  const item = await readState(store, ticketReducer, ticketId, 'all', read)
  if (item.lifecycle.status !== 'blocked' || item.lifecycle.waitId !== options.waitId) {
    return {
      ok: false,
      ticketId,
      reason: 'not-waiting',
      written: false,
      detail: `${ticketId} is not waiting on ${options.waitId} — nothing was resolved. Reload and read it again.`,
    }
  }
  const reason = item.lifecycle.reason
  if (!allowedResolutions(reason).includes('EditBodyAndRequeue')) {
    return {
      ok: false,
      ticketId,
      reason: 'not-offered',
      written: false,
      detail: `EditBodyAndRequeue is not offered for ${describeReason(reason)} — nothing was resolved.`,
    }
  }

  const key = `${ticketId}/${options.waitId}`
  const result = await writeSection({ store, github: options.github, ticketId, key, text: options.text })
  if (!result.written) {
    return { ok: false, ticketId, reason: 'write-failed', written: false, detail: result.detail }
  }

  const resolved = await resolveWaitHolding(
    {
      ticketId,
      waitId: options.waitId,
      resolution: { _tag: 'EditBodyAndRequeue' },
      writtenSection: options.text,
      by: options.by,
      // A note the person typed wins; otherwise it is composed from the text
      // just written, so it cannot go stale against an edited answer (0118 §6).
      note: options.note?.trim() ? options.note : requeueNote(options.text),
      store,
      ...read,
    },
    ticketId,
  )
  if (!resolved.ok) {
    const now = await readState(store, ticketReducer, ticketId, 'all', read)
    return {
      ok: false,
      ticketId,
      reason: resolved.reason,
      written: true,
      detail: `the answer is in the body; ${ticketId} is ${now.lifecycle.status} now — ${resolved.detail}`,
    }
  }

  return { ok: true, ticketId, written: true, detail: 'back in the queue, and the answer is in the body' }
}
