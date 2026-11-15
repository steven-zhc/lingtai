/**
 * The project's commands (0128 §7, #1174), on the memory store. A race is made by a store that appends a competing
 * event at the version the command read, then forwards the command's own append — which meets `ConcurrencyError`.
 */
import { projectStream, reduceProject } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { type EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  observeSandbox,
  otherOwner,
  pauseProject,
  recordTurn,
  registerProject,
  resumeProject,
} from '../src/commands.ts'

const stream = projectStream('lingtai')
const data = (owner: string | null) => ({ project: 'lingtai', owner, base: 'main', configHash: 'h', fromSha: 's' })

async function configured(owner: string | null = 'o') {
  const store = createMemoryEventStore()
  await store.append(stream, 0, [{ type: 'ProjectConfigured', actor: 'conductor', data: data(owner) }])
  return store
}

/** A store whose first append is preceded by `competing`, appended at the version the command meant to use. */
function racing(real: EventStore, competing: Parameters<EventStore['append']>[2]): EventStore {
  let raced = false
  return {
    ...real,
    append: async (...args: Parameters<EventStore['append']>) => {
      if (!raced) {
        raced = true
        await real.append(args[0], args[1], competing)
      }
      return real.append(...args)
    },
  } as EventStore
}

const run = <A>(e: Effect.Effect<A, Error>) => Effect.runPromise(e)

describe('pauseProject and resumeProject', () => {
  it('pausing twice appends one event and answers already with the first since', async () => {
    const store = await configured()
    expect(await run(pauseProject('lingtai', 'human:a', store))).toEqual({ kind: 'appended' })
    expect(await run(pauseProject('lingtai', 'human:b', store))).toMatchObject({ kind: 'already', by: 'human:a' })
    expect((await store.read(stream)).map((e) => e.type)).toEqual(['ProjectConfigured', 'ProjectPaused'])
  })

  it('resuming an unpaused project appends nothing', async () => {
    const store = await configured()
    expect(await run(resumeProject('lingtai', 'human:a', store))).toEqual({ kind: 'not-paused' })
    expect(await store.head(stream)).toBe(1)
  })

  it('re-reads once on a lost race', async () => {
    const real = await configured()
    const store = racing(real, [
      { type: 'ProjectPaused', actor: 'human:x', data: { project: 'lingtai', by: 'human:x' } },
    ])
    expect(await run(pauseProject('lingtai', 'human:a', store))).toMatchObject({ kind: 'already', by: 'human:x' })
    expect(await real.head(stream)).toBe(2)
  })
})

describe('recordTurn', () => {
  const refused = { refused: true, detail: 'nope', ref: null, codeSha: null } as const
  it('a lost race to the same refusal re-reads and appends nothing more', async () => {
    const real = await configured()
    const first = createMemoryEventStore()
    await first.append(stream, 0, [{ type: 'ProjectConfigured', actor: 'conductor', data: data('o') }])
    await run(recordTurn('lingtai', refused, first))
    const recorded = (await first.read(stream)).filter((e) => e.type === 'ProjectRefused')
    expect(recorded.length).toBe(1)
    const refusal = recorded[0]!
    const store = racing(real, [{ type: 'ProjectRefused', actor: 'conductor', data: refusal.data } as never])
    await run(recordTurn('lingtai', refused, store))
    expect((await real.read(stream)).filter((e) => e.type === 'ProjectRefused').length).toBe(1)
  })
})

describe('registerProject', () => {
  it('registers and reports the stream as it stood', async () => {
    const store = createMemoryEventStore()
    await store.append(stream, 0, [
      { type: 'ProjectPaused', actor: 'human:a', data: { project: 'lingtai', by: 'human:a' } },
    ])
    const answer = await run(registerProject('lingtai', data('o'), { store }))
    expect(answer).toMatchObject({ kind: 'registered', priorEvents: 1 })
    if (answer.kind === 'registered') expect(answer.before.configHash).toBeNull()
    expect((await store.read(stream)).map((e) => e.type)).toEqual(['ProjectPaused', 'ProjectConfigured'])
  })

  it('refuses another owner on its own read, appending nothing', async () => {
    const store = await configured('first')
    expect(await run(registerProject('lingtai', data('other'), { store }))).toEqual({ kind: 'taken', holder: 'first' })
    expect(await store.head(stream)).toBe(1)
  })

  it('refuses another owner on the re-read after a concurrency error', async () => {
    const real = createMemoryEventStore()
    const store = racing(real, [{ type: 'ProjectConfigured', actor: 'conductor', data: data('winner') }])
    expect(await run(registerProject('lingtai', data('loser'), { store }))).toEqual({ kind: 'taken', holder: 'winner' })
    const events = await real.read(stream)
    expect(events.length).toBe(1)
    expect(reduceProject(events).owner).toBe('winner')
  })

  it('a null owner has no identity to guard', async () => {
    const store = await configured('first')
    expect(await run(registerProject('lingtai', data(null), { store }))).toMatchObject({ kind: 'registered' })
  })
})

describe('otherOwner', () => {
  it('names the other owner, in any case', async () => {
    const state = reduceProject(await (await configured('steven-zhc')).read(stream))
    expect(otherOwner(state, 'other')).toBe('steven-zhc')
    expect(otherOwner(state, 'Steven-ZHC')).toBeNull()
    expect(otherOwner(reduceProject([]), 'other')).toBeNull()
  })
})

describe('observeSandbox', () => {
  const types = async (store: EventStore) => (await store.read(stream)).map((e) => e.type)
  it('appends on the first observation and on a new kind, and nothing for the same kind', async () => {
    const store = await configured()
    await run(observeSandbox('lingtai', { kind: 'sandboxed', runId: 'a' }, store))
    await run(observeSandbox('lingtai', { kind: 'sandboxed', runId: 'b' }, store))
    expect(await types(store)).toEqual(['ProjectConfigured', 'ProjectSandboxObserved'])
    await run(observeSandbox('lingtai', { kind: 'degraded', runId: 'c' }, store))
    expect(await types(store)).toEqual(['ProjectConfigured', 'ProjectSandboxObserved', 'ProjectSandboxObserved'])
  })

  it('a lost race to the same kind re-reads and appends nothing more', async () => {
    const real = await configured()
    const store = racing(real, [
      { type: 'ProjectSandboxObserved', actor: 'conductor', data: { kind: 'sandboxed', runId: 'x' } },
    ])
    await run(observeSandbox('lingtai', { kind: 'sandboxed', runId: 'a' }, store))
    expect(await real.head(stream)).toBe(2)
  })

  it('a store whose read rejects fails with an Error and appends nothing', async () => {
    const real = await configured()
    const store = { ...real, read: () => Promise.reject(new Error('down')) } as EventStore
    await expect(run(observeSandbox('lingtai', { kind: 'sandboxed', runId: 'a' }, store))).rejects.toBeInstanceOf(Error)
    expect(await real.head(stream)).toBe(1)
  })
})
