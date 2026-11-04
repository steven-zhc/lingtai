/**
 * `task_view`'s `note` is the sentence of the latest transition of either stored state (#845): the
 * reduces' before and after decide it, and no event type does. Each row of the issue's table has a test
 * here, over real events reduced one at a time, and the scenarios read the stored row after every event.
 */
import type { Envelope, RunState, TicketLifecycle, TicketState } from '@lingtai/domain'
import {
  agentBranchOf,
  reduceRunEvent,
  reduceTicketEvent,
  emptyRun,
  emptyTicket,
  parseTicketStream,
  ticketStream,
  waitWords,
} from '@lingtai/domain'
import {
  aClaim,
  aLanding,
  aRelease,
  aResolution,
  aRun,
  aRunFailure,
  aWait,
  aWaitId,
  anIntegrationRefusal,
} from '@lingtai/domain/test/events'
import { lateScenarios, scenarios } from '@lingtai/domain/test/histories'
import type { Scenario } from '@lingtai/domain/test/histories'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import { runNoteOf, taskViewProjection, ticketNoteOf } from '../src/task-view.ts'

const TICKET = ticketStream('proj', 4501)
const branch = agentBranchOf('4501')

/** The ticket note at each event, reduced from `emptyTicket`. */
function ticketNotes(events: readonly Envelope[]) {
  let state: TicketState = emptyTicket
  return events.map((e) => {
    const before = state
    state = reduceTicketEvent(before, e)
    return ticketNoteOf(before, state)
  })
}

function runNotes(events: readonly Envelope[]) {
  let state: RunState = emptyRun
  return events.map((e) => {
    const before = state
    state = reduceRunEvent(before, e)
    return runNoteOf(before, state)
  })
}

const mergeBySeq = (s: Scenario): Envelope[] =>
  [...s.ticket, ...s.runs.flat(), ...(s.integration ?? [])].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))

async function withStore<T>(
  fn: (run: (batch: readonly Envelope[]) => Promise<void>, row: () => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => taskViewProjection.create(ctx))
    return await store.transact(async (ctx) =>
      fn(
        (batch) => taskViewProjection.reduce(batch, ctx),
        () => ctx.query('select * from task_view order by task_id'),
      ),
    )
  } finally {
    db.close()
  }
}

/** The stored note after each event of the merged scenario. */
async function notesAfterEach(events: readonly Envelope[]): Promise<(string | null | undefined)[]> {
  return withStore(async (run, rows) => {
    const out: (string | null | undefined)[] = []
    for (const e of events) {
      await run([e])
      out.push((await rows())[0]?.note as string | null | undefined)
    }
    return out
  })
}

describe('ticketNoteOf: the transitions', () => {
  const t = makeStream(TICKET)
  const run = aRun('pass-a')
  const ask = aWaitId()
  const question = {
    _tag: 'AgentQuestion' as const,
    run: { runId: run.runId },
    step: 'implement' as const,
    question: 'which?',
  }

  it('lifecycle → blocked is the wait line', () => {
    const notes = ticketNotes([...aClaim(t, run.runId), ...aWait(t, question, ask)])
    expect(notes[1]).toEqual({ value: waitWords(question, { branch, base: '', findings: [] }).line })
  })

  it('→ claimed clears the note', () => {
    expect(ticketNotes(aClaim(t, run.runId))).toEqual([{ value: null }])
  })

  it('a release gives its reason, and a requeue pair ends on it', () => {
    const notes = ticketNotes([
      ...aClaim(t, run.runId),
      ...aWait(t, question, ask),
      ...aResolution(t, ask, { _tag: 'Requeue' }),
      ...aRelease(t, run.runId, 'Requeued by steven.', { _tag: 'ByPerson', waitId: ask }),
    ])
    expect(notes[2]).toEqual({ value: null })
    expect(notes[3]).toEqual({ value: 'Requeued by steven.' })
  })

  it('→ landed is the merge commit', () => {
    const notes = ticketNotes([...aClaim(t, run.runId), ...aLanding(t, 'abc123')])
    expect(notes[1]).toEqual({ value: 'abc123' })
  })

  it('→ closed is its reason', () => {
    const notes = ticketNotes([
      ...aClaim(t, run.runId),
      ...aRelease(t, run.runId, 'x'),
      t('TicketClosed', { by: 'steven', reason: 'not wanted' } as never),
    ])
    expect(notes[2]).toEqual({ value: 'not wanted' })
  })

  it('→ approved is the approval sentence; a grant is the grant sentence', () => {
    const signoff = {
      _tag: 'SignoffRequired' as const,
      run: { runId: run.runId },
      step: 'merge' as const,
      action: 'human',
      question: 'ok?',
    }
    const notes = ticketNotes([
      ...aClaim(t, run.runId),
      ...aWait(t, signoff, ask),
      ...aResolution(t, ask, { _tag: 'Approve', onSha: 'sha-1' }),
    ])
    expect(notes[2]).toEqual({ value: 'approved — continues once a conductor is free' })
  })

  it('a new wait on a waiting ticket writes its line', () => {
    const second = aWaitId()
    const other = { ...question, question: 'and then?' }
    const notes = ticketNotes([...aClaim(t, run.runId), ...aWait(t, question, ask), ...aWait(t, other, second)])
    expect(notes[2]).toEqual({ value: waitWords(other, { branch, base: '', findings: [] }).line })
  })

  it('a dispatch refusal on a ticket that is not blocked is the needs line', () => {
    const notes = ticketNotes([
      t('DispatchRefused', { requiredTier: 'sandboxed', runtime: 'claude-code', missing: ['a', 'b'] } as never),
    ])
    expect(notes[0]).toEqual({ value: 'needs sandboxed; claude-code is missing a, b' })
  })
})

