/**
 * The parent's `## Done when` after a split: one line per child, everything
 * above it left exactly as it was (#601). Pure, like `body-section.ts` — and
 * unlike it, this replaces a person's heading rather than a marked span, so
 * `upsertSection` is not what it is built on.
 */

const DONE_WHEN = /^## Done when[ \t]*\r?$/m
const NEXT_HEADING = /^## /m

/**
 * `body` with its `## Done when` section replaced by a checkbox per child.
 * Text before the heading survives byte for byte; sections after it are kept;
 * no heading appends one. Applying it twice is a no-op.
 */
export function splitDoneWhen(body: string, children: readonly number[]): string {
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const section = [
    '## Done when',
    '',
    ...children.map((n) => `- [ ] #${n} is closed`),
    '',
    'Split into the tickets above; this one is done when they are.',
  ].join(eol)

  const heading = DONE_WHEN.exec(body)
  if (heading === null) return `${body.trimEnd()}${body.trim() === '' ? '' : eol + eol}${section}${eol}`

  const before = body.slice(0, heading.index)
  const afterHeading = body.slice(heading.index + heading[0].length)
  const next = NEXT_HEADING.exec(afterHeading)
  if (next === null) return `${before}${section}${eol}`
  return `${before}${section}${eol}${eol}${afterHeading.slice(next.index)}`
}
