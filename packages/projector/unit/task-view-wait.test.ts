/**
 * `task_view` carries the current wait's `waitId` and `WaitReason` on the row
 * (#440) — `wait_id`/`wait_reason`, set by `WaitStarted` and cleared
 * when the wait is resolved, and read back through `waitOf` as `TaskCard.wait`.
 *
 * Separate from `task-view-rebuild.test.ts`, which is a pin against today's
 * rows and must not grow new behaviour (that file's own header). Runs on the
 * same `createSqliteProjectionStore(openSqliteProjections(':memory:'))` path.
 */
import type { Envelope } from '@lingtai/domain'
import { aClaim, aRelease, aResolution, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { WaitReason } from '@lingtai/domain/wait'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { ProjectionStore } from '../src/store.ts'
import type { TaskCard } from '../src/task-view.ts'
import { taskViewProjection, waitOf } from '../src/task-view.ts'

const SHA = 'a'.repeat(40)

async function withFold<T>(events: Envelope[], use: (store: ProjectionStore) => Promise<T>): Promise<T> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => taskViewProjection.create(ctx))
    await store.transact((ctx) => taskViewProjection.apply(events, ctx))
    return await use(store)
  } finally {
    db.close()
  }
}

async function rowOf(
  store: ProjectionStore,
  taskId: string,
): Promise<{
  task_id: string
  wait_id: string | null
  wait_reason: string | null
  note: string | null
  answer: string | null
  state: string
}> {
  const rows = await store.transact((ctx) =>
    ctx.query<{
      task_id: string
      wait_id: string | null
      wait_reason: string | null
      note: string | null
      answer: string | null
      state: string
    }>('select * from task_view where task_id = $1', [taskId]),
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`no task_view row for ${taskId}`)
  return row
}

async function cardOf(store: ProjectionStore): Promise<TaskCard> {
  const [card] = await store.tasks({ retentionDays: 999_999 })
  if (card === undefined) throw new Error('no card')
  return card
}

describe('a WaitStarted sets wait_id and wait_reason', () => {
  it('writes both, and toCard reads them back as `wait`', async () => {
    const stream = makeStream('ticket-wait-440-started')
    const waitId = aWaitId()
    const reason: WaitReason = { _tag: 'OwnQuestion', question: 'which base branch?', by: 'steven' }

    await withFold(aWait(stream, reason, waitId), async (store) => {
      const row = await rowOf(store, 'ticket-wait-440-started')
      expect(row.wait_id).toBe(waitId)
      expect(JSON.parse(row.wait_reason as string)).toEqual(reason)

      const card = await cardOf(store)
      expect(card.wait).toEqual({ waitId, reason })
    })
  })

  it('round-trips a reason whose run carries `unpushed`, losslessly', async () => {
    const stream = makeStream('ticket-wait-440-unpushed')
    const waitId = aWaitId()
    const reason: WaitReason = {
      _tag: 'AgentCrashed',
      run: { runId: 'pass-440', unpushed: { branch: 'agent/440', said: 'kept the commits, could not push' } },
      step: 'implement',
      cause: 'crash',
      detail: 'segfault',
    }

    await withFold(aWait(stream, reason, waitId), async (store) => {
      const card = await cardOf(store)
      expect(card.wait).toEqual({ waitId, reason })
    })
  })
})

describe('wait is null on every row that is not waiting', () => {
  it('is null on a freshly claimed, running task', async () => {
    const stream = makeStream('ticket-wait-440-running')
    await withFold([...aClaim(stream, 'pass-440-running')], async (store) => {
      const card = await cardOf(store)
      expect(card.state).toBe('running')
      expect(card.wait).toBeNull()
    })
  })
})

