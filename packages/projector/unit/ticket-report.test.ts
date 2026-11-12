/**
 * `ticket_report`'s rules, one test each (0123 §2, #687). Reduced through an
 * in-memory SQLite file, the way `spend-estimate.test.ts` does, so it stays
 * unit under 0060 §1.
 */
import type { Envelope, PayloadOf } from '@lingtai/domain'
import type { RateRow } from '@lingtai/domain/rate-card'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import { createFace, reduceFace } from '../src/store-face.ts'
import { ticketReportProjectionWith } from '../src/ticket-report.ts'

const T = 'ticket-pin-1'
const SNAPSHOT: RateRow[] = [
  { model: 'gpt-x', from: '2026-01-01', mode: '', input: 1, output: 1, cacheRead: null, cacheWrite: null },
]
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes))

type Stream = ReturnType<typeof makeStream>
const claim = (s: Stream, runId: string, kind: string | null, m: number): Envelope =>
  s('TicketClaimed', { runId, worker: 'local:1', title: null, kind }, { at: at(m) })
const started = (s: Stream, m: number): Envelope =>
  s(
    'RunStarted',
    {
      ticketId: T,
      runtime: 'claude-code',
      model: 'm',
      promptVersion: '1',
      baseSha: 'a'.repeat(40),
      configHash: 'c0ffee',
      worktree: '/tmp/pin',
      invocation: null,
    },
    { at: at(m) },
  )
const spent = (
  s: Stream,
  spentFor: PayloadOf<'RunSpent'>['for'],
  m: number,
  over: Partial<PayloadOf<'RunSpent'>> = {},
): Envelope =>
  s(
    'RunSpent',
    {
      for: spentFor,
      runtime: 'claude-code',
      turns: 1,
      durationMs: 1,
      usage: [],
      costUsd: 0.5,
      ...over,
    },
    { at: at(m) },
  )
const work = (round: number): PayloadOf<'RunSpent'>['for'] => ({ _tag: 'Action', step: 'build', name: 'build', round })

async function reduce(batches: Envelope[][]) {
  const db = openSqliteProjections(':memory:')
  const store = createSqliteProjectionStore(db)
  try {
    const projection = ticketReportProjectionWith({ snapshot: () => SNAPSHOT })
    await store.transact((ctx) => createFace(projection, ctx))
    for (const batch of batches) await store.transact((ctx) => reduceFace(projection, batch, ctx))
    const [row] = await store.transact((ctx) =>
      ctx.query<Record<string, unknown>>('select * from ticket_report where ticket = $1', [T]),
    )
    return row
  } finally {
    await store.close()
  }
}

const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)

