/**
 * `lingtai status` — what is runnable, and what is not.
 *
 * The old loop's equivalent was `pick_ticket`, a GitHub issue search re-run every
 * hour whose result nobody could see. The important half of this command is
 * therefore not the queue but the **absences**: an issue that is not being
 * worked has a reason, and until now the reason was never written down anywhere.
 */
import {
  backingOff,
  filterFacts,
  heldUntil,
  loadProjects,
  passedOver,
  projectFilter,
  runnableNow,
  selectRunnable,
  type ClientFor,
  type RecipeFor,
} from '@lingtai/conductor'
import { agentBranchOf, waitWords } from '@lingtai/domain'
import { paint, stateInk } from '@lingtai/env/colour'
import { describeArm, describeWaitLines, describeWait, readTasks, type TaskCard } from '@lingtai/projector'
import { queueOf, ticketSourceOf, type TicketSource } from '@lingtai/recipe/settings'

import { heading, keyValues, section, symbol, table } from './output.ts'

export interface StatusOptions {
  /** Restrict to one project. */
  project?: string
  /** Show items that have left the queue, and what holds them. */
  all?: boolean
}

/**
 * One line of it, at a width a listing survives.
 *
 * A question can be a paragraph and a git message has newlines in it, and this
 * is a table — the whole value is on the card and in the log, which is where a
 * reader who needs all of it goes.
 */
function oneLine(text: string, n = 140): string {
  const said = text.replace(/\s+/g, ' ').trim()
  return said.length > n ? `${said.slice(0, n - 1)}…` : said
}

/**
 * `ticketSourceOf`'s two values, in the words a person reads rather than the
 * schema's own (`#389`). A `db` project's queue lives in `dbTickets` —
 * `recipe.ts`'s own phrase is *"the `tickets` table on whichever store this
 * machine chose"* — never GitHub, so the two lines below must not say GitHub
 * about it.
 */
function sourceName(source: TicketSource): string {
  return source === 'db' ? 'the ticket table' : 'GitHub'
}

/** The eligible-count line, named after wherever this project's tickets live. */
export function offerLine(source: string, count: number, passed: string | null): string {
  return `  from ${source}: ${count} eligible` + (passed !== null ? `, ${passed}` : '')
}

/** The failure line, naming the same system the line above would have. */
export function offerFailedLine(source: string, err: Error): string {
  return `  (${source} unavailable: ${err.message} — the queue cannot be listed)`
}

/**
 * The arm line, in `describeArm`'s own words (#100, #504) — pulled out so a
 * unit test can render it beside the board's `toCard` without going through
 * `status()`, which `unit/status.test.ts` says is unreachable from here.
 */
export function armLine(row: { restarts?: number }, restartsOf: number | null): string | null {
  return describeArm({ restarts: row.restarts ?? 0 }, restartsOf)
}

/**
 * How a project's client and recipe are found — defaulted, and injectable.
 *
 * The seam exists for one promise. The onboarding wizard's last screen tells an
 * operator what the next pass will take (#165), and the only thing that makes
 * that true an hour later is that both screens call `selectRunnable` and
 * `passedOver`. A test can only hold that by running *this* command against the
 * same GitHub the preview was given and comparing the two outputs, and
 * `projectFilter` already takes both as arguments for exactly this reason.
 */
export interface StatusReading {
  clientFor?: ClientFor
  recipeFor?: RecipeFor
}

/** What a person is being waited on for, in the words the card and the board use (#147). */
export interface StatusWait {
  /** `WaitReason`'s `_tag`. */
  reason: string
  /** `waitWords`' sentence: the question itself for an `OwnQuestion`. */
  line: string
  needs: 'judgement' | 'acknowledgement'
  /** `describeWait`'s phrase, where the wait is one a person can tell apart at a glance. */
  words: 'waiting for your answer' | 'waiting for your review' | null
  /** `describeWaitLines`' lines — what was diagnosed about it. */
  detail: string[]
  /** There is raw failure output, kept on the log and the card rather than printed. */
  raw: boolean
}

export interface StatusRow {
  taskId: string
  ref: string
  kind: string
  title: string
  /** The projection's own state value — `verifying` stays `verifying`. */
  state: string
  restarts: number
  /** `describeArm`'s sentence, or null. */
  arm: string | null
  /** `backingOff`'s sentence while the retry window holds it. */
  held: string | null
  /** Queued, but the ticket source is not offering it — closed by hand, relabelled, excluded. */
  unoffered: boolean
  wait: StatusWait | null
}

