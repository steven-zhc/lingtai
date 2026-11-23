import { readState } from '@lingtai/conductor/snapshot-state'
import { attemptReducer, reduceAll } from '@lingtai/domain'
import { histories } from '@lingtai/domain/test/histories'
import { machineFileFrom } from '@lingtai/env'
import type { EventStore, Snapshot, SnapshotStore } from '@lingtai/event-store'
import { createMemoryEventStore, createMemorySnapshotStore } from '@lingtai/event-store/memory'
import { SpanStatusCode, context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readAttemptState } from '../src/lib/board.ts'
import { installTracing } from '../src/lib/telemetry.ts'
import { measure, traced } from '../src/lib/timing.ts'

// The real `readState` → `readThroughSnapshot` over memory stores, with the board's own observer wiring under test.

const none = machineFileFrom('/h/config.yml', null)
const on = { LINGTAI_TELEMETRY_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' } as unknown as NodeJS.ProcessEnv

let exporter: InMemorySpanExporter
let flush: () => Promise<void>
const spans = async (): Promise<ReadableSpan[]> => {
  await flush()
  return exporter.getFinishedSpans()
}
const idOf = (s: ReadableSpan) => s.spanContext().spanId
const childrenOf = (all: ReadableSpan[], parent: ReadableSpan) =>
  all.filter((s) => s.parentSpanContext?.spanId === idOf(parent))
const named = (all: ReadableSpan[], name: string) => all.filter((s) => s.name === name)
const names = (all: ReadableSpan[], parent: ReadableSpan) => childrenOf(all, parent).map((s) => s.name)

beforeEach(async () => {
  exporter = new InMemorySpanExporter()
  const installed = await installTracing(on, none, exporter)
  flush = () => installed!.forceFlush()
})

afterEach(() => {
  trace.disable()
  context.disable()
})

const EVENTS = histories.attempt.landedFirstTry.slice(0, 4).map((e) => ({ type: e.type, actor: e.actor, data: e.data }))

async function seeded(runIds: readonly string[]) {
  const events = createMemoryEventStore()
  for (const id of runIds) await events.append(id, 0, EVENTS as never)
  return { events, snapshots: createMemorySnapshotStore(events) }
}

async function plantAt(
  events: ReturnType<typeof createMemoryEventStore>,
  snapshots: ReturnType<typeof createMemorySnapshotStore>,
  runId: string,
  state?: string,
) {
  const stored = await events.read(runId)
  const at = stored[0]!
  snapshots.plant({
    streamId: runId,
    reducer: attemptReducer.name,
    reducerVersion: attemptReducer.version,
    streamVersion: at.version,
    lastSeq: at.seq,
    lastAt: at.at,
    state: state ?? attemptReducer.encode(reduceAll(attemptReducer, stored.slice(0, 1))),
  })
}

/** Counts every store call and lets a test hold or fail the tail read. */
function counted(events: EventStore, snapshots: SnapshotStore) {
  const calls = { read: 0, latest: 0, offer: 0 }
  const held = new Map<string, Promise<void>>()
  let failTail: Error | undefined
  const store = {
    readTypes: events.readTypes.bind(events),
    read: async (id: string, from?: number) => {
      calls.read += 1
      if (from !== undefined && failTail !== undefined) throw failTail
      if (from !== undefined) await held.get(id)
      return events.read(id, from)
    },
  } as Pick<EventStore, 'readTypes' | 'read'>
  const snaps: SnapshotStore = {
    ...snapshots,
    latest: async (key) => {
      calls.latest += 1
      return snapshots.latest(key)
    },
  }
  const writer = { offer: (_s: Snapshot) => void (calls.offer += 1) }
  return {
    calls,
    store,
    read: { snapshots: snaps, writer },
    hold: (id: string) => {
      let release!: () => void
      held.set(id, new Promise<void>((r) => (release = r)))
      return release
    },
    failTail: (e: Error) => void (failTail = e),
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r))

describe('readAttemptState', () => {
  it('a served read shows latest, tail, recheck and reduce, and says a snapshot served it', async () => {
    const { events, snapshots } = await seeded(['pass-r1'])
    await plantAt(events, snapshots, 'pass-r1')
    const c = counted(events, snapshots)
    await readAttemptState(c.store, 'pass-r1', c.read)
    const all = await spans()
    const [state] = named(all, 'attempt.state')
    expect(names(all, state!).sort()).toEqual(['attempt.latest', 'attempt.recheck', 'attempt.reduce', 'attempt.tail'])
    expect(state!.attributes['lingtai.snapshot']).toBe(true)
  })

  it('no snapshot row: reads the whole stream and says false', async () => {
    const { events, snapshots } = await seeded(['pass-r1'])
    const c = counted(events, snapshots)
    await readAttemptState(c.store, 'pass-r1', c.read)
    const all = await spans()
    const [state] = named(all, 'attempt.state')
    expect(names(all, state!).sort()).toEqual(['attempt.latest', 'attempt.reduce', 'attempt.tail'])
    expect(state!.attributes['lingtai.snapshot']).toBe(false)
  })

  it('a snapshot that does not decode falls back and says false', async () => {
    const { events, snapshots } = await seeded(['pass-r1'])
    await plantAt(events, snapshots, 'pass-r1', 'not json {')
    const c = counted(events, snapshots)
    const state = await readAttemptState(c.store, 'pass-r1', c.read)
    expect(state).toEqual(reduceAll(attemptReducer, await events.read('pass-r1')))
    const [span] = named(await spans(), 'attempt.state')
    expect(span!.attributes['lingtai.snapshot']).toBe(false)
  })

  it('a moved anchor shows the full re-read and says false', async () => {
    const { events, snapshots } = await seeded(['pass-r1'])
    await plantAt(events, snapshots, 'pass-r1')
    const c = counted(events, snapshots)
    let n = 0
    const first = await snapshots.latest({
      streamId: 'pass-r1',
      reducer: attemptReducer.name,
      reducerVersion: attemptReducer.version,
    })
    c.read.snapshots = {
      ...snapshots,
      latest: async () => (++n === 1 ? first : null),
    }
    const state = await readAttemptState(c.store, 'pass-r1', c.read)
    expect(state).toEqual(reduceAll(attemptReducer, await events.read('pass-r1')))
    const all = await spans()
    const [span] = named(all, 'attempt.state')
    expect(names(all, span!)).toContain('attempt.full')
    expect(span!.attributes['lingtai.snapshot']).toBe(false)
  })

  it('a failing tail ends its span and the parent with an error, and rejects with the store’s own error', async () => {
    const { events, snapshots } = await seeded(['pass-r1'])
    await plantAt(events, snapshots, 'pass-r1')
    const c = counted(events, snapshots)
    const boom = new Error('store down')
    c.failTail(boom)
    await expect(readAttemptState(c.store, 'pass-r1', c.read)).rejects.toBe(boom)
    const all = await spans()
    const [state] = named(all, 'attempt.state')
    const [tail] = named(all, 'attempt.tail')
    expect(state!.status.code).toBe(SpanStatusCode.ERROR)
    expect(tail!.status.code).toBe(SpanStatusCode.ERROR)
    expect(state!.attributes['lingtai.snapshot']).toBeUndefined()
  })

  it('two deferred cards keep their own phases and flags when released in reverse', async () => {
    const { events, snapshots } = await seeded(['pass-hit', 'pass-miss'])
    await plantAt(events, snapshots, 'pass-hit')
    const c = counted(events, snapshots)
    const releaseHit = c.hold('pass-hit')
    const releaseMiss = c.hold('pass-miss')
    const cards = Promise.all(
      ['pass-hit', 'pass-miss'].map((id) => traced(`card.${id}`, () => readAttemptState(c.store, id, c.read))),
    )
    await tick()
    releaseMiss()
    releaseHit()
    await cards
    const all = await spans()
    for (const [id, flag] of [
      ['pass-hit', true],
      ['pass-miss', false],
    ] as const) {
      const [card] = named(all, `card.${id}`)
      const [state] = childrenOf(all, card!)
      expect(state!.name).toBe('attempt.state')
      expect(state!.attributes['lingtai.snapshot']).toBe(flag)
      const phases = childrenOf(all, state!)
      expect(phases.length).toBeGreaterThan(0)
      expect(phases.every((p) => p.name.startsWith('attempt.'))).toBe(true)
      expect(phases.some((p) => p.name === 'attempt.recheck')).toBe(flag)
    }
    // every phase belongs to exactly one state
    const states = named(all, 'attempt.state').map(idOf)
    for (const p of all.filter((s) => s.name !== 'attempt.state' && s.name.startsWith('attempt.'))) {
      expect(states).toContain(p.parentSpanContext?.spanId)
    }
  })

  it('two concurrent renders keep their phases in their own trace', async () => {
    const { events, snapshots } = await seeded(['pass-a', 'pass-b'])
    const c = counted(events, snapshots)
    const releaseA = c.hold('pass-a')
    const releaseB = c.hold('pass-b')
    const renders = Promise.all(
      ['pass-a', 'pass-b'].map((id) => traced(`board.progress.${id}`, () => readAttemptState(c.store, id, c.read))),
    )
    await tick()
    releaseB()
    releaseA()
    await renders
    const all = await spans()
    for (const id of ['pass-a', 'pass-b']) {
      const [root] = named(all, `board.progress.${id}`)
      const [state] = childrenOf(all, root!)
      for (const p of childrenOf(all, state!)) {
        expect(p.spanContext().traceId).toBe(root!.spanContext().traceId)
      }
    }
  })

  it('matches the unobserved path in result and in store calls', async () => {
    const { events, snapshots } = await seeded(['pass-r1'])
    await plantAt(events, snapshots, 'pass-r1')
    const observed = counted(events, snapshots)
    const bare = counted(events, snapshots)
    const a = await readAttemptState(observed.store, 'pass-r1', observed.read)
    const b = await readState(bare.store, attemptReducer, 'pass-r1', 'all', bare.read)
    expect(a).toEqual(b)
    expect(observed.calls).toEqual(bare.calls)
  })

  it('adds no TimingMeta entry', async () => {
    const { events, snapshots } = await seeded(['pass-r1'])
    const c = counted(events, snapshots)
    const [, timings] = await measure(() => readAttemptState(c.store, 'pass-r1', c.read))
    expect(timings).toEqual([])
  })
})
