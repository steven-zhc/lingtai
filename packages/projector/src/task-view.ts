/**
 * `task_view` — the one projection.
 *
 * It replaces `board` and `queue`. One row per task Lingtai
 * has touched, holding the latest state and the metadata a card shows, and
 * nothing else: the board's list view is a `select` against this table and no
 * second query ([0012](../../../doc/decisions-archive/0012-one-task-view.md)).
 *
 * ## What is deliberately not here
 *
 * **Gate evidence, review findings, the diff.** All of
 * it is read from the event stream when somebody opens one task. A list view
 * and a detail view have opposite economics — the list is read constantly and
 * needs to be cheap, the detail is read rarely by one person about one task,
 * and folding a few dozen events on the spot is imperceptible. Building a table
 * for the second is paying continuously for an occasional read.
 *
 * The old `board` projection carried all of it, and the card grew heavy for
 * exactly that reason: what is available gets rendered. Moving detail behind a
 * task id makes a card's contents a decision instead of a consequence.
 *
 * ## Two rules that keep a rebuild honest
 *
 * **Every timestamp comes from `event.at`, never from `now()`.** A projection
 * whose rows depend on the clock cannot be rebuilt to the same table twice,
 * which would cost the property that lets a projection's shape change freely at
 * all. That property is load-bearing here, because this table's shape is
 * expected to move.
 *
 * **Retention is the reader's job.** `closed_at` is recorded and every row is
 * kept; `readTasks` filters. The two-day window is a `where` clause, so it is
 * configurable without a rebuild and a rebuild does not depend on when it ran.
 *
 * ## Counting
 *
 * Increments are guarded by `updated_seq <` rather than `<=`, so a replay lands
 * on the same numbers. Gate verdicts are a keyed map rather than a list, for
 * the same reason: assignment is idempotent and appending is not. Only the
 * verdict is kept — the evidence that came with it is detail.
 *
 * That key includes the run (#78). Keying it `point:action` alone bought
 * replay-safety and quietly gave up scope: a second attempt overwrote the same
 * cells, and in the window between a release and the next attempt reaching the
 * same point the card asserted a verdict no live run held. `ticket-lingtai-59` read
 * `1 passed · attempt 2` while attempt 1's only gate belonged to a run an
 * operator had killed hours earlier. Keying by run keeps both properties:
 * assignment is still idempotent, and `readTasks` shows only the run the card
 * names.
 */
import type { BlockDiagnosis, LabelState, PayloadOf } from '@lingtai/domain'
import type { Envelope, RunState, TicketLifecycle, TicketState } from '@lingtai/domain'
import {
  agentBranchOf,
  applyRun,
  applyTicket,
  decodeRun,
  decodeTicket,
  emptyRun,
  emptyTicket,
  encodeRun,
  encodeTicket,
  isPassStream,
  isTicketStream,
  parseTicketStream,
  waitWords,
  WaitId,
} from '@lingtai/domain'
import { WaitReason, type TriageFacts } from '@lingtai/domain/wait'

import { withProjectionStore } from './choose.ts'
import type { Projection, ProjectionContext } from './store.ts'

/**
 * Where a task is.
 *
 * Every one of these now comes from a fold — `queued` used to be written
 * straight into the table by `syncQueued`, with no event behind it, which is
 * why a queue change reached nobody (#56). A task is `queued` because the log
 * says it was released or unblocked, or because it has no row at all and
 * GitHub is offering it.
 */
export type TaskState = LabelState

export const TASK_VIEW_TABLE = 'task_view'

/** How long a landed task stays on the board. A query, not a rebuild. */
export const DEFAULT_RETENTION_DAYS = 2

