import type { ActionFinding } from './action.ts'

/**
 * **Which new-side lines a unified diff touches, per path** (#670).
 *
 * A hunk `@@ -a,b +c,d @@` covers new-side lines `c … c+d-1`, context lines
 * included: a bug made by deleting a guard is cited next to the deletion, and
 * that line is inside the hunk. A file the diff deletes (`+++ /dev/null`) has no
 * new-side lines, and is keyed by its old path with an empty set and listed in
 * `deleted`, because a finding on it is about code the diff removed.
 *
 * `null` when a hunk header cannot be read: the caller demotes nothing.
 */
export interface DiffHunks {
  readonly lines: ReadonlyMap<string, ReadonlySet<number>>
  readonly deleted: ReadonlySet<string>
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

const ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/**
 * The path on a `--- ` / `+++ ` line, as git wrote it: a name with a space is
 * followed by a tab, and one with a non-ASCII or control character is wrapped
 * in double quotes with C escapes (octal bytes for UTF-8). Neither is the
 * name a finding cites, so both are undone before the `a/` / `b/` prefix goes.
 */
function headerPath(raw: string): string {
  if (!raw.startsWith('"')) return raw.split('\t')[0] ?? raw
  const bytes: number[] = []
  let i = 1
  while (i < raw.length && raw[i] !== '"') {
    if (raw[i] !== '\\') {
      // By code point: a supplementary character is two UTF-16 units, and
      // encoding each alone would write a replacement character twice.
      const c = String.fromCodePoint(raw.codePointAt(i)!)
      bytes.push(...Buffer.from(c, 'utf8'))
      i += c.length
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(raw.slice(i + 1))
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8) & 0xff)
      i += 1 + octal[0].length
    } else {
      const e = ESCAPES[raw[i + 1] ?? '']
      bytes.push(e ?? (raw[i + 1] ?? '\\').charCodeAt(0))
      i += 2
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

export function hunksOf(diff: string): DiffHunks | null {
  // A colored diff hides every header behind an escape; reading it as empty
  // would demote everything, so it is unreadable instead.
  if (diff.includes('\x1b[')) return null
  const lines = new Map<string, Set<number>>()
  const deleted = new Set<string>()
  let oldPath: string | undefined
  let current: Set<number> | undefined
  let inHunk = false
  let remainingOld = 0
  let remainingNew = 0

  for (const row of diff.split('\n')) {
    if (inHunk && (remainingOld > 0 || remainingNew > 0)) {
      if (row.startsWith('\\')) continue
      if (row.startsWith('+')) remainingNew -= 1
      else if (row.startsWith('-')) remainingOld -= 1
      else {
        remainingOld -= 1
        remainingNew -= 1
      }
      continue
    }
    inHunk = false
    if (row.startsWith('diff --git ')) {
      oldPath = undefined
      current = undefined
    } else if (row.startsWith('--- ')) {
      oldPath = headerPath(row.slice(4)).replace(/^a\//, '')
    } else if (row.startsWith('+++ ')) {
      const path = headerPath(row.slice(4))
      if (path === '/dev/null') {
        current = undefined
        if (oldPath !== undefined && oldPath !== '/dev/null') {
          deleted.add(oldPath)
          lines.set(oldPath, new Set())
        }
      } else {
        const name = path.replace(/^b\//, '')
        current = lines.get(name) ?? new Set<number>()
        lines.set(name, current)
      }
    } else if (row.startsWith('@@')) {
      const m = HUNK.exec(row)
      if (m === null) return null
      const start = Number(m[1])
      const count = m[2] === undefined ? 1 : Number(m[2])
      const old = /^@@ -\d+(?:,(\d+))? /.exec(row)
      remainingOld = old?.[1] === undefined ? 1 : Number(old[1])
      remainingNew = count
      if (current !== undefined) for (let n = start; n < start + count; n++) current.add(n)
      inHunk = remainingOld > 0 || remainingNew > 0
    }
  }
  return { lines, deleted }
}

/** Whether a finding's location is inside (or about) what the diff touched. */
export function isInsideHunks(finding: Pick<ActionFinding, 'file' | 'line'>, hunks: DiffHunks): boolean {
  if (hunks.deleted.has(finding.file)) return true
  const set = hunks.lines.get(finding.file)
  if (set === undefined || set.size === 0) return false
  return finding.line === null ? true : set.has(finding.line)
}

const PREFIX = 'pre-existing — was '

/**
 * Demote every finding the diff does not reach to `minor`, unless the reviewer
 * said how the diff makes it reachable. `failureScenario` is left alone: the
 * recheck block quotes it word for word.
 */
export function demoteOutsideDiff(findings: readonly ActionFinding[], hunks: DiffHunks): ActionFinding[] {
  return findings.map((f) => {
    if (f.severity === 'minor') return f
    if (f.reachableBecause !== undefined && f.reachableBecause.trim() !== '') return f
    if (isInsideHunks(f, hunks)) return f
    return {
      ...f,
      severity: 'minor',
      claim: f.claim.startsWith(PREFIX) ? f.claim : `${PREFIX}${f.severity}: ${f.claim}`,
    }
  })
}
