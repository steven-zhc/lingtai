/**
 * `splitTicketHolding` (#601): writes in order, each read back, `TicketSplit` on
 * the log only once all of them landed (progress events lead up to it, #608),
 * and a retry that writes only what is missing.
 * A hand-written in-memory GitHub over `createMemoryEventStore()` (0060 §1).
 */
import { readFileSync } from 'node:fs'

import { reduceTicket, splitProgressOf, ticketStream } from '@lingtai/domain'
import { aClaim, aWait, aWaitId, aRun, aRunRef } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { Issue, LinkedIssue } from '@lingtai/github'
import { describe, expect, it } from 'vitest'

import { splitDoneWhen } from '../src/split-body.ts'
import { splitTicketHolding, type SplitClient, type SplitPlanInput } from '../src/split-ticket.ts'
import { BodyChanged } from '../src/ticket-store.ts'

const PROJECT = 'lingtai'
const REPO = 'steven-zhc/lingtai'
const PARENT = 601

type Mode = 'before' | 'after'

class FakeGitHub {
  issues = new Map<number, Issue & { id: number }>()
  subs = new Set<string>() // `${parent}>${child}`
  blocks = new Set<string>() // `${issue}<${blocker}`
  calls: string[] = []
  fail: { call: string; mode: Mode; times: number } | null = null
  next = 700

  constructor(parentBody: string) {
    this.issues.set(PARENT, this.make(PARENT, 'big ticket', parentBody))
  }

  private make(number: number, title: string, body: string): Issue & { id: number } {
    return {
      id: number * 1_000_003,
      number,
      title,
      body,
      labels: [],
      state: 'open',
      url: '',
      dependencies: null,
      assignees: [],
    }
  }

  private async hit<T>(call: string, effect: () => T): Promise<T> {
    this.calls.push(call)
    const f = this.fail
    const armed = f !== null && f.times > 0 && call.startsWith(f.call)
    if (armed && f.mode === 'before') {
      f.times--
      throw new Error(`${call} failed`)
    }
    const out = effect()
    if (armed && f.mode === 'after') {
      f.times--
      throw new Error(`${call} lost its response`)
    }
    return out
  }

  private linked(number: number): LinkedIssue {
    const i = this.issues.get(number)!
    return { ...i, repository: REPO }
  }

  client: SplitClient = {
    getIssue: async (n) => this.hit(`getIssue ${n}`, () => ({ ...this.issues.get(n)! })),
    listIssuesSince: async () => this.hit('listIssuesSince', () => [...this.issues.values()].map((i) => ({ ...i }))),
    createIssue: async (input) =>
      this.hit(`createIssue ${input.title}`, () => {
        const issue = this.make(this.next++, input.title, input.body)
        issue.labels = input.labels.map((name) => ({ name, color: null }))
        this.issues.set(issue.number, issue)
        return { ...issue }
      }),
    updateBody: async (n, body, opts) =>
      this.hit(`updateBody ${n}`, () => {
        const issue = this.issues.get(n)!
        if (opts?.ifUnchanged !== undefined && opts.ifUnchanged !== issue.body) throw new BodyChanged(n)
        issue.body = body
      }),
    addSubIssue: async (p, c) =>
      this.hit(`addSubIssue ${p} ${c}`, () => {
        if (this.subs.has(`${p}>${c}`)) throw new Error('422')
        this.subs.add(`${p}>${c}`)
      }),
    listSubIssues: async (p) =>
      this.hit(`listSubIssues ${p}`, () =>
        [...this.subs].filter((s) => s.startsWith(`${p}>`)).map((s) => this.linked(Number(s.split('>')[1]))),
      ),
    addBlockedBy: async (i, b) =>
      this.hit(`addBlockedBy ${i} ${b}`, () => {
        if (this.blocks.has(`${i}<${b}`)) throw new Error('422')
        this.blocks.add(`${i}<${b}`)
      }),
    listBlockedBy: async (i) =>
      this.hit(`listBlockedBy ${i}`, () =>
        [...this.blocks].filter((s) => s.startsWith(`${i}<`)).map((s) => this.linked(Number(s.split('<')[1]))),
      ),
  }
}

