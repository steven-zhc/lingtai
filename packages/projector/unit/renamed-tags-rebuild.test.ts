/**
 * #1241 / #1242 / 0108: a log written under the names 0108 retired and the same log written under the new ones rebuild
 * every projection to identical rows. The old log is made from the new one by writing each name back — and is then
 * read the way the store reads it, through the upcaster of the version it claims to be at.
 *
 * Runs on `createSqliteProjectionStore(openSqliteProjections(':memory:'))`, so it is unit under 0060 §1.
 */
import { type Envelope, type EventType, parseStoredPayload } from '@lingtai/domain'
import type { JudgeReply, RouteDecision, RouteOffer } from '@lingtai/domain'
import { aClaim, aRelease, aResolution, aRoute, aWait, anAttempt } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { backlogProjection } from '../src/backlog.ts'
import type { Projection } from '../src/projection.ts'
import { spendProjection } from '../src/spend.ts'
import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import { createFace, reduceFace } from '../src/store-face.ts'
import { taskViewProjection } from '../src/task-view.ts'
import { ticketReportProjection } from '../src/ticket-report.ts'

const selected = (candidate: string): { reply: JudgeReply; decision: RouteDecision } => ({
  reply: { _tag: 'Selected', candidate, why: 'because' },
  decision: { _tag: 'Selected', candidate },
})

const proposal: RouteOffer['proposal'] = { _tag: 'ReviewFindings', findings: [] }

/** The log as it is written today: a fix round, a restart that spent its rounds, an escalation on a ceiling, a redo. */
function newLog(): Envelope[] {
  const out: Envelope[] = []

  const item = makeStream('ticket-renamed-1')
  const run = anAttempt('pass-renamed-1')
  out.push(...aClaim(item, run.runId))
  const fixOffer: RouteOffer = {
    proposal,
    available: [
      { id: 'fix-lines', next: { _tag: 'FixRefusal', to: 'implement', round: 1 } },
      { id: 'merge-base', next: { _tag: 'MergeBaseBranch', toSha: 'b'.repeat(40), merge: 1 } },
      { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
    ],
    unavailable: [{ id: 'restart', because: { _tag: 'CeilingReached', ceiling: 'newAttempts' } }],
  }
  out.push(...aRoute(run, { offer: fixOffer, ...selected('fix-lines') }))
  out.push(
    run.event('StepRedone', { runId: run.runId, step: 'implement', rerun: 1, said: 'API Error: 503', waitMs: 60_000 }),
  )

  const second = makeStream('ticket-renamed-2')
  const secondRun = anAttempt('pass-renamed-2')
  out.push(...aClaim(second, secondRun.runId))
  const restartOffer: RouteOffer = {
    proposal,
    available: [{ id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'NewAttempt', newAttempt: 1 } } }],
    unavailable: [
      { id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'refusalFixes' } },
      { id: 'merge-base', because: { _tag: 'CeilingReached', ceiling: 'baseBranchMerges' } },
    ],
  }
  out.push(...aRoute(secondRun, { offer: restartOffer, ...selected('restart') }, second))

  const third = makeStream('ticket-renamed-3')
  const thirdRun = anAttempt('pass-renamed-3')
  out.push(...aClaim(third, thirdRun.runId))
  out.push(
    thirdRun.event('ProposalRouted', {
      runId: thirdRun.runId,
      offer: {
        proposal,
        available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
        unavailable: [{ id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'conflictResolutions' } }],
        ended: null,
      },
      reply: { _tag: 'NotAsked' },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'CandidateUnavailable',
          excluded: { id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'conflictResolutions' } },
        },
      },
    }),
  )
  out.push(...aRelease(third, thirdRun.runId, 'restart', { _tag: 'NewAttempt', newAttempt: 2 }))

  // #1242: one wait resolved by each of a person's four moves, and a release `NewAttempt` that counts.
  const fourth = makeStream('ticket-renamed-4')
  const fourthRun = anAttempt('pass-renamed-4')
  out.push(...aClaim(fourth, fourthRun.runId))
  const check = (n: number) =>
    ({ _tag: 'CheckRefused', run: { runId: fourthRun.runId }, step: 'proposed', action: 'test', evidence: `red ${n}`, findings: [] }) as const
  const waits = ['wait-moves-1', 'wait-moves-2', 'wait-moves-3', 'wait-moves-4'] as never[]
  out.push(...aWait(fourth, check(1), waits[0]))
  out.push(...aResolution(fourth, waits[0], { _tag: 'FixRefusal', onSha: 'a'.repeat(40), ref: 'refs/lingtai/1242' }))
  out.push(fourth('TicketContinued', { runId: fourthRun.runId, worker: 'conductor:1' }))
  out.push(...aWait(fourth, check(2), waits[1]))
  out.push(...aResolution(fourth, waits[1], { _tag: 'RedoStep', onSha: 'a'.repeat(40), ref: null }))
  out.push(fourth('TicketContinued', { runId: fourthRun.runId, worker: 'conductor:1' }))
  out.push(...aWait(fourth, check(3), waits[2]))
  out.push(...aResolution(fourth, waits[2], { _tag: 'EditBodyAndStartNewAttempt' }))
  out.push(...aRelease(fourth, fourthRun.runId, 'new attempt', { _tag: 'NewAttempt', newAttempt: 1 }))
  out.push(...aClaim(fourth, 'pass-renamed-4b'))
  out.push(...aWait(fourth, { ...check(4), run: { runId: 'pass-renamed-4b' } }, waits[3]))
  out.push(...aResolution(fourth, waits[3], { _tag: 'StartNewAttempt' }))
  return out
}