export const taskViewProjection: Projection = {
  name: 'task_view',

  async create(ctx) {
    await ctx.query(`
      create table if not exists task_view (
        task_id      text primary key,
        project      text not null,
        issue        text not null,
        -- Null means not known yet. The reader renders the fallback, so a
        -- claim that carries no title cannot overwrite one that GitHub gave.
        title        text,
        kind         text,
        state        text not null,
        tier         text not null default 'guarded',

        run_id       text,
        turns        int,

        base_sha     text,
        head_sha     text,
        files        int,
        insertions   int,
        deletions    int,

        -- { "pass-abc:proposed:build": "passed" }. A map, so replaying is
        -- assignment rather than appending; keyed by the run that produced the
        -- verdict, so an attempt that is over cannot lend its verdicts to the
        -- next one. Evidence is not here on purpose.
        --
        -- Named for what it holds rather than for what wrote it (#249). The
        -- keys are runId:step and the values are verdicts, so 0058 moving
        -- which steps record one costs this column nothing.
        --
        -- A table built before #249 has the old column and not this one, and
        -- create table if not exists does not add it. The drift check in
        -- shape.ts names both halves and says the remedy: rebuild task_view.
        -- Until that runs, the write below is to a column that is not there,
        -- and so is the read: columnOf in store.ts is what makes the board say
        -- the same sentence rather than count four zeros, because a daemon on
        -- the old code keeps the checkpoint at head and leaves the shape check
        -- nothing to fire on.
        verdicts     jsonb not null default '{}'::jsonb,

        -- One line for the card: what it is waiting on, or why it stopped.
        note         text,

        -- The sha the open question is about, and null when nothing is being
        -- asked. Written from a signoff action's onSha, which is the value
        -- approve() compares a caller's onSha against.
        --
        -- Not head_sha. That one is what the last run *produced*, and it is a
        -- different fact: the two agree right up until a branch is repaired and
        -- approval re-requested on a new head, and then the board sent the
        -- produced sha, approve() refused it as stale, and the same approval
        -- through the CLI — which sends no sha at all — landed. Two answers to
        -- one question (#92).
        --
        -- Whether a person is being asked something is read off this rather
        -- than kept beside it: a card cannot then offer Approve without the sha
        -- Approve needs. That is the "waiting, and there is a head sha"
        -- inference #84 replaced, and this is what it should have been replaced
        -- with.
        awaiting_sha text,

        -- The current wait, read back as TaskCard.wait (#440).
        wait_id      text,
        wait_reason  jsonb,
        triage_attempt int,
        triage_started_at timestamptz,
        triage_result jsonb,
        triage_head_sha text,

        -- { question, answer, by } — the last block a person answered, and
        -- what with. WaitResolved.note, which no column held before #147:
        -- a rebuild could say what was asked and never what was decided.
        -- Assignment, not a list, so a replay lands on the same value; the
        -- whole history is the fold's (TicketState.answers). Kept across a
        -- claim and a landing, because a decision outlives the attempt at it.
        answer       jsonb,

        -- [{ key, number }] — the children a split wrote, from TicketSplit,
        -- and nothing of the plan (that stays WaitResolved{Split}'s). Its own
        -- column and not note, which the next release or resolution
        -- overwrites. Assignment, so a replay lands on the same value; a
        -- second TicketSplit replaces it and no other event clears it.
        split        jsonb,

        -- A repair bought and not yet claimed, and which run was one. Written
        -- only by the retired RepairRequested (#143), so nothing sets either on
        -- a new ticket — and both stay, because a log that holds the event is
        -- replayed by every rebuild. Without them an item released for a repair
        -- just before a deploy loses the backoff exemption its repair was
        -- bought with.
        repair_pending boolean not null default false,
        repair_run_id  text,

        -- Retention and ordering. From the event's own clock, never now().
        updated_at   timestamptz not null,
        closed_at    timestamptz,

        -- The backoff #43 needs. In the table rather than in memory, because an
        -- in-memory set forgets on restart and the loop it prevents costs money:
        -- the old harness re-ran two tickets five times for roughly $29.
        attempts        int not null default 0,
        last_attempt_at timestamptz,

        -- Which arm this item is on, and the ceiling it is counted against
        -- (0040 §3). The attempts column counts claims and says nothing about
        -- why one happened; a claim after a crash, after a backoff and after an
        -- approach was abandoned all read as "attempt 3". These two say
        -- "restart 1 of 2", which is a different sentence and the one a person
        -- acts on differently.
        --
        -- Assignment and not an increment, which is why there is no updated_seq
        -- subtlety here: TicketReleased{cause: Restart} carries its own ordinal, so a replay
        -- lands on the same number. attempts has to increment because a claim
        -- carries none.
        --
        -- Zero means no restart has been bought, which is every row today.
        restarts     int not null default 0,
        restarts_of  int not null default 0,

        updated_seq  bigint not null,

        -- The ticket reduce (applyTicket), stored as encodeTicket writes it.
        -- Every one-stream column above is read off it (#834). No default: a
        -- table built before this is refused by the shape check until rebuilt.
        ticket       jsonb not null
      )`)
    await ctx.query('create index if not exists task_view_state_idx on task_view (project, state)')
    await ctx.query('create index if not exists task_view_closed_idx on task_view (closed_at)')

    // Which run belongs to which task. Run events arrive on their own stream and
    // name the task only at TicketClaimed or RunStarted.
    await ctx.query(`
      create table if not exists task_view_run (
        run_id  text primary key,
        task_id text,
        -- The run reduce (applyRun) as encodeRun writes it (#844).
        run     jsonb not null
      )`)

    // A ticket's reduce while it has no task_view row (#834): a prompt edit on
    // an untouched issue is not a card. The event that makes the row moves the
    // state into it and deletes this one.
    await ctx.query(`
      create table if not exists task_view_ticket (
        task_id    text primary key,
        ticket     jsonb not null
      )`)
  },

  async reset(ctx) {
    // Dropped, not truncated. This table's shape is expected to change, and
    // `create table if not exists` would silently keep the old columns.
    await ctx.query('drop table if exists task_view')
    await ctx.query('drop table if exists task_view_run')
    await ctx.query('drop table if exists task_view_ticket')
  },

  async apply(events, ctx) {
    // One cache per call (#844): every read goes through it, every touched row is written once at the end.
    const cache = new Cache(ctx)
    for (const event of events) {
      if (isTicketStream(event.streamId)) await applyTicketEvent(cache, event)
      else if (isPassStream(event.streamId)) await applyRunEvent(cache, event)
    }
    await cache.flush()
  },
}

// ----------------------------------------------------------------- write ----

