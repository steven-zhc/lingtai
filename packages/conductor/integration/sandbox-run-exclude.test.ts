/**
 * The wrap's per-command exclude file (#1152): stand-ins plus the global ignore rules the *command's own*
 * environment resolves, in files of their own that are gone when the wrap's scope closes, applied to the
 * action's worktree alone and never through a symlink out of it. Touches the filesystem and `git`, so
 * integration (0060 §1).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type SandboxApi, type WrapInput } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeRunSandbox } from '../src/sandbox-decision.ts'

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lingtai-exclude-'))
  const mirror = join(dir, 'app.git')
  const seed = join(dir, 'seed')
  const worktree = join(dir, 'wt')
  execFileSync('git', ['init', '-q', seed])
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i'])
  execFileSync('git', ['clone', '-q', '--bare', seed, mirror])
  git(mirror, ['worktree', 'add', '-q', '--detach', worktree])
  const globalConfig = join(dir, 'gitconfig')
  writeFileSync(globalConfig, `[core]\n\texcludesFile = project-ignore\n`)
  const env = { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  const wraps: WrapInput[] = []
  const seen: { env: Record<string, string>; files: string[] }[] = []
  const service: SandboxApi = {
    hostCanSandbox: Effect.void,
    wrap: (input) => {
      wraps.push(input)
      seen.push({ env: input.env as Record<string, string>, files: [] })
      return Effect.succeed({ argv: ['/w'], env: {}, commandId: 'c' })
    },
  }
  const additions = { network: ['a.example'], write: ['/w'], deny: ['/d'] }
  const run = makeRunSandbox(service, { project: 'app', mirror, additions })
  return { dir, mirror, worktree, env, wraps, seen, run, additions }
}

describe('makeRunSandbox', () => {
  it('wraps with the pass’s project and mirror, applies the exclusions to this worktree only, and cleans up', async () => {
    const t = setup()
    writeFileSync(join(t.worktree, 'project-ignore'), '.env.local\n')
    mkdirSync(join(t.worktree, '.vscode'))
    writeFileSync(join(t.worktree, '.vscode', 'settings.json'), '{}')
    // A nested repository, as a submodule is: its own root, its own `/.vscode`.
    const sub = join(t.worktree, 'sub')
    mkdirSync(join(sub, '.vscode'), { recursive: true })
    execFileSync('git', ['init', '-q', sub])
    writeFileSync(join(sub, '.vscode', 'settings.json'), '{}')
    let env: Record<string, string> = {}
    await Effect.runPromise(
      Effect.scoped(
        t.run.wrap(['/bin/sh', '-c', 'pnpm test'], t.worktree, t.env).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              env = t.seen[0]!.env
              const text = readFileSync(env['GIT_CONFIG_VALUE_0']!.replace(/\.config$/, ''), 'utf8')
              expect(text).toContain('/.vscode\n')
              expect(text.endsWith('.env.local\n')).toBe(true)
              const cmd = { ...t.env, ...env }
              // This worktree: the stand-in name is excluded. The nested repository: it is not.
              expect(git(t.worktree, ['status', '--porcelain', '-uall', '--', '.vscode'], cmd)).toBe('')
              expect(git(sub, ['status', '--porcelain', '-uall'], cmd)).toContain('.vscode/settings.json')
            }),
          ),
        ),
      ),
    )
    expect(t.wraps[0]).toMatchObject({ project: 'app', worktree: t.worktree, mirror: t.mirror })
    expect(t.wraps[0]!.project_additions).toEqual(t.additions)
    expect(existsSync(env['GIT_CONFIG_VALUE_0']!)).toBe(false)
  })

  it('refuses a global ignore file in the worktree that is a symlink out of it, and copies nothing', async () => {
    const t = setup()
    const secret = join(t.dir, 'secret')
    writeFileSync(secret, 'TOP-SECRET\n')
    symlinkSync(secret, join(t.worktree, 'project-ignore'))
    const exit = await Effect.runPromise(
      Effect.scoped(t.run.wrap(['/bin/sh', '-c', 'x'], t.worktree, t.env)).pipe(Effect.result),
    )
    expect(exit._tag).toBe('Failure')
    expect(t.wraps).toEqual([])
    const info = join(t.mirror, 'info')
    const leaked = existsSync(info)
      ? readdirSync(info).filter((f) => readFileSync(join(info, f), 'utf8').includes('TOP-SECRET'))
      : []
    expect(leaked).toEqual([])
  })
})
