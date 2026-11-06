/**
 * What the board is told of a `blocked-by` skip (#954): data only, read through
 * a per-process cache, and never a card.
 */
import { projectFilter } from '@lingtai/conductor/filter'
import type { ProjectState } from '@lingtai/domain'
import type { LinkedIssue } from '@lingtai/github'
import { resolveRecipe } from '@lingtai/recipe'
import { beforeEach, describe, expect, it } from 'vitest'

import { BLOCKERS_READ_MOST, askProject, forgetBlockers, githubQueue, type ProjectQueue } from '../src/lib/board.ts'

const skip = (ref: number, blockedBy: number | null = 1) => ({
  ref,
  reason: 'blocked-by' as const,
  title: `issue ${ref}`,
  kind: 'bug',
  blockedBy,
  parent: null,
  subIssues: null,
})

const blocker = (number: number): LinkedIssue => ({ number }) as unknown as LinkedIssue

const RECIPE = `
version: 2
repo: { base: main, remote: git@example.com:o/r.git }
source: { kinds: [bug], exclude: [agent:hold] }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

const state = { project: 'p', owner: 'o', repo: 'r', base: 'main' } as unknown as ProjectState

/** The real `projectFilter` over a client that lists `skipped` and counts its blocker reads. */
async function setup(skipped: ReturnType<typeof skip>[], read: (ref: number) => Promise<LinkedIssue[]>, links = true) {
  const calls: number[] = []
  const client = {
    owner: 'o',
    repo: 'r',
    listBlockedBy: (ref: number) => {
      calls.push(ref)
      return read(ref)
    },
    listOpenIssues: async () =>
      skipped.map((s) => ({
        number: s.ref,
        title: s.title,
        body: '',
        state: 'open',
        url: '',
        labels: [{ name: 'bug', color: null }],
        assignees: [],
        parent: null,
        subIssues: null,
        dependencies: { blockedBy: s.blockedBy ?? 0, totalBlockedBy: s.blockedBy ?? 0 },
      })),
  }
  // A `ticketsFor` that hands the client back is a GitHub project; one that
  // hands back anything else is a `db` project, even with an owner.
  const other = { listOpenIssues: client.listOpenIssues }
  const filter = await projectFilter(
    state,
    async () => client as never,
    (s) => resolveRecipe(async () => RECIPE, s.base ?? 'main'),
    (async () => (links ? client : other)) as never,
  )
  if (!filter.ok) throw new Error(filter.problem)
  const select = async () => []
  return { filter, calls, select }
}

const blockedOf = (q: ProjectQueue) => (q.state === 'listed' ? q.blocked : [])

beforeEach(() => forgetBlockers())

describe('the blockers of a blocked-by skip', () => {
  it('are read, and one failing read is that skip’s alone', async () => {
    const { filter, select } = await setup([skip(1), skip(2), skip(3)], async (ref) => {
      if (ref === 2) throw new Error('boom')
      return [blocker(ref + 100)]
    })
    const q = await askProject(filter, { select })
    expect(q.state).toBe('listed')
    const b = blockedOf(q)
    expect(b.map((x) => x.blockers)).toEqual([
      { ok: true, issues: [blocker(101)] },
      { ok: false, problem: 'boom' },
      { ok: true, issues: [blocker(103)] },
    ])
    expect(b[0]).toMatchObject({ project: 'p', ref: 1, title: 'issue 1', kind: 'bug', blockedBy: 1, unread: false })
  })

  it('make no request inside 60 s at the same count, and read again at a new count or after', async () => {
    let t = 1_000
    const { filter, calls, select } = await setup([skip(1)], async () => [blocker(9)])
    await askProject(filter, { select, now: () => t })
    t += 59_999
    await askProject(filter, { select, now: () => t })
    expect(calls).toEqual([1])
    t += 1
    await askProject(filter, { select, now: () => t })
    expect(calls).toEqual([1, 1])

    const changed = await setup([skip(1, 2)], async () => [blocker(9)])
    await askProject(changed.filter, { select, now: () => t })
    expect(changed.calls).toEqual([1])
  })

  it('cache a failure for the same window', async () => {
    let t = 0
    const { filter, calls, select } = await setup([skip(1)], async () => {
      throw new Error('denied')
    })
    await askProject(filter, { select, now: () => t })
    t += 1_000
    const q = await askProject(filter, { select, now: () => t })
    expect(calls).toEqual([1])
    expect(blockedOf(q)[0]!.blockers).toEqual({ ok: false, problem: 'denied' })
  })

  it('read the lowest numbers first, up to the cap, and count the rest', async () => {
    const refs = Array.from({ length: BLOCKERS_READ_MOST + 2 }, (_, i) => i + 1)
    const shuffled = [...refs].reverse()
    const { filter, calls, select } = await setup(
      shuffled.map((r) => skip(r)),
      async () => [],
    )
    const b = blockedOf(await askProject(filter, { select }))
    expect([...calls].sort((x, y) => x - y)).toEqual(refs.slice(0, BLOCKERS_READ_MOST))
    expect(b.filter((x) => x.unread).map((x) => x.ref)).toEqual([21, 22])
    expect(b.filter((x) => x.unread).every((x) => x.blockers === null)).toBe(true)
  })

  it('are not asked for when there is no link reader', async () => {
    const { filter, calls, select } = await setup([skip(1)], async () => [], false)
    const b = blockedOf(await askProject(filter, { select }))
    expect(calls).toEqual([])
    expect(b[0]).toMatchObject({ blockers: null, unread: false })
  })
})

describe('the board’s cards', () => {
  it('are untouched by blocked skips', async () => {
    const { filter, select } = await setup([skip(1)], async () => [])
    const q = await askProject(filter, { select })
    const out = await githubQueue([filter], new Set(), async () => q)
    expect(out.cards).toEqual([])
    expect(out.blocked).toHaveLength(1)
  })
})
