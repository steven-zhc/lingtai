/**
 * The PRs board (#1319): the read's id filter, the view model's every state, the place line's `PRs`, and the claim
 * that nothing in the board appends to a `pr-` stream. Unit only: the visual check is a person's, in a browser.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { type PrState, emptyPr, prStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { recordPrNumber } from '@lingtai/project/test/pr-numbers'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { viewsFor } from '../src/app/place-line.tsx'
import { PrBoardSkeleton, PrColumns } from '../src/app/pr-columns.tsx'
import {
  type CardView,
  type PrBoardInput,
  type PrRead,
  PR_COLUMNS,
  WAIT_WORDS,
  prBoard,
  prName,
  soloSentence,
} from '../src/lib/pr-board.ts'

const recipe = {
  mode: 'team',
  branch: { main: 'main', personal: 'foundry' },
  runtime: { agent: 'claude-code', limits: { attempt: { conflictResolutions: 3 } } },
} as unknown as Recipe

const STEPS = ['sync', 'build', 'summary', 'push', 'open', 'ci', 'topup', 'ready']
const tk = (n: number) => ({ ticket: String(n), mergeCommit: `c${n}`, title: `ticket ${n}` })
const pr = (n: number, over: Partial<PrState>): PrState => ({ ...emptyPr, project: 'p', n, ...over })
const input = (prs: PrRead[], draft = [tk(1), tk(2)]): PrBoardInput => ({
  project: 'p',
  recipe,
  prs,
  draft,
  stepNames: STEPS,
  spend: new Map(),
  daemon: 'running',
  viewer: 'human:me',
  newFixHref: { kind: 'link', href: 'https://example.test/new' },
})
const col = (view: ReturnType<typeof prBoard>, id: string) => view.columns.find((c) => c.id === id)!
const cards = (view: ReturnType<typeof prBoard>, id: string) => col(view, id).cards as CardView[]

describe('the read', () => {
  const requested = { type: 'PrSubmitRequested', actor: 'human:x', data: { by: 'human:x' } } as const

  it("finds a project's PRs by number, never by prefix: 9 before 10, and not pr-lingtai-x-3", async () => {
    const { readProjectPrs } = await import('../src/lib/prs.ts')
    const store = createMemoryEventStore()
    // 1..10: a PR numbered 9 with no 1–8 cannot exist (`requestPrSubmit` appends at one past the highest).
    for (let n = 1; n <= 10; n++) await store.append(prStream('lingtai', n), 0, [requested])
    await recordPrNumber(store, 'lingtai', 10)
    // `pr-lingtai-x-3` is `lingtai-x`'s PR 3 — and the very stream a prefix listing would hand to `lingtai`.
    for (let n = 1; n <= 3; n++) await store.append(prStream('lingtai-x', n), 0, [requested])
    await recordPrNumber(store, 'lingtai-x', 3)
    const reads = await Effect.runPromise(readProjectPrs('lingtai', store))
    expect(reads.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const other = await Effect.runPromise(readProjectPrs('lingtai-x', store))
    expect(other.map((r) => r.n)).toEqual([1, 2, 3])
  })

  it('finds the highest PR on the project stream and asks head about no pr- stream (#1446)', async () => {
    const { readProjectPrs } = await import('../src/lib/prs.ts')
    const inner = createMemoryEventStore()
    for (let n = 1; n <= 3; n++) await inner.append(prStream('p', n), 0, [requested])
    await recordPrNumber(inner, 'p', 3)
    const heads: string[] = []
    const store = {
      ...inner,
      head: async (id: string) => {
        heads.push(id)
        return inner.head(id)
      },
    }
    const reads = await Effect.runPromise(readProjectPrs('p', store))
    expect(reads.map((r) => r.n)).toEqual([1, 2, 3])
    expect(heads).toEqual([])
  })

  it('reads an unreadable stream as itself and still reads the others', async () => {
    const { readProjectPrs } = await import('../src/lib/prs.ts')
    const store = createMemoryEventStore()
    await store.append(prStream('p', 1), 0, [requested])
    await store.append(prStream('p', 2), 0, [requested])
    await recordPrNumber(store, 'p', 2)
    const real = store.read.bind(store)
    store.read = async (id: string) => {
      if (id === prStream('p', 1)) throw new Error('disk gone')
      return real(id)
    }
    const reads = await Effect.runPromise(readProjectPrs('p', store))
    expect(reads[0]).toEqual({ n: 1, error: 'disk gone' })
    expect('pr' in reads[1]!).toBe(true)
  })
})

/** Turns of the microtask queue, so a test orders reads without a timer (0060 §1). */
const turns = async (n: number) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('the read, with concurrency', () => {
  const requested = { type: 'PrSubmitRequested', actor: 'human:x', data: { by: 'human:x' } } as const
  const merged = {
    type: 'PrMerged',
    actor: 'conductor',
    data: { how: 'host', headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) },
  } as const

  it('stops at the first PR merged before `since`, mid-chunk, and never returns what is older', async () => {
    const { readProjectPrs } = await import('../src/lib/prs.ts')
    // PR n merges on day n. `since` is day 10.5: PR 10 is the first merged before it, newest first.
    let day = 0
    const store = createMemoryEventStore({ now: () => new Date(Date.UTC(2026, 0, 1 + day)) })
    for (let n = 1; n <= 30; n++) {
      day = n
      await store.append(prStream('p', n), 0, [requested])
      await store.append(prStream('p', n), 1, [merged])
      await recordPrNumber(store, 'p', n)
    }
    const real = store.read.bind(store)
    // PR 8 is older than the crossing PR and in its chunk (10, 9, 8, … after 14–7 is read together): its failure is dropped.
    store.read = async (id: string) => {
      if (id === prStream('p', 8)) throw new Error('disk gone')
      return real(id)
    }
    const since = new Date(Date.UTC(2026, 0, 1 + 10, 12))
    const reads = await Effect.runPromise(readProjectPrs('p', store, { since }))
    expect(reads.map((r) => r.n)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ])
    expect(reads.every((r) => 'pr' in r)).toBe(true)
  })

  const tenMerged = async () => {
    const store = createMemoryEventStore()
    for (let n = 1; n <= 10; n++) {
      await store.append(prStream('p', n), 0, [requested])
      await store.append(prStream('p', n), 1, [merged])
      await recordPrNumber(store, 'p', n)
    }
    const read: string[] = []
    const real = store.read.bind(store)
    store.read = async (id: string) => {
      // The project stream is read for the highest PR; the question here is which PR streams are.
      if (id.startsWith('pr-')) read.push(id)
      return real(id)
    }
    return { store, read }
  }

  it('with `merged: 5`, reads five of ten merged PRs and returns them oldest first; without it, all ten', async () => {
    const { readProjectPrs } = await import('../src/lib/prs.ts')
    const { store, read } = await tenMerged()
    const reads = await Effect.runPromise(readProjectPrs('p', store, { merged: 5 }))
    expect(reads.map((r) => r.n)).toEqual([6, 7, 8, 9, 10])
    expect(read.toSorted()).toEqual([6, 7, 8, 9, 10].map((n) => prStream('p', n)).toSorted())
    const all = await Effect.runPromise(readProjectPrs('p', store))
    expect(all.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('with `merged: 5`, a draft above the merged PRs is read and not counted or returned', async () => {
    const { readProjectPrs } = await import('../src/lib/prs.ts')
    const { store, read } = await tenMerged()
    await store.append(prStream('p', 11), 0, [
      {
        type: 'PrDraftTicketAdded',
        actor: 'conductor',
        data: { ticket: '1', mergeCommit: 'c'.repeat(40), from: null },
      },
    ])
    await recordPrNumber(store, 'p', 11)
    const reads = await Effect.runPromise(readProjectPrs('p', store, { merged: 5 }))
    expect(reads.map((r) => r.n)).toEqual([6, 7, 8, 9, 10])
    expect(read.toSorted()).toEqual([6, 7, 8, 9, 10, 11].map((n) => prStream('p', n)).toSorted())
  })

  it('the open PR and the draft read only the newest streams, however many merged before them', async () => {
    const { openPr, readDraftTickets } = await import('@lingtai/project')
    const { store, read } = await tenMerged()
    expect(await Effect.runPromise(openPr('p', store))).toBeNull()
    expect(await Effect.runPromise(readDraftTickets('p', store))).toEqual([])
    expect(new Set(read)).toEqual(new Set([prStream('p', 10)]))
  })

  it('returns the serial order with the reads overlapping, never more than READ_CONCURRENCY at once', async () => {
    const { readProjectPrs } = await import('../src/lib/prs.ts')
    const { READ_CONCURRENCY } = await import('@lingtai/project')
    const store = createMemoryEventStore()
    for (let n = 1; n <= 20; n++) await store.append(prStream('p', n), 0, [requested])
    await recordPrNumber(store, 'p', 20)
    const serial = await Effect.runPromise(readProjectPrs('p', store))
    const real = store.read.bind(store)
    let inFlight = 0
    let most = 0
    // The higher the number, the longer the wait: the PRs read last finish first.
    store.read = async (id: string) => {
      const n = Number(id.split('-').pop())
      inFlight++
      most = Math.max(most, inFlight)
      await turns(n)
      inFlight--
      return real(id)
    }
    const reads = await Effect.runPromise(readProjectPrs('p', store))
    expect(reads).toEqual(serial)
    expect(reads.map((r) => r.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(READ_CONCURRENCY)
  })
})

describe('prBoard', () => {
  it('draws Submit with its cost line when no PR is open', () => {
    const v = prBoard(input([]))
    const draft = cards(v, 'draft')[0]!
    expect(draft.buttons).toEqual([{ kind: 'submit', label: 'Submit PR' }])
    expect(draft.sub.join(' ')).toContain('landed on foundry, not yet on main')
    expect(draft.sub.join(' ')).toContain('≤ 20 turns, 5 min')
    expect(v.strip.branches).toBe('foundry → main')
    expect(v.strip.notInPr).toBe('2 tickets not in a PR yet')
  })

  it('links the draft card to the page listing every draft ticket', () => {
    const draft = cards(prBoard(input([], [tk(1), tk(2), tk(3), tk(4), tk(5)])), 'draft')[0]!
    expect(draft.href).toBe('/pr/p/next')
    expect(draft.more).toBe(2)
  })

  it('disables Submit beside an open PR, naming it', () => {
    const open = pr(7, { status: 'in-review', host: { number: 88, nodeId: 'n', url: 'u' }, tickets: [tk(3)] })
    const draft = cards(prBoard(input([{ n: 7, pr: open }])), 'draft')[0]!
    expect(draft.buttons[0]!.disabled).toBe('one PR at a time — submit opens once PR #88 is merged or closed')
    expect(draft.sub[0]).toBe('landed on foundry since PR #88 was submitted')
  })

  it('draws an empty draft as the column line, not a card', () => {
    const v = prBoard(input([], []))
    expect(col(v, 'draft').cards).toEqual([])
    expect(col(v, 'draft').empty).toBe('Lingtai keeps taking tickets; they gather here.')
  })

  const queuedPr = (over: Partial<PrState> = {}) =>
    pr(3, { status: 'requested', requestedBy: 'human:me', requestedAt: new Date('2026-11-24T19:55:00Z'), ...over })

  it('draws a requested PR as a queued card in In progress, every step pending, with an empty Draft', () => {
    const v = prBoard(input([{ n: 3, pr: queuedPr() }]))
    const card = cards(v, 'progress')[0]!
    expect(card).toMatchObject({ pill: 'queued', tone: 'queued', name: 'PR 3' })
    expect(card.sub).toEqual(['submitted 19:55 by you · waiting for the daemon to start it'])
    expect(card.chips.every((c) => c.status === 'pending')).toBe(true)
    expect(card.slips.map((x) => x.ticket)).toEqual(['1', '2'])
    expect(col(v, 'draft')).toMatchObject({ count: 0, cards: [] })
    expect(col(v, 'draft').empty).toBe(
      'Nothing has landed since PR 3 was submitted. Tickets that land now join PR 3 until it starts, then the next PR.',
    )
    expect(v.submitted).toEqual({ n: 3, at: '19:55', href: '/pr/p/3', daemon: 'running' })
    expect(v.strip.notInPr).toBe('PR 3 queued')
    expect(JSON.stringify(v)).not.toMatch(/pid|freezing/)
  })

  it('says to start a daemon when none runs, and never takes unknown as none', () => {
    const none = prBoard({ ...input([{ n: 3, pr: queuedPr() }]), daemon: 'none' })
    expect(cards(none, 'progress')[0]!.sub[0]).toBe('submitted 19:55 by you')
    expect(cards(none, 'progress')[0]!.buttons[0]).toMatchObject({ kind: 'command', command: 'lingtai start' })
    const unknown = prBoard({ ...input([{ n: 3, pr: queuedPr() }]), daemon: 'unknown' })
    expect(cards(unknown, 'progress')[0]!.buttons[0]).toMatchObject({ kind: 'command', command: 'lingtai doctor' })
    expect(JSON.stringify(unknown)).not.toContain('No daemon is running')
  })

  it('leaves out what the fold does not have: no by, no time', () => {
    const v = prBoard(input([{ n: 3, pr: queuedPr({ requestedBy: null, requestedAt: null }) }]))
    expect(cards(v, 'progress')[0]!.sub[0]).toBe('submitted · waiting for the daemon to start it')
    expect(v.submitted?.at).toBeNull()
    const other = prBoard(input([{ n: 3, pr: queuedPr({ requestedBy: 'human:ann' }) }]))
    expect(cards(other, 'progress')[0]!.sub[0]).toContain('submitted 19:55 by ann')
  })

  it('draws a queued card with no tickets known when the draft could not be read', () => {
    const v = prBoard({ ...input([{ n: 3, pr: queuedPr() }]), draft: { error: 'boom' } })
    const card = cards(v, 'progress')[0]!
    expect(card.slips).toEqual([])
    expect(card.meta).toContain('tickets: unknown')
    expect(cards(v, 'draft')[0]).toMatchObject({ failed: true })
  })

  it('draws the started card in place: in progress, the times, the frozen commit, no confirmation line', () => {
    const started = pr(3, {
      status: 'in-progress',
      requestedAt: new Date('2026-11-24T19:55:00Z'),
      startedAt: new Date('2026-11-24T19:57:00Z'),
      frozenSha: '5ca19bf0123456',
      tickets: [tk(1)],
    })
    const v = prBoard(input([{ n: 3, pr: started }], []))
    const card = cards(v, 'progress')[0]!
    expect(card.pill).toBe('in progress')
    expect(card.sub[0]).toBe('submitted 19:55 · started 19:57 · frozen at 5ca19bf')
    expect(v.submitted).toBeNull()
    expect(col(v, 'draft').empty).toBe('Nothing has landed since PR 3 started.')
    expect(v.strip.notInPr).toBe('PR 3 in progress')
  })

  it('does not call a waiting or in-review PR in progress on the strip', () => {
    for (const [status, words] of [
      ['waiting', 'PR 3 waiting on you'],
      ['in-review', 'PR 3 in review'],
    ] as const) {
      const v = prBoard(input([{ n: 3, pr: pr(3, { status, tickets: [tk(1)] }) }], []))
      expect(v.strip.notInPr).toBe(words)
    }
  })

  it('draws neither ci nor ready as pending on a remote that is not GitHub (#1485)', () => {
    const p = pr(3, {
      // An in-review card carries no chips; the chips are drawn for any PR that has them, so this is the fold's shape.
      status: 'in-progress',
      host: null,
      steps: ['sync', 'build', 'summary', 'push', 'open'].map((step) => ({ step, headSha: 'a' })),
      tickets: [tk(1)],
    })
    const card = cards(prBoard(input([{ n: 3, pr: p }])), 'progress')[0]!
    const texts = card.chips.map((c) => c.text)
    expect(texts.some((t) => t.startsWith('ci ·') || t.startsWith('ready ·'))).toBe(false)
    expect(card.chips.find((c) => c.step === 'ci')).toMatchObject({ text: 'no CI', status: 'done' })
    expect(card.chips.find((c) => c.step === 'ready')).toMatchObject({ status: 'skipped' })
  })

  it('draws a PR in progress with its steps from the conductor’s list', () => {
    const p = pr(2, {
      status: 'in-progress',
      steps: [
        { step: 'sync', headSha: 'a' },
        { step: 'build', headSha: 'a' },
      ],
      tickets: [tk(1)],
    })
    const card = cards(prBoard(input([{ n: 2, pr: p }])), 'progress')[0]!
    expect(card.name).toBe('PR 2')
    expect(card.chips.map((c) => c.step)).toEqual(STEPS.filter((s) => s !== 'topup'))
    expect(card.chips[0]).toMatchObject({ step: 'sync', status: 'done' })
    expect(card.chips[2]).toMatchObject({ step: 'summary', status: 'running' })
  })

  it('draws no CI as no CI, never CI ✓ 0/0', () => {
    const p = pr(2, {
      status: 'in-review',
      ciSkipped: { why: 'no workflow' } as PrState['ciSkipped'],
      prBranch: 'foundry-pr-2',
    })
    expect(cards(prBoard(input([{ n: 2, pr: p }])), 'review')[0]!.meta).toEqual(['no CI'])
  })

  const checks = (verdict: 'green' | 'red') =>
    ({
      headSha: 'h',
      verdict,
      checks: [
        { name: 'unit', state: 'success', url: 'u1' },
        {
          name: 'e2e',
          state: verdict === 'green' ? 'success' : 'failure',
          url: 'https://run/1',
          failing: verdict === 'red',
        },
      ],
    }) as PrState['checks']

  it('draws a CI wait with the run, a new pr-fix ticket and Check again', () => {
    const p = pr(3, {
      status: 'waiting',
      host: { number: 91, nodeId: 'n', url: 'u' },
      checks: checks('red'),
      wait: { step: 'ci', reason: 'ci-red', detail: 'e2e failed', headSha: 'h' },
    })
    const v = prBoard(input([{ n: 3, pr: p }]))
    const card = cards(v, 'waiting')[0]!
    expect(card.name).toBe('PR #91 · CI failed')
    expect(card.sub[0]).toBe('still a GitHub draft — nobody was asked to review it')
    expect(card.buttons.map((b) => b.label)).toEqual(['Open the run ↗', 'New pr-fix ticket', 'Check again'])
    expect(card.buttons[0]).toMatchObject({ href: 'https://run/1' })
    expect(v.waiting).toBe(1)
  })

  it('draws a conflict wait with more rounds, check again and the by-hand lines', () => {
    const p = pr(4, {
      status: 'waiting',
      prBranch: 'foundry-pr-4',
      frozenSha: 'abcdef1234',
      wait: {
        step: 'sync',
        reason: 'sync-conflict',
        detail: 'conflict',
        headSha: 'h',
        conflict: {
          merging: 'main',
          commit: 'a90d2ce1',
          paths: ['shelf.ts'],
          ours: [{ number: '43', title: 'sorts the shelf', mergeCommit: 'm' }],
          theirs: [{ sha: 'a90d2ce1', author: 'li-wei', subject: 's' }],
          roundsUsed: 3,
          last: { step: 'build', said: 'red' },
        },
      },
    })
    const v = prBoard({ ...input([{ n: 4, pr: p }]), spend: new Map([[4, 1.35]]) })
    const card = cards(v, 'waiting')[0]!
    expect(card.buttons.map((b) => b.label)).toEqual(['Give the agent 3 more rounds', 'I resolved it — check again'])
    expect(card.buttons[0]!.grant).toEqual({ merging: 'main', commit: 'a90d2ce1' })
    expect(card.sub.join(' ')).toContain('shelf.ts')
    expect(card.sub.join(' ')).toContain('$1.35')
    expect(card.meta.join(' ')).toContain('theirs a90d2ce li-wei')
    expect(card.byHand.at(-1)).toContain('lingtai pr retry p')
  })

  it('draws an unknown spend as unknown, never $0', () => {
    const p = pr(4, {
      status: 'waiting',
      wait: { step: 'sync', reason: 'sync-conflict', detail: 'c', headSha: 'h' },
    })
    expect(cards(prBoard(input([{ n: 4, pr: p }])), 'waiting')[0]!.sub.join(' ')).toContain('unknown')
  })

  it('gives a wait no retry ends no Check again', () => {
    const p = pr(5, { status: 'waiting', wait: { step: 'push', reason: 'denied', detail: 'nope', headSha: 'h' } })
    expect(cards(prBoard(input([{ n: 5, pr: p }])), 'waiting')[0]!.buttons).toEqual([])
  })

  it('has a word for every reason a PR waits', () => {
    for (const reason of Object.keys(WAIT_WORDS)) expect(WAIT_WORDS[reason as keyof typeof WAIT_WORDS]).not.toBe('')
    expect(Object.keys(WAIT_WORDS)).toHaveLength(14)
  })

  it('draws a PR in review with its branch and CI count', () => {
    const p = pr(6, {
      status: 'in-review',
      prBranch: 'foundry-pr-6',
      main: 'main',
      host: { number: 88, nodeId: 'n', url: 'u' },
      checks: checks('green'),
    })
    const card = cards(prBoard(input([{ n: 6, pr: p }])), 'review')[0]!
    expect(card.pill).toBe('in review')
    expect(card.sub).toEqual(['foundry-pr-6 → main'])
    expect(card.meta).toEqual(['CI ✓ 2/2'])
  })

  it('draws seven merged PRs as the five newest, newest first, with no fold', () => {
    const merged = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
      n,
      pr: pr(n, {
        status: 'merged',
        tickets: [tk(n)],
        mergedTickets: [String(n)],
        mergedExact: true,
        ended: { how: 'git', headSha: 'h', mergeSha: 'm', seq: 1n, at: new Date('2026-11-18T00:00:00Z') },
      }),
    }))
    const c = col(prBoard(input(merged, [])), 'merged')
    expect((c.cards as CardView[]).map((x) => x.name)).toEqual(['PR 7', 'PR 6', 'PR 5', 'PR 4', 'PR 3'])
    expect(c.count).toBe(5)
    expect('older' in c).toBe(false)
    expect(c.cards[0]).toMatchObject({ sub: ['11-18 · 1 ticket closed'] })
  })

  it('draws fourteen tickets as three slips and + 11 more', () => {
    const p = pr(8, { status: 'in-review', tickets: Array.from({ length: 14 }, (_, i) => tk(i + 1)) })
    const card = cards(prBoard(input([{ n: 8, pr: p }])), 'review')[0]!
    expect(card.slips).toHaveLength(3)
    expect(card.more).toBe(11)
    expect(card.count).toBe('14 tickets')
    expect(renderToStaticMarkup(<PrColumns project="p" view={prBoard(input([{ n: 8, pr: p }]))} />)).toContain(
      '+ 11 more',
    )
  })

  it('names a PR without a host number PR <n>, never PR #<n>', () => {
    expect(prName({ host: null, n: 12 })).toBe('PR 12')
    expect(prName({ host: { number: 88, nodeId: '', url: '' }, n: 12 })).toBe('PR #88')
  })

  it('draws an unreadable stream as its own failure and the others still', () => {
    const v = prBoard(
      input([
        { n: 1, error: 'disk gone' },
        { n: 2, pr: pr(2, { status: 'in-review' }) },
      ]),
    )
    expect(col(v, 'progress').cards[0]).toMatchObject({ failed: true, text: 'PR 1 could not be read: disk gone' })
    expect(cards(v, 'review')).toHaveLength(1)
    expect(col(v, 'waiting').empty).not.toBe('Nothing is waiting on you.')
    expect(col(v, 'waiting')).toMatchObject({ unread: true })
    expect(col(v, 'waiting').empty).toContain('PR 1 could not be read')
    const html = renderToStaticMarkup(<PrColumns project="p" view={v} />)
    expect(html).toContain('PR 1 could not be read: disk gone')
  })

  it('draws a pr-fix once, labelled, though the reducer holds it in tickets and fixesLanded', () => {
    const fix = { ticket: '9', mergeCommit: 'c9', title: 'the fix' }
    const p = pr(2, {
      status: 'in-review',
      tickets: [tk(1), fix],
      fixesLanded: [{ ...fix, version: 5 }],
    })
    const card = cards(prBoard(input([{ n: 2, pr: p }])), 'review')[0]!
    expect(card.slips).toEqual([
      { ticket: '1', title: 'ticket 1', fix: false },
      { ticket: '9', title: 'the fix', fix: true },
    ])
    expect(card.more).toBe(0)
  })

  it('never draws a skipped summary as done, and says why on the card', () => {
    const p = pr(2, {
      status: 'in-progress',
      steps: [
        { step: 'sync', headSha: 'a' },
        { step: 'build', headSha: 'a' },
        { step: 'summary', headSha: 'a' },
      ],
      summaryNotWritten: 'the project is locked',
    })
    const card = cards(prBoard(input([{ n: 2, pr: p }])), 'progress')[0]!
    expect(card.chips.find((c) => c.step === 'summary')).toMatchObject({ status: 'skipped', text: 'summary — skipped' })
    expect(card.meta).toContain('no summary: the project is locked')
  })

  it('counts and draws on a merged card only what the merged head held', () => {
    const fix = { ticket: '9', mergeCommit: 'c9', title: 'later fix' }
    const p = pr(2, {
      status: 'merged',
      tickets: [tk(1), fix],
      fixesLanded: [{ ...fix, version: 5 }],
      mergedTickets: ['1'],
      mergedExact: true,
      ended: { how: 'host', headSha: 'h', mergeSha: 'm', seq: 1n, at: new Date('2026-11-18T00:00:00Z') },
    })
    const card = col(prBoard(input([{ n: 2, pr: p }], [])), 'merged').cards[0] as CardView
    expect(card.sub).toEqual(['11-18 · 1 ticket closed'])
    expect(card.slips.map((x) => x.ticket)).toEqual(['1'])
  })

  it('does not call a PR that was marked ready a GitHub draft after a pr-fix', () => {
    const wait = { step: 'ci', reason: 'ci-red', detail: 'e2e failed', headSha: 'h' } as const
    const host = { number: 91, nodeId: 'n', url: 'u' }
    const draft = pr(3, { status: 'waiting', host, wait })
    const ready = pr(3, { status: 'waiting', host, wait, markedReady: true })
    expect(cards(prBoard(input([{ n: 3, pr: draft }])), 'waiting')[0]!.sub[0]).toContain('still a GitHub draft')
    expect(cards(prBoard(input([{ n: 3, pr: ready }])), 'waiting')[0]!.sub.join(' ')).not.toContain('GitHub draft')
  })

  it('draws an unreadable draft as its own failure, never as an empty draft', () => {
    const v = prBoard({ ...input([]), draft: { error: 'disk gone' } })
    expect(col(v, 'draft').cards[0]).toMatchObject({ failed: true, text: 'The draft could not be read: disk gone' })
    expect(v.strip.notInPr).toBe('tickets not in a PR: unknown')
  })

  it('says Nothing is waiting on you only for a board that was read', () => {
    expect(col(prBoard(input([])), 'waiting').empty).toBe('Nothing is waiting on you.')
  })
})

