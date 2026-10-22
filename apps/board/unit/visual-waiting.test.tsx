import { inWords } from '@lingtai/conductor/queue'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Card } from '../src/app/page.tsx'
import { Attempt } from '../src/app/task/[id]/page.tsx'
import { CASE_NAMES, PREVIEW_NOW, preview } from '../test/visual-waiting.ts'

describe('waiting visual previews', () => {
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
