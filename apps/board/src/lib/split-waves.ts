/**
 * Which wave each child of a split plan lands in (0118 §12), and whether a new
 * blocked-by link would close a loop. No React and no layout: the rule alone,
 * so a test can hold it without drawing anything.
 *
 * A child with no blocker is wave 1; otherwise it is one more than its latest
 * blocker's — not its earliest, so a ticket blocked by a wave-1 and a wave-2
 * child waits for the second.
 */
export interface Link {
  readonly ticket: string
  readonly blockedBy: string
}

export function waves(keys: readonly string[], links: readonly Link[]): Map<string, number> {
  const known = new Set(keys)
  const blockers = new Map<string, string[]>()
  for (const link of links) {
    if (!known.has(link.ticket) || !known.has(link.blockedBy)) continue
    blockers.set(link.ticket, [...(blockers.get(link.ticket) ?? []), link.blockedBy])
  }
  const done = new Map<string, number>()
  // `path` guards a cycle, which a validated plan cannot hold but an edit could: a loop counts as wave 1 rather than recursing forever.
  const wave = (key: string, path: readonly string[]): number => {
    const seen = done.get(key)
    if (seen !== undefined) return seen
    if (path.includes(key)) return 1
    const own = blockers.get(key) ?? []
    const value = own.length === 0 ? 1 : 1 + Math.max(...own.map((blocker) => wave(blocker, [...path, key])))
    done.set(key, value)
    return value
  }
  for (const key of keys) wave(key, [])
  return done
}

/** Whether `blocker` blocking `ticket` would close a loop: `ticket` already, directly or not, blocks `blocker`. */
export function wouldCycle(links: readonly Link[], ticket: string, blocker: string): boolean {
  if (ticket === blocker) return true
  const seen = new Set<string>()
  const stack = [blocker]
  while (stack.length > 0) {
    const at = stack.pop()!
    if (at === ticket) return true
    if (seen.has(at)) continue
    seen.add(at)
    for (const link of links) if (link.ticket === at) stack.push(link.blockedBy)
  }
  return false
}
