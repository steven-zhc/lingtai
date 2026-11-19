/**
 * `splitTicketHolding` (#601): writes in order, each read back, `TicketSplit` on
 * the log only once all of them landed (progress events lead up to it, #608),
 * and a retry that writes only what is missing.
 * A hand-written in-memory GitHub over `createMemoryEventStore()` (0060 §1).
 */
import { readFileSync } from 'node:fs'

import { frozenPlan, reduceTicket, splitProgressOf, ticketStream } from '@lingtai/domain'
import { aClaim, aWait, aWaitId, anAttempt, anAttemptRef } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { Issue, LinkedIssue } from '@lingtai/github'
import { describe, expect, it } from 'vitest'

import { splitIntoSection, splitTicketHolding, type SplitClient, type SplitPlanInput } from '../src/split-ticket.ts'
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
  /** Labels the repository has; null means every label exists. A create naming another is refused. */
  labels = new Set<string>(['bug', 'feature'])
  strictLabels = false
  /** Every `createIssue` input the writer sent. */
  created: Parameters<SplitClient['createIssue']>[0][] = []

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
      milestone: null,
      parent: null,
      subIssues: null,
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
        this.created.push(input)
        if (this.strictLabels)
          for (const l of input.labels) if (!this.labels.has(l)) throw new Error('Validation Failed')
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
    addLabels: async (n, names) =>
      this.hit(`addLabels ${n} ${names.join(',')}`, () => {
        const issue = this.issues.get(n)!
        for (const name of names)
          if (!issue.labels.some((l) => l.name === name)) issue.labels.push({ name, color: null })
      }),
    removeLabel: async (n, name) =>
      this.hit(`removeLabel ${n} ${name}`, () => {
        const issue = this.issues.get(n)!
        issue.labels = issue.labels.filter((l) => l.name !== name)
      }),
    createLabel: async (name) => this.hit(`createLabel ${name}`, () => void this.labels.add(name)),
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

/** What the daemon's triage records (0118 §12): the plan frozen in `SplitStarted`, once per wait. */
async function decide(
  store: ReturnType<typeof createMemoryEventStore>,
  ticketId: string,
  waitId: string,
  given: SplitPlanInput,
  instance = 'board-1',
) {
  const events = await store.read(ticketId)
  if (events.some((e) => e.type === 'SplitStarted' && (e.data as { waitId?: string }).waitId === waitId)) return
  await store.append(ticketId, events.length, [
    {
      type: 'SplitStarted',
      actor: 'conductor',
      data: { waitId, plan: frozenPlan(given), instance },
    } as never,
  ])
}

