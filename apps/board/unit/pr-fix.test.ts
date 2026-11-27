/**
 * Which pr-fix ticket is fixing the open PR (#1506): `fixingOf` over hand-built reads, the board's column and chip, and
 * the `PRs` count through the reads seam. No store, no GitHub: a test hands in plain data.
 */
import { type PrState, emptyPr } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ticketPath } from '../src/lib/paths.ts'
import { type CardView, type PrBoardInput, prBoard } from '../src/lib/pr-board.ts'
import { type PrFixRead, type PrFixTicket, fixingOf } from '../src/lib/pr-fix.ts'
import { type PrFixReads, readPrFixes } from '../src/lib/prs.ts'

const recipe = {
  mode: 'team',
  branch: { main: 'main', personal: 'foundry' },
  runtime: { agent: 'claude-code', limits: { attempt: { conflictResolutions: 3 } } },
} as unknown as Recipe

const wait = { step: 'ci', reason: 'ci-red', detail: 'CI failed on 296d90c: unit', headSha: 'h' } as const
const host = { number: 1503, nodeId: 'n', url: 'u' }
const pr = (over: Partial<PrState> = {}): PrState => ({
  ...emptyPr,
  project: 'p',
  n: 8,
  status: 'waiting',
  host,
  markedReady: true,
  wait,
  ...over,
})
const ticket = (over: Partial<PrFixTicket> = {}): PrFixTicket => ({
  issue: 1505,
  title: 'pr-fix for PR #1503:',
  source: 'claim',
  state: 'running',
  cutFromPr: 8,
  labels: ['lingtai:pr-fix'],
  step: 'build',
  claimedAt: '2026-11-26T10:00:00.000Z',
  ...over,
})
const read = (...tickets: PrFixTicket[]): PrFixRead => ({ kind: 'read', tickets })

describe('fixingOf', () => {
  it('names a claimed running ticket with its step', () => {
    const f = fixingOf(pr(), read(ticket()))
    expect(f.tickets.map((t) => t.word)).toEqual(['running · build'])
    expect(fixingOf(pr(), read(ticket({ step: null }))).tickets[0]!.word).toBe('running')
  })
  it('says queued for a released claim and for an unclaimed listing entry', () => {
    expect(fixingOf(pr(), read(ticket({ state: 'queued' }))).tickets[0]!.word).toBe('queued')
    expect(
      fixingOf(pr(), read(ticket({ source: 'listing', state: 'queued', cutFromPr: undefined, claimedAt: null })))
        .tickets[0]!.word,
    ).toBe('queued')
  })
  it('waits on you for a waiting claim and for a held listing entry', () => {
    const w = fixingOf(pr(), read(ticket({ state: 'waiting' })))
    expect(w.waitsOn?.issue).toBe(1505)
    const held = fixingOf(
      pr(),
      read(ticket({ source: 'listing', state: 'queued', cutFromPr: undefined, labels: ['lingtai:hold'] })),
    )
    expect(held.waitsOn?.word).toBe('waiting on you')
  })
  it('excludes a claim that names another PR, or no PR', () => {
    expect(fixingOf(pr(), read(ticket({ cutFromPr: 7 }))).tickets).toEqual([])
    expect(fixingOf(pr(), read(ticket({ cutFromPr: null }))).tickets).toEqual([])
  })
  it('excludes landed, closed and lingtai:landed tickets', () => {
    expect(fixingOf(pr(), read(ticket({ state: 'closed' }))).tickets).toEqual([])
    expect(fixingOf(pr(), read(ticket({ state: 'landed' }))).tickets).toEqual([])
    expect(fixingOf(pr(), read(ticket({ labels: ['lingtai:pr-fix', 'lingtai:landed'] }))).tickets).toEqual([])
  })
  it('draws a landed fix while the PR owes its restart, even when the read failed', () => {
    const owed = pr({
      fixOwed: true,
      fixesLanded: [{ ticket: '1505', title: 't', mergeCommit: 'c', version: 1 }] as PrState['fixesLanded'],
    })
    expect(fixingOf(owed, read()).tickets.map((t) => t.word)).toEqual(['landed'])
    const failed = fixingOf(owed, { kind: 'failed', error: 'gone' })
    expect(failed.tickets.map((t) => t.word)).toEqual(['landed'])
    expect(failed.unknown).toBe('gone')
  })
  it('lists two tickets lowest first and names the one waiting', () => {
    const f = fixingOf(pr(), read(ticket({ issue: 1507, state: 'waiting' }), ticket({ issue: 1505 })))
    expect(f.tickets.map((t) => t.issue)).toEqual([1505, 1507])
    expect(f.waitsOn?.issue).toBe(1507)
  })
  it('never turns a failed read into an empty list', () => {
    const f = fixingOf(pr(), { kind: 'failed', error: 'timed out' })
    expect(f.tickets).toEqual([])
    expect(f.unknown).toBe('timed out')
  })
})

