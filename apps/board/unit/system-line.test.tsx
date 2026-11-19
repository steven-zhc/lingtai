/**
 * #1259: a wait the system resolved reads as one line on the card and on the task page's record, and a person's
 * resolution reads as it did.
 */
import type { Envelope } from '@lingtai/domain'
import type { TaskCard } from '@lingtai/projector/task-view'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Card } from '../src/app/page.tsx'
import { toCard } from '../src/lib/board.ts'
import { toLine } from '../src/lib/history.ts'

const task = (over: Partial<TaskCard> = {}): TaskCard => ({
  taskId: 'ticket-lingtai-1259',
  project: 'lingtai',
  issue: '1259',
  title: 'A wait the system resolved',
  kind: 'feature',
  state: 'running',
  runId: null,
  turns: 0,
  passed: 0,
  failed: 0,
  waived: 0,
  approved: 0,
  baseSha: null,
  headSha: null,
  files: null,
  insertions: null,
  deletions: null,
  note: null,
  updatedAt: new Date('2026-11-19T04:27:22Z'),
  closedAt: null,
  attempts: 1,
  lastAttemptAt: null,
  awaitingSha: null,
  awaitingApproval: false,
  wait: null,
  answer: null,
  split: null,
  triage: { started: null, result: null },
  triageHeadSha: null,
  repairPending: false,
  newAttempts: 0,
  newAttemptsOf: 0,
  ...over,
})

const LINE = {
  action: 'the step is being redone',
  because: 'Triage read only unfinished',
  bound: '2 of 3 redos used',
}

const html = (system: typeof LINE | null) =>
  renderToStaticMarkup(
    <Card
      card={toCard(task(), null, null, null, null, undefined, undefined, undefined, null, null, system)}
      showProject={false}
      issue={null}
      paused={false}
    />,
  )

describe('the card', () => {
  it('carries the line under the title, in a card in any non-waiting column', () => {
    const out = html(LINE)
    expect(out).toContain('Triage read only unfinished; the step is being redone — 2 of 3 redos used')
    expect(out).toContain('/task/ticket-lingtai-1259/ticket?events=1')
    expect(out.indexOf('A wait the system resolved')).toBeLessThan(out.indexOf('Triage read only unfinished'))
  })
  it('carries nothing without one', () => {
    expect(html(null)).not.toContain('system-line')
  })
})

const e = (type: string, data: unknown): Envelope =>
  ({
    seq: 1n,
    streamId: 'ticket-lingtai-1259',
    type,
    data,
    actor: 'conductor',
    at: new Date('2026-11-19T04:27:22Z'),
  }) as unknown as Envelope

const resolved = (by: string, over: Record<string, unknown> = {}) =>
  e('WaitResolved', {
    waitId: 'w1',
    by,
    resolution: { _tag: 'RedoStep', onSha: 'a', ref: 'r' },
    note: 'because',
    ...over,
  })

describe('the task page’s record', () => {
  it('reads a triage resolution as the system’s line', () => {
    const line = toLine(resolved('triage'), { attempts: new Map(), systemLine: () => LINE })
    expect(line.summary).toBe('Triage read only unfinished; the step is being redone — 2 of 3 redos used')
  })
  it('without a WaitTriaged reads resolved by triage, with the note and no cause', () => {
    const line = toLine(resolved('triage'), { attempts: new Map() })
    expect(line.summary).toBe('resolved by triage: because')
  })
  it('leaves a person’s resolution as it was', () => {
    const line = toLine(resolved('human:steven'), { attempts: new Map(), systemLine: () => LINE })
    expect(line.summary).toBe('human:steven: because')
  })
})
