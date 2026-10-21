/**
 * **What a claim leaves behind, whatever ending it had** — 0062 §1, and the
 * three incidents that wrote it.
 *
 * Carried from the old engine's fakes test when `#256` deleted the engine it
 * was written for. The publish is the one block of that file that moved
 * into `conduct.ts` essentially verbatim, so these are the assertions that say it
 * moved *correctly* — and they are the assertions this repository has paid the
 * most for:
 *
 * - **`#250`** met the wall with two commits in its worktree, left neither
 *   `agent/250` nor `agent/250-attempt-1` on origin, and was collected. $26.84
 *   survived as unreachable git objects and one night of archaeology. The reason
 *   it could not be diagnosed is that **four different things wrote the same
 *   nothing**: a push that worked wrote no line, both silent returns wrote none,
 *   and the two refusals wrote only to the run log — which is a trace and never a
 *   record (0034 §8).
 * - **`#251`** is the row that fixes that, and the half-rejected push it found:
 *   `git push` is not atomic, so origin can take the forced arm and reject the
 *   leased branch in one command with one exit code.
 * - **`#252`** is the append asked for twice within one call, because the store
 *   drops a connection on exactly the row `attemptBrief` reads.
 *
 * The ending under test is the wall — an agent stopped at its turns — because it
 * is the ending with **no inline push of its own**: `merge` never runs, so the
 * refs exist only if this machinery puts them there. Unit by 0060 §1: no process,
 * no socket, no network.
 */
import type { Runtime } from '@lingtai/agent'
import { waitWords, type Envelope } from '@lingtai/domain'
import type { WaitReason } from '@lingtai/domain/wait'
import type { EventStore } from '@lingtai/event-store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { nextPrompt } from '../src/prompt.ts'
import { PROJECT, fakeGitHub, fakePorts, memoryStore, once, project, runtime, streams } from '../test/one-pass.ts'

