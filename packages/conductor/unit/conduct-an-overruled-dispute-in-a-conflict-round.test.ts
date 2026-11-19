/**
 * **A `Disputed` a judge overruled is told to the next fixer in a conflict round too** (#1277).
 * A conflict round runs at round 0, so the carry cannot be recognised by `round > 0`.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1.
 */
import type { Runtime } from '@lingtai/agent'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakePorts, memoryStore, once, project, runtime } from '../test/one-attempt.ts'

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
    - name: the conflict, by an agent
      judge: claude-code
      when: conflict
    - name: the dispute, by an agent
      judge: claude-code
      when: fixer-disagrees
runtime:
  agent: claude-code
  limits: { run: { turns: 10, wall: 2m }, attempt: { refusalFixes: 1, conflictResolutions: 1 }, ticket: { newAttempts: 0 } }
`

const RULING = 'zzz-the-ruling-the-judge-gave'
const OBJECTION = 'zzz-the-objection-the-fixer-made'

const result = (text: string) =>
  Effect.succeed({ exitCode: 0, turns: 1, durationMs: 10, costUsd: 0.1, failure: null, text, sessionId: 'sess' })

describe('a conflict round whose fixer declared Disputed, and a judge overruled it', () => {
  it('tells the next fixer, with the ruling', async () => {
    const fixPrompts: string[] = []
    const judging: Runtime = {
      ...runtime,
      run: (request) => {
        if (request.runId.includes(':judge:')) {
          return result(`\`\`\`json\n${JSON.stringify({ next: 'implement', why: RULING })}\n\`\`\``)
        }
        if (request.runId.includes(':fix:')) {
          fixPrompts.push(request.prompt)
          return fixPrompts.length === 1
            ? result(
                `\`\`\`outcome\n${JSON.stringify({ outcome: 'Disputed', findings: [{ index: 1, why: OBJECTION }] })}\n\`\`\``,
              )
            : runtime.run(request)
        }
        if (!request.runId.includes(':review:')) return runtime.run(request)
        return result(
          JSON.stringify({
            findings: [
              { file: 'a.ts', line: 1, claim: 'a stray name', failureScenario: 'reads oddly', severity: 'minor' },
            ],
          }),
        )
      },
    }
    const store = memoryStore()
    await once(
      {
        project,
        client: fakeGitHub([], RECIPE),
        runtime: judging,
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
        inTree: { conflicts: ['src/fix.ts'], ancestor: true },
      }),
    )

    expect(fixPrompts.length).toBeGreaterThanOrEqual(2)
    const second = fixPrompts[1]!
    expect(second).toContain('a judge ruled against its objection')
    expect(second).toContain(OBJECTION)
    expect(second).toContain(RULING)
  })
})
