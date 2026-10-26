/**
 * Which tickets may not run together because their `Fix` rows name one file
 * ([0122](../../../doc/decisions/0122-several-passes-share-one-conductor.md) §2).
 *
 * Pure: no store, no GitHub. The ticket body comes in as a string, so the look
 * and `lingtai status` ask the same function the same question.
 *
 * The rule is deliberately cheap. No agent is paid to predict scope, so a ticket
 * with no `Fix` row, or none naming a file, collides with nothing — what this
 * lets through is caught by the re-review on a moved base.
 */

/** A path-ish token: it has a `/` or an extension. `pnpm`, `Fix` and `N=2` have neither. */
function looksLikeFile(token: string): boolean {
  return /\//.test(token) || /\.[A-Za-z0-9]+$/.test(token)
}

/**
 * The files the first `**Fix**` table row names — its backticked tokens that look
 * like a path, with a trailing `:line` (or `:line-line`) removed. No such row
 * means no files.
 */
export function fixFiles(body: string): string[] {
  for (const line of body.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 3 || cells[1] !== '**Fix**') continue
    const files: string[] = []
    for (const m of cells
      .slice(2)
      .join('|')
      .matchAll(/`([^`]+)`/g)) {
      const token = m[1]!.trim().replace(/:\d+(?:-\d+)?$/, '')
      if (token !== '' && !/\s/.test(token) && looksLikeFile(token) && !files.includes(token)) files.push(token)
    }
    return files
  }
  return []
}

const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * The first file two lists share: equal paths, or a bare name equal to the last
 * segment of the other's path. An empty list collides with nothing.
 */
export function collision(a: readonly string[], b: readonly string[]): { file: string } | null {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return { file: x }
      if (!x.includes('/') && x === lastSegment(y)) return { file: y }
      if (!y.includes('/') && y === lastSegment(x)) return { file: x }
    }
  }
  return null
}

/**
 * What a ticket's `Fix` row names, or null when the ticket could not be read.
 * Null is not empty: a ticket whose body is unknown is not known to be safe to
 * run beside another.
 */
export async function readFixFiles(
  source: { getIssue(number: number): Promise<{ body: string }> },
  issue: number,
): Promise<string[] | null> {
  try {
    return fixFiles((await source.getIssue(issue)).body)
  } catch {
    return null
  }
}

/** The sentence for a ticket that must wait for one in flight, or null when it need not. */
export function waitsFor(
  files: readonly string[] | null,
  inFlight: readonly { issue: string; files: readonly string[] | null }[],
): string | null {
  for (const f of inFlight) {
    if (files === null || f.files === null) return `waits for #${f.issue} in flight — a Fix row could not be read`
    const hit = collision(files, f.files)
    if (hit) return `waits for #${f.issue} in flight — both name \`${hit.file}\``
  }
  return null
}
