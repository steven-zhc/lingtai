/**
 * #1258: `finishTriage` binds an answer to the version `TriageStarted` left. Only the triage's own run facts may sit
 * after it; a person's resolution or any other event refuses the answer, and the refusal is recorded as a failure that
 * resolves nothing. An answer the system can act on resolves its wait in the same append.
 */
import type { WaitId } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { finishTriage, recordTriageRun, startTriage } from '../src/ticket/commands.ts'

const ticketId = 'ticket-lingtai-7'
const waitId = '99999999-9999-4999-8999-999999999999' as WaitId
const by = { _tag: 'Mechanical' } as const
const crashed = { _tag: 'AgentCrashed', run: { runId: 'run-1' }, step: 'implement', cause: 'crash', detail: 'x' }
const unfinished = {
  _tag: 'TriageAnswered',
  cause: { _tag: 'Unfinished', addToBody: null },
  summary: 'ran out before it finished',
  want: null,
} as const
const room = (stepRedosUsed = 0) => ({
  refusalFixes: { used: 0, allowed: 3 },
  newAttempts: { used: 0, allowed: 2 },
  ticketSplits: { used: 0, allowed: 1 },
  stepRedos: { used: stepRedosUsed, allowed: 3 },
  conflictResolutions: { used: 0, allowed: 5 },
  personAsks: { used: 0, allowed: 5 },
})
const act = () =>
  Effect.succeed({
    origin: 'other' as const,
    counters: room(),
    boundHead: 'abc',
    headNow: 'abc',
    fix: null,
    redo: { onSha: 'abc', ref: 'agent/7' },
  })

const started = async () => {
  const store = createMemoryEventStore()
  await store.append(ticketId, 0, [
    { type: 'TicketClaimed', actor: 'conductor', data: { runId: 'run-1', worker: 'host:1', title: 't', kind: 'bug', body: 'b' } },
    { type: 'WaitStarted', actor: 'conductor', data: { waitId, reason: crashed } },
  ])
  const begun = await Effect.runPromise(startTriage(ticketId, { store, waitId, attempt: 1, by }))
  if (!begun.ok) throw new Error('did not start')
  return { store, v0: begun.version }
}
const finish = (
  s: Awaited<ReturnType<typeof started>>,
  over: Partial<Parameters<typeof finishTriage>[1]> = {},
) =>
  Effect.runPromise(
    finishTriage(ticketId, { store: s.store, ifVersion: s.v0, waitId, attempt: 1, headSha: 'abc', by, result: unfinished, ...over }),
  )
const types = async (s: Awaited<ReturnType<typeof started>>) => (await s.store.read(ticketId)).map((e) => e.type)
const own = async (s: Awaited<ReturnType<typeof started>>) => {
  await Effect.runPromise(
    recordTriageRun(ticketId, { store: s.store, waitId, record: { _tag: 'Prompted', promptVersion: 'v', runtimeVersion: null, prompt: 'p' } }),
  )
  await Effect.runPromise(
    recordTriageRun(ticketId, {
      store: s.store,
      waitId,
      record: { _tag: 'Spent', runtime: 'claude-code', outcome: { turns: 1, durationMs: 1, costUsd: 0.1 } },
    }),
  )
}

describe('finishTriage (#1258)', () => {
  it("the triage's own RunPrompted and RunSpent between TriageStarted and the answer are not a change", async () => {
    const s = await started()
    await own(s)
    expect(await finish(s)).toEqual({ ok: true, resolved: null })
    expect(await types(s)).toEqual([
      'TicketClaimed',
      'WaitStarted',
      'TriageStarted',
      'RunPrompted',
      'RunSpent',
      'WaitTriaged',
    ])
  })

  it('an answer the system can act on resolves its wait by: triage in the same append, and that is the spend', async () => {
    const s = await started()
    await own(s)
    const done = await finish(s, { act })
    expect(done).toMatchObject({ ok: true, resolved: { resolution: { _tag: 'RedoStep' }, runId: 'run-1' } })
    const events = await s.store.read(ticketId)
    expect(events.slice(-2).map((e) => e.type)).toEqual(['WaitTriaged', 'WaitResolved'])
    expect(events.at(-1)!.data).toMatchObject({ by: 'triage', spent: { bound: 'stepRedos', n: 1 } })
  })

  it('with the bound spent only WaitTriaged is recorded and the wait stays', async () => {
    const s = await started()
    const done = await finish(s, { act: () => Effect.map(act(), (c) => ({ ...c, counters: room(3) })) })
    expect(done).toEqual({ ok: true, resolved: null })
    expect(await types(s)).toEqual(['TicketClaimed', 'WaitStarted', 'TriageStarted', 'WaitTriaged'])
  })

  it("a person's WaitResolved before the answer: the answer is recorded failed, nothing resolves twice", async () => {
    const s = await started()
    await s.store.append(ticketId, s.v0, [
      {
        type: 'WaitResolved',
        actor: 'human:steven',
        data: { waitId, by: 'human:steven', resolution: { _tag: 'StartNewAttempt' }, note: '' },
      },
    ])
    expect(await finish(s, { act })).toEqual({ ok: false, refusal: 'wait-not-current' })
    const events = await s.store.read(ticketId)
    expect(events.filter((e) => e.type === 'WaitResolved')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'WaitTriaged', data: { result: { _tag: 'TriageFailed' } } })
  })

  it('an unrelated event after TriageStarted: the answer is recorded TriageFailed{changed}', async () => {
    const s = await started()
    await s.store.append(ticketId, s.v0, [
      { type: 'RunSpent', actor: 'conductor', data: { for: { _tag: 'Triage', waitId: 'someone-else' }, runtime: 'claude-code', turns: 1, durationMs: 1, usage: [], costUsd: null } },
    ])
    expect(await finish(s, { act })).toEqual({ ok: false, refusal: 'changed' })
    const last = (await s.store.read(ticketId)).at(-1)!
    expect(last).toMatchObject({ type: 'WaitTriaged', data: { result: { _tag: 'TriageFailed', why: 'changed' } } })
  })

  it('a head that moved acts on nothing and is recorded failed', async () => {
    const s = await started()
    expect(await finish(s, { act: () => Effect.map(act(), (c) => ({ ...c, headNow: 'def' })) })).toEqual({
      ok: false,
      refusal: 'head-moved',
    })
    expect((await s.store.read(ticketId)).at(-1)).toMatchObject({
      data: { result: { _tag: 'TriageFailed', why: 'head-moved' } },
    })
  })

  it('a read that fails is never taken as unchanged: the answer acts on nothing', async () => {
    const s = await started()
    expect(await finish(s, { act: () => Effect.fail(new Error('store down')) })).toEqual({
      ok: false,
      refusal: 'unreadable',
    })
    expect(await types(s)).not.toContain('WaitResolved')
  })
})
