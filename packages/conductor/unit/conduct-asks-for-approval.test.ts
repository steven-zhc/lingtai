/**
 * **What the conductor asks a person, when nothing at the point asked for
 * them.**
 *
 * A plugin that wants a person yields its own `signoff` action through the
 * pipeline; a plugin that *refused* ends with an ordinary refused `verdict`
 * action and nothing else, so the request that reaches a person over a
 * refusal is `conduct.ts`'s own — a second, synthetic `StepEnded` for the
 * same step, appended after the one the refusing action's own pipeline wrote
 * (`conduct.ts`'s "merge it anyway" offer, #502).
 *
 * `task_view` folds every action in a `StepEnded.outcome` through one
 * `setStep`, keyed `${runId}:${step}:${action}`. **So the name on the
 * synthetic action is not decoration.** Named after the action that refused,
 * the synthetic action would overwrite that action's verdict with `pending`:
 * the card's `failed` count drops to zero and the board shows a change that
 * was refused as merely waiting, on every projection and every rebuild. The
 * old engine named its request `unfixed` or `disagreement` for precisely
 * this reason; the name is what survived the engine swap, and then the #502
 * switch, unchanged.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1:
 * no process, no socket, no network. The fixtures are `test/one-pass.ts`.
 */
import type { PayloadOf } from '@lingtai/domain'
import { legacyColumns } from '@lingtai/domain'
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

    // Two `StepEnded`s share `step: 'proposed'` here: the pipeline's own,
    // carrying the refusing `review` action, and the synthetic one
    // `conduct.ts` appends after it for the offer — told apart by `plugin`,
    // since no recipe-declared or default action is ever `'conductor'`.
    const endedAtProposed = run
      .filter((e) => e.type === 'StepEnded')
      .map((e) => (e.data as PayloadOf<'StepEnded'>).outcome)
      .filter((o) => o.step === 'proposed')
    const refusedOutcome = endedAtProposed.find((o) => o.actions.some((a) => a.plugin !== 'conductor'))!
    const offerOutcome = endedAtProposed.find((o) => o.actions.some((a) => a.plugin === 'conductor'))!

    const refusedAction = refusedOutcome.actions[0]!
    expect(refusedAction.name).toBe('review')
    expect(refusedAction.result).toMatchObject({ _tag: 'Completed', assessment: { verdict: 'refused' } })

    const askedAction = offerOutcome.actions[0]!
    /**
     * **Bound to what the publish put on origin**, which is what makes the
     * question answerable: `approve()` compares `onSha` to what origin has for the
     * branch and refuses anything else as `stale` (`#92`). `published` is the head
     * `publishWhatIsCommitted` pushed, and it is what `conduct.ts` binds to —
     * never `headReached`, which is the last head a *visit* reported.
     *
     * `ApprovalRequested.artifacts` is gone with the event itself (#502): a
     * `signoff` action's `Completed{requested}` carries only `question`, so
     * the branch-ref list that field used to show is not something this row
     * can still pin — `onSha` against `RunProducedDiff.headSha` is what is
     * left of that claim.
     */
    expect(askedAction.onSha).toBe('b'.repeat(40))
    expect((run.find((e) => e.type === 'RunProducedDiff')!.data as { headSha: string }).headSha).toBe(askedAction.onSha)
    // The whole of it: one key per verdict, so the `pending` cannot land on the
    // `failed` — the two actions never share a name, which is what keeps
    // `${step}:${action}` from colliding in `task_view`.
    expect(askedAction.name).not.toBe(refusedAction.name)
    expect(askedAction.name).toBe('unfixed')

    // **And what the key stops carrying travels in the question**, which is
    // what a person reads — the pointer to the action, and the step it ran at.
    const question = askedAction.evidence
    expect(question).toContain('review')
    expect(question).toContain('proposed')

    // The card's own sentence still names the refusal, and this is a diff two
    // agents disagreed about rather than a green run — so no move is
    // recommended over it.
    const started = item.find((e) => e.type === 'WaitStarted')!
    const blocked = legacyColumns((started.data as PayloadOf<'WaitStarted'>).reason, {
      branch: 'agent/7',
      base: 'main',
      findings: [],
    })
    expect(blocked.needs).toBe('acknowledgement')
    expect(blocked.diagnosis?.recommendation).toBeNull()
  })
})
