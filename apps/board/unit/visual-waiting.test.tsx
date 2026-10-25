import { inWords } from '@lingtai/conductor/queue'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Card } from '../src/app/page.tsx'
import { TriageBand } from '../src/app/standing.tsx'
import { Attempt, TaskBody } from '../src/app/task/[id]/page.tsx'
import { CASE_NAMES, PREVIEW_NOW, preview } from '../test/visual-waiting.ts'

describe('waiting visual previews', () => {
  it.each([
    ['questions', 'decision', 'A decision for you', 'UndecidedQuestion'],
    ['fixable-lines', 'lines', 'Lines to fix', 'FixableLines'],
    ['fixable-lines-no-head', 'lines', 'Lines to fix', 'FixableLines'],
    ['wrong-approach', 'approach', 'The approach is wrong', 'WrongApproach'],
    ['conflicting-hunks', 'merge', 'Merge by hand', 'ConflictingHunks'],
    ['ticket-too-big', 'oversized', 'Ticket too big', 'TicketTooBig'],
    ['setup-broken', 'setup', 'Fix the setup', 'SetupBroken'],
  ] as const)('%s uses the same readable chip on card and detail', async (name, chip, label, tag) => {
    const { card, task } = await preview(name)
    const cardHtml = renderToStaticMarkup(<Card card={card} showProject={false} issue={null} paused={false} />)
    const detailHtml = renderToStaticMarkup(
      <TriageBand reason={task.standing.reason!} status={task.standing.triageStatus!} />,
    )
    for (const html of [cardHtml, detailHtml]) {
      expect(html).toContain(`cause-chip--${chip}`)
      expect(html).toContain(label)
      expect(html).not.toContain(tag)
    }
  })

  it.each([
    ['fixable-lines', true],
    ['fixable-lines-no-head', false],
  ] as const)('%s folds the representative wait and saved-head availability', async (name, available) => {
    const { card, task } = await preview(name)
    const html = renderToStaticMarkup(<TaskBody task={task} now={PREVIEW_NOW} />)
    expect(task.ticket?.ref).toBe('393')
    expect(task.ticket?.body).toContain('| **Problem** |')
    expect(task.standing.reason?._tag).toBe('ProposedEscalated')
    expect(task.runs[0]?.progress?.steps).toHaveLength(10)
    expect(task.runs[0]?.progress?.rounds.spent).toBe(2)
    expect(task.runs[0]?.diff?.branch).toBe('agent/393')
    expect(task.held).toContain('2 of 2 rounds')
    expect(task.discussions[0]?.turns[0]?.answer?.text).toContain(available ? 'saved branch' : 'no published head')
    expect(task.totals.discussions).toBe(1)
    expect(task.totals.byPurpose.Work.unknown).toBe(1)
    expect(card.progress).toBe(task.runs[0]?.progress)
    expect(html).toContain('A waiting pass hides its review findings')
    expect(html).toContain('Can these findings be handled on the current branch?')
    expect(html).toContain('A missing branch makes continuation impossible')
    expect(html).toContain('data-resolution="GrantFixRound"')
    if (available) {
      expect(task.standing.fixWork).toEqual({ head: 'b'.repeat(40), ref: 'agent/393' })
      expect(html).toContain('Continue fixing current work')
      expect(html).not.toContain('no published head')
    } else {
      expect(task.standing.fixWork).toHaveProperty('refusal')
      expect(html).toContain('no published head')
      expect(html).not.toContain('>Continue fixing current work</button>')
    }
  })

  it.each(['no-triage', 'triage-running', 'triage-failed'] as const)('%s has no advised cause', async (name) => {
    const { card, task } = await preview(name)
    const cardHtml = renderToStaticMarkup(<Card card={card} showProject={false} issue={null} paused={false} />)
    const detailHtml = renderToStaticMarkup(
      <TriageBand reason={task.standing.reason!} status={task.standing.triageStatus!} />,
    )
    expect(card.cause).toBeNull()
    expect(cardHtml).not.toContain('cause-chip')
    expect(detailHtml).not.toContain('cause-chip')
  })

  for (const name of CASE_NAMES) {
    it(`${name} shows the current run rail on its card`, async () => {
      const { card, task } = await preview(name)
      expect(card.progress).not.toBeNull()
      expect(card.progress).toBe(task.runs.find((run) => run.runId === task.standing.runId)?.progress)
      const html = renderToStaticMarkup(<Card card={card} showProject={false} issue={null} paused={false} />)
      expect(html).toContain('<div class="seq">')
      expect(html).toMatch(/<div class="seq">[\s\S]*<p class="(?:waiting-cause|question waiting-fallback)">/)
    })
  }

  for (const name of ['conflicting-hunks', 'resolution-cards'] as const) {
    it(`${name} uses the preview clock for attempt ages`, async () => {
      const { task } = await preview(name)
      const run = task.runs[0]!
      const html = renderToStaticMarkup(<Attempt run={run} alone deciding={false} now={PREVIEW_NOW} />)
      expect(html).toContain(`${inWords(PREVIEW_NOW - Date.parse(run.at))} ago`)
    })
  }
})