/**
 * `ticket-nextloom-ai-admin-155` → project `nextloom-ai-admin`, issue `155`.
 *
 * Safe to parse because the same code writes it (`ticket-${project}-${ref}`), and
 * splitting at the *last* hyphen is what makes a project name containing
 * hyphens survive — which every one of them does.
 */
function splitTaskId(taskId: string): { project: string; issue: string } {
  // A projection must fold anything the log holds, including an id it cannot
  // parse — hence the fallback rather than a null the caller has to handle.
  return parseTicketStream(taskId) ?? { project: taskId.replace(/^wi-/, ''), issue: '' }
}

/**
 * Where a ticket is, as the board's column and the queue's input say it (#834).
 * The only place a `TicketLifecycle` becomes a `TaskState`.
 */
export function taskStateOf(l: TicketLifecycle): TaskState {
  switch (l.status) {
    case 'backlog':
      return 'queued'
    case 'claimed':
      return 'running'
    case 'blocked':
      return 'waiting'
    case 'approved':
      return 'approved'
    case 'landed':
      return 'landed'
    case 'closed':
      return 'closed'
  }
}

/** The one-stream columns, read off a ticket's reduce. JSON columns are already text. */
interface Derived {
  project: string
  issue: string
  title: string | null
  kind: string | null
  state: TaskState
  wait_id: string | null
  wait_reason: string | null
  triage_attempt: number | null
  triage_started_at: Date | null
  triage_result: string | null
  triage_head_sha: string | null
  answer: string | null
  split: string | null
  closed_at: Date | null
  attempts: number
  last_attempt_at: Date | null
  restarts: number
}

function derive(taskId: string, t: TicketState): Derived {
  const l = t.lifecycle
  const fallback = t.project === null || t.externalRef === null ? splitTaskId(taskId) : null
  // The current wait's entry: the last one carrying the wait the lifecycle names (t22, #842).
  const wait = l.status === 'blocked' ? t.waits.filter((w) => w.waitId === l.waitId).at(-1) : undefined
  const answer = t.answers.at(-1)
  return {
    project: t.project ?? fallback!.project,
    issue: t.externalRef ?? fallback!.issue,
    title: t.title,
    kind: t.kind,
    state: taskStateOf(l),
    wait_id: l.status === 'blocked' ? l.waitId : null,
    wait_reason: l.status === 'blocked' ? JSON.stringify(l.reason) : null,
    triage_attempt: wait?.triage.started?.attempt ?? null,
    triage_started_at: wait?.triage.started?.at ?? null,
    triage_result: wait?.triage.result == null ? null : JSON.stringify(wait.triage.result),
    triage_head_sha: wait?.triage.headSha ?? null,
    answer:
      answer === undefined ? null : JSON.stringify({ question: answer.question, answer: answer.answer, by: answer.by }),
    split: t.split === null ? null : JSON.stringify(t.split.children.map((c) => ({ key: c.key, number: c.number }))),
    closed_at: l.status === 'landed' || l.status === 'closed' ? t.since : null,
    attempts: t.claims.length,
    last_attempt_at: t.lastAttemptAt,
    restarts: t.restarts.at(-1)?.restart ?? 0,
  }
}

/** The events that make a `task_view` row; every other ticket-stream event reduces into the state alone. */
const MAKES_THE_ROW: ReadonlySet<string> = new Set([
  'TicketClaimed',
  'TicketContinued',
  'TicketDiscovered',
  'DispatchRefused',
  'WaitStarted',
])

/** A note a transition writes. `{ value: null }` clears the card's line; `null` is no transition. */
export type Note = { value: string | null } | null

/**
 * The card's line for what a ticket event did, read off the state before and after its reduce (#845): the
 * last transition wins, as the last writer did. The first rule that matches answers.
 */
export function ticketNoteOf(before: TicketState, after: TicketState): Note {
  // A claim's ending becoming a release gives its reason, whatever the lifecycle did: a person's Requeue is
  // `WaitResolved` (blocked → backlog) and then a release on the backlog it already left.
  for (let i = 0; i < after.claims.length; i++) {
    const ended = after.claims[i]!.ended
    if (ended?.kind !== 'released') continue
    if (JSON.stringify(before.claims[i]?.ended ?? null) !== JSON.stringify(ended)) return { value: ended.reason }
  }
  if (JSON.stringify(before.lifecycle) !== JSON.stringify(after.lifecycle)) {
    const l = after.lifecycle
    switch (l.status) {
      case 'blocked':
        return {
          value: waitWords(l.reason, {
            branch: after.externalRef === null ? '' : agentBranchOf(after.externalRef),
            base: '',
            findings: [],
          }).line,
        }
      case 'closed':
        return { value: l.reason }
      case 'landed':
        return { value: l.mergeCommit }
      case 'approved':
        return {
          value:
            l.grantRef === undefined
              ? 'approved — continues once a conductor is free'
              : 'fix round granted — continues once a conductor is free',
        }
      case 'claimed':
      case 'backlog':
        return { value: null }
    }
  }
  if (after.dispatchRefusals.length > before.dispatchRefusals.length && after.lifecycle.status !== 'blocked') {
    const d = after.dispatchRefusals.at(-1)!
    return { value: `needs ${d.requiredTier}; ${d.runtime} is missing ${d.missing.join(', ')}` }
  }
  return null
}

