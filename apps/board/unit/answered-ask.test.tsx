/** An answered `asked` wait reads as one muted history line outside `blocked` (#1495). */
import type { Action, Envelope } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Standing } from '../src/app/standing.tsx'
import { presentAttemptEvents, standingOf, type StandingView } from '../src/lib/task.ts'

let seq = 5000n
const ITEM = 'ticket-lingtai-1495'
const RUN = 'pass-22222222-0000-0000-0000-000000000000'
const SHA = 'c'.repeat(40)

function e(streamId: string, type: string, data: unknown, at: string): Envelope {
  seq += 1n
  return { seq, streamId, version: 1, type, schemaVer: 1, data, at: new Date(at) } as unknown as Envelope
}

const ask: Action = {
  plugin: 'human',
  name: 'conductor:judge',
  onSha: SHA,
  evidence: '',
  yields: 'signoff',
  result: { _tag: 'Completed', requested: { question: 'Merge agent/1 into lingtai-base anyway?' } },
}

function landed(reason: unknown, last: 'landed' | 'continued' = 'landed') {
  const run = presentAttemptEvents({ runId: RUN, at: new Date('2026-11-25T05:00:00Z'), ended: null }, 1, [
    e(RUN, 'StepStarted', { runId: RUN, step: 'proposed', round: 0 }, '2026-11-25T05:09:00Z'),
    e(
      RUN,
      'StepEnded',
      { runId: RUN, outcome: { step: 'proposed', round: 0, actions: [ask] } },
      '2026-11-25T05:09:00Z',
    ),
  ])
  const own = [
    e(ITEM, 'TicketClaimed', { runId: RUN }, '2026-11-25T05:00:00Z'),
    e(ITEM, 'WaitStarted', { waitId: 'w1', reason }, '2026-11-25T05:09:00Z'),
    e(
      ITEM,
      'WaitResolved',
      { waitId: 'w1', resolution: { _tag: 'Approve', onSha: SHA }, by: 'human:steven' },
      '2026-11-25T05:11:00Z',
    ),
    last === 'landed'
      ? e(ITEM, 'TicketLanded', { mergeCommit: 'd'.repeat(40), base: 'lingtai-base' }, '2026-11-25T05:12:00Z')
      : e(ITEM, 'TicketContinued', { runId: RUN, worker: 'w' }, '2026-11-25T05:12:00Z'),
  ]
  return standingOf(own, [run])
}

const html = (standing: StandingView) =>
  renderToStaticMarkup(
    <Standing
      subject={null}
      standing={standing}
      project="lingtai"
      issue={1495}
      taskId={ITEM}
      discussions={[]}
      outgoing={null}
      queued={null}
    />,
  )

const SIGNOFF = { _tag: 'SignoffRequired', run: { runId: RUN }, step: 'proposed', action: 'human', question: 'q' }

describe('an answered ask', () => {
  it('carries the wait that answered it, and draws one muted line', () => {
    const standing = landed(SIGNOFF)
    expect(standing.deciding?.answered).toEqual({
      asked: '2026-11-25T05:09:00.000Z',
      at: '2026-11-25T05:11:00.000Z',
      by: 'human:steven',
      resolution: 'Approve',
    })
    const out = html(standing)
    expect(out.match(/class="past"/g)).toHaveLength(1)
    expect(out).toContain('asked at 05:09')
    expect(out).toContain('steven answered <b>merge</b> at 05:11')
    expect(out).not.toContain('sevidence')
  })

  it('says only answered when no wait names the run', () => {
    const standing = landed({ _tag: 'AgentCrashed' })
    expect(standing.deciding?.answered).toBe('unmatched')
    const out = html(standing)
    expect(out).toContain('class="past"')
    expect(out).toContain('→ answered')
    expect(out).not.toContain('sevidence')
  })

  it('stays drawn as history while the attempt runs on after the answer', () => {
    const standing = landed(SIGNOFF, 'continued')
    expect(standing.state).toBe('running')
    expect(standing.deciding?.answered).not.toBeUndefined()
    const out = html(standing)
    expect(out.match(/class="past"/g)).toHaveLength(1)
    expect(out).toContain('steven answered <b>merge</b> at 05:11')
    expect(out).not.toContain('sevidence')
  })
})
