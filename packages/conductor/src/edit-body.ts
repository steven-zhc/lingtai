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
import { reduceTicket, ticketStream, type WaitId } from '@lingtai/domain'
import { allowedResolutions } from '@lingtai/domain/wait'
import { type EventStore, eventStore } from '@lingtai/event-store'

import { deciding } from './approve.ts'
import { upsertSection } from './body-section.ts'
import { describeReason, resolveWaitHolding } from './resolve-wait.ts'
import { record, split, tellGitHub, type IssueChannel } from './tell.ts'
import { BodyChanged } from './ticket-store.ts'

export type { IssueChannel } from './tell.ts'

/** `writeSection` tried twice and the section is still not there. */
export type WriteSectionResult = { written: true } | { written: false; detail: string }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The exact text `upsertSection` puts between the markers for `key`, trimmed
 * — what `writeSection` looks for on the read-back. Built from `text` with
 * `\r\n` already folded to `\n`, because the read-back body is folded the
 * same way before the search: a `text` that itself carries CRLF must still
 * match its own normalized reflection.
 */
function sectionTextFor(key: string, text: string): string {
  return upsertSection('', key, text.replace(/\r\n/g, '\n')).trim()
}

/**
 * Puts one section into a ticket's body by its marker (0118 §6): absent →
 * appended, present → replaced in place, so writing the same key twice leaves
 * one section. Never throws.
 *
 * **Two tries in all.** A `BodyChanged` — somebody else's edit landed first —
 * is retried against the body as it now stands; anything else stops. The
 * write is through `tellGitHub`, so it is recorded the way every other write
 * to an issue is, and the read-back is what tells a write whose own call threw
 * from one that never reached GitHub at all: `tellGitHub` can record
 * `IssueUpdateFailed` for a call that in fact landed (a dropped response after
 * the PATCH committed), and the read-back finds the section anyway — that is
 * found, not retried, with a second `IssueUpdated` saying so.
 */
export async function writeSection(options: {
  store: EventStore
  github: IssueChannel
  ticketId: string
  key: string
  text: string
}): Promise<WriteSectionResult> {
  const { store, github, ticketId, key, text } = options
  const target = split(ticketId)
  if (target === null) return { written: false, detail: `${ticketId} does not name a numbered issue` }
  const { issue } = target

  let wanted: string
  try {
    wanted = sectionTextFor(key, text)
  } catch (err) {
    // Nothing was sent to GitHub, so nothing is appended: "refuse before you
    // write" applies to the body's own markers as much as to the wait.
    return { written: false, detail: errorMessage(err) }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let body: string
    try {
      body = (await github.getIssue(issue)).body
    } catch (err) {
      return { written: false, detail: `the issue could not be read: ${errorMessage(err)}` }
    }

    let next: string
    try {
      next = upsertSection(body, key, text)
    } catch (err) {
      return { written: false, detail: errorMessage(err) }
    }

    const told = await tellGitHub({ store, github, ticketId, change: { kind: 'body', body: next, ifUnchanged: body } })

    let after: string
    try {
      after = (await github.getIssue(issue)).body
    } catch (err) {
      // When the write itself recorded `IssueUpdated`, the PATCH is known to
      // have landed — the read-back failing after that tells us nothing new.
      // Only a failed or unattempted write leaves it genuinely unknown
      // whether a retry would duplicate the section, which is when to stop
      // rather than guess.
      if (told.recorded === 'IssueUpdated') return { written: true }
      return {
        written: false,
        detail: `the write's outcome is on the log, but the read-back failed: ${errorMessage(err)}`,
      }
    }

    const landed = after.replace(/\r\n/g, '\n').includes(wanted)
    if (landed) {
      if (told.recorded === 'IssueUpdateFailed') {
        await record(store, ticketId, 'IssueUpdated', {
          project: target.project,
          issue: String(issue),
          change: 'body',
          detail: `found on read-back after: ${errorMessage(told.error)}`,
        })
      }
      return { written: true }
    }

    if (told.recorded === 'IssueUpdateFailed') {
      if (told.error instanceof BodyChanged) continue // retry against the new body
      return { written: false, detail: `the write failed: ${errorMessage(told.error)}` }
    }
    if (told.recorded === 'IssueUpdated') continue // a later write removed it; try again
    return { written: false, detail: 'the write was never attempted' }
  }

  return { written: false, detail: 'the section did not land after two tries' }
}

export interface EditBodyAndRequeueResult {
  ok: boolean
  ticketId: string
  /** Whether the body carries the answer — set even when the resolve step itself refused. */
  written: boolean
  detail: string
}

export interface EditBodyAndRequeueOptions {
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
      written: false,
      detail: `${ticketId} is being decided by someone else right now — an approval may be merging it. Reload and read it again`,
    }),
    () => editBodyAndRequeueHolding(options, store, ticketId),
  )
}

/** Exported for the unit half alone — see `requeueHolding`'s own comment in `approve.ts`. */
export async function editBodyAndRequeueHolding(
  options: EditBodyAndRequeueOptions,
  store: EventStore,
  ticketId: string,
): Promise<EditBodyAndRequeueResult> {
  // **Refuse before writing** (0118 §6): a body edited for a refusal it was
  // always going to get is a body changed for nothing.
  const item = reduceTicket(await store.read(ticketId))
  if (item.lifecycle.status !== 'blocked' || item.lifecycle.waitId !== options.waitId) {
    return {
      ok: false,
      ticketId,
      written: false,
      detail: `${ticketId} is not waiting on ${options.waitId} — nothing was resolved. Reload and read it again.`,
    }
  }
  const reason = item.lifecycle.reason
  if (!allowedResolutions(reason).includes('EditBodyAndRequeue')) {
    return {
      ok: false,
      ticketId,
      written: false,
      detail: `EditBodyAndRequeue is not offered for ${describeReason(reason)} — nothing was resolved.`,
    }
  }

  const key = `${ticketId}/${options.waitId}`
  const result = await writeSection({ store, github: options.github, ticketId, key, text: options.text })
  if (!result.written) {
    return { ok: false, ticketId, written: false, detail: result.detail }
  }

  const resolved = await resolveWaitHolding(
    {
      ticketId,
      waitId: options.waitId,
      resolution: { _tag: 'EditBodyAndRequeue' },
      by: options.by,
      note: options.note,
      store,
    },
    ticketId,
  )
  if (!resolved.ok) {
    const now = reduceTicket(await store.read(ticketId))
    return {
      ok: false,
      ticketId,
      written: true,
      detail: `the answer is in the body; ${ticketId} is ${now.lifecycle.status} now — ${resolved.detail}`,
    }
  }

  return { ok: true, ticketId, written: true, detail: 'back in the queue, and the answer is in the body' }
}
