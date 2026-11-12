/**
 * `provisionWorktree`'s mirror writes wait for an in-flight write on the same
 * mirror and not for one on another (0122 §6, #1026). Unit: `git` and the
 * filesystem are mocked.
 */
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ list: [] as string[][], absent: false }))

vi.mock('../src/git.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/git.ts')>('../src/git.ts')
  const { Effect } = await import('effect')
  return {
    ...actual,
    // Lazy: a call is recorded when the Effect runs, not when it is built, since
    // `mirrorWrite(path, gitEffect(...))` builds it before the permit is taken.
    gitEffect: vi.fn((args: string[]) =>
      Effect.suspend(() => {
        calls.list.push([...args])
        if (args[0] === 'rev-parse' && args[1] === '--git-dir' && calls.absent) {
          calls.absent = false
          return Effect.fail(new actual.RepoFailed({ operation: 'git rev-parse', detail: 'not a repository' }))
        }
        return Effect.succeed('2'.repeat(40))
      }),
    ),
  }
})
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(() => Promise.resolve()),
  rm: vi.fn(() => Promise.resolve()),
  writeFile: vi.fn(() => Promise.resolve()),
}))

import { mirrorWrite } from '../src/mirror-lock.ts'
import { provisionWorktree } from '../src/worktree.ts'
import { ensureMirrorEffect } from '../src/worktree.ts'

const settle = () => new Promise((r) => setTimeout(r, 0))
const opts = (project: string) => ({
  project,
  owner: 'o',
  repo: 'r',
  base: 'main',
  branch: 'agent/1',
  runId: 'run',
  env: {},
  submodules: false,
  plantAt: '.env.local',
  home: '/h',
})

describe('provisionWorktree and the mirror permit', () => {
  beforeEach(() => {
    calls.list = []
    calls.absent = false
  })

  it('waits for a write held on its own mirror, not on another', async () => {
    let release!: () => void
    const held = Effect.runPromise(
      mirrorWrite(
        '/h/repos/p.git',
        Effect.promise(() => new Promise<void>((r) => (release = r))),
      ),
    )
    const other = provisionWorktree(opts('q'))
    await other
    expect(calls.list.some((c) => c[0] === 'worktree')).toBe(true)

    calls.list = []
    const blocked = provisionWorktree(opts('p'))
    await settle()
    expect(calls.list).toEqual([])
    release()
    await Promise.all([held, blocked])
    expect(calls.list.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(true)
  })

  it('clones an absent mirror once when two ensure it at once', async () => {
    calls.absent = true
    await Promise.all([
      Effect.runPromise(ensureMirrorEffect({ project: 'n', owner: 'o', repo: 'r', home: '/h' })),
      Effect.runPromise(ensureMirrorEffect({ project: 'n', owner: 'o', repo: 'r', home: '/h' })),
    ])
    expect(calls.list.filter((c) => c[0] === 'clone')).toHaveLength(1)
  })
})