describe('runNoteOf: the transitions', () => {
  const run = aRun('pass-b')

  it('→ awaiting-input is the prompt, and a second prompt replaces the first', () => {
    const notes = runNotes([
      run.event('RunAwaitingInput', { prompt: 'first?' }),
      run.event('RunAwaitingInput', { prompt: 'second?' }),
    ])
    expect(notes).toEqual(['first?', 'second?'])
  })

  it('a failure is kind: detail', () => {
    expect(runNotes(aRunFailure(run, 'crash', 'boom'))).toEqual(['crash: boom'])
  })

  it('a round opened reads fixing round n', () => {
    const events = lateScenarios.fixRoundAfterCompletion.runs.flat()
    const notes = runNotes(events).filter((n): n is string => n !== null)
    expect(notes.some((n) => /^fixing round \d+/.test(n))).toBe(true)
  })

  it('every run status is a sentence or writes nothing', () => {
    const quiet: RunState['lifecycle'][] = [
      { status: 'pending' },
      { status: 'running' },
      { status: 'gating', headSha: 's' },
      { status: 'finished', exitCode: 0, turns: 1, durationMs: 1 },
    ]
    for (const lifecycle of quiet) expect(runNoteOf(emptyRun, { ...emptyRun, lifecycle: { ...lifecycle } })).toBeNull()
  })
})

describe('every ticket status is in the table or writes nothing', () => {
  it('names a note for each non-blocked status', () => {
    const lifecycles: TicketLifecycle[] = [
      { status: 'backlog' },
      { status: 'claimed', runId: 'r', worker: 'w' },
      { status: 'landed', mergeCommit: 'c', base: 'main' },
      { status: 'closed', by: 'p', reason: 'because' },
      { status: 'approved', runId: 'r', waitId: aWaitId(), onSha: 's' },
    ]
    const from: TicketState = { ...emptyTicket, lifecycle: { status: 'claimed', runId: 'x', worker: 'w' } }
    for (const lifecycle of lifecycles) {
      if (lifecycle.status === 'claimed') continue
      expect(ticketNoteOf(from, { ...from, lifecycle })).not.toBeNull()
    }
    expect(ticketNoteOf(emptyTicket, { ...emptyTicket, lifecycle: lifecycles[1]! })).toEqual({ value: null })
  })
})

describe('the stored note', () => {
  it('the note is the last transition', async () => {
    const s = scenarios.answerAfterRunNote
    const events = mergeBySeq(s)
    const notes = await notesAfterEach(events)
    const waitAt = events.findIndex((e) => e.type === 'WaitStarted')
    const promptAt = events.findIndex((e) => e.type === 'RunAwaitingInput')
    const resolvedAt = events.findIndex((e) => e.type === 'WaitResolved')
    const reason = (events[waitAt]!.data as { reason: never }).reason
    const id = parseTicketStream(events[waitAt]!.streamId)!
    expect(notes[waitAt]).toBe(waitWords(reason, { branch: agentBranchOf(id.issue), base: '', findings: [] }).line)
    expect(notes[promptAt]).toBe('which of the two, really?')
    expect(notes[resolvedAt]).toBeNull()
  })

  it("a person's requeue reads its release line", async () => {
    const notes = await notesAfterEach(mergeBySeq(lateScenarios.requeueOfRunWait))
    expect(notes.at(-1)).toBe('Requeued by steven.')
  })

  it("a refusal at the lane leaves the wait's line", async () => {
    const events = mergeBySeq(lateScenarios.staleSignoff)
    const notes = await notesAfterEach(events)
    const last = events.findLast((e) => e.type === 'WaitStarted')!
    const reason = (last.data as { reason: never }).reason
    const id = parseTicketStream(last.streamId)!
    expect(notes.at(-1)).toBe(waitWords(reason, { branch: agentBranchOf(id.issue), base: '', findings: [] }).line)
  })

  it('an Integration* event changes no task_view row', async () => {
    const s = scenarios.integratedWithoutLanding
    const base = [...s.ticket, ...s.runs.flat()].sort((a, b) => (a.seq < b.seq ? -1 : 1))
    const integration = s.integration ?? []
    expect(integration.length).toBeGreaterThan(0)
    await withStore(async (run, rows) => {
      await run(base)
      const before = JSON.stringify(await rows())
      await run(integration)
      expect(JSON.stringify(await rows())).toBe(before)
      const i = makeStream(integration[0]!.streamId)
      const ticketId = s.ticket[0]!.streamId
      await run(
        anIntegrationRefusal(i, ticketId, 'b', { reason: 'dirty-base', detail: 'x' }).map(
          (e) => ({ ...e, seq: 10n ** 9n }) as Envelope,
        ),
      )
      expect(JSON.stringify(await rows())).toBe(before)
    })
  })

  it('incremental equals rebuild over scenarios, in batches of 1, 3 and all', async () => {
    for (const s of [...Object.values(scenarios), ...Object.values(lateScenarios)]) {
      const events = mergeBySeq(s)
      const results: string[] = []
      for (const batch of [1, 3, events.length]) {
        results.push(
          await withStore(async (run, rows) => {
            for (let i = 0; i < events.length; i += batch) await run(events.slice(i, i + batch))
            return JSON.stringify(await rows())
          }),
        )
      }
      expect(results[1]).toBe(results[0])
      expect(results[2]).toBe(results[0])
    }
  })
})
