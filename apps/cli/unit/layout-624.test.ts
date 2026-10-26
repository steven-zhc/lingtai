/** The layout and the `--json` documents of `ticket list`, the backlog listing and `attach` (#624), with no process behind them. */
import type { BacklogEntry } from '@lingtai/projector'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { attachHeader } from '../src/attach.ts'
import { backlogJson, renderBacklog, type BacklogListing } from '../src/backlog.ts'
import { renderTicketList, ticketListJson, type TicketListing } from '../src/ticket.ts'

const saved = process.env['NO_COLOR']
beforeEach(() => {
  process.env['NO_COLOR'] = '1'
})
afterEach(() => {
  if (saved === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = saved
})

const LONG = 'a title that is a good deal longer than one line has room for, '.repeat(4).trim()

const listing: TicketListing = {
  project: 'p',
  all: true,
  tickets: [
    { number: 3, kind: 'bug', kindLabel: 'bug', title: LONG, state: 'open', labels: ['bug', 'agent:hold'] },
    { number: 10, kind: null, kindLabel: null, title: 'unclassified', state: 'closed', labels: ['triage'] },
  ],
}

describe('ticket list', () => {
  it('prints the project, then ID/KIND/TITLE, with no escapes under NO_COLOR', () => {
    const lines = renderTicketList(listing)
    expect(lines.join('\n')).not.toContain('\u001b')
    expect(lines[0]).toBe('p')
    expect(lines[1]).toMatch(/^ID\s+KIND\s+TITLE$/)
    expect(lines[2]).toMatch(/^#3\s+bug\s+a title/)
    // The kind label is the KIND column's; the others are tags, and `closed` is one.
    expect(lines[2]).toContain('[agent:hold]')
    expect(lines[2]).not.toContain('[bug]')
    expect(lines[3]).toMatch(/^#10\s+—\s+unclassified {2}\[closed\] \[triage\]$/)
  })

  it('stays one line when there is nothing', () => {
    expect(renderTicketList({ ...listing, all: false, tickets: [] })).toEqual(['no open tickets for p'])
    expect(renderTicketList({ ...listing, tickets: [] })).toEqual(['no tickets for p'])
  })

  it('becomes a block per row where the terminal is narrower than the table', () => {
    const lines = renderTicketList(listing, { columns: 20 })
    expect(lines[1]).toMatch(/^ID\s+#3$/)
  })

  it('--json carries the full title, every label, and the kind or null', () => {
    const doc = JSON.parse(JSON.stringify({ version: 1, command: 'ticket list', ...ticketListJson(listing) }))
    expect(doc).toEqual({
      version: 1,
      command: 'ticket list',
      project: 'p',
      all: true,
      tickets: [
        { number: 3, kind: 'bug', title: LONG, state: 'open', labels: ['bug', 'agent:hold'] },
        { number: 10, kind: null, title: 'unclassified', state: 'closed', labels: ['triage'] },
      ],
    })
  })
})

const ENTRY: BacklogEntry = {
  key: '0123456789ab',
  project: 'lingtai',
  issue: '49',
  taskId: 'ticket-lingtai-49',
  runId: 'pass-1',
  step: 'proposed',
  action: 'review',
  onSha: 'a'.repeat(40),
  file: 'apps/cli/src/doctor.ts',
  line: 1204,
  severity: 'minor',
  claim: 'the detail names three issues and nothing else',
  failureScenario: 'a reader has to open GitHub before the line means anything',
  raisedSeq: '9',
  raisedAt: new Date(0),
  status: 'open',
  decidedBy: null,
  decidedAt: null,
  kind: null,
  proposedRef: null,
  proposedUrl: null,
  reason: null,
}

const backlog = (over: Partial<BacklogListing> = {}): BacklogListing => ({
  project: null,
  all: false,
  entries: [
    { entry: ENTRY, title: 'the end point runs on every outcome' },
    { entry: { ...ENTRY, key: 'bbbbbbbbbbbb', project: 'other' }, title: null },
  ],
  ...over,
})

describe('backlog listing', () => {
  it('is a section per project, the entry lines inside it, and `next:` for the verb', () => {
    const lines = renderBacklog(backlog()).join('\n').split('\n')
    expect(lines.join('\n')).not.toContain('\u001b')
    expect(lines[0]).toBe('lingtai')
    expect(lines[1]).toBe(
      '  0123456789ab  #49 the end point runs on every outcome  proposed:review  apps/cli/src/doctor.ts:1204',
    )
    expect(lines).toContain('other')
    expect(lines).toContain('next: lingtai backlog accept <project> <key> --kind <kind>')
    expect(lines.join('\n')).not.toContain('accept one:')
  })

  it('leaves out `next:` under --all, and says when there is nothing', () => {
    expect(renderBacklog(backlog({ all: true })).join('\n')).not.toContain('next:')
    expect(renderBacklog(backlog({ entries: [] }))).toEqual(['nothing open in the backlog'])
    expect(renderBacklog(backlog({ entries: [], all: true }))).toEqual(['the backlog is empty'])
  })

  it('keeps the line that says the catch-up failed', () => {
    const lines = renderBacklog(backlog({ behind: 'database is down', entries: [] }))
    expect(lines[0]).toBe('the backlog could not catch up, and may be behind: database is down')
  })

  it('--json carries every field, ISO dates, the title, and `behind` only when it is true', () => {
    const doc = JSON.parse(JSON.stringify({ version: 1, command: 'backlog', ...backlogJson(backlog()) }))
    expect(doc.command).toBe('backlog')
    expect(doc.project).toBeNull()
    expect(doc.all).toBe(false)
    expect(doc).not.toHaveProperty('behind')
    expect(doc.entries[0]).toEqual({
      ...ENTRY,
      raisedAt: '1970-01-01T00:00:00.000Z',
      decidedAt: null,
      title: 'the end point runs on every outcome',
    })
    expect(doc.entries[1].title).toBeNull()

    const late = JSON.parse(
      JSON.stringify(
        backlogJson(
          backlog({
            behind: 'database is down',
            entries: [{ entry: { ...ENTRY, status: 'declined', decidedAt: new Date(1000) }, title: null }],
          }),
        ),
      ),
    )
    expect(late.behind).toBe('database is down')
    expect(late.entries[0].decidedAt).toBe('1970-01-01T00:00:01.000Z')
  })
})

describe('attach header', () => {
  it('is a heading, where the log is, and a blank line before the run’s own lines', () => {
    const lines = attachHeader({ project: 'lingtai', path: '/home/x/.lingtai/runs/lingtai/2d6f1c.log' })
    expect(lines).toEqual(['attached to lingtai', 'log  /home/x/.lingtai/runs/lingtai/2d6f1c.log', ''])
  })
})
