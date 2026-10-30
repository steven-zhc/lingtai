import { ticketStream } from '@lingtai/domain'
import { aClaim, aLanding, aWait } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

const boundOf = async <T>(op: Promise<T>) => ({ ok: true as const, value: await op })
const store_append = (h: Awaited<ReturnType<typeof world>>, events: ReturnType<typeof aLanding>) => h.append(events)

import { followApproval, WAIT_MS, type FollowWorld } from '../src/approve.ts'

/**
 * What `approve` says after the approval committed (#748). These run
 * `followApproval`, the function `approveVerdict` hands the outcome to, with the
 * lock holder, the store, the clock, the sleep and the signal injected — the
 * point where the outcome is decided, and the only one a unit test can reach.
 */
const project = 'lingtai'
const stream = ticketStream(project, 1)
const item = makeStream(stream)
const target = { project, issue: 1 }

async function world(over: Partial<FollowWorld> = {}) {
  const store = createMemoryEventStore()
  await store.append(stream, 0, [...aClaim(item, 'run-1')])
  let t = 0
  let version = 1
  const append = async (events: ReturnType<typeof aLanding>) => {
    await store.append(stream, version, events)
    version += events.length
  }
  const w: FollowWorld = {
    holder: async () => 'lingtai-daemon',
    store,
    now: () => t,
    sleep: async (ms) => {
      t += ms
    },
    ...over,
  }
  return { w, store, append, at: () => t }
}

describe('followApproval', () => {
  it('no holder: it lands when a conductor runs', async () => {
    const { w } = await world({ holder: async () => null })
    const r = await followApproval(target, w)
    expect(r.detail).toBe('it lands when a conductor runs: lingtai start, or lingtai run')
    expect(r.outcome).toBe('no-conductor')
  })

  it('a landing, after the claim that precedes it, is read as landed and not as claimed', async () => {
    const h = await world()
    let polls = 0
    h.w.sleep = async () => {
      polls++
      if (polls === 2) await h.append(aLanding(item, 'abcdef0123456789', 'main'))
    }
    const r = await followApproval(target, h.w)
    expect(r.detail).toBe('landed on main in abcdef0')
    expect(r.outcome).toBe('landed')
    expect(r.extra).toEqual({ mergeCommit: 'abcdef0123456789', base: 'main' })
  })

  it('a new wait: held again', async () => {
    const h = await world()
    await h.append(aWait(item, { _tag: 'OwnQuestion', question: 'which one?', by: 'human:x' }))
    const r = await followApproval(target, h.w)
    expect(r.detail).toMatch(/^held again: /)
    expect(r.next).toBe('lingtai status lingtai')
  })

  it('nothing within 60 seconds: names the holder, and a landing at 59 seconds still wins', async () => {
    const h = await world()
    const r = await followApproval(target, h.w)
    expect(r.detail).toBe('lingtai-daemon is continuing it; lingtai status says when it lands')
    expect(r.outcome).toBe('pending')
    expect(h.at()).toBeGreaterThanOrEqual(WAIT_MS)

    const late = await world()
    let t = 0
    late.w.now = () => t
    late.w.sleep = async (ms) => {
      t += ms
      if (t === 59_000) await late.append(aLanding(item, '1234567890', 'main'))
    }
    expect((await followApproval(target, late.w)).outcome).toBe('landed')
  })

  it('the signal aborts the wait: the approval stands', async () => {
    const h = await world()
    const ac = new AbortController()
    h.w.signal = ac.signal
    h.w.sleep = async () => ac.abort()
    const r = await followApproval(target, h.w)
    expect(r.detail).toBe('stopped waiting; the approval stands, and lingtai status says when it lands')
    expect(r.outcome).toBe('unknown')
  })

  it('a stream read that throws says it could not read the outcome', async () => {
    const h = await world({
      store: {
        read: async () => {
          throw new Error('store down')
        },
      },
    })
    const r = await followApproval(target, h.w)
    expect(r.detail).toBe('could not read the outcome (store down); lingtai status says when it lands')
  })

  it('a holder read that throws says it could not tell', async () => {
    const h = await world({
      holder: async () => {
        throw new Error('EACCES')
      },
    })
    const r = await followApproval(target, h.w)
    expect(r.detail).toBe('could not tell whether a conductor is running (EACCES); lingtai doctor says')
  })

  it('a stream read that never answers: Ctrl+C ends the wait, and so does the 60 seconds', async () => {
    const pending = { read: () => new Promise<never>(() => {}) }
    const ac = new AbortController()
    const h = await world({ store: pending, signal: ac.signal })
    setTimeout(() => ac.abort(), 5)
    const stopped = await followApproval(target, h.w)
    expect(stopped.detail).toBe('stopped waiting; the approval stands, and lingtai status says when it lands')

    let calls = 0
    const t = await world({
      store: pending,
      bound: (op) => (++calls === 1 ? boundOf(op) : Promise.resolve({ ok: false as const, why: 'timeout' as const })),
    })
    const r = await followApproval(target, t.w)
    expect(r.outcome).toBe('pending')
    expect(r.detail).toBe('lingtai-daemon is continuing it; lingtai status says when it lands')
  })

  it('a holder read that never answers is bounded the same way', async () => {
    const h = await world({
      holder: () => new Promise<never>(() => {}),
      bound: async () => ({ ok: false, why: 'timeout' }),
    })
    const r = await followApproval(target, h.w)
    expect(r.detail).toMatch(/^could not tell whether a conductor is running \(no answer in 60 seconds\)/)
    const ac = new AbortController()
    ac.abort()
    const a = await world({ holder: () => new Promise<never>(() => {}), signal: ac.signal })
    expect((await followApproval(target, a.w)).detail).toMatch(/^stopped waiting/)
  })

  it('held again names the branch from the ticket fold, not an empty one', async () => {
    const h = await world()
    await store_append(h, [
      item('TicketDiscovered', {
        project,
        source: 'github-issue',
        externalRef: '1',
        title: 't',
        kind: 'bug',
        labels: [],
      }),
    ])
    await h.append(
      aWait(item, {
        _tag: 'ProposedEscalated',
        run: { runId: 'run-1' },
        proposal: { _tag: 'VerifyRed', output: 'red' },
        because: { _tag: 'NotAsked' },
      }),
    )
    const r = await followApproval(target, h.w)
    expect(r.detail).toMatch(/^held again: agent\/1 is waiting on you\./)
  })
})