const input = (p: PrState, fixes: PrFixRead | null): PrBoardInput => ({
  project: 'p',
  recipe,
  prs: [{ n: 8, pr: p }],
  draft: [],
  stepNames: ['sync', 'build', 'summary', 'push', 'open', 'ci', 'topup', 'ready'],
  spend: new Map(),
  daemon: 'running',
  viewer: 'human:me',
  newFixHref: { kind: 'link', href: 'https://example.test/new' },
  fixes,
})
const cardsOf = (v: ReturnType<typeof prBoard>, id: string) => v.columns.find((c) => c.id === id)!.cards as CardView[]
const withChecks = (): PrState =>
  pr({
    checks: {
      verdict: 'red',
      checks: [{ name: 'unit', state: 'failure', url: 'https://run/1', failing: true }],
    } as PrState['checks'],
  })

describe('the board with a pr-fix', () => {
  it('draws a running fix in In progress, with the chip, the link and no button', () => {
    const v = prBoard(input(withChecks(), read(ticket())))
    expect(cardsOf(v, 'waiting')).toEqual([])
    const card = cardsOf(v, 'progress')[0]!
    expect(card.name).toBe('PR #1503 · fixing CI')
    expect(card.pill).toBe('in progress')
    expect(card.sub[0]).toBe('CI failed on 296d90c — a pr-fix is on it')
    expect(card.chips.find((c) => c.step === 'ci')).toMatchObject({ text: 'CI ↻ fix', status: 'running' })
    expect(card.fixing).toEqual([
      {
        text: 'fixing: #1505 pr-fix for PR #1503: · running · build',
        href: ticketPath({ project: 'p', issue: '1505' } as never),
      },
    ])
    expect(card.buttons.map((b) => b.label)).not.toContain('New pr-fix ticket')
    expect(card.buttons.map((b) => b.label)).toContain('Open the run ↗')
    expect(v.waiting).toBe(0)
  })
  it('puts a waiting fix back in Waiting on you', () => {
    const v = prBoard(input(withChecks(), read(ticket({ state: 'waiting' }))))
    const card = cardsOf(v, 'waiting')[0]!
    expect(card.sub).toContain('#1505 is waiting on you')
    expect(v.waiting).toBe(1)
  })
  it('offers the button again when the fix closed or belongs to another PR', () => {
    for (const t of [ticket({ state: 'closed' }), ticket({ cutFromPr: 3 })]) {
      const v = prBoard(input(withChecks(), read(t)))
      expect(cardsOf(v, 'waiting')[0]!.buttons.map((b) => b.label)).toContain('New pr-fix ticket')
      expect(v.waiting).toBe(1)
    }
  })
  it('draws a landed fix with the restart owed in In progress', () => {
    const owed = withChecks()
    const p = {
      ...owed,
      fixOwed: true,
      fixesLanded: [{ ticket: '1505', title: 't', mergeCommit: 'c', version: 1 }],
    } as PrState
    const v = prBoard(input(p, read()))
    expect(cardsOf(v, 'progress')[0]!.fixing![0]!.text).toContain('· landed')
    expect(v.waiting).toBe(0)
  })
  it('keeps the wait and the button, and says it could not tell, when the read failed', () => {
    const v = prBoard(input(withChecks(), { kind: 'failed', error: 'timed out' }))
    const card = cardsOf(v, 'waiting')[0]!
    expect(card.sub).toContain('could not tell whether a pr-fix is open: timed out')
    expect(card.buttons.map((b) => b.label)).toContain('New pr-fix ticket')
    expect(v.waiting).toBe(1)
  })
  it('keeps another wait in Waiting on you and only adds the line', () => {
    const p = pr({ wait: { step: 'ci', reason: 'ci-timeout', detail: 'slow', headSha: 'h' } })
    const v = prBoard(input(p, read(ticket())))
    expect(cardsOf(v, 'waiting')[0]!.fixing).toHaveLength(1)
    expect(v.waiting).toBe(1)
  })
})

