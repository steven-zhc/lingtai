import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { isBehind } from '../src/doctor.ts'

// A fake `run` stands in for `gitEffect`, so none of these spawns a process (0060 §1).
describe('isBehind', () => {
  const ask = (run: Parameters<typeof isBehind>[2]) => Effect.runPromise(isBehind('aaa', 'bbb', run))

  it('is true when the commit is an ancestor', async () => {
    expect(await ask(() => Effect.succeed(''))).toBe(true)
  })

  it('is false when git exits non-zero, which is not proof of being older', async () => {
    expect(await ask(() => Effect.fail(new Error('exit 1')))).toBe(false)
  })

  it('is false when the read dies, as a commit this clone never fetched can', async () => {
    expect(await ask(() => Effect.die(new Error('spawn failed')))).toBe(false)
  })

  it('asks nothing for a missing or equal commit', async () => {
    const never = () => Effect.die(new Error('should not be asked'))
    expect(await Effect.runPromise(isBehind(null, 'bbb', never))).toBe(false)
    expect(await Effect.runPromise(isBehind('aaa', null, never))).toBe(false)
    expect(await Effect.runPromise(isBehind('bbb', 'bbb', never))).toBe(false)
  })

  it('lets an interruption through rather than answering false', async () => {
    const exit = await Effect.runPromiseExit(isBehind('aaa', 'bbb', () => Effect.interrupt))
    expect(exit._tag).toBe('Failure')
  })
})
