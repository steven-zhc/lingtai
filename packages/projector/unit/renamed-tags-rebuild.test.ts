/**
 * #1241 / 0108: a log written under the names 0108 retired and the same log written under the new ones rebuild
 * every projection to identical rows. The old log is made from the new one by writing each name back — and is then
 * read the way the store reads it, through the upcaster of the version it claims to be at.
 *
 * Runs on `createSqliteProjectionStore(openSqliteProjections(':memory:'))`, so it is unit under 0060 §1.
 */
import { type Envelope, type EventType, parseStoredPayload } from '@lingtai/domain'
import type { JudgeReply, RouteDecision, RouteOffer } from '@lingtai/domain'
import { aClaim, aRelease, aResolution, aRoute, aWait, aWaitId, anAttempt } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { Resolution } from '@lingtai/domain/wait'
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

  // #1267: a person answers four waits, once with each of the moves whose tag was renamed.
  const resolutions: Resolution[] = [
    { _tag: 'FixRefusal', onSha: 'a'.repeat(40), ref: 'agent/9' },
    { _tag: 'RedoStep', onSha: 'b'.repeat(40), ref: null },
    { _tag: 'StartNewAttempt' },
    { _tag: 'EditBodyAndStartNewAttempt' },
  ]
  resolutions.forEach((resolution, i) => {
    const t = makeStream(`ticket-renamed-wait-${i}`)
    const r = anAttempt(`pass-renamed-wait-${i}`)
    const waitId = aWaitId()
    out.push(...aClaim(t, r.runId))
    out.push(
      ...aWait(
        t,
        { _tag: 'SignoffRequired', run: { runId: r.runId }, step: 'merge', action: 'human', question: 'land it?' },
        waitId,
      ),
    )
    out.push(...aResolution(t, waitId, resolution))
  })
  return out
}

/** What a `WaitResolved` held before the rename: the four tags, written back. */
const RESOLUTIONS_BACK: Record<string, string> = {
  FixRefusal: 'GrantFixRound',
  RedoStep: 'RerunStep',
  StartNewAttempt: 'Requeue',
  EditBodyAndStartNewAttempt: 'EditBodyAndRequeue',
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
  'WaitResolved',
])

function withOldResolution(data: { resolution: { _tag: string } }): unknown {
  const { _tag } = data.resolution
  return { ...data, resolution: { ...data.resolution, _tag: RESOLUTIONS_BACK[_tag] ?? _tag } }
}

/** The same log as an old store would have held it, read back as today's store reads it. */
function oldLog(events: readonly Envelope[]): Envelope[] {
  return events.map((e) => {
    const type = (e.type === 'StepRedone' ? 'StepRerunInPlace' : e.type) as EventType
    if (!OLD_VERSION_TYPES.has(e.type) && e.type !== 'StepRedone') return e
    const stored =
      e.type === 'WaitResolved' ? withOldResolution(e.data as { resolution: { _tag: string } }) : unrename(e.data)
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

  it('is a different log, on the retired names', () => {
    const text = JSON.stringify(before, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(text).toContain('StepRerunInPlace')
    expect(JSON.stringify(now, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('StepRerunInPlace')
  })

  it('holds every renamed resolution, which an old WaitResolved read at version 1 gives back as the new tag', () => {
    const tags = (log: readonly Envelope[]) =>
      log
        .filter((e) => e.type === 'WaitResolved')
        .map((e) => (e.data as { resolution: { _tag: string } }).resolution._tag)
    expect(tags(now)).toEqual(['FixRefusal', 'RedoStep', 'StartNewAttempt', 'EditBodyAndStartNewAttempt'])
    expect(tags(before)).toEqual(tags(now))
    expect(
      parseStoredPayload(
        'WaitResolved',
        1,
        withOldResolution(now.find((e) => e.type === 'WaitResolved')!.data as never),
      ),
    ).toEqual(now.find((e) => e.type === 'WaitResolved')!.data)
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
