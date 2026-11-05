import type { Envelope } from '@lingtai/domain'
import type { WaitReason } from '@lingtai/domain/wait'
/**
 * What the page says about a conversation, settled by envelopes.
 *
 * Two of these are `#105`'s own bar rather than ordinary reduce tests. The meter
 * has to be a number a person can see, or *"the person is the limit"* is a
 * limit that cannot see what it is limiting
 * ([0033](../../../doc/decisions-archive/0033-the-third-kind-of-agent.md) §4); and the
 * sentence about a branch that was not there has to survive an answer that
 * forgot to mention it, which is why it is reduced off the **ask** and not off
 * the answer.
 */
import type { SpendRow } from '@lingtai/projector'
import { describe, expect, it } from 'vitest'

import { askPlaceholder } from '../src/app/discussion.tsx'
import { chatIdsFor, presentChat, totalsOf, type DiscussionView, type StandingState } from '../src/lib/task.ts'

let seq = 0n

function e(streamId: string, type: string, data: unknown, at = '2026-09-09T10:00:00Z'): Envelope {
  seq += 1n
  return {
    seq,
    streamId,
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor: 'conductor',
    causation: null,
    at: new Date(at),
  }
}

const ASKED = {
  ticketId: 'ticket-lingtai-89',
  attempt: 2,
  by: 'human:steven',
  question: 'why did attempt 2 produce nothing?',
  reading: [
    'main: readable at abc1234',
    'attempt 2 left no branch; I am reading main. worktree.ts resets the branch with -B on every run…',
  ],
}

describe('one conversation, reduced', () => {
  it('pairs each question with its answer (D16: no per-conversation cost)', () => {
    const chat = presentChat(
      'chat-1',
      [
        e('chat-1', 'DiscussionAsked', ASKED),
        e('chat-1', 'DiscussionAnswered', {
          text: 'the flag is never passed to the binary',
          read: ['main:packages/agent/src/claude-code.ts'],
          cannot: ['whether the binary accepts --max-turns; that needs a command I do not have'],
          proposal: { kind: 'prompt', text: 'pass --max-turns' },
          turns: 4,
          durationMs: 9_000,
          failure: null,
        }),
        e('chat-1', 'DiscussionAsked', { ...ASKED, question: 'and attempt 1?' }, '2026-09-09T10:05:00Z'),
      ],
      null,
    )

    expect(chat.turns).toHaveLength(2)
    expect(chat.turns[0]?.answer?.proposal).toEqual({ kind: 'prompt', text: 'pass --max-turns' })
    // The second question has no answer yet, so the page can say so rather than
    // rendering an empty turn that reads as an answer of nothing.
    expect(chat.waiting).toBe(true)
    expect(chat.attempt).toBe(2)
  })

  /**
   * The blind spot that killed `#89`'s repair. It is recorded on the ask,
   * before the assistant has said anything, so an answer that does not mention
   * it cannot make the page forget it either.
   */
  it("keeps Lingtai's own sentence about a branch that was not there", () => {
    const chat = presentChat('chat-1', [e('chat-1', 'DiscussionAsked', ASKED)], null)
    expect(chat.turns[0]?.reading.join(' ')).toContain('attempt 2 left no branch')
  })

  /** D16: a failed turn is still an answered one — it is not `waiting`. */
  it('reduces a failed turn as answered, with its failure', () => {
    const chat = presentChat(
      'chat-1',
      [
        e('chat-1', 'DiscussionAsked', ASKED),
        e('chat-1', 'DiscussionAnswered', {
          text: '',
          read: [],
          cannot: [],
          proposal: null,
          turns: 1,
          durationMs: 300_000,
          failure: 'timeout: no result within 300000ms',
        }),
      ],
      null,
    )

    expect(chat.turns[0]?.answer?.failure).toContain('timeout')
    expect(chat.waiting).toBe(false)
  })
})

