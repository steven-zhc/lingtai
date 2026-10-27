/**
 * The merge lane's fetch, against a fake git port rather than a real mirror.
 *
 * #438: the lane used to fetch the attempt's branch into the mirror's own
 * `refs/heads/<branch>`, which git refuses whenever that branch is checked out
 * in some other worktree of the same mirror — which an agent that ran
 * `git checkout agent/<n>` in its own worktree does. This is the case the
 * 803-second real-git suite (`integration/integrate.test.ts`) cannot run as
 * part of a pass: it asserts the fetch's destinations instead, which is what
 * stands in for a real worktree collision until that suite runs.
 */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { RepoFailed } from '../src/git.ts'
import { integrate } from '../src/integrate.ts'

const PROJECT = 'lane-fixture'
const BASE = 'main'
const BRANCH = 'agent/438'

/** Every git call the lane made, in order. */
type Call = { args: string[]; cwd: string }

/**
 * A git port that never touches a disk: `worktree list` and `status` answer
 * clean, `rev-parse` answers a fixed sha, `rev-list --count` answers `1` (so
 * the branch always has something to merge), and everything else succeeds —
 * except what a test asks to fail.
 */
function fakeGit(
  opts: { failMerge?: boolean; failCompareAndSwap?: boolean; subjects?: string[]; failPush?: string } = {},
) {
  const calls: Call[] = []
  const sha = '1'.repeat(40)

  const git = (args: string[], options: { cwd?: string }): Effect.Effect<string, RepoFailed> => {
    calls.push({ args: [...args], cwd: options.cwd ?? '' })
    const [cmd, second] = args
    if (cmd === 'rev-parse') return Effect.succeed(sha)
    if (cmd === 'rev-list') return Effect.succeed('1')
    if (cmd === 'log') return Effect.succeed((opts.subjects ?? []).join('\n'))
    if (cmd === 'status' || cmd === 'diff' || cmd === 'for-each-ref') return Effect.succeed('')
    if (cmd === 'merge' && second !== '--abort' && opts.failMerge) {
      return Effect.fail(new RepoFailed({ operation: 'git merge', detail: 'CONFLICT (content): Merge conflict' }))
    }
    if (cmd === 'push' && opts.failPush !== undefined) {
      return Effect.fail(new RepoFailed({ operation: 'git push', detail: opts.failPush }))
    }
    // The delete half of cleanup (`update-ref -d`) must never be the thing a
    // test makes fail — that would hide what it exists to catch.
    if (cmd === 'update-ref' && second !== '-d' && opts.failCompareAndSwap) {
      return Effect.fail(new RepoFailed({ operation: 'git update-ref', detail: 'compare-and-swap failed' }))
    }
    return Effect.succeed('')
  }
  return { git, calls }
}

const options = (git: ReturnType<typeof fakeGit>['git']) => ({
  project: PROJECT,
  owner: 'steven-zhc',
  repo: PROJECT,
  base: BASE,
  branch: BRANCH,
  ticketId: `ticket-${PROJECT}`,
  headSha: '0'.repeat(40),
  stepsPassed: true,
  home: '/fake-home',
  store: createMemoryEventStore(),
  git,
})

