/**
 * `spend` stores each run's estimate at its own day's price, and its ticket's
 * kind (#679, 0110 §5, 0123 §3). The snapshot is handed in as a port, so no
 * file is read and this stays unit under 0060 §1.
 */
import type { Envelope, PayloadOf, Usage } from '@lingtai/domain'
import type { RateRow } from '@lingtai/domain/rate-card'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { spendProjectionWith } from '../src/spend.ts'
import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'

const PROJECT = 'pin'
const wi = (n: number) => `ticket-${PROJECT}-${n}`
const CODEX: Usage = [{ model: 'gpt-x', runtime: 'codex', tokens: { fresh: 1_000_000 } } as Usage[number]]
const SNAPSHOT = [
  { model: 'gpt-x', from: '2026-01-01', mode: '', input: 1, output: 1, cacheRead: null, cacheWrite: null },
]

const spent = (
  stream: ReturnType<typeof makeStream>,
  over: Partial<PayloadOf<'RunSpent'>> = {},
  spentFor: PayloadOf<'RunSpent'>['for'] = { _tag: 'Action', step: 'build', name: 'build', round: 0 },
): Envelope =>
  stream('RunSpent', { for: spentFor, runtime: 'codex', turns: 1, durationMs: 1, usage: CODEX, costUsd: null, ...over })

const claim = (stream: ReturnType<typeof makeStream>, runId: string, kind: string | null): Envelope =>
  stream('TicketClaimed', { runId, worker: 'local:1', title: null, kind })

async function fold(events: Envelope[], snapshot: RateRow[] = SNAPSHOT, calls = { n: 0 }) {
  const db = openSqliteProjections(':memory:')
  const store = createSqliteProjectionStore(db)
  try {
    const projection = spendProjectionWith({
      snapshot: () => {
        calls.n += 1
        return snapshot
      },
    })
    await store.transact((ctx) => projection.create(ctx))
    await store.transact((ctx) => projection.apply(events, ctx))
    return await store.spend({})
  } finally {
    await store.close()
  }
}

describe('spend stores the estimate when it folds the run', () => {
  it('prices a Codex run from a snapshot row and leaves cost_usd null', async () => {
    const [row] = await fold([spent(makeStream('pass-pin-a'))])
    expect(row).toMatchObject({ costUsd: null, estimateFetched: true })
    expect(row?.estimatedUsd).toBeGreaterThan(0)
  })

  it('stores a reported cost and leaves the estimate null', async () => {
    const [row] = await fold([spent(makeStream('pass-pin-b'), { costUsd: 0.5, runtime: 'claude-code' })])
    expect(row).toMatchObject({ costUsd: 0.5, estimatedUsd: null, estimateFetched: null })
  })

  it('stores both null for a run nothing can price, never 0', async () => {
    const [row] = await fold([spent(makeStream('pass-pin-c'), { usage: [] })])
    expect(row).toMatchObject({ costUsd: null, estimatedUsd: null, estimateFetched: null })
  })

  it('reads the snapshot once per batch, and not at all when every run reported a cost', async () => {
    const calls = { n: 0 }
    const s = makeStream('pass-pin-d')
    await fold([spent(s), spent(s), spent(s)], SNAPSHOT, calls)
    expect(calls.n).toBe(1)
    const none = { n: 0 }
    await fold([spent(makeStream('pass-pin-e'), { costUsd: 1 })], SNAPSHOT, none)
    expect(none.n).toBe(0)
  })
})

