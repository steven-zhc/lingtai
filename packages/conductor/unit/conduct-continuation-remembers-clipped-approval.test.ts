/**
 * **A later approval on the same head keeps the permission to review the clipped
 * diff** (#892). An agent reviewer at `proposed` stops on an oversized diff;
 * approving it runs the clipped review and reaches the human signoff; approving
 * that signoff resumes `proposed` again on the unchanged head, and must not stop
 * on `DiffTooLarge` a second time.
 */
import { waitsOf, ticketStream, stepOutcomesOf } from '@lingtai/domain'
import { aResolution } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakePorts, memoryStore, once, project, runtime, PROJECT } from '../test/one-attempt.ts'

const REVIEWER_THEN_SIGNOFF = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: review
      agent: claude-code
      prompt: look for races
    - name: signoff
      human: "Merge this?"
runtime:
  agent: claude-code
  limits: { turns: 10, wall: 2m }
  budget: { diff: 10 }
`

/** Rejects a session id it has already seen, as `claude` does (the id is a hash of the run, action and sha). */
const dispatched: string[] = []
const reviewing = {
  ...runtime,
  run: (request: { runId: string }) => {
    if (dispatched.includes(request.runId)) {
      return Effect.succeed({
        exitCode: 1,
        turns: 0,
        durationMs: 1,
        costUsd: null,
        failure: { kind: 'crash' as const, detail: `Error: Session ID ${request.runId} is already in use.` },
        text: null,
        sessionId: 'sess-review',
      })
    }
    dispatched.push(request.runId)
    return Effect.succeed({
      exitCode: 0,
      turns: 1,
      durationMs: 10,
      costUsd: 0.1,
      failure: null,
      text: JSON.stringify({
        findings: [{ file: 'a.ts', line: 1, claim: 'a nit', failureScenario: 'reads oddly', severity: 'minor' }],
      }),
      sessionId: 'sess-review',
    })
  },
}

describe('a second approval on the same head', () => {
  it('does not raise DiffTooLarge again', async () => {
    dispatched.length = 0
    const store = memoryStore()
    const ticketId = ticketStream(PROJECT, 7)
    const base = {
      project,
      client: fakeGitHub([], REVIEWER_THEN_SIGNOFF),
      runtime: reviewing,
      issue: 7,
      hookBinary: '/tmp/fake/lingtai-hook',
      prompt: 'fix {{issue}}',
      merge: true,
      home: '/tmp/fake-home',
      store,
    }
    const first = await once(base, fakePorts([], store, true))
    if (first.ok === false) throw new Error(`stopped at ${first.stage}: ${first.detail}`)
    if (first.ok !== 'held') throw new Error('it did not hold')
    const onSha = first.headSha
    const wait1 = waitsOf(await store.read(ticketId)).at(-1)!
    expect(wait1.reason).toMatchObject({ proposal: { _tag: 'DiffTooLarge' } })

    const approve = async (waitId: typeof wait1.waitId) =>
      store.append(
        ticketId,
        (await store.read(ticketId)).length,
        aResolution(makeStream(ticketId), waitId, { _tag: 'Approve', onSha }, 'human:steven'),
      )
    await approve(wait1.waitId)
    const second = await once(
      { ...base, continuing: { runId: first.runId } },
      fakePorts([], store, true, { at: onSha, implementerCommits: false }),
    )
    if (second.ok === false) throw new Error(`stopped at ${second.stage}: ${second.detail}`)
    if (second.ok !== 'held') throw new Error('it merged before the signoff')
    const wait2 = waitsOf(await store.read(ticketId)).at(-1)!
    expect(wait2.reason).toMatchObject({ action: 'signoff' })

    await approve(wait2.waitId)
    const third = await once(
      { ...base, continuing: { runId: first.runId } },
      fakePorts([], store, true, { at: onSha, implementerCommits: false }),
    )
    if (third.ok === false) throw new Error(`stopped at ${third.stage}: ${third.detail}`)
    // The reviewer ran once across all three passes, and the third went past the signoff.
    expect(dispatched.filter((id) => id.includes(':review:'))).toHaveLength(1)
    const last = waitsOf(await store.read(ticketId)).at(-1)!
    expect(last.reason).not.toMatchObject({ proposal: { _tag: 'DiffTooLarge' } })
    expect(last.reason._tag).not.toBe('AgentCrashed')
    expect(last.waitId).toBe(wait2.waitId)
    expect((await store.read(first.runId)).some((e) => e.type === 'RunCrashed')).toBe(false)
    // The kept review's finding, evidence and clipped survive the signoff resume.
    const reviews = stepOutcomesOf(await store.read(first.runId))
      .filter((o) => o.step === 'proposed')
      .flatMap((o) => o.actions)
      .filter((a) => a.name === 'review' && a.yields === 'verdict')
    const latest = reviews.at(-1)!
    if (latest.yields !== 'verdict' || latest.result._tag !== 'Completed') throw new Error('review did not complete')
    expect(latest.result.assessment.findings).toHaveLength(1)
    expect(latest.result.assessment.findings[0]!.claim).toBe('a nit')
    expect(latest.result.assessment.clipped).toMatchObject({ read: 10 })
    expect(latest.evidence).toContain('a nit')
  })
})
