import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { createClaudeCodeRuntime } from '../src/claude-code.ts'
import { createCodexRuntime } from '../src/codex.ts'
import { runtimeVersionOf, type Runtime } from '../src/runtime.ts'

/** A spawn that prints `out` and exits 0, recording what it was asked to start. */
function fakeSpawn(out: string) {
  const calls: { binary: string; args: readonly string[]; env: unknown }[] = []
  const fn = ((binary: string, args: readonly string[], options: { env?: unknown }) => {
    calls.push({ binary, args, env: options.env })
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true,
    })
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(out))
      child.emit('close', 0, null)
    })
    return child
  }) as unknown as typeof spawn
  return { fn, calls }
}

describe('Runtime.version (#929)', () => {
  it('claude-code spawns its binary with --version and the env run spawns with', async () => {
    const s = fakeSpawn('2.1.318 (Claude Code)\n')
    const runtime = createClaudeCodeRuntime({ binary: 'claude-x', spawn: s.fn })
    expect(await runtime.version!({ PATH: '/p' })).toBe('2.1.318 (Claude Code)')
    expect(s.calls).toEqual([
      {
        binary: 'claude-x',
        args: ['--version'],
        env: { PATH: '/p', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
      },
    ])
  })

  it('codex spawns its binary with --version and the env as given', async () => {
    const s = fakeSpawn('codex-cli 0.164.0\n')
    const runtime = createCodexRuntime({ binary: 'codex-x', spawn: s.fn })
    expect(await runtime.version!({ PATH: '/q' })).toBe('codex-cli 0.164.0')
    expect(s.calls).toEqual([{ binary: 'codex-x', args: ['--version'], env: { PATH: '/q' } }])
  })
})

describe('runtimeVersionOf', () => {
  const bare = { capabilities: {} } as unknown as Runtime
  it('is null for a runtime with no version, and never rejects', async () => {
    expect(await runtimeVersionOf(bare, {})).toBeNull()
    const rejecting = { ...bare, version: () => Promise.reject(new Error('boom')) } as Runtime
    expect(await runtimeVersionOf(rejecting, {})).toBeNull()
    const throwing = {
      ...bare,
      version: () => {
        throw new Error('sync')
      },
    } as Runtime
    expect(await runtimeVersionOf(throwing, {})).toBeNull()
  })
  it('passes the env through and returns the answer', async () => {
    const seen: unknown[] = []
    const r = { ...bare, version: async (env: Record<string, string>) => (seen.push(env), 'fake 1') } as Runtime
    expect(await runtimeVersionOf(r, { A: 'b' })).toBe('fake 1')
    expect(seen).toEqual([{ A: 'b' }])
  })
})
