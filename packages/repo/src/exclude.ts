/** The merge behind the mirror's `info/exclude` write (#1152), pure so a unit test reaches it. */
const BEGIN = '# >>> lingtai sandbox stand-ins (managed; rewritten every provision)'
const END = '# <<< lingtai sandbox stand-ins'

/**
 * `existing` with the managed block set to exactly `names`: lines outside the block are kept, in order, the block
 * is replaced (each name once), and **an empty `names` removes it** — the policy belongs to the pass that wrote
 * it, so a pass that is not sandboxed must not inherit the last one's exclusions. Idempotent.
 */
export function withExcludes(existing: string, names: readonly string[]): string {
  const lines: string[] = []
  let inBlock = false
  for (const line of existing === '' ? [] : existing.replace(/\n$/, '').split('\n')) {
    if (line === BEGIN) inBlock = true
    else if (inBlock && line === END) inBlock = false
    else if (!inBlock) lines.push(line)
  }
  const unique = [...new Set(names)]
  if (unique.length > 0) lines.push(BEGIN, ...unique, END)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}