/** The run's columns, a pure function of the ticket's reduce and the latest run's (#844). */
export interface RunColumns {
  state: TaskState
  run_id: string | null
  base_sha: string | null
  head_sha: string | null
  files: number | null
  insertions: number | null
  deletions: number | null
  turns: number | null
  verdicts: string
  awaiting_sha: string | null
}

/**
 * The row's run columns. `run` is the state of `ticket.runs.at(-1)`, or null when none is stored yet.
 *
 * `state` is the ticket's, except `verifying`: a claimed ticket whose run proposed completion and has opened
 * no fix round since (`RunProposedCompletion` is appended by the first dispatch only, and `RoundOpened`
 * puts the pass back to `running` for good).
 */
export function rowOf(ticket: TicketState, run: RunState | null): RunColumns {
  const runId = ticket.runs.at(-1) ?? null
  const l = ticket.lifecycle
  const verifying =
    run !== null &&
    l.status === 'claimed' &&
    l.runId === runId &&
    run.lifecycle.status === 'gating' &&
    run.roundsOpened.length === 0
  // The run a release ended is not the card's any more: that is what scopes the verdict pills (#78).
  const released = ticket.claims.findLast((c) => c.runId === runId)?.ended?.kind === 'released'
  const verdicts: Record<string, string> = {}
  if (run !== null && runId !== null)
    for (const [key, s] of Object.entries(run.steps)) verdicts[`${runId}:${key}`] = s.verdict
  // An approval is offered only while a signoff is asked on this attempt: the request must be newer than
  // the last claim or continuation (#829), or a continued run refused at the lane would offer a spent sha.
  const asks =
    run !== null &&
    run.lifecycle.status === 'awaiting-approval' &&
    l.status === 'blocked' &&
    l.runId === runId &&
    run.askedAt !== null &&
    (ticket.lastAttemptAt === null || run.askedAt.getTime() >= ticket.lastAttemptAt.getTime())
  return {
    state: verifying ? 'verifying' : taskStateOf(l),
    run_id: released ? null : runId,
    base_sha: run?.baseSha ?? null,
    head_sha: run?.headSha ?? null,
    files: run?.produced?.files ?? null,
    insertions: run?.produced?.insertions ?? null,
    deletions: run?.produced?.deletions ?? null,
    turns: run?.receipt?.turns ?? null,
    verdicts: JSON.stringify(verdicts),
    awaiting_sha: asks && run.lifecycle.status === 'awaiting-approval' ? run.lifecycle.onSha : null,
  }
}

type Columns = Derived & RunColumns

interface TaskEntry {
  /** `row`: in `task_view`. `staged`: in `task_view_ticket`. `none`: neither yet. */
  where: 'row' | 'staged' | 'none'
  ticket: TicketState
  note: string | null
  updatedAt: Date
  updatedSeq: bigint
  /** Moved off `staged` by this call: the staging row is deleted at the flush. */
  wasStaged: boolean
  dirty: boolean
}

interface RunEntry {
  taskId: string | null
  run: RunState
  dirty: boolean
}

/**
 * Every stored state one `apply` call touches (#844). Both reduces live here, so a ticket event
 * mid-batch computes `rowOf` from the run's current state and not from a stale row.
 */
class Cache {
  readonly tasks = new Map<string, TaskEntry>()
  readonly runs = new Map<string, RunEntry>()
  private readonly missing = new Set<string>()

  private readonly ctx: ProjectionContext

  // Not a parameter property: Node's strip-only TypeScript loader refuses that syntax.
  constructor(ctx: ProjectionContext) {
    this.ctx = ctx
  }

  async task(taskId: string): Promise<TaskEntry> {
    const hit = this.tasks.get(taskId)
    if (hit) return hit
    const [row] = await this.ctx.query<Record<string, unknown>>(
      'select ticket, note, updated_at, updated_seq from task_view where task_id = $1',
      [taskId],
    )
    let entry: TaskEntry
    if (row) {
      entry = {
        where: 'row',
        ticket: decodeTicket(row.ticket, 'task_view', taskId),
        note: (row.note as string | null) ?? null,
        updatedAt: new Date(row.updated_at as string | Date),
        updatedSeq: BigInt(String(row.updated_seq)),
        wasStaged: false,
        dirty: false,
      }
    } else {
      const [staged] = await this.ctx.query<{ ticket: unknown }>(
        'select ticket from task_view_ticket where task_id = $1',
        [taskId],
      )
      entry = {
        where: staged ? 'staged' : 'none',
        ticket: staged ? decodeTicket(staged.ticket, 'task_view', taskId) : emptyTicket,
        note: null,
        updatedAt: new Date(0),
        updatedSeq: 0n,
        wasStaged: false,
        dirty: false,
      }
    }
    this.tasks.set(taskId, entry)
    const latest = entry.ticket.runs.at(-1)
    if (latest !== undefined) await this.run(latest, false)
    return entry
  }

