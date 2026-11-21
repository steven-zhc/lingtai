/**
 * A pr-fix lands on a PR's branch, which must still be what Lingtai last pushed there (0130 §5, #1341): the lane
 * compares the fetched base to `expectBase` before anything is merged or pushed. Against a fake git port.
 */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { RepoFailed } from '../src/git.ts'
import { integrateEffect } from '../src/integrate.ts'

const sha = '1'.repeat(40)

function fakeGit() {
  const calls: string[][] = []
  const git = (args: string[]): Effect.Effect<string, RepoFailed> => {
    calls.push(args)
    if (args[0] === 'rev-parse' || args[0] === 'merge-base') return Effect.succeed(sha)
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

describe('the lane lands on a PR branch only where Lingtai last pushed it', () => {
  it('refuses pr-branch-moved when the fetched base is not the expected one, and merges and pushes nothing', async () => {
    const fake = fakeGit()
    const moved = 'f'.repeat(40)
    const result = await land(fake, moved)
    expect(result).toMatchObject({ ok: false, reason: 'pr-branch-moved' })
    expect(JSON.stringify(result)).toContain(`expected ${moved} found ${sha}`)
    expect(fake.calls.some((a) => a[0] === 'merge' || a[0] === 'push' || a[0] === 'worktree')).toBe(false)
  })

  it('goes on past the check when the base is where it was expected', async () => {
    const fake = fakeGit()
    const result = await land(fake, sha)
    expect(result).not.toMatchObject({ reason: 'pr-branch-moved' })
  })

  it('has no such check without an expected base', async () => {
    const result = await land(fakeGit())
    expect(result).not.toMatchObject({ reason: 'pr-branch-moved' })
  })
})
