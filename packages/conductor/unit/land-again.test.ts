/**
 * **A landing refused only because origin did not answer is landed again from the
 * same head, inside the same pass, before a person is asked** (#1221; 0108 §15).
 * The lane's own three tries end `unreachable` or `remote-error`; a rule answers
 * that with `land-again`, waits, and goes to `merge` again. Nothing is built or
 * reviewed again.
 *
 * The waits are injected (`transientWaits`) the way `unreachableWaits` is, and are
 * a few milliseconds here; what is asserted of them is the order and the count.
 */
import { TRANSIENT_RETRIES_LIMIT } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { RECIPE, fakeGitHub, fakePorts, memoryStore, once, project, runtime } from '../test/one-attempt.ts'

const MERGE_ERROR = ' ! [remote rejected]   main -> main (Internal Server Error)'

/** Real sleeps, so the elapsed time is measurable; the sentences name them. */
const WAITS = ['40 millis', '80 millis', '120 millis'] as const

type Refusal = { reason: string; detail: string }

/** The lane refuses `refusals` times in a row with `refusal`, then lands. */
async function land(refusal: Refusal, refusals: number, recipe = RECIPE, refuseRoutes = false) {
  const began = Date.now()
  const store = memoryStore()
  if (refuseRoutes) {
    const append = store.append.bind(store)
    store.append = ((stream: string, at: number, events: readonly { type: string }[]) =>
      events.some((e) => e.type === 'ProposalRouted')
        ? Promise.reject(new Error('store refused'))
        : append(stream, at, events as never)) as typeof store.append
  }
  const did: string[] = []
  const ports = fakePorts(did, store, true)
  let lane = 0
  ports.repo.integrate = () =>
    Effect.sync(() => {
      lane += 1
      return lane <= refusals
        ? ({ ok: false, reason: refusal.reason, detail: refusal.detail } as never)
        : ({ ok: true, mergeCommit: 'c'.repeat(40) } as never)
    })
  const result = await once(
    {
      project,
      client: fakeGitHub([], recipe),
      runtime,
      issue: 7,
      hookBinary: '/tmp/fake/lingtai-hook',
      prompt: 'fix {{issue}}',
      merge: true,
      home: '/tmp/fake-home',
      store,
      unreachableWaits: ['0 millis', '0 millis'],
      transientWaits: WAITS,
    },
    ports,
  )
  const elapsed = Date.now() - began
  const events = [...store.streams.values()].flat()
  const routes = events.filter((e) => e.type === 'ProposalRouted')
  // The routes a rule selected: the decision's own candidate, not any offer that merely mentions one.
  const replyOf = (e: (typeof routes)[number]) =>
    (e.data as { reply: { _tag: string; candidate?: string; why?: string } }).reply
  const landAgains = routes.filter((e) => replyOf(e)._tag === 'Selected' && replyOf(e).candidate === 'land-again')
  const visits = (step: string) =>
    events.filter((e) => e.type === 'StepEnded' && JSON.stringify(e.data).includes(`"step":"${step}"`)).length
  return { result, lane: () => lane, routes, landAgains, visits, events, elapsed, replyOf }
}

describe('a landing the lane refused because origin did not answer', () => {
  it('is landed again after a remote-error, and nothing before the lane runs twice', async () => {
    const { result, lane, landAgains, visits } = await land({ reason: 'remote-error', detail: MERGE_ERROR }, 1)
    if (result.ok !== true) throw new Error(`did not land: ${JSON.stringify(result)}`)
    expect(lane()).toBe(2)
    expect(landAgains).toHaveLength(1)
    // The steps before the lane are visited exactly as often as in a run whose first land succeeds.
    const plain = await land({ reason: 'remote-error', detail: MERGE_ERROR }, 0)
    for (const step of ['implement', 'build', 'review']) expect(visits(step)).toBe(plain.visits(step))
    expect(visits('implement')).toBeGreaterThan(0)
  })

  it('is landed again after an unreachable too', async () => {
    const { result, lane, landAgains } = await land({ reason: 'unreachable', detail: 'Operation timed out' }, 2)
    if (result.ok !== true) throw new Error(`did not land: ${JSON.stringify(result)}`)
    expect(lane()).toBe(3)
    expect(landAgains).toHaveLength(2)
  })

  it('takes exactly TRANSIENT_RETRIES_LIMIT land-agains, then holds for a person and says how many', async () => {
    const { result, lane, landAgains, events, elapsed } = await land(
      { reason: 'remote-error', detail: MERGE_ERROR },
      99,
    )
    expect(result.ok).not.toBe(true)
    expect(landAgains).toHaveLength(TRANSIENT_RETRIES_LIMIT)
    // The waits were slept, in order, one per retry: 40 + 80 + 120 ms at least.
    expect(elapsed).toBeGreaterThanOrEqual(240)
    // The first land, and one per retry.
    expect(lane()).toBe(TRANSIENT_RETRIES_LIMIT + 1)
    const held = JSON.stringify(events, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
    expect(held).toContain('"landedAgain":{"times":3')
  })

  it('names each retry and its wait in the route it records', async () => {
    const { landAgains, replyOf } = await land({ reason: 'remote-error', detail: MERGE_ERROR }, 99)
    expect(landAgains.map((e) => replyOf(e).why)).toEqual([
      expect.stringContaining('after 40ms, retry 1 of 3'),
      expect.stringContaining('after 80ms, retry 2 of 3'),
      expect.stringContaining('after 120ms, retry 3 of 3'),
    ])
  })

  it('is not asked of a declared judge while a land-again is on offer', async () => {
    const recipe = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: the lines
      judge: same-worktree
      when: merge-refused
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`
    // Judge-first would answer the first refusal with the judge's own reply, and no route would be a `land-again`.
    const { result, landAgains, routes, replyOf } = await land(
      { reason: 'remote-error', detail: MERGE_ERROR },
      1,
      recipe,
    )
    if (result.ok !== true) throw new Error(`did not land: ${JSON.stringify(result)}`)
    expect(landAgains).toHaveLength(1)
    expect(routes).toHaveLength(1)
    expect(replyOf(routes[0]!)._tag).toBe('Selected')
  })

  it('asks a declared judge once the retries are spent', async () => {
    const recipe = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: the lines
      judge: same-worktree
      when: merge-refused
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`
    const { landAgains, routes, replyOf } = await land({ reason: 'remote-error', detail: MERGE_ERROR }, 3, recipe)
    expect(landAgains).toHaveLength(TRANSIENT_RETRIES_LIMIT)
    // The route after the three land-agains is the judge's: its reply is not a rule's land-again.
    const after = routes.slice(TRANSIENT_RETRIES_LIMIT)
    for (const r of after) expect(replyOf(r).candidate).not.toBe('land-again')
  })

  it.each(['push-rejected', 'base-protected', 'unexpected'])('does not land %s again', async (reason) => {
    const { result, lane, landAgains } = await land({ reason, detail: 'refused' }, 99)
    expect(result.ok).not.toBe(true)
    expect(lane()).toBe(1)
    expect(landAgains).toHaveLength(0)
  })

  it('spends no retry when its route cannot be recorded: it holds, having landed once', async () => {
    const { result, lane, landAgains, elapsed } = await land(
      { reason: 'remote-error', detail: MERGE_ERROR },
      99,
      RECIPE,
      true,
    )
    expect(result.ok).not.toBe(true)
    expect(lane()).toBe(1)
    expect(landAgains).toHaveLength(0)
    expect(elapsed).toBeLessThan(40)
  })
})