describe('the place line', () => {
  it('has no PRs for a solo project or All projects, and says so for a solo page', () => {
    expect(viewsFor('p').map((v) => v.id)).toEqual(['tickets', 'recipe'])
    expect(viewsFor(undefined).map((v) => v.id)).toEqual(['tickets'])
    expect(soloSentence('p', recipe)).toBe('p is a solo project: each ticket lands on main itself, so it has no PRs')
  })

  it('has PRs with a fail-coloured count when one waits, and none at zero', () => {
    const one = viewsFor('p', { waiting: 1 }).find((v) => v.id === 'prs')!
    expect(one).toMatchObject({ href: '/pr/p', key: 'P', badge: { n: 1, title: '1 PR waiting on you' } })
    expect(viewsFor('p', { waiting: 2 }).find((v) => v.id === 'prs')!.badge!.title).toBe('2 PRs waiting on you')
    expect(viewsFor('p', { waiting: 0 }).find((v) => v.id === 'prs')!.badge).toBeUndefined()
  })

  it('never reads an unreadable count as 0', () => {
    const v = viewsFor('p', { waiting: null }).find((x) => x.id === 'prs')!
    expect(v.badge).toBeUndefined()
    expect(v.unread).toBe('could not read the PRs')
  })
})

describe('the board never appends to a pr- stream', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []
    })

  it('imports a PR command only in actions.ts, and never appends one itself', () => {
    const src = join(__dirname, '..', 'src')
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8')
      if (/prStream\(/.test(text)) expect(text, file).not.toMatch(/\.append\(/)
      if (!file.endsWith('app/actions.ts'))
        expect(text, file).not.toMatch(/\b(requestPr[A-Z]\w*|grantPrRounds|recordPr\w*)\(/)
    }
  })
})

