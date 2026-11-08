/**
 * The pure half of step 1 (#970): the rows the page hands the client, the
 * filter, what a typed value counts as, and the one place a step-2 URL is
 * built. No value imports — the client component imports this, and a client
 * graph must not reach `@lingtai/setup` (`unit/client-graph.test.ts`).
 */

export interface Row {
  slug: string
  /** Why this row cannot be picked ("already added", "taken by x"), or null. */
  disabled: string | null
  private: boolean
}

/** One heading and its rows: an installation's account, or the `gh` login. */
export interface Group {
  label: string
  sentences: string[]
  rows: Row[]
}

export interface ListView {
  groups: Group[]
  /** Sentences that belong beside the whole list. */
  notes: string[]
  /** The App's install link, when nothing is installed yet. */
  installUrl: string | null
}

export type Source = { list: ListView } | { error: string } | null

export interface LocalView {
  ok: boolean
  /** The sentence under the box. */
  say: string
  path: string
  branch: string | null
}

export type Choice = { kind: 'repo'; slug: string } | { kind: 'path'; path: string }

const SLUG = /^[\w.-]+\/[\w.-]+$/

export const filterRows = (rows: readonly Row[], query: string): Row[] => {
  const q = query.trim().toLowerCase()
  return q === '' ? [...rows] : rows.filter((r) => r.slug.toLowerCase().includes(q))
}

/** Whether a typed `owner/repo` can be taken: well-formed and not a disabled row. */
export const typedSlug = (typed: string, groups: readonly Group[]): string | null => {
  const t = typed.trim()
  if (!SLUG.test(t)) return null
  const hit = groups.flatMap((g) => g.rows).find((r) => r.slug.toLowerCase() === t.toLowerCase())
  return hit !== undefined && hit.disabled !== null ? null : t
}

export const nextHref = (choice: Choice): string =>
  choice.kind === 'repo'
    ? `/setup/repository/read?repo=${encodeURIComponent(choice.slug)}`
    : `/setup/repository/read?path=${encodeURIComponent(choice.path)}`