describe('spend carries the ticket kind its claim carried', () => {
  it('takes the run claim kind, keeps it across a continuation claim, and gives triage the latest', async () => {
    const t1 = makeStream(wi(1))
    const run = makeStream('pass-pin-k1')
    const events = [
      claim(t1, 'pass-pin-k1', 'bug'),
      spent(run),
      claim(t1, 'pass-pin-k1', null), // a continuation written as a claim: no kind, never clears it
      spent(run),
      spent(makeStream(wi(1)), {}, { _tag: 'Triage', waitId: 'w' as never }),
    ]
    const rows = await fold(events)
    expect(rows.map((r) => r.kind)).toEqual(['bug', 'bug', 'bug'])
  })

  it('does not let a later claim overwrite the first claim kind on a stream, but triage takes the latest', async () => {
    const t2 = makeStream(wi(2))
    const events = [
      claim(t2, 'pass-pin-k2', 'bug'),
      claim(t2, 'pass-pin-k3', 'feature'),
      spent(makeStream('pass-pin-k2')),
      spent(makeStream('pass-pin-k3')),
      spent(makeStream(wi(2)), {}, { _tag: 'Triage', waitId: 'w' as never }),
    ]
    expect((await fold(events)).map((r) => r.kind)).toEqual(['bug', 'feature', 'feature'])
  })

  it('leaves an unlinked run unclassified', async () => {
    expect((await fold([spent(makeStream('pass-pin-orphan'))]))[0]?.kind).toBeNull()
  })

  it('keeps a run claimed with kind null unclassified, though the ticket was claimed as bug before', async () => {
    const t = makeStream(wi(3))
    const events = [claim(t, 'pass-pin-n1', 'bug'), claim(t, 'pass-pin-n2', null), spent(makeStream('pass-pin-n2'))]
    expect((await fold(events))[0]?.kind).toBeNull()
  })

  it('does not let a lagging projector replaying an older claim overwrite a newer kind', async () => {
    const t = makeStream(wi(4))
    const older = claim(t, 'pass-pin-l1', 'bug')
    const newer = claim(t, 'pass-pin-l2', 'feature')
    const db = openSqliteProjections(':memory:')
    const store = createSqliteProjectionStore(db)
    try {
      const projection = spendProjectionWith({ snapshot: () => SNAPSHOT })
      await store.transact((ctx) => projection.create(ctx))
      await store.transact((ctx) => projection.apply([older, newer], ctx))
      await store.transact((ctx) => projection.apply([older], ctx))
      await store.transact((ctx) =>
        projection.apply([spent(makeStream(wi(4)), {}, { _tag: 'Triage', waitId: 'w' as never })], ctx),
      )
      expect((await store.spend({}))[0]?.kind).toBe('feature')
    } finally {
      await store.close()
    }
  })
})

describe('spend folds TicketContinued as the old-form continuation (#684)', () => {
  const continuation = (stream: ReturnType<typeof makeStream>, runId: string): Envelope =>
    stream('TicketContinued', { runId, worker: 'local:1' })

  async function tables(events: Envelope[]) {
    const db = openSqliteProjections(':memory:')
    const store = createSqliteProjectionStore(db)
    try {
      const projection = spendProjectionWith({ snapshot: () => SNAPSHOT })
      await store.transact((ctx) => projection.create(ctx))
      await store.transact((ctx) => projection.apply(events, ctx))
      const spendKinds = (await store.spend({})).map((r) => r.kind)
      return await store.transact(async (ctx) => ({
        spend: spendKinds,
        stream: await ctx.query('select stream_id, ticket, kind from spend_stream order by stream_id'),
        kind: await ctx.query('select ticket, kind, seq from spend_kind order by ticket'),
      }))
    } finally {
      await store.close()
    }
  }

  const build = (reclaim: typeof claim | typeof continuation) => {
    const t1 = makeStream(wi(21))
    const run = makeStream('pass-pin-c1')
    const first = makeStream(wi(22))
    const orphan = makeStream('pass-pin-c2')
    return [
      claim(t1, 'pass-pin-c1', 'bug'),
      spent(run),
      reclaim === claim ? claim(t1, 'pass-pin-c1', null) : continuation(t1, 'pass-pin-c1'),
      spent(run),
      // a continuation that is the first event seen for its run
      reclaim === claim ? claim(first, 'pass-pin-c2', null) : continuation(first, 'pass-pin-c2'),
      spent(orphan),
    ]
  }

  it('links, keeps the kind and moves nothing, in all three tables', async () => {
    const a = await tables(build(claim))
    const b = await tables(build(continuation))
    expect(a.spend).toEqual(['bug', 'bug', null])
    expect(b.spend).toEqual(a.spend)
    expect(b.stream).toEqual(a.stream)
    expect(b.kind.map((r) => r.kind)).toEqual(['bug'])
    expect(a.kind.map((r) => r.kind)).toEqual(['bug'])
  })
})
