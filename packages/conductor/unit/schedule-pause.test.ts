import type { Runtime } from '@lingtai/agent'
import type { ProjectState } from '@lingtai/domain'
/**
 * A pass that is asked whether it is paused, and is (#166).
 *
 * `lingtai run` works the whole queue through `runQueue`, and a pause issued
 * while its first ticket ran used to be heard by nobody: the command read it
 * once, before the lock, and the loop went round and took the second. The
 * answer is asked every time round, before anything is offered or claimed —
 * this is the first time round, where nothing may be asked of GitHub at all.
 * The second time round, with a ticket finished between, needs the projection,
 * and nothing asserts it since `#256` deleted the old engine's tests.
 */
import type { GitHubClient } from '@lingtai/github'
import type { Recipe } from '@lingtai/recipe'
import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { AgentHost, Repo } from '../src/ports.ts'
import { runQueue } from '../src/schedule.ts'

// Every one of these throws: a paused pass reaches none of them.
const untouched = <T>(what: string): T =>
  new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === 'then') return undefined
        return () => {
          throw new Error(`a paused pass reached ${what}.${String(key)}`)
        }
      },
    },
  ) as T

const took: number[] = []

vi.mock('../src/queue.ts', () => ({
  selectRunnable: async () => [{ taskId: 'ticket-p-7', issue: '7', title: 't', kind: 'bug' }],
}))
vi.mock('../src/conduct.ts', () => ({
  runOnce: (o: { issue: number }) => {
    took.push(o.issue)
    throw new Error('a paused pass reached runOnce')
  },
}))
vi.mock('@lingtai/recipe/settings', () => ({
  queueOf: () => ({ kinds: ['bug'], exclude: [], backoff: '1h', assignee: { take: 'both' } }),
  kindsOf: () => ['bug'],
  backoffOf: () => '1h',
}))

describe('runQueue under a pause', () => {
  it('stops before it asks GitHub for anything, and says why', async () => {
    const lines: string[] = []
    let asked = 0
    const outcome = await Effect.runPromise(
      runQueue({
        project: { project: 'purecheck' } as ProjectState,
        client: untouched<GitHubClient>('client'),
        runtime: untouched<Runtime>('runtime'),
        hookBinary: '/nonexistent',
        prompt: 'p',
        recipe: untouched<Recipe>('recipe'),
        paused: Effect.sync(() => {
          asked += 1
          return 'paused by human:ops — migrating the database'
        }),
        log: (l) => lines.push(l),
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.succeed(Repo, untouched('repo')), Layer.succeed(AgentHost, untouched('agent'))),
        ),
      ),
    )

    expect(asked).toBe(1)
    expect(outcome.stopped).toBe('paused')
    expect(outcome.ran).toEqual([])
    expect(lines).toContain('paused by human:ops — migrating the database')
  })

  it('a stop that lands during the queue read takes no claim', async () => {
    const lines: string[] = []
    const failed: string[] = []
    let asked = 0
    const client = {
      listOpenIssues: async () => [
        {
          number: 7,
          title: 't',
          state: 'open' as const,
          labels: [{ name: 'bug', color: null }],
          assignees: [],
          dependencies: { blockedBy: 0 },
          parent: null,
          subIssues: null,
        },
      ],
    }
    const outcome = await Effect.runPromise(
      runQueue({
        project: { project: 'p' } as ProjectState,
        client: client as never,
        runtime: untouched<Runtime>('runtime'),
        hookBinary: '/nonexistent',
        prompt: 'p',
        recipe: {} as Recipe,
        paused: Effect.sync(() => {
          asked += 1
          return asked === 1 ? null : 'task_view stopped — nothing is claimed'
        }),
        failed: (why) => failed.push(why),
        log: (l) => lines.push(l),
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.succeed(Repo, untouched('repo')), Layer.succeed(AgentHost, untouched('agent'))),
        ),
      ),
    )

    expect(asked).toBe(2)
    expect(outcome.stopped).toBe('paused')
    expect(outcome.ran).toEqual([])
    expect(took).toEqual([])
    expect(lines).toContain('task_view stopped — nothing is claimed')
    expect(failed).toEqual(['task_view stopped — nothing is claimed'])
  })
})
