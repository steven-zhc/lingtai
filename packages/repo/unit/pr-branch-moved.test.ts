/**
 * A pr-fix lands on a PR's branch, which must still be what Lingtai last pushed there (0130 §5, #1341): the lane
 * compares the fetched base to `expectBase` before anything is merged or pushed. Against a fake git port.
 */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { RepoFailed } from '../src/git.ts'
import { integrateEffect } from '../src/integrate.ts'

const sha = '1'.repeat(40)

/** What `git merge-base --is-ancestor` exits with in the fake: 0 yes, 1 no, anything else is git failing. */
function fakeGit(ancestor: number = 0, fetched: string = sha, fork: string = fetched) {
  const calls: string[][] = []
  const git = (args: string[]): Effect.Effect<string, RepoFailed> => {
    calls.push(args)
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      return ancestor === 0
        ? Effect.succeed('')
        : Effect.fail(new RepoFailed({ operation: 'git', detail: 'no', command: args, exitCode: ancestor }))
    }
    if (args[0] === 'rev-parse' && args[1]?.endsWith('/base')) return Effect.succeed(fetched)
    if (args[0] === 'merge-base') return Effect.succeed(fork)
    if (args[0] === 'rev-parse') return Effect.succeed(sha)
    if (args[0] === 'rev-list') return Effect.succeed('1')
    return Effect.succeed('')
  }
  return { git, calls }
}

const land = (fake: ReturnType<typeof fakeGit>, expectBase?: string) =>
  Effect.runPromise(
    integrateEffect({
      project: 'p',
      owner: '',
      repo: 'p',
      base: 'feature-pr-1',
      branch: 'agent/1341',
      ticketId: 't',
      headSha: sha,
      stepsPassed: true,
      home: '/fake-home',
      store: createMemoryEventStore(),
      git: fake.git,
      ...(expectBase === undefined ? {} : { expectBase }),
    }),
  )

describe('the lane lands on a PR branch that still holds what Lingtai last pushed', () => {
  const moved = 'f'.repeat(40)
  it('refuses pr-branch-moved when the expected head is no longer in the fetched base, and merges and pushes nothing', async () => {
    const fake = fakeGit(1)
    const result = await land(fake, moved)
    expect(result).toMatchObject({ ok: false, reason: 'pr-branch-moved' })
    expect(JSON.stringify(result)).toContain(moved)
    expect(fake.calls.some((a) => a[0] === 'merge' || a[0] === 'push' || a[0] === 'worktree')).toBe(false)
  })

  it('fails, rather than land, when git cannot say whether the expected head is in the history', async () => {
    const fake = fakeGit(128)
    expect(await land(fake, moved)).toMatchObject({ ok: false, reason: 'unexpected' })
    expect(fake.calls.some((a) => a[0] === 'push')).toBe(false)
  })

  it('lands on the fetched base when others pushed on top of the expected head, leasing the push to what it fetched', async () => {
    const fetched = 'e'.repeat(40)
    // The ticket forked from `moved`; the base is now `fetched`, on top of it: merge-base stays at the fork.
    const fake = fakeGit(0, fetched, moved)
    const result = await land(fake, moved)
    expect(result).not.toMatchObject({ reason: 'pr-branch-moved' })
    expect(result).not.toMatchObject({ reason: 'base-moved' })
    const push = fake.calls.find((a) => a[0] === 'push')
    expect(push).toContain(`--force-with-lease=refs/heads/feature-pr-1:${fetched}`)
  })

  it('goes on past the check when the base is where it was expected', async () => {
    const fake = fakeGit()
    const result = await land(fake, sha)
    expect(result).not.toMatchObject({ reason: 'pr-branch-moved' })
  })

  it('has no such check without an expected base', async () => {
    const fake = fakeGit()
    const result = await land(fake)
    const moved = 'f'.repeat(40)
    expect(result).not.toMatchObject({ reason: 'pr-branch-moved' })
    expect(fake.calls.some((a) => a[1] === '--is-ancestor' && a[2] === moved)).toBe(false)
    expect(fake.calls.find((a) => a[0] === 'push')?.some((x) => x.startsWith('--force-with-lease'))).toBeFalsy()
  })
})