describe('the merge lane fetches into refs only it uses (#438)', () => {
  it('names no refs/heads/<branch> or refs/heads/<base> as a fetch destination', async () => {
    const fake = fakeGit()
    const result = await integrate(options(fake.git))
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const fetches = fake.calls.filter((c) => c.args[0] === 'fetch')
    expect(fetches.length).toBeGreaterThan(0)
    for (const fetch of fetches) {
      for (const refspec of fetch.args) {
        expect(refspec.endsWith(`:refs/heads/${BRANCH}`)).toBe(false)
        expect(refspec.endsWith(`:refs/heads/${BASE}`)).toBe(false)
      }
    }
    // And it did land in the lane's own namespace.
    const laneDestinations = fetches.flatMap((f) => f.args.filter((a) => a.includes(':refs/lingtai/lane/')))
    expect(laneDestinations.some((a) => a.endsWith('/base'))).toBe(true)
    expect(laneDestinations.some((a) => a.endsWith('/branch'))).toBe(true)
  })

  it('merges the lane branch ref with -m naming the branch, not the ref', async () => {
    const fake = fakeGit()
    const result = await integrate(options(fake.git))
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const merge = fake.calls.find((c) => c.args[0] === 'merge' && c.args[1] !== '--abort')
    expect(merge).toBeDefined()
    expect(merge!.args).toContain('--no-ff')
    const mIndex = merge!.args.indexOf('-m')
    expect(mIndex).toBeGreaterThan(-1)
    expect(merge!.args[mIndex + 1]).toBe(`Merge branch '${BRANCH}' into HEAD`)

    const merged = merge!.args.at(-1)!
    expect(merged.startsWith('refs/lingtai/lane/')).toBe(true)
    expect(merged.endsWith('/branch')).toBe(true)
  })

  it('deletes both lane refs on success', async () => {
    const fake = fakeGit()
    const result = await integrate(options(fake.git))
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const deletes = fake.calls.filter((c) => c.args[0] === 'update-ref' && c.args[1] === '-d')
    expect(deletes).toHaveLength(2)
    expect(deletes.some((c) => c.args[2]?.endsWith('/base'))).toBe(true)
    expect(deletes.some((c) => c.args[2]?.endsWith('/branch'))).toBe(true)
  })

  it('still deletes both lane refs when the merge itself fails', async () => {
    const fake = fakeGit({ failMerge: true })
    const result = await integrate(options(fake.git))
    expect(result.ok).toBe(false)

    const deletes = fake.calls.filter((c) => c.args[0] === 'update-ref' && c.args[1] === '-d')
    expect(deletes).toHaveLength(2)
    expect(deletes.some((c) => c.args[2]?.endsWith('/base'))).toBe(true)
    expect(deletes.some((c) => c.args[2]?.endsWith('/branch'))).toBe(true)
  })

  it('still reports ok when the post-push compare-and-swap is refused', async () => {
    const fake = fakeGit({ failCompareAndSwap: true })
    const result = await integrate(options(fake.git))
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const cas = fake.calls.find((c) => c.args[0] === 'update-ref' && c.args[1] === `refs/heads/${BASE}`)
    expect(cas).toBeDefined()
  })
})

/**
 * **A `wip:` commit must never land, however it got onto the branch** (`#468`).
 *
 * `conduct.ts`'s own `keepUncommittedWork` never pushes one to `agent/<n>` —
 * only to the arm — so the only way one of these reaches `laneBranch` is a
 * later agent resetting onto an arm the brief told it to take the *contents*
 * of instead. This is the lane's own backstop for that mistake.
 */
describe('the merge lane refuses a WIP commit (#468)', () => {
  it('refuses before the merge when a commit subject starts with the WIP prefix', async () => {
    const fake = fakeGit({ subjects: ['implement the fix', 'wip: run-abc stopped by out-of-turns'] })
    const result = await integrate(options(fake.git))
    expect(result.ok, JSON.stringify(result)).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('wip-commit')

    // Before the merge: a WIP commit must never be offered to it at all.
    const merge = fake.calls.find((c) => c.args[0] === 'merge' && c.args[1] !== '--abort')
    expect(merge).toBeUndefined()
  })

  it('merges normally when nothing on the branch carries the prefix', async () => {
    const fake = fakeGit({ subjects: ['implement the fix', 'fix(lane): tighten the check'] })
    const result = await integrate(options(fake.git))
    expect(result.ok, JSON.stringify(result)).toBe(true)
  })

  /**
   * **The prefix is `wip: run-`, not the bare `wip: `, exactly so this does not
   * happen** (`#468`). An agent or a person setting its own work aside with a
   * plain `wip: ` commit is never this conductor's own — `keepUncommittedWork`
   * always embeds a `runId`, which always starts `pass-`.
   */
  it('does not refuse a human or agent commit that happens to start with "wip: "', async () => {
    const fake = fakeGit({ subjects: ['implement the fix', 'wip: partial refactor'] })
    const result = await integrate(options(fake.git))
    expect(result.ok, JSON.stringify(result)).toBe(true)
  })
})

describe('a push the base refuses (#662)', () => {
  const pushes = (calls: { args: string[] }[]) => calls.filter((c) => c.args[0] === 'push')

  it('is base-protected, names both remedies, and is not retried', async () => {
    const fake = fakeGit({
      failPush:
        '! [remote rejected] HEAD -> main (protected branch hook declined)\nremote: error: GH006: Protected branch update failed',
    })
    const result = await integrate(options(fake.git))
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('base-protected')
    expect(pushes(fake.calls)).toHaveLength(1)
    expect(result.detail).toContain('does not open pull requests')
    expect(result.detail).toContain('bypass')
    expect(result.detail).toContain('repo.base')
  })

  it('leaves an ordinary non-fast-forward a lost push, retried', async () => {
    const fake = fakeGit({ failPush: '! [rejected] HEAD -> main (non-fast-forward)' })
    const result = await integrate(options(fake.git))
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('push-rejected')
    expect(pushes(fake.calls)).toHaveLength(4)
  })
})
