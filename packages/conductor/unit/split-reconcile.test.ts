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
    expect(github.issues[0]!.body).toContain(splitMarker(waitId, PLAN, 'a'))
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
          expect(github.issues.filter((i) => i.body.includes(splitMarker(waitId, PLAN, c.key)))).toHaveLength(1)
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
    expect(progress.failure).toContain('reading sub-issues')
    expect(progress.owed.complete).toBe(false)
    expect(progress.identities).toHaveLength(3)
    expect(progress.owed.subIssues).toEqual(['a', 'b', 'c'])
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

  describe('a child is the identity the log recorded (#561)', () => {
    const strip = (github: ReturnType<typeof fakeGitHub>, waitId: never, key: string) => {
      const issue = github.issues.find((i) => i.body.includes(splitMarker(waitId, PLAN, key)))!
      issue.body = issue.body.replace(splitMarker(waitId, PLAN, key), '')
      return issue
    }

    it('creates no second child for a recorded one whose marker a person removed', async () => {
      const github = fakeGitHub({ op: 'edge', at: 1, mode: 'before' })
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      const a = strip(github, waitId as never, 'a')
      const created = github.calls.create
      const gets: number[] = []
      const get = github.port.getIssue
      github.port.getIssue = async (n) => {
        gets.push(n)
        return get(n)
      }
      for (let i = 0; i < 3; i++) if (JSON.stringify(await split()).includes('split-not-resolved')) break
      expect(github.calls.create).toBe(created)
      expect(github.issues).toHaveLength(PLAN.children.length)
      // a was verified by number against its recorded id.
      expect(gets).toContain(a.number)
      const progress = splitProgressOf(await store.read(ticketId), waitId)!
      expect(progress.identities.map((i) => i.number)).toEqual([a.number, 601, 602])
      expect(progress.owed.complete).toBe(true)
    })

    it('records a create that threw but landed, so a removed marker makes no second child', async () => {
      const github = fakeGitHub({ op: 'create', at: 0, mode: 'after' })
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      const progress = splitProgressOf(await store.read(ticketId), waitId)!
      expect(progress.identities).toMatchObject([{ key: 'a', number: 600, via: 'adopted' }])
      strip(github, waitId as never, 'a')
      for (let i = 0; i < 4; i++) await split()
      expect(github.issues).toHaveLength(3)
    })

    it('never re-creates a recorded child that has gone: it is owed and named', async () => {
      const github = fakeGitHub()
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      await split()
      github.issues.splice(0, 1)
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      expect(github.calls.create).toBe(3)
      const progress = splitProgressOf(await store.read(ticketId), waitId)!
      expect(progress.owed.unverified).toMatchObject([{ key: 'a', number: 600 }])
      expect(progress.failure).toContain('#600')
    })

    it('is not the recorded child when the number now names an issue with another id', async () => {
      const github = fakeGitHub()
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      await split()
      github.issues[0]!.id = 9 as never
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      expect(github.calls.create).toBe(3)
      expect(splitProgressOf(await store.read(ticketId), waitId)!.owed.complete).toBe(false)
    })
  })

  describe('a duplicate is a stray: named, blocking, and never closed by Lingtai', () => {
    it("keeps the split incomplete while an open issue carries a recorded key's marker, and completes once a person closes it", async () => {
      const github = fakeGitHub()
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      await split()
      const [a] = github.issues
      github.issues.push({ ...a!, number: 700, id: 700_007 as Issue['id'], createdAt: 700 })
      const result = await split()
      expect(result).toMatchObject({ ok: false, reason: 'split-partial' })
      expect(result.ok === false && result.detail).toContain('close #700, a duplicate of a')
      const progress = splitProgressOf(await store.read(ticketId), waitId)!
      expect(progress.strays).toEqual([{ key: 'a', number: 700 }])
      expect(progress.owed.complete).toBe(false)
      // Nothing was closed or linked on the stray's account.
      expect(github.issues.find((i) => i.number === 700)!.state).toBe('open')
      expect(github.subs.get(PARENT)?.has(700)).toBe(false)

      github.issues.find((i) => i.number === 700)!.state = 'closed'
      expect(await split()).toMatchObject({ reason: 'split-not-resolved' })
    })

    it('a stray seen only by the read-back is still recorded', async () => {
      const github = fakeGitHub()
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      await split()
      const listed = github.port.listIssuesSince
      let lists = 0
      github.port.listIssuesSince = async (since) => {
        const all = await listed(since)
        if (++lists < 2) return all
        return [...all, { ...all[0]!, number: 700, id: 700_007 as Issue['id'] }]
      }
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      expect(splitProgressOf(await store.read(ticketId), waitId)!.strays).toEqual([{ key: 'a', number: 700 }])
    })
  })

  describe('the plan is fixed once anything exists', () => {
    it('accepts a corrected plan after a failed first read that wrote nothing', async () => {
      const github = fakeGitHub()
      const real = github.port.listIssuesSince
      let lists = 0
      github.port.listIssuesSince = async (since) => {
        if (++lists === 1) throw new Error('listing timed out')
        return real(since)
      }
      const { store, ticketId, split } = await blockedOnFirstWait(github)
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      expect(github.calls).toEqual({ create: 0, sub: 0, edge: 0 })
      const other = { ...PLAN, children: [{ ...child('a'), title: 'revised' }, child('b'), child('c')] }
      expect(await split(other)).toMatchObject({ reason: 'split-not-resolved' })
      expect(types(await store.read(ticketId), 'SplitStarted')).toHaveLength(2)
      expect(github.issues.map((i) => i.title)).toEqual(['revised', 'child b', 'child c'])
    })

    it('refuses a different plan while a create that timed out may still land, though the closing listing was clean', async () => {
      const github = fakeGitHub()
      const create = github.port.createIssue
      let late: (() => void) | null = null
      // The create times out and lands only after the closing listing has run.
      github.port.createIssue = async (input) => {
        late = () => void create(input)
        throw new Error('create timed out')
      }
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      expect(github.issues).toHaveLength(0)
      expect(splitProgressOf(await store.read(ticketId), waitId)).toMatchObject({ listed: true, createUnknown: true })
      late!()
      await Promise.resolve()
      const other = { ...PLAN, children: [{ ...child('a'), title: 'revised' }, child('b'), child('c')] }
      expect(await split(other)).toMatchObject({ ok: false, reason: 'split-in-progress' })
      expect(types(await store.read(ticketId), 'SplitStarted')).toHaveLength(1)
    })

    it('refuses a different plan once an attempt failed, even with no child recorded', async () => {
      const github = fakeGitHub({ op: 'create', at: 0, mode: 'after' })
      const real = github.port.listIssuesSince
      let lists = 0
      // The create lands, then the read-back listing throws too: no identity is recorded.
      github.port.listIssuesSince = async (since) => {
        if (++lists === 2) throw new Error('listing timed out')
        return real(since)
      }
      const { store, ticketId, waitId, split } = await blockedOnFirstWait(github)
      expect(await split()).toMatchObject({ reason: 'split-partial' })
      expect(splitProgressOf(await store.read(ticketId), waitId)!.identities).toEqual([])
      const other = { ...PLAN, children: [{ ...child('a'), title: 'revised' }, child('b'), child('c')] }
      expect(await split(other)).toMatchObject({ ok: false, reason: 'split-in-progress' })
      expect(types(await store.read(ticketId), 'SplitStarted')).toHaveLength(1)
      // Retrying the original plan adopts the child that landed.
      for (let i = 0; i < 3; i++) await split()
      expect(github.issues).toHaveLength(3)
    })
  })
})
