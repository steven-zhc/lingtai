/**
 * `lingtai ticket list` / `lingtai ticket close` (`#385`), injected the same
 * three seams `TicketReading` carries: a `dbTickets` on `:memory:` SQLite, a
 * `ResolvedRecipe` parsed from a literal YAML string, and a literal project
 * list — nothing here touches the log, the filesystem or a process (0060 §1).
 */
import { Readable } from 'node:stream'

import { dbTickets, type DbTickets, type DbTicketsEffects } from '@lingtai/conductor/db-tickets'
import { type ProjectState, emptyProject } from '@lingtai/domain'
import { createSqliteTicketSql, openSqliteLog } from '@lingtai/event-store/sqlite'
import type { TicketSql } from '@lingtai/event-store/ticket-sql'
import { resolveRecipe, type ResolvedRecipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  type EditedForm as EditedFormEffect,
  parseTicketForm,
  renderTicketForm,
  ticketClose as ticketCloseEffect,
  ticketEdit as ticketEditEffect,
  ticketList as ticketListEffect,
  ticketNew as ticketNewEffect,
  type TicketReading as TicketReadingEffect,
} from '../src/ticket.ts'

/**
 * The verbs are Effects and their seams return Effects. The scenarios below are
 * written against plain promise fakes, so this adapts them at the one edge:
 * a fake's rejection is a defect, as a rejected driver is in `makeDbTickets`
 * (0101 §6), which is the case the `your text is kept at …` lines have to hold
 * for. `getIssue`, `closeIssue` and `updateFields` fail with the typed `Error`
 * the real store fails with.
 */
interface EditedForm {
  text: string
  path: string
  discard(): Promise<void>
}
interface TicketReading {
  projects?: () => Promise<ProjectState[]>
  recipeFor?: (state: ProjectState) => Promise<ResolvedRecipe>
  ticketsFor?: (project: string) => Promise<DbTickets>
  env?: Record<string, string | undefined>
  edit?: (command: string, initial: string, name: string) => Promise<EditedForm>
  stdin?: TicketReadingEffect['stdin']
}