const PARENT_BODY = 'The problem.\r\n\r\n## Done when\r\n\r\n- [ ] it works\r\n\r\n## Related\r\n\r\n- #1\r\n'
const plan: SplitPlanInput = {
  children: [
    { key: 'a', title: 'part a', body: 'do a', kind: 'feature' },
    { key: 'b', title: 'part b', body: 'do b', kind: 'feature' },
    { key: 'c', title: 'part c', body: 'do c', kind: 'bug' },
  ],
  blockedBy: [
    { ticket: 'b', blockedBy: 'a' },
    { ticket: 'c', blockedBy: 'b' },
  ],
}

async function setup(body = PARENT_BODY) {
  const store = createMemoryEventStore()
  const ticketId = ticketStream(PROJECT, PARENT)
  const item = makeStream(ticketId)
  const run = aRun('pass-601')
  const waitId = aWaitId()
  await store.append(ticketId, 0, [
    ...aClaim(item, run.runId),
    ...aWait(item, { _tag: 'NothingProduced', run: aRunRef(run.runId), said: null }, waitId),
  ])
  const gh = new FakeGitHub(body)
  // `go()` submits the plan; `go(undefined)` is the board's Retry, which sends none.
  const go = (...args: [given?: SplitPlanInput, onStarted?: () => void]) =>
    splitTicketHolding(
      {
        project: PROJECT,
        issue: PARENT,
        waitId,
        plan: args.length === 0 ? plan : args[0],
        onStarted: args[1],
        kinds: ['bug', 'feature'],
        repository: REPO,
        by: 'human:steven',
        instance: 'board-1',
        github: gh.client,
        store,
      },
      store,
      ticketId,
    )
  const ME = { waitId, instance: 'board-1' }
  return { store, ticketId, waitId, gh, go, ME }
}

