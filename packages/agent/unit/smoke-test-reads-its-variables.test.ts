/** The smoke test proves the hook read its variables, not only that it exited 2 (#1479). */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { smokeTestFailClosedEffect, type SmokeSpawn } from '../src/hook-config.ts'

const ARE_NOT_SET = 'lingtai-hook: LINGTAI_HOOK_SOCKET and LINGTAI_HOOK_RUN_ID are not set — refusing to allow anything'

const run = (spawnIt: SmokeSpawn, where: Parameters<typeof smokeTestFailClosedEffect>[1] = { cwd: '/w' }) =>
  Effect.runPromise(smokeTestFailClosedEffect('/bin/hook', where, spawnIt))

describe('smokeTestFailClosedEffect', () => {
  it('fails a hook that exited 2 having read nothing, and quotes what it said', async () => {
    const result = await run(() => Effect.succeed({ code: 2, stderr: ARE_NOT_SET }))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('are not set')
  })

  it('passes exit 2 with the socket path it was handed in stderr', async () => {
    const result = await run((_argv, env) =>
      Effect.succeed({ code: 2, stderr: `lingtai-hook: connect ENOENT ${env['LINGTAI_HOOK_SOCKET']}` }),
    )
    expect(result.ok).toBe(true)
  })

  it('fails any other exit', async () => {
    const result = await run(() => Effect.succeed({ code: 0, stderr: '' }))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('exited 0')
  })

  it('spawns in the cwd it was given, unwrapped, with the process environment', async () => {
    const seen: { argv: readonly string[]; cwd: string; home: string | undefined }[] = []
    await run((argv, env, cwd) => {
      seen.push({ argv, cwd, home: env['HOME'] })
      return Effect.succeed({ code: 2, stderr: env['LINGTAI_HOOK_SOCKET'] ?? '' })
    })
    expect(seen).toEqual([{ argv: ['/bin/hook'], cwd: '/w', home: process.env['HOME'] }])
  })

  it('spawns the wrapped argv with the wrapped environment only, in the cwd', async () => {
    const seen: { argv: readonly string[]; cwd: string; env: Record<string, string | undefined> }[] = []
    const result = await run(
      (argv, env, cwd) => {
        seen.push({ argv, cwd, env: { ...env } })
        return Effect.succeed({ code: 2, stderr: env['LINGTAI_HOOK_SOCKET'] ?? '' })
      },
      {
        cwd: '/w',
        wrap: (input) => Effect.succeed({ argv: ['/srt', ...input.command], env: { ...input.env, WRAPPED: '1' } }),
      },
    )
    expect(result.ok).toBe(true)
    expect(seen[0]?.argv).toEqual(['/srt', '/bin/hook'])
    expect(seen[0]?.cwd).toBe('/w')
    expect(seen[0]?.env['WRAPPED']).toBe('1')
    expect(seen[0]?.env['HOME']).toBeUndefined()
  })

  it('says a wrap that failed as the smoke test not running', async () => {
    const out = await Effect.runPromise(
      Effect.flip(
        smokeTestFailClosedEffect('/bin/hook', { cwd: '/w', wrap: () => Effect.fail({ message: 'no srt' }) }, () =>
          Effect.die('never spawned'),
        ),
      ),
    )
    expect(out).toMatchObject({ _tag: 'AgentHostFailed', operation: 'smokeTest', detail: 'no srt' })
  })
})