const typed = <A>(f: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const effectsOf = (t: DbTickets): DbTicketsEffects => ({
  listOpenIssues: () => Effect.promise(() => t.listOpenIssues()),
  listIssuesSince: (since) => Effect.promise(() => t.listIssuesSince(since)),
  getIssue: (n) => typed(() => t.getIssue(n)),
  createIssue: (input) => Effect.promise(() => t.createIssue(input)),
  comment: (n, body) => typed(() => t.comment(n, body)),
  editComment: (n, id, body) => typed(() => t.editComment(n, id, body)),
  commentBodies: (n) => Effect.promise(() => t.commentBodies(n)),
  setLabels: (n, labels) => typed(() => t.setLabels(n, labels)),
  closeIssue: (n, reason) => typed(() => t.closeIssue(n, reason)),
  updateBody: (n, body, opts) => typed(() => t.updateBody(n, body, opts)),
  updateFields: (n, expected, next) => typed(() => t.updateFields(n, expected, next)),
})

const adapt = (r: TicketReading): TicketReadingEffect => ({
  ...(r.projects ? { projects: () => Effect.promise(r.projects!) } : {}),
  ...(r.recipeFor ? { recipeFor: (state) => typed(() => r.recipeFor!(state)) } : {}),
  ...(r.ticketsFor
    ? { ticketsFor: (project) => Effect.promise(() => r.ticketsFor!(project)).pipe(Effect.map(effectsOf)) }
    : {}),
  ...(r.env ? { env: r.env } : {}),
  ...(r.edit
    ? {
        edit: (command, initial, name) =>
          typed(() => r.edit!(command, initial, name)).pipe(
            Effect.map((form): EditedFormEffect => ({
              text: form.text,
              path: form.path,
              discard: () => Effect.promise(() => form.discard()),
            })),
          ),
      }
    : {}),
  ...(r.stdin ? { stdin: r.stdin } : {}),
})

const ticketList = (
  ...args: [Parameters<typeof ticketListEffect>[0]?, Parameters<typeof ticketListEffect>[1]?, TicketReading?]
) => Effect.runPromise(ticketListEffect(args[0], args[1], adapt(args[2] ?? {})))
const ticketClose = (
  ...args: [Parameters<typeof ticketCloseEffect>[0], Parameters<typeof ticketCloseEffect>[1]?, TicketReading?]
) => Effect.runPromise(ticketCloseEffect(args[0], args[1], adapt(args[2] ?? {})))
const ticketNew = (
  ...args: [Parameters<typeof ticketNewEffect>[0]?, Parameters<typeof ticketNewEffect>[1]?, TicketReading?]
) => Effect.runPromise(ticketNewEffect(args[0], args[1], adapt(args[2] ?? {})))
const ticketEdit = (
  ...args: [Parameters<typeof ticketEditEffect>[0], Parameters<typeof ticketEditEffect>[1]?, TicketReading?]
) => Effect.runPromise(ticketEditEffect(args[0], args[1], adapt(args[2] ?? {})))

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

const EDITOR_ENV = { VISUAL: undefined, EDITOR: 'fake-editor' }

/**
 * `TicketReading['edit']`, scripted rather than spawning anything (0060 §1):
 * the "editor" is just `script`, applied to whatever `ticket.ts` rendered.
 * Records every call and whether `discard` ran, which is how a test proves
 * "refusal keeps, success discards" without a real file.
 */
function fakeEdit(script: string | ((initial: string) => string)): {
  edit: NonNullable<TicketReading['edit']>
  discards: number
  calls: { command: string; initial: string; name: string }[]
} {
  const calls: { command: string; initial: string; name: string }[] = []
  let discards = 0
  const edit = async (command: string, initial: string, name: string): Promise<EditedForm> => {
    calls.push({ command, initial, name })
    const text = typeof script === 'function' ? script(initial) : script
    return {
      text,
      path: `/fake/${name}.md`,
      async discard() {
        discards++
      },
    }
  }
  return {
    edit,
    get discards(): number {
      return discards
    },
    calls,
  }
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
    // The heading and the header row, then the rows.
    expect(lines[0]).toBe('p')
    expect(lines[1]).toMatch(/^ID\s+KIND\s+TITLE$/)
    const rows = lines.slice(2)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('#1')
    expect(rows[0]).toContain('bug')
    expect(rows[0]).toContain('first')
    expect(rows[1]).toContain('#2')
    expect(rows[1]).toContain('second')
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
    const rows = lines.slice(2)
    expect(rows.map((l) => l.split(/\s+/)[0])).toEqual(['#1', '#2', '#3'])
    expect(rows[1]).toContain('closed')
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
    const rows = lines.slice(2)
    expect(rows[0]).toContain('bug')
    expect(rows[0]).toContain('[agent:hold]')
    expect(rows[0]).not.toContain('[bug]')
    expect(rows[1]).toContain('—')
    expect(rows[1]).toContain('[triage]')
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

describe('lingtai ticket list --json (#624)', () => {
  const doc = async (reading: TicketReading, options = {}) => {
    const { log, lines } = sink()
    const code = await ticketList({ project: 'p', json: true, ...options }, log, reading)
    return { code, doc: JSON.parse(lines.join('\n')) as Record<string, unknown>, lines }
  }

  it('prints one document of the tickets, and nothing else', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    await tickets.createIssue({ title: 'a bug', body: '', labels: ['bug', 'agent:hold'] })
    const r = await doc({
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
    })
    expect(r.code).toBe(0)
    expect(r.lines).toHaveLength(1)
    expect(r.doc).toEqual({
      version: 1,
      command: 'ticket list',
      project: 'p',
      all: false,
      tickets: [{ number: 1, kind: 'bug', title: 'a bug', state: 'open', labels: ['bug', 'agent:hold'] }],
    })
  })

  it('answers each refusal with an error document and a code, exit 1', async () => {
    const base = { recipeFor: async () => recipeFrom(DB_YAML), ticketsFor: async () => dbTickets(freshSql(), 'p') }
    const code = async (reading: TicketReading, options = {}) => {
      const r = await doc(reading, options)
      expect(r.code).toBe(1)
      expect(r.doc['command']).toBe('ticket list')
      return (r.doc['error'] as { code: string }).code
    }
    expect(await code({ ...base, projects: async () => [project('a')] }, { project: 'zzz' })).toBe('no-project')
    expect(await code({ ...base, projects: async () => [] }, { project: undefined })).toBe('no-projects')
    expect(await code({ ...base, projects: async () => [project('a'), project('b')] }, { project: undefined })).toBe(
      'ambiguous-project',
    )
    expect(
      await code({
        projects: async () => [project('p')],
        recipeFor: async () => {
          throw new Error('no recipe')
        },
        ticketsFor: base.ticketsFor,
      }),
    ).toBe('recipe-unreadable')
    expect(
      await code({
        projects: async () => [project('p')],
        recipeFor: async () => recipeFrom(GITHUB_YAML),
        ticketsFor: base.ticketsFor,
      }),
    ).toBe('tickets-on-github')
  })
})

describe('lingtai ticket new / edit (#386)', () => {
  it('new refuses by name, before opening any store, when neither $VISUAL nor $EDITOR is set', async () => {
    let called = false
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => {
        called = true
        throw new Error('must not be called')
      },
      env: { VISUAL: undefined, EDITOR: undefined },
    }
    const { log, lines } = sink()
    expect(await ticketNew({ project: 'p' }, log, reading)).toBe(1)
    expect(lines[0]).toContain('VISUAL')
    expect(lines[0]).toContain('EDITOR')
    expect(called).toBe(false)
  })

  it("new creates a ticket with the parsed title, labels and body, from a form seeded with the recipe's kinds", async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const fake = fakeEdit('a fresh bug\nlabels: bug, agent:hold\n\nSteps to reproduce.\n')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    const code = await ticketNew({ project: 'p' }, log, reading)
    expect(code).toBe(0)
    expect(lines[0]).toContain('created #1')
    expect(lines[0]).toContain('a fresh bug')

    const created = await tickets.getIssue(1)
    expect(created.title).toBe('a fresh bug')
    expect(created.labels.map((l) => l.name).sort()).toEqual(['agent:hold', 'bug'])
    expect(created.body).toBe('Steps to reproduce.')
    expect(fake.calls[0]?.initial).toContain('#! kinds: bug, feature')
    expect(fake.discards).toBe(1)
  })

  it('new accepts blank lines pasted before a title', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const fake = fakeEdit('\n\nAdd the next chapter\nlabels: feature\n\nContinue the story.\n')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketNew({ project: 'p' }, log, reading)).toBe(0)
    expect(lines[0]).toContain('created #1')
    const created = await tickets.getIssue(1)
    expect(created.title).toBe('Add the next chapter')
    expect(created.labels.map((label) => label.name)).toEqual(['feature'])
    expect(created.body).toBe('Continue the story.')
  })

  it("new still creates the ticket when no kind label is in labels:, with a warning that the queue won't take it", async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const fake = fakeEdit('untriaged\nlabels: \n\nbody\n')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketNew({ project: 'p' }, log, reading)).toBe(0)
    expect(lines[0]).toContain('created #1')
    expect(lines[1]).toContain('no kind label')
    expect((await tickets.getIssue(1)).title).toBe('untriaged')
  })

  it('new does nothing and keeps the file when the form is quit unchanged', async () => {
    let createCalled = false
    const fake = fakeEdit((initial) => initial)
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => ({
        ...dbTickets(freshSql(), 'p'),
        createIssue: async () => {
          createCalled = true
          throw new Error('must not be called')
        },
      }),
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketNew({ project: 'p' }, log, reading)).toBe(0)
    expect(lines[0]).toContain('no change')
    expect(lines[0]).toContain('/fake/')
    expect(createCalled).toBe(false)
    // Not discarded: a non-blocking editor would still have the person typing
    // into this path (#386 round 2).
    expect(fake.discards).toBe(0)
  })

  it('new refuses an empty title and keeps the file, even once the body was filled in', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const fake = fakeEdit('\nlabels: bug\n\nsomebody wrote a body but never a title\n')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketNew({ project: 'p' }, log, reading)).toBe(1)
    expect(lines[0]).toContain('title')
    expect(lines[0]).toContain('/fake/')
    expect(fake.discards).toBe(0)
    expect((await tickets.listIssuesSince(new Date(0))).length).toBe(0)
  })

  it('new refuses by name, without writing anything, a title starting #! — it would read back as a dropped instruction line', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const fake = fakeEdit(
      '#!/usr/bin/env node is wrong in the built binary\nlabels: bug, agent:hold\n\nthe shebang the SEA writes points at the wrong node.\n',
    )
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketNew({ project: 'p' }, log, reading)).toBe(1)
    expect(lines[0]).toContain('/fake/')
    expect(fake.discards).toBe(0)
    expect((await tickets.listIssuesSince(new Date(0))).length).toBe(0)
  })

  it('new keeps the file and prints its path when creating the ticket fails', async () => {
    const fake = fakeEdit('a fresh bug\nlabels: bug\n\nbody\n')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => {
        throw new Error('the store is down')
      },
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketNew({ project: 'p' }, log, reading)).toBe(1)
    expect(lines[0]).toContain('the store is down')
    expect(lines[0]).toContain('/fake/')
    expect(fake.discards).toBe(0)
  })

  it('edit refuses an unknown ticket number, by name, without opening the editor', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const fake = fakeEdit('unreached')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketEdit({ project: 'p', issue: 999 }, log, reading)).toBe(1)
    expect(lines[0]).toContain('no ticket #999')
    expect(fake.calls).toHaveLength(0)
  })

  it('edit refuses, without opening the editor or writing anything, a ticket whose title starts #! — it would read back as a dropped header line', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const opened = await tickets.createIssue({
      title: '#!/usr/bin/env node is wrong in the built binary',
      body: 'the shebang the SEA writes points at the wrong node.',
      labels: ['bug', 'agent:hold'],
    })
    const fake = fakeEdit('unreached')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketEdit({ project: 'p', issue: opened.number }, log, reading)).toBe(1)
    expect(lines[0]).toContain(`#${opened.number}`)
    expect(fake.calls).toHaveLength(0)

    const after = await tickets.getIssue(opened.number)
    expect(after.title).toBe('#!/usr/bin/env node is wrong in the built binary')
    expect(after.labels.map((l) => l.name)).toEqual(['bug', 'agent:hold'])
  })

  it('edit refuses, without opening the editor or writing anything, a ticket with a comma inside one of its labels', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const opened = await tickets.createIssue({
      title: 'untouched',
      body: 'body',
      labels: ['bug', 'needs design, maybe'],
    })
    const fake = fakeEdit('unreached')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketEdit({ project: 'p', issue: opened.number }, log, reading)).toBe(1)
    expect(lines[0]).toContain(`#${opened.number}`)
    expect(fake.calls).toHaveLength(0)

    const after = await tickets.getIssue(opened.number)
    expect(after.labels.map((l) => l.name)).toEqual(['bug', 'needs design, maybe'])
  })

  it('edit writes only the fields that changed', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const opened = await tickets.createIssue({ title: 'old title', body: 'old body', labels: ['bug'] })
    const fake = fakeEdit('old title\nlabels: bug\n\nnew body\n')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketEdit({ project: 'p', issue: opened.number }, log, reading)).toBe(0)
    expect(lines[0]).toContain('body')
    expect(lines[0]).not.toContain('title')
    expect(lines[0]).not.toContain('labels')

    const after = await tickets.getIssue(opened.number)
    expect(after.title).toBe('old title')
    expect(after.body).toBe('new body')
    expect(after.labels.map((l) => l.name)).toEqual(['bug'])
  })

  it('edit that changes only the title leaves the stored body byte-for-byte unchanged', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const opened = await tickets.createIssue({ title: 'old title', body: 'body line\n', labels: ['bug'] })
    const fake = fakeEdit((initial) => initial.replace('old title', 'new title'))
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketEdit({ project: 'p', issue: opened.number }, log, reading)).toBe(0)
    expect(lines[0]).toContain('title')
    expect(lines[0]).not.toContain('body')

    const after = await tickets.getIssue(opened.number)
    expect(after.title).toBe('new title')
    // The rendered form shows the body trimmed; saving it back must not
    // overwrite the stored row's own trailing newline just because the title
    // changed (#386 round 4).
    expect(after.body).toBe('body line\n')
  })

  it('edit reports no change when the stored body ends in a newline the form never shows', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const opened = await tickets.createIssue({ title: 'steady', body: 'steady body\n\nFinding: x\n', labels: ['bug'] })
    const fake = fakeEdit((initial) => initial)
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketEdit({ project: 'p', issue: opened.number }, log, reading)).toBe(0)
    expect(lines[0]).toContain('no change')
    expect(lines[0]).toContain('/fake/')
    expect(fake.discards).toBe(0)

    const after = await tickets.getIssue(opened.number)
    expect(after.body).toBe('steady body\n\nFinding: x\n')
  })

  it('edit keeps the file and lands nothing when the write throws', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const opened = await tickets.createIssue({ title: 'old title', body: 'old body', labels: ['bug'] })
    const fake = fakeEdit('new title\nlabels: bug\n\nnew body\n')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => ({
        ...tickets,
        updateFields: async () => {
          throw new Error('connection dropped')
        },
      }),
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketEdit({ project: 'p', issue: opened.number }, log, reading)).toBe(1)
    expect(lines[0]).toContain('connection dropped')
    expect(fake.discards).toBe(0)

    // The title and the body are written together in one statement
    // (`updateFields`), so a throw there lands neither.
    const after = await tickets.getIssue(opened.number)
    expect(after.title).toBe('old title')
    expect(after.body).toBe('old body')
  })

  it('edit refuses when the ticket changed since the form was opened, and keeps the file', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const opened = await tickets.createIssue({ title: 'old title', body: 'old body', labels: ['bug'] })
    const fake = fakeEdit('old title\nlabels: bug\n\nnew body\n')
    let firstRead = true
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => ({
        ...tickets,
        async getIssue(n: number) {
          const row = await tickets.getIssue(n)
          if (firstRead) {
            firstRead = false
            // A real second `edit` session, saved in full between this
            // session's one read and its one write — not a mocked
            // comparison, an actual write through the same store, so the
            // refusal below comes from `updateFields`'s own compare-and-swap
            // rather than from a second read this code no longer performs.
            await tickets.updateBody(n, 'a second edit landed first')
          }
          return row
        },
      }),
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketEdit({ project: 'p', issue: opened.number }, log, reading)).toBe(1)
    expect(lines[0]).toContain('changed since')
    expect(fake.discards).toBe(0)

    const after = await tickets.getIssue(opened.number)
    expect(after.title).toBe('old title')
    expect(after.body).toBe('a second edit landed first')
  })

  it('edit does nothing when the form is quit unchanged', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const opened = await tickets.createIssue({ title: 'steady', body: 'steady body', labels: ['feature'] })
    const fake = fakeEdit((initial) => initial)
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketEdit({ project: 'p', issue: opened.number }, log, reading)).toBe(0)
    expect(lines[0]).toContain('no change')
    expect(lines[0]).toContain('/fake/')
    expect(fake.discards).toBe(0)

    const after = await tickets.getIssue(opened.number)
    expect(after.title).toBe('steady')
    expect(after.body).toBe('steady body')
  })

  it('edit refuses an emptied title and keeps the file, without writing anything', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const opened = await tickets.createIssue({ title: 'had a title', body: 'body', labels: [] })
    const fake = fakeEdit('\nlabels: \n\nbody\n')
    const reading: TicketReading = {
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => tickets,
      env: EDITOR_ENV,
      edit: fake.edit,
    }
    const { log, lines } = sink()
    expect(await ticketEdit({ project: 'p', issue: opened.number }, log, reading)).toBe(1)
    expect(lines[0]).toContain('title')
    expect(fake.discards).toBe(0)

    const after = await tickets.getIssue(opened.number)
    expect(after.title).toBe('had a title')
  })
})