describe('column headings (#1456)', () => {
  it('wears sec-h wait on Waiting on you and sec-h on the rest', () => {
    for (const html of [
      renderToStaticMarkup(<PrColumns project="p" view={prBoard(input([]))} />),
      renderToStaticMarkup(<PrBoardSkeleton />),
    ]) {
      expect(html).toContain('<h2 class="sec-h wait">Waiting on you')
      for (const t of ['Draft', 'In progress', 'In review', 'Merged']) expect(html).toContain(`<h2 class="sec-h">${t}`)
    }
  })
})

describe('PrBoardSkeleton (#1419)', () => {
  const html = renderToStaticMarkup(<PrBoardSkeleton />)
  const titles = PR_COLUMNS.map((c) => c.title)
  const sections = html.split('<section ').slice(1)

  it('draws one section per column of the shared constant, in order', () => {
    expect([...html.matchAll(/<section [^>]*aria-label="([^"]*)"/g)].map((m) => m[1])).toEqual(titles)
  })

  it('puts one card skeleton in each column', () => {
    expect(sections).toHaveLength(titles.length)
    for (const s of sections) expect(s.match(/class="sk-card"/g)).toHaveLength(1)
  })

  it('has no words but the titles', () => {
    expect(
      html
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(titles.join(' '))
  })
})
