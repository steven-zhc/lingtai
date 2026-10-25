/**
 * Reconciling a split against GitHub (#561): a fake that issues ids unlike
 * numbers, a fault at every write position in both ways it can go wrong, and a
 * retry until the plan is whole — checked against `createMemoryEventStore()`.
 */
import { type Envelope, reduceTicket, splitProgressOf, ticketStream } from '@lingtai/domain'
import { aClaim, aRun, aRunRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { Issue } from '@lingtai/github'
import { describe, expect, it } from 'vitest'

import { resolveWaitHolding } from '../src/resolve-wait.ts'
import { type SplitPort, splitMarker } from '../src/split.ts'

const PROJECT = 'lingtai'
const PARENT = 561

const child = (key: string) => ({ key, title: `child ${key}`, body: `work on ${key}`, kind: 'feature' })
const PLAN = {
  _tag: 'Split' as const,
  children: [child('a'), child('b'), child('c')],
  blockedBy: [
    { ticket: 'b', blockedBy: 'a' },
    { ticket: 'c', blockedBy: 'b' },
  ],
}

type Op = 'create' | 'sub' | 'edge'
type Fault = { op: Op; at: number; mode: 'before' | 'after' }

/** GitHub as far as a split sees it. `id = number * 1000 + 7`, so a number given as an id is refused. */
function fakeGitHub(fault?: Fault) {
  const issues: (Issue & { createdAt: number })[] = []
  const subs = new Map<number, Set<number>>()
  const blocks = new Map<number, Set<number>>()
  const calls: Record<Op, number> = { create: 0, sub: 0, edge: 0 }
  let next = 600
  let spent = false

  /** Throws on the chosen call: before it lands, or after. Returns whether to throw after. */
  const attempt = (op: Op): boolean => {
    const n = calls[op]++
    if (fault === undefined || spent || fault.op !== op || fault.at !== n) return false
    spent = true
    if (fault.mode === 'before') throw new Error(`${op} timed out before landing`)
    return true
  }
  const issued = (id: number) => issues.some((i) => i.id === id)
  const numberOf = (id: number) => issues.find((i) => i.id === id)?.number

  const port: SplitPort = {
    listIssuesSince: async () => issues.map((i) => ({ ...i })),
    createIssue: async (input) => {
      const throwAfter = attempt('create')
      const number = next++
      const issue: Issue & { createdAt: number } = {
        number,
        id: (number * 1000 + 7) as Issue['id'],
        title: input.title,
        body: input.body,
        labels: input.labels.map((name) => ({ name, color: null })),
        state: 'open',
        url: `https://example.invalid/${number}`,
        dependencies: null,
        assignees: [],
        createdAt: number,
      }
      issues.push(issue)
      if (throwAfter) throw new Error('create timed out after landing')
      return issue
    },
    getIssue: async (n) => {
      const hit = issues.find((i) => i.number === n)
      if (hit === undefined) throw new Error(`GET /issues/${n}: 404 Not Found`)
      return { ...hit }
    },
    comment: async () => ({ id: 1 }),
    closeIssue: async (n) => {
      const hit = issues.find((i) => i.number === n)
      if (hit) hit.state = 'closed'
    },
    subIssues: async (parent) =>
      [...(subs.get(parent) ?? [])].map((n) => ({ number: n, id: (n * 1000 + 7) as Issue['id'] })),
    addSubIssue: async (parent, childId) => {
      const throwAfter = attempt('sub')
      const n = numberOf(childId)
      if (n === undefined) throw new Error(`sub_issue_id ${childId} is not an issue id`)
      subs.set(parent, (subs.get(parent) ?? new Set()).add(n))
      if (throwAfter) throw new Error('sub timed out after landing')
    },
    blockedBy: async (issue) =>
      [...(blocks.get(issue) ?? [])].map((id) => ({ number: numberOf(id)!, id: id as Issue['id'] })),
    addBlockedBy: async (issue, blocker) => {
      const throwAfter = attempt('edge')
      if (!issued(blocker)) throw new Error(`issue_id ${blocker} is not an issue id`)
      blocks.set(issue, (blocks.get(issue) ?? new Set()).add(blocker))
      if (throwAfter) throw new Error('edge timed out after landing')
    },
    removeSubIssue: async (parent, childId) => {
      subs.get(parent)?.delete(numberOf(childId)!)
    },
    removeBlockedBy: async (issue, blocker) => {
      blocks.get(issue)?.delete(blocker)
    },
  }
  return { port, issues, subs, blocks, calls }
}

async function blockedOnFirstWait(github: { port: SplitPort }) {
  const store = createMemoryEventStore()
  const ticketId = ticketStream(PROJECT, PARENT)
  const item = makeStream(ticketId)
  const run = aRun('pass-561')
  const waitId = aWaitId()
  await store.append(ticketId, 0, [
    ...aClaim(item, run.runId),
    ...aWait(item, { _tag: 'NothingProduced', run: aRunRef(run.runId), said: null }, waitId),
  ])
  const split = (resolution: unknown = PLAN) =>
    resolveWaitHolding(
      {
        ticketId,
        waitId,
        resolution: resolution as never,
        by: 'human:steven',
        kinds: ['feature'],
        links: github.port,
        store,
      },
      ticketId,
    )
  return { store, ticketId, waitId, split }
}

const types = (events: readonly Envelope[], type: string) => events.filter((e) => e.type === type)

describe('reconcileSplit through resolveWaitHolding (#561)', () => {
  it('refuses a project with no GitHub links before any write', async () => {
    const github = fakeGitHub()
    const { store, ticketId, waitId } = await blockedOnFirstWait(github)
    const before = (await store.read(ticketId)).length
    const result = await resolveWaitHolding(
      { ticketId, waitId, resolution: PLAN as never, by: 'human:steven', kinds: ['feature'], store },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'split-unsupported' })
    expect((await store.read(ticketId)).length).toBe(before)
    expect(github.issues).toHaveLength(0)
  })

  it('creates held children, attaches them and links them, and still does not resolve the wait', async () => {
    const github = fakeGitHub()
    const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
    expect(await split()).toMatchObject({ ok: false, reason: 'split-not-resolved' })

    expect(github.issues.map((i) => i.labels.map((l) => l.name))).toEqual(Array(3).fill(['feature', 'agent:hold']))
    expect(github.issues[0]!.body).toContain(splitMarker(PARENT, waitId, PLAN, 'a'))
    const [a, b, c] = github.issues
    expect(github.subs.get(PARENT)).toEqual(new Set([a!.number, b!.number, c!.number]))
    expect(github.blocks.get(b!.number)).toEqual(new Set([a!.id]))
    expect(github.blocks.get(c!.number)).toEqual(new Set([b!.id]))

    const events = await store.read(ticketId)
    expect(types(events, 'WaitResolved')).toHaveLength(0)
    expect(reduceTicket(events).lifecycle).toMatchObject({ status: 'blocked', waitId })
    const progress = splitProgressOf(events, waitId)!
    expect(progress.owed.complete).toBe(true)
    expect(progress.identities.map((x) => x.number)).toEqual([a!.number, b!.number, c!.number])
    expect(progress.observed.children).toEqual(['a', 'b', 'c'])
  })

  it('a second command on a whole split creates and writes nothing', async () => {
    const github = fakeGitHub()
    const { split } = await blockedOnFirstWait(github)
    await split()
    const calls = { ...github.calls }
    expect(await split()).toMatchObject({ reason: 'split-not-resolved' })
    expect(github.calls).toEqual(calls)
    expect(github.issues).toHaveLength(3)
  })

  const positions: [Op, number][] = [
    ['create', 0],
    ['create', 1],
    ['create', 2],
    ['sub', 0],
    ['sub', 1],
    ['sub', 2],
    ['edge', 0],
    ['edge', 1],
  ]
  for (const [op, at] of positions) {
    for (const mode of ['before', 'after'] as const) {
      it(`a ${op} write #${at} that throws ${mode === 'before' ? 'before landing' : 'after landing'} is reconciled by retrying`, async () => {
        const github = fakeGitHub({ op, at, mode })
        const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)

        const first = await split()
        expect(first).toMatchObject({ ok: false, reason: 'split-partial' })
        expect(first.ok === false && first.detail).toContain('timed out')

        let last = first
        for (let i = 0; i < 4 && last.ok === false && last.reason !== 'split-not-resolved'; i++) last = await split()
        expect(last).toMatchObject({ ok: false, reason: 'split-not-resolved' })

        // One issue per key.
        for (const c of PLAN.children)
          expect(github.issues.filter((i) => i.body.includes(splitMarker(PARENT, waitId, PLAN, c.key)))).toHaveLength(1)
        expect(github.issues).toHaveLength(3)
        const byKey = new Map(PLAN.children.map((c, i) => [c.key, github.issues[i]!]))
        // Every edge exists on the dependent child and names the blocker's id.
        for (const d of PLAN.blockedBy)
          expect(github.blocks.get(byKey.get(d.ticket)!.number)).toContain(byKey.get(d.blockedBy)!.id)
        expect(github.subs.get(PARENT)?.size).toBe(3)

        // Nothing but the last attempt claims completion; nothing resolved the wait.
        const events = await store.read(ticketId)
        const reconciled = types(events, 'SplitReconciled').map(
          (e) => e.data as { observed: never; failure: string | null },
        )
        expect(reconciled.length).toBeGreaterThanOrEqual(2)
        expect(reconciled[0]!.failure).not.toBeNull()
        expect(types(events, 'WaitResolved')).toHaveLength(0)
        expect(types(events, 'SplitStarted')).toHaveLength(1)
        expect(splitProgressOf(events, waitId)!.owed.complete).toBe(true)
        expect(reconciled.at(-1)!.failure).toBeNull()
      })
    }
  }

  it('records only what a read-back returned: a create that threw before landing is owed', async () => {
    const github = fakeGitHub({ op: 'create', at: 1, mode: 'before' })
    const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
    await split()
    const progress = splitProgressOf(await store.read(ticketId), waitId)!
    expect(progress.identities.map((c) => c.key)).toEqual(['a'])
    expect(progress.observed.children).toEqual(['a'])
    expect(progress.owed.children).toEqual(['b', 'c'])
    expect(progress.owed.complete).toBe(false)
  })

  it('does not write after a read-back failure, and counts an unread item as owed', async () => {
    const github = fakeGitHub()
    const real = github.port.subIssues
    let reads = 0
    github.port.subIssues = async (parent) => {
      if (++reads === 2) throw new Error('listing timed out')
      return real(parent)
    }
    const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
    const result = await split()
    expect(result).toMatchObject({ reason: 'split-partial' })
    const progress = splitProgressOf(await store.read(ticketId), waitId)!
    expect(progress.failure).toContain('read-back failed')
    expect(progress.owed.complete).toBe(false)
    expect(progress.identities).toHaveLength(3)
    expect(progress.owed.subIssues).toEqual(['a', 'b', 'c'])
  })

  it('a duplicate opened by a racing reconcile is withdrawn and the older issue is the child', async () => {
    const github = fakeGitHub()
    const { split, waitId } = await blockedOnFirstWait(github)
    const real = github.port.createIssue
    let raced = false
    github.port.createIssue = async (input) => {
      if (!raced) {
        raced = true
        // The other caller's issue lands first, then ours.
        await real(input)
      }
      return real(input)
    }
    await split()
    const open = github.issues.filter((i) => i.state === 'open')
    expect(open).toHaveLength(3)
    expect(github.issues.filter((i) => i.state === 'closed')).toHaveLength(1)
    expect(open.filter((i) => i.body.includes(splitMarker(PARENT, waitId, PLAN, 'a')))).toHaveLength(1)
  })

  it('does not take a sub-issue from another repository with the same number for the child', async () => {
    const github = fakeGitHub()
    const real = github.port.subIssues
    // Numbers are per repository: this one is #600 over there, with an id of its own.
    github.port.subIssues = async (parent) => [...(await real(parent)), { number: 600, id: 42 as Issue['id'] }]
    const { split } = await blockedOnFirstWait(github)
    expect(await split()).toMatchObject({ reason: 'split-not-resolved' })
    expect(github.issues[0]!.number).toBe(600)
    expect(github.subs.get(PARENT)).toContain(600)
    expect(github.calls.sub).toBe(3)
  })

  it('keeps retrying a duplicate withdrawal that failed, and is not complete while one is open', async () => {
    const github = fakeGitHub()
    const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
    const create = github.port.createIssue
    let raced = false
    github.port.createIssue = async (input) => {
      if (!raced) {
        raced = true
        await create(input)
      }
      return create(input)
    }
    const close = github.port.closeIssue
    let closes = 0
    github.port.closeIssue = async (n, reason) => {
      if (closes++ === 0) throw new Error('close timed out')
      return close(n, reason)
    }
    expect(await split()).toMatchObject({ reason: 'split-partial' })
    // The failed close stopped the writing: the child and its open duplicate.
    expect(github.issues.filter((i) => i.state === 'open')).toHaveLength(2)
    expect(splitProgressOf(await store.read(ticketId), waitId)!.failure).toContain('close timed out')
    expect(await split()).toMatchObject({ reason: 'split-not-resolved' })
    expect(github.issues.filter((i) => i.state === 'open')).toHaveLength(3)
  })

  it('a duplicate that only becomes visible after a retry is withdrawn on the next attempt', async () => {
    const github = fakeGitHub()
    const { split } = await blockedOnFirstWait(github)
    await split()
    const [a] = github.issues
    github.issues.push({ ...a!, number: 700, id: 700_007 as Issue['id'], createdAt: 700 })
    expect(await split()).toMatchObject({ reason: 'split-not-resolved' })
    expect(github.issues.find((i) => i.number === 700)!.state).toBe('closed')
  })

  /** The original a lands but the listing omits it, so a retry makes the child the log records; then it shows up, linked. */
  async function aLinkedOriginalAppears() {
    const github = fakeGitHub({ op: 'create', at: 0, mode: 'after' })
    const run = await blockedOnFirstWait(github)
    const listed = github.port.listIssuesSince
    github.port.listIssuesSince = async () => (await listed(new Date())).filter((i) => i.number !== 600)
    expect(await run.split()).toMatchObject({ reason: 'split-partial' })
    expect(await run.split()).toMatchObject({ reason: 'split-not-resolved' })
    github.port.listIssuesSince = listed
    const at = (n: number) => github.issues.find((i) => i.number === n)!
    const [original, a, b, c] = [at(600), at(601), at(602), at(603)] as const
    // The original had been attached and made a blocker, and was itself blocked by the recorded a.
    github.subs.set(PARENT, (github.subs.get(PARENT) ?? new Set()).add(original.number))
    github.blocks.set(b.number, (github.blocks.get(b.number) ?? new Set()).add(original.id))
    github.blocks.set(original.number, new Set([a.id]))
    return { github, ...run, original, a, b, c }
  }

  it('unlinks a duplicate that is attached, a blocker, and blocked by one of ours; the recorded child stays', async () => {
    const { github, store, ticketId, waitId, split, original, a, b, c } = await aLinkedOriginalAppears()
    expect(await split()).toMatchObject({ reason: 'split-not-resolved' })
    expect(original.state).toBe('closed')
    expect(github.subs.get(PARENT)).toEqual(new Set([a.number, b.number, c.number]))
    expect(github.blocks.get(b.number)).toEqual(new Set([a.id]))
    // The assertion that fails if the duplicate-owned dependency cleanup is removed.
    expect(github.blocks.get(original.number)?.size ?? 0).toBe(0)
    const last = types(await store.read(ticketId), 'SplitReconciled').at(-1)!.data as { failure: string | null }
    expect(last.failure).toBeNull()
    expect(splitProgressOf(await store.read(ticketId), waitId)!.owed.complete).toBe(true)
  })

  it('is not complete while a withdrawn duplicate is still linked', async () => {
    const { github, store, ticketId, waitId, split } = await aLinkedOriginalAppears()
    github.port.removeSubIssue = async () => {
      throw new Error('unlink timed out')
    }
    expect(await split()).toMatchObject({ reason: 'split-partial' })
    const failure = splitProgressOf(await store.read(ticketId), waitId)!.failure
    expect(failure).toContain('unlink timed out')
    expect(failure).toContain('still linked')
  })

  describe('a child is the identity the log recorded (#561)', () => {
    const strip = (github: ReturnType<typeof fakeGitHub>, waitId: never, key: string) => {
      const issue = github.issues.find((i) => i.body.includes(splitMarker(PARENT, waitId, PLAN, key)))!
      issue.body = issue.body.replace(splitMarker(PARENT, waitId, PLAN, key), '')
      return issue
    }
    const carrying = (github: ReturnType<typeof fakeGitHub>) => github.issues.filter((i) => i.labels.length === 2)

    it('creates no second child for a recorded one whose marker a person removed', async () => {
      const github = fakeGitHub({ op: 'edge', at: 0, mode: 'before' })
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      const a = strip(github, waitId as never, 'a')
      const b = strip(github, waitId as never, 'b')
      const created = github.calls.create
      expect(await split()).toMatchObject({ reason: 'split-not-resolved' })
      expect(github.calls.create).toBe(created)
      expect(carrying(github)).toHaveLength(PLAN.children.length)
      const progress = splitProgressOf(await store.read(ticketId), waitId)!
      expect(progress.identities.map((i) => i.number)).toEqual([a.number, b.number, 602])
      expect(progress.owed.complete).toBe(true)
    })

    it('does the same when the first run stopped after a was created and before it was attached', async () => {
      const github = fakeGitHub({ op: 'create', at: 1, mode: 'before' })
      const { waitId, split } = await blockedOnFirstWait(github)
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      expect(github.subs.get(PARENT)?.size ?? 0).toBe(0)
      strip(github, waitId as never, 'a')
      expect(await split()).toMatchObject({ reason: 'split-not-resolved' })
      expect(carrying(github)).toHaveLength(3)
      expect(github.subs.get(PARENT)?.size).toBe(3)
    })

    it('makes a second child when the create threw and the marker is removed: nothing was recorded', async () => {
      const github = fakeGitHub({ op: 'create', at: 0, mode: 'after' })
      const { waitId, split } = await blockedOnFirstWait(github)
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      strip(github, waitId as never, 'a')
      // The documented residual window: no identity, so nothing to adopt by.
      await split()
      expect(carrying(github)).toHaveLength(4)
    })

    it.each([
      ['is gone (404)', (g: ReturnType<typeof fakeGitHub>) => g.issues.splice(0, 1)],
      [
        'has another id now',
        (g: ReturnType<typeof fakeGitHub>) => {
          g.issues[0]!.id = 999_999 as Issue['id']
        },
      ],
    ])('keeps a recorded child that %s unverified and never creates it again', async (_, damage) => {
      const github = fakeGitHub({ op: 'sub', at: 0, mode: 'before' })
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      await split()
      damage(github)
      const created = github.calls.create
      const result = await split()
      expect(result).toMatchObject({ ok: false, reason: 'split-partial' })
      expect(result.ok === false && result.detail).toContain('unverified child #600')
      expect(github.calls.create).toBe(created)
      const progress = splitProgressOf(await store.read(ticketId), waitId)!
      expect(progress.failure).toContain('recorded child #600 for "a" is not readable')
      expect(progress.owed.unverified).toEqual([{ key: 'a', number: 600 }])
      expect(progress.owed.children).toEqual([])
      expect(progress.owed.complete).toBe(false)
    })

    it('keeps a child a person closed, and says so', async () => {
      const github = fakeGitHub()
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      await split()
      github.issues[0]!.state = 'closed'
      const created = github.calls.create
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      expect(github.calls.create).toBe(created)
      const progress = splitProgressOf(await store.read(ticketId), waitId)!
      expect(progress.failure).toContain('recorded child #600 for "a" is closed')
      expect(progress.owed.unverified).toEqual([])
    })

    it('withdraws an older marker-carrying issue for a recorded key and keeps the recorded child', async () => {
      const github = fakeGitHub()
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      await split()
      const [a] = github.issues
      github.issues.push({ ...a!, number: 500, id: 500_007 as Issue['id'], createdAt: 500 })
      expect(await split()).toMatchObject({ reason: 'split-not-resolved' })
      expect(github.issues.find((i) => i.number === 500)!.state).toBe('closed')
      expect(a!.state).toBe('open')
      expect(splitProgressOf(await store.read(ticketId), waitId)!.identities[0]).toMatchObject({ number: 600 })
    })

    it('refuses a different plan once any identity is recorded, even with no marker to find', async () => {
      const github = fakeGitHub({ op: 'sub', at: 0, mode: 'before' })
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      await split()
      for (const key of ['a', 'b', 'c']) strip(github, waitId as never, key)
      const other = { ...PLAN, children: [child('x'), child('y')], blockedBy: [] }
      expect(await split(other)).toMatchObject({ reason: 'split-in-progress', detail: expect.stringContaining('#600') })
      expect(types(await store.read(ticketId), 'SplitStarted')).toHaveLength(1)
    })
  })

  describe('a plan change', () => {
    const other = { ...PLAN, children: [child('x'), child('y')], blockedBy: [] }

    it('is refused as split-in-progress once a child exists, naming it', async () => {
      const github = fakeGitHub({ op: 'create', at: 1, mode: 'before' })
      const { store, ticketId, split } = await blockedOnFirstWait(github)
      await split()
      const result = await split(other)
      expect(result).toMatchObject({ ok: false, reason: 'split-in-progress', detail: expect.stringContaining('#600') })
      expect(types(await store.read(ticketId), 'SplitStarted')).toHaveLength(1)
      expect(github.issues).toHaveLength(1)
    })

    it('never adopts a child of the superseded plan that only became visible after the plan changed', async () => {
      const github = fakeGitHub({ op: 'create', at: 0, mode: 'after' })
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      // The create landed but the listing does not show it yet.
      const listed = github.port.listIssuesSince
      github.port.listIssuesSince = async () => []
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      const edited = {
        ...PLAN,
        children: [{ ...child('a'), title: 'changed', body: 'new work' }, child('b'), child('c')],
      }
      await split(edited)
      github.port.listIssuesSince = listed
      expect(await split(edited)).toMatchObject({ reason: 'split-not-resolved' })
      const progress = splitProgressOf(await store.read(ticketId), waitId)!
      const a = progress.identities.find((c) => c.key === 'a')!
      const issue = github.issues.find((i) => i.number === a.number)!
      expect(issue.title).toBe('changed')
      expect(issue.body).toContain('new work')
    })

    it('is accepted while no child exists, and the new plan is the one reconciled', async () => {
      const github = fakeGitHub({ op: 'create', at: 0, mode: 'before' })
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      await split()
      expect(github.issues).toHaveLength(0)
      expect(await split(other)).toMatchObject({ reason: 'split-not-resolved' })
      const events = await store.read(ticketId)
      expect(types(events, 'SplitStarted')).toHaveLength(2)
      expect(splitProgressOf(events, waitId)!.plan.children.map((c) => c.key)).toEqual(['x', 'y'])
    })
  })
})
