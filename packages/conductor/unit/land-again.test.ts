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

type Refusal = { reason: string; detail: string }

/** The lane refuses `refusals` times in a row with `refusal`, then lands. */
async function land(refusal: Refusal, refusals: number, recipe = RECIPE) {
  const store = memoryStore()
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
      transientWaits: ['1 millis', '2 millis', '3 millis'],
    },
    ports,
  )
  const events = [...store.streams.values()].flat()
  const routes = events.filter((e) => e.type === 'ProposalRouted')
  const landAgains = routes.filter((e) => JSON.stringify(e.data).includes('"land-again"'))
  const visits = (step: string) =>
    events.filter((e) => e.type === 'StepEnded' && JSON.stringify(e.data).includes(`"step":"${step}"`)).length
  return { result, lane: () => lane, routes, landAgains, visits, events }
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
    const { result, lane, landAgains, events } = await land({ reason: 'remote-error', detail: MERGE_ERROR }, 99)
    expect(result.ok).not.toBe(true)
    expect(landAgains).toHaveLength(TRANSIENT_RETRIES_LIMIT)
    // The first land, and one per retry.
    expect(lane()).toBe(TRANSIENT_RETRIES_LIMIT + 1)
    const held = JSON.stringify(events, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
    expect(held).toContain('"landedAgain":{"times":3')
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
    const { result, landAgains, events } = await land({ reason: 'remote-error', detail: MERGE_ERROR }, 1, recipe)
    if (result.ok !== true) throw new Error(`did not land: ${JSON.stringify(result)}`)
    expect(landAgains).toHaveLength(1)
    expect(JSON.stringify(events, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).not.toContain('"Judged"')
  })

  it.each(['push-rejected', 'base-protected', 'unexpected'])('does not land %s again', async (reason) => {
    const { result, lane, landAgains } = await land({ reason, detail: 'refused' }, 99)
    expect(result.ok).not.toBe(true)
    expect(lane()).toBe(1)
    expect(landAgains).toHaveLength(0)
  })
})
