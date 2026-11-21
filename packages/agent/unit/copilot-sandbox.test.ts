/** A sandboxed Copilot run (#1301): the wrapped argv, the token, the policy additions, every refusal by name. */
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import type { WrapInput } from '@lingtai/sandbox'
import { Effect, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import { acpRun, type AcpOptions } from '../src/acp.ts'
import type { RunSandbox } from '../src/claude-sandbox.ts'
import { CLASSIC_COPILOT_TOKEN_SENTENCE, COPILOT_NETWORK, NO_COPILOT_TOKEN_SENTENCE } from '../src/copilot-sandbox.ts'
import type { RunRequest } from '../src/runtime.ts'

const TOKEN = 'github_pat_FAKE_1301'

const harness = (ports: { token?: string | null | 'throws' } = {}, over: Partial<RunSandbox> = {}) => {
  const wrapped: WrapInput[] = []
  const spawned: Array<{ command: string; args: readonly string[]; env: Record<string, string> }> = []
  const sandbox: RunSandbox = {
    decision: { kind: 'sandboxed', project_additions: { write: ['/extra'] } },
    project: 'p',
    mirror: '/state/repos/p.git',
    cache: '/state/cache/p',
    worktree: '/work/tree',
    runDir: '/state/runs/r1/claude',
    operatorClaudeDir: '/home/op/.claude',
    hostHome: '/home/op',
    codexNamed: false,
    read: ['/bundle/lingtai-hook'],
    wrap: (input) =>
      Effect.sync(() => {
        wrapped.push(input)
        return { argv: ['/usr/bin/srt', '--', ...input.command], env: { ...input.env, XDG: 'x' }, commandId: 'c1' }
      }),
    ...over,
  }
  const options: AcpOptions = {
    binary: 'copilot',
    spawn: ((command: string, args: readonly string[], o: { env: Record<string, string> }) => {
      spawned.push({ command, args, env: o.env })
      const c = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      })
      setImmediate(() => c.emit('exit', 1, null))
      return c as unknown as ChildProcess
    }) as unknown as AcpOptions['spawn'] & object,
    hook: () => Promise.resolve({ allow: true }),
    signalGroup: () => {},
    cancelWaitMs: 20,
    killWaitMs: 20,
    sandbox: {
      githubToken: () => {
        if (ports.token === 'throws') throw new Error('/x/config.yml could not be read or parsed')
        return ports.token === null ? undefined : Redacted.make(ports.token ?? TOKEN)
      },
      readCodexPermissions: () => ({ kind: 'none' }),
    },
  }
  const request: RunRequest = {
    runId: 'r1',
    cwd: '/work/tree',
    prompt: 'go',
    settingsPath: '/x/settings.json',
    env: {
      LINGTAI_HOOK_SOCKET: '/tmp/hook.sock',
      LINGTAI_HOOK_RUN_ID: 'r1',
      HOME: '/home/agent',
      GH_TOKEN: 'gho_PERSONAL',
      GITHUB_TOKEN: 'gho_PERSONAL2',
    },
    limits: { wallMs: 5_000 },
    sandbox,
  } as RunRequest
  return { options, request, wrapped, spawned }
}

describe('a sandboxed Copilot run', () => {
  it('spawns the wrapped argv and never `copilot` itself', async () => {
    const h = harness()
    await Effect.runPromise(acpRun(h.options, h.request))
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.command).toBe('/usr/bin/srt')
    expect(h.wrapped[0]!.command).toEqual(['copilot', '--acp', '--no-sandbox'])
  })

  it('holds the network and the write path, and the env has the token and no personal one', async () => {
    const h = harness()
    await Effect.runPromise(acpRun(h.options, h.request))
    const input = h.wrapped[0]!
    expect(input.caller_additions?.network).toEqual([...COPILOT_NETWORK])
    expect(input.caller_additions?.write).toEqual(['/home/agent/.copilot'])
    expect(input.env['COPILOT_GITHUB_TOKEN']).toBe(TOKEN)
    expect(input.env['GH_TOKEN']).toBeUndefined()
    expect(input.env['GITHUB_TOKEN']).toBeUndefined()
    expect(h.spawned[0]!.env['COPILOT_GITHUB_TOKEN']).toBe(TOKEN)
  })

  it('an unsandboxed run is untouched: no wrap, no flag, no token', async () => {
    const h = harness()
    const { sandbox: _sandbox, ...bare } = h.request
    await Effect.runPromise(acpRun(h.options, bare as RunRequest))
    expect(h.wrapped).toEqual([])
    expect(h.spawned[0]!.command).toBe('copilot')
    expect(h.spawned[0]!.args).not.toContain('--no-sandbox')
    expect(h.spawned[0]!.env['COPILOT_GITHUB_TOKEN']).toBeUndefined()
  })

  it.each([
    ['no token', { token: null }, NO_COPILOT_TOKEN_SENTENCE],
    ['a classic token', { token: 'ghp_CLASSIC' }, CLASSIC_COPILOT_TOKEN_SENTENCE],
    ['an unreadable file', { token: 'throws' as const }, '/x/config.yml could not be read or parsed'],
  ])('is refused by name before spawn: %s', async (_name, ports, sentence) => {
    const h = harness(ports)
    const outcome = await Effect.runPromise(acpRun(h.options, h.request))
    expect(outcome.failure).toEqual({ kind: 'crash', detail: sentence })
    expect(h.spawned).toEqual([])
    expect(JSON.stringify(outcome)).not.toContain('ghp_CLASSIC')
  })

  it('is refused when the host has no sandbox', async () => {
    const h = harness({}, { decision: { kind: 'refused', why: 'no srt' } })
    const outcome = await Effect.runPromise(acpRun(h.options, h.request))
    expect(outcome.failure?.kind).toBe('crash')
    expect(outcome.failure?.detail).toContain('no srt')
    expect(h.spawned).toEqual([])
  })

  it('is refused when it has no HOME to name its Copilot home from', async () => {
    const h = harness()
    const request = { ...h.request, env: { ...h.request.env, HOME: '' } } as RunRequest
    const outcome = await Effect.runPromise(acpRun(h.options, request))
    expect(outcome.failure?.detail).toContain('no HOME')
    expect(h.spawned).toEqual([])
  })
})
