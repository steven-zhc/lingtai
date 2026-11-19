/**
 * **The `## Done when` items of a ticket body, parsed in one place** (0108 §21, #1251).
 *
 * `implement`'s decision and `review`'s check both read the list through here, so they cannot
 * disagree about what the items are. Pure.
 *
 * An item is a top-level list line (`- `, `* `, `+ ` or `1. `) between the `## Done when`
 * heading and the next `## ` heading, with a leading `[ ]` / `[x]` removed. A line indented
 * further than the first item is part of its parent and is never an item of its own — its text
 * is appended to the parent's, so a nested list is checked with the line it belongs to.
 * `null` is *no checkable list*: the heading is absent, or holds no item.
 */

const HEADING = /^#{2}[ \t]+done when[ \t]*:?[ \t]*$/i
const ANY_H2 = /^#{1,2}[ \t]+\S/
const ITEM = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(.*)$/
const CHECKBOX = /^\[[ xX]\][ \t]*/

/** Whitespace collapsed and nothing else changed: how two renderings of an item are compared. */
export function normaliseItem(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The body's `## Done when` items, or `null` where there is no list to check against. */
export function doneWhenItems(body: string): string[] | null {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((l) => HEADING.test(l.trim()))
  if (start < 0) return null
  const items: string[] = []
  let indent: number | null = null
  let fence = false
  for (const line of lines.slice(start + 1)) {
    if (/^[ \t]*```/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    if (ANY_H2.test(line) && !/^#{3,}/.test(line)) break
    const m = ITEM.exec(line)
    if (m !== null) {
      const depth = m[1]!.replace(/\t/g, '    ').length
      if (indent === null) indent = depth
      if (depth <= indent) {
        items.push(normaliseItem(m[2]!.replace(CHECKBOX, '')))
        continue
      }
    }
    // A nested item or a continuation line belongs to the item above it.
    if (items.length > 0 && line.trim() !== '') {
      const body = m !== null ? m[2]!.replace(CHECKBOX, '') : line
      items[items.length - 1] = normaliseItem(`${items[items.length - 1]!} ${body}`)
    }
  }
  const kept = items.filter((i) => i !== '')
  return kept.length === 0 ? null : kept
}
