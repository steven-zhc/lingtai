/**
 * **The fixture #459's `nextOf` migration is held to** (#461, 0120 §2).
 *
 * One row per way a pass ends today, each asserting the ordered event types on
 * the run stream and the work-item stream and the final `Hold` — recorded by
 * running the row against the fakes and copying what it actually wrote, not by
 * transcribing 0120's draft table. Phase 1 (#466, #467) moves the pass onto
 * `nextOf` without changing one event; this is what makes that claim checkable.
 *
 * Driven with `once()` from `test/one-pass.ts`, never `runPass` directly:
 * `runPass` appends nothing (`pass.ts:1069` — *the pipeline does not touch the
 * store*), so every event here is `conduct.ts`'s own, and `runOnce` is the seam
 * #467 must leave unchanged.
 *
 * Two endings from the ticket's table are left out, both because nothing in
 * `test/one-pass.ts` can reach them without a change to production code:
 *
 * - **#3, `build` red, rounds spent.** Only `runPlugin` serves `build`
 *   (`recipe/src/recipe.ts:175–181`), and `run:` spawns a real process
 *   (`actions/src/command.ts:43`) — a subprocess in a worktree this file never
 *   cuts, which is the filesystem and so is integration (0060 §1).
 * - **#8, `prepared` refuses.** `prepared` is in `REFUSING_STEPS` (`pass.ts:120`)
 *   and does have its own hold, `SetupRefused` (`hold-of.ts:224`) — it is left
 *   out only because the one plugin that can make it refuse is `run:`
 *   (`recipe.ts:175–181`), and `run:` spawns a real process
 *   (`actions/src/command.ts:43`), the same reason row 3 is left out. Where
 *   nothing is declared there the body is `async () => ({ ending: 'passed' })`
 *   (`pass-steps.ts:1088`) and nothing here can make it answer otherwise.
 *
 * **Disagreements with 0120 found by running the rows, not by reading it:**
 *
 * - **The wall is not a `Ceiling`** (row 14b): only `out-of-turns` and
 *   `out-of-usd` set `ceilingHit` (`conduct.ts:2774–2781`); `timeout` falls to
 *   an ordinary `DidNotFinish` at the step it stopped, same shape as row 6.
 * - **Restarts spent is `Routed`, not a ceiling tag of its own** (row 5): a
 *   judge answering `claim` with no restarts left is not one of the steps on
 *   offer (`askTheAgent`'s `held(...)`, `conduct.ts:1849`), so `judged` in
 *   `pass-steps.ts` turns it into an ordinary `next: 'waiting'` and the pass
 *   rests exactly as an unrouted `findings` judgement would — `stopped ===
 *   null`, `Routed{when: 'findings'}` (`hold-of.ts`'s case 4), with the
 *   restarts-spent sentence folded into `why` rather than a tag of its own.
 * - **An `agent:` check declared ahead of the merge lane is `CheckRed`, not
 *   `MergeRefused`** (row 9): `directionOf` answers `'red'` for every refused
 *   step but `merge`, and for `merge` only `conflict`/`verify-failed` get a
 *   direction (`pass-steps.ts:620–628`) — an agent gate's own refusal carries
 *   `because: 'action-refused'`, which is none of those, so it falls past
 *   `directionOf` to `hold-of.ts`'s step 2, fails `RefusalReason`'s parse, and
 *   reads `CheckRed`.
 * - **A `claim` that is passed over still gets a `pass-*` stream** (row 15):
 *   three events — `StepRequested`, `StepStarted`, `StepFailed` — land on it,
 *   because `claim` is `STEPS[0]` and runs through the same per-step
 *   bookkeeping every other step does. What stays empty is the *work-item*
 *   stream, which is the claim this file's neighbour
 *   (`conduct-before-the-claim.test.ts`) actually makes.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1: no
 * process, no socket, no network.
 */
import { AgentHostFailed, type Runtime } from '@lingtai/agent'
import type { Envelope, PayloadOf } from '@lingtai/domain'
import {
  integrationStream,
  reduceIntegration,
  releaseCauseOf,
  routesOf,
  stepOutcomesOf,
  waitsOf,
  wellFormed,
} from '@lingtai/domain'
import type { WaitReason } from '@lingtai/domain/wait'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  fakeGitHub,
  fakePorts,
  issue,
  JUDGED,
  JUDGED_BY_A_CHEAP_AGENT,
  memoryStore,
  once,
  PROJECT,
  project,
  RECIPE,
  refusingRuntime,
  runtime,
  streams,
} from '../test/one-pass.ts'

/** The one run stream a pass mints, or `null` where none was opened. */
function theRun(store: ReturnType<typeof memoryStore>): Envelope[] | null {
  const found = [...streams(store)].find(([id]) => id.startsWith('pass-'))
  return found === undefined ? null : found[1]
}

/** Every run stream a store holds, oldest first — for a row that calls `once()` more than once. */
function theRuns(store: ReturnType<typeof memoryStore>): Envelope[][] {
  return [...streams(store)].filter(([id]) => id.startsWith('pass-')).map(([, events]) => events)
}

function typesOf(events: readonly Envelope[] | null): string[] {
  return events === null ? [] : events.map((e) => e.type)
}

async function theItem(store: ReturnType<typeof memoryStore>): Promise<Envelope[]> {
  return store.read(`ticket-${PROJECT}-7`)
}

function theHold(item: readonly Envelope[]): WaitReason | null {
  const started = item.find((e) => e.type === 'WaitStarted')
  return started === undefined ? null : (started.data as PayloadOf<'WaitStarted'>).reason
}

function bySeq(a: Envelope, b: Envelope): number {
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0
}

/** The item's own events, every run's, and the integration lane's — one item's slice of the log, `read-model.ts`'s own input shape. */
async function allEvents(store: ReturnType<typeof memoryStore>): Promise<Envelope[]> {
  const item = await theItem(store)
  const runs = theRuns(store).flat()
  const integration = await store.read(integrationStream(PROJECT, 'main'))
  return [...item, ...runs, ...integration].sort(bySeq)
}

/**
 * **The last `WaitStarted` on the slice is the same `WaitReason` `waitsOf`
 * reads back** (#502) — there is no `holdOf` translation left to cross-check:
 * `WaitStarted.reason` is `@lingtai/domain/wait`'s own `WaitReason`, stored
 * verbatim, so `waitsOf`'s fold and the stored payload are the same object by
 * construction. What is still worth pinning is that `stepOutcomesOf(all)`
 * does not throw on the slice every row produces.
 */
function theWaitFoldsToTheStoredHold(all: readonly Envelope[], hold: WaitReason, _skipRaw?: string): void {
  expect(() => stepOutcomesOf(all)).not.toThrow()
  const waits = waitsOf(all)
  const wait = waits[waits.length - 1]
  expect(wait).toBeDefined()
  expect(wait!.reason).toEqual(hold)
}

