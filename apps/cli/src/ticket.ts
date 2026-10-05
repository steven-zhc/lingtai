/**
 * `lingtai ticket list` / `close` / `new` / `edit` — what a person does
 * against a project's own ticket table, once tickets live in the database
 * rather than on GitHub (`#385`, `#380`, `#386`).
 *
 * **Not `lingtai close`.** That command ends a work item on the log — the
 * `end` point runs and the queue stops offering the issue because the log
 * says it is over. This file only changes a row in `tickets`: nothing is
 * appended, no projector is held, and the daemon notices on its next sweep
 * rather than at once.
 *
 * **Not through `projectFilter`.** Its default `clientFor` is
 * `githubClientFor`, which throws with no GitHub App configured — exactly the
 * machine a `db`-ticketed project runs on. The recipe is read with
 * `currentRecipe` directly, the same call `apps/board/src/lib/task.ts` makes
 * for the same question, and no client is ever built.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { currentRecipe, kindLabelOf, kindOf, loadProjects, type Tickets } from '@lingtai/conductor'
import { dbTickets, type DbTickets } from '@lingtai/conductor/db-tickets'
import type { ProjectState } from '@lingtai/domain'
import { processTicketSql } from '@lingtai/event-store'
import type { Recipe, ResolvedRecipe } from '@lingtai/recipe'
import { queueOf, ticketSourceOf } from '@lingtai/recipe/settings'

/** `status.ts`'s own `oneLine`, copied rather than exported for one caller. */
function oneLine(text: string, n = 140): string {
  const said = text.replace(/\s+/g, ' ').trim()
  return said.length > n ? `${said.slice(0, n - 1)}…` : said
}

/** What `edit` hands back: the saved text, where it was kept, and how to clean it up once it is no longer needed. */
export interface EditedForm {
  text: string
  path: string
  discard(): Promise<void>
}

/**
 * How a project's recipe and its ticket store are found — defaulted, and
 * injectable so a test can hand `dbTickets` a `:memory:` SQLite and a literal
 * `ResolvedRecipe` without touching the log or the filesystem.
 *
 * **`env` and `edit` are the seam `ticketNew`/`ticketEdit` open `$EDITOR`
 * through.** 0060 §1 makes a temporary file integration just as much as a
 * spawned process, so `edit` owns both: a unit test fakes it to return a
 * scripted `text` at a fixed `path` and records whether `discard` ran,
 * without touching the filesystem or starting a process.
 */
export interface TicketReading {
  projects?: () => Promise<ProjectState[]>
  recipeFor?: (state: ProjectState) => Promise<ResolvedRecipe>
  ticketsFor?: (project: string) => Promise<DbTickets>
  env?: Record<string, string | undefined>
  edit?: (command: string, initial: string, name: string) => Promise<EditedForm>
}

async function defaultTicketsFor(project: string): Promise<DbTickets> {
  return dbTickets(await processTicketSql(), project)
}

/** The first non-blank of `$VISUAL` and `$EDITOR` — the house rule (`restart.ts`'s `$USER`), never a guessed default like `vi`. */
function editorCommand(env: Record<string, string | undefined>): string | null {
  const visual = env['VISUAL']
  if (visual && visual.trim() !== '') return visual
  const editor = env['EDITOR']
  if (editor && editor.trim() !== '') return editor
  return null
}

/**
 * Opens `command` on a fresh temporary file holding `initial`, waits for it
 * to exit, and reads the file back. Through `sh -c`, so `$EDITOR` carrying
 * its own arguments (`code -w`, `emacsclient -t`) still runs.
 *
 * Not unit-tested, by design (0060 §1) — `unit/ticket.test.ts` injects `edit`
 * instead.
 */