  /** The run's entry, created from `emptyRun` when it has no row (`create`) or left absent (`peek`). */
  run(runId: string, create: true): Promise<RunEntry>
  run(runId: string, create: false): Promise<RunEntry | undefined>
  async run(runId: string, create: boolean): Promise<RunEntry | undefined> {
    const hit = this.runs.get(runId)
    if (hit) return hit
    if (!this.missing.has(runId)) {
      const [row] = await this.ctx.query<{ task_id: string | null; run: unknown }>(
        'select task_id, run from task_view_run where run_id = $1',
        [runId],
      )
      if (row) {
        const entry = { taskId: row.task_id, run: decodeRun(row.run, 'task_view', runId), dirty: false }
        this.runs.set(runId, entry)
        return entry
      }
      this.missing.add(runId)
    }
    if (!create) return undefined
    const entry = { taskId: null, run: emptyRun, dirty: true }
    this.runs.set(runId, entry)
    return entry
  }

  /** The row's whole column set as the cache holds it now, or null for a ticket that has no row. */
  columns(taskId: string, entry: TaskEntry): Columns | null {
    if (entry.where !== 'row') return null
    return this.columnsOf(taskId, entry.ticket)
  }

  /** Reads the latest run from memory: `task` loads it with the ticket, and a claim links it before this is asked. */
  columnsOf(taskId: string, ticket: TicketState): Columns {
    const latest = ticket.runs.at(-1)
    const run = latest === undefined ? undefined : this.runs.get(latest)
    return { ...derive(taskId, ticket), ...rowOf(ticket, run?.run ?? null) }
  }

  async flush(): Promise<void> {
    for (const [runId, e] of this.runs) {
      if (!e.dirty) continue
      await this.ctx.query(
        `insert into task_view_run (run_id, task_id, run) values ($1, $2, $3::jsonb)
         on conflict (run_id) do update set task_id = excluded.task_id, run = excluded.run`,
        [runId, e.taskId, encodeRun(e.run)],
      )
    }
    for (const [taskId, e] of this.tasks) {
      if (!e.dirty) continue
      const encoded = encodeTicket(e.ticket)
      if (e.where === 'staged' || e.where === 'none') {
        await this.ctx.query(
          `insert into task_view_ticket (task_id, ticket) values ($1, $2::jsonb)
           on conflict (task_id) do update set ticket = excluded.ticket`,
          [taskId, encoded],
        )
        continue
      }
      const cols = this.columns(taskId, e)
      const c = cols!
      const row: [string, unknown, string][] = [
        ['project', c.project, '::text'],
        ['issue', c.issue, '::text'],
        ['title', c.title, '::text'],
        ['kind', c.kind, '::text'],
        ['state', c.state, '::text'],
        ['note', e.note, '::text'],
        ['run_id', c.run_id, '::text'],
        ['turns', c.turns, '::int'],
        ['base_sha', c.base_sha, '::text'],
        ['head_sha', c.head_sha, '::text'],
        ['files', c.files, '::int'],
        ['insertions', c.insertions, '::int'],
        ['deletions', c.deletions, '::int'],
        ['verdicts', c.verdicts, '::jsonb'],
        ['awaiting_sha', c.awaiting_sha, '::text'],
        ['wait_id', c.wait_id, '::text'],
        ['wait_reason', c.wait_reason, '::jsonb'],
        ['triage_attempt', c.triage_attempt, '::int'],
        ['triage_started_at', c.triage_started_at, '::timestamptz'],
        ['triage_result', c.triage_result, '::jsonb'],
        ['triage_head_sha', c.triage_head_sha, '::text'],
        ['answer', c.answer, '::jsonb'],
        ['split', c.split, '::jsonb'],
        ['closed_at', c.closed_at, '::timestamptz'],
        ['attempts', c.attempts, '::int'],
        ['last_attempt_at', c.last_attempt_at, '::timestamptz'],
        ['restarts', c.restarts, '::int'],
        ['updated_at', e.updatedAt, '::timestamptz'],
        ['updated_seq', e.updatedSeq.toString(), '::bigint'],
        ['ticket', encoded, '::jsonb'],
      ]
      await this.ctx.query(
        `insert into task_view (task_id, ${row.map(([n]) => n).join(', ')})
         values ($1::text, ${row.map(([, , cast], i) => `$${i + 2}${cast}`).join(', ')})
         on conflict (task_id) do update set ${row.map(([n]) => `${n} = excluded.${n}`).join(', ')}`,
        [taskId, ...row.map(([, v]) => v)],
      )
      if (e.wasStaged) await this.ctx.query('delete from task_view_ticket where task_id = $1', [taskId])
    }
  }
}

/** The card's line for what a run event did, read off the run's state before and after its reduce (#845). */
export function runNoteOf(before: RunState, after: RunState): string | null {
  if (JSON.stringify(before.lifecycle) !== JSON.stringify(after.lifecycle)) {
    const l = after.lifecycle
    if (l.status === 'awaiting-input') return l.prompt
    if (l.status === 'awaiting-approval') return l.question
  }
  if (after.roundsOpened.length > before.roundsOpened.length) {
    const round = after.roundsOpened.at(-1)!
    const proposal = after.route?.offer.proposal
    const findings = proposal?._tag === 'ReviewFindings' ? proposal.findings.length : 0
    return findings > 0 ? `fixing round ${round}: ${findings} finding(s)` : `fixing round ${round}`
  }
  if (after.failure !== null && JSON.stringify(before.failure) !== JSON.stringify(after.failure))
    return `${after.failure.kind}: ${after.failure.detail}`
  return null
}

