import { describe, expect, it } from 'vitest'

import { emptyWorkItem, reduceWorkItem, retiredRepairPending, WorkItemBlocked } from '../src/index.ts'
import { makeStream, unknownEvent } from '../test/support.ts'

const discovered = {
  project: 'nextloom-ai-admin',
  source: 'github-issue' as const,
  externalRef: '117',
  title: 'Migration hold',
  kind: 'bug' as const,
  labels: ['agent:ready'],
}

describe('reduceWorkItem', () => {
  it('is backlog with nothing known before its first event', () => {
    const s = reduceWorkItem([])
    expect(s).toEqual(emptyWorkItem)
    expect(s.lifecycle.status).toBe('backlog')
    expect(s.version).toBe(0)
  })

  it('records what discovery knew', () => {
    const e = makeStream('wi-nextloom-ai-admin-117')
    const s = reduceWorkItem([e('WorkItemDiscovered', discovered)])

    expect(s.project).toBe('nextloom-ai-admin')
    expect(s.externalRef).toBe('117')
    expect(s.kind).toBe('bug')
    expect(s.labels).toEqual(['agent:ready'])
    expect(s.lifecycle.status).toBe('backlog')
  })

  it('walks discovered → claimed → landed', () => {
    const e = makeStream('wi-nextloom-ai-admin-117')
    const s = reduceWorkItem([
      e('WorkItemDiscovered', discovered),
      e('WorkItemClaimed', { runId: 'run-01JX', worker: 'conductor@host', title: null, kind: null }),
      e('WorkItemLanded', { mergeCommit: 'abc1234', base: 'develop' }),
    ])

    expect(s.lifecycle).toEqual({ status: 'landed', mergeCommit: 'abc1234', base: 'develop' })
    expect(s.runs).toEqual(['run-01JX'])
    expect(s.version).toBe(3)
  })

  it('returns to the backlog when released, and the lease goes with it', () => {
    const e = makeStream('wi-p-1')
    const s = reduceWorkItem([
      e('WorkItemDiscovered', discovered),
      e('WorkItemClaimed', { runId: 'run-a', worker: 'w', title: null, kind: null }),
      e('WorkItemReleased', { runId: 'run-a', reason: 'lease expired' }),
    ])

    expect(s.lifecycle).toEqual({ status: 'backlog' })
    // The run is still on the record — it happened — but it holds nothing.
    expect(s.runs).toEqual(['run-a'])
  })

  it('carries the question when blocked, and drops it when unblocked', () => {
    const e = makeStream('wi-p-1')
    const hold = {
      _tag: 'Human' as const,
      run: { runId: 'run-a' },
      step: 'proposed' as const,
      source: 'declared' as const,
      question: 'Which base branch should this target?',
    }
    const events = [e('WorkItemDiscovered', discovered), e('WorkItemBlocked', { hold })]

    const blocked = reduceWorkItem(events)
    expect(blocked.lifecycle).toEqual({
      status: 'blocked',
      hold,
      // The step prefix is composed by `legacyColumns`, rebuilding the card
      // line `whatIsWaitingOnYou` wrote before #445 — the bare question is on
      // `hold.question` itself.
      question: 'the `proposed` step held: Which base branch should this target?',
      needsFrom: 'human',
      runId: 'run-a',
      needs: 'judgement',
      diagnosis: {
        what: 'the `proposed` step held: Which base branch should this target?',
        done: null,
        raw: 'Which base branch should this target?',
        // Not `merge`, so a `Human` here is never recommended `approve` —
        // `legacyColumns` cannot see a findings veto on this variant either way.
        recommendation: null,
      },
    })

    const unblocked = reduceWorkItem([...events, e('WorkItemUnblocked', { by: 'human:steven', note: 'develop' })])
    expect(unblocked.lifecycle).toEqual({ status: 'backlog' })
    // The answer is not dropped with the question (#147).
    expect(unblocked.answers).toEqual([
      {
        question: 'the `proposed` step held: Which base branch should this target?',
        runId: 'run-a',
        answer: 'develop',
        by: 'human:steven',
      },
    ])
  })

  /**
   * A question asked before anything is spent (#147).
   *
   * `runId: null` was written into the type and never into the log: all three
   * appenders ran inside a pass. `lingtai ask` is the first that does not, so
   * the fold has to accept a block that belongs to no run — with no claim before
   * it and nothing in `runs` — and a replay of the answer has to be able to say
   * what the answer was.
   */
  it('accepts a block that belongs to no run, and keeps the answer that ends it', () => {
    const e = makeStream('wi-lingtai-51')
    const hold = {
      _tag: 'Question' as const,
      question: 'Which of the three designs for the production-credential tripwire?',
      by: 'steven',
    }
    const asked = [e('WorkItemBlocked', { hold })]

    const waiting = reduceWorkItem(asked)
    expect(waiting.lifecycle).toEqual({
      status: 'blocked',
      hold,
      question: 'Which of the three designs for the production-credential tripwire?',
      needsFrom: 'human',
      runId: null,
      needs: 'judgement',
      // `lingtai ask`'s own question carries no diagnosis, same as before #445.
      diagnosis: null,
    })
    expect(waiting.runs).toEqual([])

    const answered = reduceWorkItem([
      ...asked,
      e('WorkItemUnblocked', { by: 'human:steven', note: 'the second: refuse at the hook' }),
      e('WorkItemClaimed', { runId: 'run-a', worker: 'w', title: null, kind: null }),
    ])
    expect(answered.lifecycle.status).toBe('claimed')
    // Durable: a claim consumes a prompt edit and does not consume a decision.
    expect(answered.answers).toEqual([
      {
        question: 'Which of the three designs for the production-credential tripwire?',
        runId: null,
        answer: 'the second: refuse at the hook',
        by: 'human:steven',
      },
    ])

    // Withdrawn rather than answered: back in the backlog, and nothing kept.
    const withdrawn = reduceWorkItem([
      ...asked,
      e('WorkItemUnblocked', { by: 'human:steven', note: 'asked by mistake, ignore', withdrawn: true }),
    ])
    expect(withdrawn.lifecycle).toEqual({ status: 'backlog' })
    expect(withdrawn.answers).toEqual([])
  })

  /**
   * The two kinds of block, told apart on the log (#83).
   *
   * `held at the merge gate` and `conflict: agent/112 does not merge into
   * develop` were both `WorkItemBlocked` with a string, and they are opposite
   * kinds of thing: one wants a person's judgement, the other wants a diagnosis
   * nobody had written. A fold that cannot distinguish them cannot let a card
   * offer a default action, which is the whole of what the ticket asked for.
   */
  it('tells a judgement apart from a failure needing acknowledgement', () => {
    const e = makeStream('wi-nextloom-ai-admin-112')
    const judgement = reduceWorkItem([
      e('WorkItemBlocked', {
        hold: {
          _tag: 'Human' as const,
          run: { runId: 'run-a' },
          step: 'merge' as const,
          source: 'injected' as const,
          question: 'held at the merge step: agent/112 into develop',
        },
      }),
    ])
    const failure = reduceWorkItem([
      e('WorkItemBlocked', {
        hold: {
          _tag: 'MergeRefused' as const,
          run: { runId: 'run-b' },
          reason: 'conflict' as const,
          why: 'agent/112 does not merge into develop.',
          paths: ['apps/web/src/user-lookup-panel.tsx'],
          baseSha: 'base123',
          headSha: 'head456',
          raw: 'CONFLICT (content): Merge conflict in apps/web/src/…',
        },
      }),
    ])

    expect(judgement.lifecycle).toMatchObject({ status: 'blocked', needs: 'judgement' })
    expect(failure.lifecycle).toMatchObject({ status: 'blocked', needs: 'acknowledgement' })
    // And the recommendation is a value, not a sentence to parse: `approve` is a
    // legitimate one, which is what makes the board's default action possible.
    // A `Human` at `merge` is recommended `approve` regardless of findings —
    // the variant carries none, unlike `Routed` (#445's design).
    expect(judgement.lifecycle.status === 'blocked' && judgement.lifecycle.diagnosis?.recommendation).toEqual({
      action: 'approve',
      why: 'every step passed on this diff; approving merges what this run produced',
    })
    // A conflict recommends a requeue — the next attempt is cut from a base
    // that has moved — which is `REFUSAL_READING.conflict.move` in `attribution.ts`.
    expect(failure.lifecycle.status === 'blocked' && failure.lifecycle.diagnosis?.recommendation).toEqual({
      action: 'requeue',
      why: 'it is cut from a base that has since moved, so a fresh attempt starts from where the base is now',
    })
    // The raw failure survives the summary. A sentence that hides the git
    // output would be worse than the git output.
    expect(failure.lifecycle.status === 'blocked' && failure.lifecycle.diagnosis?.raw).toContain('CONFLICT (content)')
  })

  /**
   * The regression this whole aggregate exists for. #35 held `agent:blocked` and
   * `agent:review` at once because labels are a set, not a state. Here the
   * lifecycle is one value, so the second transition replaces the first — there
   * is no state in which both are true, and no way to construct one.
   */
  it('cannot be blocked and claimed at the same time', () => {
    const e = makeStream('wi-nextloom-ai-admin-35')
    const s = reduceWorkItem([
      e('WorkItemDiscovered', discovered),
      e('WorkItemBlocked', { hold: { _tag: 'Question' as const, question: '?', by: 'steven' } }),
      e('WorkItemClaimed', { runId: 'run-b', worker: 'w', title: null, kind: null }),
    ])

    expect(s.lifecycle.status).toBe('claimed')
    expect(Object.keys(s.lifecycle).sort()).toEqual(['runId', 'status', 'worker'])
    expect(s.lifecycle).not.toHaveProperty('question')
  })

  it('links a filed bug to the merge that caused it, without duplicating', () => {
    const e = makeStream('wi-nextloom-ai-admin-134')
    const link = { relation: 'caused-by' as const, otherRef: '58' }
    const s = reduceWorkItem([
      e('WorkItemDiscovered', { ...discovered, externalRef: '134' }),
      e('WorkItemLinked', link),
      e('WorkItemLinked', link),
    ])

    expect(s.links).toEqual([link])
  })

  it('keeps every refused dispatch rather than counting them', () => {
    const e = makeStream('wi-p-1')
    const s = reduceWorkItem([
      e('WorkItemDiscovered', discovered),
      e('DispatchRefused', {
        requiredTier: 'sandboxed' as const,
        runtime: 'claude-code' as const,
        missing: ['filesystem-sandbox'],
      }),
    ])

    expect(s.dispatchRefusals).toHaveLength(1)
    expect(s.dispatchRefusals[0]!.missing).toEqual(['filesystem-sandbox'])
    // A refusal is not a transition: the item is still in the backlog, and the
    // tier was not silently downgraded to make it run.
    expect(s.lifecycle.status).toBe('backlog')
  })

  /**
   * A log that still holds `RepairRequested` folds, and the event decides
   * nothing (`#143`).
   *
   * This fold used to carry `repairs`, `pendingRepair` and `repairRun`: the
   * event was appended just before the release, so between the two the item
   * carried a pending repair and the next claim *became* it
   * ([0025](../../../doc/decisions-archive/0025-a-failure-buys-one-agent.md)). A lane
   * refusal buys nothing since
   * [0039](../../../doc/decisions-archive/0039-the-worktree-is-the-whole-of-a-pass.md)
   * §Consequences, so the type is retired — readable for ever, appended never —
   * and the three fields are gone with the purchase.
   *
   * **The property pinned here is that the rows are harmless, not that they are
   * absent.** A replay of Lingtai's own log reaches this event, and a reducer
   * that threw or skipped it would take `projection rebuild` out for the exact
   * reason 0019 gives. So: the same lifecycle as a log without it, and the
   * version still advancing, so the next append does not use a stale
   * expectation.
   */
  it('folds a retired RepairRequested as nothing but a version bump', () => {
    const e = makeStream('wi-p-1')
    const bought = {
      runId: 'run-a',
      reason: 'conflict' as const,
      detail: 'agent/1 does not merge into main: page.tsx',
      fingerprint: '0123456789ab',
      attempt: 1,
    }

    const withIt = reduceWorkItem([
      e('WorkItemClaimed', { runId: 'run-a', worker: 'w', title: null, kind: null }),
      e('RepairRequested', bought),
      e('WorkItemReleased', { runId: 'run-a', reason: 'repairing conflict (attempt 1)' }),
      e('WorkItemClaimed', { runId: 'run-b', worker: 'w', title: null, kind: null }),
    ])

    const f = makeStream('wi-p-2')
    const without = reduceWorkItem([
      f('WorkItemClaimed', { runId: 'run-a', worker: 'w', title: null, kind: null }),
      f('WorkItemReleased', { runId: 'run-a', reason: 'repairing conflict (attempt 1)' }),
      f('WorkItemClaimed', { runId: 'run-b', worker: 'w', title: null, kind: null }),
    ])

    expect(withIt.lifecycle).toEqual(without.lifecycle)
    expect(withIt.runs).toEqual(without.runs)
    // One event more, so one version more — and nothing else moved.
    expect(withIt.version).toBe(without.version + 1)
  })

  /**
   * The one question an old stream is still asked: is a repair the old code
   * bought waiting for a claim? That is the item a daemon restarted onto
   * `#143` finds in its queue, and it is owed the run it was released for —
   * so the answer is there until the next claim, and gone after it.
   */
  it('reports a retired repair as pending until the next claim consumes it', () => {
    const e = makeStream('wi-p-3')
    const bought = {
      runId: 'run-a',
      reason: 'verify-failed' as const,
      detail: 'policy: exit 1',
      fingerprint: '0123456789ab',
      attempt: 1,
    }
    const released = [
      e('WorkItemClaimed', { runId: 'run-a', worker: 'w', title: null, kind: null }),
      e('RepairRequested', bought),
      e('WorkItemReleased', { runId: 'run-a', reason: 'repairing verify-failed (attempt 1)' }),
    ]
    expect(retiredRepairPending(released)).toEqual({
      after: 'run-a',
      reason: 'verify-failed',
      detail: 'policy: exit 1',
      attempt: 1,
    })
    expect(
      retiredRepairPending([
        ...released,
        e('WorkItemClaimed', { runId: 'run-b', worker: 'w', title: null, kind: null }),
      ]),
    ).toBeNull()
  })

  /**
   * The second ceiling, counted off the log rather than remembered
   * ([0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md) §2).
   *
   * The property that matters is what it does *not* have: no pending record, and
   * nothing a claim consumes. A repair needed one because the next claim had to
   * *become* the repair; a restart is an ordinary claim, told what every second
   * attempt is told, so the only thing the fold owes anybody is the count and
   * each arm's evidence. Since `#143` it is the only list of its kind left.
   */
  it('counts the approaches a ticket abandoned, and hands the next claim nothing', () => {
    const e = makeStream('wi-p-1')
    const arm = (runId: string, restart: number) => ({
      runId,
      restart,
      of: 2,
      action: 'review',
      rounds: 3,
      branch: 'agent/1',
      headSha: '8634c5d',
      findings: [
        {
          file: 'packages/daemon/src/daemon.ts',
          line: 124,
          claim: 'startBeacon sits inside the lock',
          failureScenario: 'the first beat throws and the lock is never released',
          severity: 'major' as const,
        },
      ],
    })

    const after = reduceWorkItem([
      e('WorkItemClaimed', { runId: 'run-a', worker: 'w', title: null, kind: null }),
      e('PassRestarted', arm('run-a', 1)),
      e('WorkItemReleased', { runId: 'run-a', reason: '…restart 1 of 2' }),
      e('WorkItemClaimed', { runId: 'run-b', worker: 'w', title: null, kind: null }),
    ])

    // The claim does not consume it, unlike the pending repair this fold used
    // to carry: this is a bound on the ticket and not an instruction to the
    // next run.
    expect(after.restarts).toHaveLength(1)
    expect(after.restarts[0]!.after).toBe('run-a')
    // And it is claimed, not blocked — a restart is not a state an item is in.
    expect(after.lifecycle.status).toBe('claimed')

    // **Each arm's findings survive**, which is the criterion 0040 §3 rests on:
    // the run that was refused is on a stream no later pass reads, so if they
    // were not here a person asked after the last restart would see one
    // refusal and have to guess about the others.
    expect(after.restarts[0]!.findings[0]!.failureScenario).toContain('never released')

    const twice = reduceWorkItem([e('PassRestarted', arm('run-a', 1)), e('PassRestarted', arm('run-b', 2))])
    expect(twice.restarts.map((r) => r.restart)).toEqual([1, 2])
  })

  it('ignores an event type it has never heard of, but still advances', () => {
    const e = makeStream('wi-p-1')
    const first = e('WorkItemDiscovered', discovered)
    const s = reduceWorkItem([first, unknownEvent('wi-p-1', 2)])

    expect(s.title).toBe('Migration hold')
    expect(s.lifecycle.status).toBe('backlog')
    // Version still advances, so the next append does not use a stale expectation.
    expect(s.version).toBe(2)
  })

  /**
   * The one-shot edit
   * ([0032](../../../doc/decisions-archive/0032-the-page-is-organised-by-attempt.md)
   * §5). It applies to the next run and to no other, which is what makes a
   * stale instruction impossible rather than merely guarded against. It is the
   * only thing a claim consumes now that `pendingRepair` is gone (`#143`).
   */
  it('holds a prompt edit until the next claim, and no longer', () => {
    const e = makeStream('wi-p-1')
    const edited = reduceWorkItem([
      e('WorkItemDiscovered', discovered),
      e('PromptEdited', {
        text: 'pass --max-turns',
        hash: 'a91f2e',
        by: 'human:steven',
        basedOn: 'ticket@1924',
        chatId: 'chat-1',
      }),
    ])
    expect(edited.pendingPrompt).toEqual({ text: 'pass --max-turns', by: 'human:steven' })

    const f = makeStream('wi-p-2')
    const consumed = reduceWorkItem([
      f('WorkItemDiscovered', discovered),
      f('PromptEdited', {
        text: 'pass --max-turns',
        hash: 'a91f2e',
        by: 'human:steven',
        basedOn: 'ticket@1924',
        chatId: 'chat-1',
      }),
      f('WorkItemClaimed', { runId: 'run-a', worker: 'w', title: null, kind: null }),
    ])
    expect(consumed.pendingPrompt).toBeNull()
  })

  /** A second edit replaces the first: two sentences nobody re-read is a prompt nobody approved. */
  it('keeps the last edit rather than stacking them', () => {
    const e = makeStream('wi-p-3')
    const state = reduceWorkItem([
      e('WorkItemDiscovered', discovered),
      e('PromptEdited', { text: 'first', hash: 'f1', by: 'human:steven', basedOn: null, chatId: null }),
      e('PromptEdited', { text: 'second', hash: 'f2', by: 'human:steven', basedOn: null, chatId: null }),
    ])
    expect(state.pendingPrompt?.text).toBe('second')
  })

  /**
   * *Remove the edit* is an append, not a deletion. The page offers it beside
   * the box (#104) and this is the whole of what it does — which also closes a
   * gap in the version: a blank edit produced no block in the prompt, because
   * `humanBrief` trims, and still a `human@…` in `promptVersion`.
   */
  it('takes the edit back off when the text is blank', () => {
    const e = makeStream('wi-p-4')
    const state = reduceWorkItem([
      e('WorkItemDiscovered', discovered),
      e('PromptEdited', { text: 'pass --max-turns', hash: 'a91f2e', by: 'human:steven', basedOn: null, chatId: null }),
      e('PromptEdited', { text: '  \n ', hash: null, by: 'human:steven', basedOn: null, chatId: null }),
    ])
    expect(state.pendingPrompt).toBeNull()
  })
})