describe('every way `waiting` is cleared clears wait_id and wait_reason with it', () => {
  it('a WaitResolved{Approve}', async () => {
    const stream = makeStream('ticket-wait-440-approve')
    const run = 'pass-440-approve'
    const waitId = aWaitId()
    const events = [
      ...aClaim(stream, run),
      ...aWait(
        stream,
        { _tag: 'SignoffRequired', run: { runId: run }, step: 'merge', action: 'human', question: 'land it?' },
        waitId,
      ),
      ...aResolution(stream, waitId, { _tag: 'Approve', onSha: SHA }),
    ]
    await withFold(events, async (store) => {
      const row = await rowOf(store, 'ticket-wait-440-approve')
      expect(row.wait_id).toBeNull()
      expect(row.wait_reason).toBeNull()
      const card = await cardOf(store)
      expect(card.wait).toBeNull()
    })
  })

  it('a WaitResolved{Requeue}', async () => {
    const stream = makeStream('ticket-wait-440-requeue')
    const waitId = aWaitId()
    const events = [
      ...aWait(stream, { _tag: 'OwnQuestion', question: 'which registry?', by: 'steven' }, waitId),
      ...aResolution(stream, waitId, { _tag: 'Requeue' }),
    ]
    await withFold(events, async (store) => {
      const row = await rowOf(store, 'ticket-wait-440-requeue')
      expect(row.wait_id).toBeNull()
      expect(row.wait_reason).toBeNull()
    })
  })

  it('a TicketReleased', async () => {
    const stream = makeStream('ticket-wait-440-released')
    const run = 'pass-440-released'
    const waitId = aWaitId()
    const events = [
      ...aClaim(stream, run),
      ...aWait(stream, { _tag: 'FixerDisagrees', run: { runId: run }, said: 'looks fine to me' }, waitId),
      ...aRelease(stream, run, 'the pass did not finish'),
    ]
    await withFold(events, async (store) => {
      const row = await rowOf(store, 'ticket-wait-440-released')
      expect(row.wait_id).toBeNull()
      expect(row.wait_reason).toBeNull()
    })
  })

  it('a TicketClosed', async () => {
    const stream = makeStream('ticket-wait-440-closed')
    const waitId = aWaitId()
    const events = [
      ...aWait(stream, { _tag: 'OwnQuestion', question: 'still relevant?', by: 'steven' }, waitId),
      stream('TicketClosed', { by: 'steven', reason: 'no longer needed' }),
    ]
    await withFold(events, async (store) => {
      const row = await rowOf(store, 'ticket-wait-440-closed')
      expect(row.wait_id).toBeNull()
      expect(row.wait_reason).toBeNull()
    })
  })

  it('a TicketLanded', async () => {
    const stream = makeStream('ticket-wait-440-landed')
    const run = 'pass-440-landed'
    const waitId = aWaitId()
    const events = [
      ...aClaim(stream, run),
      ...aWait(
        stream,
        { _tag: 'SignoffRequired', run: { runId: run }, step: 'merge', action: 'human', question: 'land it?' },
        waitId,
      ),
      stream('TicketLanded', { mergeCommit: 'b'.repeat(40), base: 'main' }),
    ]
    await withFold(events, async (store) => {
      const row = await rowOf(store, 'ticket-wait-440-landed')
      expect(row.wait_id).toBeNull()
      expect(row.wait_reason).toBeNull()
    })
  })

  it('an IntegrationSucceeded', async () => {
    const stream = makeStream('ticket-wait-440-integrated')
    const integration = makeStream('integration-wait-440-integrated')
    const run = 'pass-440-integrated'
    const waitId = aWaitId()
    const events = [
      ...aClaim(stream, run),
      ...aWait(
        stream,
        { _tag: 'SignoffRequired', run: { runId: run }, step: 'merge', action: 'human', question: 'land it?' },
        waitId,
      ),
      integration('IntegrationSucceeded', {
        ticketId: 'ticket-wait-440-integrated',
        branch: 'agent/440',
        base: 'main',
        mergeCommit: 'c'.repeat(40),
      }),
    ]
    await withFold(events, async (store) => {
      const row = await rowOf(store, 'ticket-wait-440-integrated')
      expect(row.wait_id).toBeNull()
      expect(row.wait_reason).toBeNull()
    })
  })

  it('a fresh claim', async () => {
    const stream = makeStream('ticket-wait-440-reclaimed')
    const waitId = aWaitId()
    const events = [
      ...aWait(stream, { _tag: 'OwnQuestion', question: 'which registry?', by: 'steven' }, waitId),
      ...aClaim(stream, 'pass-440-reclaimed'),
    ]
    await withFold(events, async (store) => {
      const row = await rowOf(store, 'ticket-wait-440-reclaimed')
      expect(row.wait_id).toBeNull()
      expect(row.wait_reason).toBeNull()
    })
  })
})

it('a DispatchRefused on a standing wait leaves wait_reason and note exactly as they were', async () => {
  const stream = makeStream('ticket-wait-440-refused')
  const waitId = aWaitId()
  const events = [
    ...aWait(stream, { _tag: 'OwnQuestion', question: 'which registry?', by: 'steven' }, waitId),
    stream('DispatchRefused', { requiredTier: 'sandboxed', runtime: 'claude-code', missing: ['filesystem-sandbox'] }),
  ]
  await withFold(events, async (store) => {
    const row = await rowOf(store, 'ticket-wait-440-refused')
    expect(row.wait_id).toBe(waitId)
    expect(JSON.parse(row.wait_reason as string)).toEqual({
      _tag: 'OwnQuestion',
      question: 'which registry?',
      by: 'steven',
    })
    expect(row.note).toBe('which registry?')
    expect(row.state).toBe('waiting')
  })
})

it('Requeue of an OwnQuestion preserves the previous answer', async () => {
  const stream = makeStream('ticket-wait-522-answer')
  const answeredId = aWaitId()
  const withdrawnId = aWaitId()
  const events = [
    ...aWait(stream, { _tag: 'OwnQuestion', question: 'which base?', by: 'steven' }, answeredId),
    ...aResolution(stream, answeredId, { _tag: 'AnswerQuestion', choice: 'main' }),
    ...aWait(stream, { _tag: 'OwnQuestion', question: 'still needed?', by: 'steven' }, withdrawnId),
    ...aResolution(stream, withdrawnId, { _tag: 'Requeue' }),
  ]
  await withFold(events, async (store) => {
    const row = await rowOf(store, 'ticket-wait-522-answer')
    expect(JSON.parse(row.answer as string)).toMatchObject({ question: 'which base?', answer: 'main' })
  })
})

describe('waitOf', () => {
  it('is null for every state but waiting', () => {
    expect(waitOf('ticket-x', 'queued', 'wait-1', { _tag: 'OwnQuestion', question: 'q', by: 'steven' })).toBeNull()
  })

  it('throws, naming the task id, when a waiting row carries no reason', () => {
    expect(() => waitOf('ticket-wait-440-corrupt', 'waiting', 'wait-1', null)).toThrow(/ticket-wait-440-corrupt/)
  })

  it('throws, naming the task id, when the stored reason does not parse', () => {
    expect(() => waitOf('ticket-wait-440-garbled', 'waiting', 'wait-1', { _tag: 'NoSuchReason' })).toThrow(
      /ticket-wait-440-garbled/,
    )
  })
})
