/**
 * **What the conductor asks a person, when nothing at the point asked for
 * them.**
 *
 * `ApprovalRequested` is gone (#502): a refusal a person must see is carried
 * on the single `WaitStarted` `conduct.ts` appends for every blocked ending,
 * named for the reason itself (`CheckRefused`) rather than for a second,
 * run-level event that used to risk colliding with the step's own
 * `StepEnded` — `task_view`'s old `${runId}:${gate}:${action}` key could be
 * overwritten by a request sharing it, which this shape has no way to do: one
 * event, on the ticket's own stream.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1:
 * no process, no socket, no network. The fixtures are `test/one-pass.ts`.
 */
import { legacyColumns, type Action, type PayloadOf } from '@lingtai/domain'
import type { WaitReason } from '@lingtai/domain/wait'
import { describe, expect, it } from 'vitest'

import {
  PROJECT,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  refusingRuntime,
  restartRecipe,
  streams,
} from '../test/one-pass.ts'

describe('the approval a refusal reaches a person with', () => {
  /**
   * A cold reviewer that refuses, and no round to patch with.
   *
   * `rounds: 0` is the shortest path: the review refuses the first diff,
   * `onOffer` has no `implement` left to offer, and a `findings` direction has
   * no built-in judge (`BUILT_IN_FOR`) — so the floor `#253` set holds and the
   * pass reaches a person with `proposed` named as where it stopped.
   */
  const refused = async () => {
    const store = memoryStore()
    const did: string[] = []
    const said: string[] = []

    const result = await once(
      {
        project,
        client: fakeGitHub(said, restartRecipe(0)),
        runtime: refusingRuntime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store),
    )
    const [, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!
    return { result, run, item: await store.read(`ticket-${PROJECT}-7`) }
  }

  it('is named for itself, so the refusal it reports is not overwritten', async () => {
    const { result, run, item } = await refused()

    expect(result).toMatchObject({ ok: 'held', step: 'proposed' })

    const ended = run.find((e) => e.type === 'StepEnded')!
    const outcome = (ended.data as PayloadOf<'StepEnded'>).outcome
    expect(outcome.step).toBe('proposed')
    const review = outcome.actions.find((a: Action) => a.name === 'review')!
    expect(review.result._tag).toBe('Completed')
    expect((review.result as { assessment: { verdict: string } }).assessment.verdict).toBe('refused')

    /**
     * **Bound to what the publish put on origin**, which is what makes the
     * question answerable: `approve()` compares `onSha` to what origin has for the
     * branch and refuses anything else as `stale` (`#92`). `published` is the head
     * `publishWhatIsCommitted` pushed, and it is what `conduct.ts` binds to —
     * never `headReached`, which is the last head a *visit* reported.
     */
    expect(review.onSha).toBe('b'.repeat(40))
    expect((run.find((e) => e.type === 'RunProducedDiff')!.data as { headSha: string }).headSha).toBe(review.onSha)

    // **One event, on the ticket's own stream, named for the reason itself**
    // — there is no second, run-level request for it to collide with.
    const started = item.find((e) => e.type === 'WaitStarted')!
    const reason = (started.data as PayloadOf<'WaitStarted'>).reason as Extract<WaitReason, { _tag: 'CheckRefused' }>
    expect(reason._tag).toBe('CheckRefused')
    expect(reason.step).toBe('proposed')
    expect(reason.action).toBe('review')

    // The card's own sentence still names the refusal, and this is a diff two
    // agents disagreed about rather than a green run — so no move is
    // recommended over it.
    const columns = legacyColumns(reason)
    expect(columns.needs).toBe('acknowledgement')
    expect(columns.diagnosis?.recommendation).toBeNull()
  })
})
