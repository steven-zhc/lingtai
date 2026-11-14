/**
 * The mirror's `info/exclude` and the names a sandboxed project adds to it (#1152).
 *
 * `info/exclude` is read by every worktree of the mirror. Nothing here reads `core.excludesFile` or matches a path
 * against srt's globs: the names are root-anchored stand-ins the caller passes in, and the file is only merged.
 */

/**
 * `existing` with each of `names` appended once, keeping every line already there (git's template comments
 * included) in order. Returns `existing` itself when nothing is missing, so a second merge is a no-op.
 */
export function mergeExclude(existing: string, names: readonly string[]): string {
  const have = new Set(existing.split('\n').map((line) => line.replace(/\r$/, '')))
  const missing: string[] = []
  for (const name of names) {
    if (have.has(name)) continue
    have.add(name)
    missing.push(name)
  }
  if (missing.length === 0) return existing
  const head = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
  return `${head}${missing.join('\n')}\n`
}
