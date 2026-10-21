import { describe, expect, it } from 'vitest'

import { emptyTicket, reduceTicket, waitWords, WaitStarted, type WaitId } from '../src/index.ts'
import { makeStream, unknownEvent } from '../test/support.ts'

const discovered = {
  project: 'nextloom-ai-admin',
  source: 'github-issue' as const,
  externalRef: '117',
  title: 'Migration hold',
  kind: 'bug' as const,
  labels: ['agent:ready'],
}

describe('reduceTicket', () => {
  it('is backlog with nothing known before its first event', () => {
    const s = reduceTicket([])
    expect(s).toEqual(emptyTicket)
    expect(s.lifecycle.status).toBe('backlog')
    expect(s.version).toBe(0)
  })

  it('records what discovery knew', () => {
    const e = makeStream('ticket-nextloom-ai-admin-117')
    const s = reduceTicket([e('TicketDiscovered', discovered)])

    expect(s.project).toBe('nextloom-ai-admin')
    expect(s.externalRef).toBe('117')
    expect(s.kind).toBe('bug')
    expect(s.labels).toEqual(['agent:ready'])
    expect(s.lifecycle.status).toBe('backlog')
  })

  it('walks discovered → claimed → landed', () => {
    const e = makeStream('ticket-nextloom-ai-admin-117')
    const s = reduceTicket([
      e('TicketDiscovered', discovered),
      e('TicketClaimed', { runId: 'pass-01JX', worker: 'conductor@host', title: null, kind: null }),
      e('TicketLanded', { mergeCommit: 'abc1234', base: 'develop' }),
    ])

    expect(s.lifecycle).toEqual({ status: 'landed', mergeCommit: 'abc1234', base: 'develop' })
    expect(s.runs).toEqual(['pass-01JX'])
    expect(s.version).toBe(3)
  })

  it('returns to the backlog when released, and the lease goes with it', () => {
    const e = makeStream('ticket-p-1')
    const s = reduceTicket([
      e('TicketDiscovered', discovered),
      e('TicketClaimed', { runId: 'pass-a', worker: 'w', title: null, kind: null }),
      e('TicketReleased', { runId: 'pass-a', reason: 'lease expired', cause: null }),
    ])

    expect(s.lifecycle).toEqual({ status: 'backlog' })
    // The run is still on the record — it happened — but it holds nothing.
    expect(s.runs).toEqual(['pass-a'])
  })

  it('carries the question when blocked, and drops it when unblocked', () => {
    const e = makeStream('ticket-p-1')
    const reason = {
      _tag: 'SignoffRequired' as const,
      run: { runId: 'pass-a' },
      step: 'proposed' as const,
      action: 'sign-off',
      question: 'Which base branch should this target?',
    }
    const events = [e('TicketDiscovered', discovered), e('WaitStarted', { waitId: 'wait-1' as WaitId, reason })]

    const blocked = reduceTicket(events)
    expect(blocked.lifecycle).toEqual({
      status: 'blocked',
      waitId: 'wait-1' as WaitId,
      reason,
      runId: 'pass-a',
    })

    const unblocked = reduceTicket([
      ...events,
      e('WaitResolved', {
        waitId: 'wait-1' as WaitId,
        by: 'human:steven',
        resolution: { _tag: 'Requeue' },
        note: 'develop',
      }),
    ])
    expect(unblocked.lifecycle).toEqual({ status: 'backlog' })
    // The answer is not dropped with the question (#147).
    expect(unblocked.answers).toEqual([
      {
        question: 'the `proposed` step held: Which base branch should this target?',
        runId: 'pass-a',
        answer: 'develop',
        by: 'human:steven',
      },
    ])
  })

  /**
   * **`Approve` moves to `approved`, not `backlog`** (#465, 0118 §11) — a
   * continuation is owed, and the queue must not cut a fresh pass for an
   * item whose run has already been spent and is waiting to be resumed.
   */
  it('moves an Approve to approved, carrying the run and the sha it approved', () => {
    const e = makeStream('ticket-p-2')
    const reason = {
      _tag: 'SignoffRequired' as const,
      run: { runId: 'pass-b' },
      step: 'merge' as const,
      action: 'human:land',
      question: 'land it?',
    }
    const events = [
      e('TicketClaimed', { runId: 'pass-b', worker: 'w', title: null, kind: null }),
      e('WaitStarted', { waitId: 'wait-2' as WaitId, reason }),
      e('WaitResolved', {
        waitId: 'wait-2' as WaitId,
        by: 'human:steven',
        resolution: { _tag: 'Approve', onSha: 'a'.repeat(40) },
        note: '',
      }),
    ]

    const approved = reduceTicket(events)
    expect(approved.lifecycle).toEqual({
      status: 'approved',
      runId: 'pass-b',
      waitId: 'wait-2' as WaitId,
      onSha: 'a'.repeat(40),
    })

    // A continuation claims onto the same run, the same way any claim does.
    const claimed = reduceTicket([
      ...events,
      e('TicketClaimed', { runId: 'pass-b', worker: 'w', title: null, kind: null }),
    ])
    expect(claimed.lifecycle).toEqual({ status: 'claimed', runId: 'pass-b', worker: 'w' })
  })

  /**
   * A question asked before anything is spent (#147).
   *
   * `runId: null` was written into the type and never into the log: all three
   * appenders ran inside a pass. `lingtai ask` is the first that does not, so
   * the fold has to accept a wait that belongs to no run — with no claim before
   * it and nothing in `runs` — and a replay of the answer has to be able to say
   * what the answer was.
   */
  it('accepts a wait that belongs to no run, and keeps the answer that ends it', () => {
    const e = makeStream('ticket-lingtai-51')
    const reason = {
      _tag: 'OwnQuestion' as const,
      question: 'Which of the three designs for the production-credential tripwire?',
      by: 'steven',
    }
    const asked = [e('WaitStarted', { waitId: 'wait-1' as WaitId, reason })]

    const waiting = reduceTicket(asked)
    expect(waiting.lifecycle).toEqual({
      status: 'blocked',
      waitId: 'wait-1' as WaitId,
      reason,
      runId: null,
    })
    expect(waiting.runs).toEqual([])

    const answered = reduceTicket([
      ...asked,
      e('WaitResolved', {
        waitId: 'wait-1' as WaitId,
        by: 'human:steven',
        resolution: { _tag: 'AnswerQuestion', choice: 'the second: refuse at the hook' },
        note: 'the second: refuse at the hook',
      }),
      e('TicketClaimed', { runId: 'pass-a', worker: 'w', title: null, kind: null }),
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
    const withdrawn = reduceTicket([
      ...asked,
      e('WaitResolved', { waitId: 'wait-1' as WaitId, by: 'human:steven', resolution: { _tag: 'Requeue' }, note: '' }),
    ])
    expect(withdrawn.lifecycle).toEqual({ status: 'backlog' })
    expect(withdrawn.answers).toEqual([])
  })

  /**
   * The two kinds of wait, told apart on the log (#83).
   *
   * `held at the merge gate` and `conflict: agent/112 does not merge into
   * develop` were both `WorkItemBlocked` with a string, and they are opposite
   * kinds of thing: one wants a person's judgement, the other wants a diagnosis
   * nobody had written. A fold that cannot distinguish them cannot let a card
   * offer a default action, which is the whole of what the ticket asked for.
   */
  it('tells a judgement apart from a failure needing acknowledgement', () => {
    const e = makeStream('ticket-nextloom-ai-admin-112')
    const judgement = reduceTicket([
      e('WaitStarted', {
        waitId: 'wait-1' as WaitId,
        reason: {
          _tag: 'SignoffRequired' as const,
          run: { runId: 'pass-a' },
          step: 'merge' as const,
          action: 'no-merge',
          question: 'held at the merge step: agent/112 into develop',
        },
      }),
    ])
    const failure = reduceTicket([
      e('WaitStarted', {
        waitId: 'wait-2' as WaitId,
        reason: {
          _tag: 'MergeRefused' as const,
          run: { runId: 'pass-b' },
          reason: 'lane-busy' as const,
          raw: 'another integration held the merge lane',
        },
      }),
    ])

    expect(judgement.lifecycle.status === 'blocked' && waitWords(judgement.lifecycle.reason).needs).toBe('judgement')
    expect(failure.lifecycle.status === 'blocked' && waitWords(failure.lifecycle.reason).needs).toBe('acknowledgement')
    // And the recommendation is a value, not a sentence to parse: `approve` is a
    // legitimate one, which is what makes the board's default action possible.
    expect(
      judgement.lifecycle.status === 'blocked' && waitWords(judgement.lifecycle.reason).diagnosis?.recommendation,
    ).toEqual({
      action: 'approve',
      why: 'every step passed on this diff; approving merges what this run produced',
    })
    // A conflict recommends a requeue — the next attempt is cut from a base
    // that has moved — which is `REFUSAL_READING.conflict.move` in `attribution.ts`.
    expect(
      failure.lifecycle.status === 'blocked' && waitWords(failure.lifecycle.reason).diagnosis?.recommendation,
    ).toEqual({
      action: 'requeue',
      why: 'the lane was busy rather than wrong — the next pass merges it',
    })
    // The raw failure survives the summary. A sentence that hides the git
    // output would be worse than the git output.
    expect(failure.lifecycle.status === 'blocked' && waitWords(failure.lifecycle.reason).diagnosis?.raw).toContain(
      'another integration held the merge lane',
    )
  })

  /**
   * The regression this whole aggregate exists for. #35 held `agent:blocked` and
   * `agent:review` at once because labels are a set, not a state. Here the
   * lifecycle is one value, so the second transition replaces the first — there
   * is no state in which both are true, and no way to construct one.
   */
  it('cannot be blocked and claimed at the same time', () => {
    const e = makeStream('ticket-nextloom-ai-admin-35')
    const s = reduceTicket([
      e('TicketDiscovered', discovered),
      e('WaitStarted', {
        waitId: 'wait-1' as WaitId,
        reason: { _tag: 'OwnQuestion' as const, question: '?', by: 'steven' },
      }),
      e('TicketClaimed', { runId: 'pass-b', worker: 'w', title: null, kind: null }),
    ])

    expect(s.lifecycle.status).toBe('claimed')
    expect(Object.keys(s.lifecycle).sort()).toEqual(['runId', 'status', 'worker'])
    expect(s.lifecycle).not.toHaveProperty('question')
  })

  it('links a filed bug to the merge that caused it, without duplicating', () => {
    const e = makeStream('ticket-nextloom-ai-admin-134')
    const link = { relation: 'caused-by' as const, otherRef: '58' }
    const s = reduceTicket([
      e('TicketDiscovered', { ...discovered, externalRef: '134' }),
      e('TicketLinked', link),
      e('TicketLinked', link),
    ])

    expect(s.links).toEqual([link])
  })

  it('keeps every refused dispatch rather than counting them', () => {
    const e = makeStream('ticket-p-1')
    const s = reduceTicket([
      e('TicketDiscovered', discovered),
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
   * The second ceiling, counted off the log rather than remembered
   * ([0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md) §2).
   *
   * Since #502 the arm's own branch/head/findings are not repeated on the
   * work item — they are on the previous run's own stream, which the next
   * prompt already reads (`attempts.ts`'s `lastRun`) — so what this fold owes
   * is the count and which run each restart followed.
   */
  it('counts the approaches a ticket abandoned, from the release that follows each one', () => {
    const e = makeStream('ticket-p-1')
    const after = reduceTicket([
      e('TicketClaimed', { runId: 'pass-a', worker: 'w', title: null, kind: null }),
      e('TicketReleased', { runId: 'pass-a', reason: '…restart 1 of 2', cause: { _tag: 'Restart', restart: 1 } }),
      e('TicketClaimed', { runId: 'pass-b', worker: 'w', title: null, kind: null }),
    ])

    expect(after.restarts).toHaveLength(1)
    expect(after.restarts[0]!).toEqual({ after: 'pass-a', restart: 1 })
    // And it is claimed, not blocked — a restart is not a state an item is in.
    expect(after.lifecycle.status).toBe('claimed')

    const twice = reduceTicket([
      e('TicketReleased', { runId: 'pass-a', reason: 'restart 1', cause: { _tag: 'Restart', restart: 1 } }),
      e('TicketReleased', { runId: 'pass-b', reason: 'restart 2', cause: { _tag: 'Restart', restart: 2 } }),
    ])
    expect(twice.restarts.map((r) => r.restart)).toEqual([1, 2])
  })

  it('ignores an event type it has never heard of, but still advances', () => {
    const e = makeStream('ticket-p-1')
    const first = e('TicketDiscovered', discovered)
    const s = reduceTicket([first, unknownEvent('ticket-p-1', 2)])

    expect(s.title).toBe('Migration hold')
    expect(s.lifecycle.status).toBe('backlog')
    // Version still advances, so the next append does not use a stale expectation.
    expect(s.version).toBe(2)
  })

  /**
   * The one-shot edit
   * ([0032](../../../doc/decisions-archive/0032-the-page-is-organised-by-attempt.md)
   * §5). It applies to the next run and to no other, which is what makes a
   * stale instruction impossible rather than merely guarded against.
   */
  it('holds a prompt edit until the next claim, and no longer', () => {
    const e = makeStream('ticket-p-1')
    const edited = reduceTicket([
      e('TicketDiscovered', discovered),
      e('PromptEdited', {
        text: 'pass --max-turns',
        hash: 'a91f2e',
        by: 'human:steven',
        basedOn: 'ticket@1924',
        chatId: 'chat-1',
      }),
    ])
    expect(edited.pendingPrompt).toEqual({ text: 'pass --max-turns', by: 'human:steven' })

    const f = makeStream('ticket-p-2')
    const consumed = reduceTicket([
      f('TicketDiscovered', discovered),
      f('PromptEdited', {
        text: 'pass --max-turns',
        hash: 'a91f2e',
        by: 'human:steven',
        basedOn: 'ticket@1924',
        chatId: 'chat-1',
      }),
      f('TicketClaimed', { runId: 'pass-a', worker: 'w', title: null, kind: null }),
    ])
    expect(consumed.pendingPrompt).toBeNull()
  })

  /** A second edit replaces the first: two sentences nobody re-read is a prompt nobody approved. */
  it('keeps the last edit rather than stacking them', () => {
    const e = makeStream('ticket-p-3')
    const state = reduceTicket([
      e('TicketDiscovered', discovered),
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
    const e = makeStream('ticket-p-4')
    const state = reduceTicket([
      e('TicketDiscovered', discovered),
      e('PromptEdited', { text: 'pass --max-turns', hash: 'a91f2e', by: 'human:steven', basedOn: null, chatId: null }),
      e('PromptEdited', { text: '  \n ', hash: null, by: 'human:steven', basedOn: null, chatId: null }),
    ])
    expect(state.pendingPrompt).toBeNull()
  })
})

/**
 * `WaitStarted` is `z.strictObject`, so asserting `safeParse(...).success ===
 * false` is the only check that proves a payload carrying an old field beside
 * `reason` is refused, not silently stripped — asserting the *parsed output*
 * lacks the field would also pass for a plain `z.object`.
 */
describe('WaitStarted is strict about what rides beside reason', () => {
  const reason = { _tag: 'OwnQuestion' as const, question: 'which design?', by: 'steven' }

  it('accepts waitId and reason alone', () => {
    expect(WaitStarted.safeParse({ waitId: 'wait-1' as WaitId, reason }).success).toBe(true)
  })

  it.each([
    ['needs', { waitId: 'wait-1' as WaitId, reason, needs: ['design'] }],
    ['question', { waitId: 'wait-1' as WaitId, reason, question: 'which design?' }],
    ['runId', { waitId: 'wait-1' as WaitId, reason, runId: 'pass-1' }],
    [
      'diagnosis',
      {
        waitId: 'wait-1' as WaitId,
        reason,
        diagnosis: { what: 'merge conflict', done: null, raw: null, recommendation: null },
      },
    ],
  ])('refuses a payload carrying %s beside reason', (_name, payload) => {
    expect(WaitStarted.safeParse(payload).success).toBe(false)
  })

  it('refuses the old WorkItemBlocked payload, which carries a hold rather than a reason', () => {
    const old = { hold: { _tag: 'Question', question: 'which design?', by: 'steven' } }
    expect(WaitStarted.safeParse(old).success).toBe(false)
  })
})
