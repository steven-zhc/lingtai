/**
 * Under a wait, a discussion answer is added to the resolution about to be
 * confirmed rather than written to the ticket on its own (#574, 0118 §6).
 * Outside a wait the two original buttons stay.
 */
import { aWaitId } from '@lingtai/domain/test/events'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Discussion } from '../src/app/discussion.tsx'
import { TriagePicks } from '../src/app/triage-picks.tsx'
import type { DiscussionView } from '../src/lib/task.ts'

const turn = (
  proposal: { kind: 'prompt' | 'ticket'; text: string } | null,
  held: DiscussionView['held'] = null,
): DiscussionView => ({
  chatId: 'chat-1',
  attempt: 2,
  waiting: false,
  costUsd: null,
  held,
  turns: [
    {
      question: 'why?',
      by: 'human:steven',
      at: '2026-09-10T10:00:00.000Z',
      reading: [],
      answer: { text: 'Because the lock is held.', read: [], cannot: [], proposal, costUsd: null, failure: null },
    },
  ],
})

const render = (discussion: DiscussionView, tag: string | null, waitId = aWaitId()) =>
  renderToStaticMarkup(
    <TriagePicks waitId={waitId} questions={[]} recommended={tag}>
      <Discussion taskId="ticket-lingtai-89" attempt={2} discussions={[discussion]} />
    </TriagePicks>,
  )

describe('add to this resolution', () => {
  it.each(['EditBodyAndRequeue', 'AnswerQuestion'])(
    'replaces Add to the ticket under a wait recommending %s',
    (tag) => {
      const html = render(turn({ kind: 'ticket', text: 'Note the lock.' }), tag)
      expect(html).toContain('Add to this resolution')
      expect(html).not.toContain('Add to the ticket')
      expect(html).toContain('Use for the next run')
    },
  )

  it('offers it on an answer that proposed nothing', () => {
    expect(render(turn(null), 'EditBodyAndRequeue')).toContain('Add to this resolution')
  })

  it('still offers it on a proposal after the discussion is concluded for the next run', () => {
    const html = render(turn({ kind: 'ticket', text: 'Note the lock.' }, 'prompt'), 'EditBodyAndRequeue')
    expect(html).toContain('Add to this resolution')
    expect(html).not.toContain('Add to the ticket')
  })

  it.each([null, 'Close', 'Approve'])('keeps both buttons when the first resolution is %s', (tag) => {
    const html = render(turn({ kind: 'ticket', text: 'Note the lock.' }), tag)
    expect(html).toContain('Add to the ticket')
    expect(html).not.toContain('Add to this resolution')
    expect(render(turn(null), tag)).not.toContain('Add to this resolution')
  })

  it('keeps both buttons outside a wait', () => {
    const html = renderToStaticMarkup(
      <TriagePicks waitId={null} questions={[]} recommended="EditBodyAndRequeue">
        <Discussion taskId="ticket-lingtai-89" attempt={2} discussions={[turn({ kind: 'ticket', text: 'x' })]} />
      </TriagePicks>,
    )
    expect(html).toContain('Add to the ticket')
    expect(html).not.toContain('Add to this resolution')
  })

  it('keeps both buttons with no provider at all', () => {
    const html = renderToStaticMarkup(
      <Discussion taskId="ticket-lingtai-89" attempt={2} discussions={[turn({ kind: 'ticket', text: 'x' })]} />,
    )
    expect(html).toContain('Add to the ticket')
  })
})
