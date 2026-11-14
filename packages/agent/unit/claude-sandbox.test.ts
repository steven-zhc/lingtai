/** A sandboxed Claude Code run (#1150): wrapped argv and env, the token, the carried denies, every refusal by name. */
import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import type { WrapInput } from '@lingtai/sandbox'
import { Effect, Redacted } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { claudeCodeRun } from '../src/claude-code.ts'
import type { RunDirFs } from '../src/claude-run-dir.ts'
import { NO_TOKEN_SENTENCE, type RunSandbox, type SandboxPorts } from '../src/claude-sandbox.ts'
import type { UserPermissions } from '../src/codex.ts'
import type { RunRequest } from '../src/runtime.ts'

const TOKEN = 'sk-ant-oat01-FAKE-1150'
const err = (code: string) => Object.assign(new Error(code), { code })

/** A source with only a `CLAUDE.md`; everything written is recorded. */
const fakeFs = () => {
  const written: string[] = []
  const removed: string[] = []
  const stat = (file: boolean) => ({ isDirectory: () => !file, isFile: () => file, isSymbolicLink: () => false })
  const fs: RunDirFs = {
    lstat: (p) => (p.endsWith('/CLAUDE.md') ? Effect.succeed(stat(true)) : Effect.fail(err('ENOENT'))),
    stat: (p) => (p.endsWith('/CLAUDE.md') ? Effect.succeed(stat(true)) : Effect.fail(err('ENOENT'))),
    realpath: (p) => Effect.succeed(p),
    readdir: () => Effect.succeed([]),
    readFile: () => Effect.succeed(new Uint8Array()),
    writeFile: (p) => Effect.sync(() => void written.push(p)),
    mkdir: () => Effect.void,
    rm: (p) => Effect.sync(() => void removed.push(p)),
  }
  return { fs, written, removed }
}

const child = () => {
  const c = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
  setImmediate(() => c.emit('close', 0))
  return c
}

const harness = (
  over: Partial<RunSandbox> = {},
  ports: { token?: string | null; settings?: string | null; profile?: UserPermissions } = {},
) => {
  const wrapped: WrapInput[] = []
  const spawned: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = []
  const files = fakeFs()
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
  const request: RunRequest = {
    runId: 'r1',
    cwd: '/work/tree',
    prompt: 'do it',
    settingsPath: '/state/runs/r1/settings.json',
    env: { KEEP: '1' },
    limits: { wallMs: 60_000 },
    sandbox,
  }
  const ports2: { -readonly [K in keyof SandboxPorts]-?: SandboxPorts[K] } = {
    oauthToken: () => (ports.token === null ? undefined : Redacted.make(ports.token ?? TOKEN)),
    runDirFs: files.fs,
    readOperatorSettings: () => Effect.succeed(ports.settings === undefined ? null : ports.settings),
    readCodexPermissions: () => ports.profile ?? { kind: 'none' },
  }
  const options = {
    binary: 'claude',
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawned.push({ command, args, options })
      return child()
    }) as unknown as typeof spawn,
    sandbox: ports2 as SandboxPorts,
  }
  return { request, options, ports: ports2, wrapped, spawned, files }
}