describe('splitTicketHolding', () => {
  it('writes a full plan one child at a time and appends TicketSplit, WaitResolved and the release once', async () => {
    const { store, ticketId, gh, go } = await setup()
    const before = (await store.read(ticketId)).length
    const real = store.append.bind(store)
    store.append = async (id, version, events) => {
      for (const e of events)
        if (e.type === 'SplitChildWritten') gh.calls.push(`record ${(e.data as { key: string }).key}`)
      return real(id, version, events)
    }
    const result = await go()
    expect(result.ok).toBe(true)
    expect(result.steps.every((s) => s.status === 'done')).toBe(true)
    expect(result.children).toEqual([
      { key: 'a', number: 700 },
      { key: 'b', number: 701 },
      { key: 'c', number: 702 },
    ])

    // Rule 6: create → attach → record for one child before the next child's create.
    const order = gh.calls.filter((c) => /^(createIssue|addSubIssue|record|addBlockedBy|updateBody)/.test(c))
    expect(order).toEqual([
      'createIssue part a',
      'addSubIssue 601 700',
      'record a',
      'createIssue part b',
      'addSubIssue 601 701',
      'record b',
      'createIssue part c',
      'addSubIssue 601 702',
      'record c',
      'addBlockedBy 701 700',
      'addBlockedBy 702 701',
      'addBlockedBy 601 700',
      'addBlockedBy 601 701',
      'addBlockedBy 601 702',
      'updateBody 601',
    ])

    const added = (await store.read(ticketId)).slice(before)
    expect(added.map((e) => e.type)).toEqual([
      'SplitStarted',
      'SplitChildWritten',
      'SplitChildWritten',
      'SplitChildWritten',
      'SplitLinkWritten',
      'SplitLinkWritten',
      'TicketSplit',
      'WaitResolved',
      'TicketReleased',
    ])
    expect(added[0]!.data).toMatchObject({
      instance: 'board-1',
      plan: { children: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] },
    })
    expect(added[1]!.data).toMatchObject({ key: 'a', number: 700, id: 700 * 1_000_003 })
    expect(added[4]!.data).toMatchObject({ ticket: 'b', blockedBy: 'a' })
    expect(added[6]!.data).toMatchObject({
      children: [
        { key: 'a', number: 700, id: 700 * 1_000_003 },
        { key: 'b', number: 701, id: 701 * 1_000_003 },
        { key: 'c', number: 702, id: 702 * 1_000_003 },
      ],
    })
    expect(reduceTicket(await store.read(ticketId)).lifecycle.status).toBe('backlog')
    expect(gh.issues.get(700)!.labels.map((l) => l.name)).toEqual(['feature'])
  })

  it('keeps the parent body above Done when byte for byte, and what follows it', async () => {
    const { gh, go } = await setup()
    await go()
    const body = gh.issues.get(PARENT)!.body
    expect(body.startsWith('The problem.\r\n\r\n')).toBe(true)
    expect(body).toContain('- [ ] #700 is closed')
    expect(body).not.toContain('it works')
    expect(body.endsWith('## Related\r\n\r\n- #1\r\n')).toBe(true)
  })

  it('has appended SplitStarted and fired onStarted before its first GitHub call', async () => {
    const { store, ticketId, gh, go } = await setup()
    let fired = false
    const list = gh.client.listIssuesSince
    let seen: { fired: boolean; started: boolean } | null = null
    gh.client.listIssuesSince = async (since) => {
      seen ??= { fired, started: (await store.read(ticketId)).some((e) => e.type === 'SplitStarted') }
      return list(since)
    }
    await go(plan, () => (fired = true))
    expect(seen).toEqual({ fired: true, started: true })
  })

  for (const mode of ['before', 'after'] as const) {
    for (const call of [
      'createIssue',
      'addSubIssue',
      'addBlockedBy 70',
      'addBlockedBy 601',
      'updateBody',
      'listSubIssues',
      'getIssue',
    ]) {
      it(`a failure ${mode} ${call} leaves no TicketSplit, and a retry converges on the whole plan`, async () => {
        const { store, ticketId, gh, go } = await setup()
        const before = (await store.read(ticketId)).length
        gh.fail = { call, mode, times: 1 }
        const first = await go()
        if (!first.ok)
          expect((await store.read(ticketId)).slice(before).some((e) => e.type === 'TicketSplit')).toBe(false)
        gh.fail = null
        // A lost response is read back as landed, so the first call may have finished.
        if (!first.ok) expect((await go(undefined)).ok).toBe(true)
        expect(
          [...gh.issues.values()]
            .filter((i) => i.number !== PARENT)
            .map((i) => i.title)
            .sort(),
        ).toEqual(['part a', 'part b', 'part c'])
        expect(gh.subs.size).toBe(3)
        expect(gh.blocks.size).toBe(5)
        const types = (await store.read(ticketId))
          .slice(before)
          .map((e) => e.type)
          .filter((t) => !t.startsWith('Split'))
        expect(types).toEqual(['TicketSplit', 'WaitResolved', 'TicketReleased'])
      })
    }
  }

  it('a create whose response is lost is found by its marker on retry and not created twice', async () => {
    const { gh, go } = await setup()
    // The create lands, its response is lost, and so is the look-by-marker that follows it.
    gh.fail = { call: 'createIssue part b', mode: 'after', times: 1 }
    const list = gh.client.listIssuesSince
    let listings = 0
    gh.client.listIssuesSince = async (since) => {
      if (++listings === 2) throw new Error('listing lost')
      return list(since)
    }
    const first = await go()
    expect(first.ok).toBe(false)
    expect(gh.calls.filter((c) => c.startsWith('createIssue part b'))).toHaveLength(1)
    expect((await go(undefined)).ok).toBe(true)
    expect(gh.calls.filter((c) => c.startsWith('createIssue part b'))).toHaveLength(1)
    expect([...gh.issues.values()].filter((i) => i.title === 'part b')).toHaveLength(1)
  })

  it('fails and records nothing but SplitFailed when the listing fails — an empty answer is never not-created', async () => {
    const { store, ticketId, gh, go } = await setup()
    const before = (await store.read(ticketId)).length
    gh.fail = { call: 'listIssuesSince', mode: 'before', times: 1 }
    const result = await go()
    expect(result.ok).toBe(false)
    expect(gh.calls.some((c) => c.startsWith('createIssue'))).toBe(false)
    expect((await store.read(ticketId)).slice(before).map((e) => e.type)).toEqual(['SplitStarted', 'SplitFailed'])
  })

  it('never adopts, edits, attaches or links an unrelated sub-issue that shares a planned title', async () => {
    const { gh, go } = await setup()
    const stranger = await gh.client.createIssue({ title: 'part a', body: 'not ours', labels: ['feature'] })
    await gh.client.addSubIssue(PARENT, stranger.number)
    gh.calls.length = 0
    const result = await go()
    expect(result.ok).toBe(true)
    expect(gh.calls.some((c) => c.startsWith('createIssue part a'))).toBe(true)
    const touched = gh.calls.filter((c) => /^(updateBody|addSubIssue|addBlockedBy)/.test(c))
    expect(touched.some((c) => c.split(' ').slice(1).includes(String(stranger.number)))).toBe(false)
    expect(gh.issues.get(stranger.number)!.body).toBe('not ours')
    expect(result.children.find((c) => c.key === 'a')!.number).not.toBe(stranger.number)
  })

  it('ignores a later submission that differs from the frozen plan', async () => {
    const { store, ticketId, gh, go } = await setup()
    gh.fail = { call: 'addBlockedBy 702 701', mode: 'before', times: 1 }
    expect((await go()).ok).toBe(false)
    gh.fail = null
    const other: SplitPlanInput = {
      children: [{ key: 'z', title: 'something else', body: 'z', kind: 'bug' }],
      blockedBy: [],
    }
    expect((await go(other)).ok).toBe(true)
    expect([...gh.issues.values()].some((i) => i.title === 'something else')).toBe(false)
    const starts = (await store.read(ticketId)).filter((e) => e.type === 'SplitStarted')
    expect(starts).toHaveLength(2)
    for (const e of starts)
      expect((e.data as { plan: unknown }).plan).toEqual((starts[0]!.data as { plan: unknown }).plan)
    expect(gh.subs.size).toBe(3)
  })

  it('records in TicketSplit the links GitHub returned, after a retry too', async () => {
    const { store, ticketId, gh, go } = await setup()
    gh.fail = { call: 'addBlockedBy 702 701', mode: 'before', times: 1 }
    await go()
    gh.fail = null
    // A person linked a to c meanwhile: GitHub's answer is the record, not the plan.
    gh.blocks.add('702<700')
    expect((await go(undefined)).ok).toBe(true)
    const split = (await store.read(ticketId)).find((e) => e.type === 'TicketSplit')!.data as {
      blockedBy: { ticket: string; blockedBy: string }[]
    }
    expect(split.blockedBy).toEqual(
      expect.arrayContaining([
        { ticket: 'b', blockedBy: 'a' },
        { ticket: 'c', blockedBy: 'b' },
        { ticket: 'c', blockedBy: 'a' },
      ]),
    )
    expect(split.blockedBy).toHaveLength(3)
  })

  it('a second call after success writes nothing and is refused as not waiting', async () => {
    const { gh, go } = await setup()
    await go()
    const writes = gh.calls.length
    const again = await go()
    expect(again.ok).toBe(false)
    expect(gh.calls.length).toBe(writes)
  })

  it('a failure on chain appends SplitFailed, and the retry appends a fresh SplitStarted and only the missing link', async () => {
    const { store, ticketId, waitId, gh, go, ME } = await setup()
    gh.fail = { call: 'addBlockedBy 702 701', mode: 'before', times: 1 }
    const first = await go()
    expect(first.ok).toBe(false)
    const afterFirst = await store.read(ticketId)
    const failed = afterFirst.at(-1)!
    expect(failed.type).toBe('SplitFailed')
    expect(failed.data).toMatchObject({ waitId, step: 'chain c←b' })
    expect(splitProgressOf(afterFirst, { ...ME, running: false }).state).toBe('failed')

    gh.fail = null
    expect((await go(undefined)).ok).toBe(true)
    const retried = (await store.read(ticketId)).slice(afterFirst.length)
    expect(retried.map((e) => e.type)).toEqual([
      'SplitStarted',
      'SplitLinkWritten',
      'TicketSplit',
      'WaitResolved',
      'TicketReleased',
    ])
    expect(splitProgressOf(await store.read(ticketId), { ...ME, running: false }).state).toBe('done')
  })

  it('leaves the page interrupted, not writing, when the final SplitFailed append throws', async () => {
    const { store, ticketId, gh, go, ME } = await setup()
    const real = store.append.bind(store)
    store.append = async (id, version, events) => {
      if (events.some((e) => e.type === 'SplitFailed')) throw new Error('store is down')
      return real(id, version, events)
    }
    gh.fail = { call: 'addBlockedBy 702 701', mode: 'before', times: 1 }
    const result = await go().catch(() => null)
    expect(result === null || !result.ok).toBe(true)
    const events = await store.read(ticketId)
    expect(events.some((e) => e.type === 'SplitFailed')).toBe(false)
    // The writer has ended, so the process's running set no longer has it.
    expect(splitProgressOf(events, { ...ME, running: false }).state).toBe('interrupted')
  })

  it('a refusal before writing appends nothing', async () => {
    const { store, ticketId, gh } = await setup()
    const dup = await splitTicketHolding(
      {
        project: PROJECT,
        issue: PARENT,
        waitId: aWaitId(),
        plan,
        kinds: ['bug', 'feature'],
        repository: REPO,
        by: 'human:h',
        instance: 'board-1',
        github: gh.client,
        store,
      },
      store,
      ticketId,
    )
    expect(dup.ok).toBe(false)
    expect((await store.read(ticketId)).some((e) => e.type.startsWith('Split'))).toBe(false)
  })

  it('marks record the split done only once the append lands', async () => {
    const { store, ticketId, go } = await setup()
    const real = store.append.bind(store)
    store.append = async (id, version, events) => {
      if (events.some((e) => e.type === 'TicketSplit')) throw new Error('append refused')
      return real(id, version, events)
    }
    const failed = await go()
    expect(failed.ok).toBe(false)
    expect(failed.steps.find((s) => s.name === 'record the split')!.status).toBe('failed')
    expect(failed.steps.find((s) => s.name === 'end the wait')!.status).toBe('failed')
    expect((await store.read(ticketId)).some((e) => e.type === 'TicketSplit')).toBe(false)
    store.append = real
    const ok = await go(undefined)
    expect(ok.steps.find((s) => s.name === 'record the split')!.status).toBe('done')
  })

  it('knows a child by its marker and never by its title', () => {
    const source = readFileSync(new URL('../src/split-ticket.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\.title\s*[!=]==?/)
    expect(source).not.toMatch(/titles?\b.*\bindexOf/)
  })
})

describe('splitDoneWhen', () => {
  it('keeps text above the heading and the sections after it, and is idempotent', () => {
    const body = 'intro\n\n## Done when\n\n- [ ] x\n\n## Related\n\n- #2\n'
    const once = splitDoneWhen(body, [5, 6])
    expect(once.startsWith('intro\n\n## Done when\n\n- [ ] #5 is closed\n- [ ] #6 is closed')).toBe(true)
    expect(once.endsWith('## Related\n\n- #2\n')).toBe(true)
    expect(splitDoneWhen(once, [5, 6])).toBe(once)
  })

  it('appends the section when there is no heading', () => {
    const once = splitDoneWhen('just text', [5])
    expect(once.startsWith('just text\n\n## Done when')).toBe(true)
    expect(splitDoneWhen(once, [5])).toBe(once)
  })
})
