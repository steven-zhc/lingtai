/**
 * The ⌘K search (#908): the index the route builds, the ranking, and the
 * keyboard — all pure.
 *
 * **This is the one `@/lib/` file a `"use client"` file may import**, so its
 * imports are types only. A server-only import reaching a client graph is
 * caught by the Next build after the merge and by nothing before it (#230);
 * `unit/palette.test.tsx` holds this file to the rule.
 */
import type { PrStatus } from '@lingtai/domain'
import type { TaskCard, TaskState } from '@lingtai/projector/task-view'

import { homePath, prPath, recipePath, ticketPath } from './paths.ts'

export type Group = 'Pages' | 'Projects' | 'Recipes' | 'Tickets' | 'PRs'

export const GROUPS: readonly Group[] = ['Pages', 'Projects', 'Recipes', 'Tickets', 'PRs']

export interface Entry {
  group: Group
  label: string
  detail?: string
  href: string
  /** Set on a `Projects` entry: the name a pick remembers (#1435), so nothing parses it back out of `href`. */
  project?: string
  keys: string[]
  /** The number a query of just digits finds this by at rank 0; `hash` when `#<n>` names it (a ticket, a PR with a host number). */
  number?: { value: string; hash: boolean }
}

/** A PR as the route hands it over: plain data, so this file imports no PR code. */
export interface SearchPr {
  project: string
  /** Lingtai's id: the href, and what `pr <n>` finds before the host has a number. */
  n: number
  /** The code host's number; `#<n>` names only this. */
  host: number | null
  name: string
  title: string | null
  branch: string | null
  status: PrStatus
  /** Every ticket the PR has ever named: its keys. */
  tickets: string[]
  /** The tickets it holds now: what a ticket's *in PR* says. */
  holding: string[]
}

export const PR_WORD: Record<PrStatus, string> = {
  draft: 'draft',
  requested: 'requested',
  'in-progress': 'in progress',
  waiting: 'waiting on you',
  'in-review': 'in review',
  refused: 'refused',
  merged: 'merged',
  closed: 'closed',
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
  satisfied: 'satisfied',
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
  prs,
}: {
  tasks: readonly TaskCard[] | Error
  projects: readonly string[] | Error
  prs?: ReadonlyMap<string, readonly SearchPr[] | Error>
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
      href: homePath(p),
      project: p,
      keys: [p],
    })
  }
  for (const p of sorted) {
    entries.push({
      group: 'Recipes',
      label: `recipe · ${p}`,
      href: recipePath(p),
      keys: [p, `recipe ${p}`],
    })
  }
  const holder = new Map<string, string>()
  for (const [project, read] of prs ?? []) {
    if (read instanceof Error) {
      problems.push(`PRs could not be read for ${project}: ${reason(read)}`)
      continue
    }
    for (const pr of read) for (const t of pr.holding) holder.set(`${project}\u0000${t}`, pr.name)
  }
  if (!(tasks instanceof Error)) {
    for (const t of tasks) {
      const inPr = holder.get(`${t.project}\u0000${t.issue}`)
      entries.push({
        group: 'Tickets',
        label: t.title.trim() === '' ? `#${t.issue}` : `#${t.issue} ${t.title}`,
        detail: `${t.project} · ${TICKET_WORD[t.state] ?? t.state}${inPr === undefined ? '' : ` · in ${inPr}`}`,
        href: ticketPath({ project: t.project, issue: t.issue }),
        keys: [t.issue, t.title, t.taskId],
        number: { value: t.issue, hash: true },
      })
    }
  }
  for (const [project, read] of prs ?? []) {
    if (read instanceof Error) continue
    for (const pr of read) {
      const title = pr.title?.trim() ?? ''
      const k = pr.tickets.length
      entries.push({
        group: 'PRs',
        label: title === '' ? pr.name : `${pr.name} ${title}`,
        detail: `${project} · ${PR_WORD[pr.status] ?? pr.status} · ${k} ${k === 1 ? 'ticket' : 'tickets'}`,
        href: prPath(project, pr.n),
        keys: [
          ...(pr.host === null ? [] : [String(pr.host)]),
          title,
          pr.branch ?? '',
          ...pr.tickets.flatMap((t) => [t, `#${t}`]),
        ],
        number: pr.host === null ? { value: String(pr.n), hash: false } : { value: String(pr.host), hash: true },
      })
    }
  }
  return { entries, problems }
}

/** How a number was typed: `88`, `#88` or `pr 88`. */
interface NumberQuery {
  kind: 'bare' | 'hash' | 'pr'
  digits: string
}