describe('when the agent meets the wall', () => {
  const atTheWall: Runtime = {
    ...runtime,
    run: async () => ({
      exitCode: 1,
      turns: 151,
      durationMs: 1_800_000,
      costUsd: 20.81,
      failure: { kind: 'out-of-turns', detail: '151 turns, and the recipe allows 151 · $20.81' },
      text: null,
      sessionId: 'sess-237',
    }),
  }

  /** The budget's shape, at the recipe's defaults — this asserts the brief, not the bound. */
  const budget = { evidence: 2_000, attempts: 3, findings: 5 }

  /**
   * A `RepoFailed`, shaped rather than imported (`#251`).
   *
   * `Effect.either` reads `.detail` and nothing else, and `@lingtai/repo` loads
   * `node:child_process` at import — which is the one thing keeping this half of
   * the suite out of the `integration` project.
   */
  const pushRefusedWith = (detail: string) =>
    Effect.fail({ _tag: 'RepoFailed', operation: 'git push', detail } as never)

  /** The same shaping as `pushRefusedWith`, for a git call other than `push`. */
  const repoFailedWith = (operation: string, detail: string) =>
    Effect.fail({ _tag: 'RepoFailed', operation, detail } as never)

  const hitTheWall = async (
    committed: boolean,
    /**
     * What goes wrong underneath the publish, and all three are things that
     * actually can: a push origin rejects, a push origin *half* rejects, and a
     * store that will not take the row accounting for either.
     *
     * `leasedBranch` is the half: only the command carrying `--force-with-lease`
     * is refused, which is what origin does when a sibling claim has moved
     * `agent/<n>` since the worktree was cut. The forced arm refspec in the same
     * command is taken, and a later push of the arm alone is a no-op that
     * succeeds — so the fake lets it through.
     *
     * `theDiff` is how many `RunProducedDiff` appends the store drops before it
     * starts taking them — the Postgres disconnect CLAUDE.md documents for `#157`,
     * arriving on the one row `attemptBrief` reads.
     */
    breaks: { push?: string; leasedBranch?: string; theRow?: boolean; theDiff?: number } = {},
  ) => {
    const store = memoryStore()
    const did: string[] = []
    const said: string[] = []
    const ports = fakePorts(did, store)
    /**
     * **The appends go on the same list as the git calls**, because what `#250`
     * needed said is an ordering *between* them: a person asked a question wants
     * the branch already there to answer it with.
     */
    const appended = store.append.bind(store) as EventStore['append']
    let dropDiffs = breaks.theDiff ?? 0
    store.append = async (stream, at, events) => {
      if (breaks.theRow && events.some((e) => e.type === 'RunRefsPublished')) {
        throw new Error('the store would not take the row')
      }
      if (dropDiffs > 0 && events.some((e) => e.type === 'RunProducedDiff')) {
        dropDiffs -= 1
        throw new Error('the store would not take the diff record')
      }
      for (const e of events) did.push(`append ${e.type}`)
      return appended(stream, at, events)
    }
    const refuse = breaks.push ?? breaks.leasedBranch
    if (refuse !== undefined) {
      const inner = ports.repo.git
      const refused = (args: readonly string[]) =>
        args[0] === 'push' && (breaks.push !== undefined || args.some((a) => a.startsWith('--force-with-lease=')))
      ports.repo.git = (args, o) =>
        refused(args)
          ? Effect.sync(() => {
              did.push(`git push ${args.filter((a) => a.includes(':refs/heads/')).join(' ')}`)
            }).pipe(Effect.andThen(pushRefusedWith(refuse)))
          : inner(args, o)
    }
    if (!committed) {
      // The worktree's HEAD is still the base: the agent edited and never ran
      // `git commit`, which is exactly what `#237` did.
      const inner = ports.repo.git
      ports.repo.git = (args, o) =>
        args[0] === 'rev-parse'
          ? Effect.sync(() => {
              did.push('git rev-parse')
              return 'a'.repeat(40)
            })
          : inner(args, o)
    }
    // Full args for `update-ref`/`for-each-ref` (`#421`) — the base fake only
    // logs a verb (`one-pass.ts:755-759`), and these tests check the ref name
    // and the sha it was written at.
    const beforeKeptRefs = ports.repo.git
    ports.repo.git = (args, o) =>
      args[0] === 'update-ref' || args[0] === 'for-each-ref'
        ? Effect.sync(() => {
            did.push(`git ${args.join(' ')}`)
            return ''
          })
        : beforeKeptRefs(args, o)
    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime: atTheWall,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      ports,
    )
    const [runId, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!
    return { result, did, runId, run, item: await store.read(`ticket-${PROJECT}-7`) }
  }

  /**
   * **The wall is a `did-not-finish` at `implement`, and it holds the item.**
   *
   * The result reads `held` where the old engine returned `ok: false, stage: "run"`
   * *and* appended `WorkItemBlocked` — a failure and a hold at once, which is what
   * the two vocabularies cost. Under the pass there is one answer: the commit is
   * the receipt (0057 §2), an agent that ran out of turns left none, and
   * `outcomeOf` reads the ending as `blocked`. Nothing else about the ending
   * changed: the receipt is still both events, the diagnosis still says *the limit
   * is a scope alarm*, and the item still waits on a person.
   */
  it('records the receipt of a run stopped at its turns, and holds the item for a person', async () => {
    const { result, run, item } = await hitTheWall(true)
    if (result.ok !== 'held') throw new Error(`expected a hold, got ${JSON.stringify(result)}`)
    expect(result.step).toBe('implement')

    // **Both, and in that order.** Turns were taken and money was spent, so the
    // receipt is a fact; the ending is what `RunFailed` says. `RunFinished`
    // carries the turns alone now (#502, 0110 §9) — the dollar figure moved
    // to `RunSpent`, the one place spend lives.
    const types = run.map((e) => e.type)
    expect(types.indexOf('RunFinished')).toBeLessThan(types.indexOf('RunFailed'))
    expect(run.find((e) => e.type === 'RunFinished')!.data).toMatchObject({
      turns: 151,
    })
    expect(run.find((e) => e.type === 'RunSpent')!.data).toMatchObject({
      costUsd: 20.81,
    })

    const blocked = item.find((e) => e.type === 'WaitStarted')
    expect(blocked).toBeDefined()
    const cols = waitWords((blocked!.data as { reason: WaitReason }).reason)
    expect(cols.needsFrom).toBe('human')
    expect(cols.needs).toBe('acknowledgement')
    expect(cols.line).toContain('out-of-turns')
    // The recommendation is *narrow or split the ticket*, which is the whole of
    // why the turn limit keeps a diagnosis of its own.
    expect(cols.diagnosis?.what).toContain('scope alarm')
    expect(cols.diagnosis?.recommendation).toMatchObject({ action: 'requeue' })
  })

  it('publishes the commits it made, and names them for the next attempt', async () => {
    const { result, did, runId, run, item } = await hitTheWall(true)
    expect(result.ok).toBe('held')

    // **Both refs, from the ending that promises them.** One `lingtai requeue`
    // makes this attempt 2, `attemptBrief` runs, and it will say `git fetch origin
    // agent/7` — for a ref that now exists. `agent/7` is the newest and
    // `agent/7-attempt-1` is this claim's own, so the claim after this one cannot
    // overwrite what this one left.
    const push = 'git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1'
    expect(did).toContain(push)
    // Pushed while the worktree still exists, which is the only place those
    // commits are.
    expect(did.indexOf(push)).toBeLessThan(did.indexOf(`remove ${runId}`))

    // **And recorded, or the ref is one nobody will fetch.** `attemptBrief` reads
    // `RunProducedDiff` and nothing else.
    const produced = run.find((e) => e.type === 'RunProducedDiff')
    expect(produced).toBeDefined()
    expect(produced!.data).toMatchObject({ branch: 'agent/7', headSha: 'b'.repeat(40) })

    // The next attempt's prompt, composed the way the conductor composes it.
    const brief = nextPrompt({ base: 'ticket@1', budget, item, lastRun: run }).failure
    expect(brief).toContain('git fetch origin agent/7')
    expect(brief).not.toContain('It committed no change')
  })

  /**
   * **And nothing when there is nothing.** A ref to an empty branch would be a
   * worse lie than the absence: it would tell the next agent there is an approach
   * to build on and hand it the base branch.
   */
  it('publishes nothing when the agent committed nothing, and says so', async () => {
    const { result, did, run, item } = await hitTheWall(false)
    expect(result.ok).toBe('held')

    expect(did.filter((d) => d.startsWith('git push'))).toEqual([])
    expect(run.some((e) => e.type === 'RunProducedDiff')).toBe(false)

    const brief = nextPrompt({ base: 'ticket@1', budget, item, lastRun: run }).failure
    expect(brief).toContain('It committed no change, so there is no branch to build on')
    expect(brief).not.toContain('git fetch origin')
  })

  /**
   * **And it offers nobody *merge it anyway*, on either arm** — because nothing
   * judged this diff (`#84`: a card offers the move that is left, never a control
   * that refuses).
   *
   * The wall is a `did-not-finish` at `implement`: the pass never reached `build`,
   * `review`, `proposed` or `merge`, so no `StepFailed`, `StepNeverRan` or
   * `StepDidNotFinish` row exists about it. `refusingOn` (`approve.ts`) therefore
   * answers `[]`, and an `ApprovalRequested` here is a live **Approve** on the
   * board (`standing.tsx` draws one wherever `task_view.awaitingSha` is set) that
   * merges a half-finished diff with no reason required, no `StepWaived` and
   * nothing on the log recording that the build and the cold reviewer were
   * skipped. On a card whose own diagnosis reads *the limit is a scope alarm …
   * requeue*. The old engine appended no request on this ending and Requeue was the
   * only move; `conduct.ts` asks whether anything **refused** the diff, and this
   * ending refused nothing.
   *
   * Which is not `onOrigin`'s job and does not replace it: the arms still differ
   * in whether the refs went, the `false` arm publishes nothing, and the question
   * on the card differs with it. What they no longer differ in is whether a person
   * is handed a merge button.
   *
   * **`headSha` could not have told them apart either**, which is worth keeping:
   * `headReached` is the last `head` a *visit* reported, `admit` reports the base
   * sha so the head the pass is judged against always has a value
   * (`pass-steps.ts`), and this ending reports none — so it is the base sha in
   * both arms, including the one where origin is holding two commits at another.
   * A request bound to it would have been refused as `stale` by `approve()`
   * (`#92`) while the board drew the item `awaitingApproval` at a sha nothing is
   * at. Where a request *is* made, it is bound to what the publish put on origin:
   * `unit/conduct-asks-for-approval.test.ts`.
   */
  it('offers no approval on an ending nothing judged, whether or not it committed', async () => {
    for (const committed of [false, true]) {
      const { result, run, item } = await hitTheWall(committed)
      expect(result.ok).toBe('held')
      expect(
        run.some((e) => e.type === 'ApprovalRequested'),
        `nothing judged this diff, so there is nothing to approve (committed: ${committed})`,
      ).toBe(false)
      // Still a person's, and still with the move that is actually left on it.
      const blocked = waitWords((item.find((e) => e.type === 'WaitStarted')!.data as { reason: WaitReason }).reason)
      expect(blocked.needs).toBe('acknowledgement')
      expect(blocked.diagnosis?.recommendation).toMatchObject({ action: 'requeue' })
    }

    // And the refs still went on the arm that committed, which is what the next
    // attempt is promised and what a person reads while deciding to requeue.
    const committed = await hitTheWall(true)
    expect(committed.run.find((e) => e.type === 'RunProducedDiff')!.data).toMatchObject({
      branch: 'agent/7',
      headSha: 'b'.repeat(40),
    })
  })

  /**
   * **The push happens before the person is asked**, which is the ordering `#250`
   * could not have had: the publish lived only in the finalizer, which releases
   * after every append the pass makes.
   *
   * Two rows, and the second is the finalizer saying it ran: it finds the head
   * already where it wanted it and pushes nothing. *The finalizer fired* is the
   * fact `#250` had to infer from a `RUN_LOG_END` line.
   */
  it('pushes before the person is asked, and the log says both refs went', async () => {
    const { result, did, run } = await hitTheWall(true)
    expect(result.ok).toBe('held')

    const push = 'git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1'
    expect(did).toContain(push)
    expect(did.indexOf(push)).toBeLessThan(did.indexOf('append WaitStarted'))

    const rows = run.filter((e) => e.type === 'RunRefsPublished')
    expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['published', 'already-published'])
    expect(rows[0]!.data).toMatchObject({
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'b'.repeat(40),
      detail: null,
    })
    expect(did.filter((d) => d.startsWith('git push'))).toEqual([push])
  })

  /**
   * **An absence that is meant is said, or it cannot be told from one that is
   * not.** This is the reading `#250` most needed excluded and could not exclude:
   * the publish ran, found the head still at the base, and returned `null` without
   * a word — which on the page is the same nothing as a finalizer that never fired.
   */
  it('says nothing was committed, rather than leaving that absence to be read', async () => {
    const { run, did } = await hitTheWall(false)

    const rows = run.filter((e) => e.type === 'RunRefsPublished')
    expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['nothing-committed', 'nothing-committed'])
    expect(rows[0]!.data).toMatchObject({ headSha: null, detail: null })
    expect(did.filter((d) => d.startsWith('git push'))).toEqual([])
  })

  /**
   * **A refused push keeps git's own words, and the stop still stands.**
   *
   * The head is on the row because that is what says whether anything was lost: a
   * rejection with commits behind it is a run somebody can still rescue from the
   * worktree's objects, and `#250`'s was. The person is asked the same question
   * either way — a push that failed is not a second opinion about the ticket.
   */
  it("keeps git's words when the push is refused, and holds the item anyway", async () => {
    const rejected = '! [remote rejected] agent/7 -> agent/7 (stale info)'
    const { result, run, item } = await hitTheWall(true, { push: rejected })
    expect(result.ok).toBe('held')

    const rows = run.filter((e) => e.type === 'RunRefsPublished')
    expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['refused', 'refused'])
    expect(rows[0]!.data).toMatchObject({ headSha: 'b'.repeat(40), detail: rejected })
    // The item is still held, and the card carries what git said — a rescue starts
    // from knowing whether the commits reached origin.
    const blocked = item.find((e) => e.type === 'WaitStarted')
    expect(blocked).toBeDefined()
    // `was not pushed` is composed by `waitWords`, onto `diagnosis.what`
    // — the event itself carries git's bare words on `reason.run.unpushed.said`.
    const cols = waitWords((blocked!.data as { reason: WaitReason }).reason)
    expect(cols.diagnosis?.what).toContain('was not pushed')
  })

  /**
   * **One exit code for two refspecs, so a failure is asked which** (`#251`).
   *
   * Origin takes the forced arm, rejects the leased `agent/<n>`, and the command
   * exits non-zero with the commits on origin. Read as a plain refusal it is the
   * exact loss the publish exists to end: a row saying *nothing was pushed* over a
   * ref that is there, and — because `attemptBrief` reads `RunProducedDiff` and
   * nothing else — a next attempt told *Nothing*, starting over from the base while
   * the arm sits unfetched.
   *
   * So the record names **the arm**, not the branch: naming `agent/<n>` would send
   * the next agent to fetch a ref holding whatever invalidated the lease.
   */
  it('finds the arm that survived a half-rejected push, and sends the next attempt to it', async () => {
    const stale = '! [remote rejected] agent/7 -> agent/7 (stale info)'
    const { run, item } = await hitTheWall(true, { leasedBranch: stale })

    const rows = run.filter((e) => e.type === 'RunRefsPublished')
    expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['arm-only', 'arm-only'])
    const produced = run.find((e) => e.type === 'RunProducedDiff')
    expect(produced).toBeDefined()
    expect(produced!.data).toMatchObject({
      branch: 'agent/7-attempt-1',
      headSha: 'b'.repeat(40),
    })

    const brief = nextPrompt({ base: 'ticket@1', budget, item, lastRun: run }).failure
    expect(brief).toContain('git fetch origin agent/7-attempt-1')
  })

  /**
   * **The account never costs the thing it is an account of.**
   *
   * A store that will not take `RunRefsPublished` is swallowed: raising it would
   * abort the body before the `RunProducedDiff` that `attemptBrief` reads, and a
   * ref nobody will fetch is a worse outcome than a missing explanation of a ref
   * that is there.
   */
  it('does not let a refused row change the ending or cost the diff record', async () => {
    const { result, run, item } = await hitTheWall(true, { theRow: true })
    expect(result.ok).toBe('held')
    expect(run.some((e) => e.type === 'RunRefsPublished')).toBe(false)
    expect(run.find((e) => e.type === 'RunProducedDiff')!.data).toMatchObject({
      branch: 'agent/7',
    })
    const brief = nextPrompt({ base: 'ticket@1', budget, item, lastRun: run }).failure
    expect(brief).toContain('git fetch origin agent/7')
  })

  /**
   * **Asked again within the call that owed the row** (`#252`).
   *
   * `appendNow` throws on a dropped connection, arriving on the one row
   * `attemptBrief` reads and nothing else does. Leaving the repair to *a later
   * call* made it a repair only the endings that publish inline get — and the wall
   * publishes once. So the row is asked for twice inside one call: a round trip on
   * a path that has already failed, and nothing on the path that has not.
   */
  it('asks again for the diff record a dropped append cost, and keeps its own ending', async () => {
    const { result, run, item } = await hitTheWall(true, { theDiff: 1 })
    expect(result.ok).toBe('held')
    expect(run.find((e) => e.type === 'RunProducedDiff')!.data).toMatchObject({
      branch: 'agent/7',
      headSha: 'b'.repeat(40),
    })
    const brief = nextPrompt({ base: 'ticket@1', budget, item, lastRun: run }).failure
    expect(brief).toContain('git fetch origin agent/7')
  })

  /**
   * **And where both asks die the loss is said rather than swallowed.**
   *
   * An `unrecorded` row names the ref, the head and the store's words, so a run
   * whose brief will say *Nothing* over commits that are on origin carries the
   * contradiction on the log where a person can find it.
   */
  it('says the refs are on origin and unrecorded when both asks are refused', async () => {
    const { run } = await hitTheWall(true, { theDiff: 2 })
    const rows = run.filter((e) => e.type === 'RunRefsPublished')
    expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toContain('unrecorded')
    expect(rows.find((e) => (e.data as { outcome: string }).outcome === 'unrecorded')!.data).toMatchObject({
      headSha: 'b'.repeat(40),
    })
  })

  /**
   * **A clean tree writes nothing** (`#468`). Every other test in this file
   * meets the wall with `git status --porcelain` answering empty, the way
   * `fakePorts`'s own git port does by default — so this is the same ending,
   * asserted for the property the new behaviour must not disturb.
   */
  it('commits nothing and records no RunKeptUncommitted when the tree is clean', async () => {
    const { did, run } = await hitTheWall(true)
    expect(run.some((e) => e.type === 'RunKeptUncommitted')).toBe(false)
    expect(did.some((d) => d.includes('commit'))).toBe(false)
  })

  /**
   * **A stopped agent's dirty tree is kept as its own commit, on the arm and
   * never on `agent/<n>`** (`#468`). `atTheWall`'s own ending — `out-of-turns`
   * — is `stoppedBy`'s own case, and `keepUncommittedWork` runs ahead of the
   * publish's `rev-parse HEAD`, so every read below already sees the commit
   * it made.
   */
  describe('and the worktree is left dirty', () => {
    const WIP_SHA = 'c'.repeat(40)

    /**
     * `committed` carries `hitTheWall`'s own meaning — whether `wire` left a
     * commit of the implementer's in the tree (`'b'*40`) or the tree never
     * moved off the base (`'a'*40`, `#237`'s shape) — and adds the dirt
     * `status --porcelain` answers with until the commit this test watches
     * for is made. `leasedBranch`, same as `hitTheWall`'s own: the half of a
     * push that carries `--force-with-lease` is refused, so origin takes the
     * forced arm and rejects `agent/<n>` — the `arm-only` ending, now with a
     * WIP on top of the agent's own commit.
     */
    const hitTheWallDirty = async (
      committed: boolean,
      breaks: { leasedBranch?: string; failKeptOnce?: boolean; push?: string } = {},
    ) => {
      const store = memoryStore()
      const did: string[] = []
      const said: string[] = []
      const ports = fakePorts(did, store)
      const appended = store.append.bind(store) as EventStore['append']
      let keptAppends = 0
      store.append = async (stream, at, events) => {
        for (const e of events) did.push(`append ${e.type}`)
        if (breaks.failKeptOnce && events.some((e) => e.type === 'RunKeptUncommitted')) {
          keptAppends += 1
          if (keptAppends === 1) throw new Error('dropped connection')
        }
        return appended(stream, at, events)
      }

      let dirty = true
      let head = committed ? 'b'.repeat(40) : 'a'.repeat(40)
      let inner = ports.repo.git
      if (breaks.leasedBranch !== undefined) {
        const beforeRefusal = inner
        inner = (args, o) =>
          args[0] === 'push' && args.some((a) => a.startsWith('--force-with-lease='))
            ? Effect.sync(() => {
                did.push(`git push ${args.filter((a) => a.includes(':refs/heads/')).join(' ')}`)
              }).pipe(Effect.andThen(pushRefusedWith(breaks.leasedBranch!)))
            : beforeRefusal(args, o)
      }
      // Every push refused, not only the leased half — origin unreachable, as
      // opposed to a sibling claim moving `agent/<n>` out from under the lease.
      if (breaks.push !== undefined) {
        const beforeRefusal = inner
        inner = (args, o) =>
          args[0] === 'push'
            ? Effect.sync(() => {
                did.push(`git push ${args.filter((a) => a.includes(':refs/heads/')).join(' ')}`)
              }).pipe(Effect.andThen(pushRefusedWith(breaks.push!)))
            : beforeRefusal(args, o)
      }
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

      const result = await once(
        {
          project,
          client: fakeGitHub(said),
          runtime: atTheWall,
          issue: 7,
          hookBinary: '/tmp/fake/lingtai-hook',
          prompt: 'fix {{issue}}',
          merge: false,
          home: '/tmp/fake-home',
          store,
        },
        ports,
      )
      const [runId, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!
      return { result, did, runId, run, item: await store.read(`ticket-${PROJECT}-7`) }
    }

    it('keeps it on the arm at the agent’s own commit, and leaves the branch there too', async () => {
      const { result, did, run } = await hitTheWallDirty(true)
      expect(result.ok, JSON.stringify(result)).toBe('held')

      // In order: add, commit, then a push whose branch refspec carries the
      // agent's own commit — never the WIP sha.
      expect(did.indexOf('git add -A')).toBeLessThan(did.indexOf('git commit --no-verify'))
      const push = `git push ${'b'.repeat(40)}:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1`
      expect(did).toContain(push)
      expect(did.indexOf('git commit --no-verify')).toBeLessThan(did.indexOf(push))

      const kept = run.find((e) => e.type === 'RunKeptUncommitted')
      expect(kept).toBeDefined()
      expect(kept!.data).toMatchObject({
        arm: 'agent/7-attempt-1',
        sha: WIP_SHA,
        parentSha: 'b'.repeat(40),
        stoppedBy: 'out-of-turns',
      })

      // The branch's own `RunProducedDiff` names the agent's commit, not the
      // WIP sha on top of it.
      const produced = run.find((e) => e.type === 'RunProducedDiff')
      expect(produced!.data).toMatchObject({ branch: 'agent/7', headSha: 'b'.repeat(40) })

      // **The durable row must never assert the mergeable branch carries the
      // WIP commit** (`#468`) — `agent/7` is at the agent's own commit, not
      // the WIP sha `keepUncommittedWork` moved `HEAD` onto. `armSha` names
      // where the arm actually is, one commit ahead of `headSha`, which is
      // what stops the history line from reading the two refs as one sha.
      const refs = run.find((e) => e.type === 'RunRefsPublished')
      expect(refs!.data).toMatchObject({ outcome: 'published', headSha: 'b'.repeat(40), armSha: WIP_SHA })
    })

    it('keeps it on the arm alone when the agent itself committed nothing', async () => {
      const { result, did, run } = await hitTheWallDirty(false)
      expect(result.ok, JSON.stringify(result)).toBe('held')

      // The arm, and never `refs/heads/agent/7`.
      const pushes = did.filter((d) => d.startsWith('git push'))
      expect(pushes).toEqual(['git push +HEAD:refs/heads/agent/7-attempt-1'])

      const kept = run.find((e) => e.type === 'RunKeptUncommitted')
      expect(kept).toBeDefined()
      expect(kept!.data).toMatchObject({
        arm: 'agent/7-attempt-1',
        sha: WIP_SHA,
        parentSha: 'a'.repeat(40),
        stoppedBy: 'out-of-turns',
      })

      // Nothing was ever this claim's own commit, so there is no
      // `RunProducedDiff` at all — `RunKeptUncommitted` is the whole account.
      // `approve()`/`waive()` read the former through `RunState.headSha`, and
      // a WIP with no commit of the agent's own must never be offered there.
      expect(run.some((e) => e.type === 'RunProducedDiff')).toBe(false)

      // **Neither row leaves `branch`'s absence unsaid** (`#468`) — the
      // inline publish writes `published`, and the finalizer's own call to
      // the same function (the scope closes once `once()` returns) finds the
      // same state and writes `already-published`; both must say `agent/7`
      // never got this sha, as a typed field rather than a sentence in
      // `detail` for a reader to infer the same thing from.
      const refs = run.filter((e) => e.type === 'RunRefsPublished')
      expect(refs.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['published', 'already-published'])
      for (const row of refs) {
        expect(row.data).toMatchObject({ headSha: WIP_SHA, branchCarries: false, detail: null })
      }
    })

    /**
     * **`noteKept` is retried on the `already-published` call, the same way
     * `recordDiff` already is** (`#468`, `#251`). The first call's append of
     * `RunKeptUncommitted` hits a store that is down; the publish still
     * writes `published` and pushes the WIP, same as the happy path above.
     * The finalizer's own call then finds `branchHead === published` and
     * `head === armPublished`, lands on `already-published`, and — because
     * the store is back by then — must ask `noteKept` again rather than
     * leaving the WIP's own event unrecorded for good.
     */
    it('retries a WIP account the store refused on the first publish call', async () => {
      const { result, run } = await hitTheWallDirty(false, { failKeptOnce: true })
      expect(result.ok, JSON.stringify(result)).toBe('held')

      const refs = run.filter((e) => e.type === 'RunRefsPublished')
      expect(refs.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['published', 'already-published'])

      const kept = run.filter((e) => e.type === 'RunKeptUncommitted')
      expect(kept).toHaveLength(1)
      expect(kept[0]!.data).toMatchObject({ arm: 'agent/7-attempt-1', sha: WIP_SHA, stoppedBy: 'out-of-turns' })
    })

    /**
     * **A half-rejected push on top of a WIP, where two things can go wrong at
     * once** (`#468`). Origin rejects the leased `agent/<n>` and takes the
     * forced arm, exactly as the plain `arm-only` case does — but the arm's
     * own `HEAD` is now the WIP commit, not the agent's last one.
     */
    it('counts only the agent’s own commit on arm-only, and keeps the WIP account once', async () => {
      const stale = '! [remote rejected] agent/7 -> agent/7 (stale info)'
      const { result, run } = await hitTheWallDirty(true, { leasedBranch: stale })
      expect(result.ok, JSON.stringify(result)).toBe('held')

      const refs = run.filter((e) => e.type === 'RunRefsPublished')
      expect(refs.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['arm-only', 'arm-only'])

      // **Never the WIP sha** (`#468`): the guard asks whether the agent
      // committed, and the count it buys must be of that commit alone, not of
      // the uncommitted edits layered on top of it and counted as if reviewed.
      const produced = run.find((e) => e.type === 'RunProducedDiff')
      expect(produced!.data).toMatchObject({ branch: 'agent/7-attempt-1', headSha: 'b'.repeat(40) })

      // `publishWhatIsCommitted` runs twice on this ending (inline, then from
      // the finalizer) and both reach this same branch — one `RunKeptUncommitted`
      // for the one WIP commit, not two.
      const kept = run.filter((e) => e.type === 'RunKeptUncommitted')
      expect(kept).toHaveLength(1)
      expect(kept[0]!.data).toMatchObject({ sha: WIP_SHA, parentSha: 'b'.repeat(40) })
    })

    /**
     * **A push origin never takes at all names the branch's own commit, never
     * the WIP sha on top of it** (`#468`). Both refspecs are rejected — origin
     * is unreachable, not merely stale — so the arm-alone retry fails too and
     * the publish lands on `refused`. `headSha` there must be `branchHead`
     * (the agent's own commit): a person rescuing by hand who instead pushed
     * the WIP sha to `agent/7` would put a `wip:` commit on the one branch the
     * merge lane reads, and `integrate.ts`'s own guard refuses it until
     * somebody unpicks the branch.
     */
    it('names the branch’s own commit on a refused push, never the WIP sha kept on top of it', async () => {
      const unreachable = 'fatal: unable to access — Could not resolve host'
      const { result, run } = await hitTheWallDirty(true, { push: unreachable })
      expect(result.ok, JSON.stringify(result)).toBe('held')

      const refs = run.filter((e) => e.type === 'RunRefsPublished')
      expect(refs.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['refused', 'refused'])
      for (const row of refs) {
        expect(row.data).toMatchObject({ headSha: 'b'.repeat(40) })
      }

      // Neither push ever landed the WIP sha on origin, so there is nothing
      // fetchable to account for — `noteKept` only fires once a push of the
      // arm has actually succeeded (`doc/design/468.md`: "a sha named on the
      // log must be fetchable").
      expect(run.some((e) => e.type === 'RunKeptUncommitted')).toBe(false)
    })

    /**
     * **The WIP commit's own `rev-parse` can fail with `HEAD` already moved
     * onto it** (`#468`) — a killed process, `EAGAIN` under memory pressure.
     * `keepUncommittedWork` must not leave `wip` null on that failure alone:
     * `publishWhatIsCommitted`'s own `rev-parse HEAD`, right after, already has
     * to succeed for anything past it to run, and is what fills `wip.sha` in.
     * Getting this wrong pushes the WIP sha to `agent/7` itself — the one
     * thing the ticket forbids.
     */
    it('keeps the branch at the agent’s own commit even when the WIP’s own sha-read fails', async () => {
      const { did, run } = await (async () => {
        const store = memoryStore()
        const did: string[] = []
        const ports = fakePorts(did, store)
        let dirty = true
        let head = 'b'.repeat(40)
        let revParses = 0
        const inner = ports.repo.git
        ports.repo.git = (args, o) => {
          if (args[0] === 'status') {
            return Effect.sync(() => {
              did.push('git status')
              return dirty ? ' M src/leftover.ts\n' : ''
            })
          }
          if (args[0] === 'rev-parse') {
            revParses += 1
            // The second `rev-parse HEAD` is `keepUncommittedWork`'s own,
            // right after the commit below — the one this test fails. Every
            // other call, including `publishWhatIsCommitted`'s, succeeds.
            if (revParses === 2) {
              return Effect.sync(() => did.push('git rev-parse (failed)')).pipe(
                Effect.andThen(repoFailedWith('git rev-parse', 'EAGAIN')),
              )
            }
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

        const result = await once(
          {
            project,
            client: fakeGitHub([]),
            runtime: atTheWall,
            issue: 7,
            hookBinary: '/tmp/fake/lingtai-hook',
            prompt: 'fix {{issue}}',
            merge: false,
            home: '/tmp/fake-home',
            store,
          },
          ports,
        )
        expect(result.ok, JSON.stringify(result)).toBe('held')
        const [, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!
        return { did, run }
      })()

      // The branch's refspec carries the agent's own commit, never the WIP
      // sha the failed read could not confirm.
      const push = `git push ${'b'.repeat(40)}:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1`
      expect(did).toContain(push)

      const refs = run.find((e) => e.type === 'RunRefsPublished')
      expect(refs!.data).toMatchObject({ outcome: 'published', headSha: 'b'.repeat(40) })

      const kept = run.find((e) => e.type === 'RunKeptUncommitted')
      expect(kept!.data).toMatchObject({ sha: WIP_SHA, parentSha: 'b'.repeat(40) })
    })

    /**
     * **A keep that could not even check the tree writes something durable**
     * (`#468`) — `git status --porcelain` itself failing, not the dirty-tree
     * answer. Before this fix both this and a failed `rev-parse` on the parent
     * returned with no `runLog.note` and no `detail` anywhere; this pins the
     * `detail` half, since the run log is a trace and never a record (0034 §8).
     */
    it('puts a failed status check into RunRefsPublished.detail, not only the run log', async () => {
      const store = memoryStore()
      const did: string[] = []
      const ports = fakePorts(did, store)
      const inner = ports.repo.git
      ports.repo.git = (args, o) => {
        if (args[0] === 'status') {
          return Effect.sync(() => did.push('git status (failed)')).pipe(
            Effect.andThen(repoFailedWith('git status', 'index corrupt')),
          )
        }
        if (args[0] === 'rev-parse') {
          return Effect.sync(() => {
            did.push('git rev-parse')
            return 'a'.repeat(40)
          })
        }
        return inner(args, o)
      }

      const result = await once(
        {
          project,
          client: fakeGitHub([]),
          runtime: atTheWall,
          issue: 7,
          hookBinary: '/tmp/fake/lingtai-hook',
          prompt: 'fix {{issue}}',
          merge: false,
          home: '/tmp/fake-home',
          store,
        },
        ports,
      )
      expect(result.ok, JSON.stringify(result)).toBe('held')
      const [, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!

      const refs = run.find((e) => e.type === 'RunRefsPublished')
      expect(refs!.data).toMatchObject({ outcome: 'nothing-committed' })
      expect(String((refs!.data as { detail: string }).detail)).toContain('index corrupt')
    })

    /**
     * **Staging everything and then unstaging the planted env file by name is
     * what keeps its secrets out of the WIP commit** (`#468`, `#470`) —
     * `kept-run-port.ts`'s `commitWipExceptPlanted` does this rather than a
     * `:(exclude)` pathspec on the `add`, which exits 1 whenever the
     * repository's own `.gitignore` already covers the planted path.
     * `keepUncommittedWork` must go through that same helper.
     */
    it('unstages the planted env file from the WIP commit’s staging', async () => {
      const store = memoryStore()
      const did: string[] = []
      const ports = fakePorts(did, store)
      const inner = ports.repo.git
      let dirty = true
      let head = 'b'.repeat(40)
      ports.repo.git = (args, o) => {
        if (args[0] === 'status') {
          return Effect.sync(() => {
            did.push('git status')
            return dirty ? ' M src/leftover.ts\n?? .env.local\n' : ''
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
            did.push(`git add ${args.slice(1).join(' ')}`)
            return ''
          })
        }
        if (args[0] === 'reset') {
          return Effect.sync(() => {
            did.push(`git reset ${args.slice(1).join(' ')}`)
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

      const result = await once(
        {
          project,
          client: fakeGitHub([]),
          runtime: atTheWall,
          issue: 7,
          hookBinary: '/tmp/fake/lingtai-hook',
          prompt: 'fix {{issue}}',
          merge: false,
          home: '/tmp/fake-home',
          store,
        },
        ports,
      )
      expect(result.ok, JSON.stringify(result)).toBe('held')

      // A bare `git add -A` — never a `:(exclude)` pathspec, which exits 1
      // whenever the repository's own `.gitignore` already covers the
      // planted path (`#470`).
      expect(did).toContain('git add -A')

      // **The `add` above stages the planted file along with everything
      // else — it is this `reset` that takes it back out** (`#468`, `#470`),
      // unconditionally and after the `add`, which is the only way that works
      // whether or not the repository ignores the path and whether or not an
      // earlier `add` by the agent had already staged it.
      expect(did).toContain('git reset -q -- .env.local')
      expect(did.indexOf('git add -A')).toBeLessThan(did.indexOf('git reset -q -- .env.local'))
      expect(did.indexOf('git reset -q -- .env.local')).toBeLessThan(did.indexOf('git commit --no-verify'))

      const [, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!
      const kept = run.find((e) => e.type === 'RunKeptUncommitted')
      expect(kept!.data).toMatchObject({ sha: WIP_SHA, parentSha: 'b'.repeat(40) })
    })

    /**
     * **Dirt that is only the planted env file is not agent work to keep**
     * (`#468`) — a stopped run that never touched the worktree still shows a
     * dirty `git status --porcelain` in a repo whose `.gitignore` does not
     * cover `plantAt`, since `provisionWorktree` writes it untracked. Reading
     * that as something to commit is the exact scenario the review refused:
     * `RunKeptUncommitted` would assert a file of the agent's own work was
     * kept when the agent left nothing at all.
     */
    it('treats dirt that is only the planted env file as nothing to keep', async () => {
      const store = memoryStore()
      const did: string[] = []
      const ports = fakePorts(did, store)
      const inner = ports.repo.git
      const head = 'a'.repeat(40)
      ports.repo.git = (args, o) => {
        if (args[0] === 'status') {
          return Effect.sync(() => {
            did.push('git status')
            return '?? .env.local\n'
          })
        }
        if (args[0] === 'rev-parse') {
          return Effect.sync(() => {
            did.push('git rev-parse')
            return head
          })
        }
        return inner(args, o)
      }

      const result = await once(
        {
          project,
          client: fakeGitHub([]),
          runtime: atTheWall,
          issue: 7,
          hookBinary: '/tmp/fake/lingtai-hook',
          prompt: 'fix {{issue}}',
          merge: false,
          home: '/tmp/fake-home',
          store,
        },
        ports,
      )
      expect(result.ok, JSON.stringify(result)).toBe('held')

      // Neither `git add` nor `git commit` is ever asked for a tree whose
      // only dirt is a path no commit may carry.
      expect(did.some((d) => d.startsWith('git add'))).toBe(false)
      expect(did.some((d) => d.includes('commit'))).toBe(false)

      const [, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!
      expect(run.some((e) => e.type === 'RunKeptUncommitted')).toBe(false)

      const refs = run.find((e) => e.type === 'RunRefsPublished')
      expect(refs!.data).toMatchObject({ outcome: 'nothing-committed', detail: null })
    })

    /**
     * **A failed keep's own reason must not outlive the attempt that failed**
     * (`#468`). `wipFailure` used to stay set once a keep failed, and the
     * finalizer's retry of the same commit found `wipParent` still null (the
     * guard at `keepUncommittedWork`'s own top only skips a *successful*
     * keep) and tried again. Where that retry succeeds, the row it writes
     * must say so — not repeat the first attempt's failure text.
     */
    it('clears a stale WIP failure once a retried keep succeeds', async () => {
      const store = memoryStore()
      const did: string[] = []
      const ports = fakePorts(did, store)
      const inner = ports.repo.git
      let dirty = true
      let head = 'a'.repeat(40)
      let commitAttempts = 0
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
          commitAttempts += 1
          if (commitAttempts === 1) {
            return Effect.sync(() => did.push('git commit (failed)')).pipe(
              Effect.andThen(repoFailedWith('git commit', 'EAGAIN')),
            )
          }
          return Effect.sync(() => {
            did.push('git commit --no-verify')
            dirty = false
            head = WIP_SHA
            return ''
          })
        }
        return inner(args, o)
      }

      const result = await once(
        {
          project,
          client: fakeGitHub([]),
          runtime: atTheWall,
          issue: 7,
          hookBinary: '/tmp/fake/lingtai-hook',
          prompt: 'fix {{issue}}',
          merge: false,
          home: '/tmp/fake-home',
          store,
        },
        ports,
      )
      expect(result.ok, JSON.stringify(result)).toBe('held')
      const [, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!

      const refs = run.filter((e) => e.type === 'RunRefsPublished')
      expect(refs.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['nothing-committed', 'published'])
      expect(String((refs[0]!.data as { detail: string }).detail)).toContain('EAGAIN')
      // **The retry's own row must not repeat the first attempt's stale
      // failure** — the second keep succeeded, so this row's `detail` says
      // nothing about a failed commit.
      expect(refs[1]!.data).toMatchObject({ outcome: 'published', detail: null })

      const kept = run.find((e) => e.type === 'RunKeptUncommitted')
      expect(kept!.data).toMatchObject({ sha: WIP_SHA, stoppedBy: 'out-of-turns' })
    })
  })

  /**
   * **A refused push's commits survive the worktree, in a ref of their own**
   * (`#421`). `#250` lost two commits as unreachable objects because nothing
   * pointed at them once the worktree was removed; this is the ref that
   * points at them, written before that removal, and `keptAt` is the field
   * that tells a person where.
   */
  describe('and a refused push keeps the head in the mirror', () => {
    type Unpushed = { branch: string; said: string; keptAt?: { _tag: string; ref: string; sha: string; arm?: string } }

    const unpushedOf = (item: readonly Envelope[]): Unpushed | undefined => {
      const blocked = item.find((e) => e.type === 'WaitStarted')!
      return (blocked.data as { reason: { run?: { unpushed?: Unpushed } } }).reason.run?.unpushed
    }

    it('writes the mirror ref before the worktree is removed, and the wait names it', async () => {
      const rejected = '! [remote rejected] agent/7 -> agent/7 (stale info)'
      const { did, runId, item } = await hitTheWall(true, { push: rejected })

      const write = `git update-ref refs/lingtai/unpushed/7/${runId} ${'b'.repeat(40)}`
      expect(did).toContain(write)
      expect(did.indexOf(write)).toBeLessThan(did.indexOf(`remove ${runId}`))

      const unpushed = unpushedOf(item)
      expect(unpushed?.keptAt).toMatchObject({
        _tag: 'Mirror',
        ref: `refs/lingtai/unpushed/7/${runId}`,
        sha: 'b'.repeat(40),
        arm: 'refs/heads/agent/7-attempt-1',
      })
    })

    /**
     * **`arm-only` is not a refusal to keep anything from** — the commits
     * are already on origin, as the arm, so a mirror ref would be a second
     * place pointing at work that is not lost. `keptAt` says `Arm` instead,
     * naming the ref that already carries it.
     */
    it('names the arm instead of the mirror when only the arm got through', async () => {
      const stale = '! [remote rejected] agent/7 -> agent/7 (stale info)'
      const { did, item } = await hitTheWall(true, { leasedBranch: stale })

      expect(did.some((d) => d.startsWith('git update-ref') && !d.includes(' -d '))).toBe(false)

      const unpushed = unpushedOf(item)
      expect(unpushed?.keptAt).toMatchObject({
        _tag: 'Arm',
        ref: 'refs/heads/agent/7-attempt-1',
        sha: 'b'.repeat(40),
      })
    })

    /**
     * **No head, nothing to keep.** `rev-parse HEAD` itself failing is the
     * one `refused` ending with no sha to write anywhere — `unpushed` is
     * still recorded, with no `keptAt` on it.
     */
    it('records unpushed with no keptAt when rev-parse HEAD itself fails', async () => {
      const store = memoryStore()
      const did: string[] = []
      const ports = fakePorts(did, store)
      const inner = ports.repo.git
      ports.repo.git = (args, o) => {
        if (args[0] === 'status') {
          return Effect.sync(() => {
            did.push('git status')
            return ''
          })
        }
        if (args[0] === 'rev-parse') {
          return Effect.sync(() => did.push('git rev-parse (failed)')).pipe(
            Effect.andThen(repoFailedWith('git rev-parse', 'the index is locked')),
          )
        }
        return inner(args, o)
      }

      const result = await once(
        {
          project,
          client: fakeGitHub([]),
          runtime: atTheWall,
          issue: 7,
          hookBinary: '/tmp/fake/lingtai-hook',
          prompt: 'fix {{issue}}',
          merge: false,
          home: '/tmp/fake-home',
          store,
        },
        ports,
      )
      expect(result.ok, JSON.stringify(result)).toBe('held')
      const item = await store.read(`ticket-${PROJECT}-7`)

      expect(did.some((d) => d.startsWith('git update-ref'))).toBe(false)
      const unpushed = unpushedOf(item)
      expect(unpushed).toBeDefined()
      expect(unpushed?.keptAt).toBeUndefined()
    })

    /**
     * **Once the commits reach origin, the mirror ref goes with them.**
     * `publishWhatIsCommitted` runs twice on this ending — inline, where the
     * push is refused and the ref is written, and again from the finalizer,
     * where (the sibling claim that invalidated the lease now gone) the same
     * push succeeds. The mirror never holds a ref for work the second call
     * just put on origin.
     */
    it('deletes the mirror ref once the finalizer’s own retry publishes', async () => {
      const rejected = '! [remote rejected] agent/7 -> agent/7 (stale info)'
      const store = memoryStore()
      const did: string[] = []
      const said: string[] = []
      const ports = fakePorts(did, store)
      let pushAttempts = 0
      const inner = ports.repo.git
      ports.repo.git = (args, o) => {
        if (args[0] === 'push') {
          pushAttempts += 1
          if (pushAttempts <= 2) {
            return Effect.sync(() => {
              did.push(`git push ${args.filter((a) => a.includes(':refs/heads/')).join(' ')}`)
            }).pipe(Effect.andThen(pushRefusedWith(rejected)))
          }
        }
        if (args[0] === 'update-ref' || args[0] === 'for-each-ref') {
          return Effect.sync(() => {
            did.push(`git ${args.join(' ')}`)
            return ''
          })
        }
        return inner(args, o)
      }

      const result = await once(
        {
          project,
          client: fakeGitHub(said),
          runtime: atTheWall,
          issue: 7,
          hookBinary: '/tmp/fake/lingtai-hook',
          prompt: 'fix {{issue}}',
          merge: false,
          home: '/tmp/fake-home',
          store,
        },
        ports,
      )
      expect(result.ok, JSON.stringify(result)).toBe('held')
      const [runId, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!

      const rows = run.filter((e) => e.type === 'RunRefsPublished')
      expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['refused', 'published'])

      const ref = `refs/lingtai/unpushed/7/${runId}`
      const write = `git update-ref ${ref} ${'b'.repeat(40)}`
      const drop = `git update-ref -d ${ref}`
      expect(did).toContain(write)
      expect(did).toContain(drop)
      expect(did.indexOf(write)).toBeLessThan(did.indexOf(drop))
    })
  })
})

/**
 * **A landing is the one place a kept ref is ever cleaned up** (`#421`) —
 * the worktree still exists when it runs (`repo.remove` is a finalizer, and
 * the publish finalizer is skipped on this path), so this is the only
 * opportunity, and it takes every ref under the ticket's own number rather
 * than only this run's — an earlier run of the same ticket may have left one
 * too.
 */
describe('when the ticket lands', () => {
  it('deletes every kept ref for the ticket', async () => {
    const store = memoryStore()
    const did: string[] = []
    const said: string[] = []
    const ports = fakePorts(did, store, true)
    const inner = ports.repo.git
    ports.repo.git = (args, o) => {
      if (args[0] === 'for-each-ref') {
        return Effect.sync(() => {
          did.push(`git ${args.join(' ')}`)
          return 'refs/lingtai/unpushed/7/run-aaa\nrefs/lingtai/unpushed/7/run-bbb\n'
        })
      }
      if (args[0] === 'update-ref') {
        return Effect.sync(() => {
          did.push(`git ${args.join(' ')}`)
          return ''
        })
      }
      return inner(args, o)
    }

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
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
    expect(result.ok, JSON.stringify(result)).toBe(true)

    expect(did.filter((d) => d.startsWith('git for-each-ref'))).toHaveLength(1)
    expect(did).toContain('git update-ref -d refs/lingtai/unpushed/7/run-aaa')
    expect(did).toContain('git update-ref -d refs/lingtai/unpushed/7/run-bbb')
  })
})

/**
 * **The other ending that publishes nothing of its own, and it is the one that
 * reaches the merge lane** (0062 §2).
 *
 * `land` pushes `agent/<n>` alone — the lane is about to merge that ref, and an
 * arm written for a landing is one 0062 §4's sweep takes straight back off — and
 * it records the head as published. So a lane that then *refuses* leaves the
 * branch on origin and the arm on none, and the end-of-pass publish used to read
 * its own `published` as the whole answer, short-circuit as `already-published`,
 * push nothing, and write a row naming an `arm` that has never existed.
 *
 * What that costs is exactly what the arm exists to prevent. The card blocks
 * recommending a requeue, attempt 2's `--force-with-lease` matches the lease and
 * overwrites `agent/<n>` from a fresh base, and attempt 1's commits — the diff
 * the live `ApprovalRequested` named — are unreachable on origin with no ref of
 * their own, under a log row asserting both refs went up.
 */
describe('when the merge lane refuses what every step passed', () => {
  const budget = { evidence: 2_000, attempts: 3, findings: 5 }

  /**
   * A lane that says no, with a reason no judge answers.
   *
   * `dirty-base` is one of the five `directionOf` calls null — they stop the lane
   * before the diff is what is in doubt — so the pass is held for a person with
   * no round bought and no second agent, which keeps this test about the refs.
   * `conflict`, `no-commits` and `pending-migration` reach the same publish.
   */
  const theLaneRefuses = async () => {
    const store = memoryStore()
    const did: string[] = []
    const said: string[] = []
    const ports = fakePorts(did, store, true)
    ports.repo.integrate = () =>
      Effect.sync(() => {
        did.push('integrate')
        return { ok: false, reason: 'dirty-base', detail: 'the base branch has local changes' } as never
      })
    const appended = store.append.bind(store) as EventStore['append']
    store.append = async (stream, at, events) => {
      for (const e of events) did.push(`append ${e.type}`)
      return appended(stream, at, events)
    }

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        // No `--no-merge`: the lane has to be reached for this ending to exist.
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      ports,
    )
    const [runId, run] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!
    return { result, did, runId, run, item: await store.read(`ticket-${PROJECT}-7`) }
  }

  it("leaves this attempt's own arm on origin, and does not call it already published", async () => {
    const { result, did, run, item } = await theLaneRefuses()
    expect(result.ok, JSON.stringify(result)).toBe('held')

    // The lane pushed the branch on its way in, and the ending published the arm
    // beside it — the second push is the one that was missing.
    const both = 'git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1'
    expect(did).toContain('git push HEAD:refs/heads/agent/7')
    expect(did).toContain(both)
    expect(did.indexOf('integrate')).toBeLessThan(did.indexOf(both))
    // Before the person is asked, like every other ending that asks one.
    expect(did.indexOf(both)).toBeLessThan(did.indexOf('append WaitStarted'))

    // And the log says so rather than claiming the refs were already up: the
    // first row is this publish, the second is the finalizer finding nothing
    // left to do.
    const rows = run.filter((e) => e.type === 'RunRefsPublished')
    expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['published', 'already-published'])
    expect(rows[0]!.data).toMatchObject({
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'b'.repeat(40),
    })

    // The whole of what the arm is for: one `lingtai requeue` makes this attempt
    // 2, and the ref its brief names is on origin.
    const brief = nextPrompt({ base: 'ticket@1', budget, item, lastRun: run }).failure
    expect(brief).toContain('git fetch origin agent/7')
  })
})
