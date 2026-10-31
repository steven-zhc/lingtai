/**
 * The release notes' *Tickets landed* section (#776): the tickets the merge
 * lane landed between the previous release and this tag, grouped by kind.
 * GitHub's generated notes list pull requests and the lane opens none.
 */
import { readFileSync } from 'node:fs'

/** Priority order, which is also the order the groups print in. */
export const KINDS = ['bug', 'tech-debt', 'feature', 'documentation'] as const

const LANDING = /^Merge branch 'agent\/(\d+)' into HEAD$/

/** Ticket numbers from first-parent subjects: anchored, deduplicated, in first-landing order. */
export function landedTickets(subjects: string[]): number[] {
  const seen = new Set<number>()
  for (const s of subjects) {
    const m = LANDING.exec(s)
    if (m) seen.add(Number(m[1]))
  }
  return [...seen]
}

export type Ticket = { n: number; found: false } | { n: number; found: true; title: string; labels: string[] }

export type IssueRead = { found: false } | { found: true; title: string; labels: string[] }

type Fetch = (url: string, init?: RequestInit) => Promise<Pick<Response, 'status' | 'ok' | 'json'>>

/** 404 and 410 (GitHub's answer for a deleted issue) are "not found"; any other failure throws. */
export async function readIssue(fetch: Fetch, repo: string, token: string, n: number): Promise<IssueRead> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${n}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (res.status === 404 || res.status === 410) return { found: false }
  if (!res.ok) throw new Error(`reading issue #${n} of ${repo} answered ${res.status}`)
  const body = (await res.json()) as { title: string; labels?: Array<string | { name?: string }> }
  const labels = (body.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
  return { found: true, title: body.title, labels }
}

const kindOf = (labels: string[]): string => KINDS.find((k) => labels.includes(k)) ?? 'Other'

export function renderTickets(input: {
  repo: string
  tag: string
  prev: string | undefined
  tickets: Ticket[]
}): string {
  const { repo, tag, prev, tickets } = input
  if (!prev) return '## Tickets landed\n\nNo earlier release to compare against.\n'
  const groups = new Map<string, string[]>()
  for (const t of tickets) {
    const kind = t.found ? kindOf(t.labels) : 'Other'
    const line = t.found ? `- #${t.n} ${t.title}` : `- #${t.n} (issue not found)`
    groups.set(kind, [...(groups.get(kind) ?? []), line])
  }
  const out = ['## Tickets landed', '']
  for (const kind of [...KINDS, 'Other']) {
    const lines = groups.get(kind)
    if (lines) out.push(`### ${kind}`, '', ...lines, '')
  }
  out.push(`Full diff: https://github.com/${repo}/compare/${prev}...${tag}`)
  return out.join('\n') + '\n'
}

if (import.meta.main) {
  // tickets-changed.ts <repo> <tag> [<landings file> <previous tag>]
  const [repo, tag, file, prev] = process.argv.slice(2)
  if (!repo || !tag) throw new Error('usage: tickets-changed.ts <repo> <tag> [<landings file> <previous tag>]')
  if (!file || !prev) {
    process.stdout.write(renderTickets({ repo, tag, prev: undefined, tickets: [] }))
  } else {
    const token = process.env.GH_TOKEN
    if (!token) throw new Error('GH_TOKEN is not set: an anonymous read would hit the rate limit as a 403')
    const numbers = landedTickets(readFileSync(file, 'utf8').split('\n'))
    const tickets: Ticket[] = []
    for (const n of numbers) tickets.push({ n, ...(await readIssue(fetch, repo, token, n)) })
    process.stdout.write(renderTickets({ repo, tag, prev, tickets }))
  }
}
