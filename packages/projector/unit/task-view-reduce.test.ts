/**
 * `task_view` reads its one-stream columns off the ticket reduce (#834): each
 * cell where it used to disagree with `applyTicket` (D5, D6) over the histories
 * #798 built for it, the `verifying` overlay, and the at-least-once delivery.
 *
 * `createSqliteProjectionStore(openSqliteProjections(':memory:'))` — the real
 * fold path, touching no file, so unit under 0060 §1. Every history below is
 * built at module scope by `@lingtai/domain/test/histories`, whose `seq` and `at`
 * are hash-locked, so nothing here builds one.
 */
import type { Envelope } from '@lingtai/domain'
import { agentBranchOf, waitWords } from '@lingtai/domain'
import { aClaim } from '@lingtai/domain/test/events'
import { histories, lateHistories, scenarios } from '@lingtai/domain/test/histories'
import type { Scenario } from '@lingtai/domain/test/histories'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it, vi } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { ProjectionContext, ProjectionRow } from '../src/store.ts'
import { taskViewProjection } from '../src/task-view.ts'

// A spy on the reduce, so a replay can be shown to skip it (the skip is made before `applyTicket`).
const spy = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@lingtai/domain', async (original) => {
  const m = await original<typeof import('@lingtai/domain')>()
  return {
    ...m,
    applyTicket: (...args: Parameters<typeof m.applyTicket>) => {
      spy.calls += 1
      return m.applyTicket(...args)
    },
  }
})

/** A scenario's streams, merged by `seq` as a log would hand them over. */
const mergeBySeq = (s: Scenario): Envelope[] =>
  [...s.ticket, ...s.runs.flat(), ...(s.integration ?? [])].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))

async function withStore<T>(
  fn: (run: (batch: readonly Envelope[]) => Promise<void>, ctx: ProjectionContext) => Promise<T>,
): Promise<T> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => taskViewProjection.create(ctx))
    return await store.transact(async (ctx) => fn((batch) => taskViewProjection.apply(batch, ctx), ctx))
  } finally {
    db.close()
  }
}

async function tableAfter(events: readonly Envelope[], batch = events.length): Promise<ProjectionRow[]> {
  return withStore(async (run, ctx) => {
    for (let i = 0; i < events.length; i += batch) await run(events.slice(i, i + batch))
    return ctx.query('select * from task_view order by task_id')
  })
}

async function rowAfter(events: readonly Envelope[]): Promise<ProjectionRow> {
  const [row] = await tableAfter(events)
  if (!row) throw new Error('no row')
  return row
}

const parsed = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v)

describe('task_view reads state and answer off the ticket reduce', () => {
  it('D5: a fix round granted is approved', async () => {
    const h = histories.ticket.waitsResolvedBeforeClose
    const cut = h.findIndex((e) => e.type === 'WaitResolved')
    const row = await rowAfter(h.slice(0, cut + 1))
    expect(row).toMatchObject({
      state: 'approved',
      note: 'fix round granted — continues once a conductor is free',
      wait_id: null,
    })
  })

  it('D5: Close is waiting until TicketClosed', async () => {
    const h = histories.ticket.waitsResolvedBeforeClose
    const sign = [...h].reverse().find((e) => e.type === 'WaitStarted')!
    const row = await rowAfter(h)
    expect(row).toMatchObject({ state: 'waiting', wait_id: (sign.data as { waitId: string }).waitId })
    expect(row.answer).toBeNull()
  })

  it('D5: IntegrationSucceeded alone is not landed', async () => {
    const row = await rowAfter(mergeBySeq(scenarios.integratedWithoutLanding))
    expect(row).toMatchObject({ state: 'running', closed_at: null })
  })

  it('D5: an answer is worded from the reason', async () => {
    const s = scenarios.answerAfterRunNote
    const started = s.ticket.find((e) => e.type === 'WaitStarted')!
    const reason = (started.data as { reason: Parameters<typeof waitWords>[0] }).reason
    const row = await rowAfter(mergeBySeq(s))
    const answer = parsed(row.answer) as { question: string; answer: string; by: string }
    expect(answer.question).toBe(waitWords(reason, { branch: agentBranchOf('9302'), base: '', findings: [] }).line)
    expect(answer.question).not.toBe('which of the two, really?')
    expect(answer).toMatchObject({ answer: 'the first', by: 'steven' })
  })

  it('triage reads the reduce: the first result for the latest attempt', async () => {
    const h = lateHistories.ticket.triagedTwice
    const cut = h.findIndex((e) => e.type === 'WaitResolved')
    const row = await rowAfter(h.slice(0, cut))
    expect(row.triage_attempt).toBe(2)
    expect(parsed(row.triage_result)).toMatchObject({ _tag: 'TriageFailed', why: 'second' })
    expect(row.triage_head_sha).toBe('head-2')
  })

  it('D6: a claim after a close changes nothing', async () => {
    const row = await rowAfter(histories.ticket.claimedAfterClosed)
    expect(row).toMatchObject({ state: 'closed', attempts: 1 })
  })
})