describe('a sandboxed Claude Code run (#1150)', () => {
  it('is spawned from wrap argv and env, shell off, with the token and config dir', async () => {
    const h = harness(
      {},
      { settings: JSON.stringify({ sandbox: { filesystem: { denyRead: ['~/secret', '/abs/x'] } } }) },
    )
    const outcome = await Effect.runPromise(claudeCodeRun(h.options, h.request))
    expect(outcome.failure?.detail).not.toContain(TOKEN)

    expect(h.wrapped).toHaveLength(1)
    const input = h.wrapped[0]!
    expect(input.command[0]).toBe('claude')
    expect(input.env).toMatchObject({
      KEEP: '1',
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      CLAUDE_CONFIG_DIR: '/state/runs/r1/claude',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    })
    expect(input.caller_additions).toEqual({
      write: ['/state/runs/r1/claude'],
      read: [
        '/state/runs/r1/settings.json',
        '/bundle/lingtai-hook',
        '/state/runs/r1/claude/settings.json',
        '/state/runs/r1/claude/CLAUDE.md',
      ],
      deny: ['/home/op/secret', '/abs/x'],
    })
    expect(input.project_additions).toEqual({ write: ['/extra'] })

    expect(h.spawned).toHaveLength(1)
    const s = h.spawned[0]!
    expect(s.command).toBe('/usr/bin/srt')
    expect(s.args.slice(0, 2)).toEqual(['--', 'claude'])
    expect(s.options.env).toMatchObject({ XDG: 'x', CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    expect(s.options.shell).toBeUndefined()
    // The directory is the run's own and is removed when the run ends.
    expect(h.files.removed).toEqual(['/state/runs/r1/claude'])
  })

  it('a refused decision fails before anything is read, wrapped or spawned', async () => {
    const h = harness({ decision: { kind: 'refused', why: 'no srt' } })
    const wrap = vi.fn(h.request.sandbox!.wrap)
    h.request.sandbox = { ...h.request.sandbox!, wrap }
    const outcome = await Effect.runPromise(claudeCodeRun(h.options, h.request))
    expect(outcome.failure).toEqual({ kind: 'crash', detail: 'sandbox required and unavailable on this host: no srt' })
    expect(wrap).not.toHaveBeenCalled()
    expect(h.spawned).toHaveLength(0)
  })

  it('a wrap failure is a crash carrying its sentences, and spawns nothing', async () => {
    const h = harness({ wrap: () => Effect.fail({ message: 'bwrap missing; install it' }) })
    const outcome = await Effect.runPromise(claudeCodeRun(h.options, h.request))
    expect(outcome.failure).toEqual({ kind: 'crash', detail: 'bwrap missing; install it' })
    expect(h.spawned).toHaveLength(0)
    expect(h.files.removed).toEqual(['/state/runs/r1/claude'])
  })

  it('an absent token refuses by name, spawns nothing, and the token is nowhere in the outcome', async () => {
    const h = harness({}, { token: null })
    const outcome = await Effect.runPromise(claudeCodeRun(h.options, h.request))
    expect(outcome.failure).toEqual({ kind: 'crash', detail: NO_TOKEN_SENTENCE })
    expect(h.spawned).toHaveLength(0)
    expect(h.wrapped).toHaveLength(0)

    const ok = harness()
    const done = await Effect.runPromise(claudeCodeRun(ok.options, ok.request))
    expect(JSON.stringify(done)).not.toContain(TOKEN)
  })

  it.each([
    ['not JSON', '{nope', 'is not JSON'],
    ['a non-string entry', JSON.stringify({ sandbox: { filesystem: { denyRead: [3] } } }), 'is not a string'],
    ['a relative entry', JSON.stringify({ sandbox: { filesystem: { denyRead: ['rel/x'] } } }), 'not an absolute path'],
    ['one over the worktree', JSON.stringify({ sandbox: { filesystem: { denyRead: ['/work'] } } }), 'would be voided'],
    [
      'one inside the mirror',
      JSON.stringify({ sandbox: { filesystem: { denyRead: ['/state/repos/p.git/x'] } } }),
      'would be voided',
    ],
    [
      'one over the run directory',
      JSON.stringify({ sandbox: { filesystem: { denyRead: ['/state/runs'] } } }),
      'would be voided',
    ],
  ])('refuses by name: %s', async (_name, settings, sentence) => {
    const h = harness({}, { settings })
    const outcome = await Effect.runPromise(claudeCodeRun(h.options, h.request))
    expect(outcome.failure?.kind).toBe('crash')
    expect(outcome.failure?.detail).toContain(sentence)
    expect(outcome.failure?.detail).not.toContain(TOKEN)
    expect(h.spawned).toHaveLength(0)
  })

  it('an unreadable operator settings file refuses by name', async () => {
    const h = harness()
    h.ports.readOperatorSettings = () => Effect.fail(err('EACCES'))
    const outcome = await Effect.runPromise(claudeCodeRun(h.options, h.request))
    expect(outcome.failure?.detail).toContain('/home/op/.claude/settings.json could not be read')
  })

  it('without a sandbox on the request the run is today’s', async () => {
    const h = harness()
    delete h.request.sandbox
    h.request.env = { KEEP: '1' }
    await Effect.runPromise(claudeCodeRun(h.options, h.request))
    expect(h.wrapped).toHaveLength(0)
    expect(h.spawned[0]!.command).toBe('claude')
    expect(h.spawned[0]!.options.env).toEqual({ KEEP: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' })
  })
})

describe("the operator's Codex profile on a Claude Code run (#1155)", () => {
  it('puts the profile denies on caller_additions.deny beside the settings denies', async () => {
    const h = harness(
      {},
      {
        settings: JSON.stringify({ sandbox: { filesystem: { denyRead: ['/abs/x'] } } }),
        profile: { kind: 'denies', paths: ['~/secrets', '/abs/y'] },
      },
    )
    await Effect.runPromise(claudeCodeRun(h.options, { ...h.request, env: { HOME: '/home/op' } }))
    expect(h.wrapped[0]!.caller_additions?.deny).toEqual(['/abs/x', '/home/op/secrets', '/abs/y'])
  })

  it('refuses an unreadable profile before wrap when the recipe names Codex', async () => {
    const h = harness({ codexNamed: true }, { profile: { kind: 'unreadable', why: 'bad toml' } })
    const outcome = await Effect.runPromise(claudeCodeRun(h.options, h.request))
    expect(h.wrapped).toHaveLength(0)
    expect(h.spawned).toHaveLength(0)
    expect(outcome.failure?.detail).toContain('bad toml')
  })

  it('goes ahead without the denies, and says so, when the recipe names no Codex', async () => {
    const h = harness({ codexNamed: false }, { profile: { kind: 'unreadable', why: 'bad toml' } })
    const notes: string[] = []
    const log = { note: (_k: string, line: string) => void notes.push(line) } as unknown as RunRequest['log']
    await Effect.runPromise(claudeCodeRun(h.options, { ...h.request, log }))
    expect(h.wrapped).toHaveLength(1)
    expect(h.wrapped[0]!.caller_additions?.deny).toEqual([])
    expect(notes.join('\n')).toContain("the operator's Codex profile could not be read: ")
  })

  it('refuses a deny that is, lies inside or contains the worktree', async () => {
    for (const path of ['/work/tree', '/work/tree/sub', '/work', '/state/cache/p']) {
      const h = harness({}, { profile: { kind: 'denies', paths: [path] } })
      await Effect.runPromise(claudeCodeRun(h.options, h.request))
      expect(h.wrapped, path).toHaveLength(0)
    }
  })
})
