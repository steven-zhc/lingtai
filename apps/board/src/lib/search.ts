/**
 * The ⌘K search (#908): the index the route builds, the ranking, and the
 * keyboard — all pure.
 *
 * **This is the one `@/lib/` file a `"use client"` file may import**, so its
 * imports are types only. A server-only import reaching a client graph is
 * caught by the Next build after the merge and by nothing before it (#230);
 * `unit/palette.test.tsx` holds this file to the rule.
 */
import type { TaskCard, TaskState } from '@lingtai/projector/task-view'

export type Group = 'Pages' | 'Projects' | 'Recipes' | 'Tickets'

export const GROUPS: readonly Group[] = ['Pages', 'Projects', 'Recipes', 'Tickets']

export interface Entry {
  group: Group
  label: string
  detail?: string
  href: string
  keys: string[]
}

export interface Index {
  entries: Entry[]
  problems: string[]
}

/** At most this many results from any one group. */
export const PER_GROUP = 8

/**
 * The board's pages that need no argument. The route returns them and a test
 * lists the board's static `page.tsx` files against them, so a new page that is
 * not here fails rather than going unfindable.
 */
export const PAGES: readonly { label: string; href: string }[] = [
  { label: 'board', href: '/' },
  { label: 'report', href: '/report' },
  { label: 'landed', href: '/landed' },
  { label: 'backlog', href: '/backlog' },
  { label: 'claude token', href: '/setup/claude-token' },
]

/**
 * A word for each card state, in the glossary's words. A `Record`, so a new
 * state fails `tsc` rather than showing the raw enum.
 */
export const TICKET_WORD: Record<TaskState, string> = {
  queued: 'queued',
  running: 'running',
  verifying: 'running',
  approved: 'approved',
  waiting: 'waiting on you',
  landed: 'landed',
  closed: 'closed',
}

const reason = (e: Error): string => e.message.split('\n')[0] ?? 'unknown'

/**
 * The index, from what the route read. Each read arrives as its answer or its
 * `Error`; an `Error` becomes a sentence in `problems` and leaves its group
 * out, and is never an empty group.
 */
export function buildIndex({
  tasks,
  projects,
}: {
  tasks: readonly TaskCard[] | Error
  projects: readonly string[] | Error
}): Index {
  const entries: Entry[] = []
  const problems: string[] = []

  for (const p of PAGES) entries.push({ group: 'Pages', label: p.label, href: p.href, keys: [p.label, p.href] })

  const names = new Set<string>()
  if (projects instanceof Error) problems.push(`projects could not be read: ${reason(projects)}`)
  else for (const p of projects) names.add(p)
  if (tasks instanceof Error) problems.push(`tickets could not be read: ${reason(tasks)}`)
  else for (const t of tasks) names.add(t.project)

  const sorted = [...names].sort()
  for (const p of sorted) {
    entries.push({
      group: 'Projects',
      label: p,
      href: `/?project=${encodeURIComponent(p)}`,
      keys: [p],
    })
  }
  for (const p of sorted) {
    entries.push({
      group: 'Recipes',
      label: `recipe · ${p}`,
      href: `/recipe/${encodeURIComponent(p)}`,
      keys: [p, `recipe ${p}`],
    })
  }
  if (!(tasks instanceof Error)) {
    for (const t of tasks) {
      entries.push({
        group: 'Tickets',
        label: t.title.trim() === '' ? `#${t.issue}` : `#${t.issue} ${t.title}`,
        detail: `${t.project} · ${TICKET_WORD[t.state] ?? t.state}`,
        href: `/task/${encodeURIComponent(t.taskId)}`,
        keys: [t.issue, t.title, t.taskId],
      })
    }
  }
  return { entries, problems }
}

/** Lower rank is better; `null` is no match. */
function rank(e: Entry, q: string, issue: string | null): number | null {
  if (issue !== null && e.group === 'Tickets' && e.keys[0] === issue) return 0
  const keys = [...e.keys, e.label].map((k) => k.toLowerCase())
  if (keys.some((k) => k.startsWith(q))) return 1
  if (keys.some((k) => k.includes(q))) return 2
  return null
}

/**
 * The results for a query, flat, in group order and at most `PER_GROUP` from
 * each. An empty query lists the pages and projects and no tickets.
 */
export function search(index: Index, query: string): Entry[] {
  const q = query.trim().toLowerCase()
  const out: Entry[] = []
  if (q === '') {
    for (const g of ['Pages', 'Projects'] as const) {
      out.push(...index.entries.filter((e) => e.group === g).slice(0, PER_GROUP))
    }
    return out
  }
  const m = /^#?(\d+)$/.exec(q)
  const issue = m ? (m[1] as string) : null
  for (const g of GROUPS) {
    const ranked: { e: Entry; r: number; i: number }[] = []
    index.entries.forEach((e, i) => {
      if (e.group !== g) return
      const r = rank(e, q, issue)
      if (r !== null) ranked.push({ e, r, i })
    })
    ranked.sort((a, b) => a.r - b.r || a.i - b.i)
    out.push(...ranked.slice(0, PER_GROUP).map((x) => x.e))
  }
  return out
}

// ----------------------------------------------------------------- keyboard --

export interface KeyLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  isComposing?: boolean
  keyCode?: number
}

/** A key pressed while an IME composition is open is the composition's. Safari reports it only as 229. */
const composing = (k: KeyLike): boolean => k.isComposing === true || k.keyCode === 229

/** ⌘K on macOS, Ctrl+K elsewhere; never while composing. */
export function isOpenKey(k: KeyLike, isMac: boolean): boolean {
  if (composing(k)) return false
  if (k.key.toLowerCase() !== 'k') return false
  return isMac ? k.metaKey === true && k.ctrlKey !== true : k.ctrlKey === true
}

export interface PaletteState {
  selected: number
}

export type Effect = { go: string; newTab: boolean } | { close: true } | null

/** What a key does to the list: the new selection and, maybe, somewhere to go. */
export function paletteKey(
  state: PaletteState,
  results: readonly Entry[],
  k: KeyLike,
): { state: PaletteState; effect: Effect } {
  const same = { state, effect: null }
  if (composing(k)) return same
  const n = results.length
  const at = (i: number) => ({ state: { selected: i }, effect: null })
  switch (k.key) {
    case 'ArrowDown':
      return n === 0 ? same : at((state.selected + 1) % n)
    case 'ArrowUp':
      return n === 0 ? same : at((state.selected - 1 + n) % n)
    case 'Home':
      return n === 0 ? same : at(0)
    case 'End':
      return n === 0 ? same : at(n - 1)
    case 'Escape':
      return { state, effect: { close: true } }
    case 'Enter': {
      const e = results[state.selected]
      if (e === undefined) return same
      return { state, effect: { go: e.href, newTab: k.metaKey === true || k.ctrlKey === true } }
    }
    default:
      return same
  }
}
