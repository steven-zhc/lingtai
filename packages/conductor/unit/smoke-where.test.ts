/** Where the hook's smoke test runs (#1479): the worktree always, the run's own sandbox when the invocation is sandboxed. */
import type { SandboxApi, WrapInput } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { smokeWhere } from '../src/smoke-where.ts'

const sandboxed = { kind: 'sandboxed', project_additions: { network: ['example.com'] } } as never
const asked: WrapInput[] = []
const api = {
  wrap: (input: WrapInput) =>
    Effect.sync(() => {
      asked.push(input)
      return { argv: ['/srt', ...input.command], env: { ...input.env, SRT: '1' }, commandId: 'c' }
    }),
} as unknown as SandboxApi
const from = { project: 'p', mirror: '/m', hookBinary: '/bin/lingtai-hook', service: Effect.succeed(api) }

describe('smokeWhere', () => {
  it('is the worktree and no wrap when the decision is unsandboxed', () => {
    const where = smokeWhere({ kind: 'unsandboxed', reason: 'off by choice' }, 'claude-code', '/w', from)
    expect(where).toEqual({ cwd: '/w' })
  })

  it('is no wrap for a runtime that cannot be sandboxed, though the pass was sandboxed', () => {
    expect(smokeWhere(sandboxed, 'antigravity', '/w', from)).toEqual({ cwd: '/w' })
    expect(smokeWhere(sandboxed, 'claude-code', '/w', from).wrap).toBeDefined()
  })

  it('wraps the hook with the worktree, its env, and a read of the hook binary', async () => {
    asked.length = 0
    const where = smokeWhere(sandboxed, 'claude-code', '/w', from)
    expect(where.cwd).toBe('/w')
    const wrapped = await Effect.runPromise(
      Effect.scoped(where.wrap!({ command: ['/bin/lingtai-hook'], env: { A: 'b' } })),
    )
    expect(wrapped.argv).toEqual(['/srt', '/bin/lingtai-hook'])
    expect(asked[0]).toMatchObject({
      worktree: '/w',
      mirror: '/m',
      project: 'p',
      env: { A: 'b' },
      caller_additions: { read: ['/bin/lingtai-hook'] },
    })
  })

  it('says why a wrap could not be made', async () => {
    const where = smokeWhere(sandboxed, 'claude-code', '/w', { ...from, service: undefined })
    const out = await Effect.runPromise(Effect.scoped(Effect.flip(where.wrap!({ command: ['x'], env: {} }))))
    expect(out.message).toBe('no sandbox service in this process')
  })
})
