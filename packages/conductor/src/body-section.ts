/**
 * `upsertSection` — one section per key, found by a marker
 * ([0118](../../../doc/decisions/0118-a-hold-explains-itself.md) §6), and the
 * other building block #422's move onto it needs. Pure: no event store, no
 * clock, no GitHub, so this file is safe to call from anywhere a body is
 * composed. `#422` is what makes an answer go in here rather than through
 * `discuss.ts`'s `appendToBody`, which stays as it is until that move.
 */

/** The marker a section's text sits between, invisible when rendered. */
export function answerOpenMarker(key: string): string {
  return `<!-- lingtai:answer ${key} -->`
}

/** The close marker. Carries no key — a close belongs to whichever open marker precedes it. */
export const ANSWER_CLOSE_MARKER = '<!-- /lingtai:answer -->'

/**
 * Writes `text` into `body` under `key`, replacing whatever that key's
 * section held before.
 *
 * **Absent → appended.** **Present with the same text → `body` itself,
 * unchanged** — so a retried write costs no second write. **Present with
 * different text → replaced in place**, byte for byte everywhere outside the
 * marker span.
 *
 * Matches the *whole* open marker, including the trailing ` -->`, so a key
 * that is another key's prefix (`w-1@review` against `w-1@reviewer`) cannot
 * collide. The close marker is found after it and never before, because
 * sections never nest.
 *
 * Throws rather than guessing when the markers cannot be trusted: a key
 * carrying `-->` or a newline could close its own marker early, and an open
 * marker with no close could only be treated as absent (appending a second
 * copy, the bug this exists to prevent) or as running to the end of the body
 * (deleting a person's text after it) — both wrong.
 *
 * **A second, hand-pasted open marker for the same key is left alone.** Only
 * the first pair is replaced.
 */
export function upsertSection(body: string, key: string, text: string): string {
  if (key.includes('-->') || key.includes('\n')) {
    throw new Error(`upsertSection: key ${JSON.stringify(key)} cannot contain "-->" or a newline`)
  }

  const open = answerOpenMarker(key)
  const trimmed = text.trim()
  const section = `${open}\n\n${trimmed}\n\n${ANSWER_CLOSE_MARKER}`

  const openIdx = body.indexOf(open)
  if (openIdx === -1) {
    return body.trim() === '' ? `${section}\n` : `${body.trimEnd()}\n\n${section}\n`
  }

  const innerStart = openIdx + open.length
  const closeIdx = body.indexOf(ANSWER_CLOSE_MARKER, innerStart)
  if (closeIdx === -1) {
    throw new Error(`upsertSection: the open marker for ${JSON.stringify(key)} has no matching close marker`)
  }

  if (body.slice(innerStart, closeIdx).trim() === trimmed) return body

  return body.slice(0, openIdx) + section + body.slice(closeIdx + ANSWER_CLOSE_MARKER.length)
}