async function defaultEdit(command: string, initial: string, name: string): Promise<EditedForm> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lingtai-ticket-'))
  const filePath = path.join(dir, `${name}.md`)
  await writeFile(filePath, initial, 'utf8')
  const result = spawnSync('sh', ['-c', `${command} "$1"`, 'lingtai-editor', filePath], { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`the editor exited with status ${result.status ?? result.signal} — your text is kept at ${filePath}`)
  }
  const text = await readFile(filePath, 'utf8')
  return {
    text,
    path: filePath,
    async discard() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * The one project this call is about: `--project` named, or the only one
 * registered. More than one with nothing named is refused rather than
 * guessed — `close <n>` against the wrong project closes a different
 * ticket carrying the same number.
 */
async function pickProject(
  named: string | undefined,
  projects: () => Promise<ProjectState[]>,
  log: (line: string) => void,
): Promise<ProjectState | null> {
  const all = await projects()
  if (named !== undefined) {
    const found = all.find((p) => p.project === named)
    if (!found) {
      log(`no project named "${named}" — run lingtai add <owner>/<repo> first`)
      return null
    }
    return found
  }
  if (all.length === 0) {
    log('no projects registered — run lingtai add <owner>/<repo>')
    return null
  }
  if (all.length > 1) {
    log(
      `more than one project is registered (${all.map((p) => p.project).join(', ')}) — say which with --project <p>`,
    )
    return null
  }
  return all[0]!
}

/**
 * Refuses by name, before any store is opened, a project whose tickets are
 * not Lingtai's own. `dbTickets` creates its tables on first use, so asking
 * it anything on a `github` project would leave behind empty `tickets` and
 * `ticket_comments` tables for no reason — this check runs first so that
 * never happens.
 */
async function resolveDbRecipe(
  project: ProjectState,
  recipeFor: (state: ProjectState) => Promise<ResolvedRecipe>,
  log: (line: string) => void,
): Promise<Recipe | null> {
  let resolved: ResolvedRecipe
  try {
    resolved = await recipeFor(project)
  } catch (err) {
    log((err as Error).message)
    return null
  }
  if (ticketSourceOf(resolved.recipe) !== 'db') {
    log(
      `${project.project}'s tickets are on GitHub (${project.owner}/${project.project}) — gh issue list reads them, not lingtai ticket`,
    )
    return null
  }
  return resolved.recipe
}

export interface TicketListOptions {
  project?: string
  all?: boolean
}

export async function ticketList(
  options: TicketListOptions = {},
  log: (line: string) => void = console.log,
  reading: TicketReading = {},
): Promise<number> {
  const projects = reading.projects ?? loadProjects
  const recipeFor = reading.recipeFor ?? ((state: ProjectState) => currentRecipe(state))
  const ticketsFor = reading.ticketsFor ?? defaultTicketsFor

  const project = await pickProject(options.project, projects, log)
  if (!project) return 1
  const name = project.project!

  const recipe = await resolveDbRecipe(project, recipeFor, log)
  if (!recipe) return 1

  const kinds = queueOf(recipe).kinds
  const tickets = await ticketsFor(name)
  const listing = options.all
    ? [...(await tickets.listIssuesSince(new Date(0)))].sort((a, b) => a.number - b.number)
    : await tickets.listOpenIssues()

  if (listing.length === 0) {
    log(options.all ? `no tickets for ${name}` : `no open tickets for ${name}`)
    return 0
  }

  const numberWidth = Math.max(...listing.map((t) => String(t.number).length))
  const kindWidth = Math.max(...listing.map((t) => (kindOf(t, kinds) ?? '—').length))
  for (const t of listing) {
    const matched = kindLabelOf(t, kinds)
    const kind = matched?.kind ?? '—'
    // Every label except the one `kindOf` matched — matched by `kindLabelOf`'s
    // own rule, so a label differing only in case or whitespace is not shown
    // twice (`discover.ts:102-105`).
    const others = t.labels.map((l) => l.name).filter((n) => n !== matched?.label.name)
    const tags = [...(t.state === 'closed' ? ['closed'] : []), ...others].map((s) => `[${s}]`).join(' ')
    log(
      `#${String(t.number).padEnd(numberWidth)}  ${kind.padEnd(kindWidth)}  ${oneLine(t.title)}` +
        (tags ? `  ${tags}` : ''),
    )
  }
  return 0
}

export interface TicketCloseOptions {
  project?: string
  issue: number
}

export async function ticketClose(
  options: TicketCloseOptions,
  log: (line: string) => void = console.log,
  reading: TicketReading = {},
): Promise<number> {
  const projects = reading.projects ?? loadProjects
  const recipeFor = reading.recipeFor ?? ((state: ProjectState) => currentRecipe(state))
  const ticketsFor = reading.ticketsFor ?? defaultTicketsFor

  const project = await pickProject(options.project, projects, log)
  if (!project) return 1
  const name = project.project!

  const recipe = await resolveDbRecipe(project, recipeFor, log)
  if (!recipe) return 1

  const tickets = await ticketsFor(name)
  let ticket: Awaited<ReturnType<Tickets['getIssue']>>
  try {
    ticket = await tickets.getIssue(options.issue)
  } catch (err) {
    log((err as Error).message)
    return 1
  }
  // A second close reads as a first one otherwise — `closeIssue` on an
  // already-closed row succeeds silently (`db-tickets.ts`'s `UPDATE … RETURNING`).
  if (ticket.state === 'closed') {
    log(`#${ticket.number} is already closed`)
    return 0
  }
  await tickets.closeIssue(options.issue)
  log(`closed #${ticket.number}  ${ticket.title}`)
  return 0
}

/** The three fields a person can change through the form — never the number or the state, which the store owns. */
export interface TicketFormFields {
  title: string
  labels: readonly string[]
  body: string
}

export type ParsedTicketForm = { ok: true; form: TicketFormFields } | { ok: false; why: string }

/**
 * `renderTicketForm` and `parseTicketForm` must round-trip:
 * `parseTicketForm(renderTicketForm(t))` equals `{ ok: true, form: t }` for a
 * `t` whose title has no surrounding whitespace and does not start `#!`,
 * whose labels contain no comma, and whose body has no trailing whitespace
 * (`unit/ticket.test.ts` holds this). Breaking it means every `edit` rewrites
 * the ticket even when the person touched nothing.
 *
 * `instructions` are whole lines, each already carrying its own leading
 * `#!` — `renderTicketForm` does not add the marker, so a caller writes
 * `#! …` once rather than this function inventing the convention a second
 * time. `parseTicketForm` drops any header line starting `#!` wherever it
 * falls, which is how they survive being handed back unread.
 */
export function renderTicketForm(form: TicketFormFields, instructions: readonly string[] = []): string {
  const labelsLine = `labels: ${form.labels.join(', ')}`
  return [form.title, labelsLine, ...instructions, '', form.body].join('\n')
}

/**
 * The header is everything before the first blank line; the body is
 * everything after it, `trimEnd()`ed. `#!` lines are dropped from the header
 * wherever they fall — never recognised in the body, because the first blank
 * line has already ended the header by the time one could appear there.
 *
 * **Emptiness is not this function's refusal.** An empty title parses fine —
 * `form.title === ''` — because the caller compares the parsed form against
 * the ticket's unedited form to decide "no change" before it decides "no
 * title": folding the empty-title case in here would make that comparison
 * collapse two different saves (same blank title, different body) into one,
 * discarding whichever body the first comparison looked at. The one way this
 * returns `ok: false` is a header carrying a line that is neither the title,
 * the optional `labels:` line, nor dropped as an instruction — text that
 * belongs in the body but landed above the blank line instead.
 */
export function parseTicketForm(text: string): ParsedTicketForm {
  const lines = text.split('\n')
  // Searched from line 1, not line 0: line 0 is always the title, however it
  // reads, so a blank title must never be mistaken for the separator that
  // ends the header — that would hand the real `labels:` line to the body.
  const blankAt = lines.indexOf('', 1)
  const headerLines = blankAt === -1 ? lines : lines.slice(0, blankAt)
  const bodyLines = blankAt === -1 ? [] : lines.slice(blankAt + 1)

  const header = headerLines.filter((l) => !l.startsWith('#!'))
  const title = (header[0] ?? '').trim()
  const rest = header.slice(1)

  let labels: readonly string[] = []
  let afterLabels = rest
  if (rest[0]?.startsWith('labels:')) {
    labels = rest[0]
      .slice('labels:'.length)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    afterLabels = rest.slice(1)
  }
  if (afterLabels.length > 0) {
    return { ok: false, why: `a line in the header is neither the title nor labels: — ${JSON.stringify(afterLabels[0])}` }
  }

  return { ok: true, form: { title, labels, body: bodyLines.join('\n').trimEnd() } }
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i])
}

