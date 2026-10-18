/**
 * `spend` (#497): one row per `RunSpent`, for every `for` variant 0110 §9
 * gives it, and a `ticket` filled through `spend.ts`'s own link table.
 *
 * Runs on `createSqliteProjectionStore(openSqliteProjections(':memory:'))` —
 * the real fold path, skipping WAL, touching no file and reading no `$HOME`,
 * so it is unit under 0060 §1. Follows `backlog-rebuild.test.ts`'s own shape:
 * the stream is built once, at module scope, off the module-global seq
 * counter `@lingtai/domain/test/support` keeps.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Envelope, PayloadOf, WaitId } from '@lingtai/domain'
import { chatStream, CONTROL_STREAM } from '@lingtai/domain'
import { aRun } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { spendProjection } from '../src/spend.ts'
import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { ProjectionRow } from '../src/store.ts'

const SHA = 'a'.repeat(40)
const PROJECT = 'pin'
const wi = (n: number | string) => `wi-${PROJECT}-${n}`

const USAGE = [{ model: 'claude-opus-5', tokens: { fresh: 100, output: 20 } }]

function aRunStarted(run: ReturnType<typeof aRun>, workItemId: string): Envelope {
  return run.event('RunStarted', {
    workItemId,
    runtime: 'claude-code',
    model: 'm',
    promptVersion: '1',
    baseSha: SHA,
    configHash: 'c0ffee',
    worktree: '/tmp/pin',
    invocation: null,
  })
}

function aRunSpent(
  event: ReturnType<typeof makeStream>,
  spentFor: PayloadOf<'RunSpent'>['for'],
  overrides: Partial<PayloadOf<'RunSpent'>> = {},
): Envelope {
  return event('RunSpent', {
    for: spentFor,
    runtime: 'claude-code',
    turns: 3,
    durationMs: 1000,
    usage: USAGE,
    costUsd: 0.1,
    ...overrides,
  })
}

const events: Envelope[] = []

// ---- Action and Judge, on one run stream after its RunStarted -------------
const runAction = aRun('run-pin-action')
events.push(aRunStarted(runAction, wi(1)))
const afterActionRunStarted = events.length
const actionSpent = aRunSpent(runAction.event, { _tag: 'Action', step: 'proposed', name: 'review', round: 0 })
events.push(actionSpent)
const judgeSpent = aRunSpent(runAction.event, { _tag: 'Judge', when: 'findings' })
events.push(judgeSpent)

// ---- Triage, on the work item's own stream — no link event needed ---------
const triageStream = makeStream(wi(2))
const triageSpent = aRunSpent(triageStream, { _tag: 'Triage', waitId: 'wait-1' as WaitId })
events.push(triageSpent)

// ---- Discussion, on chat-… after DiscussionRequested on ctl-conductor -----
const controlStream = makeStream(CONTROL_STREAM)
events.push(
  controlStream('DiscussionRequested', {
    chatId: 'chat-pin-1',
    workItemId: wi(4),
    attempt: null,
    question: 'why did this fail?',
    by: 'human:t',
  }),
)
const discussionStream = makeStream(chatStream('chat-pin-1'))
const discussionSpent = aRunSpent(discussionStream, { _tag: 'Discussion' })
events.push(discussionSpent)

// ---- A run stream with no RunStarted — kept, ticket and project null ------
const orphanSpent = aRunSpent(makeStream('run-pin-orphan'), { _tag: 'Action', step: 'build', name: 'build', round: 0 })
events.push(orphanSpent)

// ---- costUsd: null stays null, never becomes 0 -----------------------------
const nullCostSpent = aRunSpent(
  makeStream('run-pin-nullcost'),
  { _tag: 'Action', step: 'build', name: 'build', round: 0 },
  { costUsd: null },
)
events.push(nullCostSpent)

/**
 * `seq` is this table's primary key, so SQLite stores it as the rowid itself
 * and hands it back as a number rather than the text `translate` bound it
 * as — unlike `finding_backlog.raised_seq`, which is an ordinary bigint
 * column and keeps the text it was given.
 */
function rowFor(rows: readonly ProjectionRow[], seq: bigint): ProjectionRow | undefined {
  return rows.find((r) => BigInt(r.seq as number) === seq)
}