function touch(entry: TaskEntry, event: Envelope): void {
  entry.updatedAt = event.at
  entry.updatedSeq = event.seq
  entry.dirty = true
}

/**
 * One event on either half: reduce it into its own state, read the other, compute the row, write what
 * changed (#844).
 *
 * **One writer** (0100 §13, #860): the conductor-lock holder alone runs this projection, in `seq` order,
 * so there is no per-row `seq` guard and no lock ordering between the tables.
 */
async function applyRunEvent(cache: Cache, event: Envelope): Promise<void> {
  const runId = event.streamId
  const entry = await cache.run(runId, true)
  if (event.type === 'RunStarted') entry.taskId = (event.data as PayloadOf<'RunStarted'>).ticketId
  const task = entry.taskId === null ? null : await cache.task(entry.taskId)
  const was = task === null || entry.taskId === null ? null : cache.columns(entry.taskId, task)

  const runBefore = entry.run
  entry.run = applyRun(entry.run, event)
  entry.dirty = true

  if (task === null || entry.taskId === null || task.where !== 'row') return
  const now = cache.columns(entry.taskId, task)
  // Only the ticket's latest run speaks for the card.
  const note = task.ticket.runs.at(-1) === runId ? runNoteOf(runBefore, entry.run) : null
  if (note !== null) task.note = note
  if (note !== null || JSON.stringify(was) !== JSON.stringify(now)) touch(task, event)
}

async function applyTicketEvent(cache: Cache, event: Envelope): Promise<void> {
  const taskId = event.streamId
  const entry = await cache.task(taskId)
  const before = entry.ticket
  const was = cache.columns(taskId, entry)
  if (event.type === 'TicketClaimed' || event.type === 'TicketContinued') {
    const run = await cache.run((event.data as PayloadOf<'TicketClaimed'>).runId, true)
    run.taskId = taskId
    run.dirty = true
  }
  const after = applyTicket(before, event)
  entry.ticket = after
  entry.dirty = true

  if (entry.where !== 'row' && !MAKES_THE_ROW.has(event.type)) {
    entry.where = 'staged'
    return
  }

  const now = cache.columnsOf(taskId, after)
  const note = ticketNoteOf(before, after)
  if (entry.where !== 'row') {
    // The event that makes the row: it moves out of staging, whole, and the card's age starts here.
    entry.wasStaged = entry.where === 'staged'
    entry.where = 'row'
    entry.note = note?.value ?? null
    touch(entry, event)
    return
  }
  const touched = JSON.stringify(was) !== JSON.stringify(now) || note !== null
  if (!touched) return
  if (note !== null) entry.note = note.value
  touch(entry, event)
}

// ------------------------------------------------------------------ read ----

export interface TaskCard {
  taskId: string
  project: string
  issue: string
  title: string
  kind: string
  state: TaskState
  tier: string
  runId: string | null
  turns: number | null
  /**
   * Verdicts from the run this card names, and no other. Four counts rather
   * than two, because a person's word is not a gate's: `waived` is an
   * override of a failure and `approved` is a human answering a `human`
   * action. Counting either as passed made the card say the opposite of what
   * happened.
   *
   * **No prefix, and that is the whole of `#249`.** A prefix on these names the
   * *population* — which steps recorded a verdict — and
   * [0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md) §3a
   * changes it: `review` stops giving one at all and raises findings instead, so
   * the 231 refusals it recorded over 14 days
   * ([012](../../../doc/experiments/012-where-the-turns-go.md) §4) will arrive at
   * `proposed`. `stepsPassed` would then promise a population it does not count,
   * exactly as the retired prefix did. These four say only *this run recorded
   * that many*, which was true before that rewrite and is true after it.
   */
  passed: number
  failed: number
  waived: number
  approved: number
  baseSha: string | null
  headSha: string | null
  files: number | null
  insertions: number | null
  deletions: number | null
  note: string | null
  updatedAt: Date
  closedAt: Date | null
  attempts: number
  lastAttemptAt: Date | null
  /**
   * How many approaches this ticket has abandoned, and the ceiling
   * ([0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md) §3).
   *
   * Both zero on every card today, because `runtime.limits.restarts` defaults
   * to zero. `attempts` is not this number and never was: it counts claims, so
   * a claim after a crash, after a backoff and after an approach was thrown
   * away all read as `attempt 3`. Read through `describeArm`, which is what
   * keeps the board and `lingtai status` saying it in the same words.
   */
  restarts: number
  restartsOf: number
  /**
   * The current wait, non-null exactly when `state` is `'waiting'` (#440).
   * `waitId` names the `WaitStarted` that opened it, and `reason` is the
   * whole of what it recorded — `allowedResolutions(wait.reason)` is what a
   * caller asks to know which controls apply. Read through `waitOf`, which
   * both store twins call so they cannot disagree about the refusal below.
   */
  wait: { waitId: WaitId; reason: WaitReason } | null
  triage: TriageFacts
  triageHeadSha: string | null
  /**
   * The last block a person answered, and what they answered it with — null on
   * a task nobody has answered. `question` is null only for an answer the log
   * holds without a block before it.
   */
  answer: { question: string | null; answer: string; by: string } | null
  /** The children a split wrote, or null for a ticket that was never split. */
  split: { key: string; number: number }[] | null
  /**
   * The sha the open question is about, and null when there is none.
   *
   * This is what a control has to send, not `headSha`: `approve()` binds its
   * verdict to what the run is *asking* about, and the card was sending what
   * the run *produced* (#92). They differ the moment a branch is repaired and
   * approval re-requested on a new head.
   */
  awaitingSha: string | null
  /**
   * Whether a person is being asked something, rather than merely left holding
   * it. `waiting` says where the card sits; this says whether Approve can work.
   *
   * Read off `awaitingSha` rather than stored beside it, so the card cannot
   * offer Approve without the sha Approve needs.
   */
  awaitingApproval: boolean
  /**
   * A repair bought and not yet claimed. Exempt from the queue's backoff.
   *
   * Only a retired `RepairRequested` sets it (`#143`), so it is false on every
   * new ticket — and true on one released for a repair before the deploy, which
   * is owed the exemption its repair was bought with.
   */
  repairPending: boolean
}

