/**
 * **What the conductor asks a person, when nothing at the point asked for
 * them.**
 *
 * `ApprovalRequested` is gone (#502): a refusal a person must see is carried
 * on the single `WaitStarted` `conduct.ts` appends for every blocked ending,
 * named for the reason itself (`CheckRefused`) rather than for a second,
 * run-level event that used to risk colliding with the step's own
 * `StepEnded`.
 *
 * **That risk was real, not removed, until `#503`.** The run's own stream
 * carries *two* `StepEnded`s for a blocked `proposed` or `merge` — the
 * step's, and the `conductor`-plugin signoff `conduct.ts` appends after it so
 * the board turns the Approve control on. Before `#503` the signoff was
 * named plainly `judge`/`unfixed`, inside the same `${step}:${name}` key
 * space a declared action's own name lives in — so a recipe naming a
 * `proposed` action `judge` had its refusal overwritten by the signoff and
 * then excluded from what an approval demands a reason for (`refusingOn`,
 * `approve.ts`). `#503` namespaces the signoff as `conductor:judge`/
 * `conductor:unfixed`, and the recipe validator refuses any declared name
 * containing `:` (0110 §9), so the two can never share a key again. The
 * second `it` below is the regression: it resolves a recipe that names a
 * `proposed` action `judge` and checks the refusal survives the signoff.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1:
 * no process, no socket, no network. The fixtures are `test/one-pass.ts`.
 */
import { legacyColumns, reduceRun, type Action, type PayloadOf } from '@lingtai/domain'
import type { WaitReason } from '@lingtai/domain/wait'
import { describe, expect, it } from 'vitest'

import { refusingOn } from '../src/resolve-wait.ts'
import {
  PROJECT,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  refusingRuntime,
  restartRecipe,
  restartRecipeNamedJudge,
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

  it('names the review and the signoff apart, so the refusal survives the second StepEnded', async () => {
    const { result, run, item } = await refused()

    expect(result).toMatchObject({ ok: 'held', step: 'proposed' })

    // **Two `StepEnded`s now carry `outcome.step === 'proposed'`** — the
    // step's own, naming `review`, and the `conductor`-plugin signoff
    // `conduct.ts` appends after it, naming `conductor:judge`. `review` and
    // `conductor:judge` never share a key, so finding the first by its own
    // name — not by position — is what makes this assertion survive either
    // order.
    const stepEndeds = run.filter(
      (e) => e.type === 'StepEnded' && (e.data as PayloadOf<'StepEnded'>).outcome.step === 'proposed',
    )
    expect(stepEndeds).toHaveLength(2)
    const review = stepEndeds
      .flatMap((e) => (e.data as PayloadOf<'StepEnded'>).outcome.actions)
      .find((a: Action) => a.name === 'review')!
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

    // The `conductor:judge` signoff is the other `StepEnded`, named apart
    // from `review` so neither overwrites the other's key on the run.
    const signoff = stepEndeds
      .flatMap((e) => (e.data as PayloadOf<'StepEnded'>).outcome.actions)
      .find((a: Action) => a.name === 'conductor:judge')!
    expect(signoff.plugin).toBe('conductor')
    expect(signoff.yields).toBe('signoff')

    // The ticket's own `WaitStarted`, named for the reason itself.
    const started = item.find((e) => e.type === 'WaitStarted')!
    const reason = (started.data as PayloadOf<'WaitStarted'>).reason as Extract<
      WaitReason,
      { _tag: 'ProposedEscalated' }
    >
    expect(reason._tag).toBe('ProposedEscalated')
    expect(reason.proposal).toMatchObject({ _tag: 'CheckRefused', from: 'proposed' })

    // The card's own sentence still names the refusal, and this is a diff two
    // agents disagreed about rather than a green run — so no move is
    // recommended over it.
    const columns = legacyColumns(reason)
    expect(columns.needs).toBe('acknowledgement')
    expect(columns.diagnosis?.recommendation).toBeNull()
  })

  /**
   * **#503's regression: a declared `proposed` action named `judge` keeps its
   * own refusal once the conductor's signoff lands beside it.**
   *
   * Before `#503` the signoff was named plainly `judge`, inside the same
   * `${step}:${name}` key `run.steps` folds every action into (`run.ts`) —
   * so this recipe's own `proposed:judge` refusal was overwritten by the
   * signoff, `run.lifecycle.step` became `'proposed:judge'`, and
   * `refusingOn` excluded it as "the signoff this approval is itself
   * answering" (`approve.ts`). `#503` namespaces the signoff as
   * `conductor:judge`, which keys `proposed:conductor:judge` instead —
   * distinct from `proposed:judge` — so the two verdicts coexist.
   */
  it('keeps a declared `judge` action refused once the conductor:judge signoff lands beside it', async () => {
    const store = memoryStore()
    const did: string[] = []
    const said: string[] = []

    const result = await once(
      {
        project,
        client: fakeGitHub(said, restartRecipeNamedJudge(0)),
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
    expect(result).toMatchObject({ ok: 'held', step: 'proposed' })

    const [, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!
    const folded = reduceRun(run)

    expect(folded.steps['proposed:judge']).toMatchObject({ verdict: 'failed', onSha: folded.headSha })
    expect(folded.steps['proposed:conductor:judge']).toMatchObject({ onSha: folded.headSha })
    expect(folded.lifecycle).toMatchObject({ status: 'awaiting-approval', step: 'proposed:conductor:judge' })

    // The regression itself: on the old naming this returned `[]`, because
    // the signoff overwrote `proposed:judge` and then excluded itself as the
    // signoff being answered — so Approve demanded no reason for a check
    // that was, in fact, still refusing.
    expect(refusingOn(folded, folded.headSha!)).toEqual(['proposed:judge'])
  })
})