describe('lingtai ticket new --title (#1060)', () => {
  const noEditor = (tickets: ReturnType<typeof dbTickets>, extra: Partial<TicketReading> = {}): TicketReading => ({
    projects: async () => [project('p')],
    recipeFor: async () => recipeFrom(DB_YAML),
    ticketsFor: async () => tickets,
    env: {},
    edit: async () => {
      throw new Error('the editor must not open')
    },
    ...extra,
  })
  const countingTickets = () => {
    const real = dbTickets(freshSql(), 'p')
    const state = { creates: 0 }
    const wrapped = {
      ...real,
      createIssue: (...args: Parameters<typeof real.createIssue>) => {
        state.creates += 1
        return real.createIssue(...args)
      },
    } as typeof real
    return { wrapped, state }
  }

  it('creates the ticket from flags with no editor', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const { log, lines } = sink()
    const code = await ticketNew(
      { project: 'p', title: ' Fix it ', label: 'bug, agent:hold', body: 'Steps.\n\n' },
      log,
      noEditor(tickets),
    )
    expect(code).toBe(0)
    expect(lines[0]).toContain('created #1')
    const created = await tickets.getIssue(1)
    expect(created.title).toBe('Fix it')
    expect(created.labels.map((l) => l.name).sort()).toEqual(['agent:hold', 'bug'])
    expect(created.body).toBe('Steps.')
  })

  it('warns when no kind label is given, and still creates', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const { log, lines } = sink()
    expect(await ticketNew({ project: 'p', title: 'x' }, log, noEditor(tickets))).toBe(0)
    expect(lines.join('\n')).toContain('carries no kind label')
  })

  it('--body - takes the body from the injected stdin', async () => {
    const tickets = dbTickets(freshSql(), 'p')
    const { log } = sink()
    const stdin = Object.assign(Readable.from(['the body\n']), { isTTY: false })
    expect(await ticketNew({ project: 'p', title: 'x', body: '-' }, log, noEditor(tickets, { stdin }))).toBe(0)
    expect((await tickets.getIssue(1)).body).toBe('the body')
  })

  it('--body - on a terminal is refused', async () => {
    const { wrapped, state } = countingTickets()
    const { log, lines } = sink()
    const stdin = Object.assign(Readable.from([]), { isTTY: true })
    expect(await ticketNew({ project: 'p', title: 'x', body: '-' }, log, noEditor(wrapped, { stdin }))).toBe(1)
    expect(lines[0]).toContain('--body - reads stdin')
    expect(state.creates).toBe(0)
  })

  it('prints why createIssue failed, not a wrapper message', async () => {
    const tickets = {
      ...dbTickets(freshSql(), 'p'),
      createIssue: async () => {
        throw new Error('SQLITE_READONLY')
      },
    } as unknown as ReturnType<typeof dbTickets>
    const { log, lines } = sink()
    expect(await ticketNew({ project: 'p', title: 'x' }, log, noEditor(tickets))).toBe(1)
    expect(lines.join('\n')).toContain('SQLITE_READONLY')
  })

  it('names the cause when the stdin read fails', async () => {
    const { wrapped, state } = countingTickets()
    const { log, lines } = sink()
    const stdin = Object.assign(
      new Readable({
        read() {
          this.destroy(new Error('EIO'))
        },
      }),
      { isTTY: false },
    )
    expect(await ticketNew({ project: 'p', title: 'x', body: '-' }, log, noEditor(wrapped, { stdin }))).toBe(1)
    expect(lines.join('\n')).toContain('--body -')
    expect(lines.join('\n')).toContain('EIO')
    expect(state.creates).toBe(0)
  })

  it.each([
    ['--label without --title', { label: 'bug' }, '--label needs --title'],
    ['--body without --title', { body: 'x' }, '--body needs --title'],
    ['an empty title', { title: '' }, 'a ticket needs a title'],
    ['a whitespace title', { title: '   ' }, 'a ticket needs a title'],
    ['a title with a newline', { title: 'a\nb' }, 'ticket edit could not read it back'],
    ['a title starting #!', { title: '#!x' }, 'ticket edit could not read it back'],
    ['a label with a newline', { title: 'x', label: 'bug\nx' }, 'ticket edit could not read it back'],
  ])('refuses %s and creates nothing', async (_name, flags, said) => {
    const { wrapped, state } = countingTickets()
    const { log, lines } = sink()
    expect(await ticketNew({ project: 'p', ...flags }, log, noEditor(wrapped))).toBe(1)
    expect(lines.join('\n')).toContain(said)
    expect(state.creates).toBe(0)
  })
})

