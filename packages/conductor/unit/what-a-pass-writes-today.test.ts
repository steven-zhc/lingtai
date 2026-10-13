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
 * - **`NotDone` at `implement` is not routed** (row 6, the ticket's own
 *   *Watch out*): `implement` is not in `REFUSING_STEPS` (`pass.ts:120`), so
 *   `goesToTheRouter` never sees the ending and it holds as `DidNotFinish`
 *   straight off the step, with no `PassRouted` anywhere on the run.
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
 * - **A `claim` that is passed over still gets a `run-*` stream** (row 15):
 *   three events — `StepRequested`, `StepStarted`, `StepFailed` — land on it,
 *   because `claim` is `STEPS[0]` and runs through the same per-step
 *   bookkeeping every other step does. What stays empty is the *work-item*
 *   stream, which is the claim this file's neighbour
 *   (`conduct-before-the-claim.test.ts`) actually makes.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1: no
 * process, no socket, no network.
 */
import type { Runtime } from '@lingtai/agent'
import type { Envelope, Hold } from '@lingtai/domain'
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
  const found = [...streams(store)].find(([id]) => id.startsWith('run-'))
  return found === undefined ? null : found[1]
}

/** Every run stream a store holds, oldest first — for a row that calls `once()` more than once. */
function theRuns(store: ReturnType<typeof memoryStore>): Envelope[][] {
  return [...streams(store)].filter(([id]) => id.startsWith('run-')).map(([, events]) => events)
}

function typesOf(events: readonly Envelope[] | null): string[] {
  return events === null ? [] : events.map((e) => e.type)
}

async function theItem(store: ReturnType<typeof memoryStore>): Promise<Envelope[]> {
  return store.read(`wi-${PROJECT}-7`)
}