function numberQuery(q: string): NumberQuery | null {
  const m = /^(#|pr\s*#?)?(\d+)$/i.exec(q)
  if (!m) return null
  const kind = m[1] === undefined ? 'bare' : m[1] === '#' ? 'hash' : 'pr'
  return { kind, digits: m[2] as string }
}

/** The query's letters in order, with gaps, in `label`: how tight (span) and how early (start). Null when not a subsequence. */
export function fuzzy(q: string, label: string): { span: number; start: number } | null {
  const letters = q.replace(/\s+/g, '').toLowerCase()
  if (letters === '') return null
  const text = label.toLowerCase()
  let best: { span: number; start: number } | null = null
  for (let from = text.indexOf(letters[0] as string); from >= 0; from = text.indexOf(letters[0] as string, from + 1)) {
    let at = from
    let ok = true
    for (let k = 1; k < letters.length; k++) {
      at = text.indexOf(letters[k] as string, at + 1)
      if (at < 0) {
        ok = false
        break
      }
    }
    if (!ok) break
    if (best === null || at - from < best.span) best = { span: at - from, start: from }
  }
  return best
}

/** The shortest query that fuzzy-matches: two letters would light every title. */
const FUZZY_MIN = 3

/** `[rank, span, start]`, lower is better; `null` is no match. */
function rank(e: Entry, q: string, num: NumberQuery | null): [number, number, number] | null {
  if (num !== null && e.number !== undefined && e.number.value === num.digits) {
    if (num.kind === 'pr' ? e.group === 'PRs' : e.number.hash) return [0, 0, 0]
  }
  const keys = [...e.keys, e.label].map((k) => k.toLowerCase())
  if (keys.some((k) => k !== '' && k.startsWith(q))) return [1, 0, 0]
  if (keys.some((k) => k !== '' && k.includes(q))) return [2, 0, 0]
  if (num === null && q.replace(/\s+/g, '').length >= FUZZY_MIN) {
    const f = fuzzy(q, e.label)
    if (f !== null) return [3, f.span, f.start]
  }
  return null
}

/**
 * The results for a query, flat, in group order (`pr <n>` puts PRs first; the palette
 * draws groups in the order they appear here) and at most `PER_GROUP` from
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
  const num = numberQuery(q)
  // `pr 88` asks for a PR: its group leads.
  const order = num?.kind === 'pr' ? ['PRs' as const, ...GROUPS.filter((g) => g !== 'PRs')] : GROUPS
  for (const g of order) {
    const ranked: { e: Entry; r: [number, number, number]; i: number }[] = []
    index.entries.forEach((e, i) => {
      if (e.group !== g) return
      const r = rank(e, q, num)
      if (r !== null) ranked.push({ e, r, i })
    })
    ranked.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.i - b.i)
    out.push(...ranked.slice(0, PER_GROUP).map((x) => x.e))
  }
  return out
}

// ----------------------------------------------------------------- keyboard --

export interface KeyLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
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

/** Where a key landed, as plain data: the tag, and whether it is a `contenteditable`. */
export interface TargetLike {
  tag: string
  editable: boolean
}

const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** A key is never bound while focus is in a field. */
export const inField = (t: TargetLike): boolean => t.editable || FIELDS.has(t.tag.toUpperCase())

const modified = (k: KeyLike): boolean => k.metaKey === true || k.ctrlKey === true || k.altKey === true

/** `#` outside a field opens the palette with `#` typed. Matched on `key`, never `keyCode`; never while composing. */
export function isHashKey(k: KeyLike, t: TargetLike): boolean {
  return !composing(k) && k.key === '#' && !modified(k) && !inField(t)
}

/** How long `g` waits for its second key. */
export const GO_WINDOW_MS = 1500

export interface GoState {
  armedAt: number | null
}

export type GoEffect = { go: 't' | 'p' | 's' } | null

/** `G T`, `G P`, `G S`: `g` arms for 1500 ms, the next key is the place; any other key disarms. */
export function goKey(state: GoState, k: KeyLike, t: TargetLike, now: number): { state: GoState; effect: GoEffect } {
  const off = { state: { armedAt: null }, effect: null }
  if (composing(k) || inField(t)) return off
  // A bare modifier is part of typing `G`, not a second key.
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(k.key)) return { state, effect: null }
  if (modified(k)) return off
  const key = k.key.toLowerCase()
  if (state.armedAt !== null && now - state.armedAt <= GO_WINDOW_MS && (key === 't' || key === 'p' || key === 's')) {
    return { state: { armedAt: null }, effect: { go: key } }
  }
  return key === 'g' ? { state: { armedAt: now }, effect: null } : off
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