describe('ticket_report', () => {
  it('sums fix rounds over every pass, never the maximum for one (#658)', async () => {
    const t = makeStream(T)
    const events: Envelope[] = []
    for (let p = 0; p < 4; p++) {
      const run = makeStream(`pass-pin-${p}`)
      events.push(claim(t, `pass-pin-${p}`, 'bug', p * 10), started(run, p * 10 + 1))
      // 14 over 4 passes: 4, 4, 3, 3 rounds
      for (let r = 1; r <= (p < 2 ? 4 : 3); r++) events.push(spent(run, work(r), p * 10 + 2))
      events.push(spent(run, work(0), p * 10 + 3))
    }
    const row = await reduce([events])
    expect(row).toMatchObject({ passes: 4, fix_rounds: 14, kind: 'bug' })
  })

  it('counts a continuation, new or old form, as no pass', async () => {
    const t = makeStream(T)
    const events = [
      claim(t, 'pass-pin-a', 'bug', 0),
      t('TicketContinued', { runId: 'pass-pin-b', worker: 'local:1' }, { at: at(1) }),
      claim(t, 'pass-pin-a', null, 2),
    ]
    // old form split across a batch boundary
    const row = await reduce([events.slice(0, 1), events.slice(1, 2), events.slice(2)])
    expect(row).toMatchObject({ passes: 1, kind: 'bug' })
    expect(parse(row?.pass_times)).toHaveLength(1)
  })

  it('ends an interval at its last sign of life, and contributes 0 when there is none', async () => {
    const t = makeStream(T)
    const a = makeStream('pass-pin-a')
    const row = await reduce([
      [
        claim(t, 'pass-pin-a', 'bug', 0),
        started(a, 1),
        spent(a, work(0), 5),
        // a conductor that died: the release lands hours later
        t('TicketReleased', { runId: 'pass-pin-a', reason: 'died', cause: null }, { at: at(300) }),
        claim(t, 'pass-pin-b', 'bug', 301),
        t('TicketReleased', { runId: 'pass-pin-b', reason: 'died', cause: null }, { at: at(302) }),
        claim(t, 'pass-pin-c', 'bug', 303),
      ],
    ])
    expect(row).toMatchObject({ machine_ms: 5 * 60_000, intervals_empty: 1, intervals_open: 1, passes: 3 })
  })

  it('prices an unreported run at the reducer and keeps reported, estimated and unknown apart', async () => {
    const t = makeStream(T)
    const a = makeStream('pass-pin-a')
    const usage = [{ model: 'gpt-x', tokens: { fresh: 1_000_000 } }] as PayloadOf<'RunSpent'>['usage']
    const row = await reduce([
      [
        claim(t, 'pass-pin-a', 'bug', 0),
        spent(a, work(0), 1),
        spent(a, work(0), 2, { costUsd: null, usage }),
        spent(a, work(0), 3, { costUsd: null, usage: [] }),
        spent(a, work(1), 4),
      ],
    ])
    const cost = parse(row?.cost)
    expect(cost.Work).toMatchObject({ reportedCents: 50, reportedRuns: 1, estimatedRuns: 1, unknown: 1 })
    expect(cost.Work.estimatedUsd).toBeGreaterThan(0)
    expect(cost.Answering).toMatchObject({ reportedCents: 50 })
  })

  it('adds one unknown per claim with no Action RunSpent, and none for a continuation', async () => {
    const t = makeStream(T)
    const a = makeStream('pass-pin-a')
    const b = makeStream('pass-pin-b')
    const row = await reduce([
      [
        claim(t, 'pass-pin-a', 'bug', 0),
        claim(t, 'pass-pin-b', 'bug', 1),
        claim(t, 'pass-pin-b', null, 2),
        spent(a, work(0), 3),
        spent(b, { _tag: 'Judge', when: 'findings' } as PayloadOf<'RunSpent'>['for'], 4),
      ],
    ])
    expect(row).toMatchObject({ unknown_claims: 1, passes: 2 })
  })

  it('reduces the outcome: a landing is landed, and a close is final (D6: a later claim reopens nothing)', async () => {
    const t = makeStream(T)
    const closed = await reduce([
      [claim(t, 'pass-pin-a', 'bug', 0), t('TicketClosed', { by: 'p', reason: 'r' }, { at: at(1) })],
    ])
    expect(closed).toMatchObject({ outcome: 'closed' })
    const t2 = makeStream(T)
    const reopened = await reduce([
      [
        claim(t2, 'pass-pin-a', 'bug', 0),
        t2('TicketClosed', { by: 'p', reason: 'r' }, { at: at(1) }),
        claim(t2, 'pass-pin-b', 'bug', 2),
      ],
    ])
    // D6: `closed` absorbs the claim, so there is no second pass and no interval.
    expect(reopened).toMatchObject({ outcome: 'closed', passes: 1, intervals_open: 0 })
    const t3 = makeStream(T)
    const landed = await reduce([
      [claim(t3, 'pass-pin-a', 'bug', 0), t3('TicketLanded', { mergeCommit: 'abc', base: 'main' }, { at: at(1) })],
    ])
    expect(landed).toMatchObject({ outcome: 'landed' })
    // A close after a landing is a sequence `close.ts` refuses to write; the reduce's answer is `closed`.
    const t4 = makeStream(T)
    const closedAfterLanding = await reduce([
      [
        claim(t4, 'pass-pin-a', 'bug', 0),
        t4('TicketLanded', { mergeCommit: 'abc', base: 'main' }, { at: at(1) }),
        t4('TicketClosed', { by: 'p', reason: 'r' }, { at: at(2) }),
      ],
    ])
    expect(closedAfterLanding).toMatchObject({ outcome: 'closed' })
  })

  it('holds the landing attempt, its last diff, the last review’s summary and its fix rounds (#894)', async () => {
    const t = makeStream(T)
    const a = makeStream('pass-pin-a')
    const b = makeStream('pass-pin-b')
    const diff = (s: Stream, m: number, files: number): Envelope =>
      s(
        'RunProducedDiff',
        { branch: 'agent/1', headSha: 'f'.repeat(40), files, insertions: files * 2, deletions: 1 },
        { at: at(m) },
      )
    const review = (s: Stream, runId: string, round: number, summary: string | null, m: number): Envelope =>
      s(
        'StepEnded',
        {
          runId,
          outcome: {
            step: 'review',
            round,
            actions: [
              {
                plugin: 'agent',
                name: 'review',
                onSha: 'f'.repeat(40),
                evidence: 'e',
                yields: 'verdict',
                result: {
                  _tag: 'Completed',
                  assessment: { verdict: 'accepted', findings: [], ...(summary === null ? {} : { summary }) },
                },
              },
            ],
          },
        } as PayloadOf<'StepEnded'>,
        { at: at(m) },
      )
    const row = await reduce([
      [
        claim(t, 'pass-pin-a', 'bug', 0),
        diff(a, 1, 9),
        review(a, 'pass-pin-a', 0, 'attempt one', 2),
        t('TicketReleased', { runId: 'pass-pin-a', reason: 'died', cause: null }, { at: at(3) }),
        claim(t, 'pass-pin-b', 'bug', 4),
        t('TicketContinued', { runId: 'pass-pin-c', worker: 'local:1' }, { at: at(5) }),
        diff(b, 6, 3),
        review(b, 'pass-pin-b', 0, 'first look', 7),
        diff(b, 8, 4),
        spent(b, work(1), 9),
        review(b, 'pass-pin-b', 1, 'after the fix', 10),
        t('TicketLanded', { mergeCommit: 'abc', base: 'main' }, { at: at(11) }),
      ],
    ])
    expect(row).toMatchObject({
      outcome: 'landed',
      landing_run: 'pass-pin-b',
      landing_attempt: 2,
      landing_fix_rounds: 1,
      diff_files: 4,
      diff_insertions: 8,
      diff_deletions: 1,
      summary: 'after the fix',
    })
    expect(row?.summary_clipped).toBeNull()
  })

  it('leaves the landing facts null where the run produced no diff or summary, and for an open ticket (#894)', async () => {
    const t = makeStream(T)
    const landed = await reduce([
      [claim(t, 'pass-pin-a', 'bug', 0), t('TicketLanded', { mergeCommit: 'abc', base: 'main' }, { at: at(1) })],
    ])
    expect(landed).toMatchObject({
      landing_run: 'pass-pin-a',
      landing_attempt: 1,
      landing_fix_rounds: 0,
      diff_files: null,
      diff_insertions: null,
      diff_deletions: null,
      summary: null,
    })
    const open = await reduce([[claim(makeStream(T), 'pass-pin-a', 'bug', 0)]])
    expect(open).toMatchObject({ landing_run: null, landing_attempt: null, diff_files: null, summary: null })
  })

  it('D4: a claim with a null kind keeps the kind an earlier one named', async () => {
    const t = makeStream(T)
    const row = await reduce([[claim(t, 'pass-pin-a', 'bug', 0), claim(t, 'pass-pin-b', null, 1)]])
    expect(row).toMatchObject({ passes: 2, kind: 'bug' })
  })

  it('rebuilding gives the rows of the live reduce', async () => {
    const t = makeStream(T)
    const a = makeStream('pass-pin-a')
    const events = [claim(t, 'pass-pin-a', 'bug', 0), started(a, 1), spent(a, work(1), 2)]
    const live = await reduce(events.map((e) => [e]))
    const once = await reduce([events])
    expect(once).toEqual(live)
  })
})