function theHold(item: readonly Envelope[]): Hold | null {
  const blocked = item.find((e) => e.type === 'WorkItemBlocked')
  return blocked === undefined ? null : (blocked.data as { hold: Hold }).hold
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
    expect(typesOf(await theItem(store))).toEqual(['WorkItemClaimed', 'IssueUpdated', 'WorkItemLanded', 'IssueUpdated'])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
    ])
    expect(theHold(await theItem(store))).toBeNull()
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
    expect(typesOf(await theItem(store))).toEqual(['WorkItemClaimed', 'IssueUpdated', 'WorkItemLanded', 'IssueUpdated'])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepFailed',
      'StepRequested',
      'StepStarted',
      'FixRequested',
      'FixApplied',
      'RunProducedDiff',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'PassRouted',
    ])
    const fixApplied = theRun(store)!.find((e) => e.type === 'FixApplied')!
    expect(fixApplied.data).toMatchObject({ round: 1, said: 'done' })
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
  it('4. a judge restarts the pass (`PassRestarted`, `WorkItemReleased`)', async () => {
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
    expect(typesOf(await theItem(store))).toEqual([
      'WorkItemClaimed',
      'IssueUpdated',
      'PassRestarted',
      'WorkItemReleased',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepFailed',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const item = await theItem(store)
    expect(theHold(item)).toBeNull()
    const restarted = item.find((e) => e.type === 'PassRestarted')!
    expect(restarted.data).toMatchObject({ restart: 1, of: 1 })
    const released = item.find((e) => e.type === 'WorkItemReleased')!
    expect(released.data).toMatchObject({
      reason:
        'the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over — restart 1 of 1',
    })
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
      'WorkItemClaimed',
      'IssueUpdated',
      'PassRestarted',
      'WorkItemReleased',
      'IssueUpdated',
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    const runs = theRuns(store)
    expect(runs).toHaveLength(2)
    expect(typesOf(runs[1] ?? [])).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepFailed',
      'PassRouted',
      'RunRefsPublished',
      'ApprovalRequested',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Routed', when: 'findings' })
    expect((hold as { why: string }).why).toContain('`restarts` is spent')
  })

  /**
   * **The ticket's own *Watch out*.** `implement` is not in `REFUSING_STEPS`
   * (`pass.ts:120`), so an implementer that produced no commits at round 0
   * never reaches `goesToTheRouter` — it holds straight off the step as
   * `DidNotFinish`, with `StepDidNotFinish` on the run and no `PassRouted`
   * anywhere. This is the ending #461's first run ended on, seq 368–371.
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
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'StepDidNotFinish',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'DidNotFinish', step: 'implement', why: 'the agent produced no commits' })
    expect(typesOf(theRun(store))).not.toContain('PassRouted')
  })

  /**
   * The fix round's own agent reads the review's findings and commits
   * nothing, without crashing — `committed` is false and `fixed.failure` is
   * null, so `conduct.ts:2966` sets `declined` and `holdOfPass` reads the
   * `did-not-finish` ending as `Declined` rather than `DidNotFinish`.
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
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepFailed',
      'StepRequested',
      'StepStarted',
      'FixRequested',
      'FixApplied',
      'StepDidNotFinish',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Declined', step: 'implement' })
    expect((hold as { said: string | null }).said).toContain('the approach cannot work')
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
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepFailed',
      'PassRouted',
      'RunRefsPublished',
      'ApprovalRequested',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'CheckRed', step: 'merge' })
    expect((hold as { why: string }).why).toContain('blocker src/fix.ts:12')
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
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepFailed',
      'PassRouted',
      'RunRefsPublished',
      'ApprovalRequested',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Routed', when: 'conflict', raw: 'both sides touched src/fix.ts' })
  })

  /**
   * `dirty-base` is one of the lane's other six reasons — no direction exists
   * for it, so it stays `MergeRefused` (`hold-of.ts`'s step 2).
   */
  it('10b. the merge lane refuses on a dirty base (`MergeRefused`)', async () => {
    const store = memoryStore()
    const did: string[] = []
    const ports = fakePorts(did, store, true)
    ports.repo.integrate = () =>
      Effect.sync(() => {
        did.push('integrate')
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
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepFailed',
      'PassRouted',
      'RunRefsPublished',
      'ApprovalRequested',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'MergeRefused', reason: 'dirty-base' })
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
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepAsked',
      'PassRouted',
      'RunRefsPublished',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Asked', step: 'design', question: asked })
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
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'ApprovalRequested',
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
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunProducedDiff',
      'RunProposedCompletion',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepFailed',
      'PassRouted',
      'RunRefsPublished',
      'ApprovalRequested',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Routed', when: 'findings' })
    expect((hold as { why: string }).why).toContain('was not readable as one of the steps')
  })

  /**
   * `out-of-turns` with turns spent is the one failure kind that sets
   * `ceilingHit` (with `out-of-usd`, `conduct.ts:2774`), so it is the one
   * `Ceiling` in this file.
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
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFinished',
      'RunFailed',
      'StepDidNotFinish',
      'RunRefsPublished',
      'RunProducedDiff',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'Ceiling', kind: 'out-of-turns', turns: 10, costUsd: 1.1 })
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
      'WorkItemClaimed',
      'IssueUpdated',
      'WorkItemBlocked',
      'IssueUpdated',
      'IssueUpdated',
    ])
    expect(typesOf(theRun(store))).toEqual([
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'StepPassed',
      'StepRequested',
      'StepStarted',
      'RunStarted',
      'StepsResolved',
      'RunFailed',
      'StepDidNotFinish',
      'RunRefsPublished',
      'RunProducedDiff',
      'RunRefsPublished',
    ])
    const hold = theHold(await theItem(store))
    expect(hold).toMatchObject({ _tag: 'DidNotFinish', step: 'implement', why: 'timeout: exceeded wall 2m' })
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
    expect(typesOf(theRun(store))).toEqual(['StepRequested', 'StepStarted', 'StepFailed'])
  })
})
