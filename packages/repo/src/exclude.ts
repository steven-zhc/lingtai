/** The merge behind the mirror's `info/exclude` write (#1152), pure so a unit test reaches it. */
/** `existing` with each of `names` added once. Lines already there are kept, in order; idempotent. */
export function withExcludes(existing: string, names: readonly string[]): string {
  const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n')
  const have = new Set(lines)
  for (const name of names) {
    if (!have.has(name)) {
      have.add(name)
      lines.push(name)
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}
