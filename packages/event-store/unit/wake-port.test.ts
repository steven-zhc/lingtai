import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { promiseWaker } from '../src/store-face.ts'
import type { WakerPort } from '../src/wake.ts'

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describe('promiseWaker over a WakerPort', () => {
  it('a close before ready returns at once, releases once, and owes no lost', async () => {
    let released = 0
    let lost = 0
    const port: WakerPort = {
      open: () =>
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              released++
            }),
          )
          return yield* Effect.never
        }),
    }
    const session = promiseWaker(port).open({
      nudge() {},
      lost() {
        lost++
      },
    })
    session.close()
    await flush()
    expect(released).toBe(1)
    session.close()
    await flush()
    expect(released).toBe(1)
    expect(lost).toBe(0)
  })

  it('calls listener.lost once with the very error the port died with', async () => {
    const e = new Error('gone')
    const seen: unknown[] = []
    const port: WakerPort = { open: () => Effect.succeed({ lost: Effect.die(e) }) }
    const session = promiseWaker(port).open({
      nudge() {},
      lost: (err) => {
        seen.push(err)
      },
    })
    await session.ready
    await flush()
    expect(seen).toEqual([e])
    expect(seen[0]).toBe(e)
  })
})
