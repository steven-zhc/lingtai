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
function fakeGit(opts: { failMerge?: boolean; failCompareAndSwap?: boolean } = {}) {
  const calls: Call[] = []
  const sha = '1'.repeat(40)

  const git = (args: string[], options: { cwd?: string }): Effect.Effect<string, RepoFailed> => {
    calls.push({ args: [...args], cwd: options.cwd ?? '' })
    const [cmd, second] = args
    if (cmd === 'rev-parse') return Effect.succeed(sha)
    if (cmd === 'rev-list') return Effect.succeed('1')
    if (cmd === 'status' || cmd === 'diff' || cmd === 'for-each-ref') return Effect.succeed('')
    if (cmd === 'merge' && second !== '--abort' && opts.failMerge) {
      return Effect.fail(new RepoFailed({ operation: 'git merge', detail: 'CONFLICT (content): Merge conflict' }))
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
  workItemId: `wi-${PROJECT}`,
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
