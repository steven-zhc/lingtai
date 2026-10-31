/**
 * The land asks a local remote what it has checked out before it fetches or
 * pushes (0104 §15). Against a fake git port: a real non-bare checkout with a
 * linked worktree is integration (0060 §1).
 */
import { diagnoseRefusal } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { RepoFailed } from '../src/git.ts'
import { checkedOutAt, integrate, isLocalRemote } from '../src/integrate.ts'

const REMOTE = '/Users/me/code/app'
const sha = '1'.repeat(40)

const porcelain = (branch: string) =>
  `worktree ${REMOTE}\nHEAD ${sha}\nbranch refs/heads/main\n\nworktree /tmp/linked\nHEAD ${sha}\nbranch refs/heads/${branch}\n`

function fakeGit(listing: () => Effect.Effect<string, RepoFailed>) {
  const calls: string[][] = []
  const remoteReads: string[][] = []
  const git = (args: string[], options: { cwd?: string }): Effect.Effect<string, RepoFailed> => {
    calls.push(args)
    if (args[0] === 'worktree' && args[1] === 'list' && options.cwd === REMOTE) {
      remoteReads.push(args)
      return listing()
    }
    if (args[0] === 'rev-parse') return Effect.succeed(sha)
    if (args[0] === 'rev-list') return Effect.succeed('1')
    return Effect.succeed('')
  }
  return { git, calls, remoteReads }
}

const land = (fake: ReturnType<typeof fakeGit>, over: { base?: string; remote?: string } = {}) =>
  integrate({
    project: 'p',
    owner: '',
    repo: 'p',
    base: over.base ?? 'lingtai-base',
    branch: 'agent/771',
    ticketId: 't',
    headSha: '0'.repeat(40),
    stepsPassed: true,
    home: '/fake-home',
    store: createMemoryEventStore(),
    git: fake.git,
    remote: over.remote ?? REMOTE,
    issue: '771',
  })

const ran = (fake: ReturnType<typeof fakeGit>, cmd: string) => fake.calls.some((a) => a[0] === cmd)

describe('checkedOutAt', () => {
  it('finds the base in a linked worktree, not only the first block', () => {
    expect(checkedOutAt(porcelain('lingtai-base'), 'lingtai-base')).toMatchObject({ dir: '/tmp/linked' })
  })
  it('compares the whole ref, never a prefix', () => {
    expect(checkedOutAt(porcelain('lingtai-base-2'), 'lingtai-base')).toBeNull()
  })
  it('never hits a bare repository', () => {
    expect(checkedOutAt(`worktree ${REMOTE}\nbare\n`, 'main')).toBeNull()
  })
  it('is unreadable without a worktree line', () => {
    expect(checkedOutAt('', 'main')).toBe('unreadable')
    expect(checkedOutAt('garbage', 'main')).toBe('unreadable')
  })
})

describe('isLocalRemote', () => {
  it('is false for URLs and scp-like addresses', () => {
    for (const r of ['https://github.com/a/b', 'file:///tmp/x', 'git@host:a/b.git', 'buildhost:repos/app.git'])
      expect(isLocalRemote(r)).toBe(false)
    expect(isLocalRemote('/tmp/x')).toBe(true)
  })
})

describe('the land into a local remote', () => {
  it('holds when the base is checked out, and neither fetches nor pushes', async () => {
    const fake = fakeGit(() => Effect.succeed(porcelain('lingtai-base')))
    const result = await land(fake)
    expect(result).toMatchObject({ ok: false, reason: 'base-checked-out' })
    expect(ran(fake, 'push')).toBe(false)
    expect(ran(fake, 'fetch')).toBe(false)
    if (result.ok) throw new Error('unreachable')
    const diagnosis = diagnoseRefusal({
      reason: result.reason,
      detail: result.detail,
      branch: 'agent/771',
      base: 'lingtai-base',
    })
    expect(diagnosis.what).toBe(
      'lingtai-base is checked out in /tmp/linked — switch to another branch, then lingtai approve p --issue 771',
    )
    expect(diagnosis.recommendation?.action).toBe('approve')
  })

  it('names whatever the base is', async () => {
    const fake = fakeGit(() => Effect.succeed(porcelain('main')))
    const result = await land(fake, { base: 'main' })
    expect(result).toMatchObject({ ok: false, reason: 'base-checked-out' })
    if (!result.ok) expect(result.detail.startsWith(`main is checked out in ${REMOTE} `)).toBe(true)
  })

  it('proceeds to the push for a bare remote and for a URL', async () => {
    const bare = fakeGit(() => Effect.succeed(`worktree ${REMOTE}\nbare\n`))
    expect((await land(bare)).ok).toBe(true)
    expect(ran(bare, 'push')).toBe(true)

    const url = fakeGit(() => Effect.fail(new RepoFailed({ operation: 'x', detail: 'never asked' })))
    expect((await land(url, { remote: 'https://github.com/a/b' })).ok).toBe(true)
    expect(url.remoteReads).toEqual([])
  })

  it('refuses as unexpected, pushing nothing, when the read fails or is empty', async () => {
    const failing = fakeGit(() =>
      Effect.fail(new RepoFailed({ operation: 'git worktree', detail: 'not a repository' })),
    )
    expect(await land(failing)).toMatchObject({ ok: false, reason: 'unexpected' })
    expect(ran(failing, 'push')).toBe(false)

    const empty = fakeGit(() => Effect.succeed('nothing here'))
    expect(await land(empty)).toMatchObject({ ok: false, reason: 'unexpected' })
    expect(ran(empty, 'push')).toBe(false)
  })
})