/**
 * #445's own Done-when: a payload carrying an old field beside `hold` must be
 * refused, not silently stripped. `WorkItemBlocked` is `z.strictObject`, so
 * asserting `safeParse(...).success === false` is the only check that proves
 * it — asserting the *parsed output* lacks the field would also pass for a
 * plain `z.object`, which strips unknown keys without complaint.
 */
describe('WorkItemBlocked is strict about what rides beside hold', () => {
  const hold = { _tag: 'Question' as const, question: 'which design?', by: 'steven' }

  it('accepts hold alone', () => {
    expect(WorkItemBlocked.safeParse({ hold }).success).toBe(true)
  })

  it.each([
    ['needs', { hold, needs: ['design'] }],
    ['question', { hold, question: 'which design?' }],
    ['runId', { hold, runId: 'run-1' }],
    ['diagnosis', { hold, diagnosis: { what: 'merge conflict', done: null, raw: null, recommendation: null } }],
  ])('refuses a payload carrying %s beside hold', (_name, payload) => {
    expect(WorkItemBlocked.safeParse(payload).success).toBe(false)
  })

  it('refuses the old v2 payload, which carries no hold at all', () => {
    const v2 = {
      question: 'which design?',
      needsFrom: 'human',
      runId: null,
      needs: ['design'],
      diagnosis: null,
    }
    expect(WorkItemBlocked.safeParse(v2).success).toBe(false)
  })
})
