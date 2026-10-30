import type { ReactNode } from 'react'

/**
 * A wait sentence with its backtick pairs set as code: `` the `proposed` step
 * held `` reads `proposed` in monospace, with no backtick characters.
 *
 * This is not `lib/markdown.ts`'s rule, and is kept out of `markdown.tsx` on
 * purpose: that file decides per *source* whether text is markdown at all, and a
 * sentence an agent or a recipe wrote is `log`, rendered never. Here the one
 * change is to drop matched single-backtick pairs and set what they enclosed in
 * `<code>`; nothing else is interpreted (`_`, `#`, `{}` stay literal) and
 * nothing is removed but the delimiters. Strings and elements only, so React
 * escapes every byte.
 *
 * An empty pair and a trailing unmatched backtick stay as characters.
 */
export function codeSpans(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let plain = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '`') {
      const close = text.indexOf('`', i + 1)
      if (close > i + 1) {
        if (plain !== '') out.push(plain)
        plain = ''
        out.push(<code key={out.length}>{text.slice(i + 1, close)}</code>)
        i = close + 1
        continue
      }
    }
    plain += text[i]
    i += 1
  }
  if (plain !== '' || out.length === 0) out.push(plain)
  return out
}
