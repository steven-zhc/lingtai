import { inWords } from '@lingtai/conductor/queue'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Card } from '../src/app/page.tsx'
import { TriageBand } from '../src/app/standing.tsx'
import { Attempt } from '../src/app/task/[id]/page.tsx'
import { CASE_NAMES, PREVIEW_NOW, preview } from '../test/visual-waiting.ts'

describe('waiting visual previews', () => {
  it.each([
    ['questions', 'decision', 'A decision for you', 'UndecidedQuestion'],
    ['fixable-lines', 'lines', 'Lines to fix', 'FixableLines'],
    ['wrong-approach', 'approach', 'The approach is wrong', 'WrongApproach'],
    ['disagreement', 'approach', 'The approach is wrong', 'WrongApproach'],
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

  it('shows judge and triage readings from the disagreement fixture', async () => {
    const { task } = await preview('disagreement')
    const html = renderToStaticMarkup(
      <TriageBand reason={task.standing.reason!} status={task.standing.triageStatus!} />,
    )
    expect(html).toContain('Which reading is right?')
    expect(html).toContain('hand-to-person')
    expect(html).toContain('The judge read the recorded finding as a local fix.')
    expect(html).toContain('The approach needs to change before another pass.')
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