/** `ProjectFilter` reduced to what a reader needs, so a report can be built by hand in a test. */
export type StatusFilter =
  | {
      ok: true
      /** `describeFilter`'s words, as key/value pairs (`filterFacts`). */
      facts: (readonly [string, string])[]
      recipe: string
      ref: string
      kinds: string[]
      exclude: string[]
    }
  | { ok: false; facts: (readonly [string, string])[]; problem: string }

export interface ProjectStatus {
  project: string
  base: string | null
  filter: StatusFilter
  /** `GitHub` or `the ticket table`. Null when the recipe would not resolve. */
  source: string | null
  /** How many the recipe's `kinds` and `exclude` will take. Null when the source was not asked. */
  eligible: number | null
  offerError: string | null
  passedOver: { ref: number; reason: string }[]
  /** `passedOver`'s one sentence, or null. */
  passedOverLine: string | null
  /** `discover.ts`'s sentence when GitHub sent no dependency summary, else null. */
  dependenciesUnread: string | null
  /** What could start next, in `selectRunnable`'s order. */
  runnable: StatusRow[]
  /** Every row the log has for this project. */
  known: StatusRow[]
}

export interface StatusReport {
  projects: ProjectStatus[]
  /** The one-line answer when there is nothing to report on. */
  message: string | null
}

/** `verifying` folds into `running`: from an operator's seat they are the same fact. */
const NAMES: Record<string, string> = {
  running: 'running',
  verifying: 'running',
  approved: 'approved, not yet taken up',
  waiting: 'waiting on you',
  landed: 'landed',
}

/**
 * Everything `status` knows, and nothing printed. The reads are the same ones in
 * the same order the command always made; the words are computed here so that
 * `renderStatus` and `statusJson` are pure.
 */