async function setup(body = PARENT_BODY) {
  const store = createMemoryEventStore()
  const ticketId = ticketStream(PROJECT, PARENT)
  const item = makeStream(ticketId)
  const run = anAttempt('pass-601')
  const waitId = aWaitId()
  await store.append(ticketId, 0, [
    ...aClaim(item, run.runId),
    ...aWait(item, { _tag: 'NothingProduced', run: anAttemptRef(run.runId), said: null }, waitId),
  ])
  const gh = new FakeGitHub(body)
  // `go()` is the decision followed by the writer; `go(undefined)` is a retry, which decides nothing again.
  const go = async (...args: [given?: SplitPlanInput]) => {
    const given = args.length === 0 ? plan : args[0]
    if (given !== undefined) await decide(store, ticketId, waitId, given)
    return splitTicketHolding(
      {
        project: PROJECT,
        issue: PARENT,
        waitId,
        kinds: ['bug', 'feature'],
        repository: REPO,
        by: 'conductor',
        instance: 'board-1',
        github: gh.client,
        store,
      },
      store,
      ticketId,
    )
  }
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

  it('leaves the parent Done when untouched and lists every child under Split into', async () => {
    const { gh, go } = await setup()
    await go()
    const body = gh.issues.get(PARENT)!.body
    expect(body.startsWith(PARENT_BODY.trimEnd())).toBe(true)
    expect(body).toContain('## Done when\r\n\r\n- [ ] it works\r\n\r\n## Related\r\n\r\n- #1')
    expect(body).toContain('## Split into')
    for (const n of [700, 701, 702]) expect(body).toContain(`- #${n} — part `)
  })

  it('creates every child with the publishing label and lifts it only after every read-back', async () => {
    const { gh, go } = await setup()
    await go()
    const creates = gh.calls.filter((c) => c.startsWith('createIssue'))
    expect(creates).toHaveLength(3)
    const removes = gh.calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith('removeLabel'))
    expect(removes.map(([c]) => c)).toEqual([
      'removeLabel 700 lingtai:publishing',
      'removeLabel 701 lingtai:publishing',
      'removeLabel 702 lingtai:publishing',
    ])
    const lastRead = Math.max(
      gh.calls.lastIndexOf('listBlockedBy 601'),
      gh.calls.lastIndexOf('listBlockedBy 702'),
      gh.calls.lastIndexOf('listSubIssues 601'),
    )
    expect(Math.min(...removes.map(([, i]) => i))).toBeGreaterThan(lastRead)
    expect(gh.calls.some((c) => c.startsWith('setLabels'))).toBe(false)
  })

  it('a split interrupted after its second child leaves both labelled, and a second run lifts them and appends one TicketSplit', async () => {
    const { store, ticketId, gh, go } = await setup()
    gh.fail = { call: 'createIssue part c', mode: 'before', times: 2 }
    expect((await go()).ok).toBe(false)
    expect(gh.issues.get(700)!.labels.map((l) => l.name)).toContain('lingtai:publishing')
    expect(gh.issues.get(701)!.labels.map((l) => l.name)).toContain('lingtai:publishing')
    gh.fail = null
    expect((await go(undefined)).ok).toBe(true)
    for (const n of [700, 701, 702])
      expect(gh.issues.get(n)!.labels.map((l) => l.name)).not.toContain('lingtai:publishing')
    expect((await store.read(ticketId)).filter((e) => e.type === 'TicketSplit')).toHaveLength(1)
  })

  it("keeps a person's agent:hold on a child", async () => {
    const { gh, go } = await setup()
    const getIssue = gh.client.getIssue
    // A person holds the child while the split is still being read back.
    gh.client.addBlockedBy = ((add) => async (i: number, b: number) => {
      if (i === PARENT && b === 700) gh.issues.get(700)!.labels.push({ name: 'agent:hold', color: null })
      return add(i, b)
    })(gh.client.addBlockedBy)
    void getIssue
    await go()
    expect(
      gh.issues
        .get(700)!
        .labels.map((l) => l.name)
        .sort(),
    ).toEqual(['agent:hold', 'feature'])
  })

  it('a crash after the removals appends TicketSplit without putting the label back', async () => {
    const { store, ticketId, gh, go } = await setup()
    gh.fail = { call: 'removeLabel 702', mode: 'before', times: 1 }
    expect((await go()).ok).toBe(false)
    gh.fail = null
    const adds = gh.calls.filter((c) => c.startsWith('addLabels')).length
    expect((await go(undefined)).ok).toBe(true)
    expect(gh.calls.filter((c) => c.startsWith('addLabels')).length).toBe(adds)
    expect((await store.read(ticketId)).filter((e) => e.type === 'TicketSplit')).toHaveLength(1)
  })

  it('adds the label to a new child whose create dropped it', async () => {
    const { gh, go } = await setup()
    const create = gh.client.createIssue
    gh.client.createIssue = async (input) =>
      create({ ...input, labels: input.labels.filter((l) => l !== 'lingtai:publishing') })
    expect((await go()).ok).toBe(true)
    expect(gh.calls.filter((c) => c.startsWith('addLabels'))).toHaveLength(3)
  })

  it("opens every child in the parent's milestone and assigned to the parent's assignees (#1272)", async () => {
    const { gh, go } = await setup()
    Object.assign(gh.issues.get(PARENT)!, {
      milestone: 3,
      assignees: ['a', 'b'],
      labels: [{ name: 'agent:hold', color: null }],
    })
    expect((await go()).ok).toBe(true)
    expect(gh.created).toHaveLength(3)
    for (const input of gh.created) {
      expect(input.milestone).toBe(3)
      expect(input.assignees).toEqual(['a', 'b'])
      expect(input.labels).not.toContain('agent:hold')
    }
  })

  it('sends neither key for a parent with no milestone and no assignee', async () => {
    const { gh, go } = await setup()
    expect((await go()).ok).toBe(true)
    for (const input of gh.created) {
      expect('milestone' in input).toBe(false)
      expect('assignees' in input).toBe(false)
    }
  })

  it('a resumed write reads the parent again, so a child created on a retry is placed too', async () => {
    const { gh, go } = await setup()
    Object.assign(gh.issues.get(PARENT)!, { milestone: 3, assignees: ['a'] })
    gh.fail = { call: 'createIssue part c', mode: 'before', times: 2 }
    expect((await go()).ok).toBe(false)
    gh.fail = null
    gh.created.length = 0
    expect((await go(undefined)).ok).toBe(true)
    expect(gh.created).toHaveLength(1)
    expect(gh.created[0]).toMatchObject({ milestone: 3, assignees: ['a'] })
  })

  it('a resumed write whose parent read fails opens no child and a later write converges', async () => {
    const { gh, go } = await setup()
    gh.fail = { call: 'createIssue part c', mode: 'before', times: 2 }
    expect((await go()).ok).toBe(false)
    gh.fail = { call: `getIssue ${PARENT}`, mode: 'before', times: 1 }
    gh.created.length = 0
    expect((await go(undefined)).ok).toBe(false)
    expect(gh.created).toHaveLength(0)
    gh.fail = null
    expect((await go(undefined)).ok).toBe(true)
    expect(gh.created).toHaveLength(1)
  })

  it('creates the repository label once when GitHub refuses a create naming it', async () => {
    const { gh, go } = await setup()
    gh.strictLabels = true
    expect((await go()).ok).toBe(true)
    expect(gh.calls.filter((c) => c.startsWith('createLabel'))).toEqual(['createLabel lingtai:publishing'])
  })

  it('relabels recorded but unlinked children from an earlier writer before creating the rest', async () => {
    const { gh, go } = await setup()
    gh.fail = { call: 'addBlockedBy 701', mode: 'before', times: 1 }
    expect((await go()).ok).toBe(false)
    // An earlier writer left two children unlabelled and unlinked.
    gh.blocks.clear()
    for (const n of [700, 701]) gh.issues.get(n)!.labels = [{ name: 'feature', color: null }]
    gh.fail = null
    gh.calls.length = 0
    expect((await go(undefined)).ok).toBe(true)
    const firstCreate = gh.calls.findIndex((c) => c.startsWith('createIssue'))
    const relabels = gh.calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith('addLabels 70'))
    expect(relabels.length).toBeGreaterThanOrEqual(2)
    expect(relabels[0]![1]).toBeLessThan(gh.calls.findIndex((c) => c.startsWith('addBlockedBy')))
    void firstCreate
  })

  it('does not publish when a parent blocker vanishes while Split into is written', async () => {
    const { store, ticketId, gh, go } = await setup()
    const update = gh.client.updateBody
    gh.client.updateBody = async (n, body, opts) => {
      await update(n, body, opts)
      gh.blocks.delete('601<700')
    }
    const result = await go()
    expect(result.ok).toBe(false)
    expect(gh.calls.some((c) => c.startsWith('removeLabel'))).toBe(false)
    expect((await store.read(ticketId)).some((e) => e.type === 'TicketSplit')).toBe(false)
  })

  it('refuses a second split of a ticket that already has a SplitStarted for another wait', async () => {
    const { store, ticketId, gh, go } = await setup()
    expect((await go()).ok).toBe(true)
    // Wait again on the same ticket, as a later split would.
    const item = makeStream(ticketId)
    const run = anAttempt('pass-602')
    const waitId2 = aWaitId()
    await store.append(ticketId, (await store.read(ticketId)).length, [
      ...aClaim(item, run.runId),
      ...aWait(item, { _tag: 'NothingProduced', run: anAttemptRef(run.runId), said: null }, waitId2),
    ])
    await decide(store, ticketId, waitId2, plan)
    const calls = gh.calls.length
    const before = (await store.read(ticketId)).length
    const again = await splitTicketHolding(
      {
        project: PROJECT,
        issue: PARENT,
        waitId: waitId2,
        kinds: ['bug', 'feature'],
        repository: REPO,
        by: 'conductor',
        instance: 'board-1',
        github: gh.client,
        store,
      },
      store,
      ticketId,
    )
    expect(again.ok).toBe(false)
    expect(again.detail).toContain('already split once')
    expect(gh.calls.length).toBe(calls)
    expect((await store.read(ticketId)).length).toBe(before)
  })

  it('is not refused by its own Split into section on a retry', async () => {
    const { gh, go } = await setup()
    gh.fail = { call: 'removeLabel 700', mode: 'before', times: 1 }
    expect((await go()).ok).toBe(false)
    gh.fail = null
    expect(gh.issues.get(PARENT)!.body).toContain('## Split into')
    expect((await go(undefined)).ok).toBe(true)
  })

  it('has the decision on the log before its first GitHub call', async () => {
    const { store, ticketId, gh, go } = await setup()
    const list = gh.client.listIssuesSince
    let seen: { started: boolean } | null = null
    gh.client.listIssuesSince = async (since) => {
      seen ??= { started: (await store.read(ticketId)).some((e) => e.type === 'SplitStarted') }
      return list(since)
    }
    await go(plan)
    expect(seen).toEqual({ started: true })
  })

  for (const mode of ['before', 'after'] as const) {
    for (const call of [
      'createIssue',
      'addSubIssue',
      'addBlockedBy 70',
      'addBlockedBy 601',
      'updateBody',
      'listSubIssues',
      'getIssue 70',
      'removeLabel',
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

  it('answers a second child whose createIssue yields a malformed answer (a defect) as that step failing, and resolves rather than rejecting', async () => {
    const { store, ticketId, gh, go } = await setup()
    const create = gh.client.createIssue
    gh.client.createIssue = ((input: Parameters<typeof create>[0]) => {
      // A malformed answer: reading `.number` off it throws inside the step, a defect and not a rejection.
      if (input.title === 'part b') return Promise.resolve(undefined)
      return create(input)
    }) as typeof create
    const result = await go()
    expect(result.ok).toBe(false)
    expect(result.detail).toEqual(
      expect.stringMatching(
        /^write b failed: .*number.*\. Nothing was finished — call again to write what is missing\.$/,
      ),
    )
    expect(result.steps.find((s) => s.name === 'write b')).toMatchObject({ status: 'failed' })
    expect(result.children).toEqual([{ key: 'a', number: expect.any(Number) }])
    const failed = (await store.read(ticketId)).filter((e) => e.type === 'SplitFailed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.data).toMatchObject({ step: 'write b' })
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
        kinds: ['bug', 'feature'],
        repository: REPO,
        by: 'conductor',
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

describe('splitIntoSection', () => {
  const children = [
    { number: 5, title: 'a', covers: ['x', 'y'] },
    { number: 6, title: 'b' },
  ]
  it('writes its own section, leaves Done when alone, lists covers and what no child covers, and is idempotent', () => {
    const body = 'intro\n\n## Done when\n\n- [ ] x\n\n## Related\n\n- #2\n'
    const once = splitIntoSection(body, children, ['z'])
    expect(once.startsWith(body.trimEnd())).toBe(true)
    expect(once).toContain('- #5 — a\n  - x\n  - y\n- #6 — b\n')
    expect(once).toContain('Not covered by any child:\n\n- z')
    expect(splitIntoSection(once, children, ['z'])).toBe(once)
  })

  it('defuses a marker quoted in an item', () => {
    expect(() =>
      splitIntoSection('t', [{ number: 1, title: 'a', covers: ['<!-- lingtai:answer k -->'] }]),
    ).not.toThrow()
  })
})
