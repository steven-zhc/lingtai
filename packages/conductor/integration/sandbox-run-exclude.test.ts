/**
 * The wrap's per-command exclude file (#1152): stand-ins plus the global ignore rules the *command's own*
 * environment resolves, in a file of its own that is gone when the wrap's scope closes. Touches the filesystem
 * and `git`, so integration (0060 §1).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type SandboxApi, type WrapInput } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeRunSandbox } from '../src/sandbox-decision.ts'

describe('makeRunSandbox', () => {
  it('wraps with the pass’s project and mirror, and hands the command its own exclude file, read from its own environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingtai-exclude-'))
    const mirror = join(dir, 'app.git')
    const worktree = join(dir, 'wt')
    mkdirSync(worktree)
    // Relative: read against the action's worktree, not the daemon's directory.
    const projectIgnore = join(worktree, 'project-ignore')
    execFileSync('git', ['init', '--bare', mirror])
    writeFileSync(projectIgnore, '.env.local\n')
    const wraps: WrapInput[] = []
    const service: SandboxApi = {
      hostCanSandbox: Effect.void,
      wrap: (input) => {
        wraps.push(input)
        // Read while the scope is open, as the command would.
        const text = readFileSync(input.env!['GIT_CONFIG_VALUE_0']!, 'utf8')
        expect(text).toContain('/.vscode\n')
        expect(text.endsWith('.env.local\n')).toBe(true)
        return Effect.succeed({ argv: ['/w'], env: {}, commandId: 'c' })
      },
    }
    const additions = { network: ['a.example'], write: ['/w'], deny: ['/d'] }
    const run = makeRunSandbox(service, { project: 'app', mirror, additions })
    // The action's own global config, not the daemon's: it names the project's ignore file.
    const globalConfig = join(dir, 'gitconfig')
    writeFileSync(globalConfig, `[core]\n\texcludesFile = project-ignore\n`)
    const env = { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
    let file = ''
    await Effect.runPromise(
      Effect.scoped(
        run
          .wrap(['/bin/sh', '-c', 'pnpm test'], worktree, env)
          .pipe(Effect.tap(() => Effect.sync(() => (file = wraps[0]!.env!['GIT_CONFIG_VALUE_0']!)))),
      ),
    )
    expect(wraps[0]).toMatchObject({ project: 'app', worktree, mirror, project_additions: additions })
    expect(file).toContain(join(mirror, 'info', 'lingtai-sandbox-exclude-'))
    expect(existsSync(file)).toBe(false)
  })
})