/**
 * The columns a store's own `toCard` reads into `TaskCard.wait` (#440).
 *
 * `reason` is already-parsed on Postgres and text on SQLite — each twin
 * passes in whatever its own column type hands back, and this is the one
 * place that turns it into `WaitReason` so the two cannot disagree about the
 * refusal below.
 *
 * Returns `null` for every state but `'waiting'`, whatever the columns hold:
 * Since #834 the wait columns are read off the ticket reduce and clear with the
 * lifecycle, so a stale pair is not expected; the check stays because the board
 * must not draw a wait for a row that is not waiting.
 *
 * Throws, naming the task, on the one combination the fold can never write:
 * `state === 'waiting'` with no reason. `state` is only ever set to
 * `'waiting'` in the same statement that sets `wait_reason` (`WaitStarted`),
 * so a row here either predates this column or has been tampered with — both
 * are a bug to report loudly, not a card to draw with no wait.
 */
export function waitOf(taskId: string, state: TaskState, waitId: unknown, reason: unknown): TaskCard['wait'] {
  if (state !== 'waiting') return null
  if (reason === null || reason === undefined) {
    throw new Error(`task ${taskId} is waiting with no wait_reason`)
  }
  try {
    return { waitId: WaitId.parse(waitId), reason: WaitReason.parse(reason) }
  } catch (err) {
    throw new Error(`task ${taskId} has a wait that does not parse: ${String(err)}`)
  }
}

/** The parent's line about its split, in one place so the board and a CLI say it alike. */
export function splitLine(split: readonly { number: number }[]): string {
  return `split into ${split.map((c) => `#${c.number}`).join(', ')}`
}

/**
 * One sentence of a wait, and which of the four it is.
 *
 * Typed parts rather than formatted lines, so the card and `lingtai status` can
 * render the same sentences differently without keeping their own copies of the
 * words. That is what #83's last condition asks for: *two places that disagree
 * about why something is blocked is the failure this repository keeps finding* —
 * so the wording is decided once, here, beside the field it is read from.
 */
export interface WaitLine {
  part: 'what' | 'did' | 'rec'
  text: string
}

/**
 * What is known about a wait, in the order an operator uses it.
 *
 * Empty for a block that carries only a question — every block written before
 * #83 — which is what makes those render exactly as they did: the question is
 * the card's `note` and is not this function's business.
 *
 * `diagnosis.raw` is deliberately **not** here. It is the git output verbatim,
 * it belongs behind a disclosure rather than in a sentence, and a reader that
 * cannot collapse it should link to the log instead of pasting a hundred lines
 * into a queue listing.
 */
export function describeWaitLines(card: { diagnosis: BlockDiagnosis | null }): WaitLine[] {
  const lines: WaitLine[] = []
  const d = card.diagnosis
  if (d === null) return lines
  lines.push({ part: 'what', text: d.what })
  if (d.done !== null) lines.push({ part: 'did', text: d.done })
  if (d.recommendation !== null) {
    lines.push({
      part: 'rec',
      text: `recommends ${d.recommendation.action} — ${d.recommendation.why}`,
    })
  }
  return lines
}

