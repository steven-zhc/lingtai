/**
 * `lingtai pr retry` and `lingtai pr rounds` on a merged PR whose catch-up waits (#1371): the request is answered by what
 * the catch-up came to — never by the open PR's reading of `status` and `pending`, which a merged PR always satisfies.
 */
import { prStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { requestPrRetry, readPr } from '@lingtai/project'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type PrWorld, catchUpLine, prRequestVerdict } from '../src/pr.ts'

const team = { mode: 'team', branch: { main: 'main', personal: 'lingtai-team' } } as unknown as Recipe
const MAIN = 'a'.repeat(40)
const HEAD = 'f'.repeat(40)

/** A PR merged on the host whose catch-up conflicted and waits on a person. */
async function waiting(): Promise<EventStore> {
  const store = createMemoryEventStore()
  await store.append(prStream('lingtai', 1), 0, [
    { type: 'PrSubmitRequested', actor: 'human:steven', data: { by: 'human:steven' } },
    {
      type: 'PrInProgress',
      actor: 'conductor',
      data: {
        because: 'submit',
        branch: 'lingtai-team',
        main: 'main',
        prBranch: 'lingtai-team-pr-1',
        frozenSha: HEAD,
        tickets: [],
      },
    },
    { type: 'PrMerged', actor: 'conductor', data: { how: 'host', headSha: HEAD, mergeSha: 'c'.repeat(40) } },
    { type: 'PrCatchUpFailed', actor: 'conductor', data: { mainSha: MAIN, why: 'conflict', detail: 'x' } },
  ] as never)
  return store
}

/** A world whose clock moves only as the request sleeps, and whose conductor does `answer` the first time it does. */
const world = (store: EventStore, answer: () => Promise<void>): PrWorld => {
  let now = 0
  let answered = false
  return {
    store,
    recipe: () => Effect.succeed(team),
    describe: () => Effect.succeed({ title: '', body: '' }),
    holder: async () => null,
    now: () => now,
    sleep: async (ms) => {
      now += ms
      if (!answered) {
        answered = true
        await answer()
      }
    },
  }
}

const run = (ask: 'retry' | 'rounds', w: PrWorld) =>
  Effect.runPromise(prRequestVerdict(ask, 'lingtai', 'human:steven', w, 10_000, 1))

describe('a request on a merged PR waiting on its catch-up', () => {
  it('a retry whose catch-up fails again is the failure, not progress', async () => {
    const store = await waiting()
    const w = world(store, async () => {
      const at = (await store.read(prStream('lingtai', 1))).length
      await store.append(prStream('lingtai', 1), at, [
        { type: 'PrCatchUpFailed', actor: 'conductor', data: { mainSha: MAIN, why: 'conflict', detail: 'again' } },
      ] as never)
    })
    const answered = await run('retry', w)
    expect(answered.code).toBe(1)
    expect(answered.verdict.outcome).not.toBe('accepted')
    expect(JSON.stringify(answered.verdict)).toContain('catch-up waiting: conflict')
  })

  it('a retry whose catch-up lands says it caught up', async () => {
    const store = await waiting()
    const w = world(store, async () => {
      const at = (await store.read(prStream('lingtai', 1))).length
      await store.append(prStream('lingtai', 1), at, [
        { type: 'PrCaughtUp', actor: 'conductor', data: { mainSha: MAIN, mergeCommit: 'd'.repeat(40) } },
      ] as never)
    })
    const answered = await run('retry', w)
    expect(answered.code).toBe(0)
    expect(JSON.stringify(answered.verdict)).toContain('caught up')
    expect(JSON.stringify(answered.verdict)).not.toContain('checking again')
  })

  it('rounds granted while no conductor runs are not reported as resolving', async () => {
    const store = await waiting()
    const w = world(store, async () => {})
    const answered = await run('rounds', w)
    expect(JSON.stringify(answered.verdict)).not.toContain('the agent is resolving')
    expect(JSON.stringify(answered.verdict)).toContain('served when a conductor runs')
  })

  it('rounds granted whose attempt then fails are the failure that waits, not the agent resolving', async () => {
    const store = await waiting()
    const w = world(store, async () => {
      const at = (await store.read(prStream('lingtai', 1))).length
      await store.append(prStream('lingtai', 1), at, [
        {
          type: 'SyncRoundStarted',
          actor: 'conductor',
          data: { merging: 'back', commit: MAIN, start: HEAD, round: 1, catchUp: true },
        },
        { type: 'PrCatchUpFailed', actor: 'conductor', data: { mainSha: MAIN, why: 'conflict', detail: 'spent' } },
      ] as never)
    })
    const answered = await run('rounds', w)
    expect(answered.code).toBe(1)
    expect(JSON.stringify(answered.verdict)).not.toContain('the agent is resolving')
    expect(JSON.stringify(answered.verdict)).toContain('catch-up waiting: conflict')
  })

  it('a retry releases the wait: the line is no longer waiting while the attempt runs', async () => {
    const store = await waiting()
    await Effect.runPromise(requestPrRetry({ project: 'lingtai', n: 1, mode: 'team' }, { by: 'human:steven' }, store))
    const was = await Effect.runPromise(readPr('lingtai', 1, store))
    expect(catchUpLine(was!)).not.toContain('waiting')
  })
})