async function fold(evts: readonly Envelope[]): Promise<{ spend: ProjectionRow[]; links: ProjectionRow[] }> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => spendProjection.create(ctx))
    await store.transact((ctx) => spendProjection.apply(evts, ctx))
    return await store.transact(async (ctx) => ({
      spend: await ctx.query('select * from spend order by seq'),
      links: await ctx.query('select * from spend_stream order by stream_id'),
    }))
  } finally {
    db.close()
  }
}

async function foldInTwoBatches(mid: number): Promise<{ spend: ProjectionRow[]; links: ProjectionRow[] }> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => spendProjection.create(ctx))
    await store.transact((ctx) => spendProjection.apply(events.slice(0, mid), ctx))
    await store.transact((ctx) => spendProjection.apply(events.slice(mid), ctx))
    return await store.transact(async (ctx) => ({
      spend: await ctx.query('select * from spend order by seq'),
      links: await ctx.query('select * from spend_stream order by stream_id'),
    }))
  } finally {
    db.close()
  }
}

describe('spend folds one row per RunSpent, filling ticket through its own link table', () => {
  it('fills ticket and project for an Action spent on a run stream with a RunStarted', async () => {
    const { spend } = await fold(events)
    const row = rowFor(spend, actionSpent.seq)!
    expect(row).toMatchObject({
      stream_id: runAction.runId,
      ticket: wi(1),
      project: PROJECT,
      pass: runAction.runId,
      purpose: 'Action',
      step: 'proposed',
      action: 'review',
      round: 0,
      runtime: 'claude-code',
      turns: 3,
      duration_ms: 1000,
      cost_usd: 0.1,
    })
    expect(JSON.parse(row.spent_for as string)).toEqual({
      _tag: 'Action',
      step: 'proposed',
      name: 'review',
      round: 0,
    })
    expect(JSON.parse(row.usage as string)).toEqual(USAGE)
  })

  it('fills ticket for a Judge spent on the same run stream, with no step/action/round', async () => {
    const { spend } = await fold(events)
    const row = rowFor(spend, judgeSpent.seq)!
    expect(row).toMatchObject({
      ticket: wi(1),
      purpose: 'Judge',
      step: null,
      action: null,
      round: null,
    })
    expect(JSON.parse(row.spent_for as string)).toEqual({ _tag: 'Judge', when: 'findings' })
  })

  it('fills ticket for a Triage spent on the work item stream itself, with no link row needed', async () => {
    const { spend, links } = await fold(events)
    const row = rowFor(spend, triageSpent.seq)!
    expect(row).toMatchObject({ stream_id: wi(2), ticket: wi(2), project: PROJECT, pass: null, purpose: 'Triage' })
    expect(links.find((l) => l.stream_id === wi(2))).toBeUndefined()
  })

  it('fills ticket for a Discussion spent through DiscussionRequested on ctl-conductor', async () => {
    const { spend, links } = await fold(events)
    const row = rowFor(spend, discussionSpent.seq)!
    expect(row).toMatchObject({
      stream_id: chatStream('chat-pin-1'),
      ticket: wi(4),
      project: PROJECT,
      pass: null,
      purpose: 'Discussion',
    })
    expect(links.find((l) => l.stream_id === chatStream('chat-pin-1'))).toMatchObject({ ticket: wi(4) })
  })

  it('keeps a RunSpent row whose run stream has no RunStarted, with ticket and project null', async () => {
    const { spend } = await fold(events)
    const row = rowFor(spend, orphanSpent.seq)!
    expect(row).toMatchObject({ stream_id: 'run-pin-orphan', ticket: null, project: null, pass: 'run-pin-orphan' })
  })

  it('leaves cost_usd null rather than defaulting it to zero', async () => {
    const { spend } = await fold(events)
    const row = rowFor(spend, nullCostSpent.seq)!
    expect(row.cost_usd).toBeNull()
  })

  it('writes one row per RunSpent and no more', async () => {
    const { spend } = await fold(events)
    expect(spend).toHaveLength(6)
  })

  it('folds in two batches split around the first RunStarted the same as one batch', async () => {
    const whole = await fold(events)
    const split = await foldInTwoBatches(afterActionRunStarted)
    expect(split).toEqual(whole)
  })
})

describe('spend.ts reads RunSpent and no old spend source', () => {
  const SRC = fileURLToPath(new URL('../src/spend.ts', import.meta.url))
  const code = readFileSync(SRC, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it.each(['RunFinished', 'FixApplied', 'DiscussionAnswered', 'DiscussionHeld', 'TriageAgent'])(
    'never names %s',
    (type) => {
      expect(code).not.toContain(type)
    },
  )
})
