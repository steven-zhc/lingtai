/**
 * `lingtai ticket list` / `lingtai ticket close` (`#385`), injected the same
 * three seams `TicketReading` carries: a `dbTickets` on `:memory:` SQLite, a
 * `ResolvedRecipe` parsed from a literal YAML string, and a literal project
 * list — nothing here touches the log, the filesystem or a process (0060 §1).
 */
import { dbTickets } from '@lingtai/conductor/db-tickets'
import { type ProjectState, emptyProject } from '@lingtai/domain'
import { createSqliteTicketSql, openSqliteLog } from '@lingtai/event-store/sqlite'
import type { TicketSql } from '@lingtai/event-store/ticket-sql'
import { resolveRecipe, type ResolvedRecipe } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { ticketClose, ticketList, type TicketReading } from '../src/ticket.ts'

const DB_YAML = `
version: 2
repo:
  base: main
source:
  kinds: [bug, feature]
  tickets: db
env:
  required: []
  plantAt: .env.local
runtime:
  agent: claude-code
`

const GITHUB_YAML = `
version: 2
repo:
  base: main
source:
  kinds: [bug, feature]
env:
  required: []
  plantAt: .env.local
runtime:
  agent: claude-code
`

function project(name: string): ProjectState {
  return { ...emptyProject, project: name, owner: 'o' }
}

async function recipeFrom(yaml: string): Promise<ResolvedRecipe> {
  return resolveRecipe(async () => yaml, 'main')
}

function freshSql(): TicketSql {
  return createSqliteTicketSql(openSqliteLog(':memory:'))
}

/** Collects `log`'s lines. */
function sink(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = []
  return { log: (l) => lines.push(l), lines }
}

describe('lingtai ticket', () => {
  it('lists open tickets in number order', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    await tickets.createIssue({ title: 'first', body: '', labels: ['bug'] })
    await tickets.createIssue({ title: 'second', body: '', labels: ['feature'] })
    const third = await tickets.createIssue({ title: 'third', body: '', labels: ['bug'] })
    await tickets.closeIssue(third.number)

    const { log, lines } = sink()
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
    }
    const code = await ticketList({ project: 'p' }, log, reading)
    expect(code).toBe(0)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('#1')
    expect(lines[0]).toContain('bug')
    expect(lines[0]).toContain('first')
    expect(lines[1]).toContain('#2')
    expect(lines[1]).toContain('second')
  })

  it('--all adds closed tickets, marked closed, in number order even when created out of number order', async () => {
    const times = [10, 5, 20]
    let i = 0
    const tickets = dbTickets(freshSql(), 'p', { now: () => new Date(times[i++] ?? 0) })
    // #1 is created with the latest timestamp, #2 with the earliest — so a
    // sort by `created_at` (what `listIssuesSince` itself does) would read
    // #2, #1, #3, and only a re-sort by number gets back to #1, #2, #3.
    await tickets.createIssue({ title: 'one', body: '', labels: [] })
    const two = await tickets.createIssue({ title: 'two', body: '', labels: [] })
    await tickets.createIssue({ title: 'three', body: '', labels: [] })
    await tickets.closeIssue(two.number)

    const { log, lines } = sink()
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
    }
    const code = await ticketList({ project: 'p', all: true }, log, reading)
    expect(code).toBe(0)
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual(['#1', '#2', '#3'])
    expect(lines[1]).toContain('closed')
  })

  it('shows the kind column, "—" for a ticket with no kind, and other labels in brackets', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    await tickets.createIssue({ title: 'a bug', body: '', labels: ['bug', 'agent:hold'] })
    await tickets.createIssue({ title: 'unclassified', body: '', labels: ['triage'] })

    const { log, lines } = sink()
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
    }
    const code = await ticketList({ project: 'p' }, log, reading)
    expect(code).toBe(0)
    expect(lines[0]).toContain('bug')
    expect(lines[0]).toContain('[agent:hold]')
    expect(lines[0]).not.toContain('[bug]')
    expect(lines[1]).toContain('—')
    expect(lines[1]).toContain('[triage]')
  })

  it('closes a ticket, and a following list no longer shows it', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const opened = await tickets.createIssue({ title: 'done soon', body: '', labels: ['bug'] })

    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
    }

    const closeOut = sink()
    const closeCode = await ticketClose({ project: 'p', issue: opened.number }, closeOut.log, reading)
    expect(closeCode).toBe(0)
    expect(closeOut.lines[0]).toContain(`#${opened.number}`)
    expect(closeOut.lines[0]).toContain('done soon')

    const listOut = sink()
    const listCode = await ticketList({ project: 'p' }, listOut.log, reading)
    expect(listCode).toBe(0)
    expect(listOut.lines[0]).toBe(`no open tickets for p`)
  })

  it('says "no tickets", not "no open tickets", when --all finds none either', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
    }
    const { log, lines } = sink()
    const code = await ticketList({ project: 'p', all: true }, log, reading)
    expect(code).toBe(0)
    expect(lines[0]).toBe(`no tickets for p`)
  })

  it('refuses closing an unknown ticket number, by name', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
    }
    const { log, lines } = sink()
    const code = await ticketClose({ project: 'p', issue: 999 }, log, reading)
    expect(code).toBe(1)
    expect(lines[0]).toContain('no ticket #999')
  })

  it('refuses a project whose tickets are on GitHub, by name, and never opens a store', async () => {
    let called = false
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(GITHUB_YAML),
      ticketsFor: async () => {
        called = true
        throw new Error('must not be called')
      },
    }

    const listSink = sink()
    expect(await ticketList({ project: 'p' }, listSink.log, reading)).toBe(1)
    expect(listSink.lines[0]).toContain('GitHub')

    const closeSink = sink()
    expect(await ticketClose({ project: 'p', issue: 1 }, closeSink.log, reading)).toBe(1)
    expect(closeSink.lines[0]).toContain('GitHub')

    expect(called).toBe(false)
  })

  it('refuses when more than one project is registered and none is named', async () => {
    const reading: TicketReading = {
      projects: async () => [project('a'), project('b')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => dbTickets(freshSql(), 'a'),
    }
    const { log, lines } = sink()
    const code = await ticketList({}, log, reading)
    expect(code).toBe(1)
    expect(lines[0]).toContain('a')
    expect(lines[0]).toContain('b')
    expect(lines[0]).toContain('--project')
  })
})
