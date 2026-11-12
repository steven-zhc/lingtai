/**
 * **A fix round bought on a merge conflict is briefed on the conflict first**
 * (#1119). The review before the lane passed with a minor finding; the round
 * must still be told to run the merge, with the minor after it as context.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1.
 */
import type { Runtime } from '@lingtai/agent'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakePorts, memoryStore, once, project, runtime } from '../test/one-attempt.ts'

const RECIPE_WITH_CONFLICT_JUDGE = `
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

const MINOR = 'zzz-a-stray-name-in-a-comment'

describe('a conflict round after a review that passed with a minor', () => {
  it('records a brief with the merge before the minor', async () => {
    const fixPrompts: string[] = []
    const reviewing: Runtime = {
      ...runtime,
      run: (request) => {
        if (request.runId.includes(':fix:')) {
          fixPrompts.push(request.prompt)
          return runtime.run(request)
        }
        return Effect.succeed({
          exitCode: 0,
          turns: 1,
          durationMs: 10,
          costUsd: 0.1,
          failure: null,
          text: JSON.stringify({
            findings: [{ file: 'a.ts', line: 1, claim: MINOR, failureScenario: 'reads oddly', severity: 'minor' }],
          }),
          sessionId: 'sess-review',
        })
      },
    }
    const store = memoryStore()
    await once(
      {
        project,
        client: fakeGitHub([], RECIPE_WITH_CONFLICT_JUDGE),
        runtime: reviewing,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts([], store, true, {
        at: 'a'.repeat(40),
        implementerCommits: true,
        conflicts: { paths: ['src/fix.ts'], baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
      }),
    )

    expect(fixPrompts.length).toBeGreaterThan(0)
    const first = fixPrompts[0]!
    const merge = first.indexOf('run git merge `main`')
    const open = first.indexOf('## Also open from the last review')
    const minor = first.indexOf(MINOR)
    expect(merge).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(merge)
    expect(minor).toBeGreaterThan(open)
    expect(first).toContain('## What conflicts')
  })
})
