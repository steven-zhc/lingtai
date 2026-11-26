/**
 * The discussion has a meter, and the ledger has a total.
 *
 * Two numbers, one argument. [0033](../../../doc/decisions-archive/0033-the-third-kind-of-agent.md)
 * §4 gives the discussion assistant no spend limit **because the person is the
 * control loop** — and a person can only be the limit if the person can see the
 * number. The box carried the boundary (*it cannot run anything*) and no cost at
 * all, so the one agent on this page with no ceiling was the one with no reading
 * (#111 §4). The ledger had the opposite problem: two costs and no sum, leaving
 * `$13.04` — the figure `#89` is remembered by — as arithmetic every reader did
 * in their head (§5).
 *
 * Asserted on the markup for the reason `#101` established: these are facts
 * about what a reader is shown, not about the reducer.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Discussion } from '../src/app/discussion.tsx'
import type { DiscussionView } from '../src/lib/task.ts'

function chat(over: Partial<DiscussionView> = {}): DiscussionView {
  return {
    chatId: 'chat-1',
    attempt: 2,
    turns: [],
    waiting: false,
    held: null,
    ...over,
  }
}

function turn(question: string) {
  return {
    question,
    by: 'human:steven',
    at: '2026-09-09T10:00:00.000Z',
    reading: [],
    answer: {
      text: 'attempt 2 left no branch; I am reading main.',
      read: [],
      cannot: [],
      proposal: null,
      failure: null,
    },
  }
}

const render = (discussions: DiscussionView[], discussionTotal: string | null = null) =>
  renderToStaticMarkup(
    <Discussion
      taskId="ticket-lingtai-89"
      state="blocked"
      attempts={2}
      attempt={2}
      discussions={discussions}
      discussionTotal={discussionTotal}
    />,
  )

describe('the meter', () => {
  /**
   * The sentence 0033 §4 asks for, in the order a person checks it: what this
   * conversation has cost, how many exchanges bought it, and that nothing will
   * stop it. `no limit` is said rather than implied — an unstated limit reads as
   * a limit somebody else is keeping.
   */
  it('reads the messages and the absence of a limit, with no figure of its own (D16)', () => {
    const html = render([chat({ turns: [turn('why no branch?'), turn('and the flag?'), turn('so?')] })])

    expect(html).toContain('this conversation no figure · 3 messages · no limit')
    expect(html).not.toContain('chatcost')
  })

  it('says the boundary, and no figure, before the first question', () => {
    const html = render([])

    expect(html).toContain('reads the log, the ticket and the code — it cannot run anything')
    expect(html).not.toContain('$0.00')
  })

  /**
   * `$0.00` would say a conversation has been shown to be free. A null cost is
   * *nobody said* — the same reading `RunFinished.costUsd` gets — so a question
   * still in flight says it was asked and waits for the number.
   */
  it('does not print a zero for a cost nobody has reported', () => {
    const html = render([chat({ waiting: true, turns: [turn('why?')] })])

    expect(html).toContain('this conversation asked · 1 message · no limit')
    expect(html).not.toContain('$0.00')
  })

  /**
   * `discussionTotal` is `spend`'s own Discussion rows, already formatted —
   * `task.totals.byPurpose.Discussion` through `billText` — never
   * `DiscussionView.costUsd` summed here (`#498`): the per-turn `costUsd`
   * above stays what `DiscussionAnswered` recorded, but the conversation's
   * running total moved.
   */
  it('reports what closed conversations came to once none is open', () => {
    const html = render([chat({ held: 'none', turns: [turn('why?')] })], '$0.42')

    expect(html).toContain('1 discussion · $0.42 · no limit')
  })
})