/**
 * What a person is being waited on *for*, or null when nobody is.
 *
 * Two holds rendered as one chip until #147, and they want opposite things of
 * the person. **An answer** is a question asked before any run: nothing has
 * been produced, there is no diff and no branch, and the move is to decide.
 * **A review** is a run holding a diff at a sha: the move is to approve or
 * reject what is there. A failure that needs acknowledging is neither, and
 * is worded only by its diagnosis, and by nothing when there is none.
 *
 * **`needs` is read, and that is what makes the third sentence true** (`#197`).
 * It used to hold by accident: the only blocks written `acknowledgement` — the
 * merge lane's own undirected reasons (`dirty-base` and the rest), the
 * out-of-turns one, a spent approval's — left no open `signoff`, so
 * `awaitingSha` was null and this returned null without ever asking. A fixer
 * killed mid-round now writes `acknowledgement` on a block that *does* hold a
 * sha, and the chip read *waiting for your review* — whose move is approve or
 * reject what is there — directly beside a headline saying *this is
 * infrastructure and not your call: send it again*. A chip and a headline
 * prescribing opposite moves on one card is the failure #147 split the chip to
 * end, so the rule that was documented is now the rule that runs. **Since
 * #452 a `conflict`/`verify-failed` refusal the router sent on is `Routed`,
 * writes `judgement` and does hold one** — correctly, because there the chip
 * and the headline agree: a branch that does not merge is exactly what *your
 * review* means.
 *
 * Beside `describeWaitLines` for its reason (#83, #100): the card and `lingtai
 * status` both say it, and must say it in the same words.
 */
export function describeWait(card: {
  waiting: boolean
  asked: boolean
  awaitingSha: string | null
  needs: 'judgement' | 'acknowledgement' | null
}): 'waiting for your answer' | 'waiting for your review' | null {
  if (!card.waiting) return null
  if (card.asked) return 'waiting for your answer'
  // Before the sha, because a block can now carry both and only one of them is
  // a question to the person: an acknowledgement is worded by its diagnosis alone.
  if (card.needs === 'acknowledgement') return null
  if (card.awaitingSha !== null) return 'waiting for your review'
  return null
}

/**
 * *restart 1 of 2*, or null when this ticket has only ever had one approach.
 *
 * **Beside `describeWaitLines` and for its reason** (#83, #100): the board and
 * `lingtai status` both show it, and two places that word the same fact
 * differently is the failure this repository keeps finding. So the sentence is
 * decided once, here — but the ceiling is the recipe's, never the row's, and
 * every caller has to hand it in. `#502` dropped the ceiling from the event
 * (`TicketReleased{cause: Restart}` is `{after, restart}` alone — the policy
 * it was spent against lives in the recipe, never on the event), so
 * `restartsOf` stays at its DDL default of 0 on every row now; a caller that
 * wants `of N` reads the recipe's `limits?.restarts` and passes it, the same
 * source `describeHeld` falls back to.
 *
 * Null rather than `restart 0 of 2`, because a ticket on its first approach is
 * not *on* an arm — there is nothing to tell apart yet, and a card that said so
 * on every row would spend the reader's attention on an absence. That is the
 * same reading `[not offered]` earns by saying nothing (#100).
 *
 * **The other half of the sentence is the note.** `fixing round 2` is what
 * `RoundOpened` writes there (#502 dropped the denominator with `FixRequested`:
 * there is no `of 3` any more), because depth is a fact about the pass in flight
 * and lives as long as that pass; this is a fact about the ticket and outlives
 * every pass of it. Together they read *fixing round 2, restart 1 of 2*, which is
 * what 0040 §3 asks a card to be able to say.
 */
export function describeArm(card: Pick<TaskCard, 'restarts'>, restartsOf: number | null): string | null {
  if (card.restarts === 0) return null
  return restartsOf !== null && restartsOf > 0
    ? `restart ${card.restarts} of ${restartsOf}`
    : `restart ${card.restarts}`
}

export interface ReadTasksOptions {
  project?: string
  /**
   * How long a landed task stays visible. Here rather than in the projection,
   * so changing it is a different query and not a rebuild — and so a rebuild
   * does not depend on when it ran.
   */
  retentionDays?: number
  url?: string
}

/**
 * The board's cards, out of whichever store this machine wrote down (#179).
 *
 * The query and the mapping moved into `postgres.ts` with #219 and did not
 * change on the way; what is left here is a store opened for this read and
 * closed after it, exactly as the client it replaced was. **Nothing here
 * chooses between the implementations** — `choose.ts` is the one place that
 * does — and a caller that already has a store calls `store.tasks` and skips
 * this.
 */
export async function readTasks(options: ReadTasksOptions = {}): Promise<TaskCard[]> {
  return withProjectionStore({ url: options.url, max: 1 }, (store) =>
    store.tasks({
      project: options.project,
      // Resolved here rather than in the store, so that changing the window
      // stays a different query and a store never has to know the board's
      // default.
      retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
    }),
  )
}

/**
 * Which projects the board holds cards from, whatever it is filtered to.
 *
 * Distinct over the same rows `readTasks` returns — the same retention window,
 * so a project whose last card has aged out loses its name here too rather than
 * offering a filter that leads to an empty board.
 *
 * Its own query rather than a fold over a filtered read, because that is the
 * one question a filtered read cannot answer: narrowing to one project is what
 * removes the evidence that the others exist. And not the registered list
 * either — **a card can outlive its project** (#86), so a repository that has
 * been unregistered still appears here for as long as its work does.
 */
export async function readTaskProjects(
  options: Pick<ReadTasksOptions, 'retentionDays' | 'url'> = {},
): Promise<string[]> {
  return withProjectionStore({ url: options.url, max: 1 }, (store) =>
    store.taskProjects({ retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS }),
  )
}
