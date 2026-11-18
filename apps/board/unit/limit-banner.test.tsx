import type { Lock } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LockRows } from '../src/app/lock-banner.tsx'

const now = new Date(2026, 10, 16, 20, 0)
const limit = (named: Extract<Lock, { kind: 'account' }>['named']): Lock => ({
  kind: 'account',
  account: 'claude-code',
  by: 'lingtai',
  since: new Date(2026, 10, 16, 18, 0),
  until: new Date(2026, 10, 16, 23, 20),
  untilFrom: 'message',
  said: 'limit reached',
  named,
})
const render = (lock: Lock) =>
  renderToStaticMarkup(
    <LockRows locks={{ ok: true, held: [{ project: 'lingtai', locks: [lock] }], ceiling: undefined }} now={now} />,
  )

describe("the banner's account row (#1216)", () => {
  it("says #1214's sentence for a lock that was written with its limit", () => {
    const out = render(limit({ kind: '5-hour', resetsAt: new Date(2026, 10, 16, 23, 20) }))
    expect(out).toContain('Claude Code limit')
    expect(out).toContain('Claude Code&#x27;s 5-hour limit, resets 23:20')
    expect(out).toContain('nothing starts until then')
  })

  it('says to raise a limit that names no reset, then Lift', () => {
    expect(render(limit({ kind: 'monthly-spend', resetsAt: null }))).toContain('raise it, then Lift')
  })

  it("keeps today's text exactly for a lock with no limit", () => {
    const out = render(limit(null))
    expect(out).toContain('claude-code limit')
    expect(out).toContain('until 23:20')
  })
})