const CEILINGS_BACK: Record<string, string> = {
  refusalFixes: 'rounds',
  conflictResolutions: 'conflict-rounds',
  newAttempts: 'restarts',
  baseBranchMerges: 'base-merges',
}

/** Writes every renamed name back, at any depth: what a row from before the rename holds. */
function unrename(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unrename)
  if (typeof value !== 'object' || value === null) return value
  const o = value as Record<string, unknown>
  if (o._tag === 'NewAttempt' && 'newAttempt' in o) {
    const { newAttempt, ...rest } = o
    return { ...rest, _tag: 'Restart', restart: newAttempt }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === '_tag' && v === 'FixRefusal') out[k] = 'FixRound'
    else if (k === '_tag' && v === 'MergeBaseBranch') out[k] = 'MergeBase'
    else if (k === 'ceiling' && typeof v === 'string') out[k] = CEILINGS_BACK[v] ?? v
    else out[k] = unrename(v)
  }
  return out
}

const OLD_VERSION_TYPES: ReadonlySet<string> = new Set([
  'PassRouted',
  'ProposalRouted',
  'TicketReleased',
  'WaitStarted',
])

/** A person's moves under the names they had before #1242. */
const MOVES_BACK: Record<string, string> = {
  FixRefusal: 'GrantFixRound',
  RedoStep: 'RerunStep',
  StartNewAttempt: 'Requeue',
  EditBodyAndStartNewAttempt: 'EditBodyAndRequeue',
}

/** The same log as an old store would have held it, read back as today's store reads it. */
function oldLog(events: readonly Envelope[]): Envelope[] {
  return events.map((e) => {
    if (e.type === 'WaitResolved') {
      const data = e.data as { resolution: { _tag: string } }
      const stored = { ...data, resolution: { ...data.resolution, _tag: MOVES_BACK[data.resolution._tag] ?? data.resolution._tag } }
      return { ...e, data: parseStoredPayload('WaitResolved', 1, stored) } as Envelope
    }
    const type = (e.type === 'StepRedone' ? 'StepRerunInPlace' : e.type) as EventType
    if (!OLD_VERSION_TYPES.has(e.type) && e.type !== 'StepRedone') return e
    const stored = unrename(e.data)
    const read = OLD_VERSION_TYPES.has(e.type) ? parseStoredPayload(type, 1, stored) : stored
    return { ...e, type, data: read } as Envelope
  })
}

async function rebuild(projection: Projection, events: readonly Envelope[]): Promise<Record<string, unknown[]>> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => createFace(projection, ctx))
    await store.transact((ctx) => reduceFace(projection, events, ctx))
    return await store.transact(async (ctx) => {
      const tables = (await ctx.query(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != 'checkpoints' order by name",
      )) as { name: string }[]
      const dump: Record<string, unknown[]> = {}
      for (const { name } of tables) dump[name] = await ctx.query(`select * from ${name} order by rowid`)
      return dump
    })
  } finally {
    db.close()
  }
}

describe('a log written under the retired names rebuilds as the same log under the new ones', () => {
  const now = newLog()
  const before = oldLog(now)

  it('holds each of the four moves a person has, and a release that spent a new attempt', () => {
    const tags = now.filter((e) => e.type === 'WaitResolved').map((e) => (e.data as { resolution: { _tag: string } }).resolution._tag)
    expect(tags).toEqual(['FixRefusal', 'RedoStep', 'EditBodyAndStartNewAttempt', 'StartNewAttempt'])
    expect(now.filter((e) => e.type === 'TicketReleased' && JSON.stringify(e.data).includes('"NewAttempt"')).length).toBeGreaterThan(0)
  })

  it('is a different log, on the retired names', () => {
    const text = JSON.stringify(before, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(text).toContain('StepRerunInPlace')
    expect(JSON.stringify(now, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('StepRerunInPlace')
  })

  it.each([
    ['task_view', taskViewProjection],
    ['ticket_report', ticketReportProjection],
    ['spend', spendProjection],
    ['finding_backlog', backlogProjection],
  ] as const)('%s gives identical rows', async (_name, projection) => {
    const a = await rebuild(projection, now)
    const b = await rebuild(projection, before)
    expect(b).toEqual(a)
    // `finding_backlog` holds the minors a gate raised, and this log raises none: it proves the fourth gives the
    // same answer, which here is the same empty one.
    if (_name !== 'finding_backlog') expect(Object.values(a).some((rows) => rows.length > 0)).toBe(true)
  })
})