const reads = (over: Partial<PrFixReads> = {}): PrFixReads => ({
  tasks: () => Effect.succeed([{ issue: '1505', title: 'x', kind: 'Lingtai:PR-fix', state: 'running', runId: 'r1' }]),
  claim: () => Effect.succeed({ cutFromPr: 8, claimedAt: '2026-11-26T10:00:00.000Z' }),
  step: () => Effect.succeed('build'),
  listing: () => Effect.succeed([]),
  ...over,
})

describe('readPrFixes and the PRs count', () => {
  it('reads a claimed pr-fix from the projection and the claim', async () => {
    const r = await Effect.runPromise(readPrFixes('p', pr(), { listing: false }, reads()))
    expect(r).toMatchObject({ kind: 'read', tickets: [{ issue: 1505, cutFromPr: 8, step: 'build', source: 'claim' }] })
  })
  it('asks the listing only when nothing is fixing the PR, and drops what the projection returned', async () => {
    let asked = 0
    const listing = () => {
      asked++
      return Effect.succeed([
        { number: 1505, title: 'x', labels: [{ name: 'lingtai:pr-fix' }] },
        { number: 1600, title: 'y', labels: [{ name: 'lingtai:pr-fix' }, { name: 'lingtai:hold' }] },
        { number: 1601, title: 'z', labels: [{ name: 'bug' }] },
      ])
    }
    await Effect.runPromise(readPrFixes('p', pr(), { listing: true }, reads({ listing })))
    expect(asked).toBe(0)
    const none = reads({ tasks: () => Effect.succeed([]), listing })
    const r = await Effect.runPromise(readPrFixes('p', pr(), { listing: true }, none))
    expect(r.kind === 'read' && r.tickets.map((t) => t.issue)).toEqual([1505, 1600])
  })
  it('turns a failed or slow listing into a failed read, never an empty one', async () => {
    const none = reads({ tasks: () => Effect.succeed([]), listing: () => Effect.fail(new Error('rate limited')) })
    expect(await Effect.runPromise(readPrFixes('p', pr(), { listing: true }, none))).toEqual({
      kind: 'failed',
      error: 'rate limited',
    })
  })
  it('counts 0 while a claimed ticket is fixing the PR, and fails when the projection cannot be read', async () => {
    const { waitingPrs } = await import('../src/lib/prs.ts')
    const { recordPrNumber } = await import('@lingtai/project/test/pr-numbers')
    const { prStream } = await import('@lingtai/domain')
    const store = createMemoryEventStore()
    const tickets = [{ ticket: '41', mergeCommit: 'c41', title: 't' }]
    await store.append(prStream('p', 1), 0, [
      { type: 'PrSubmitRequested', actor: 'human:x', data: { by: 'human:x' } },
      {
        type: 'PrInProgress',
        actor: 'conductor',
        data: {
          because: 'submit',
          branch: 'foundry',
          main: 'main',
          frozenSha: 'f0',
          prBranch: 'foundry-pr-1',
          tickets,
        },
      },
      {
        type: 'PrWaiting',
        actor: 'conductor',
        data: { step: 'ci', reason: 'ci-red', detail: 'CI failed on f0: unit', headSha: 'f0' },
      },
    ])
    await recordPrNumber(store, 'p', 1)
    const fixing = reads({ claim: () => Effect.succeed({ cutFromPr: 1, claimedAt: null }) })
    expect(await Effect.runPromise(waitingPrs('p', store, fixing))).toBe(0)
    const elsewhere = reads({ claim: () => Effect.succeed({ cutFromPr: 9, claimedAt: null }) })
    expect(await Effect.runPromise(waitingPrs('p', store, elsewhere))).toBe(1)
    const broken = reads({ tasks: () => Effect.fail(new Error('projection down')) })
    const r = await Effect.runPromise(Effect.result(waitingPrs('p', store, broken)))
    expect(r._tag).toBe('Failure')
  })
})
