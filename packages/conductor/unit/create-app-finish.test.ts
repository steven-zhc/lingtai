/**
 * Two returns of one `state` are one exchange (#1083), with no filesystem: the
 * exchange waits on a `Deferred`, then GitHub refuses the code. Both callers are
 * given the same refused `Outcome`, and a refused exchange writes nothing.
 */
import { GITHUB_APP_STREAM } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Deferred, Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { createCreationSession } from '../src/create-app.ts'

describe('finish with one state twice', () => {
  it('asks GitHub once and gives both returns the one refusal', async () => {
    const session = createCreationSession()
    const store = createMemoryEventStore()
    const release = Deferred.makeUnsafe<void>()
    let asked = 0
    const fetched = (async () => {
      asked += 1
      await Effect.runPromise(Deferred.await(release))
      return new Response('{"message":"Not Found"}', { status: 422 })
    }) as unknown as typeof fetch

    const { state } = session.begin({ redirectUrl: 'http://localhost/created', name: 'lingtai-test' })
    const options = {
      code: 'one-time',
      state,
      by: 'human:test',
      store,
      env: {},
      configFile: '/nonexistent/lingtai/config.yml',
      keyPath: '/nonexistent/lingtai/key.pem',
      fetch: fetched,
      readFile: () => Effect.succeed(null),
    }

    const first = session.finish({ ...options })
    const reload = session.finish({ ...options })
    await new Promise((resolve) => setTimeout(resolve, 10))
    Effect.runSync(Deferred.succeed(release, undefined))
    const [a, b] = await Promise.all([first, reload])

    expect(asked).toBe(1)
    expect(a.ok).toBe(false)
    expect(b).toBe(a)
    expect(await store.read(GITHUB_APP_STREAM)).toEqual([])
  })
})