describe('which conversations an item has had', () => {
  /**
   * The join 0012 puts on the reader: the request is on `ctl-conductor` and the
   * ending is on the work item, and neither one alone lists them.
   */
  it('finds an open conversation from the control stream and a closed one from the item', () => {
    const chats = chatIdsFor(
      [
        { chatId: 'chat-1', ticketId: 'ticket-lingtai-89' },
        { chatId: 'chat-2', ticketId: 'ticket-lingtai-87' },
      ],
      [{ chatId: 'chat-1', outcome: 'prompt' }],
      'ticket-lingtai-89',
    )

    expect(chats).toEqual([{ chatId: 'chat-1', held: 'prompt' }])
  })

  it('lists a held chat control does not name after the control-named ones', () => {
    const chats = chatIdsFor(
      [{ chatId: 'chat-2', ticketId: 't' }],
      [
        { chatId: 'chat-9', outcome: 'none' },
        { chatId: 'chat-2', outcome: 'ticket' },
      ],
      't',
    )
    expect(chats).toEqual([
      { chatId: 'chat-2', held: 'ticket' },
      { chatId: 'chat-9', held: 'none' },
    ])
  })

  it('leaves an unconcluded conversation open rather than calling it closed', () => {
    const chats = chatIdsFor([{ chatId: 'chat-1', ticketId: 'ticket-lingtai-89' }], [], 'ticket-lingtai-89')
    expect(chats).toEqual([{ chatId: 'chat-1', held: null }])
  })
})

describe('the ledger', () => {
  /**
   * `2 attempts + 3 discussions · $14.10`, as the design's example reads it.
   * Beside the attempts' money rather than inside it, for the reason `#84`
   * keeps a repair's spend apart: they come out of one budget, and reducing two
   * figures into one misstates both. The money is `spend`'s now (`#498`),
   * never `DiscussionView.costUsd` — `totalsOf`'s third argument.
   */
  it("counts discussions beside attempts and their money beside the work's", () => {
    const totals = totalsOf([], [chat(), chat(), chat()], [discussionSpent(0.42), discussionSpent(1.1)])

    expect(totals.discussions).toBe(3)
    expect(totals.byPurpose.Discussion.reportedCents).toBe(152)
    expect(totals.byPurpose.Work.reportedRuns).toBe(0)
  })
})

function chat(): DiscussionView {
  return { chatId: 'chat-1', attempt: null, turns: [], waiting: false, held: 'none' }
}

function discussionSpent(costUsd: number | null): SpendRow {
  return {
    seq: '1',
    at: new Date('2026-09-09T10:00:00Z'),
    streamId: 'chat-1',
    ticket: 'ticket-lingtai-89',
    project: 'lingtai',
    pass: null,
    purpose: 'Discussion',
    step: null,
    action: null,
    round: null,
    runtime: 'claude-code',
    turns: 1,
    durationMs: 1000,
    costUsd,
    usage: [],
    estimatedUsd: null,
    estimateFetched: null,
    grant: null,
    kind: null,
  }
}

describe('the example question in the empty box', () => {
  const own = { _tag: 'OwnQuestion', question: 'q', by: 'agent' } as unknown as WaitReason
  const other = { _tag: 'Other' } as unknown as WaitReason
  const ask = (state: StandingState, attempt: number | null, attempts: number, reason: WaitReason | null = null) =>
    askPlaceholder({ state, attempt, attempts, reason })

  it('names the next attempt on a queued page, from the count and never from `attempt`', () => {
    expect(ask('queued', null, 0)).toBe('what will Attempt 1 change first?')
    expect(ask('queued', 2, 2)).toBe('what will Attempt 3 change first?')
  })

  it('has a sentence for every other state', () => {
    expect(ask('running', 2, 2)).toBe('what is Attempt 2 doing now?')
    expect(ask('blocked', 1, 1, own)).toBe('what does the code say about this question?')
    expect(ask('blocked', 1, 1, other)).toBe('why did Attempt 1 stop?')
    expect(ask('blocked', 3, 3)).toBe('why did Attempt 3 stop?')
    expect(ask('approved', 3, 3)).toBe('what will Attempt 3 do once it continues?')
    expect(ask('landed', 1, 1)).toBe('what did Attempt 1 change?')
    expect(ask('closed', 1, 1)).toBe('why was this ticket closed?')
    expect(ask('closed', null, 0)).toBe('why was this ticket closed?')
  })

  it('falls back when a state that names an attempt has none', () => {
    for (const state of ['running', 'blocked', 'approved', 'landed'] as const)
      expect(ask(state, null, 0)).toBe('what is this ticket asking for?')
  })

  it('never prints null, undefined, or attempt 2 for an attempt that is not 2', () => {
    const states: StandingState[] = ['queued', 'running', 'blocked', 'landed', 'closed', 'approved']
    for (const state of states)
      for (const attempt of [null, 1, 2])
        for (const attempts of [0, 1, 2])
          for (const reason of [null, own]) {
            const text = ask(state, attempt, attempts, reason)
            expect(text).not.toMatch(/null|undefined/)
            if (/attempt 2/i.test(text)) expect(state === 'queued' ? attempts + 1 : attempt).toBe(2)
          }
  })
})