describe('the verifying overlay and the rows a ticket event may make', () => {
  it('a ticket event during verifying leaves it verifying', async () => {
    const ticket = makeStream('ticket-overlay-1')
    const run = makeStream('pass-overlay-1')
    const claim = aClaim(ticket, 'pass-overlay-1')
    const proposed = run('RunProposedCompletion', { headSha: 'sha-1' })
    const edited = ticket('PromptEdited', {
      text: 'mind the edge',
      hash: null,
      by: 'steven',
      basedOn: null,
      chatId: null,
    })
    const before = await rowAfter([...claim, proposed])
    expect(before.state).toBe('verifying')
    const after = await rowAfter([...claim, proposed, edited])
    expect(after.state).toBe('verifying')
    expect(after.updated_at).toEqual(before.updated_at)
    expect(after.updated_seq).toEqual(before.updated_seq)
  })

  it('a prompt edit on an untouched ticket makes no row', async () => {
    const ticket = makeStream('ticket-untouched-1')
    const edited = ticket('PromptEdited', { text: 'x', hash: null, by: 'steven', basedOn: null, chatId: null })
    await withStore(async (run, ctx) => {
      await run([edited])
      expect(await ctx.query('select * from task_view')).toEqual([])
      expect(await ctx.query('select task_id from task_view_ticket')).toHaveLength(1)
      // The event that makes the row moves the state into it, and the side row goes.
      await run(aClaim(ticket, 'pass-untouched-1'))
      expect(await ctx.query('select task_id from task_view')).toHaveLength(1)
      expect(await ctx.query('select task_id from task_view_ticket')).toEqual([])
    })
  })
})

describe('delivery is at-least-once', () => {
  it('the same events handed over twice leave the row as one delivery does, without reducing again', async () => {
    const h = histories.ticket.waitsResolvedBeforeClose
    const cut = h.findIndex((e) => e.type === 'WaitResolved')
    const events = h.slice(0, cut + 1)
    const once = await tableAfter(events)
    const twice = await withStore(async (run, ctx) => {
      await run(events)
      spy.calls = 0
      await run(events.slice(0, 1))
      await run(events.slice(cut, cut + 1))
      expect(spy.calls).toBe(0)
      return ctx.query('select * from task_view order by task_id')
    })
    expect(twice).toEqual(once)
    // A later event with a greater seq still reduces.
    const later = await tableAfter(h.slice(0, cut + 2))
    expect(later[0]!.state).toBe('running')
  })

  it('two runners that both read before either writes have one effect', async () => {
    // SQLite only: a Postgres twin is the integration half, which a pass does not run.
    const ticket = makeStream('ticket-race-1')
    const claim = aClaim(ticket, 'pass-race-1')
    const first = ticket('TicketReleased', { runId: 'pass-race-1', reason: 'x', cause: null })
    const second = { ...first, data: { ...(first.data as object), reason: 'y' } } as Envelope
    await withStore(async (run, ctx) => {
      await run(claim)
      const stale = await ctx.query('select ticket from task_view where task_id = $1', ['ticket-race-1'])
      const staleCtx: ProjectionContext = {
        query: ((sql: string, params?: readonly unknown[]) =>
          sql.startsWith('select ticket from task_view where')
            ? Promise.resolve(stale)
            : ctx.query(sql, params)) as never,
      }
      await taskViewProjection.apply([first], staleCtx)
      await taskViewProjection.apply([second], staleCtx)
      const [row] = await ctx.query('select note from task_view where task_id = $1', ['ticket-race-1'])
      expect(row!.note).toBe('x')
    })
  })
})

describe('incremental against rebuild', () => {
  const cases: [string, Envelope[]][] = [
    ['waitsResolvedBeforeClose', [...histories.ticket.waitsResolvedBeforeClose]],
    ['claimedAfterClosed', [...histories.ticket.claimedAfterClosed]],
    ['claimedReleasedClaimedLanded', [...histories.ticket.claimedReleasedClaimedLanded]],
    ['approvedAfterSignoff', [...histories.ticket.approvedAfterSignoff]],
    ['triagedTwice', [...lateHistories.ticket.triagedTwice]],
    ['integratedWithoutLanding', mergeBySeq(scenarios.integratedWithoutLanding)],
    ['answerAfterRunNote', mergeBySeq(scenarios.answerAfterRunNote)],
    ['landedWithRun', mergeBySeq(scenarios.landedWithRun)],
  ]
  it.each(cases)('%s reduces to the same rows in batches of 1, 3 and all', async (_name, events) => {
    const whole = await tableAfter(events)
    expect(await tableAfter(events, 1)).toEqual(whole)
    expect(await tableAfter(events, 3)).toEqual(whole)
  })
})
