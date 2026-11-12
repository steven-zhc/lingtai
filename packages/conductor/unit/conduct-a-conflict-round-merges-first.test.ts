/**
 * **The conductor starts the merge before a conflict round's agent does** (#1120),
 * through `conduct` over the shared fake git with its opt-in `inTree` fields. The
 * real `MERGE_HEAD` and markers on disk are an integration claim (0060 §1).
 */
import type { Runtime } from '@lingtai/agent'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakePorts, memoryStore, once, project, runtime, type FakeTree } from '../test/one-attempt.ts'

const RECIPE = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  review:
    - name: cold reviewer
      agent: claude-code
      prompt: look for races
  proposed:
    - name: the conflict, by the lines
      judge: same-worktree
      when: conflict
runtime:
  agent: claude-code
  limits: { turns: 10, wall: 2m, rounds: 1, restarts: 0 }
`

const BASE = 'a'.repeat(40)

async function conflictRound(inTree: NonNullable<FakeTree['inTree']>, laneBaseSha: string | null = BASE) {
  const did: string[] = []
  const fixPrompts: string[] = []
  let reviews = 0
  const tree: FakeTree = {
    at: 'a'.repeat(40),
    implementerCommits: true,
    conflicts: { paths: ['src/fix.ts'], baseSha: laneBaseSha as string, headSha: 'b'.repeat(40) },
    inTree,
  }
  const agent: Runtime = {
    ...runtime,
    run: (request) => {
      if (request.runId.includes(':fix:')) {
        did.push('fix agent runs')
        fixPrompts.push(request.prompt)
        // The resolution is in: the lane's next trial merge is clean.
        tree.conflicts = undefined
        // The fixer commits: HEAD moves.
        tree.at = 'c'.repeat(40)
        return runtime.run(request)
      }
      // The implementer is the fake runtime's; a review is the reviewer's own session.
      if (!request.runId.includes(':review:')) return runtime.run(request)
      reviews++
      return Effect.succeed({
        exitCode: 0,
        turns: 1,
        durationMs: 10,
        costUsd: 0.1,
        failure: null,
        text: JSON.stringify({ findings: [] }),
        sessionId: 'sess-review',
      })
    },
  }
  const store = memoryStore()
  const result = await once(
    {
      project,
      client: fakeGitHub([], RECIPE),
      runtime: agent,
      issue: 7,
      hookBinary: '/tmp/fake/lingtai-hook',
      prompt: 'fix {{issue}}',
      merge: true,
      home: '/tmp/fake-home',
      store,
    },
    fakePorts(did, store, true, tree),
  )
  return {
    result,
    did,
    fixPrompts,
    reviewsAtFix: () => reviews,
    log: JSON.stringify([...store.streams.values()], (_, v) => (typeof v === 'bigint' ? String(v) : v)),
  }
}

describe('a conflict round', () => {
  it('has the base merged into the worktree before the fixer starts, and says so', async () => {
    const { did, fixPrompts } = await conflictRound({ conflicts: ['src/fix.ts'], ancestor: true })

    const merge = did.indexOf(`git merge --no-commit --no-ff ${BASE}`)
    expect(merge).toBeGreaterThan(-1)
    expect(merge).toBeLessThan(did.indexOf('fix agent runs'))
    expect(fixPrompts[0]).toContain('`MERGE_HEAD` and the')
    expect(fixPrompts[0]).toContain('src/fix.ts')
    expect(fixPrompts[0]).toContain(`git merge --no-commit --no-ff ${BASE}`)
    expect(fixPrompts[0]).not.toContain('is yours to do')
  })

  it('lands when the fixer committed the merge, after a build and a review of it', async () => {
    const { result, did, reviewsAtFix } = await conflictRound({ conflicts: ['src/fix.ts'], ancestor: true })

    expect(result).toMatchObject({ ok: true })
    expect(did.filter((d) => d === 'integrate')).toHaveLength(2)
    expect(did).toContain(`git merge-base --is-ancestor ${BASE} HEAD`)
    // A review before the lane's first try and another after the round.
    expect(reviewsAtFix()).toBe(2)
  })

  it('goes to a person, with no review spent, when the fixer committed without the merge', async () => {
    const { result, did, reviewsAtFix, log } = await conflictRound({ conflicts: ['src/fix.ts'], ancestor: false })

    expect(did.filter((d) => d === 'integrate')).toHaveLength(1)
    expect(result).toMatchObject({ ok: 'held' })
    expect(log).toContain(`the round committed without the merge of ${BASE.slice(0, 7)}`)
    expect(reviewsAtFix()).toBe(1)
  })

  it('goes to a person, after aborting, when the merge does not conflict in the worktree', async () => {
    const { did, fixPrompts } = await conflictRound({ conflicts: [], ancestor: true })

    expect(fixPrompts).toHaveLength(0)
    expect(did).toContain('git merge --abort')
  })

  it('goes to a person, merging nothing, when the lane named no base sha', async () => {
    const { did, fixPrompts } = await conflictRound({ conflicts: ['src/fix.ts'], ancestor: true }, null)

    expect(fixPrompts).toHaveLength(0)
    expect(did.some((d) => d.startsWith('git merge --no-commit'))).toBe(false)
  })
})
