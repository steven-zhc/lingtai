/**
 * **A person's `RedoStep` continues the same attempt at the step that stopped** (#1218): a reviewer that
 * crashed for a cause outside the diff is run again, in the same run, on the saved head, with the prompt it was
 * first given, under a dispatch id of its own — and no round, restart or fixer is spent on it.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1.
 */
import type { Runtime } from '@lingtai/agent'
import { reduceAttempt, ticketStream, waitsOf, type PayloadOf } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { resolveWaitHoldingEffect } from '../src/resolve-wait.ts'
import { fakeGitHub, fakePorts, JUDGED, memoryStore, once, project, PROJECT, runtime } from '../test/one-attempt.ts'

/** A reviewer that crashes on its first dispatch and on each of the three redos by rule (#1249), and answers on the next. */
function reviewerCrashesOnce(seen: { id: string; prompt: string }[]): Runtime {
  return {
    ...runtime,
    run: (request) => {
      if (!request.runId.includes(':review:')) {
        return Effect.succeed({
          exitCode: 0,
          turns: 3,
          durationMs: 1234,
          costUsd: 0.42,
          failure: null,
          text: 'done\n```outcome\n{"outcome": "Implemented"}\n```',
          sessionId: 'sess-1',
        })
      }
      seen.push({ id: request.runId, prompt: request.prompt })
      return Effect.succeed({
        exitCode: 1,
        turns: 2,
        durationMs: 1_000,
        costUsd: 0.1,
        failure: seen.length <= 4 ? { kind: 'crash' as const, detail: 'the process was killed' } : null,
        text: seen.length <= 4 ? null : '{"verdict":"accepted","findings":[]}',
        sessionId: `sess-review-${seen.length}`,
      })
    },
  }
}

describe('a step a person asked to run again', () => {
  it('continues the same run at review with the recorded prompt under the next :rerun:, spending no round', async () => {
    const store = memoryStore()
    const seen: { id: string; prompt: string }[] = []
    const base = {
      project,
      client: fakeGitHub([], JUDGED),
      runtime: reviewerCrashesOnce(seen),
      issue: 7,
      hookBinary: '/tmp/fake/lingtai-hook',
      prompt: 'fix {{issue}}',
      merge: false,
      home: '/tmp/fake-home',
      store,
      log: () => {},
    }
    const first = await once(base, fakePorts([], store, true))
    expect(seen).toHaveLength(4)

    const ticketId = ticketStream(PROJECT, 7)
    const wait = waitsOf(await store.read(ticketId)).at(-1)!
    expect(wait.reason).toMatchObject({ _tag: 'AgentCrashed', step: 'review' })
    const runId = first.runId!
    const published = (await store.read(runId))
      .filter((e) => e.type === 'RunRefsPublished')
      .map((e) => e.data as PayloadOf<'RunRefsPublished'>)
    const head = published.at(-1)!.headSha!

    // A head the person did not see is refused, and nothing is appended.
    const before = (await store.read(ticketId)).length
    const stale = await Effect.runPromise(
      resolveWaitHoldingEffect(
        {
          ticketId,
          issue: 7,
          waitId: wait.waitId,
          resolution: { _tag: 'RedoStep', onSha: 'f'.repeat(40), ref: null },
          by: 'human:steven',
          client: { refSha: async () => head },
          store,
        },
        ticketId,
      ),
    )
    expect(stale).toMatchObject({ ok: false, reason: 'stale' })
    expect((await store.read(ticketId)).length).toBe(before)

    const resolved = await Effect.runPromise(
      resolveWaitHoldingEffect(
        {
          ticketId,
          issue: 7,
          waitId: wait.waitId,
          resolution: { _tag: 'RedoStep', onSha: '', ref: null },
          by: 'human:steven',
          client: { refSha: async () => head },
          store,
        },
        ticketId,
      ),
    )
    expect(resolved).toMatchObject({ ok: true })

    // Asked again — as when the continuation was never scheduled — it is accepted and appends nothing to the ticket.
    const afterResolved = (await store.read(ticketId)).length
    const again = await Effect.runPromise(
      resolveWaitHoldingEffect(
        {
          ticketId,
          issue: 7,
          waitId: wait.waitId,
          resolution: { _tag: 'RedoStep', onSha: '', ref: null },
          by: 'human:steven',
          client: { refSha: async () => head },
          store,
        },
        ticketId,
      ),
    )
    expect(again).toMatchObject({ ok: true })
    expect((await store.read(ticketId)).length).toBe(afterResolved)
    const spentBefore = reduceAttempt(await store.read(runId))

    const second = await once(
      { ...base, continuing: { runId } },
      fakePorts([], store, true, { at: head, implementerCommits: false }),
    )
    expect(second.runId).toBe(runId)
    expect(seen).toHaveLength(5)
    expect(seen[4]!.id).toBe(`${seen[0]!.id}:rerun:4`)
    expect(seen[4]!.prompt).toBe(seen[0]!.prompt)

    // No round, base merge, conflict round or transient retry was spent on the rerun.
    const spentAfter = reduceAttempt(await store.read(runId))
    expect(spentAfter.implementRound).toBe(spentBefore.implementRound)
    expect(spentAfter.baseMerges ?? 0).toBe(spentBefore.baseMerges ?? 0)
    expect(spentAfter.conflictRounds ?? 0).toBe(spentBefore.conflictRounds ?? 0)
    expect(spentAfter.stepRedos ?? 0).toBe(spentBefore.stepRedos ?? 0)
  })
})
