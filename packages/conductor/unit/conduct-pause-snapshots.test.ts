/**
 * `pauseConductorOnce` reads the control state through the generic snapshot read
 * (#873): head first, then the state, then the append at that head.
 *
 * - A store passed in has no snapshots of its own, so the process log's are never touched.
 * - An event that lands between the head and the append fails the append, which the
 *   pause already answers as a defect (`failed`) rather than deciding over a stale state.
 */
import { describe, expect, it, vi } from 'vitest'

import { RECIPE, fakeGitHub, fakePorts, memoryStore, once, project, runtime } from '../test/one-attempt.ts'

vi.mock('@lingtai/event-store', async (orig) => {
  const real = await orig<typeof import('@lingtai/event-store')>()
  return {
    ...real,
    log: {
      get snapshots(): never {
        throw new Error('the process log was touched')
      },
    },
  }
})

const SANDBOXED = RECIPE.replace('agent: claude-code,', 'agent: claude-code, tier: sandboxed,')
const input = (store: ReturnType<typeof memoryStore>) => ({
  project,
  client: fakeGitHub([], SANDBOXED),
  runtime,
  issue: 7,
  hookBinary: '/tmp/fake/lingtai-hook',
  prompt: 'fix {{issue}}',
  merge: false,
  home: '/tmp/fake-home',
  store,
})

describe('pauseConductorOnce through the generic snapshot read', () => {
  it('appends the pause on a passed-in store without touching log.snapshots', async () => {
    const store = memoryStore()
    await once(input(store), fakePorts([], store))
    const paused = (await store.read('ctl-conductor')).filter((e) => e.type === 'ConductorPaused')
    expect(paused).toHaveLength(1)
  })

  it('an event landing after head fails the append, and the pause is answered as failed', async () => {
    const real = memoryStore()
    let raced = false
    const store = {
      ...real,
      readTypes: async (...args: Parameters<typeof real.readTypes>) => {
        const out = await real.readTypes(...args)
        if (!raced && args[0] === 'ctl-conductor') {
          raced = true
          await real.append('ctl-conductor', await real.head('ctl-conductor'), [
            { type: 'ConductorResumed', actor: 'human:p', data: { by: 'a person' } },
          ])
        }
        return out
      },
    } as typeof real
    await once(input(store), fakePorts([], store))
    expect(raced).toBe(true)
    const control = await real.read('ctl-conductor')
    expect(control.filter((e) => e.type === 'ConductorPaused')).toHaveLength(0)
    expect(control.map((e) => e.type)).toEqual(['ConductorResumed'])
  })
})
