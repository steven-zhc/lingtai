/**
 * The git of a PR's merges, against a fake git port (#1312): unmerged paths are read NUL-split and the merge is
 * aborted; a failed merge with no unmerged path is `failed`, never a conflict; the worktree is never `integrator-…`;
 * and the sweep takes the PR worktrees and only them.
 */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { RepoFailed } from '../src/git.ts'
import { type GitPort, mergeInWorktree, sweepPrWorktrees } from '../src/pr-sync.ts'

const HOME = '/nonexistent-lingtai-home'
const WT = `${HOME}/worktrees/p`

function fakeGit(
  opts: { failMerge?: boolean; unmerged?: string; porcelain?: string; failWorktreeAdd?: boolean } = {},
): { port: GitPort; calls: string[][] } {
  const calls: string[][] = []
  const port: GitPort = (args) => {
    calls.push([...args])
    if (args[0] === 'worktree' && args[1] === 'add' && opts.failWorktreeAdd) {
      return Effect.fail(new RepoFailed({ operation: 'git worktree', detail: 'fatal: cannot add' }))
    }
    if (args[0] === 'merge' && args[1] !== '--abort' && opts.failMerge) {
      return Effect.fail(new RepoFailed({ operation: 'git merge', detail: 'CONFLICT or something', exitCode: 1 }))
    }
    if (args[0] === 'diff') return Effect.succeed(opts.unmerged ?? '')
    if (args[0] === 'rev-parse') return Effect.succeed('9'.repeat(40) + '\n')
    if (args[0] === 'worktree' && args[1] === 'list') return Effect.succeed(opts.porcelain ?? '')
    return Effect.succeed('')
  }
  return { port, calls }
}

const merge = (git: GitPort, name = 'pr-sync-1-100') =>
  Effect.runPromise(
    mergeInWorktree({ project: 'p', home: HOME, name, at: 'a', theirs: 'b', message: 'Merge b into a', git }),
  )

describe('mergeInWorktree', () => {
  it('cuts a detached worktree at the start commit, merges --no-ff, answers the merge, and releases the worktree', async () => {
    const { port, calls } = fakeGit()
    expect(await merge(port)).toEqual({ kind: 'merged', sha: '9'.repeat(40) })
    const add = calls.find((c) => c[0] === 'worktree' && c[1] === 'add')!
    expect(add.slice(0, 4)).toEqual(['worktree', 'add', '--force', '--detach'])
    expect(add[4]).toContain('/pr-sync-1-100')
    expect(add[4]).not.toContain('integrator-')
    expect(add[5]).toBe('a')
    expect(calls.find((c) => c[0] === 'merge')).toEqual(['merge', '--no-ff', '--no-edit', '-m', 'Merge b into a', 'b'])
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true)
    // Nothing here pushes.
    expect(calls.some((c) => c[0] === 'push')).toBe(false)
  })

  it('a conflict reads the unmerged paths NUL-split, aborts the merge, and still releases the worktree', async () => {
    const { port, calls } = fakeGit({ failMerge: true, unmerged: 'a.ts\0dir/with space.ts\0' })
    expect(await merge(port)).toEqual({ kind: 'conflict', paths: ['a.ts', 'dir/with space.ts'] })
    expect(calls.find((c) => c[0] === 'diff')).toEqual(['diff', '--name-only', '--diff-filter=U', '-z'])
    expect(calls.some((c) => c[0] === 'merge' && c[1] === '--abort')).toBe(true)
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true)
  })

  it('a failed merge with no unmerged path is git failing, never a conflict', async () => {
    const { port } = fakeGit({ failMerge: true, unmerged: '' })
    expect(await merge(port)).toEqual({ kind: 'failed', text: 'CONFLICT or something' })
  })

  it('a worktree that will not cut is failed with git’s text and nothing is merged', async () => {
    const { port, calls } = fakeGit({ failWorktreeAdd: true })
    expect(await merge(port)).toEqual({ kind: 'failed', text: 'fatal: cannot add' })
    expect(calls.some((c) => c[0] === 'merge')).toBe(false)
  })
})

describe('sweepPrWorktrees', () => {
  it('removes every pr-sync-* and pr-back-* worktree, whatever its age, and leaves the lane’s and the person’s', async () => {
    const wt = (dir: string) => `worktree ${dir}\nHEAD abc\ndetached\n`
    const { port, calls } = fakeGit({
      porcelain: [
        wt('/h/repos/p.git'),
        wt('/Users/me/src/pr-sync-debug'),
        wt(`${WT}/pr-sync-1-100`),
        wt(`${WT}/pr-back-1-200`),
        wt(`${WT}/integrator-main-1-abc`),
        wt(`${WT}/base-abcdef0-r1`),
      ].join('\n'),
    })
    await Effect.runPromise(sweepPrWorktrees({ project: 'p', home: HOME, git: port }))
    const removed = calls.filter((c) => c[0] === 'worktree' && c[1] === 'remove').map((c) => c[3])
    expect(removed).toEqual([`${WT}/pr-sync-1-100`, `${WT}/pr-back-1-200`])
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'prune')).toBe(true)
  })
})