describe('what a pass writes today, one row per ending (#461)', () => {
  it('1. lands with no rounds spent', async () => {
    const store = memoryStore()
    const did: string[] = []

    const result = await once(
      {
        project,
        client: fakeGitHub([]),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store, true),
    )

    expect(result).toMatchObject({ ok: true, mergeCommit: 'c'.repeat(40) })
    expect(typesOf(await theItem(store))).toEqual(['TicketClaimed', 'IssueUpdated', 'TicketLanded', 'IssueUpdated'])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
    ])
    expect(theHold(await theItem(store))).toBeNull()

    const outcomes = stepOutcomesOf(await allEvents(store))
    expect(outcomes.find((o) => o.step === 'implement')?.actions[0]).toMatchObject({
      yields: 'commit',
      result: { _tag: 'Completed', question: null },
    })
    expect(outcomes.find((o) => o.step === 'merge')?.actions[0]?.result).toEqual({
      _tag: 'Completed',
      integration: { _tag: 'Integrated', mergeSha: 'c'.repeat(40) },
    })
  })

  /**
   * `review` refuses once with a blocker finding, the built-in `same-worktree`
   * judge spends the recipe's one round sending it back to `implement`, the
   * fixer commits, and the second `review` reads findings that parse to an
   * empty list — which is a `passed` verdict and not merely an unreadable one
   * (`verdictFor([]) === 'passed'`; only an answer that does not parse at all
   * is forced to `failed`, findings or none — see row 13).
   */
  it('2. lands after one fix round (review lines, judge, implement, green)', async () => {
    const store = memoryStore()
    const did: string[] = []
    const reviewed = { n: 0 }
    const twoSided: typeof refusingRuntime = {
      ...refusingRuntime,
      run: async (request) => {
        if (!request.runId.includes(':review:')) return runtime.run(request)
        reviewed.n += 1
        return reviewed.n === 1
          ? refusingRuntime.run(request)
          : { ...(await runtime.run(request)), text: JSON.stringify({ findings: [] }) }
      },
    }
    const ports = fakePorts(did, store, true)
    const git = ports.repo.git
    // The fixer's round needs its own head, or it is a round with no diff in it.
    ports.repo.git = (args, o) =>
      args[0] === 'rev-parse' && reviewed.n > 0 ? Effect.succeed('d'.repeat(40)) : git(args, o)

    const result = await once(
      {
        project,
        client: fakeGitHub([], JUDGED),
        runtime: twoSided,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      ports,
    )

    expect(result).toMatchObject({ ok: true, mergeCommit: 'c'.repeat(40) })
    expect(typesOf(await theItem(store))).toEqual(['TicketClaimed', 'IssueUpdated', 'TicketLanded', 'IssueUpdated'])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunSpent',
      'StepEnded',
      'StepStarted',
      'RunSpent',
      'RunProducedDiff',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunSpent',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'PassRouted',
    ])
    // **`FixApplied` is gone (#502): the fix round's own `StepEnded{step:
    // 'implement', round: 1}` is the one event now.**
    const fixApplied = theRun(store)!.find(
      (e) =>
        e.type === 'StepEnded' &&
        (e.data as PayloadOf<'StepEnded'>).outcome.step === 'implement' &&
        (e.data as PayloadOf<'StepEnded'>).outcome.round === 1,
    )!
    const fixRound = (fixApplied.data as PayloadOf<'StepEnded'>).outcome.round
    expect(fixRound).toBe(1)

    // **#493**: one `RunSpent` per `implement` dispatch that returned an
    // outcome — the first visit's at round 0, the fix round's own at the
    // round the fix round's own `StepEnded` carries.
    const spent = theRun(store)!.filter((e) => e.type === 'RunSpent')
    const implementSpent = spent.filter((e) => (e.data as { for: { step: string } }).for.step === 'implement')
    expect(implementSpent).toHaveLength(2)
    expect(implementSpent[0]!.data).toMatchObject({
      for: { _tag: 'Action', step: 'implement', name: 'write the change', round: 0 },
    })
    expect(implementSpent[1]!.data).toMatchObject({
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: fixRound,
      },
    })

    // **#494**: the cold reviewer's own `RunSpent`, one per visit, and the
    // second visit's round is the fix round's own `StepEnded` carries -- the
    // same number `implement`'s own second `RunSpent` just asserted above.
    const reviewSpent = spent.filter((e) => (e.data as { for: { step: string } }).for.step === 'review')
    expect(reviewSpent).toHaveLength(2)
    expect(reviewSpent[0]!.data).toMatchObject({ for: { _tag: 'Action', step: 'review', round: 0 } })
    expect(reviewSpent[1]!.data).toMatchObject({
      for: { _tag: 'Action', step: 'review', round: fixRound },
    })

    const runId = theRun(store)![0]!.streamId
    // `from` is `'review'` since #502: `routesOf` reads it off
    // `fromOf(offer.proposal)`, and `fromOf` answers `'review'` for a
    // `ReviewFindings` proposal directly (`proposal.ts`) — there is no
    // `reported`/`'proposed'` fallback left to prefer.
    expect(routesOf(await allEvents(store))).toEqual([
      {
        runId,
        from: 'review',
        decision: { _tag: 'Selected', candidate: 'fix-lines' },
        next: { _tag: 'FixRound', to: 'implement', round: 1 },
      },
    ])
  })

  /**
   * **#3, `build` red with rounds spent, is left out** — see the file header.
   */

  /**
   * A judge runtime (not the built-in) answers `{"next": "claim"}` for
   * `review`'s findings: `rested` becomes `'requeued'` (`pass.ts:1360`), the
   * arm is on origin (the fake's `git push` always answers `''`, so
   * `armPublished` is set), and `conduct.ts` spends a restart rather than
   * holding.
   */
  it('4. a judge restarts the pass (`PassRestarted`, `TicketReleased`)', async () => {
    const RESTARTABLE = `
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
    - name: the lines or the approach
      judge: claude-code
      when: findings
runtime:
  agent: claude-code
  limits: { turns: 10, wall: 2m, rounds: 1, restarts: 1 }
`
    const store = memoryStore()
    const did: string[] = []
    const judgePrompts: string[] = []
    const judging: typeof refusingRuntime = {
      ...refusingRuntime,
      run: async (request) => {
        if (!request.runId.includes(':judge:')) return refusingRuntime.run(request)
        judgePrompts.push(request.prompt)
        return {
          ...(await refusingRuntime.run(request)),
          text: '```json\n{"next": "claim", "why": "start over from a clean worktree"}\n```',
        }
      },
    }

    const result = await once(
      {
        project,
        client: fakeGitHub([], RESTARTABLE),
        runtime: judging,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store, false),
    )

    expect(result).toMatchObject({
      ok: false,
      stage: 'restart',
      detail:
        'the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over — restart 1 of 1',
    })
    expect(typesOf(await theItem(store))).toEqual(['TicketClaimed', 'IssueUpdated', 'TicketReleased', 'IssueUpdated'])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunSpent',
      'StepEnded',
      'RunSpent',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const item = await theItem(store)
    expect(theHold(item)).toBeNull()
    const restarted = item.find((e) => e.type === 'PassRestarted')!
    expect(restarted.data).toMatchObject({ restart: 1, of: 1 })
    const released = item.find((e) => e.type === 'TicketReleased')!
    expect(released.data).toMatchObject({
      reason:
        'the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over — restart 1 of 1',
    })
    // **`ReviewFindings` routed with a restart on offer** (#462's own test
    // list): `rounds: 1` and `restarts: 1` are both unspent on this arrival,
    // so the judge's brief offers `claim` (off `restart`) beside `implement`
    // and `waiting`, not only the two a spent restart would leave.
    expect(judgePrompts).toHaveLength(1)
    expect(judgePrompts[0]).toContain('`claim`')

    const runId = theRun(store)![0]!.streamId
    const all = await allEvents(store)
    // `from` is `'proposed'`, the same reason as row 2's own comment.
    expect(routesOf(all)).toEqual([
      {
        runId,
        from: 'proposed',
        decision: { _tag: 'Selected', candidate: 'restart' },
        next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } },
      },
    ])
    expect(releaseCauseOf(all)).toEqual([{ _tag: 'Restart', restart: 1 }])
  })

  /**
   * The same pass, run twice on the same store with fresh ports each time —
   * `folded.restarts` is read off the work-item stream (`conduct.ts:3351`), so
   * the second `once()` sees the first's restart without any event being
   * hand-seeded. With `restarts: 1` already spent, the judge's second `claim`
   * answer is not one of the steps on offer (`"waiting"`, `"implement"`), so
   * `askTheAgent` holds rather than requeues — **not a ceiling tag of its
   * own**, but the same `Routed{when: "findings"}` an unrouted judgement gets,
   * with the restarts-spent sentence folded into `why` (see the file header).
   */
  it('5. restarts spent: the second arrival holds, not requeues', async () => {
    const RESTARTABLE = `
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
    - name: the lines or the approach
      judge: claude-code
      when: findings
runtime:
  agent: claude-code
  limits: { turns: 10, wall: 2m, rounds: 1, restarts: 1 }
`
    const store = memoryStore()
    const did: string[] = []
    const judging: typeof refusingRuntime = {
      ...refusingRuntime,
      run: async (request) => {
        if (!request.runId.includes(':judge:')) return refusingRuntime.run(request)
        return {
          ...(await refusingRuntime.run(request)),
          text: '```json\n{"next": "claim", "why": "start over from a clean worktree"}\n```',
        }
      },
    }

    const r1 = await once(
      {
        project,
        client: fakeGitHub([], RESTARTABLE),
        runtime: judging,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store, false),
    )
    expect(r1).toMatchObject({ ok: false, stage: 'restart' })

    const result = await once(
      {
        project,
        client: fakeGitHub([], RESTARTABLE),
        runtime: judging,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store, false),
    )

    expect(result).toMatchObject({ ok: 'held', step: 'proposed' })
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'TicketReleased',
      'IssueUpdated',
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    const runs = theRuns(store)
    expect(runs).toHaveLength(2)
    expect(typesOf(runs[1] ?? [])).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunSpent',
      'StepEnded',
      'RunSpent',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Routed', when: 'findings' })
    expect((hold as { why: string }).why).toContain('`restarts` is spent')

    const all = await allEvents(store)
    theWaitFoldsToTheStoredHold(all, hold!)
    // `PassRouted.ceiling` is `'restarts'` even though the file header's own
    // `WaitReason` reading folds the sentence into `why` rather than a new
    // tag (0118 §1 gains none for this) — the judge chose `restart`, which
    // `offerFor` had already excluded, so `routesOf` reads it as the
    // ordinary ceiling escalation `CandidateUnavailable` always is.
    const runId2 = runs[1]![0]!.streamId
    expect(routesOf(all).filter((r) => r.runId === runId2)).toEqual([
      {
        runId: runId2,
        from: 'proposed',
        decision: {
          _tag: 'Escalated',
          because: {
            _tag: 'CandidateUnavailable',
            excluded: { id: 'restart', because: { _tag: 'CeilingReached', ceiling: 'restarts' } },
          },
        },
        next: { _tag: 'HandToPerson' },
      },
    ])
  })

  /**
   * **Since `#472` this routes too.** An implementer that produced no commits
   * at round 0 is `NothingProduced`, one of the seven `nextOf` now answers
   * `Propose` for, so `routeProposal` records a `PassRouted` right after
   * `StepDidNotFinish` on the run. With no `judge:` declared the router's
   * floor is the same person, and `holdOf`'s `ProposedEscalated{NothingProduced}`
   * branch calls the same `nothingProducedHold` builder the direct form did,
   * so the hold itself — `DidNotFinish`, `why: 'the agent produced no
   * commits'` — is unchanged. This is the ending #461's first run ended on,
   * seq 368–371.
   */
  it('6. `implement` produces no commits at round 0 (`StepDidNotFinish`, `DidNotFinish`)', async () => {
    const store = memoryStore()
    const did: string[] = []

    const result = await once(
      {
        project,
        client: fakeGitHub([]),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store, false, { at: 'a'.repeat(40), implementerCommits: false }),
    )

    expect(result).toMatchObject({ ok: 'held', step: 'implement' })
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'StepEnded',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'DidNotFinish', step: 'implement', why: 'the agent produced no commits' })
    theWaitFoldsToTheStoredHold(await allEvents(store), hold!)
  })

  /**
   * The fix round's own agent reads the review's findings and commits
   * nothing, without crashing — `committed` is false and `fixed.failure` is
   * null, so `conduct.ts:2966` sets `declined` and `holdOfPass` reads the
   * `did-not-finish` ending as `Declined` rather than `DidNotFinish`.
   *
   * **Two `PassRouted`s, since `#472`**: `pass.routes` collects one decision
   * per routed visit over the whole walk and `conduct.ts:3506-3525` appends
   * all of them in one batch after the walk returns, so the review's own
   * `ReviewFindings` route (into the fix round) and the round's own
   * `FixerDisagrees` route (now one of the seven) land as two consecutive
   * entries rather than one.
   */
  it('7. `implement` changes nothing in a fix round (`FixDeclined`/`Declined`)', async () => {
    const store = memoryStore()
    const did: string[] = []
    // No override on `git rev-parse`: the fixer's round leaves `HEAD` exactly
    // where the review saw it, which is the whole of what makes this a decline
    // and not a commit to re-review.
    const ports = fakePorts(did, store, true)

    const result = await once(
      {
        project,
        client: fakeGitHub([], JUDGED),
        runtime: refusingRuntime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      ports,
    )

    expect(result).toMatchObject({ ok: 'held', step: 'implement' })
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunSpent',
      'StepEnded',
      'StepStarted',
      'RunSpent',
      'StepEnded',
      'PassRouted',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Declined', step: 'implement' })
    expect((hold as { said: string | null }).said).toContain('the approach cannot work')

    const all = await allEvents(store)
    theWaitFoldsToTheStoredHold(all, hold!)
    // `stepOutcomesOf` and `waitsOf` must agree about this round: the fixer
    // read the findings and declined (`FixApplied{failure: null}`), which is
    // a commit action that *cleared* having committed nothing — never the
    // `NotDone` 0120 §4 sends to `Propose{SetupRefused}` for a work action
    // whose own setup broke before any agent ran. `waitsOf` already answers
    // `Declined`/`FixerDisagrees` off the stored hold regardless; this is the
    // other half, read off the run's own wire events.
    const implementRound1 = stepOutcomesOf(all).find((o) => o.step === 'implement' && o.round === 1)
    expect(implementRound1?.actions[0]?.result).toEqual({ _tag: 'Completed', head: null, question: null })
    const routes = routesOf(all)
    expect(routes).toHaveLength(2)
    expect(routes[0]).toMatchObject({ from: 'proposed', decision: { _tag: 'Selected', candidate: 'fix-lines' } })
    expect(routes[1]).toMatchObject({ from: 'implement', decision: { _tag: 'Escalated' } })
    // **#493**: a fix round that declines still returned a `RunOutcome`, so it
    // still gets a `RunSpent` — at the round `FixApplied` itself carries. And
    // `#494`: the one review dispatch above it gets its own, at round 0.
    const spent = theRun(store)!.filter((e) => e.type === 'RunSpent')
    const implementSpent = spent.filter((e) => (e.data as { for: { step: string } }).for.step === 'implement')
    expect(implementSpent).toHaveLength(2)
    expect(implementSpent[1]!.data).toMatchObject({
      for: { _tag: 'Action', step: 'implement', name: 'write the change', round: 1 },
    })
    const reviewSpent = spent.filter((e) => (e.data as { for: { step: string } }).for.step === 'review')
    expect(reviewSpent).toHaveLength(1)
  })

  /**
   * **#8, `prepared` refuses, is left out** — see the file header.
   */

  /**
   * An `agent:` check declared ahead of the landing in `merge:`'s own list —
   * legal since `#270` (`agentPlugin.at` includes `merge`). Its blocker
   * finding is a `failed` verdict (0058 §3b: *a reviewer's `failed` is its
   * findings*), and because `merge` is in `REFUSING_STEPS` that verdict
   * becomes a `refused` ending with `because: 'action-refused'` — not one of
   * the merge lane's own `RefusalReason`s, so it reads `CheckRed` rather than
   * `MergeRefused` (see the file header).
   */
  it('9. a check before the lane at `merge` refuses (`CheckRed`)', async () => {
    const CHECK_AT_MERGE = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  merge:
    - name: check
      agent: claude-code
      prompt: does this look safe to land
    - name: land the branch
      merge: { strategy: merge-commit }
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`
    const store = memoryStore()
    const did: string[] = []

    const result = await once(
      {
        project,
        client: fakeGitHub([], CHECK_AT_MERGE),
        runtime: refusingRuntime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store, true),
    )

    expect(result).toMatchObject({ ok: 'held', step: 'merge' })
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunSpent',
      'StepEnded',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'CheckRed', step: 'merge' })
    expect((hold as { why: string }).why).toContain('blocker src/fix.ts:12')
    const all9 = await allEvents(store)
    theWaitFoldsToTheStoredHold(all9, hold!)
    // The `check` that refuses at `merge` and `conduct.ts:4038`'s own
    // injected "merge it anyway" offer share this step and round on the
    // wire — `stepOutcomesOf` must not group them into one `StepOutcome`
    // with the refusal neither last nor cleared.
    expect(stepOutcomesOf(all9).every(wellFormed)).toBe(true)
  })

  /**
   * `conflict` is one of the two `RefusalReason`s a direction exists for
   * (`directionOf`, `pass-steps.ts:626`), so it is `Routed` and not
   * `MergeRefused` — the opposite of row 9, read off the same lane.
   */
  it('10a. the merge lane refuses on a conflict (`Routed{when: "conflict"}`)', async () => {
    const store = memoryStore()
    const did: string[] = []
    const ports = fakePorts(did, store, true)
    ports.repo.integrate = () =>
      Effect.sync(() => {
        did.push('integrate')
        return { ok: false, reason: 'conflict', detail: 'both sides touched src/fix.ts' } as never
      })

    const result = await once(
      {
        project,
        client: fakeGitHub([]),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      ports,
    )

    expect(result).toMatchObject({ ok: 'held', step: 'merge' })
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Routed', when: 'conflict', raw: 'both sides touched src/fix.ts' })
    const all10a = await allEvents(store)
    theWaitFoldsToTheStoredHold(all10a, hold!)
    expect(stepOutcomesOf(all10a).every(wellFormed)).toBe(true)
  })

  /**
   * `dirty-base` is one of the lane's other six reasons — no direction exists
   * for it, so it stays `MergeRefused` (`conduct.ts`'s own `MergeRefused`
   * patch, `#472`, filling `paths`/`baseSha`/`headSha` in from
   * `lastIntegrationRefusal` since `holdOf` alone writes `null` for all
   * three). The fake `integrate` appends a real `IntegrationRefused` row —
   * carrying those three fields for a `dirty-base` reason, which the real
   * lane (`packages/repo/src/integrate.ts`) only does for `conflict` — so
   * this is the unit-level stand-in `doc/design/472.md`'s own *What nothing
   * here can verify* section asks for: whether the patch actually reads them
   * back onto the hold.
   */
  it('10b. the merge lane refuses on a dirty base (`MergeRefused`)', async () => {
    const store = memoryStore()
    const did: string[] = []
    const ports = fakePorts(did, store, true)
    ports.repo.integrate = (o) =>
      Effect.promise(async () => {
        did.push('integrate')
        const stream = integrationStream(o.project, o.base)
        const at = reduceIntegration(await store.read(stream)).version
        await store.append(stream, at, [
          {
            type: 'IntegrationRefused',
            actor: 'conductor',
            data: {
              ticketId: o.ticketId,
              branch: o.branch,
              reason: 'dirty-base',
              detail: 'main moved under it',
              paths: ['src/fix.ts'],
              baseSha: 'b'.repeat(40),
              headSha: 'c'.repeat(40),
            },
          },
        ])
        return { ok: false, reason: 'dirty-base', detail: 'main moved under it' } as never
      })

    const result = await once(
      {
        project,
        client: fakeGitHub([]),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      ports,
    )

    expect(result).toMatchObject({ ok: 'held', step: 'merge' })
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({
      _tag: 'MergeRefused',
      reason: 'dirty-base',
      paths: ['src/fix.ts'],
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
    })
    const all10b = await allEvents(store)
    theWaitFoldsToTheStoredHold(all10b, hold!)
    expect(stepOutcomesOf(all10b).every(wellFormed)).toBe(true)
  })

  /**
   * A `design:` agent's question (`#294`) — `StepAsked`, and never
   * `StepDidNotFinish` (`#296`). No `RunStarted` at all: that event is the
   * `implement` dispatch's own, and `design` asking stops the pass before
   * `implement` is ever reached.
   */
  it('11. an agent asks a question (`StepAsked`)', async () => {
    const DRAFTED = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  design:
    - name: draft
      agent: claude-code
      prompt: say what shape this takes
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`
    const store = memoryStore()
    const did: string[] = []
    const asked = 'The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?'
    const asking: Runtime = {
      ...runtime,
      run: async (request) =>
        request.runId.includes(':design:')
          ? {
              exitCode: 0,
              turns: 2,
              durationMs: 1234,
              costUsd: 0.21,
              failure: null,
              text: `\`\`\`question\n${asked}\n\`\`\``,
              sessionId: 'sess-design',
            }
          : {
              exitCode: 0,
              turns: 3,
              durationMs: 1234,
              costUsd: 0.42,
              failure: null,
              text: 'done',
              sessionId: 'sess-1',
            },
    }

    const result = await once(
      {
        project,
        client: fakeGitHub([], DRAFTED),
        runtime: asking,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store, true),
    )

    expect(result).toMatchObject({ ok: 'held', step: 'design' })
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunSpent',
      'StepEnded',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Asked', step: 'design', question: asked })
    theWaitFoldsToTheStoredHold(await allEvents(store), hold!)
  })

  /**
   * A `human:` the recipe declared at `proposed:` — `#58`'s own claim, carried
   * to the new seam: `--no-merge` asks exactly the same way, through the same
   * `ApprovalRequested`, and this is the recipe asking with no flag anywhere.
   */
  it('12. a declared `human:` at `proposed` (`Human`)', async () => {
    const HUMAN_BEFORE_THE_LANE = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: approval
      human: "Merge this? It is Lingtai's own code."
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`
    const store = memoryStore()
    const did: string[] = []

    const result = await once(
      {
        project,
        client: fakeGitHub([], HUMAN_BEFORE_THE_LANE),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store, true),
    )

    expect(result).toMatchObject({ ok: 'held', step: 'proposed' })
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({
      _tag: 'Human',
      step: 'proposed',
      source: 'declared',
      question: "Merge this? It is Lingtai's own code.",
    })
    theWaitFoldsToTheStoredHold(await allEvents(store), hold!)
  })

  /**
   * The judge's answer does not parse as JSON at all. `chosenIn` returns
   * `null`, `askTheAgent` holds (`conduct.ts:1935`), and the pass rests with
   * `stopped === null` — the same `Routed{when: 'findings'}` an unrouted
   * `review` refusal gets, because nothing here is a step's own refusal.
   */
  it('13. a judge answer is unreadable', async () => {
    const store = memoryStore()
    const did: string[] = []
    const judging: typeof refusingRuntime = {
      ...refusingRuntime,
      run: async (request) => {
        if (!request.runId.includes(':judge:')) return refusingRuntime.run(request)
        return { ...(await refusingRuntime.run(request)), text: 'I am not sure what to say here.' }
      },
    }

    const result = await once(
      {
        project,
        client: fakeGitHub([], JUDGED_BY_A_CHEAP_AGENT),
        runtime: judging,
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
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunSpent',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunSpent',
      'StepEnded',
      'RunSpent',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Routed', when: 'findings' })
    expect((hold as { why: string }).why).toContain('was not readable as one of the steps')
    // The judge's own sentence (`conduct.ts:2293`) lives only in this
    // `PassRouted`'s own `why` — `routesOf`'s `waiting` branch answers
    // `because: NotAsked` for any escalation with `ceiling: null`, judge's
    // own unreadable answer included, so `holdOf`'s rebuild has no way back
    // to that text and falls to `ReviewEmpty`'s own fallback, the review's
    // raw findings. `_tag`/`when` still agree (0120's own 13 collapse to the
    // one shape `Routed{when: 'findings'}` already is).
    theWaitFoldsToTheStoredHold(
      await allEvents(store),
      hold!,
      'the judge-unreadable sentence lives on PassRouted.why, which routesOf does not read back into `because`',
    )
  })

  /**
   * **The cold reviewer's own answer is unreadable, and since `#472` never
   * runs `proposed`'s own declared `human:`/`watch:` action** (reversing
   * `#467`'s own carry-forward). `nextOf` answers `Propose{AnswerUnreadable}`
   * for a `review` whose findings do not parse at all, exactly as it does for
   * the other six fall-shorts, and `review` always ends `passed` (`endingOf`),
   * so `routeProposal`'s `reported` is `null` and it builds the routing visit
   * itself (`#462`) without ever calling `proposed`'s own body. A recipe that
   * declared a gate at `proposed:` would **not** have it run here; the hold —
   * the same `Routed{when: 'findings'}` an unrouted `review` refusal always
   * got, with the *could not be read at all* sentence ahead of the raw answer
   * — comes from `holdOf`'s `answerUnreadableHold` builder instead.
   */
  it("13b. the cold reviewer's own answer is unreadable", async () => {
    const store = memoryStore()
    const did: string[] = []
    const reviewUnreadable: Runtime = {
      ...runtime,
      run: async (request) => {
        if (!request.runId.includes(':review:')) return runtime.run(request)
        return { ...(await runtime.run(request)), text: 'I am not sure what to say here.' }
      },
    }

    const result = await once(
      {
        project,
        client: fakeGitHub([], JUDGED),
        runtime: reviewUnreadable,
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
    expect(typesOf(theRun(store))).toContain('ApprovalRequested')
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Routed', when: 'findings' })
    expect((hold as { why: string }).why).toContain('could not be read at all')
    theWaitFoldsToTheStoredHold(await allEvents(store), hold!)
  })

  /**
   * **A fix round's own wall is not the ticket's scope either** (`#467`'s fix
   * round) — the same read as the cold reviewer's (14d), for a dispatch
   * `firstDispatch`'s own receipt never covers. `ceilingHit` is set only by
   * the implementer's first attempt (row 14a); a round bought on `review`'s
   * findings that then runs out of turns leaves it `null`, so `holdFor`'s
   * guard reads it as `DidNotFinish` rather than inventing a `Ceiling` — with
   * real numbers or not — for a budget the ticket's own scope never promised.
   */
  it('14c. a fix round`s own agent hits the turn ceiling (`DidNotFinish`, not the ticket`s scope)', async () => {
    const store = memoryStore()
    const did: string[] = []
    const fixCeiling: Runtime = {
      ...runtime,
      run: async (request) => {
        if (request.runId.includes(':review:')) return refusingRuntime.run(request)
        if (request.runId.includes(':fix:')) {
          return {
            exitCode: 1,
            turns: 7,
            durationMs: 3_000,
            costUsd: 0.77,
            failure: { kind: 'out-of-turns', detail: 'spent all 7 turns mid-fix' },
            text: null,
            sessionId: 'sess-fix',
          }
        }
        return runtime.run(request)
      },
    }

    const result = await once(
      {
        project,
        client: fakeGitHub([], JUDGED),
        runtime: fixCeiling,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store),
    )

    expect(result).toMatchObject({ ok: 'held', step: 'implement' })
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'DidNotFinish', step: 'implement' })
    theWaitFoldsToTheStoredHold(await allEvents(store), hold!)
  })

  /**
   * **The cold reviewer's own wall is not the ticket's scope** (`#467`'s fix
   * round). `ceilingHit` is `implement`'s own receipt alone (`firstDispatch`,
   * `fixRound`) — a reviewer that runs out of turns leaves it `null`, and
   * `nextOf`'s `BudgetExhausted` carries no step to gate itself with, so
   * without `holdFor`'s guard this would read as `Ceiling{turns: null,
   * costUsd: null}`: the *scope alarm, requeue* sentence, for a budget the
   * implementer never touched. Before `#467` the same wall held as an
   * ordinary `DidNotFinish` (`holdOfPass`'s step 3, gated on the same
   * `ceilingHit`), and this is that shape surviving `nextOf`.
   */
  it('14d. the cold reviewer`s own wall is `DidNotFinish`, not a `Ceiling` nobody paid for', async () => {
    const store = memoryStore()
    const did: string[] = []
    const reviewCeiling: Runtime = {
      ...runtime,
      run: async (request) => {
        if (!request.runId.includes(':review:')) return runtime.run(request)
        return {
          exitCode: 1,
          turns: 5,
          durationMs: 2_000,
          costUsd: 0.33,
          failure: { kind: 'out-of-turns', detail: 'spent all 5 turns reviewing' },
          text: null,
          sessionId: 'sess-review',
        }
      },
    }

    const result = await once(
      {
        project,
        client: fakeGitHub([], JUDGED),
        runtime: reviewCeiling,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store),
    )

    expect(result).toMatchObject({ ok: 'held', step: 'review' })
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'DidNotFinish', step: 'review' })
    const all = await allEvents(store)
    theWaitFoldsToTheStoredHold(all, hold!)
    // #478: this row's own wire sentence (`agent-action.ts:580`) names the
    // real kind, and `stepOutcomesOf` must read it back rather than folding
    // to its own `crash` default — this is the one row here whose events
    // come from that real sentence rather than a fixture's own literal.
    const review = stepOutcomesOf(all).find((o) => o.step === 'review')
    expect(review?.actions.at(-1)?.result).toEqual({ _tag: 'Interrupted', cause: 'out-of-turns' })
  })

  /**
   * `out-of-turns` with turns spent is the one failure kind that sets
   * `ceilingHit` (with `out-of-usd`, `conduct.ts:2774`), so it is the one
   * `Ceiling` in this file. **Since `#472`** `BudgetExhausted` is one of the
   * seven, so the run gains a `PassRouted`, and `holdFor`'s ceiling branch
   * takes the step from `pass.waitOn.proposal.from` rather than
   * `pass.stoppedAt!` — the hold itself, with `turns`/`costUsd` patched in
   * from `ceilingHit`, is unchanged.
   */
  it('14a. the turn ceiling is hit mid-run (`Ceiling`)', async () => {
    const store = memoryStore()
    const did: string[] = []
    const ceilingRuntime: Runtime = {
      ...runtime,
      run: async () => ({
        exitCode: 1,
        turns: 10,
        durationMs: 5_000,
        costUsd: 1.1,
        failure: { kind: 'out-of-turns', detail: 'spent all 10 turns with no commit' },
        text: null,
        sessionId: 'sess-1',
      }),
    }

    const result = await once(
      {
        project,
        client: fakeGitHub([]),
        runtime: ceilingRuntime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store),
    )

    expect(result).toMatchObject({ ok: 'held', step: 'implement' })
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunFailed',
      'RunSpent',
      'StepEnded',
      'PassRouted',
      'RunRefsPublished',
      'RunProducedDiff',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Ceiling', kind: 'out-of-turns', turns: 10, costUsd: 1.1 })
    const all14a = await allEvents(store)
    theWaitFoldsToTheStoredHold(all14a, hold!)
    const implementOutcome = stepOutcomesOf(all14a).find((o) => o.step === 'implement')
    expect(implementOutcome?.actions[0]?.result).toEqual({ _tag: 'Interrupted', cause: 'out-of-turns', head: null })
    // **#493**: `out-of-turns` still returned an outcome, so it still gets a
    // `RunSpent` — what it reported, never a made-up zero.
    const spent14a = theRun(store)!.filter((e) => e.type === 'RunSpent')
    expect(spent14a).toHaveLength(1)
    expect(spent14a[0]!.data).toEqual({
      for: { _tag: 'Action', step: 'implement', name: 'write the change', round: 0 },
      runtime: 'claude-code',
      turns: 10,
      durationMs: 5_000,
      costUsd: 1.1,
      usage: [],
    })
  })

  /**
   * **The wall is not a ceiling today** (see the file header). A `timeout`
   * does not set `ceilingHit`, so it holds as an ordinary `DidNotFinish` —
   * the same tag row 6 gets, for a different reason.
   */
  it('14b. the wall is hit mid-run (`DidNotFinish`, not `Ceiling`)', async () => {
    const store = memoryStore()
    const did: string[] = []
    const timeoutRuntime: Runtime = {
      ...runtime,
      run: async () => ({
        exitCode: 1,
        turns: 2,
        durationMs: 120_000,
        costUsd: 0.2,
        failure: { kind: 'timeout', detail: 'exceeded wall 2m' },
        text: null,
        sessionId: 'sess-1',
      }),
    }

    const result = await once(
      {
        project,
        client: fakeGitHub([]),
        runtime: timeoutRuntime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store),
    )

    expect(result).toMatchObject({ ok: 'held', step: 'implement' })
    expect(typesOf(await theItem(store))).toEqual([
      'TicketClaimed',
      'IssueUpdated',
      'WaitStarted',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'StepEnded',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFailed',
      'RunSpent',
      'StepEnded',
      'RunRefsPublished',
      'RunProducedDiff',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'DidNotFinish', step: 'implement', why: 'timeout: exceeded wall 2m' })
    const all14b = await allEvents(store)
    theWaitFoldsToTheStoredHold(all14b, hold!)
    const implementOutcome = stepOutcomesOf(all14b).find((o) => o.step === 'implement')
    expect(implementOutcome?.actions[0]?.result).toEqual({ _tag: 'Interrupted', cause: 'timeout', head: null })
  })

  /**
   * **A claim `selectRunnable` passes over writes no run events** — a ticket
   * carrying an excluded label stays queued (`conduct-before-the-claim.test.ts`),
   * and this is the same arrangement, read for what it writes rather than for
   * what it must not. The work-item stream stays untouched; what exists is the
   * run stream `claim` itself opens as `STEPS[0]` — three events, and nothing
   * beyond them (see the file header for why this is not the empty stream
   * 0120 assumed).
   */
  it('15. a claim decline (`passed-over`) writes no work-item events', async () => {
    const HELD_BACK = RECIPE.replace('exclude: []', 'exclude: [hold]')
    const held = { ...issue, labels: [...issue.labels, { name: 'hold', color: '#ededed' }] }
    const store = memoryStore()
    const said: string[] = []
    const did: string[] = []
    const onHold = { ...fakeGitHub(said, HELD_BACK), getIssue: async () => held }

    const result = await once(
      {
        project,
        client: onHold as never,
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store),
    )

    expect(result).toMatchObject({ ok: false, stage: 'claim', detail: 'excluded-label' })
    expect(await theItem(store)).toEqual([])
    expect(said).toEqual([])
    expect(typesOf(theRun(store))).toEqual([])
    // `claim` runs outside `runPass` (0120 §6) and never has a `StepOutcome`,
    // so its own three events — a real `pass-*` stream, the file header's own
    // point — fold to none at all.
    expect(stepOutcomesOf(theRun(store) ?? [])).toEqual([])
  })

  /**
   * **`not-claimed`: another conductor already holds the item** (`#463`).
   *
   * `claimWorkItem` reads `held` off the `TicketClaimed` seeded below and the
   * claim declines before `runPass` ever starts. Same shape as row 15: the item
   * stream is exactly what was seeded (nothing of this run's own), and the run
   * stream still opens through `claim`'s own bookkeeping.
   */
  it('15b. a claim decline (`not-claimed`) writes no work-item events', async () => {
    const store = memoryStore()
    const said: string[] = []
    const did: string[] = []
    const itemId = `ticket-${PROJECT}-7`
    await store.append(itemId, 0, [
      {
        type: 'TicketClaimed',
        actor: 'conductor',
        data: { runId: 'pass-somebody-else', worker: 'other:1', title: null, kind: null },
      },
    ])

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store),
    )

    expect(result).toMatchObject({ ok: false, stage: 'claim' })
    expect((result as { detail: string }).detail).toContain('held')
    expect((await store.read(itemId)).map((e) => e.type)).toEqual(['TicketClaimed'])
    expect(said).toEqual([])
    expect(typesOf(theRun(store))).toEqual([])
  })

  /**
   * **`claim-unconfirmed`: the append may have committed and then lost the
   * connection** (`#463`). Only the `TicketClaimed` append throws — every
   * other append on the run stream goes through — so `claim` reports
   * `mayHold` and `conduct.ts` releases what this run may hold rather than
   * resolving an ending it never confirmed: `TicketReleased` on the item
   * stream, and no `EndActionsResolved` anywhere, because `end` never runs on
   * a decline.
   */
  it('15c. a claim decline (`claim-unconfirmed`) writes TicketReleased and resolves nothing', async () => {
    const base = memoryStore()
    const said: string[] = []
    const did: string[] = []
    const itemId = `ticket-${PROJECT}-7`
    const flaky: typeof base = {
      ...base,
      append: async (streamId, expectedVersion, events) => {
        if (streamId === itemId && events.some((e) => e.type === 'TicketClaimed')) {
          throw new Error('connection lost')
        }
        return base.append(streamId, expectedVersion, events)
      },
    }

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store: flaky,
      },
      fakePorts(did, flaky),
    )

    expect(result).toMatchObject({ ok: false, stage: 'claim' })
    expect(typesOf(await flaky.read(itemId))).toEqual(['TicketReleased', 'IssueUpdated'])
    expect(typesOf(theRun(flaky))).toEqual([])
    // No `TicketClaimed` ever landed on this stream — the append that would
    // have written it is what threw.
    expect(releaseCauseOf(await flaky.read(itemId))).toEqual([{ _tag: 'ClaimUnconfirmed' }])
  })

  /**
   * **A restart that keeps a WIP still spends the ceiling** (`#468`).
   *
   * The fix round's own agent commits half the fix and then meets the wall —
   * `after !== brief.context.onSha` (a real commit) *and* `fixed.failure` is
   * set (a real failure) at once, which is `conduct.ts:3323`'s own case: *a
   * commit clears `interrupted`, but not a failure that still ended the
   * round.* `stoppedBy` stays `'out-of-turns'` rather than clearing, and the
   * worktree is left dirty on top of that commit. `review` refuses the fix
   * round's head a second time; the round ceiling is now spent (`rounds: 1`),
   * so `stepsOnOffer` no longer offers `implement` and the agent judge at
   * `findings` is asked between `claim` and `human` alone. It answers `claim`
   * — `pass.rested === 'requeued'`.
   *
   * **Before the fix this test pins down**, `armIsUp` compared `armPublished`
   * (the WIP's own sha, once `keepUncommittedWork` has run) against `headSha`
   * (`headReached(pass.steps)`, the commit `review` judged — the WIP's own
   * *parent*) directly. Every ending that kept a WIP therefore read the arm as
   * down though it was on origin and `headSha` was its ancestor: no
   * `PassRestarted` was appended and `restartsSpent` never advanced. `armIsUp`
   * now also accepts a WIP whose own parent is `headSha` (`conduct.ts:3719`).
   */
  function restartWithAKeptWip(did: string[], store: ReturnType<typeof memoryStore>) {
    const RESTARTABLE = `
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
    - name: the lines or the approach
      judge: claude-code
      when: findings
runtime:
  agent: claude-code
  limits: { turns: 10, wall: 2m, rounds: 1, restarts: 2 }
`
    /** The fix round's own commit — half the fix, on top of the implementer's. */
    const FIX_SHA = 'd'.repeat(40)
    /** `keepUncommittedWork`'s commit, on top of `FIX_SHA`. */
    const WIP_SHA = 'e'.repeat(40)
    let head = 'a'.repeat(40)
    let dirty = false
    const judged = { n: 0 }
    const judging: Runtime = {
      ...refusingRuntime,
      run: async (request) => {
        if (request.runId.includes(':fix:')) {
          head = FIX_SHA
          dirty = true
          return {
            exitCode: 1,
            turns: 8,
            durationMs: 90_000,
            costUsd: 1.5,
            failure: { kind: 'out-of-turns', detail: 'spent all 8 turns mid-fix' },
            text: null,
            sessionId: 'sess-fix',
          }
        }
        if (request.runId.includes(':judge:')) {
          judged.n += 1
          // The first arrival still has a round to spend — buy it. The
          // second has none left (`stepsOnOffer`), and the point of this
          // fixture is what the judge says there: start over.
          const next = judged.n === 1 ? 'implement' : 'claim'
          return {
            ...(await refusingRuntime.run(request)),
            text: `\`\`\`json\n{"next": "${next}", "why": "round ${judged.n}"}\n\`\`\``,
          }
        }
        if (!request.runId.includes(':review:')) return runtime.run(request)
        return refusingRuntime.run(request)
      },
    }

    const ports = fakePorts(did, store, false)
    // The implementer's own commit — `firstDispatch`'s only call to `wire`.
    ports.agent.wire = () =>
      Effect.sync(() => {
        did.push('wire')
        head = 'b'.repeat(40)
        return { settingsPath: '/tmp/fake/settings.json', socketPath: '/tmp/fake/sock', env: {} } as never
      })
    const inner = ports.repo.git
    ports.repo.git = (args, o) => {
      if (args[0] === 'status') {
        return Effect.sync(() => {
          did.push('git status')
          return dirty ? ' M src/leftover.ts\n' : ''
        })
      }
      if (args[0] === 'rev-parse') {
        return Effect.sync(() => {
          did.push('git rev-parse')
          return head
        })
      }
      if (args[0] === 'add') {
        return Effect.sync(() => {
          did.push('git add -A')
          return ''
        })
      }
      if (args.includes('commit')) {
        return Effect.sync(() => {
          did.push('git commit --no-verify')
          dirty = false
          head = WIP_SHA
          return ''
        })
      }
      return inner(args, o)
    }

    return { recipe: RESTARTABLE, runtime: judging, ports, FIX_SHA, WIP_SHA }
  }

  it('16. a judge restarts a pass that kept a WIP (`RunKeptUncommitted`, `PassRestarted` spends the ceiling)', async () => {
    const store = memoryStore()
    const did: string[] = []
    const fixture = restartWithAKeptWip(did, store)

    const result = await once(
      {
        project,
        client: fakeGitHub([], fixture.recipe),
        runtime: fixture.runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fixture.ports,
    )

    expect(result).toMatchObject({ ok: false, stage: 'restart' })

    const run = theRun(store)!
    const kept = run.find((e) => e.type === 'RunKeptUncommitted')
    expect(kept).toBeDefined()
    expect(kept!.data).toMatchObject({ sha: fixture.WIP_SHA, parentSha: fixture.FIX_SHA, stoppedBy: 'out-of-turns' })

    // **#493**: the fix round's own `out-of-turns`, with a commit kept, still
    // returned an outcome — a `RunSpent` at this round's own number, beside
    // the first dispatch's own at round 0.
    const spent16 = run.filter((e) => e.type === 'RunSpent')
    const implementSpent16 = spent16.filter((e) => (e.data as { for: { step: string } }).for.step === 'implement')
    expect(implementSpent16).toHaveLength(2)
    expect(implementSpent16[1]!.data).toMatchObject({
      for: { _tag: 'Action', step: 'implement', round: 1 },
      turns: 8,
      costUsd: 1.5,
      usage: [],
    })

    // **#494**: the cold reviewer dispatches again over the kept-but-dirty
    // tree before the pass notices it and restarts — so its own `RunSpent`
    // appears twice too, one per visit, the same shape `implement`'s does.
    const reviewSpent16 = spent16.filter((e) => (e.data as { for: { step: string } }).for.step === 'review')
    expect(reviewSpent16).toHaveLength(2)

    // The durable row must never offer the WIP sha as something origin judged.
    const refs = run.filter((e) => e.type === 'RunRefsPublished')
    expect(refs.length).toBeGreaterThan(0)
    for (const row of refs) {
      expect((row.data as { headSha: string | null }).headSha).not.toBe(fixture.WIP_SHA)
    }

    const item = await theItem(store)
    const restarted = item.find((e) => e.type === 'PassRestarted')!
    // **The restart is bound to the commit `review` judged, never the WIP.**
    // This is the ceiling actually being spent — the bug this test is against
    // left `PassRestarted` unappended on this exact ending.
    expect(restarted.data).toMatchObject({ restart: 1, of: 2, headSha: fixture.FIX_SHA })
    expect(releaseCauseOf(await allEvents(store))).toEqual([{ _tag: 'Restart', restart: 1 }])

    // The same pass, run again on the same store with fresh ports:
    // `folded.restarts` already carries the first, and a second WIP on a
    // fresh worktree spends the second.
    const did2: string[] = []
    const again = restartWithAKeptWip(did2, store)
    const result2 = await once(
      {
        project,
        client: fakeGitHub([], again.recipe),
        runtime: again.runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      again.ports,
    )
    expect(result2).toMatchObject({ ok: false, stage: 'restart' })

    const item2 = await theItem(store)
    const restarts = item2.filter((e) => e.type === 'PassRestarted')
    expect(restarts).toHaveLength(2)
    expect(restarts[1]!.data).toMatchObject({ restart: 2, of: 2 })
    expect(releaseCauseOf(await allEvents(store))).toEqual([
      { _tag: 'Restart', restart: 1 },
      { _tag: 'Restart', restart: 2 },
    ])
  })

  /**
   * **#493**: a crash is a `RunOutcome` too — `firstDispatch` never reaches
   * the hook-not-served early return (`Either.isLeft(ran)`), so the failure
   * batch is the one `appendFrom` call that writes `RunFailed` and
   * `RunSpent` together. `costUsd: null` is carried through rather than
   * defaulted to zero (0110 §4).
   */
  it('17. a crash still returns an outcome, so it still gets a `RunSpent`', async () => {
    const store = memoryStore()
    const did: string[] = []
    const crashingRuntime: Runtime = {
      ...runtime,
      run: async () => ({
        exitCode: 1,
        turns: 2,
        durationMs: 500,
        costUsd: null,
        failure: { kind: 'crash', detail: 'the runtime exited 1' },
        text: null,
        sessionId: 'sess-crash',
      }),
    }

    const result = await once(
      {
        project,
        client: fakeGitHub([]),
        runtime: crashingRuntime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store),
    )

    expect(result).toMatchObject({ ok: 'held', step: 'implement' })
    expect(typesOf(theRun(store))).toContain('RunFailed')
    const spent = theRun(store)!.filter((e) => e.type === 'RunSpent')
    expect(spent).toHaveLength(1)
    expect(spent[0]!.data).toEqual({
      for: { _tag: 'Action', step: 'implement', name: 'write the change', round: 0 },
      runtime: 'claude-code',
      turns: 2,
      durationMs: 500,
      costUsd: null,
      usage: [],
    })
  })

  /**
   * **#493**: a run the hook never served is the reachable unit case for *a
   * process killed with no outcome records nothing* (0110 §2) — `ran` is a
   * `Left` and `firstDispatch` returns before either append. There is no way
   * from the fakes to reach the actually-killed-mid-run case (a real
   * process), so this is the nearest the unit half gets.
   */
  it('18. the hook socket is never served, so nothing is appended — no `RunSpent` either', async () => {
    const store = memoryStore()
    const did: string[] = []
    const ports = fakePorts(did, store)
    ports.agent.serve = () => Effect.fail(new AgentHostFailed({ operation: 'serve', detail: 'the socket refused' }))

    const result = await once(
      {
        project,
        client: fakeGitHub([]),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      ports,
    )

    expect(result).toMatchObject({ ok: 'held', step: 'implement' })
    const run = theRun(store)
    expect(typesOf(run)).not.toContain('RunStarted')
    expect(typesOf(run)).not.toContain('RunSpent')
  })
})
