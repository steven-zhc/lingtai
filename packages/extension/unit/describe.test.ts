/**
 * The two types `#125` added to `describe`, and the rule that the card comes
 * off `workItem` rather than the stream.
 *
 * `RunFailed` is appended to a *run* stream, so a payload for one carries a
 * `pass-<uuid>` stream id and the work item the daemon resolved through the
 * run's `RunStarted` — built here that way, and not on a `ticket-` stream it is
 * never appended to, so the link asserted is the one production produces.
 */
import { describe, expect, it } from 'vitest'

import { describe as render, isMain, type NotifyPayload } from '../src/index.ts'

const payload = (type: string, data: unknown): NotifyPayload => ({
  event: { type, data },
  workItem: { id: 'ticket-lingtai-125', project: 'lingtai', issue: '125' },
  board: 'http://localhost:3200',
})

describe('what a channel that is read later says', () => {
  it('says a landed task landed, where, and links to its card', () => {
    const n = render(payload('TicketLanded', { mergeCommit: '5ace763aa0b1', base: 'main' }))

    expect(n.title).toBe('#125 landed')
    expect(n.body).toBe('merged into main at 5ace763')
    expect(n.url).toBe('http://localhost:3200/task/ticket-lingtai-125')
  })

  it('says both halves of a failed run, for the work item its run stream was resolved to', () => {
    const n = render(payload('RunFailed', { kind: 'crash', detail: 'session limit' }))

    expect(n.title).toBe('#125 run failed')
    expect(n.body).toBe('crash: session limit')
    expect(n.url).toBe('http://localhost:3200/task/ticket-lingtai-125')
  })

  it('reads the WaitReason a wait carries, since #502 — not the question the payload no longer has', () => {
    const asked = render(
      payload('WaitStarted', {
        waitId: 'wait-1',
        reason: { _tag: 'SignoffRequired', run: { runId: 'pass-1' }, step: 'merge', action: 'human', question: 'ship it?' },
      }),
    )
    expect(asked.body).toBe('ship it?')

    const red = render(
      payload('WaitStarted', {
        waitId: 'wait-2',
        reason: { _tag: 'CheckRefused', run: { runId: 'pass-1' }, step: 'merge', action: 'check', evidence: 'pnpm test exited 2', findings: [] },
      }),
    )
    expect(red.body).toBe('pnpm test exited 2')

    const budget = render(
      payload('WaitStarted', {
        waitId: 'wait-3',
        reason: { _tag: 'BudgetExhausted', run: { runId: 'pass-1' }, cause: 'out-of-turns', detail: '151 turns' },
      }),
    )
    expect(budget.body).toBe('out-of-turns: 151 turns')
  })
})

describe('isMain', () => {
  it('is true only for the file node was asked to run', () => {
    expect(isMain('file:///repo/packages/telegram/src/cli.ts', '/repo/packages/telegram/src/cli.ts')).toBe(true)
    expect(isMain('file:///repo/packages/telegram/src/cli.ts', '/repo/node_modules/vitest/cli.js')).toBe(false)
    expect(isMain('file:///repo/x.ts', undefined)).toBe(false)
  })
})
