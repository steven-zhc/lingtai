import { Effect, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { attach } from '../src/attach.ts'

const found = { runId: 'pass-1', project: 'lingtai', path: '/nowhere/pass-1.log' }
const find = (() => Effect.succeed(found)) as never

function run(follow: never, signal?: AbortSignal) {
  const out: string[] = []
  const err: string[] = []
  return Effect.runPromise(
    attach({
      runId: 'pass-1',
      find,
      follow,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      ...(signal ? { signal } : {}),
    }),
  ).then((code) => ({ code, out, err }))
}

describe('attach over a fake follow', () => {
  it('says the run log ends here and returns 0', async () => {
    const follow = (() => Stream.make({ line: 'hello' }, { ended: 'kept' as const })) as never
    const { code, out } = await run(follow)
    expect(code).toBe(0)
    expect(out).toContain('hello')
    expect(out.at(-1)).toContain('the run log ends here')
    expect(out.some((l) => l.includes('detached'))).toBe(false)
  })

  it('says detached when the follow ends with no ending, and returns 0', async () => {
    const controller = new AbortController()
    controller.abort()
    const follow = (() => Stream.make({ line: 'hello' })) as never
    const { code, out } = await run(follow, controller.signal)
    expect(code).toBe(0)
    expect(out.at(-1)).toBe(`— detached. The run is still going; its log is at ${found.path}`)
  })
})

describe('attach over a follow that fails', () => {
  it('reports the failure and returns 1, not a detach', async () => {
    const follow = (() => Stream.make({ line: 'hello' }).pipe(Stream.concat(Stream.fail('boom')))) as never
    const { code, out, err } = await run(follow)
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('could not read')
    expect(out.some((l) => l.includes('detached'))).toBe(false)
  })
})
