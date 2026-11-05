/**
 * Putting one section into a ticket's body (#422, 0118 §6), apart from
 * `edit-body.ts` so `resolve-wait.ts` can write one without the two modules
 * importing each other.
 */
import { type EventStore } from '@lingtai/event-store'

import { upsertSection } from './body-section.ts'
import { record, split, tellGitHub, type IssueChannel } from './tell.ts'
import { BodyChanged } from './ticket-store.ts'

/** `writeSection` tried twice and the section is still not there. */
export type WriteSectionResult = { written: true } | { written: false; detail: string }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The exact text `upsertSection` puts between the markers for `key`, trimmed
 * — what `writeSection` looks for on the read-back. Built from `text` with
 * `\r\n` already reduced to `\n`, because the read-back body is reduced the
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