describe('a store failure is a defect, and still keeps the text (#1100)', () => {
  // `makeDbTickets` fails with a defect on a driver error (0101 §6), which
  // `Effect.catch` does not see: the sentence that says where the text is kept
  // has to hold for the whole cause.
  const dying = (): TicketReadingEffect => {
    const base = adapt({
      projects: async () => [project('p')],
      recipeFor: async () => recipeFrom(DB_YAML),
      ticketsFor: async () => dbTickets(freshSql(), 'p'),
      env: EDITOR_ENV,
    })
    return {
      ...base,
      ticketsFor: () =>
        Effect.succeed({
          ...effectsOf(dbTickets(freshSql(), 'p')),
          createIssue: () => Effect.die(new Error('disk I/O error')),
        }),
    }
  }

  it('ticket new says where the text is kept, and does not discard it', async () => {
    const fake = fakeEdit('a fresh bug\nlabels: bug\n\nSteps.\n')
    const { log, lines } = sink()
    const reading = adapt({ edit: fake.edit })
    const code = await Effect.runPromise(ticketNewEffect({ project: 'p' }, log, { ...dying(), edit: reading.edit! }))
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('disk I/O error — your text is kept at /fake/p-new.md')
    expect(fake.discards).toBe(0)
  })
})

describe('renderTicketForm / parseTicketForm round-trip (#386)', () => {
  it('parse(render(t)) equals t for a title, labels and a multi-line body with blank lines', () => {
    const form = {
      title: "the sample's tests fail on an empty input",
      labels: ['bug', 'agent:hold'],
      body: 'first paragraph.\n\nsecond paragraph, after a blank line.',
    }
    const rendered = renderTicketForm(form)
    const parsed = parseTicketForm(rendered)
    expect(parsed).toEqual({ ok: true, form })
  })

  it('a body that itself contains a labels: line or a #! line round-trips, because those only count in the header', () => {
    const form = {
      title: 'body carries header-shaped lines',
      labels: ['feature'],
      body: 'labels: not actually a header\n#! not actually an instruction',
    }
    const rendered = renderTicketForm(form)
    expect(parseTicketForm(rendered)).toEqual({ ok: true, form })
  })

  it('an extra trailing newline on save still parses equal to the original', () => {
    const form = { title: 'tidy save', labels: ['bug'], body: 'the body' }
    const rendered = renderTicketForm(form)
    const savedWithExtraNewline = `${rendered}\n`
    expect(parseTicketForm(savedWithExtraNewline)).toEqual({ ok: true, form })
  })

  it('instructions passed to render are dropped by parse wherever they fall in the header', () => {
    const form = { title: 'x', labels: ['bug'], body: 'y' }
    const rendered = renderTicketForm(form, ['#! kinds: bug, feature — one belongs in labels:'])
    expect(parseTicketForm(rendered)).toEqual({ ok: true, form })
  })

  it('a stray header line that is neither the title nor labels: is refused by name', () => {
    const text = 'a title\nlabels: bug\nthis line should have been under a blank line\n\nbody'
    const parsed = parseTicketForm(text)
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.why).toContain('header')
  })

  it('a first line starting #! is refused rather than read as a dropped instruction, which would promote labels: into the title', () => {
    const text = '#! not a title\nlabels: bug\n\nbody'
    const parsed = parseTicketForm(text)
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.why).toContain('title')
  })

  it('a first line starting labels: is refused rather than read as the labels line', () => {
    const text = 'labels: bug, feature\n\nbody'
    const parsed = parseTicketForm(text)
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.why).toContain('title')
  })
})
