/**
 * **A branch push that cannot reach origin is retried in place, and what still
 * fails says so** (#1029). `landNow` pushes the branch before the lane runs; it
 * used to call every failure `push-rejected`.
 */
import { RepoFailed } from '@lingtai/repo'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { RECIPE, fakeGitHub, fakePorts, memoryStore, once, project, runtime } from '../test/one-attempt.ts'

const TIMEOUT =
  "fatal: unable to access 'https://github.com/steven-zhc/lingtai.git/': Recv failure: Operation timed out"

const logOf = (store: ReturnType<typeof memoryStore>) =>
  JSON.stringify([...store.streams.values()].flat(), (_k, v) => (typeof v === 'bigint' ? Number(v) : v))

async function land(pushDetail: string | undefined, failures: number, lsFailures = 0) {
  const store = memoryStore()
  const ports = fakePorts([], store, true)
  const pushes: string[][] = []
  let lane = 0
  ports.repo.integrate = () =>
    Effect.sync(() => {
      lane += 1
      return { ok: true, mergeCommit: 'c'.repeat(40) } as never
    })
  const git = ports.repo.git
  ports.repo.git = (args, o) => {
    if (args[0] === 'ls-remote' && lsFailures > 0) {
      lsFailures -= 1
      return Effect.fail(new RepoFailed({ operation: 'git ls-remote', detail: TIMEOUT }))
    }
    if (args[0] === 'ls-remote') return Effect.succeed('')
    if (args[0] !== 'push' || pushDetail === undefined) return git(args, o)
    return Effect.suspend(() => {
      pushes.push(args)
      return pushes.length <= failures
        ? Effect.fail(new RepoFailed({ operation: 'git push', detail: pushDetail }))
        : git(args, o)
    })
  }
  const result = await once(
    {
      project,
      client: fakeGitHub([], RECIPE),
      runtime,
      issue: 7,
      hookBinary: '/tmp/fake/lingtai-hook',
      prompt: 'fix {{issue}}',
      merge: true,
      home: '/tmp/fake-home',
      store,
      unreachableWaits: ['0 millis', '0 millis'],
    },
    ports,
  )
  return { result, pushes, lane: () => lane, store }
}

describe('the branch push in landNow', () => {
  it('is retried when origin cannot be reached, and the lane is then called', async () => {
    const { result, pushes, lane } = await land(TIMEOUT, 1)
    if (result.ok !== true) throw new Error(`did not land: ${JSON.stringify(result)}`)
    expect(pushes).toHaveLength(2)
    expect(lane()).toBe(1)
  })

  it('is unreachable, not push-rejected, when the tries run out', async () => {
    // Three tries fail; the end-of-pass publish after them is another push, and succeeds.
    // (Three consecutive failures of the first push, then the lane never runs.)
    const { result, pushes, lane, store } = await land(TIMEOUT, 3)
    expect(result.ok).not.toBe(true)
    expect(pushes.slice(0, 3).every((a) => a.some((x) => x.startsWith('--force-with-lease')))).toBe(true)
    expect(lane()).toBe(0)
    const logged = logOf(store)
    expect(logged).toContain('unreachable')
    expect(logged).not.toContain('push-rejected')
  })

  it('stays push-rejected for a failure that is not the network, with no retry', async () => {
    // Only the first push fails: a retry would make the second succeed and call the lane.
    const { result, lane, store } = await land('! [rejected] HEAD -> agent/7 (non-fast-forward)', 1)
    expect(result.ok).not.toBe(true)
    expect(lane()).toBe(0)
    expect(logOf(store)).toContain('push-rejected')
  })

  it('retries a stale-info check whose ls-remote fails once, inside the same tries', async () => {
    // Every push is stale; origin does not hold our sha, so it ends push-rejected — but only
    // after the transient ls-remote failure was retried rather than held as unreachable.
    const { result, pushes, store } = await land('! [rejected] HEAD -> agent/7 (stale info)', 99, 1)
    expect(result.ok).not.toBe(true)
    expect(pushes.length).toBeGreaterThanOrEqual(2)
    expect(logOf(store)).not.toContain('unreachable')
  })
})