export async function readStatus(options: StatusOptions = {}, reading: StatusReading = {}): Promise<StatusReport> {
  const projects = (await loadProjects()).filter((p) => !options.project || p.project === options.project)
  if (projects.length === 0) {
    return {
      projects: [],
      message: options.project
        ? `no project named "${options.project}" — run lingtai add <owner>/<repo> first`
        : 'no projects registered — run lingtai add <owner>/<repo>',
    }
  }

  const out: ProjectStatus[] = []
  for (const project of projects) {
    const name = project.project!
    // Said before the numbers that depend on it, by the facts of the function
    // `lingtai daemon` prints at startup, so the two cannot disagree (#76).
    const filter = await projectFilter(project, reading.clientFor, reading.recipeFor)
    const view: StatusFilter = filter.ok
      ? {
          ok: true,
          facts: [...filterFacts(filter)],
          recipe: filter.configHash,
          ref: filter.ref,
          kinds: [...filter.kinds],
          exclude: [...filter.exclude],
        }
      : { ok: false, facts: [...filterFacts(filter)], problem: filter.problem }

    // Priority order is the recipe's `kinds`, and the recipe lives in the
    // managed repository — so without GitHub the queue can still be listed, just
    // not prioritised.
    const kinds: readonly string[] = filter.ok ? filter.kinds : []
    // Empty when the ticket source could not be asked, which is not the same as
    // an empty queue and is said differently.
    let offered: { ref: string; title: string; kind: string }[] = []
    let asked = false
    let source: string | null = null
    let eligible: number | null = null
    let offerError: string | null = null
    let skipped: { ref: number; reason: string }[] = []
    let passed: string | null = null
    let unread: string | null = null
    if (filter.ok) {
      // After where this project's tickets actually live (#389).
      source = sourceName(ticketSourceOf(filter.recipe))
      try {
        const { tickets, recipe } = filter
        // Always, never behind a flag; takes nothing, claims nothing, appends no
        // event. **`tickets`, not `client`** (#382): a `db` project's queue lives
        // in `dbTickets`, same as `board.ts` and `queued.ts`.
        const found = await runnableNow({ client: tickets, queue: queueOf(recipe) })
        offered = found.runnable
        asked = true
        // **`eligible`, not `runnable`** (#54): this is about the recipe, the queue line about state.
        eligible = found.runnable.length
        skipped = found.skipped.map((s) => ({ ref: s.ref, reason: s.reason }))
        passed = passedOver(found.skipped)
        unread = found.dependenciesUnread
      } catch (err) {
        offerError = (err as Error).message
      }
    }

    // Zero when the recipe would not resolve: nothing was offered either.
    const backoffMs = filter.ok ? filter.backoffMs : 0
    // The ceiling `describeArm` says `of` against — `limits.restarts`, null where the recipe would not resolve (#504).
    const restartsOf = filter.ok ? filter.limits.restarts : null
    const runnable = await selectRunnable({ project: name, offered, kinds, backoffMs })
    const tasks = await readTasks({ project: name })
    // **The arm comes from the row, because the offer cannot carry it** (#100):
    // a restarted ticket is queued, so it is listed from here and nowhere else.
    const restartsByTask = new Map(tasks.map((t) => [t.taskId, t.restarts ?? 0]))
    const now = Date.now()

    const rowOf = (
      t: {
        taskId: string
        issue: string
        kind: string
        title: string
        state: string
        lastAttemptAt?: Date | null
        repairPending?: boolean
        wait?: TaskCard['wait']
        awaitingSha?: string | null
      },
      restarts: number,
    ): StatusRow => {
      // **When, not whether** (#95): the sentence is `backingOff`'s, so the card says it in the same words (#100).
      const until =
        t.state === 'queued'
          ? heldUntil(
              { lastAttemptAt: t.lastAttemptAt ?? null, repairPending: t.repairPending === true },
              backoffMs,
              now,
            )
          : null
      const words =
        t.wait == null ? null : waitWords(t.wait.reason, { branch: agentBranchOf(t.issue), base: '', findings: [] })
      return {
        taskId: t.taskId,
        ref: t.issue,
        kind: t.kind,
        title: t.title,
        state: t.state,
        restarts,
        arm: armLine({ restarts }, restartsOf),
        held: until ? backingOff(until, now) : null,
        // Said only when the source actually answered: with no answer every row looks unoffered.
        unoffered: t.state === 'queued' && asked && !runnable.some((r) => r.taskId === t.taskId),
        wait:
          t.wait == null || words === null
            ? null
            : {
                reason: t.wait.reason._tag,
                line: words.line,
                needs: words.needs,
                words: describeWait({
                  waiting: true,
                  asked: t.wait.reason._tag === 'OwnQuestion',
                  awaitingSha: t.awaitingSha ?? null,
                  needs: words.needs,
                }),
                detail: describeWaitLines(words).map((l) => l.text),
                raw: Boolean(words.diagnosis?.raw),
              },
      }
    }

    out.push({
      project: name,
      base: project.base ?? null,
      filter: view,
      source,
      eligible,
      offerError,
      passedOver: skipped,
      passedOverLine: passed,
      dependenciesUnread: unread,
      runnable: runnable.map((r) => rowOf({ ...r, state: 'queued' }, restartsByTask.get(r.taskId) ?? 0)),
      known: tasks.map((t) => rowOf(t, t.restarts ?? 0)),
    })
  }
  return { projects: out, message: null }
}

/** The state column: the wait's words, the clock, the absence — and the arm, muted. */
function stateCell(row: StatusRow): string {
  const parts: string[] = []
  if (row.state !== 'queued') {
    const said = row.wait?.words ?? row.state
    // Amber is ● and nothing else (0121 §2): a wait is amber on its own line below.
    parts.push(row.wait ? `[${said}]` : stateInk(row.state)(`[${said}]`))
  } else if (row.held) parts.push(paint.muted(`[${row.held}]`))
  else if (row.unoffered) parts.push(paint.muted('[not offered]'))
  if (row.arm) parts.push(paint.muted(row.arm))
  return parts.join('  ')
}

/**
 * 0121's layout: the project block, the queue and the people being waited on,
 * as separate sections. `columns` is the terminal's width, `undefined` when
 * redirected, which is never truncated.
 */