function formsEqual(a: TicketFormFields, b: TicketFormFields): boolean {
  return a.title === b.title && a.body === b.body && sameLabels(a.labels, b.labels)
}

/**
 * A ticket's own fields, normalised the same way a saved form is —
 * `parseTicketForm(renderTicketForm(…))`'s `trimEnd()` on the body — so that
 * comparing against what the editor hands back never reads a stored row's
 * trailing whitespace as a change nobody made.
 */
function formFromTicket(ticket: { title: string; labels: readonly { name: string }[]; body: string }): TicketFormFields {
  const raw: TicketFormFields = { title: ticket.title, labels: ticket.labels.map((l) => l.name), body: ticket.body }
  const parsed = parseTicketForm(renderTicketForm(raw))
  return parsed.ok ? parsed.form : raw
}

export interface TicketNewOptions {
  project?: string
}

export async function ticketNew(
  options: TicketNewOptions = {},
  log: (line: string) => void = console.log,
  reading: TicketReading = {},
): Promise<number> {
  const projects = reading.projects ?? loadProjects
  const recipeFor = reading.recipeFor ?? ((state: ProjectState) => currentRecipe(state))
  const ticketsFor = reading.ticketsFor ?? defaultTicketsFor
  const env = reading.env ?? process.env
  const edit = reading.edit ?? defaultEdit

  const command = editorCommand(env)
  if (!command) {
    log('no editor to open — set $VISUAL or $EDITOR')
    return 1
  }

  const project = await pickProject(options.project, projects, log)
  if (!project) return 1
  const name = project.project!

  const recipe = await resolveDbRecipe(project, recipeFor, log)
  if (!recipe) return 1

  const kinds = queueOf(recipe).kinds
  const empty: TicketFormFields = { title: '', labels: [], body: '' }
  const instructions = [`#! kinds: ${kinds.join(', ')} — one belongs in labels:, or the queue never sees this ticket`]
  const rendered = renderTicketForm(empty, instructions)

  let edited: EditedForm
  try {
    edited = await edit(command, rendered, `${name}-new`)
  } catch (err) {
    log((err as Error).message)
    return 1
  }

  const after = parseTicketForm(edited.text)
  if (!after.ok) {
    log(`${after.why} — your text is kept at ${edited.path}`)
    return 1
  }
  if (formsEqual(empty, after.form)) {
    await edited.discard()
    log('no change — nothing written')
    return 0
  }
  if (after.form.title === '') {
    log(`a ticket needs a title — your text is kept at ${edited.path}`)
    return 1
  }

  let created: Awaited<ReturnType<Tickets['createIssue']>>
  try {
    const tickets = await ticketsFor(name)
    created = await tickets.createIssue({ title: after.form.title, body: after.form.body, labels: after.form.labels })
  } catch (err) {
    log(`${(err as Error).message} — your text is kept at ${edited.path}`)
    return 1
  }
  await edited.discard()
  log(`created #${created.number}  ${created.title}`)
  if (kindOf(created, kinds) === null) {
    log(`#${created.number} carries no kind label — the queue will not take it`)
  }
  return 0
}

