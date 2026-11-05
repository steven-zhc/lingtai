/**
 * The dot, the sentence and the command (#904), rendered through `Said`.
 *
 * Not `Live` or `Following`: `Live` needs Next's router, and `Following` can
 * never be handed stale code (`warning` passes `bearing` no code), so a test
 * that mounted it with one would test something that cannot happen. Both draw
 * `Said`, which is what this renders.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Said } from '../src/app/live.tsx'
import { bearing, type CodeNews } from '../src/lib/bearing.ts'
import type { Health } from '../src/lib/health.ts'

const health = (over: Partial<Health> = {}): Health =>
  ({
    lag: 0,
    daemon: 'up',
    sinceBeatMs: 2_000,
    inFlight: [],
    stoppedProjections: [],
    ...over,
  }) as unknown as Health

const stale: CodeNews = {
  wrong: 'daemon 4 commits behind',
  command: 'lingtai restart',
  said: 'running d4fbd1a — 4 commit(s) behind origin/main',
}

describe('Said', () => {
  it('draws the command in <code>, after the sentence and outside it', () => {
    const out = renderToStaticMarkup(<Said said={bearing('open', health(), stale)} />)
    expect(out).toContain('<code>lingtai restart</code>')
    expect(out).toMatch(/<span class="why"[^>]*>daemon 4 commits behind<\/span><code>/)
  })

  it('draws a command a task page can reach the same way', () => {
    const out = renderToStaticMarkup(
      <Said said={bearing('open', health({ lag: 3, daemon: 'never', sinceBeatMs: null }), null)} />,
    )
    expect(out).toContain('<code>lingtai daemon --no-conduct</code>')
  })

  it('draws no sentence and no code when well', () => {
    const out = renderToStaticMarkup(<Said said={bearing('open', health(), null)} />)
    expect(out).not.toContain('<code>')
    expect(out).not.toContain('class="why"')
  })
})