export function renderStatus(
  report: StatusReport,
  options: { all?: boolean; columns?: number | undefined } = {},
): string[] {
  if (report.message !== null) return [report.message]
  const blocks: string[] = []
  for (const p of report.projects) {
    const lines: string[] = [heading(p.project), '']
    lines.push(
      section(
        'Project',
        keyValues([['base', p.base ?? '(unrecorded)'], ...p.filter.facts.map(([k, v]) => [k, v] as const)]),
      ),
    )

    // `verifying` folds into `running`. A row with a wait is in the Waiting section, not counted twice (#147).
    const elsewhere = new Map<string, number>()
    for (const t of p.known) {
      if (t.state === 'queued' || t.wait !== null) continue
      const label = NAMES[t.state] ?? t.state
      elsewhere.set(label, (elsewhere.get(label) ?? 0) + 1)
    }
    const elsewhereSays = [...elsewhere].map(([label, n]) => `${n} ${label}`).join(', ')

    const queue: string[] = []
    if (p.source !== null) {
      if (p.offerError !== null) queue.push(offerFailedLine(p.source, new Error(p.offerError)).trim())
      else if (p.eligible !== null) queue.push(offerLine(p.source, p.eligible, p.passedOverLine).trim())
    }
    if (p.dependenciesUnread !== null) queue.push(`(${p.dependenciesUnread})`)
    // `--all` widens the listing to everything the project has a row for.
    const ids = new Set(p.known.map((t) => t.taskId))
    const rows = options.all ? [...p.known, ...p.runnable.filter((r) => !ids.has(r.taskId))] : p.runnable
    if (rows.length > 0) {
      queue.push(
        ...table(
          ['ID', 'KIND', 'TITLE', 'STATE'],
          rows.map((r) => [`#${r.ref}`, r.kind, r.title, stateCell(r)]),
          { columns: options.columns },
        ),
      )
    }
    lines.push('', section(`Queue  ${p.runnable.length} runnable${elsewhereSays ? ` — ${elsewhereSays}` : ''}`, queue))

    // Every wait, every time: the reason is a question only a person can answer.
    const waiting = p.known.filter((t) => t.wait !== null)
    if (waiting.length > 0) {
      const lines2: string[] = []
      for (const t of waiting) {
        const w = t.wait!
        lines2.push(
          `${symbol.signal()} #${t.ref}  ${t.kind}  ${t.title} — ${w.words ? `${w.words}: ` : ''}${oneLine(w.line)}`,
        )
        if (options.all) {
          for (const d of w.detail) lines2.push(`    ${oneLine(d)}`)
          // The raw failure is not printed and is not lost: it is on the log and the card.
          if (w.raw) lines2.push('    (the failure itself is on the log, and on the card)')
        }
      }
      lines.push('', section('Waiting on you', lines2))
      for (const t of waiting) {
        if (t.wait!.reason === 'OwnQuestion')
          lines.push(`next: lingtai answer ${p.project} --issue ${t.ref} "<choice>"`)
      }
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n').split('\n')
}

const rowJson = (r: StatusRow): Record<string, unknown> => ({
  taskId: r.taskId,
  ref: r.ref,
  kind: r.kind,
  title: r.title,
})

/** The body `--json` wraps in `{ version, command }` (0121 §5). */
export function statusJson(report: StatusReport): Record<string, unknown> {
  return {
    projects: report.projects.map((p) => {
      const byState: Record<string, unknown[]> = {}
      for (const t of p.known) (byState[t.state] ??= []).push(rowJson(t))
      return {
        project: p.project,
        base: p.base,
        filter: p.filter.ok
          ? { ok: true, recipe: p.filter.recipe, ref: p.filter.ref, kinds: p.filter.kinds, exclude: p.filter.exclude }
          : { ok: false, problem: p.filter.problem },
        source: p.source,
        eligible: p.eligible,
        offerError: p.offerError,
        passedOver: p.passedOver,
        dependenciesUnread: p.dependenciesUnread,
        runnable: p.runnable.map((r) => ({
          ...rowJson(r),
          restarts: r.restarts,
          held: r.held,
          arm: r.arm,
        })),
        byState,
        waiting: p.known
          .filter((t) => t.wait !== null)
          .map((t) => ({
            taskId: t.taskId,
            ref: t.ref,
            reason: t.wait!.reason,
            line: t.wait!.line,
            needs: t.wait!.needs,
            asked: t.wait!.reason === 'OwnQuestion',
          })),
      }
    }),
  }
}

/** Reads and prints the text form — what the tests that drive the command with a `log` use. */
export async function status(
  options: StatusOptions = {},
  log = console.log,
  reading: StatusReading = {},
): Promise<number> {
  const report = await readStatus(options, reading)
  for (const line of renderStatus(report, { all: options.all, columns: process.stdout.columns })) log(line)
  return 0
}