export interface TicketEditOptions {
  project?: string
  issue: number
}

export async function ticketEdit(
  options: TicketEditOptions,
  log: (line: string) => void = console.log,
  reading: TicketReading = {},
): Promise<number> {
  const projects = reading.projects ?? loadProjects
  const recipeFor = reading.recipeFor ?? ((state: ProjectState) => currentRecipe(state))
  const ticketsFor = reading.ticketsFor ?? defaultTicketsFor
  const env = reading.env ?? process.env
  const edit = reading.edit ?? defaultEdit

  const command = editorCommand(env)
  if (!command) {
    log('no editor to open — set $VISUAL or $EDITOR')
    return 1
  }

  const project = await pickProject(options.project, projects, log)
  if (!project) return 1
  const name = project.project!

  const recipe = await resolveDbRecipe(project, recipeFor, log)
  if (!recipe) return 1

  const tickets = await ticketsFor(name)
  let ticket: Awaited<ReturnType<Tickets['getIssue']>>
  try {
    ticket = await tickets.getIssue(options.issue)
  } catch (err) {
    log((err as Error).message)
    return 1
  }

  const original = formFromTicket(ticket)
  const rendered = renderTicketForm(original)

  let edited: EditedForm
  try {
    edited = await edit(command, rendered, `${name}-${ticket.number}`)
  } catch (err) {
    log((err as Error).message)
    return 1
  }

  const after = parseTicketForm(edited.text)
  if (!after.ok) {
    log(`${after.why} — your text is kept at ${edited.path}`)
    return 1
  }
  if (formsEqual(original, after.form)) {
    await edited.discard()
    log('no change — nothing written')
    return 0
  }
  if (after.form.title === '') {
    log(`a ticket needs a title — your text is kept at ${edited.path}`)
    return 1
  }

  // The row this form was opened against may have moved while the editor had
  // it open — a second `edit` on the same ticket, saved first. Re-reading it
  // right before writing, rather than trusting `original`, is what stops that
  // save from landing on top of this one unnoticed.
  let current: Awaited<ReturnType<Tickets['getIssue']>>
  try {
    current = await tickets.getIssue(options.issue)
  } catch (err) {
    log(`${(err as Error).message} — your text is kept at ${edited.path}`)
    return 1
  }
  if (!formsEqual(original, formFromTicket(current))) {
    log(`#${ticket.number} changed since this form was opened — your text is kept at ${edited.path}`)
    return 1
  }

  const changed: string[] = []
  try {
    if (after.form.title !== original.title) {
      await tickets.updateTitle(options.issue, after.form.title)
      changed.push('title')
    }
    if (!sameLabels(original.labels, after.form.labels)) {
      await tickets.setLabels(options.issue, after.form.labels)
      changed.push('labels')
    }
    if (after.form.body !== original.body) {
      await tickets.updateBody(options.issue, after.form.body)
      changed.push('body')
    }
  } catch (err) {
    const landed = changed.length > 0 ? ` (${changed.join(', ')} already written)` : ''
    log(`${(err as Error).message}${landed} — your text is kept at ${edited.path}`)
    return 1
  }
  await edited.discard()
  log(`updated #${ticket.number} — ${changed.join(', ')}`)
  return 0
}
