import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { isSea } from 'node:sea'

import {
  RUN_LIMITS,
  ToolsCannotBeDenied,
  type AuthStatus,
  type Runtime,
  type RuntimeCapabilities,
  createRuntime,
  everyRuntime,
} from '@lingtai/agent'
/**
 * `lingtai doctor` — the old `preflight()`, generalised.
 *
 * The old loop refused to start when its guard hook failed a smoke test. That
 * instinct was right and this applies it to everything: a doctor that is green
 * is the precondition for a restart, so a merge that breaks the scheduler is
 * found *before* the scheduler fails to start (roadmap, Phase 3).
 *
 * Two rules shape what is in here.
 *
 * **It never writes.** `scripts/bootstrap.mjs` applies `NOTIFY_SQL` and proves
 * the append-only rules by trying to break them, which means writing probe rows
 * to the event log. A diagnostic that appends to the system of record is the
 * wrong shape; every check below reads the catalogue instead. Bootstrap stays as
 * the write-side setup step. The one exception is `NOTIFY`, which is a
 * transient signal and touches no table.
 *
 * **A check that cannot run yet says so.** The checks for the repository, the
 * hook and GitHub are listed as `skip` rather than omitted — a
 * check you cannot see is a check you will forget you never had. Each carries
 * the reason it is not a startup check, which is a fact about the design and
 * not about what happened to be installed the day it was written: see
 * `DEFERRED`.
 */
import { extensionEnv, productionPatterns, resolveAgentEnv, runnableEnv } from '@lingtai/agent-env'
import {
  type AgentRefusal,
  type ClientFor,
  type ProjectFilter,
  type RecipeFor,
  agentRefusal,
  currentRecipe,
  endedWithoutEndActions,
  githubClientFor,
  loadProjects,
  passCeiling,
  projectFilters,
  signedInHere,
} from '@lingtai/conductor'
import { daySpendText, type DaySpend } from '@lingtai/conductor'
import { readFetchNote, readRateSnapshot } from '@lingtai/conductor/rate-snapshot'
import {
  codeCurrency,
  type Currency,
  codeRoot,
  conductorLockHolder,
  describeCurrency,
  describeInFlight,
  findOrphans,
  held as heldPasses,
  lastBeat,
  readCodeVersion,
  readControl,
  readStatus,
} from '@lingtai/daemon'
import { type RecordedRefusal, type RuntimeId, isEventType } from '@lingtai/domain'
import {
  SQLITE_MACHINE,
  type StoreChoice,
  directUrlIfSet,
  githubApp,
  githubAppValues,
  githubAuth,
  hasGitHubApp,
  hasGitHubAuth,
  machineDatabaseUrl,
  codexTextConfig,
  type CodexTextConfig,
  postgresUrlIfSet,
  repoRoot,
  storeChoice,
  type StoreUnchosen,
} from '@lingtai/env'
import { badge, paint } from '@lingtai/env/colour'
// The barrel's `log`, which is the store **this machine wrote down** (0056) and
// opens nothing until something asks it a question. It is what the rows above
// are asked on a machine whose log is a file; a Postgres machine keeps naming
// the direct connection, for the reason the import above gives.
import { log, logPredatesHold } from '@lingtai/event-store'
// The submodule, not the barrel: these two checks run on the *direct*
// connection, and the barrel's `log` is the pooled one. Through a pooler is
// where the suite learned what a dropped connection costs (#157), and an audit
// that reds on one would hold `lingtai restart`.
import { createPostgresLogQueries, type LogQueries, type UnconvergedUpdate } from '@lingtai/event-store/queries'
import type { GhRun, GitHubClient } from '@lingtai/github'
import { ghScopeGap, ghScopeRefresh, ghStatus, REQUIRED_PERMISSIONS } from '@lingtai/github'
import {
  backlogProjection,
  describeShape,
  projectionLag,
  projectionShape,
  readTasks,
  spendProjection,
  ticketReportProjection,
  taskViewProjection,
  type Projection,
} from '@lingtai/projector'
import {
  UNBOUNDED,
  baseDivergence,
  baseOf,
  baseWrittenAt,
  ceilingOf,
  declaresTurnsOn,
  isBuiltInJudge,
  recipePath,
  remoteOf,
  type Recipe,
} from '@lingtai/recipe'
import { git } from '@lingtai/repo'
import pg from 'pg'

import { readDaySpend } from './day-ceiling.ts'
import { heading, section, symbol, width } from './output.ts'
import { RUN_UNDER_A_PAUSE } from './run.ts'
import { probeSeaBuild, type SeaProbe } from './sea-build.ts'

/**
 * `warn` is not a weak `fail`. It means **nothing is wrong and you should know
 * anyway** — the case the vocabulary had no room for until something needed to
 * report what it could see but not control (`settings: other sources`, ADR 0016
 * §6). Folding that into `ok` hides it in a wall of green; folding it into
 * `fail` makes doctor red for a file everybody has, and a check that is always
 * red is a check nobody reads.
 *
 * `info` is *true, and there is nothing to do*: where `warn` says you should
 * know anyway and is counted as needing attention, `info` is never counted,
 * never a non-zero exit and never a restart gate.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip' | 'info'

/**
 * How far back `subscribers: failures` counts as *recent*.
 *
 * A window and not an all-time count, for the reason that check's own docstring
 * gives: nothing retries a subscriber, so a total would be red for ever over a
 * notifier that broke once in March.
 */
const A_DAY_MS = 24 * 60 * 60 * 1000

export interface CheckResult {
  name: string
  status: CheckStatus
  /** What it found — never just a tick. */
  detail: string
  /**
   * True for a check that is *not implemented here*, as opposed to one skipped
   * because something earlier failed. Its detail says why — in terms of the
   * design, naming where the property is proved instead, so that the reason
   * cannot go stale. See `DEFERRED`.
   */
  deferred?: boolean
  /**
   * True for a failure whose remedy the check itself names as restarting the
   * daemon. `lingtai restart` gates on this report and does not count these:
   * refusing the one command a failure asks for, unless a waiver is typed, is
   * how that waiver becomes a habit that hides the failures it should not (0042).
   */
  restartAnswers?: boolean
  /** What the row is about, as a sentence a person reads first; absent, `name` is the title. */
  title?: string
  /**
   * The command that fixes it, one per line, a `lingtai env set …` a person can run as written —
   * the project's real name, never a placeholder. A row with no remedy has none invented.
   */
  fix?: string
  /** Milliseconds the call that produced this row took — rows from one call share it. Set by `runDoctor`. */
  ms?: number
}

/** What `runDoctor` tells a caller about the step it is in: `done` is the rows pushed so far. */
export interface DoctorProgress {
  label: string
  phase: 'start' | 'end'
  done: number
}

/**
 * Everything about a connection string that is safe to print.
 *
 * Never the string itself, never the user, never the password, and not the host
 * either — on a hosted Postgres the project identifier lives in the hostname.
 * Port, database and the pooler flag are what actually distinguish the two, and
 * "same host" is the one relation worth knowing.
 */
function describeUrl(raw: string): { port: string; database: string; pgbouncer: boolean; host: string } {
  const u = new URL(raw)
  return {
    port: u.port || '5432',
    database: u.pathname.replace(/^\//, '') || '(default)',
    pgbouncer: u.searchParams.get('pgbouncer') === 'true',
    host: u.hostname,
  }
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: 'lingtai-doctor' })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

/**
 * **Which store this machine says it runs**, from the one function that reads
 * the choice (0056, #215) — so this row and `lingtai init`'s last line are one
 * answer, and a machine that was never set up is told so by name.
 *
 * It renders the choice rather than printing `describeStore()`, for the reason
 * `describeUrl` gives: a hosted Postgres carries its project identifier in the
 * hostname, and no row here prints one. What it does not do is decide anything
 * a second time — the store, and where it was read, are the choice's own.
 *
 * **A refusal here is a failure, since #179.** It was a `warn` while nothing
 * opened a store from this value and a process found Postgres through
 * `LINGTAI_DATABASE_URL` and `database.url` anyway — then a machine with no
 * `database.store` had something to do rather than something broken. Every
 * store now opens from the choice (0056), so the same machine refuses
 * `lingtai status`, the board and the daemon at first use: `warn` would be the
 * one row that names the cause telling the reader it is not the cause, in the
 * status whose own docstring says *nothing is wrong* (see `CheckStatus`).
 *
 * **And `lingtai restart` gating on failures is the reason, not an argument
 * against it.** A daemon started on a machine that cannot open a log drains
 * the old one and starts nothing that works; `restart` refusing until `lingtai
 * init` has run is the behaviour that check exists for (0042).
 *
 * A written `sqlite` is `ok`. It is a log that opens, and what is worth saying
 * about it is `SQLITE_MACHINE`.
 */
const STORE_REFUSED_TITLE: Record<StoreUnchosen, string> = {
  'nothing chosen': 'this machine has not chosen a store',
  'no url': 'the chosen Postgres store has no connection URL',
  'two keys': 'the machine config names the store twice',
  unreadable: "the machine's config file cannot be read",
}

export function storeRow(choice: StoreChoice): CheckResult {
  const name = "store: the machine's written choice"
  const shut =
    'every command that opens the log is refused until this is written — nothing falls back to LINGTAI_DATABASE_URL or database.url (#179, 0056 §2)'
  if ('refused' in choice) {
    return {
      name,
      status: 'fail',
      title: STORE_REFUSED_TITLE[choice.because],
      fix: 'lingtai init',
      detail: `${choice.refused}\n${shut}`,
    }
  }
  if (choice.store === 'sqlite') {
    return { name, status: 'ok', detail: `sqlite ← ${choice.from} · ${SQLITE_MACHINE}` }
  }
  return { name, status: 'ok', detail: `postgres ← ${choice.from}` }
}

/**
 * **Is the log reachable at all**, asked of a log that is a file.
 *
 * `postgres: pooled connection` is this question on a machine with a server,
 * and until [#214](https://github.com/steven-zhc/lingtai/issues/214) it was the
 * only asker of it — so on a machine that wrote `store: sqlite` the one thing
 * anybody runs `lingtai doctor` to find out was answered by nothing, under a
 * summary line that said `0 failed`.
 *
 * **It opens the log; it does not look for a file.** A path that is not there
 * yet is the ordinary state of a machine `lingtai init` has just finished:
 * `init` writes `database.store: sqlite` and stops, because "a SQLite log is a
 * file this machine will create on first open" — `init.ts`'s own words — and
 * no command creates it early. A row that stat()ed the path would fail that
 * machine for ever, naming a remedy (`lingtai init`) that had just run and
 * would never write the file, and a failure carrying no `restartAnswers` gates
 * `lingtai restart` (0042): setup correct, doctor red, no way out. So this asks
 * the store a question, which opens it exactly as the next command would
 * — `create table if not exists`, and not one row written, which is the rule
 * at the top of this file.
 *
 * What it therefore fails on is what is worth failing on: a directory that is
 * not writable, a file that is not a database, a file another process has
 * locked past the busy timeout.
 *
 * **And it is the only row that does fail on those.** Every audit below reads
 * the log behind a `.catch(() => null)` and reports *no log to read yet* as
 * `ok`, which is right for a machine that has genuinely never appended and
 * indistinguishable from a machine whose store will not open. That row is what
 * tells the two apart, so it is placed before them and never after.
 */
export async function logReachable(where: string, queries: LogQueries): Promise<CheckResult> {
  const name = 'log: reachable'
  try {
    const streams = await queries.projectStreams('prj-')
    return {
      name,
      status: 'ok',
      detail: `${where} opened and answered — ${streams.length} project stream(s) in it`,
    }
  } catch (err) {
    return {
      name,
      status: 'fail',
      title: 'the log cannot be opened',
      detail:
        `${where} could not be opened or read — ${(err as Error).message}\n` +
        'Every command that appends or reads is refused the same way until it can be',
    }
  }
}

export const GITHUB_APP_NOT_CONFIGURED =
  'no GitHub App is configured — ~/.lingtai/config.yml names no github.app_id and key, and nothing ' +
  "exported does, so no repository can be onboarded yet. The board's setup page or lingtai init writes one."

/**
 * The rows that are about **Postgres** and not about a log, and the sentence
 * each gives a machine that runs a file instead.
 *
 * Skipping them is right: there is no server here, and inventing a green row
 * for a connection nobody made would be worse than the silence it replaces.
 * What was wrong is that they *vanished* — **twelve** checks collapsed into one
 * line saying `postgres: not attempted`, so a reader counting rows could not
 * see the twelve that were gone, and `0 failed` covered the lot. ADR 0016 §4's
 * rule about a thing you cannot tell apart from its absence, in the one command
 * built to prevent it.
 *
 * **Twelve, and this list is seven of them.** The other five — `log: every type
 * is readable`, `github: what we said and did not manage`, `subscribers:
 * failures` and the two gate audits — are questions about a log and not about
 * Postgres, so they did not need a line here saying why they do not apply: they
 * are asked of whatever store is open, above. Somebody adding a Postgres-only
 * check later adds it to this list, and the number to audit it against is the
 * length of the list itself.
 *
 * So each keeps its own name, and each says **why it does not apply, naming the
 * store** — not a bare `skip`. Where the question survives the store the
 * sentence says which row asks it instead; where it does not survive, it says
 * what stands in its place, including where nothing does. `schema:
 * append-only` is the one that has to be read carefully: Postgres enforces it
 * with a rule and a file does not enforce it at all.
 *
 * **Every row here can only ever be a `skip`.** A row that could have *failed*
 * on this machine and did not run is a machine nobody checked, and there is
 * none of those: the questions that can fail — reachability, the projections,
 * the readable types, the two gate audits — are asked of whatever store is
 * open. `apps/cli/integration/doctor.test.ts` pins that, by name.
 */
export function postgresOnlyRows(): { name: string; because: string }[] {
  return [
    {
      name: 'postgres: pooled connection',
      because:
        'there is no server to connect to — log: reachable above opens the file instead, which is the same question',
    },
    {
      name: 'postgres: direct connection is session mode',
      because:
        'session mode is about a pooler handing a LISTEN registration to someone else; a reader of a file ' +
        'is told about an append by polling it, so there is no connection here to be in ' +
        'the wrong mode',
    },
    {
      name: 'schema: tables',
      because:
        'events and checkpoints are created by the store itself every time it opens the file, ' +
        'so there is no bootstrap step that could have been missed',
    },
    {
      name: 'schema: optimistic concurrency',
      because:
        'UNIQUE (stream_id, version) is in that same CREATE TABLE and cannot be absent from a file this build opened',
    },
    {
      name: 'schema: append-only',
      because:
        'and nothing stands in for it: UPDATE and DELETE on events are refused by Postgres rules, and a file ' +
        'has no rules — what keeps this log append-only is that the store is the only writer of it',
    },
    {
      name: 'schema: notify trigger',
      because: 'nothing announces an append from inside the file; a second reader finds out by polling',
    },
    {
      name: 'schema: payload column',
      because:
        'data is TEXT holding JSON, read with json_extract rather than jsonb operators — there is no column type ' +
        'here that could be the wrong one',
    },
  ]
}

/** The `environment` row for a config file that would not parse: a file edit, so a title and no `fix`. */
export function unreadableConfigRow(message: string): CheckResult {
  return {
    name: 'environment',
    status: 'fail',
    title: "the machine's config file cannot be read",
    detail: message,
  }
}

/**
 * `source` is where the pooled URL was read: the variable, or — with neither
 * variable set — `~/.lingtai/config.yml`, where `lingtai init` writes it (#186).
 */
export function environment(
  pooled: string | undefined,
  direct: string | undefined,
  standIn = false,
  source = 'LINGTAI_DATABASE_URL',
): CheckResult {
  if (!pooled || !direct) {
    const missing = [!pooled && 'LINGTAI_DATABASE_URL', !direct && 'LINGTAI_DIRECT_DATABASE_URL'].filter(Boolean)
    return {
      name: 'environment',
      status: 'fail',
      title: 'no database connection is configured',
      fix: 'lingtai init',
      detail:
        `${missing.join(' and ')} not set, and ~/.lingtai/config.yml names no database.url\n` +
        'lingtai init writes one, or export LINGTAI_DATABASE_URL and restart',
    }
  }

  const p = describeUrl(pooled)
  const d = describeUrl(direct)
  const sameHost = p.host === d.host
  const detail =
    `${source} :${p.port} db=${p.database} pgbouncer=${p.pgbouncer} · ` +
    (standIn
      ? 'LINGTAI_DIRECT_DATABASE_URL unset, the pooled one stands in · '
      : `LINGTAI_DIRECT_DATABASE_URL :${d.port} db=${d.database} pgbouncer=${d.pgbouncer} · `) +
    `same host: ${sameHost ? 'yes' : 'NO'}`

  // Two URLs against different databases is not a configuration this system has
  // any meaning for: the subscriber would be listening to one log while the
  // writer appended to another.
  if (!sameHost || p.database !== d.database) {
    return {
      name: 'environment',
      status: 'fail',
      title: 'the two database URLs name different databases',
      detail: `they must be one database\n${detail}`,
    }
  }
  if (d.pgbouncer) {
    return {
      name: 'environment',
      status: 'fail',
      title: 'the direct database URL goes through a pooler',
      detail: standIn
        ? `LINGTAI_DATABASE_URL carries pgbouncer=true, so it cannot stand in for the direct one: set LINGTAI_DIRECT_DATABASE_URL\n${detail}`
        : `LINGTAI_DIRECT_DATABASE_URL still carries pgbouncer=true\n${detail}`,
    }
  }
  return { name: 'environment', status: 'ok', detail }
}

async function pooledConnection(url: string): Promise<CheckResult> {
  try {
    const version = await withClient(url, async (c) => {
      const r = await c.query<{ v: string }>('select version() as v')
      return (r.rows[0]?.v ?? '').split(' on ')[0]
    })
    return { name: 'postgres: pooled connection', status: 'ok', detail: version ?? 'connected' }
  } catch (err) {
    return {
      name: 'postgres: pooled connection',
      status: 'fail',
      title: 'the database refused the pooled connection',
      detail: (err as Error).message,
    }
  }
}

/**
 * The check ADR 0009 exists to demand.
 *
 * Opening the direct connection and running `select 1` proves nothing — that
 * passes against a transaction pooler, where `LISTEN/NOTIFY` fails
 * **silently**. So this holds a listener open, waits long enough for a pool to
 * churn, and notifies from a second connection — the whole event-driven design
 * depends on the notification.
 *
 * It used to take an advisory lock too, because the merge lane was one. No lock
 * is in Postgres since #193: every lock is a file (`@lingtai/env/lock`).
 */
async function directIsSessionMode(url: string, standIn = false): Promise<CheckResult> {
  const name = 'postgres: direct connection is session mode'
  const listener = new pg.Client({ connectionString: url, application_name: 'lingtai-doctor' })
  const notifier = new pg.Client({ connectionString: url, application_name: 'lingtai-doctor' })

  try {
    await listener.connect()
    const heard: string[] = []
    listener.on('notification', (m) => void heard.push(m.payload ?? ''))
    await listener.query('LISTEN lingtai_doctor')

    // Long enough that a transaction pooler would have handed the listener's
    // backend to someone else, taking the LISTEN registration with it.
    await new Promise((r) => setTimeout(r, 1_500))

    await notifier.connect()
    await notifier.query("NOTIFY lingtai_doctor, 'lingtai doctor'")

    const deadline = Date.now() + 5_000
    while (heard.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    if (heard.length === 0) {
      return {
        name,
        status: 'fail',
        title: 'the direct database connection is not session mode',
        detail:
          (standIn
            ? 'a NOTIFY from a second connection never arrived — LINGTAI_DIRECT_DATABASE_URL is unset, and ' +
              'LINGTAI_DATABASE_URL standing in for it is not session mode: set LINGTAI_DIRECT_DATABASE_URL\n'
            : 'a NOTIFY from a second connection never arrived — LINGTAI_DIRECT_DATABASE_URL is not session mode\n') +
          'LISTEN/NOTIFY will fail silently through it (doc/decisions-archive/0009).',
      }
    }

    return {
      name,
      status: 'ok',
      detail: 'cross-connection NOTIFY delivered after a 1.5s pause',
    }
  } catch (err) {
    return { name, status: 'fail', title: 'the direct database connection failed', detail: (err as Error).message }
  } finally {
    await listener.end().catch(() => {})
    await notifier.end().catch(() => {})
  }
}

/** The schema the log's own tables live in; an archive made by #448's reset
 * procedure sits beside it under a different one, and must change nothing
 * here. */
const EVENTS_SCHEMA = 'public'

/**
 * Judges the three catalogue-shaped checks against `schema` alone, so a second
 * `events` table elsewhere — an archive schema beside the log, made by #448's
 * reset procedure — changes none of their results. Split out from `schema()`
 * so a unit test can hand it a fake catalogue without a database (#500).
 */
export function schemaChecks(
  indexRows: readonly { schemaname: string }[],
  ruleRows: readonly { schemaname: string; rulename: string }[],
  triggerRows: readonly { schemaname: string }[],
  schema: string = EVENTS_SCHEMA,
  { checkout = true }: { checkout?: boolean } = {},
): CheckResult[] {
  const out: CheckResult[] = []
  // `db:bootstrap` is a script in a checkout (`packages/event-store/package.json`); a binary has none, so
  // there it is said and not offered as a command.
  const bootstrap = 'pnpm --filter @lingtai/event-store db:bootstrap'
  const bootstrapLine = checkout
    ? `run ${bootstrap}`
    : 'the bootstrap script runs from a checkout of the repository, not from this binary'

  const hasUnique = indexRows.some((r) => r.schemaname === schema)
  out.push({
    name: 'schema: optimistic concurrency',
    status: hasUnique ? 'ok' : 'fail',
    // No fix: `db:bootstrap` checks this index and does not create it, so offering it would run and repair nothing.
    ...(hasUnique ? {} : { title: 'the log has no guard against two writers' }),
    detail: hasUnique
      ? 'UNIQUE (stream_id, version) present — the whole of the concurrency control'
      : 'UNIQUE (stream_id, version) is MISSING; two workers can claim one work item',
  })

  const ruleNames = ruleRows
    .filter((r) => r.schemaname === schema)
    .map((r) => r.rulename)
    .sort()
  out.push({
    name: 'schema: append-only',
    status: ruleNames.length === 2 ? 'ok' : 'fail',
    ...(ruleNames.length === 2
      ? {}
      : { title: 'the log can be edited or deleted from', ...(checkout ? { fix: bootstrap } : {}) }),
    detail:
      ruleNames.length === 2
        ? 'UPDATE and DELETE on events do nothing'
        : `only ${ruleNames.join(', ') || 'no'} of the two append-only rules are present\n${bootstrapLine}`,
  })

  const hasTrigger = triggerRows.some((r) => r.schemaname === schema)
  out.push({
    name: 'schema: notify trigger',
    status: hasTrigger ? 'ok' : 'fail',
    ...(hasTrigger ? {} : { title: 'appends no longer wake anything', ...(checkout ? { fix: bootstrap } : {}) }),
    detail: hasTrigger
      ? 'every append announces itself on the lingtai channel'
      : `the lingtai_events_notify trigger is missing, so nothing would wake on an append\n${bootstrapLine}`,
  })

  return out
}

/**
 * The write model, read from the catalogue rather than exercised.
 *
 * `UNIQUE (stream_id, version)` is the entire concurrency control; the rules are
 * what make the log append-only by the database rather than by convention; the
 * trigger is what makes the system event-driven at all. Each one missing is a
 * different silent failure.
 */
async function schema(url: string): Promise<CheckResult[]> {
  try {
    return await withClient(url, async (c) => {
      const out: CheckResult[] = []

      // Two, since `#72` dropped `outbox`. The log and the projections'
      // checkpoints are the whole of the schema now, which is the shape 0022
      // was arguing for: everything else is computed on demand.
      const tables = await c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = '${EVENTS_SCHEMA}' and table_name in ('events','checkpoints')`,
      )
      const found = tables.rows.map((r) => r.table_name).sort()
      out.push({
        name: 'schema: tables',
        status: found.length === 2 ? 'ok' : 'fail',
        ...(found.length === 2 ? {} : { title: 'the log is missing a table' }),
        detail: found.length === 2 ? found.join(', ') : `found ${found.join(', ') || 'none'} — expected both`,
      })

      // These three match on `tablename`/`relname` across every schema — not
      // just `EVENTS_SCHEMA` — because `schemaChecks` is what judges the
      // result; see its own docstring for why that split exists (#500).
      const uq = await c.query<{ schemaname: string }>(
        `select schemaname from pg_indexes where tablename = 'events'
         and indexdef like '%UNIQUE%stream_id%version%'`,
      )

      const rules = await c.query<{ schemaname: string; rulename: string }>(
        `select schemaname, rulename from pg_rules where tablename = 'events'
         and rulename in ('lingtai_events_no_update','lingtai_events_no_delete')`,
      )

      const trig = await c.query<{ schemaname: string }>(
        `select n.nspname as schemaname from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         where c.relname = 'events' and t.tgname = 'lingtai_events_notify' and not t.tgisinternal`,
      )

      out.push(...schemaChecks(uq.rows, rules.rows, trig.rows, EVENTS_SCHEMA, { checkout: !isSea() }))

      const jsonb = await c.query<{ table_name: string; column_name: string; data_type: string }>(
        `select table_name, column_name, data_type from information_schema.columns
         where table_schema = '${EVENTS_SCHEMA}'
           and (table_name, column_name) in (('events','data'))`,
      )
      const wrong = jsonb.rows.filter((r) => r.data_type !== 'jsonb')
      out.push({
        name: 'schema: payload column',
        status: jsonb.rows.length === 1 && wrong.length === 0 ? 'ok' : 'fail',
        ...(jsonb.rows.length === 1 && wrong.length === 0
          ? {}
          : { title: 'the event payload column is the wrong type' }),
        detail:
          jsonb.rows.length === 1 && wrong.length === 0
            ? 'events.data is jsonb'
            : wrong.length > 0
              ? wrong.map((r) => `${r.table_name}.${r.column_name} is ${r.data_type}`).join(', ')
              : 'events.data is missing',
      })

      return out
    })
  } catch (err) {
    return [
      { name: 'schema', status: 'fail', title: 'the log schema could not be read', detail: (err as Error).message },
    ]
  }
}

/**
 * `url` refines a Postgres connection and never picks the store: left out, this
 * folds through the one this machine wrote down (#179), which is what lets a
 * file-backed machine have this row at all.
 */
export async function projections(
  url?: string,
  fetch: () => ReturnType<typeof projectionLag> = () => projectionLag(url),
): Promise<CheckResult> {
  try {
    const lags = await fetch()
    if (lags.length === 0) {
      return {
        name: 'projections: lag',
        status: 'ok',
        detail: 'no projection has a checkpoint yet — nothing is running to fall behind',
      }
    }
    const detail = lags.map((l) => `${l.name} at ${l.lastSeq}/${l.headSeq} (${l.lag} behind)`).join(' · ')
    // Reported, not failed. With no daemon yet, every projection is behind
    // whenever nothing is running it — that is expected, not broken. Once the
    // conductor runs as a daemon (#27), lag plus a stale `updatedAt` becomes a
    // real failure and this is where it belongs.
    return { name: 'projections: lag', status: 'ok', detail }
  } catch (err) {
    return {
      name: 'projections: lag',
      status: 'fail',
      title: 'projection lag could not be read',
      detail: (err as Error).message,
    }
  }
}

/**
 * The columns the projection's DDL declares, against the columns the table has.
 *
 * The check above looks at **lag**, and lag is the wrong instrument for this:
 * #84 added `awaiting_approval` to `task_view`'s `create table`, which only runs
 * when the table is absent, and the live table had been made days earlier. Lag
 * was zero right up to the append that needed the column — then the projector
 * threw, the daemon stopped with it at 933 against a head of 941, and the board
 * was stale overnight with a run orphaned in it. The one check that covered
 * projections could not have seen the one thing that was wrong.
 *
 * A **fail**, not a warn or a skip. The daemon will stop over this the moment
 * the wrong event arrives, and the fix costs a replay rather than a decision —
 * which is why the detail names it (`describeDrift`). Reads
 * `information_schema` only, so it obeys the rule at the top of this file and
 * runs on every doctor.
 */
export async function projectionShapes(
  url?: string,
  fetch: (p: Projection) => ReturnType<typeof projectionShape> = (p) => projectionShape(p, url),
): Promise<CheckResult> {
  const name = 'projections: shape'
  try {
    // Every projection, not the first one: `finding_backlog` (#137) and
    // `spend` (#497) each have a `create table if not exists` of their own,
    // and the same #84 waiting in it.
    const shapes = await Promise.all(
      [taskViewProjection, backlogProjection, spendProjection, ticketReportProjection].map((p) => fetch(p)),
    )
    const drifting = shapes.filter((s) => s.drift.length > 0)
    if (drifting.length === 0) {
      return { name, status: 'ok', detail: shapes.map((s) => `${s.projection}: ${describeShape(s)}`).join(' · ') }
    }
    return {
      name,
      status: 'fail',
      title: `${drifting.length === 1 ? 'a projection differs' : `${drifting.length} projections differ`} from the declared columns`,
      fix: drifting.map((s) => `lingtai projection rebuild ${s.projection}`).join('\n'),
      detail:
        `${drifting.length} projection(s) differ from the columns their code declares\n` +
        shapes.map((s) => `${s.projection}: ${describeShape(s)}`).join('\n'),
    }
  } catch (err) {
    return { name, status: 'fail', title: 'projection columns could not be read', detail: (err as Error).message }
  }
}

/**
 * Checks that belong here and cannot run yet.
 *
 * Listed rather than omitted. A doctor whose output silently shrinks to what
 * happens to be implemented is how a missing check becomes invisible — which is
 * the exact failure mode of the system this replaces.
 */
/**
 * The App's credentials, without contacting GitHub.
 *
 * Whether an installation actually grants the four permissions is a per-repository
 * question, and `lingtai add` answers it before it writes anything. What can be
 * answered here is the one that costs an hour to diagnose otherwise: is a key
 * configured at all, and is it a key.
 */
/**
 * Whether the agent runtime can sign in **in the environment a run gets**.
 *
 * That qualifier is the entire check. The operator being signed in tells you
 * nothing: the first real run against a repository died on "Not logged in ·
 * Please run /login" while the operator was signed in perfectly well, because
 * a run's environment is filtered and had no `USER` — and macOS finds a
 * keychain item by who is asking. A check that probed `process.env` would have
 * been green throughout.
 *
 * `claude auth status` is free; it reads the credential and does not call the
 * API. Its exit code is 0 whether or not you are signed in, so the field is the
 * answer.
 */
/**
 * What else is configuring the agent, besides the recipe.
 *
 * Reports rather than enforces, and that is the whole point. Lingtai does not
 * set `HOME` — it cannot, because the runtime's credentials live under it — so
 * the operator's own `~/.claude/settings.json` is in scope for every run, along
 * with any `.claude/settings.json` the managed repository has committed. Both
 * merge with the settings Lingtai writes; hooks from every source run, and
 * `permissions.deny` from any of them holds.
 *
 * That means **the recipe is not a complete description of a run**, and since
 * deleting the guard (ADR 0016 §6) this is the only visibility that exists into
 * the difference. Being unable to control it is acceptable. Being unable to see
 * it is not — which is exactly the failure the old loop's 132 invisible blocks
 * were.
 *
 * Never a `fail`: none of this is wrong, and a check that goes red for a
 * `settings.json` everyone has is a check people learn to skip.
 */
async function settingsSources(
  fetch: () => Promise<string | null> = async () => {
    try {
      return await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')
    } catch {
      return null
    }
  },
): Promise<CheckResult> {
  const name = 'runtime: other settings in scope'

  const raw = await fetch()
  if (raw === null) {
    return { name, status: 'ok', detail: 'no ~/.claude/settings.json — the recipe is the whole story' }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    return { name, status: 'warn', detail: `~/.claude/settings.json does not parse: ${(err as Error).message}` }
  }

  // Only the keys that change what a run does. Everything else there is the
  // operator's business and is not worth naming.
  const carries: string[] = []
  if (parsed['hooks']) carries.push('hooks')
  if (parsed['permissions']) carries.push('permissions')
  if (parsed['mcpServers'] || parsed['enabledMcpjsonServers']) carries.push('MCP servers')
  if (parsed['env']) carries.push('env')

  if (carries.length === 0) {
    return { name, status: 'ok', detail: '~/.claude/settings.json carries nothing that changes a run' }
  }
  return {
    name,
    status: 'info',
    detail:
      `~/.claude/settings.json also applies to every run (${carries.join(', ')})\n` +
      "Lingtai cannot set HOME (the runtime's credentials live there), so this is " +
      'reported rather than removed — the recipe alone does not describe a run on this machine.',
  }
}

/**
 * Which runtimes are signed in, **asked of every one of them** (`#313`).
 *
 * It asked `createClaudeCodeRuntime()` alone, which was right while that was the
 * only runtime dispatched: this row went `fail` on a machine signed in to Codex
 * and nothing else, telling an operator to fix a Claude Code login they did not
 * want. Since a recipe's `runtime.agent` now decides which adapter is started,
 * the question is the one `signedInProbe` already asks — *every runtime, not only
 * the one that runs today* — and `everyRuntime()` is the table's own values, so a
 * third runtime is asked about by having a row.
 *
 * **Green means at least one, and the per-project answer is `runtime: <project>
 * signed in`.** This row is about the *installation* — is there an agent on this
 * machine at all — and on its own it is not enough: a machine signed in to Codex
 * alone, with a project whose recipe still carries the schema default
 * `runtime.agent: claude-code`, is green here and dispatches a runtime that is
 * signed out. `dispatchedAuthRow` is what asks that question, per project, off the
 * recipe, and it is a `fail` in exactly that case. Neither row is the other's
 * summary.
 */
async function runtimeAuth(fetch: () => ReturnType<typeof everyRuntime> = () => everyRuntime()): Promise<CheckResult> {
  const name = 'runtime: signed in'
  // Exactly what a run gets. Not `process.env`.
  const env = runnableEnv({})
  const asked = await Promise.all(
    fetch().map(async (runtime) => ({
      id: runtime.capabilities.id,
      // A runtime that cannot be asked cheaply must not pretend.
      status: runtime.checkAuth ? await runtime.checkAuth(env) : null,
    })),
  )

  const signedIn = asked.filter((a) => a.status?.loggedIn === true)
  const said = asked
    .map((a) => `${a.id} — ${a.status === null ? 'cannot be asked cheaply' : a.status.detail}`)
    .join(' · ')

  if (signedIn.length > 0) return { name, status: 'ok', detail: said }
  if (asked.every((a) => a.status === null)) {
    return { name, status: 'skip', detail: said }
  }
  return {
    name,
    status: 'fail',
    detail:
      `${said}, in the filtered environment a run gets ` +
      `(${Object.keys(env).sort().join(', ')}). ` +
      "If you are signed in yourself, the run's environment is missing something the credential " +
      'store needs — on macOS that is USER, because a keychain item is found by who is asking.',
  }
}

/** Whether the machine is elected to the saved `gh` login; a refused or absent election is not `gh`. */
function usesGh(env: NodeJS.ProcessEnv): boolean {
  try {
    return githubAuth(env).kind === 'gh'
  } catch {
    return false
  }
}

/**
 * `github: gh login`, on a `gh` machine only: every pass asks `gh` for a token,
 * so a login that is signed out or lacks `repo` and `workflow` fails every pass.
 * Reads `gh auth status`, never the token.
 */
export async function ghLogin(env: NodeJS.ProcessEnv, gh?: GhRun): Promise<CheckResult | null> {
  if (!usesGh(env)) return null
  const name = 'github: gh login'
  const status = await ghStatus(gh)
  if (!status.ok) {
    // Only a missing sign-in is answered by `gh auth login`; a missing or old gh
    // cannot run it, and signing in again would not make an old gh accept --json.
    const titles = {
      missing: 'gh is not installed',
      'too-old': 'gh is too old to report its login',
      unparsed: 'gh gave no readable login status',
      'no-account': 'gh is not signed in to github.com',
      'signed-out': 'gh is not signed in to github.com',
    } as const
    const signIn = status.reason === 'no-account' || status.reason === 'signed-out'
    return {
      name,
      status: 'fail',
      title: titles[status.reason],
      // The command is the row's `fix`; the sentence stops before it.
      detail: signIn ? status.detail.split(' — run ')[0]! : status.detail,
      ...(signIn ? { fix: 'gh auth login' } : {}),
    }
  }
  const gap = ghScopeGap(status)
  if (gap !== null) {
    // The command is the row's `fix`; the sentence stops before it.
    return {
      name,
      status: 'fail',
      title: 'the gh login is missing the repo or workflow scope',
      detail: gap.split(' — run ')[0]!,
      fix: ghScopeRefresh(status)!,
    }
  }
  return { name, status: 'ok', detail: `gh is signed in to github.com as ${status.login} with repo and workflow` }
}

export function githubCredentials(env: NodeJS.ProcessEnv): CheckResult {
  const name = 'github: app credentials'
  if (usesGh(env)) {
    return {
      name,
      status: 'skip',
      detail: 'github.auth is gh — the App is not used for projects, so its credentials are not checked.',
    }
  }
  // A source that names an id with no key, or a `config.yml` that cannot be
  // read, is somebody's half-written App — a failure with its reason, never
  // the *not configured* skip, which tells them to write what they just wrote.
  const elected = githubAppValues(env)
  if (!hasGitHubApp(env) && elected.source === null && elected.unreadable === undefined) {
    return {
      name,
      status: 'skip',
      detail: GITHUB_APP_NOT_CONFIGURED,
    }
  }
  try {
    const app = githubApp(env)
    // Parsing it proves it is a key rather than a path typo or a truncated
    // paste, and does so without the key going anywhere.
    createPublicKey(app.privateKey)
    return {
      name,
      status: 'ok',
      detail:
        `app ${app.appId} from ${app.source}, key from ${app.keySource} · ` +
        `requires ${REQUIRED_PERMISSIONS.map((p) => `${p.name}:${p.level}`).join(', ')} ` +
        '(verified per repository by lingtai add)',
    }
  } catch (err) {
    // What clears it depends on which of several causes this is (no key, an
    // unreadable config.yml, a key that will not parse), so there is no `fix`.
    return { name, status: 'fail', title: 'the GitHub App credentials do not load', detail: (err as Error).message }
  }
}

/**
 * The checks that are listed but not run, each with the reason it is not one.
 *
 * These details are literals, and a literal cannot re-read the world: whatever
 * one asserts about this installation goes on being asserted long after it
 * stops being true. Two of them said no project was onboarded while two were,
 * and a reader who took that at face value went and re-ran `lingtai add`.
 *
 * So the rule, enforced by a test rather than remembered: **a deferred detail
 * says why the check is not a startup check — of the design, and where the
 * property is proved instead — and claims nothing about the state of this
 * machine.** State worth reporting is a check that reads it, next to the ones
 * above. Issue numbers are the same trap one step removed, because an issue
 * closes; a reason that stands on its own does not carry one.
 */
const DEFERRED: { name: string; detail: string }[] = [
  {
    name: 'repository, base branch, submodules',
    detail:
      'only a clone settles these: every run cuts its branch from origin/<base> in the mirror and ' +
      'initialises submodules from it, and stops there when it cannot. Doctor reads — it does not ' +
      'fetch, clone or check out',
  },
  {
    name: 'hook: fail closed',
    detail:
      'every run proves it immediately before dispatching, which is the check that matters; ' +
      'proving it once at daemon startup as well would only surface a missing binary earlier (#48)',
  },
  {
    name: 'github: installation and labels',
    detail:
      "per repository: lingtai add checks the App's permissions before it records anything, so the " +
      'gap a startup check would look for stops the one command that can act on it. Labels are ' +
      "computed from the work item's state and written whole, and reconcile converges what did not " +
      'land (#69) — so label drift has an owner rather than needing a check here',
  },
]

/**
 * The seams `runDoctor` needs besides `load` and `queries` to run the
 * file-backed branch without reaching outside the process.
 *
 * `load` and `queries` were the whole story until this ticket: the rows below
 * take no parameter today, so a unit test handing in only those two still
 * reaches `~/.lingtai`, a spawned process, or a store this test process never
 * chose. Every member here defaults to exactly the call `runDoctor` made
 * before this existed, so `doctorReport` and every caller that does not name
 * `reach` are unchanged (#242, #349).
 */
export interface DoctorReach {
  /** Told when each step starts and ends; `lingtai doctor` draws a spinner from it. */
  onProgress?: (p: DoctorProgress) => void
  /** As `daemonLiveness` and `daemonCurrency` already take it. */
  status: () => ReturnType<typeof readStatus>
  /** As `daemonLiveness` already takes it. */
  pause: () => Promise<Awaited<ReturnType<typeof readControl>> | null>
  lags: () => ReturnType<typeof projectionLag>
  shapes: (p: Projection) => ReturnType<typeof projectionShape>
  lockHolder: () => ReturnType<typeof conductorLockHolder>
  orphans: () => ReturnType<typeof findOrphans>
  titles: () => ReturnType<typeof readTasks>
  /** The raw text of `~/.claude/settings.json`, or `null` where it is absent. */
  settings: () => Promise<string | null>
  runtimes: () => ReturnType<typeof everyRuntime>
  /** As `spendToday` takes it: today's rows and the ceiling, injectable so a unit test reads no store. */
  /** `gh`'s runner for the `github: gh login` row, injectable so a unit test spawns nothing. */
  gh?: GhRun
  spend?: () => Promise<{ day: DaySpend; ceilingUsd: number | undefined }>
  /** Model-only Codex configuration, injectable so doctor tests never read machine credentials. */
  codexText?: () => CodexTextConfig | undefined
  /**
   * As `probeSeaBuild` answers it — required rather than optional, and
   * `runDoctor`'s own `reach` parameter picks this one key out with `Pick` so
   * the requirement reaches that call boundary too, not just a literal typed
   * `DoctorReach` in full. Without the `Pick`, `Partial<DoctorReach>` makes
   * every key optional again and a caller can omit `sea` and spawn Node for
   * real (#212).
   */
  sea: () => SeaProbe
  /** As `currentRecipe` resolves it — `declaredEnvironment`, `recipeGovernsItsBase` and `projectFiltersOnce` all read one injected source (#357). */
  recipe: RecipeFor
  /** As `resolveAgentEnv` reads it, for `declaredEnvironment`. */
  agentEnv: typeof resolveAgentEnv
}

export interface DoctorReport {
  results: CheckResult[]
  ok: number
  failed: number
  skipped: number
  /**
   * Of `skipped`, the ones in `DEFERRED`: not implemented here at all, on any
   * machine.
   */
  deferred: number
  /**
   * Of `skipped`, the ones about **this machine** — a question that does not
   * apply to the store it runs, or one an earlier failure stopped.
   *
   * Counted apart from `deferred` because the summary line has to tell them
   * apart ([#214](https://github.com/steven-zhc/lingtai/issues/214)): *not
   * implemented yet* is a fact about Lingtai and reads the same on every
   * machine, while *not checked here* is a fact about the machine in front of
   * you, and folding the two made `0 failed` the only thing the last line said
   * about a machine whose log had never been opened.
   */
  notChecked: number
  /** Reported, not wrong. See `CheckStatus`. */
  warned: number
  /** True and needing nothing; never counted in `warned`. See `CheckStatus`. */
  info: number
}

/**
 * Is the daemon up, and is it taking work?
 *
 * This is the check that would have turned an hour of confusion into a glance.
 * Two work items merged into `develop` for real while their cards sat in
 * "waiting on you", because nothing was advancing the projections and nothing
 * said so — from outside, a button that did nothing.
 *
 * A daemon that is down is **not a failure here**. Not running one is a
 * legitimate state, and `lingtai run` still works by hand. What would be a failure
 * is not being able to tell.
 *
 * `read` is the beacon read, and doctor's own folds a failure into "no daemon
 * has run". `lingtai service status` passes one that throws, so the read it
 * reports is the read that failed rather than a second one on another
 * connection.
 */
export async function daemonLiveness(
  read: () => ReturnType<typeof readStatus> = () => readStatus().catch(() => null),
  /** The control fold. Doctor's own swallows a failure; the suite passes a memory store's. */
  readPause: () => Promise<Awaited<ReturnType<typeof readControl>> | null> = () => readControl().catch(() => null),
): Promise<CheckResult> {
  const status = await read()
  // Read before the early return. A pause is in force whether or not a daemon
  // has ever run, and it is exactly the thing somebody will forget they set —
  // reporting liveness without it would be the same silence this check exists
  // to break.
  const control = await readPause()
  // With what it means for `lingtai run`, which obeys it daemon or none (#166):
  // "why did nothing run" and "why did something run" answered in one row.
  const paused = control?.paused ? `, paused by ${control.by} (${control.reason}) — ${RUN_UNDER_A_PAUSE}` : ''
  // A third fact beside those two, and independent of both (0030): being
  // current, being paused and being on the way out are three answers, and a
  // daemon that is draining is up, unpaused and going to stop anyway.
  const asked = control?.shutdown ? `, shutdown asked by ${control.shutdown.by} (${control.shutdown.reason})` : ''

  if (!status) {
    return {
      name: 'daemon: liveness',
      status: 'ok',
      detail: `no daemon has run — lingtai run works by hand; lingtai daemon takes the queue${paused}${asked}`,
    }
  }

  // Both of the beacon's fields, through the one function the board reads it
  // with. This row used to compute the age here and ignore the state, and so
  // called a daemon that was still starting `not running` — for twelve seconds,
  // in the window just after a restart, which is exactly when somebody is
  // reading this row to decide whether to restart (`#144`).
  const beat = lastBeat(status)
  const age = beat.ageMs

  if (!beat.up) {
    // What it last said, because a stale beacon still knows what the process
    // was doing when it fell silent: `stopping` is a daemon that was told to
    // go, `starting` one that died on the way up and never took work.
    const last = beat.state === 'up' ? '' : `, last said ${beat.state}`
    return {
      name: 'daemon: liveness',
      status: 'ok',
      // Reported, not failed: a stopped daemon is a choice as often as a
      // crash, and doctor exiting non-zero on it would make the command
      // useless as a restart gate.
      detail: `last seen ${Math.round(age / 1000)}s ago (pid ${status.pid})${last} — not running${paused}${asked}`,
    }
  }

  // `draining` says stopping; what it is stopping *for* is the pass, and the
  // pass is a ticket. "stopping, finishing lingtai#94" is the sentence; "up"
  // was what this said for both, which is the folding #77 argued against.
  // A task_view that cannot be read is said so, never passed off as no passes (#640).
  let held: string[] | null = []
  if (beat.state === 'draining' || beat.state === 'up') held = await readTasks().then(heldPasses, () => null)
  const stopping =
    beat.state === 'draining' ? ` — ${held === null ? 'what is in flight is unreadable' : describeInFlight(held)}` : ''
  // Up with several passes side by side says how many, and one or none stays as it was (#640).
  let side = ''
  if (beat.state === 'up') {
    if (held === null) side = ' — passes in flight unreadable'
    else if (held.length > 1) side = ` — ${held.length} passes in flight`
  }
  // The same argument one state along. `starting` is up and taking nothing
  // yet, and saying only `starting` would invite the restart that `#144`'s
  // `not running` invited.
  const starting = beat.state === 'starting' ? ' — reconciling; it takes no work until that finishes' : ''

  return {
    name: 'daemon: liveness',
    status: 'ok',
    detail: `${beat.state}${stopping}${side}${starting}, last beat ${Math.round(age / 1000)}s ago${paused}${asked}`,
  }
}

/** The `spend` projection's lag right now; undefined where it cannot be read. */
async function spendLagNow(lags: () => ReturnType<typeof projectionLag>): Promise<bigint | undefined> {
  try {
    return (await lags()).find((l) => l.name === 'spend')?.lag
  } catch {
    return undefined
  }
}

/**
 * The fetched half of the rate card (#658): when prices were last fetched, and
 * what the last attempt said. A failed fetch is a warning, never a failure —
 * pricing reads the snapshot and is unaffected. Never fetched is the offline
 * machine's ordinary state, said plainly.
 */
export function ratesCheck(from: NodeJS.ProcessEnv = process.env, spendLag?: bigint): CheckResult {
  const name = 'rates'
  const note = readFetchNote(from)
  if (note === null) {
    return {
      name,
      status: 'ok',
      detail: 'never fetched — models the shipped rate card does not list stay unknown until the conductor starts',
    }
  }
  const day = note.at.slice(0, 10)
  const rejected = note.rejected.length > 0 ? `; out of range, left unknown: ${note.rejected.join(', ')}` : ''
  const rejectedLine = note.rejected.length > 0 ? `\nout of range, left unknown: ${note.rejected.join(', ')}` : ''
  if (!note.ok) {
    return {
      name,
      status: 'warn',
      title: 'the last price fetch failed',
      detail: `last fetched ${day}, ${note.error ?? 'failed'} — the previous snapshot stands${rejectedLine}`,
    }
  }
  // Nothing detects a ChatGPT plan, so the note is conditional in its wording.
  const plan = readRateSnapshot(from).some((r) => r.source !== undefined && r.model.startsWith('gpt'))
    ? ". A Codex user on a ChatGPT plan: an estimate from per-token prices is not that plan's bill; the daily ceiling still counts it"
    : ''
  const priced =
    note.priced === undefined ? '' : `; priced ${note.priced.join(', ')}; ${note.rebuilt ?? 'spend not rebuilt'}`
  // Whether `spend` is behind *now* decides it, not what the refresh once said:
  // a manual rebuild or the live subscriber catching up clears it. The note is
  // the fallback only where the projection could not be read.
  const stuck =
    note.priced !== undefined &&
    (spendLag === undefined ? !/rebuilt — at \S+, 0 behind/.test(note.rebuilt ?? '') : spendLag !== 0n)
  if (stuck) {
    return {
      name,
      status: 'warn',
      title: 'spend was not rebuilt after new prices',
      detail:
        `prices changed but spend has not been rebuilt since (fetched ${day})` +
        `\npriced ${note.priced!.join(', ')}; ${note.rebuilt ?? 'spend not rebuilt'}${rejectedLine}`,
      fix: 'lingtai projection rebuild spend',
    }
  }
  return { name, status: 'ok', detail: `last fetched ${day}, ok${priced}${rejected}${plan}` }
}

/**
 * Is the daemon running the code the repository holds?
 *
 * Liveness above answers *is a daemon up*. This answers the independent
 * question nothing was measuring: *is it up on the current code*. They came
 * apart on 2026-09-08. A daemon started at 17:22:53; `#88` — the fix that
 * records a run's prompt instead of its length — landed on `main` at 18:01:32;
 * and doctor went on saying `up, last beat 2s ago` while 52 prompts were
 * written by the old code and lost for good. Node caches a module at import, so
 * the running process could not produce the new event at all.
 *
 * **[0010](../../../doc/decisions-archive/0010-source-runs-unbuilt.md) reads as "there
 * is no deploy step", and that is half true.** *The source runs unbuilt*
 * removes the build; the restart is still the deploy. Everything else in the
 * system is a fresh process per invocation — the CLI, the gates — or hot
 * reloads — the board — or is re-read from `origin/main` each pass — the
 * recipe. The daemon alone is frozen, so the system schedules with old logic
 * and verifies with new code, which is worse than being uniformly stale.
 *
 * **A `warn`, never a `fail`.** Running a commit behind is normal for the
 * minutes between a merge and a restart, and a doctor that went red for it
 * would be red most afternoons. It is also not `ok`: `ok` is where this hid.
 *
 * It reports and stops there, but this report is no longer read only by a
 * person: `lingtai restart` runs the same doctor and refuses on every failure
 * not marked `restartAnswers`
 * ([0042](../../../doc/decisions-archive/0042-the-restart-is-a-command.md)). Turning
 * this `warn` into a plain `fail` would refuse every restart that is behind —
 * which is every restart that has something to pick up — and marking it would
 * make `lingtai doctor` exit 1 on something the restart lets through. Whether a daemon should restart
 * *itself* when `main` moves is still open; 0042 decided only the command.
 */
export async function daemonCurrency(
  /**
   * The beacon read, as `daemonLiveness` takes it. Both rows read the one
   * mutable row, so both of them answer on whichever store holds it (#220) —
   * and a test can show that without a database.
   */
  read: () => ReturnType<typeof readStatus> = () => readStatus().catch(() => null),
): Promise<CheckResult> {
  const name = 'daemon: currency'
  const status = await read()
  if (!status) {
    return { name, status: 'ok', detail: 'no daemon has run — nothing is holding code open' }
  }

  const beat = lastBeat(status)
  if (!beat.up) {
    // Nothing is holding stale modules if nothing is running. Said rather than
    // omitted, because a check that disappears is one nobody misses.
    return {
      name,
      status: 'ok',
      detail: `no daemon is up (last beat ${Math.round(beat.ageMs / 1000)}s ago) — no process is holding old code`,
    }
  }

  if (!status.codeSha) {
    return {
      name,
      status: 'warn',
      // The state this check was written for, seen from the other side: a
      // daemon old enough to predate the column cannot say what it is running,
      // and that it cannot say is the finding.
      title: 'the daemon cannot say which commit it runs',
      detail:
        'the running daemon recorded no commit\nit started before the beacon carried one, so how far behind it is cannot be known from here',
      fix: RESTART_FIX,
    }
  }

  const currency = await codeCurrency({ sha: status.codeSha, dirty: status.codeDirty })
  return currencyRow(currency)
}

/** The restart that answers both a daemon behind `main` and a refusal by code older than this checkout. */
const RESTART_FIX = 'lingtai restart "picking up main"'

/** The grading of a comparison, apart from the git read that made it. */
export function currencyRow(c: Currency): CheckResult {
  const name = 'daemon: currency'
  if (c.unknown || c.behind.length === 0) return { name, status: 'ok', detail: describeCurrency(c) }
  const at = c.running ? c.running.slice(0, 7) : 'an unrecorded commit'
  const dirty = c.dirty ? ', worktree dirty when it started' : ''
  const base = c.base.replace(/^origin\//, '')
  return {
    name,
    status: 'warn',
    title: `the daemon is ${c.behind.length} commit(s) behind ${base}`,
    detail: [
      `running ${at}${dirty}; a restart takes the new commits`,
      ...c.behind.map((b) => `${b.sha} ${b.subject}`),
    ].join('\n'),
    fix: RESTART_FIX,
  }
}

/**
 * What a conductor's pass refused, **as the refusing process saw it** (#148).
 *
 * The `recipe:` and `env:` rows read `origin/<base>` with *this* checkout's code,
 * and that is the wrong witness whenever the checkout is newer than the daemon.
 * On 2026-09-12 a daemon started at `cc6e856` refused every sweep of `lingtai`
 * over a key its frozen schema did not know, while a `doctor` run after a
 * `git pull` resolved the same recipe cleanly. The two disagreed, and the
 * healthy-looking one was the one a person read.
 *
 * So this resolves nothing. It reads each project's last `ProjectRefused` that
 * no `ProjectRecovered` has followed, and sets its commit beside this
 * checkout's, which is what turns the message into a diagnosis.
 */
async function passRefusals(load: typeof loadProjects = loadProjects): Promise<CheckResult> {
  const name = 'conductor: refusals on the log'
  const projects = await load().catch(() => null)
  if (projects === null) return { name, status: 'skip', detail: 'the project streams could not be read' }

  const refusing = projects.filter((p) => p.project !== null && p.refused !== null)
  if (refusing.length === 0) {
    return { name, status: 'ok', detail: 'no project is refused by the last pass that looked at it' }
  }

  const status = await readStatus().catch(() => null)
  const daemonUp = status !== null && lastBeat(status).up
  const here = (await readCodeVersion()).sha
  const read = await Promise.all(
    refusing.map(async (p) =>
      describeRefusal(p.project!, p.refused!, { daemonUp, here, behind: await isBehind(p.refused!.codeSha, here) }),
    ),
  )
  return refusalsRow(read)
}

/** The row for the projects refused, graded apart from the reads that found them. */
export function refusalsRow(read: ReturnType<typeof describeRefusal>[]): CheckResult {
  const name = 'conductor: refusals on the log'
  const failing = read.filter((r) => r.status === 'fail')
  const restarts = failing.length > 0 && failing.every((r) => r.restartAnswers)
  return {
    name,
    status: failing.length > 0 ? 'fail' : 'warn',
    title: read.length === 1 ? read[0]!.title : `${read.length} projects are refused by the last pass`,
    detail: read.map((r) => r.detail).join('\n'),
    // Only when every failing project is one a restart is the remedy for — one
    // refused by code older than this checkout. A refusal by the code here
    // would refuse again after the restart, and still gates it.
    ...(restarts ? { restartAnswers: true, fix: RESTART_FIX } : {}),
  }
}

/**
 * Whether `sha` is an ancestor of `here` and not `here` itself — code this
 * checkout has moved past. False where it could not be said: a commit this
 * clone never fetched, or no checkout at all, is not proof of being older.
 */
async function isBehind(sha: string | null, here: string | null): Promise<boolean> {
  if (!sha || !here || sha === here) return false
  try {
    await git(['merge-base', '--is-ancestor', sha, here], { cwd: codeRoot() })
    return true
  } catch {
    return false
  }
}

/**
 * One project's refusal, in words. Exported for the suite, which cannot arrange
 * which daemon is up against a shared database.
 *
 * **A fail while a daemon is up**: the last pass that looked refused, and no
 * pass since has looked without refusing, so nothing is being taken from the
 * project. It does not claim the daemon up now is the process that refused — a
 * `--no-conduct` daemon beats at the same commit and runs no pass — only what
 * the log says. **A warn when none is**, since whatever refused is no longer
 * beating, and the next pass records whether it still refuses.
 */
export function describeRefusal(
  project: string,
  r: RecordedRefusal,
  now: {
    daemonUp: boolean
    here: string | null
    /**
     * The refusing commit is an ancestor of `here`. Only then is a restart onto
     * this checkout the remedy: a refusal by *newer* code is not answered by
     * starting older code, and still gates the restart.
     */
    behind?: boolean
  },
): { status: 'fail' | 'warn'; title: string; detail: string; restartAnswers: boolean } {
  const short = (sha: string | null) => (sha ? sha.slice(0, 7) : 'an unrecorded commit')
  const head =
    `${project}: ${r.detail}\n` +
    `refused since seq ${r.seq} (${r.at.toISOString()}) by a process at ${short(r.codeSha)}, ` +
    `reading ${r.ref ?? 'a branch it never reached'}.`
  // The sentence #148 was missing: whether the recipe rows in this report
  // read with the refusing code or with newer code.
  const differs = Boolean(r.codeSha && now.here && r.codeSha !== now.here)
  const older = differs && now.behind === true
  const witness = differs
    ? ` This checkout is at ${short(now.here)}, so the recipe rows here read with other code than the ` +
      'process that refused: if they are ok, the recipe is fine and that process is too old for it — restart it'
    : r.codeSha && r.codeSha === now.here
      ? ' This checkout is at the same commit, so the recipe rows here read with the code that refused'
      : " Which code the recipe rows here read with, beside the refusing process's, cannot be said"
  return now.daemonUp
    ? {
        status: 'fail',
        title: `${project} is refused by the last pass`,
        detail: `${head}${witness}`,
        restartAnswers: older,
      }
    : {
        status: 'warn',
        title: `${project} was refused by the last pass and no daemon is up`,
        detail: `${head}${witness}. No daemon is up; the next pass records whether it still refuses`,
        restartAnswers: older,
      }
}

/**
 * Who is conducting.
 *
 * Liveness above is a beacon — a row somebody wrote — and it answers "is a
 * daemon up". This answers the different question 0027 rests its recovery on:
 * **is anything conducting right now**, whatever it is called. A `lingtai run`
 * in a terminal holds the same lock as the daemon (#93), and before it did, the
 * two questions had the same answer for the wrong reason.
 *
 * Read, never taken — the rule at the top of this file, applied to a lock. A
 * diagnostic that acquired it to find out whether it was free would lock out
 * the thing it is diagnosing, and would itself be a conductor for as long as
 * the check ran.
 *
 * Always `ok`. A lock that is held is the normal state of a machine with a
 * daemon on it, and a lock that is free is the normal state of one without.
 * What would be wrong is not being able to say which.
 */
async function conductorLock(
  fetch: () => ReturnType<typeof conductorLockHolder> = () => conductorLockHolder(),
): Promise<CheckResult> {
  let holder: string | null
  try {
    holder = await fetch()
  } catch (err) {
    return { name: 'conductor: lock', status: 'ok', detail: `could not be read — ${(err as Error).message}` }
  }
  return {
    name: 'conductor: lock',
    status: 'ok',
    detail: holder
      ? `held by ${holder} — lingtai run and lingtai daemon both stand down while it is`
      : 'nobody holds it — the next lingtai run or lingtai daemon conducts',
  }
}

/**
 * What a restart would tidy up, without tidying it up.
 *
 * `dryRun` is the whole point: a check that changed the thing it was checking
 * would tell you about a state that no longer exists by the time you read it.
 */
async function orphans(
  fetch: () => ReturnType<typeof findOrphans> = () => findOrphans({ dryRun: true }),
): Promise<CheckResult> {
  const found = await fetch().catch(() => null)
  if (found === null) {
    return { name: 'worktrees: reconciliation', status: 'ok', detail: 'could not read the worktree directory' }
  }
  if (found.length === 0) {
    return { name: 'worktrees: reconciliation', status: 'ok', detail: 'nothing left over' }
  }
  return {
    name: 'worktrees: reconciliation',
    status: 'ok',
    // Reported, not failed. Leftovers are a normal consequence of a kill, and
    // starting the daemon clears them — a red doctor here would train people
    // to ignore a red doctor.
    detail: `${found.length} left over; lingtai daemon removes them on startup: ${found
      .map((f) => f.stream)
      .join(', ')}`,
  }
}

/**
 * Whether the log holds an event type this build cannot read.
 *
 * The check that would have caught the defect [ADR 0019](../../../doc/decisions-archive/0019-a-second-reset.md)
 * is about. 3c′ deleted three event types while the log held six rows of two of
 * them, and `toEnvelope` throws on a type the catalogue does not know — so every
 * run stream in the log was unreadable from its first row and
 * `lingtai projection rebuild` could not run at all. **Nothing said so.** Both
 * projections were past those rows, and a follower never looks back.
 *
 * A failure here means one of two things, and the detail says which is not
 * knowable from here: a type was deleted while its rows were still in the log,
 * or this build is older than the writer. Either way the log is not fully
 * replayable, which is the one property the whole system rests on.
 */
export async function readableTypes(queries: LogQueries): Promise<CheckResult> {
  const name = 'log: every type is readable'
  const rows = await queries.typeCounts().catch(() => null)
  if (rows === null) return { name, status: 'ok', detail: 'no log to read yet' }

  const orphaned = rows.filter((r) => !isEventType(r.type))
  if (orphaned.length === 0) {
    return { name, status: 'ok', detail: `${rows.length} types, all in the catalogue` }
  }
  return {
    name,
    status: 'fail',
    title: 'the log holds events this build cannot read',
    detail:
      `${orphaned.reduce((n, r) => n + r.rows, 0)} row(s) of ${orphaned.length} type(s) this build cannot read, ` +
      'so reading any stream that holds one throws and a projection rebuild cannot run\n' +
      orphaned.map((r) => `${r.type} ×${r.rows}`).join('\n'),
  }
}

/**
 * Whether the log holds a wait written before #445's reset of its payload, or
 * a stored `type` this build's catalogue does not carry at all — the same
 * guard daemon start and `lingtai projection rebuild` run before they fold
 * the log at all (#451). The second condition is also what `readableTypes`
 * above catches, but that row's own detail never says which of the two
 * things it means; this row's `detail` is `LogPredatesHoldError`'s own
 * message, which does — naming reset or upgrade depending on which it found
 * (`#490`). Doctor reports both as plain checks instead of refusals: the
 * remedy here is the operator's own call, not something worth holding a
 * report over.
 */
export async function logPredatesHoldRow(queries: LogQueries): Promise<CheckResult> {
  const name = 'log: predates the Hold event'
  let found: Awaited<ReturnType<typeof logPredatesHold>>
  try {
    found = await logPredatesHold(queries)
  } catch {
    return { name, status: 'ok', detail: 'no log to read yet' }
  }
  if (found === null) return { name, status: 'ok', detail: 'no wait predates it' }
  return { name, status: 'fail', title: 'the log holds a wait from before the Hold event', detail: found.message }
}

/** What the board calls each issue the two rows below name — `project#issue` to its title. */
type TitleBook = Map<string, string>

/**
 * That book, read from `task_view`.
 *
 * Those rows are read by somebody deciding whether to act *now*, and a detail
 * that fails and says `lingtai#49, lingtai#53, lingtai#55` makes that decision
 * impossible without a round trip to GitHub, under exactly the time pressure
 * that makes a round trip expensive (#258). `task_view` already holds the
 * title, so it costs one read.
 *
 * **Over the whole history, and never thrown.** The board's retention window
 * would drop the oldest divergence, which is the one still being reported; and
 * a store that cannot answer costs the titles rather than the check, which is
 * why the failure is an empty book.
 */
async function issueTitles(
  fetch: () => ReturnType<typeof readTasks> = () => readTasks({ retentionDays: 36_500 }),
): Promise<TitleBook> {
  const cards = await fetch().catch(() => [])
  return new Map(cards.map((c) => [`${c.project}#${c.issue}`, c.title]))
}

/**
 * One reference as a person reads it: the number, what happened to it, and the
 * title when the board has one.
 *
 * `what` is the row's own word — the outcome an item reached, or the change
 * that never landed. It is not a substitute for the title and is not offered as
 * one: it is what keeps the fallback a sentence rather than a bare number.
 */
function say(titles: TitleBook, ref: string, what: string): string {
  const title = titles.get(ref)
  return title === undefined ? `${ref} ${what}` : `${ref} ${what} — ${title}`
}

/**
 * Items that landed with an `end` point that was configured and did not run.
 *
 * The comparison [ADR 0015](../../../doc/decisions-archive/0015-five-gates-and-two-extensions.md)
 * promised, and the one that would have found #55 the day it happened.
 * `StepsResolved` names all ten steps and the actions resolved for each, so
 * "the recipe asked for something at `end`" is in the log; `EndActionsResolved`
 * is the record that the step ran. An item that landed, whose run planned
 * actions at `end`, and whose stream holds no resolution, is a gate that was
 * configured and did not run — which [0016](../../../doc/decisions-archive/0016-the-settled-model.md)
 * §4 calls Lingtai's bug rather than the operator's.
 *
 * **A failure, not a note.** Nothing on the issue shows that Lingtai touched
 * it, and the gap is invisible from GitHub: the ticket stays open and looks
 * exactly like one nothing ever ran on. That invisibility is why two issues sat
 * merged and open for a day with no signal anywhere.
 *
 * From the log alone, and from the *item's own stream* for the second half, so
 * it says nothing about what the recipe happens to contain today.
 */
async function endStepRan(queries: LogQueries, titles: TitleBook): Promise<CheckResult> {
  const name = 'steps: end ran on what landed'
  const found = await endedWithoutEndActions(queries).catch(() => null)
  if (found === null) return { name, status: 'ok', detail: 'no log to read yet' }

  if (found.length === 0) {
    return { name, status: 'ok', detail: 'every landed item with end actions resolved them' }
  }
  return {
    name,
    status: 'fail',
    detail:
      `${found.length} item(s) landed with actions planned at end and none resolved — ` +
      `${found.map((f) => say(titles, `${f.project}#${f.issue}`, f.outcome)).join(', ')}. ` +
      'Their issues were never closed or labelled, and nothing on GitHub says Lingtai ' +
      'touched them: lingtai end replay resolves the step as it should have been.',
  }
}

/**
 * Issues whose last word from Lingtai was a failure.
 *
 * The outbox reported depth and failed on dead letters. There is no queue any
 * more (0022): `tellGitHub` calls GitHub inline and writes down what happened,
 * so the question is no longer *how much is waiting* but *what did we say we
 * would do and not manage*. An `IssueUpdateFailed` with no later `IssueUpdated`
 * for the same issue and change is exactly the divergence `reconcile` converges
 * at the next startup (`#69`) — by recomputing the target, never by replaying
 * the call.
 *
 * **Two grades, because every change but the comment is computable.** Labels
 * and closing come back from `labelsFor` and the work item's state, and a refs
 * sweep from `armPrefix` and one request (`#240`), so a divergence in any of
 * them is a job with an owner and clears itself. A comment's text was a one-off
 * decision that no later pass can re-make, so it is a fact for a person: it is
 * listed separately and never graded `fail`, because a check that stays red
 * forever is a check nobody reads.
 *
 * **So the bucket has to be earned and not assumed.** `refs` sat in the
 * computable half from the day it was declared, with the sentence below
 * promising an operator that the next reconcile would write the difference —
 * while `converge.ts` had no case for it and the only function that swept ran
 * once per outcome. The grading is right now because that case exists, and a
 * sixth change added to the enum without one would put this sentence back into
 * the same lie.
 *
 * A failure that a later attempt fixed is not reported: the log keeps both, and
 * only the last one is the state of the world.
 */
/**
 * Today's spend against `limits.day_usd` (#637). `warn` when a ceiling is set
 * and runs reported no cost: the ceiling cannot see them (#332). `fail` only
 * where the figure is malformed.
 */
export async function spendToday(
  read: () => Promise<{ day: DaySpend; ceilingUsd: number | undefined }> = readDaySpend,
): Promise<CheckResult> {
  const name = 'spend: today'
  try {
    const { day, ceilingUsd } = await read()
    const detail = daySpendText(day, ceilingUsd)
    if (ceilingUsd !== undefined && day.unknown > 0) {
      return {
        name,
        status: 'warn',
        title: `${day.unknown} of today's runs reported no cost`,
        detail: `the daily ceiling cannot see them\n${detail}`,
      }
    }
    return { name, status: 'ok', detail }
  } catch (err) {
    return { name, status: 'fail', title: "today's spend could not be read", detail: (err as Error).message }
  }
}

/**
 * The grading, pulled out of the read so a test can hand it rows directly
 * (`#389`) — the same split `recipeRow` gets, and for the same reason.
 *
 * **A row whose project is in `unresolved` is `fail`, not `warn`.** The
 * sentence *"the next reconcile recomputes and writes the difference"* is
 * false for that project: `clientsForProjects` drops a project whose recipe
 * will not resolve rather than handing `convergeIssues` the raw client (see
 * its own doc comment), so nothing is going to write anything until the
 * recipe does resolve — a fact for a person, kept only for the rows whose
 * project is not in the map.
 */
export function unconvergedRow(
  rows: readonly UnconvergedUpdate[],
  titles: TitleBook,
  unresolved: ReadonlyMap<string, string>,
): CheckResult {
  const name = 'github: what we said and did not manage'
  if (rows.length === 0) {
    return { name, status: 'ok', detail: 'every issue carries what the log last said about it' }
  }

  const comments = rows.filter((r) => r.change === 'comment')
  const computable = rows.filter((r) => r.change !== 'comment')
  const named = (r: { project: string; issue: string; change: string }) =>
    say(titles, `${r.project}#${r.issue}`, r.change)
  const commentTail = comments.length > 0 ? ` ${comments.length} comment(s) it cannot, which need a person.` : ''

  if (computable.length === 0) {
    return {
      name,
      status: 'warn',
      title: `${comments.length} comment(s) were never posted`,
      detail:
        'a comment is not computable from state, so nothing will converge it; say it by hand if it still matters\n' +
        comments.slice(0, 4).map(named).join(', '),
    }
  }

  const blocked = computable.filter((r) => unresolved.has(r.project))
  if (blocked.length > 0) {
    const problems = [...new Set(blocked.map((r) => r.project))].map((p) => `${p} (${unresolved.get(p)})`)
    const rest = blocked.length < computable.length ? ' The next reconcile recomputes the rest.' : ''
    return {
      name,
      status: 'fail',
      title: `${blocked.length} issue(s) cannot converge until a recipe resolves`,
      detail:
        `${blocked.length} of ${computable.length} diverged issue(s) wait on a recipe that does not resolve` +
        `\n${problems.join(', ')}` +
        (rest === '' ? '' : `\n${rest.trim()}`) +
        (commentTail === '' ? '' : `\n${commentTail.trim()}`) +
        '\n' +
        computable.slice(0, 4).map(named).join(', '),
    }
  }

  return {
    name,
    status: 'warn',
    title: `${computable.length} issue(s) on GitHub differ from the log`,
    detail:
      'the next reconcile recomputes and writes the difference' +
      (comments.length > 0 ? `; ${comments.length} comment(s) it cannot, which need a person` : '') +
      '\n' +
      computable.slice(0, 4).map(named).join(', '),
  }
}

async function unconverged(
  queries: LogQueries,
  titles: TitleBook,
  unresolved: ReadonlyMap<string, string>,
): Promise<CheckResult> {
  const rows = await queries.unconvergedUpdates().catch(() => null)
  if (rows === null)
    return { name: 'github: what we said and did not manage', status: 'ok', detail: 'no log to read yet' }
  return unconvergedRow(rows, titles, unresolved)
}

/**
 * Subscribers that were handed an event and did not come back from it.
 *
 * The half of `#120` that is not about the `.catch`. A subscriber's failure was
 * a console line and nothing else, and the console line is gone by morning — so
 * **a notifier that has silently stopped notifying looked exactly like a quiet
 * week**, which is the one failure a notifier must not have. The boundary in
 * `work-loop.ts` appends `PluginFailed` now, and this is what reads it back;
 * without something that does, the event would be a second thing nobody looks
 * at rather than a fix.
 *
 * **Bounded to a day, and `warn` rather than `fail`.** Nothing converges a
 * subscriber failure — 0015's other rule is that a subscriber is never retried,
 * because its effects are worthless late — so an all-time count would be red
 * for ever over a notifier that broke once in March, and a check that is always
 * red is a check nobody reads. Older failures are still counted in the detail,
 * because "and 400 before that" is the sentence that turns one bad night into a
 * subscriber that has never worked.
 *
 * **The day is measured here and the rows are counted in the store.** Which
 * window is worth being red over is this command's rule and not a log's, so it
 * is the parameter `subscriberFailures` takes.
 */
async function subscribers(queries: LogQueries): Promise<CheckResult> {
  const rows = await queries.subscriberFailures(new Date(Date.now() - A_DAY_MS)).catch(() => null)
  return subscriberRow(rows)
}

type SubscriberFailures = Awaited<ReturnType<LogQueries['subscriberFailures']>>

/** The row for what `subscriberFailures` found; `null` is a log that could not be read. Pure, so its text is testable. */
export function subscriberRow(rows: SubscriberFailures | null): CheckResult {
  const name = 'subscribers: failures'
  if (rows === null) return { name, status: 'ok', detail: 'no log to read yet' }

  const recent = rows.filter((r) => r.recent > 0)
  const older = rows.reduce((n, r) => n + r.total - r.recent, 0)
  if (recent.length === 0) {
    return {
      name,
      status: 'ok',
      detail:
        older === 0
          ? 'every subscriber returned'
          : `nothing in the last day; ${older} older failure(s) the log still holds`,
    }
  }
  // A subscriber's own reason can end with a placeholder command (`lingtai env set <project> …`);
  // the real one is the row's `fix`, so the reason stops at its first ` — `.
  const reason = (recent[0]?.lastReason ?? '?').split('\n')[0]!.split(' — ')[0]!
  const counts = recent.length === 1 ? `${recent[0]!.recent}` : recent.map((r) => `${r.name} ×${r.recent}`).join(', ')
  const row: CheckResult = {
    name,
    status: 'warn',
    title: `${recent.map((r) => r.name).join(' and ')} notifications are failing`,
    detail: `${counts} in the last day · ${reason}`,
  }
  failingOf.set(
    row,
    recent.map((r) => r.name),
  )
  return row
}

/** A client for a reader that asks GitHub nothing; any question it is asked is a bug, said so. */
const offlineClient = new Proxy({} as GitHubClient, {
  get: (_target, key) => {
    // Not a thenable: an `async` function returning this looks for `then`.
    if (key === 'then' || typeof key === 'symbol') return undefined
    throw new Error(`no GitHub auth configured, so GitHub cannot be asked (${String(key)})`)
  },
})

/**
 * The client `recipe:` resolves with. The recipe is this machine's file (#180),
 * so no App is needed to check it: without one, the client refuses every
 * question, nothing in a resolve asks one, and `github: app credentials`
 * already says the App is missing.
 */
export function recipeClientFor(env: NodeJS.ProcessEnv): ClientFor {
  return hasGitHubAuth(env) ? githubClientFor : async () => offlineClient
}

/** One line per value, `key  value ← where`, indented under the row. */
export function provenanceLines(provenance: Readonly<Record<string, string>>): string {
  return Object.entries(provenance)
    .map(([key, from]) => `         ${key.padEnd(24)} ${from}\n`)
    .join('')
}

/**
 * One resolve per registered project, shared by every row below that grades
 * one — `recipe:`'s own row, and since `#389` the `unconverged` rows, which
 * need to say when a divergence belongs to a project reconcile has dropped.
 * **Do not resolve the recipe a second time**: this is the one place that
 * calls `projectFilters`, and both callers below are handed its result.
 *
 * `null` where the project streams themselves could not be read — the same
 * fact `projectRecipes` used to discover on its own, kept as its own `skip`.
 */
async function projectFiltersOnce(
  env: NodeJS.ProcessEnv,
  load: typeof loadProjects,
  recipe: RecipeFor = currentRecipe,
): Promise<readonly ProjectFilter[] | null> {
  const projects = await load().catch(() => null)
  if (projects === null) return null
  return projectFilters(projects, recipeClientFor(env), recipe)
}

/** Each unresolved filter's project, against the recipe's own problem. */
function unresolvedProblems(filters: readonly ProjectFilter[] | null): ReadonlyMap<string, string> {
  return new Map(
    (filters ?? []).filter((f): f is ProjectFilter & { ok: false } => !f.ok).map((f) => [f.project, f.problem]),
  )
}

/**
 * Per project: does its recipe resolve at all, and what will it therefore take.
 *
 * **A fail, not a skip** (#76). This was in `DEFERRED`, on the argument that a
 * recipe read here would be "a different commit's" than the one a run reads.
 * That argument was about the wrong thing. The run reads
 * `~/.lingtai/<project>/recipe.yml` (#180) and so does this, via the same
 * `currentRecipe`; and the question being
 * asked is not "will this exact commit's gates pass", it is "does the file that
 * governs the next run parse" — which was `no` on `main` for long enough that
 * every issue in the project sat unpicked, with doctor green throughout.
 *
 * The detail is `ProjectFilter`'s, the same value `lingtai daemon` prints at
 * startup and `lingtai status` prints per project. Three commands, one answer.
 */
async function projectRecipes(filters: readonly ProjectFilter[] | null): Promise<CheckResult[]> {
  const name = 'recipe: resolves for every project'
  if (filters === null) {
    return [{ name, status: 'skip', detail: 'the project streams could not be read' }]
  }
  if (filters.length === 0) {
    return [{ name, status: 'ok', detail: 'nothing is registered, so no recipe governs anything' }]
  }

  // **The dispatched runtime is the project's own, not this machine's** (`#313`).
  // It defaulted to `createClaudeCodeRuntime().capabilities.id`, and a default
  // that is right for one project and silently wrong for the next is how `#89`
  // was possible — so it is deleted rather than re-pointed. `conduct.ts`
  // constructs from this same field, which is what makes the answer true: the
  // `runtime.agent` half of `agentRefusal` is now an assertion that the caller
  // picked correctly, and the half that still refuses is a step's own `agent:`.
  // `""` where the recipe did not resolve, and `recipeRow` never reads it there:
  // nothing was dispatched, because there was no recipe to name a runtime.
  // **What this machine can dispatch beyond each project's own** (`#314`). One
  // cached probe for the whole report rather than one per project: the answer is
  // about the machine, and `signedInProbe` remembers it for a minute anyway.
  const signedIn = await signedInHere()
  return filters.map((f) => recipeRow(f, f.ok ? f.recipe.runtime.agent : '', signedIn))
}

/**
 * The line an operator has to change, for the `agent:` that was refused.
 *
 * **Two refusals, two files, and one instruction for both is a wrong one**
 * (`#245`). Both live in `recipePath()` since `#372` — `runtime.agent` beside
 * `steps:`, and a step's own `agent:` on the step — but they are different
 * lines: a row that named `runtime.agent` for a step's refusal sent the
 * operator to a line that is *already* the dispatched runtime — it is what
 * `dispatched` was compared against and matched — so re-writing the same value
 * there changes nothing and the project goes on taking no work, with the line
 * that must change never mentioned.
 *
 * **The step's half stopped saying *name the other one* in `#314`.** Per-step
 * dispatch is built, so a step naming a second runtime is legal; what is refused
 * is a runtime nothing on this machine is signed in to, and the two ways out of
 * that are signing in and naming something else. `lingtai doctor`'s own
 * `runtime: signed in` row is where the first is checked.
 *
 * **And the step's half names the key rather than assuming `agent:`** (`#277`).
 * A `judge:` may name a runtime too, and it is the same refusal for the same
 * reason — so the remedy takes the key off the refusal, because *Name `agent:`
 * …* over a `judge:` line is the same wrong instruction `#245` fixed one level
 * up: an operator sent to edit a key the line does not have.
 */
function agentRemedy(refused: AgentRefusal, project: string, dispatched: string): string {
  return refused.at === 'runtime.agent'
    ? `Name runtime.agent: ${dispatched} in ${recipePath(project)}; it is what this conductor was asked to dispatch`
    : `Sign in to it, or name a runtime this machine has as that action's ${refused.key}: in ` +
        `${recipePath(project)} — see the runtime: signed in row above`
}

/**
 * One project's `recipe:` row.
 *
 * **A recipe that resolves is not yet one that runs.** An `agent:` may name a
 * runtime this conductor does not dispatch — `runtime.agent`, or a step's own
 * since `#245` — and `runOnce` refuses every pass of such a project before its
 * claim (#180) — so that is a `fail` here, in `runOnce`'s own sentence, and not
 * an `ok` that prints the agent and says nothing of it.
 */
export function recipeRow(f: ProjectFilter, dispatched: string, signedIn: readonly string[] = []): CheckResult {
  const wrongAgent = f.ok ? agentRefusal(f, dispatched, signedIn) : null
  if (f.ok && wrongAgent !== null) {
    return {
      name: `recipe: ${f.project}`,
      status: 'fail',
      detail:
        `${wrongAgent.sentence} — every run of this project is refused before its claim, and nothing will be taken. ` +
        `${agentRemedy(wrongAgent, f.project, dispatched)}\n` +
        provenanceLines(f.provenance),
    }
  }
  return f.ok
    ? {
        name: `recipe: ${f.project}`,
        status: 'ok' as const,
        detail:
          `${f.configHash.slice(0, 12)} for ${f.ref} · picks up ${f.kinds.join(' > ')} · ` +
          `excludes ${f.exclude.length > 0 ? f.exclude.join(', ') : 'nothing'}\n` +
          // The resolved recipe and where each value came from (#180): the
          // recipe file, the machine file, detection or a default. Four
          // places cannot be read by opening one file, so they are said here.
          provenanceLines(f.provenance) +
          // What a pass of this project may cost, from the same function
          // `lingtai add` and the board's chip call (0039 §3). Doctor is
          // where an operator looks before starting something, which makes
          // it the place this number is most worth knowing — and it is the
          // one number here that is a product rather than a setting.
          `         a pass: ${passCeiling(f.limits)}`,
      }
    : {
        name: `recipe: ${f.project}`,
        status: 'fail' as const,
        detail:
          `${f.problem} — nothing will be taken from this project, ` +
          // Said even where the log holds no `IssueUpdateFailed` row for this
          // project yet — the common case, since nothing claiming a divergence
          // has a reason to exist before the recipe ever resolved (`#389`).
          'and reconcile cannot converge its labels, closes or leftover arms either',
      }
}

/**
 * Per project: every limit its recipe declares, and whether the runtime applies it.
 *
 * `#89`, asked before a run instead of discovered after one. `turns: 150` was
 * declared, threaded to the request, printed in `RunStarted` and read by
 * nothing while `#84` ran 172 — and every one of those signals said the bound
 * existed.
 *
 * **The runtime is the one that runs, which since `#313` is the one the recipe
 * names.** It used to be `createClaudeCodeRuntime()` unconditionally, because
 * that was what every run was handed and a recipe naming another agent was
 * refused before its claim. Now `conduct.ts` constructs from
 * `runtime.agent`, so the recipe's field *is* the runtime that runs and reading
 * it is the only way to answer for the adapter that will be started. The caller
 * passes it; there is no default, because a default that is right for one
 * project and silently wrong for the next is how `#89` was possible.
 *
 * **Any declared limit the runtime does not apply is `fail`, and the size of it
 * is in the sentence rather than in the status.**
 *
 * For one round this was a `warn` wherever *some* other limit still bound, on the
 * grounds that a Codex project cannot clear it: `enforces` is `["wall"]` —
 * measured, `codex exec` has no `--max-turns` and no flag of any name bounds
 * turns — and `runtime.limits.turns` has a schema default of `300` that is always
 * present, so red there is red for ever and `CheckStatus`'s docstring names that
 * trap. **The downgrade cost more than the trap.** `RUN_LIMITS` was two names then
 * and every runtime in `RUNTIMES` applies at least one of them, so `fail` became a
 * branch no real project could reach, and the state `#89` was built to catch
 * reported `warn` —
 * which `gatingFailures` does not count (`restart.ts`), so `lingtai restart` would
 * start a daemon and a pass could run 172 turns against a declared 150 with
 * nothing red anywhere. That is `#84` verbatim, with the check that exists to
 * catch it passing.
 *
 * So the red is back, and it is a **true** sentence about a runtime that cannot
 * keep a bound the recipe declares. There are two levers and both are named:
 * `runtime.agent`, a runtime that applies it, or `runtime.limits.turns:
 * unbounded` (`#547`), which is the recipe saying *"I accept an unbounded turn
 * count"*. **That is a choice and not a promise, so it is not checked**: `turns:
 * unbounded` is excluded from `ignored` the way an undeclared `usd` is. A number
 * on a runtime that cannot hold it stays `fail` — softening it is a decision for
 * a person and not a status this function should soften — and so does a step's
 * own `limits.turns` on that runtime, which the ceiling being `unbounded` would
 * otherwise hide (`declaresTurnsOn`).
 *
 * The two sizes are still told apart, because they are not the same failure: a
 * limit carried beside one that binds is spend the wall will still stop, and a
 * runtime applying **none** of them is a run nothing will ever stop. Both are red;
 * the detail says which.
 *
 * Here rather than in the schema: whether a limit binds is a fact about the
 * recipe *and* the adapter, which a field's parse cannot see. A `fail` is how the
 * schema's acceptance stops being silent.
 */
export function limitsRow(project: string, recipe: Recipe, capabilities: RuntimeCapabilities): CheckResult {
  const name = `runtime: ${project} limits`
  // `usd` has no default (recipe.ts), so unlike `turns` and `wall` it can be
  // genuinely absent — and absent is never "ignored": a Codex project with no
  // `runtime.limits.usd` declared has nothing for Codex to fail at holding.
  const declaredUsd = ceilingOf(recipe).usd
  // `turns: unbounded` is the same shape (`#547`): a choice to promise nothing,
  // unless a dispatch on this very runtime narrows it to a number anyway.
  const declaredTurns = ceilingOf(recipe).turns !== UNBOUNDED || declaresTurnsOn(recipe, capabilities.id)
  const declared: Record<(typeof RUN_LIMITS)[number], string> = {
    // The ceiling beside its provenance: this row is about what the recipe
    // says (`#375`) and whether the runtime applies it, and a step's
    // reduction is neither (`#314`).
    turns: String(ceilingOf(recipe).turns),
    wall: ceilingOf(recipe).wall,
    usd: declaredUsd === undefined ? 'none declared' : `$${declaredUsd}`,
  }
  const ignored = RUN_LIMITS.filter(
    (limit) =>
      (limit !== 'usd' || declaredUsd !== undefined) &&
      (limit !== 'turns' || declaredTurns) &&
      !capabilities.enforces.includes(limit),
  )
  const detail = RUN_LIMITS.map((limit) =>
    limit === 'usd' && declaredUsd === undefined
      ? 'usd — none declared'
      : limit === 'turns' && !declaredTurns
        ? 'turns — unbounded'
        : `${limit} ${declared[limit]} ← ${
            capabilities.enforces.includes(limit) ? `applied by ${capabilities.id}` : 'not applied'
          }`,
  ).join(' · ')

  if (ignored.length === 0) return { name, status: 'ok', detail }

  const applied = RUN_LIMITS.filter((limit) => capabilities.enforces.includes(limit))
  const carries =
    `${capabilities.id} carries ${ignored.join(' and ')} and bounds nothing ` +
    `with ${ignored.length === 1 ? 'it' : 'them'}`
  // `wall` is named at `runtime.agent`, because no edit to the recipe clears
  // it. `turns` also clears by being written `unbounded` (`#547`), and `usd`
  // has no default (recipe.ts), so it clears by deleting the line that
  // declared it — each named here rather than folded into "name a runtime",
  // which is not the only lever for either.
  const namedIgnored = ignored.filter((limit) => limit !== 'usd')
  const unboundedWay = ignored.includes('turns')
    ? ", or write runtime.limits.turns: unbounded (and drop any step's limits.turns) to accept no turn ceiling"
    : ''
  const lever =
    namedIgnored.length === 0
      ? 'The lever is deleting runtime.limits.usd, or naming a runtime that applies usd'
      : `The lever is runtime.agent — name a runtime that applies ${namedIgnored.join(' and ')}${unboundedWay}` +
        (ignored.includes('usd') ? '. usd also clears by deleting runtime.limits.usd' : '')
  return {
    name,
    status: 'fail',
    detail:
      `${detail} — ${carries}, so the recipe declares a spend nothing will stop. ` +
      // Both are red; which one this is decides what an overspending run costs.
      (applied.length === 0
        ? 'Nothing will stop a run of this project at all. '
        : `What still stops one is ${applied.join(' and ')}, and not ${ignored.join(' or ')}. `) +
      lever,
  }
}

/**
 * Per project: every name its recipe requires, and **which layer answered**.
 *
 * The half of [ADR 0020](../../../doc/decisions-archive/0020-the-agent-environment-in-layers.md)
 * that costs nothing. The other half — refusing the project — happens in
 * `runOnce`, after a pass has already been started and a recipe fetched; this
 * answers the same question before anyone spends anything, which is what makes
 * the difference between `lingtai run` in your shell and `lingtai daemon` under
 * launchd visible rather than guessed at. Run doctor in the daemon's own
 * environment and the discrepancy is in the output.
 *
 * **Names only, never values.** A `.env` file's whole point is that its contents
 * do not appear in a terminal, a screenshot or a paste.
 *
 * A missing name is a `fail` here, because the run it describes cannot happen.
 * That is the one place doctor is allowed to be red about a project rather than
 * about the installation: a red that names the file to write is a red somebody
 * can clear.
 */
/**
 * Where an extension runs, which is the whole of what
 * [0015](../../../doc/decisions-archive/0015-five-gates-and-two-extensions.md) lets an
 * extension be: **in the loop, where the loop waits for it, or off the log,
 * where it cannot change an outcome.** Nothing else about the two differs, and
 * every question worth asking about a broken one turns on it.
 */
export interface DeclaredExtension {
  name: string
  env: readonly string[]
  where: 'step' | 'subscriber'
}

/**
 * Every extension a recipe declares, and the names it asked for.
 *
 * A `run:` action at any of the four steps `runPlugin.at` allows — `prepared`,
 * `build`, `proposed`, `merge`, and the recipe refuses one at the other six —
 * and every subscriber: that is everything which extends Lingtai without
 * declaring anything. A plugin declares a key, its fields and the steps it
 * serves, and today every declaration lives in `PLUGINS`; what
 * [0067](../../../doc/decisions-archive/0067-a-plugin-is-a-declaration-and-an-implementation.md)
 * lets come from elsewhere is that declaration, and the code under it is still a
 * subprocess with an env of its own to collect. *Four of the ten* is 0067 §2's
 * whole argument for opening the registry, so it is the number to read off `at`
 * rather than off this sentence.
 *
 * Reading the recipe's own shape rather than a list of steps here meant that the
 * five steps 0058 §3 added were covered by arithmetic instead of by remembering
 * — which is what 0037 §2's *"there is no plugin system, an extension is a
 * command"* was written for, and it has now been collected on. That sentence is
 * the one this function was written against and not 0067's: 0067 supersedes §2
 * afterwards, and takes none of the arithmetic back.
 */
export function declaredExtensions(recipe: Recipe): DeclaredExtension[] {
  const out: DeclaredExtension[] = []
  for (const step of Object.values(recipe.steps)) {
    for (const action of step) {
      if ('run' in action) out.push({ name: action.name, env: action.env, where: 'step' })
    }
  }
  for (const subscriber of recipe.subscribers) {
    out.push({ name: subscriber.name, env: subscriber.env, where: 'subscriber' })
  }
  return out
}

/**
 * Per project: what each extension asked for, and whether this machine holds it.
 *
 * The half of [0037](../../../doc/decisions-archive/0037-an-extension-is-a-command.md)
 * §1 that costs nothing, for the reason `declaredEnvironment` above it exists:
 * an extension's declaration is the *whole* of what its process gets, so a name
 * this machine does not hold is a Telegram bot that starts, finds no token and
 * exits — during a run, where the exit code of a subscriber is discarded and
 * nobody is told. Asking before a run is the only cheap time to ask.
 *
 * **Names only, never values**, exactly as the agent's row is.
 *
 * **How red depends on where the extension runs, because that is what a missing
 * name costs.** A `run:` action at a gate point is in the loop and the loop
 * waits for its verdict, so a name it will not find refuses every pass — after
 * a worktree and an install, which is money. That is a `fail`. A subscriber
 * runs off the log and cannot change an outcome (0015), so what a missing name
 * costs is the notification and nothing else; every event it is owed appends
 * `PluginFailed` saying so, which `subscribers: failures` reads back. That is a
 * `warn`.
 *
 * It was a `fail` for both, and that was wrong in the way a check is wrong when
 * nobody can clear it: this machine declares `telegram` and holds neither of
 * its names, so `lingtai doctor` has been red for weeks over a notification
 * nobody asked for yet — and `lingtai restart` is gated on doctor
 * ([0042](../../../doc/decisions-archive/0042-the-restart-is-a-command.md)), so
 * `--despite-doctor` became the ordinary way to restart. **A red that is always
 * on is not a check, it is a habit.** `subscribers: failures` had already
 * reached this conclusion about the same subscriber — *a check that is always
 * red is a check nobody reads* — one row away, for the same fact.
 *
 * What stays a `fail` for either is a declared name whose *value* looks like
 * production (`#51`): that is a credential about to be handed out, not a
 * feature that will not run.
 */
export function extensionRow(
  project: string,
  recipe: Recipe,
  agentEnv: { names: readonly { name: string; layer: string }[]; merged: Record<string, string>; file: string },
): CheckResult {
  const { result, short } = extensionOutcome(project, recipe, agentEnv)
  shortOf.set(result, short)
  return result
}

/** The row, and the names of the extensions short of a variable — as data, so nobody parses the `fix` to learn them. */
function extensionOutcome(
  project: string,
  recipe: Recipe,
  agentEnv: { names: readonly { name: string; layer: string }[]; merged: Record<string, string>; file: string },
): { result: CheckResult; short: Record<DeclaredExtension['where'], string[]> } {
  const name = `env: ${project} extensions`
  const short: Record<DeclaredExtension['where'], string[]> = { step: [], subscriber: [] }
  const extensions = declaredExtensions(recipe)
  const asking = extensions.filter((e) => e.env.length > 0)

  if (asking.length === 0) {
    return {
      short,
      result: {
        name,
        status: 'ok',
        detail:
          extensions.length === 0
            ? 'no extension is declared'
            : `${extensions.length} declared, none asking for a variable — each gets PATH and nothing else`,
      },
    }
  }

  // The production tripwire over what each extension would be handed, which
  // `resolveAgentEnv` does not see: it checks the agent's values, after `deny`,
  // and an extension reads its names from the merged files. Named, never valued.
  for (const extension of asking) {
    try {
      extensionEnv(agentEnv.merged, extension.env, productionPatterns(recipe.env.refuseHosts))
    } catch (err) {
      return { short, result: { name, status: 'fail', detail: `${extension.name}: ${(err as Error).message}` } }
    }
  }

  const layerOf = new Map(agentEnv.names.map((n) => [n.name, n.layer]))
  const missing: Record<DeclaredExtension['where'], string[]> = { step: [], subscriber: [] }
  const detail = asking
    .map((extension) => {
      const names = extension.env.map((variable) => {
        const layer = layerOf.get(variable) ?? 'not set'
        if (!(variable in agentEnv.merged)) {
          missing[extension.where].push(variable)
          if (!short[extension.where].includes(extension.name)) short[extension.where].push(extension.name)
        }
        return `${variable} ← ${layer === 'project file' ? basename(agentEnv.file) : layer}`
      })
      return `${extension.name}: ${names.join(', ')}`
    })
    .join(' · ')

  const absent = [...new Set([...missing.step, ...missing.subscriber])]
  if (absent.length === 0) return { short, result: { name, status: 'ok', detail } }

  // A gate action decides the pass, so one missing name is red however many
  // subscribers are also short: the worst outcome sets the row.
  const inTheLoop = missing.step.length > 0
  const shortNames = [...short.step, ...short.subscriber]
  return {
    short,
    result: {
      name,
      status: inTheLoop ? 'fail' : 'warn',
      title: `${shortNames.join(' and ')} ${shortNames.length === 1 ? 'is' : 'are'} missing environment variables`,
      detail:
        `${detail}\n${absent.join(', ')} declared by an extension and not set in either file. ` +
        `An extension gets only what it declares, so it would run without them — ` +
        (inTheLoop
          ? `and a step's action verdict is what the loop waits for, so every pass is refused after a worktree and an install.`
          : `a subscriber runs off the log and changes no outcome, so what is lost is the notification, once per event, as a PluginFailed.`),
      fix: [
        ...absent.map((variable) => `lingtai env set ${project} ${variable}`),
        // Removing a step extension is the wrong advice: it is the gate.
        ...(inTheLoop ? [] : short.subscriber.map((n) => `or remove the ${n} subscriber`)),
      ].join('\n'),
    },
  }
}

/** Which extensions each row was short of, and which subscribers a failure row names: facts `shareFixes` reads without parsing text. */
const shortOf = new WeakMap<CheckResult, Record<DeclaredExtension['where'], string[]>>()
const failingOf = new WeakMap<CheckResult, string[]>()

/** A copy of the row with its time; the facts above are keyed by the row object, so they move to the copy. */
export function timed(row: CheckResult, ms: number): CheckResult {
  const copy = { ...row, ms }
  const short = shortOf.get(row)
  if (short !== undefined) shortOf.set(copy, short)
  const failing = failingOf.get(row)
  if (failing !== undefined) failingOf.set(copy, failing)
  return copy
}

/**
 * The subscriber row takes the `fix` of the one project row that is short of exactly that subscriber, so the
 * two are one problem drawn once. Nothing is copied when the match is not unique: `subscriberFailures` groups
 * by name and not by project, so two projects declaring the same subscriber could not be told apart.
 */
export function shareFixes(results: readonly CheckResult[]): void {
  const row = results.find((r) => failingOf.has(r))
  const failing = row === undefined ? [] : (failingOf.get(row) ?? [])
  if (row === undefined || failing.length !== 1) return
  const matches = results.filter((r) => {
    const s = shortOf.get(r)
    return s !== undefined && s.step.length === 0 && s.subscriber.length === 1 && s.subscriber[0] === failing[0]
  })
  if (matches.length === 1 && matches[0]!.fix !== undefined) row.fix = matches[0]!.fix
}

/**
 * Per project: **is the runtime this project will dispatch signed in?**
 *
 * The question `runtime: signed in` stopped being able to answer (`#313`). That
 * row asked `createClaudeCodeRuntime()` alone while that was the only runtime
 * dispatched, so it *was* the per-project answer; since it asks every runtime and
 * goes green on any one of them, a machine signed in to Codex alone reads `ok`
 * beside a project whose recipe carries the schema default
 * `runtime.agent: claude-code` (`recipe.ts`), and the next pass spawns `claude`
 * and dies on *"Not logged in"*. Neither `recipeRow` nor `limitsRow` closes it:
 * the first now compares `runtime.agent` with itself, and the second reads
 * `enforces` and asks nothing about auth.
 *
 * **One probe per runtime and not per project**, memoised in `asked`: the answer
 * is a fact about the machine, and `claude`/`codex login status` is a spawn.
 *
 * `skip` where the runtime cannot be asked cheaply — a row that guessed would be
 * the thing `runtime: signed in` already refuses to do.
 */
async function dispatchedAuthRow(
  project: string,
  agent: RuntimeId,
  asked: Map<RuntimeId, AuthStatus | null>,
  // Found in the injected list rather than built with `createRuntime`, so a
  // test can hand in a fake `checkAuth` instead of spawning the real binary.
  runtimes: readonly Pick<Runtime, 'capabilities' | 'checkAuth'>[] = everyRuntime(),
  label: string = 'runtime',
  // The recipe keys that name `agent`, for the remedy sentence.
  keys: readonly string[] = ['runtime.agent'],
  // Exactly what a run gets. Not `process.env` — except the `CODEX_HOME` a
  // triage checkout is given, which the caller adds and keeps its own cache for.
  env: Record<string, string> = runnableEnv({}),
): Promise<CheckResult> {
  const name = `${label}: ${project} signed in`
  if (!asked.has(agent)) {
    const runtime = runtimes.find((r) => r.capabilities.id === agent)
    asked.set(agent, runtime?.checkAuth ? await runtime.checkAuth(env) : null)
  }
  const status = asked.get(agent) ?? null
  if (status === null) {
    return { name, status: 'skip', detail: `${agent} cannot be asked cheaply` }
  }
  if (status.loggedIn) return { name, status: 'ok', detail: `${agent} — ${status.detail}` }
  return {
    name,
    status: 'fail',
    detail:
      `${agent} reports ${status.detail}, and ${project}'s recipe names it at ${keys.join(', ')} — ` +
      `so that is what its next call constructs and spawns. Sign in, or name a runtime this ` +
      `machine has at ${keys.join(', ')} in ${recipePath(project)}. If you are signed in yourself, the call's environment ` +
      `is missing something the credential store needs — see runtime: signed in.`,
  }
}

/** Check the separately billed, tool-free route named by a recipe role. */
function codexRoleRow(
  project: string,
  role: 'discuss' | 'triage',
  model: string | undefined,
  configured: () => CodexTextConfig | undefined,
): CheckResult {
  const name = `${role}: ${project} codex ready`
  try {
    const config = configured()
    if (!config) throw new ToolsCannotBeDenied('codex')
    // The same factory used at dispatch; never probe the Codex CLI as a substitute.
    createRuntime('codex', { tools: 'none', codexText: { config } })
    if (model && model !== config.model) {
      return { name, status: 'fail', detail: `${role}.model differs from codex_text.model and its configured prices` }
    }
    return { name, status: 'ok', detail: `model-only API route ready for ${role}; separately billed` }
  } catch (err) {
    const remedy =
      role === 'triage'
        ? ' — or set triage.tools: full to run the Codex CLI with tools on its own login, which needs no codex_text'
        : ''
    return { name, status: 'fail', detail: `${role}.agent: ${(err as Error).message}${remedy}` }
  }
}

export async function declaredEnvironment(
  env: NodeJS.ProcessEnv,
  load: typeof loadProjects = loadProjects,
  reach: Partial<DoctorReach> = {},
): Promise<CheckResult[]> {
  const name = 'env: declared names, and which layer'
  // No App is needed: the recipe is this machine's file (#180), and nothing in
  // this row asks GitHub anything. No owner is needed either (#357): every
  // value this loop reads — `currentRecipe`, `resolveAgentEnv`, `extensionRow`,
  // `limitsRow` and `dispatchedAuthRow` — takes the project name alone.
  const projects = await load().catch(() => null)
  if (projects === null) {
    return [{ name, status: 'skip', detail: 'the project streams could not be read' }]
  }
  if (projects.length === 0) {
    return [{ name, status: 'ok', detail: 'no project has a recipe to declare anything yet' }]
  }

  const recipeFor = reach.recipe ?? currentRecipe
  const agentEnvFor = reach.agentEnv ?? resolveAgentEnv
  const runtimes = reach.runtimes?.() ?? everyRuntime()

  const results: CheckResult[] = []
  /** One spawn per runtime across every project — see `dispatchedAuthRow`. */
  const asked = new Map<RuntimeId, AuthStatus | null>()
  const askedTriageCli = new Map<RuntimeId, AuthStatus | null>()
  for (const project of projects) {
    if (!project.project) {
      results.push({
        name: `env: ${project.project ?? '(unnamed)'}`,
        status: 'skip',
        detail: 'no repository name recorded — re-run lingtai add',
      })
      continue
    }
    const label = `env: ${project.project}`
    try {
      const resolved = await recipeFor(project, undefined)
      // Every name either file offers, and which one answered — 0021 makes
      // this load-bearing rather than nice: "the operator is responsible" is
      // only true where the operator can see what is happening. Names only,
      // never values.
      const agentEnv = await agentEnvFor({
        project: project.project,
        required: resolved.recipe.env.required,
        allow: resolved.recipe.env.allow,
        deny: resolved.recipe.env.deny,
        patterns: productionPatterns(resolved.recipe.env.refuseHosts),
      })

      if (agentEnv.names.length === 0) {
        results.push({
          name: label,
          status: 'ok',
          detail: `nothing required · ${basename(agentEnv.file)} is where a value would go`,
        })
      } else {
        // A name that resolved but does not reach the agent is worth saying: it
        // is the `deny` half of the recipe doing its job, and it is invisible in
        // the values.
        const detail = agentEnv.names
          .map((n) => {
            const where = n.layer === 'project file' ? basename(agentEnv.file) : n.layer
            const held = n.layer !== 'not set' && !(n.name in agentEnv.values)
            return `${n.name} ← ${where}${held ? ' (denied)' : ''}`
          })
          .join(' · ')
        results.push({
          name: label,
          status: agentEnv.missing.length > 0 ? 'fail' : 'ok',
          detail: agentEnv.refusal ? `${detail}\n${agentEnv.refusal}` : detail,
        })
      }
      results.push(extensionRow(project.project, resolved.recipe, agentEnv))
      results.push(
        limitsRow(project.project, resolved.recipe, createRuntime(resolved.recipe.runtime.agent).capabilities),
      )
      // Whether the runtime named above can actually be started — a different
      // question from whether its declared limits bind, and the one nothing
      // asked between `runtimeAuth` becoming per-machine and this row.
      // Every agent the recipe will dispatch, once each: `runtime.agent` always
      // (an unconfigured `implement` runs on it), then each step's agent action
      // and each judge that names a runtime. Same test as `agentRefusal` — a
      // built-in judge is a function, not a dispatch.
      const needed = new Map<RuntimeId, string[]>([[resolved.recipe.runtime.agent, ['runtime.agent']]])
      const need = (agent: RuntimeId, key: string) => needed.set(agent, [...(needed.get(agent) ?? []), key])
      for (const [step, actions] of Object.entries(resolved.recipe.steps)) {
        for (const action of actions) {
          if ('agent' in action) need(action.agent, `steps.${step}.agent`)
          else if ('judge' in action && !isBuiltInJudge(action.judge)) {
            need(action.judge as RuntimeId, `steps.${step}.judge (when: ${action.when})`)
          }
        }
      }
      for (const [agent, keys] of needed) {
        const row = await dispatchedAuthRow(project.project, agent, asked, runtimes, 'runtime', keys)
        const onRuntime = agent === resolved.recipe.runtime.agent
        results.push({
          ...row,
          // Two agents in one project are two rows, so the second names itself.
          name: onRuntime ? row.name : `steps: ${project.project} ${agent} signed in`,
          detail: keys.length > 1 || !onRuntime ? `${row.detail} · needed by ${keys.join(', ')}` : row.detail,
        })
      }
      for (const role of ['discuss', 'triage'] as const) {
        const selected = resolved.recipe[role]
        if (role === 'triage' && resolved.recipe.triage?.agent === 'codex' && resolved.recipe.triage.tools === 'full') {
          // The login the wait will use: a triage checkout keeps `CODEX_HOME`,
          // which `runnableEnv` strips, so this is asked in its own cache.
          const codexHome = process.env['CODEX_HOME']
          const signedIn = await dispatchedAuthRow(
            project.project,
            'codex',
            askedTriageCli,
            runtimes,
            role,
            [`${role}.agent`],
            codexHome ? { ...runnableEnv({}), CODEX_HOME: codexHome } : runnableEnv({}),
          )
          results.push({
            ...signedIn,
            detail:
              `triage runs the Codex CLI with tools in a disposable checkout of the attempt's head, ` +
              `billed to the Codex login; codex_text is not read. ${signedIn.detail}`,
          })
          results.push({
            name: `triage: ${project.project} limits`,
            status: 'warn',
            detail:
              'Codex CLI route: wall is enforced; turns is passed to the runtime and not enforced; usd is not observed ' +
              '(the CLI receipt carries no dollars), so the out-of-usd check never fires',
          })
        } else if (selected?.agent === 'codex') {
          results.push(
            codexRoleRow(project.project, role, selected.model, reach.codexText ?? (() => codexTextConfig(env))),
          )
        } else if (selected) {
          results.push(
            await dispatchedAuthRow(project.project, selected.agent, asked, runtimes, role, [`${role}.agent`]),
          )
        }
      }
    } catch (err) {
      // Includes `ProductionValueError`, which names the variable and the
      // pattern it matched and no part of the value.
      results.push({ name: label, status: 'fail', detail: (err as Error).message })
    }
  }
  return results
}

/**
 * Per project: is the branch the rules are read from the branch they govern?
 *
 * `runOnce` refuses this at `stage: "recipe"` and `lingtai add` refuses to
 * record it, so a project onboarded from here on cannot be in this state. A
 * project registered *before* those existed can be, and nothing else would say
 * so: the divergence is invisible until a run merges into `repo.base` under
 * gates it read from somewhere else, and every event that run writes is
 * internally consistent — `StepsResolved` carries the hash of the recipe it
 * obeyed, so `steps: end ran on what landed` compares a plan against itself and
 * finds nothing wrong. Comparing the plan's *origin* to the merge
 * target is the only thing that sees it, and this is where that happens without
 * waiting for a run to pay for it.
 *
 * **A failure, and one with no repair behind it.** Both branches are recorded
 * decisions and doctor never writes; which one is meant is a person's answer,
 * given by re-running `lingtai add --base`.
 */
export async function recipeGovernsItsBase(
  env: NodeJS.ProcessEnv,
  load: typeof loadProjects = loadProjects,
  reach: Partial<DoctorReach> = {},
): Promise<CheckResult[]> {
  const name = 'recipe: the rules and the merge target are one branch'
  // No App is needed to compare them: the recipe is this machine's file (#180).
  // No owner either (#357): the comparison is `state.base` against the
  // recipe's own `repo.base`, read straight from the recorded registration —
  // no fetch, no GitHub call, nothing beyond what registration already wrote.

  const projects = await load().catch(() => null)
  if (projects === null) {
    return [{ name, status: 'skip', detail: 'the project streams could not be read' }]
  }
  if (projects.length === 0) {
    return [{ name, status: 'ok', detail: 'no project has a recorded base to disagree with a recipe yet' }]
  }

  const recipeFor = reach.recipe ?? currentRecipe
  const results: CheckResult[] = []
  for (const project of projects) {
    if (!project.project) {
      results.push({
        name: `base: ${project.project ?? '(unnamed)'}`,
        status: 'skip',
        detail: 'no repository name recorded — re-run lingtai add',
      })
      continue
    }
    const label = `base: ${project.project}`
    try {
      const resolved = await recipeFor(project, undefined)
      // The slug `baseDivergence` splices after `lingtai add ` in its own
      // "Re-register:" sentence — a GitHub project names it `owner/repo`; a
      // `--local` one has no owner to name and no directory recorded on
      // `ProjectState` either, so `<dir>` is what the operator fills in
      // (`conduct.ts`'s own convention, `#352`); and an owner-less project
      // with no `repo.remote` is a GitHub project registered before
      // `ProjectConfigured` carried an owner — only the remote tells the two
      // apart (`init.ts`'s own `unrecorded`, `#352`).
      const slug =
        project.owner !== null
          ? `${project.owner}/${project.project}`
          : remoteOf(resolved.recipe) !== null
            ? '--local <dir>'
            : `<owner>/${project.project}`
      const divergence = baseDivergence(resolved, slug)
      results.push(
        divergence
          ? { name: label, status: 'fail', detail: divergence }
          : {
              name: label,
              status: 'ok',
              // The key as this recipe writes it: since `#268` the base may be
              // `worktree:`'s at `admit`, and a row naming the other line is a
              // row that sends a reader to something nothing reads.
              detail:
                `read from ${resolved.ref}, and ` + `${baseWrittenAt(resolved.recipe)} says ${baseOf(resolved.recipe)}`,
            },
      )
    } catch (err) {
      // A skip, not a second failure: an unreadable recipe is already red in the
      // check above, and the comparison genuinely could not be made.
      results.push({ name: label, status: 'skip', detail: `no recipe to compare — ${(err as Error).message}` })
    }
  }
  return results
}

/**
 * Is the Node running this command at or above `.node-version`'s major — the
 * floor `check.yml` actually tests since #430, where the floor `engines`
 * named until then was not.
 *
 * `running` is `process.versions.node`; `declared` is `.node-version`'s
 * trimmed text, or `undefined` where the file could not be read. Compares
 * majors only, by taking the leading integer of each — `26`, `v26.5.0` and
 * `26.5` all parse the same.
 *
 * **The read stays outside this function.** `runDoctor` does it, because
 * under 0060 §1 a test that reads a file is an integration test, and handing
 * `nodeRow` two strings keeps this a unit test that can call it directly.
 *
 * **Not the whole guarantee.** `pnpm lingtai` is `node apps/cli/src/entry.ts`
 * (`package.json`'s `lingtai` script), and a Node that cannot strip types
 * unflagged dies on that `.ts` before this command loads — 22.13 is one of
 * those. This row speaks for the Nodes between that point and the floor;
 * below it, only `engines` speaks.
 */
export function nodeRow(running: string, declared: string | undefined): CheckResult {
  const name = 'node: at or above the floor'
  const major = (v: string): number | undefined => {
    const found = /\d+/.exec(v)
    return found ? Number(found[0]) : undefined
  }
  const declaredMajor = declared === undefined ? undefined : major(declared)
  if (declaredMajor === undefined) {
    return {
      name,
      status: 'fail',
      title: 'the Node version the repository needs is unknown',
      detail: `.node-version could not be read or did not name a version\nrunning node ${running}`,
    }
  }
  const runningMajor = major(running)
  if (runningMajor === undefined || runningMajor < declaredMajor) {
    return {
      name,
      status: 'fail',
      // No `restartAnswers`: a daemon started on this Node is a daemon on a
      // version CI no longer tests, so this should gate `lingtai restart`
      // rather than let it through (`gatingFailures`, 0042).
      // No `fix`: how Node is installed on this machine is not something the check knows.
      title: 'this Node is older than the repository needs',
      detail: `running node ${running}, below the floor .node-version names (${declared})\ninstall node ${declared} and rerun`,
    }
  }
  return { name, status: 'ok', detail: `running node ${running}, at or above .node-version's ${declared}` }
}

/**
 * `nodeRow` answers *is this Node new enough*; this answers the question #212
 * showed a version cannot — Homebrew's 26.7.0 is newer than the floor and
 * still cannot `--build-sea`, because that build has single-executable
 * support compiled out. `probe` is `probeSeaBuild`'s result, read outside this
 * function for the same reason `nodeRow` takes `running` and `declared` as
 * strings: it keeps this a unit test that never spawns Node.
 *
 * `warn`, not `fail` (see `CheckStatus`): nothing a conductor, a daemon or a
 * pass does ever calls `--build-sea` — only `pnpm binary` and `release.yml`
 * do (`buildBinary`, `apps/release/src/binary.ts`) — so this is a fact worth
 * knowing before cutting a release and not one worth gating `lingtai
 * restart`, `lingtai service start/install` or `lingtai upgrade`'s drain on.
 */
export function seaRow(node: string, version: string, probe: SeaProbe): CheckResult {
  const name = 'node: can build a single executable'
  if (probe.can) return { name, status: 'ok', detail: `${node} (node ${version}) can build a single executable` }
  if (probe.why === 'disabled') {
    return {
      name,
      status: 'warn',
      // No `fix`: whether this Node came from Homebrew, and what to put first on PATH, is not known here.
      title: 'this Node cannot build a single executable',
      detail:
        `${node} (node ${version}) has single-executable support compiled out, which is how Homebrew ships node\n` +
        `it says: ${probe.said}\n` +
        `Run \`brew unlink node\`, or put a Node built with SEA first on PATH (for example \`mise use -g node@26\`).`,
    }
  }
  if (probe.why === 'unsupported') {
    return {
      name,
      status: 'warn',
      title: 'this Node is too old to build a single executable',
      detail: `--build-sea needs Node 25.5 or later; see .node-version\n${node} (node ${version}) says: ${probe.said}`,
    }
  }
  return {
    name,
    status: 'warn',
    title: 'this Node could not be asked about single executables',
    detail: `${node} (node ${version}) says: ${probe.said}`,
  }
}

/**
 * `machine` reads `database.url` from `~/.lingtai/config.yml`. Asked only when
 * `LINGTAI_DATABASE_URL` is unset — the order `postgresUrl` reads them in — and
 * only where the caller hands it in: `doctorReport` does, and a test's own
 * environment never reaches the operator's file.
 *
 * **`load` is the other half of that, and it is one seam rather than four**
 * (`#242`). Every row that folds projects — the refusals, the recipes, the
 * declared environment, the base — reads the log for *which* projects and this
 * machine's `~/.lingtai/<project>/recipe.yml` for what governs each one. On the
 * operator's machine those two agree. A caller that swaps the log without
 * swapping the home has made them disagree, and the rows then report on a
 * machine nobody has: `apps/cli/integration/doctor.test.ts`'s *is green* folded
 * a `ProjectOnboarded` that a sibling test had appended to the shared test log
 * and looked for its recipe in the real `$HOME`, where a throwaway
 * `esctest…` project's recipe has never existed. Eight problems, four projects,
 * and one more pair every time anybody ran the suite — a red nobody could
 * clear, beside `--despite-doctor` on every restart. So the projects a report is
 * about are the caller's to name, and a caller that names them owes the recipes
 * too.
 */
export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  machine: () => string | undefined = () => undefined,
  store: () => StoreChoice = () => storeChoice(),
  queries: LogQueries = log.queries,
  load: typeof loadProjects = loadProjects,
  reach: Partial<DoctorReach> & Pick<DoctorReach, 'sea'> = { sea: probeSeaBuild },
): Promise<DoctorReport> {
  const results: CheckResult[] = []
  // Every row goes in inside a step, so each gets the milliseconds of the call that pushed it and
  // the caller hears which call is in flight. A step that throws stamps nothing and emits no `end`.
  const step = async <T>(label: string, run: () => T | Promise<T>): Promise<T> => {
    const from = results.length
    reach.onProgress?.({ label, phase: 'start', done: from })
    const t0 = performance.now()
    const value = await run()
    const ms = Math.round(performance.now() - t0)
    for (let i = from; i < results.length; i++) results[i] = timed(results[i]!, ms)
    reach.onProgress?.({ label, phase: 'end', done: results.length })
    return value
  }

  if (isSea()) {
    // A binary has no checkout beside it to read `.node-version` from, and it
    // carries the Node that built it — `release.yml` reads that file too, so
    // the two cannot disagree.
    await step('Node', () => {
      results.push({
        name: 'node: at or above the floor',
        status: 'ok',
        detail: `node ${process.version} — the binary carries the Node it was built with`,
      })
      results.push({
        name: 'node: can build a single executable',
        status: 'skip',
        // `process.execPath` here is the lingtai binary, not a Node to probe —
        // building a binary is a checkout's job, and a binary never does it to
        // itself.
        detail:
          "this is a binary, not a checkout — building a binary is a checkout's job, not something a binary does to itself",
      })
    })
  } else {
    await step('Node', async () => {
      let declaredNode: string | undefined
      try {
        declaredNode = (await readFile(join(repoRoot(), '.node-version'), 'utf8')).trim()
      } catch {
        declaredNode = undefined
      }
      results.push(nodeRow(process.versions.node, declaredNode))
      results.push(seaRow(process.execPath, process.versions.node, reach.sea()))
    })
  }

  await step('packages', () =>
    results.push({
      name: 'packages load under Node',
      status: 'ok',
      // Not a freebie: to reach this line, Node's type stripping had to load
      // `@lingtai/domain`, `/recipe`, `/event-store` and everything else this
      // command imports. A `.js` specifier in a barrel or a constructor parameter
      // property would have stopped it, and neither `tsc` nor a board build
      // notices either. See doc/decisions-archive/0010.
      detail: "every package this command imports loaded under Node's type stripping",
    }),
  )

  // Before the connection rows, because it is the question they assume an
  // answer to: what this machine says it runs.
  const choice = store()
  await step('the store', () => results.push(storeRow(choice)))

  // One resolve for the whole report (`#389`) — `recipe:`'s own rows below
  // and the `unconverged` rows in both store branches read this same value,
  // rather than each asking every project's recipe again.
  const filters = await step('recipes', () => projectFiltersOnce(env, load, reach.recipe))
  const unresolved = unresolvedProblems(filters)

  /**
   * **A machine that wrote `sqlite` is never asked for a connection string.**
   *
   * `environment` is a report on the Postgres pair, and on this machine there
   * is no pair. Pushed unconditionally, it failed a machine `lingtai init` had
   * just set up correctly — one that appends, folds `task_view`, renders the
   * cards and beats the beacon
   * (`packages/daemon/integration/the-written-choice.test.ts`) — by the name of a
   * variable it is right not to have, and named giving a Postgres URL as the
   * remedy. And a failure carrying no `restartAnswers` gates `lingtai restart`
   * (`gatingFailures`, 0042), so the working machine could not start a daemon
   * either: setup said correct, doctor said broken, and the way out it offered
   * was to abandon the configuration.
   */
  const fileBacked = !('refused' in choice) && choice.store === 'sqlite'

  let fromFile: string | undefined
  let unreadable: string | undefined
  if (!fileBacked && !env['LINGTAI_DATABASE_URL']) {
    try {
      fromFile = machine()
    } catch (err) {
      unreadable = (err as Error).message
    }
  }
  const pooled = fileBacked ? undefined : env['LINGTAI_DATABASE_URL'] || fromFile
  // Absent, the pooled one stands in (#176) — the rule `directPostgresUrl`
  // follows, so the doctor checks the connection the system will actually use.
  const standIn = !env['LINGTAI_DIRECT_DATABASE_URL']
  const direct = fileBacked ? undefined : env['LINGTAI_DIRECT_DATABASE_URL'] || pooled
  const envResult = fileBacked
    ? {
        name: 'environment',
        status: 'skip' as const,
        detail:
          'not read on this machine — it wrote store: sqlite, so there is no connection string to report on, ' +
          'and the store row above says where the log is',
      }
    : unreadable
      ? unreadableConfigRow(unreadable)
      : environment(
          pooled,
          direct,
          standIn && Boolean(pooled),
          fromFile ? '~/.lingtai/config.yml database.url' : undefined,
        )
  await step('the environment', () => results.push(envResult))

  if (fileBacked) {
    // Every row below that is about **a log** rather than about Postgres: each
    // opens the store this machine chose, so each answers here too. Losing the
    // projection lag, the shape check, the beacon and the lock along with the
    // connection rows was the same defect's other half, and losing the
    // reachability of the log itself along with the pooled connection was the
    // half that let `0 failed` print for a machine nobody had checked (#214).
    //
    // Still nothing written, in the sense the rule at the top of this file
    // means it: no row appends, and none is a probe. Opening a file-backed
    // store runs its own `create table if not exists` — `events` and
    // `daemon_status` — which is how that store is opened at all and how the
    // very next command would open it; not one row goes in.
    await step('the log', async () => results.push(await logReachable(choice.path, queries)))
    await step('projections', async () => results.push(await projections(undefined, reach.lags)))
    await step('projection shapes', async () => results.push(await projectionShapes(undefined, reach.shapes)))
    await step('the daemon', async () => results.push(await daemonLiveness(reach.status, reach.pause)))
    await step('daemon currency', async () => results.push(await daemonCurrency(reach.status)))
    await step('spend', async () => results.push(await spendToday(reach.spend)))
    await step('rates', async () =>
      results.push(ratesCheck(process.env, await spendLagNow(reach.lags ?? (() => projectionLag())))),
    )
    await step('refusals', async () => results.push(await passRefusals(load)))
    await step('the lock', async () => results.push(await conductorLock(reach.lockHolder)))
    await step('event types', async () => results.push(await readableTypes(queries)))
    await step('holds', async () => results.push(await logPredatesHoldRow(queries)))
    await step('orphans', async () => results.push(await orphans(reach.orphans)))
    // Read once and handed to both: the two rows below name issues, and a
    // number on its own is homework for whoever is reading them (#258).
    const titles = await step('issue titles', () => issueTitles(reach.titles))
    await step('unconverged', async () => results.push(await unconverged(queries, titles, unresolved)))
    await step('subscribers', async () => results.push(await subscribers(queries)))
    await step('end step', async () => results.push(await endStepRan(queries, titles)))
    // Named one at a time, each saying why it does not apply and naming the
    // store. See `postgresOnlyRows`.
    await step('Postgres-only rows', () => {
      for (const row of postgresOnlyRows()) {
        results.push({
          name: row.name,
          status: 'skip',
          detail: `not asked on this machine: it wrote store: sqlite, and ${row.because}`,
        })
      }
    })
  } else if (envResult.status === 'ok' && pooled && direct) {
    // **The direct connection, and not `queries`.** These read the log, and on
    // this machine the log has two connection strings: `log.queries` is the
    // pooled one, and through a pooler a dropped connection turns an audit into
    // a red check that has nothing to do with the log (#157). The rows take a
    // `LogQueries` so that the file-backed branch above can ask them at all;
    // which connection *this* branch hands them is unchanged.
    const audit = createPostgresLogQueries({ url: direct })
    await step('the pooler', async () => results.push(await pooledConnection(pooled)))
    await step('the direct connection', async () => results.push(await directIsSessionMode(direct, standIn)))
    await step('the schema', async () => results.push(...(await schema(direct))))
    await step('projections', async () => results.push(await projections(pooled)))
    await step('projection shapes', async () => results.push(await projectionShapes(pooled)))
    await step('the daemon', async () => results.push(await daemonLiveness()))
    // Beside liveness, never folded into it: up and current are two facts, and
    // for thirty-nine minutes only one of them was measured.
    await step('daemon currency', async () => results.push(await daemonCurrency()))
    await step('spend', async () => results.push(await spendToday()))
    await step('rates', async () => results.push(ratesCheck(process.env, await spendLagNow(() => projectionLag()))))
    // What the conductor refused, from the log — not what this checkout would
    // refuse, which the recipe rows answer, and which is a different question
    // whenever the two are at different commits (#148).
    await step('refusals', async () => results.push(await passRefusals(load)))
    await step('the lock', async () => results.push(await conductorLock()))
    await step('event types', async () => results.push(await readableTypes(audit)))
    await step('holds', async () => results.push(await logPredatesHoldRow(audit)))
    await step('orphans', async () => results.push(await orphans()))
    // The projection and not the audit connection: this is what the rows are
    // *called*, not what they assert, so it is read where every other
    // projection read here is read (#258).
    const titles = await step('issue titles', () => issueTitles())
    await step('unconverged', async () => results.push(await unconverged(audit, titles, unresolved)))
    await step('subscribers', async () => results.push(await subscribers(audit)))
    await step('end step', async () => results.push(await endStepRan(audit, titles)))
  } else {
    await step('Postgres', () =>
      results.push({
        name: 'postgres',
        status: 'skip',
        detail: 'not attempted — the environment check failed first',
      }),
    )
  }

  await step('GitHub', async () => {
    results.push(githubCredentials(env))
    const ghRow = await ghLogin(env, reach.gh)
    if (ghRow !== null) results.push(ghRow)
  })
  await step('project recipes', async () => results.push(...(await projectRecipes(filters))))
  await step('declared environment', async () => results.push(...(await declaredEnvironment(env, load, reach))))
  await step('recipe bases', async () => results.push(...(await recipeGovernsItsBase(env, load, reach))))
  await step('settings', async () => results.push(await settingsSources(reach.settings)))
  await step('runtimes', async () => results.push(await runtimeAuth(reach.runtimes)))
  await step('deferred', () => {
    for (const d of DEFERRED) results.push({ ...d, status: 'skip', deferred: true })
  })
  shareFixes(results)

  return { results, ...tally(results) }
}

/**
 * The report, with the environment built the one legal way.
 *
 * Touching the loaders rather than reading `process.env` keeps the one rule
 * about environment loading true even in the command that inspects it — and
 * this is a function rather than four lines at a call site because there are two
 * call sites now: `lingtai doctor`, and the `lingtai restart` it gates
 * ([0042](../../../doc/decisions-archive/0042-the-restart-is-a-command.md)). A gate that
 * ran a *slightly* different doctor than the one you type would be the worst of
 * both.
 */
export async function doctorReport(opts: { onProgress?: (p: DoctorProgress) => void } = {}): Promise<DoctorReport> {
  const env = doctorEnvironment()
  return runDoctor(
    env,
    () => machineDatabaseUrl(env),
    () => storeChoice(env),
    undefined,
    undefined,
    { sea: probeSeaBuild, onProgress: opts.onProgress },
  )
}

/**
 * That environment: a copy of this process's, with the two unprefixed names
 * carrying what this copy reads for itself — and **carrying neither** where
 * nothing is configured, so an operator's own `DATABASE_URL` for something else
 * never reads as Lingtai's.
 *
 * **Read, not caught** (#213). This was two `try`/`catch` blocks around the
 * getters, asking them to answer *is one configured* by throwing — the shape
 * that let the same question hide in `entry.ts` for five passes.
 * `postgresUrlIfSet` and `directUrlIfSet` are those same two reads with the
 * refusal left off, so every value here is the one that was here before.
 */
export function doctorEnvironment(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...from }
  const pooled = postgresUrlIfSet(from)
  const direct = directUrlIfSet(from)
  if (pooled) env['DATABASE_URL'] = pooled
  else delete env['DATABASE_URL']
  if (direct) env['DIRECT_DATABASE_URL'] = direct
  else delete env['DIRECT_DATABASE_URL']
  return env
}

/**
 * The counts of a list of results, in one place: `runDoctor` counts its own, and
 * `lingtai doctor` counts again once it has appended the release row (which is
 * asked outside `runDoctor`, so a restart does not make the request).
 *
 * A `skip` that is not `deferred` is `notChecked` — a fact about this machine,
 * on the half of the summary that says so (#214).
 */
export function tally(results: readonly CheckResult[]): Omit<DoctorReport, 'results'> {
  const count = (keep: (r: CheckResult) => boolean): number => results.filter(keep).length
  return {
    ok: count((r) => r.status === 'ok'),
    failed: count((r) => r.status === 'fail'),
    skipped: count((r) => r.status === 'skip'),
    deferred: count((r) => r.status === 'skip' && r.deferred === true),
    notChecked: count((r) => r.status === 'skip' && r.deferred !== true),
    warned: count((r) => r.status === 'warn'),
    info: count((r) => r.status === 'info'),
  }
}

const NOT_IMPLEMENTED = 'Not implemented here'
const OTHER = 'Other'

/**
 * Which section a check is in, by the text before the first `": "` of its name
 * — every check already says which area it is about, so none carries a second
 * field that could disagree. A name with no colon is matched whole. The order
 * here is the order the sections are drawn in, within a tier (see `renderDoctor`).
 */
const AREA_OF: readonly (readonly [string, readonly string[]])[] = [
  ['Machine', ['node', 'packages load under Node', 'release']],
  ['Store and log', ['store', 'environment', 'postgres', 'schema', 'log', 'projections']],
  ['Daemon', ['daemon', 'conductor', 'worktrees', 'subscribers', 'spend', 'rates']],
  ['Projects', ['recipe', 'env', 'base', 'discuss', 'triage', 'steps']],
  ['GitHub', ['github']],
  ['Runtimes', ['runtime']],
]

/** The section of one check. A deferred row is *not implemented here* whatever its prefix; an unknown prefix is `Other`, never dropped. */
export function areaOf(result: CheckResult): string {
  if (result.deferred === true) return NOT_IMPLEMENTED
  const colon = result.name.indexOf(': ')
  const prefix = colon === -1 ? result.name : result.name.slice(0, colon)
  return AREA_OF.find(([, prefixes]) => prefixes.includes(prefix))?.[0] ?? OTHER
}

/** Inside a section: what is wrong first, what is merely worth knowing next. */
const STATUS_ORDER: readonly CheckStatus[] = ['fail', 'warn', 'info', 'ok', 'skip']

function marker(status: CheckStatus): string {
  const slot = (text: string, drawn: string): string => drawn + ' '.repeat(Math.max(0, 4 - width(text)))
  switch (status) {
    case 'ok':
      return slot('✓', symbol.pass())
    case 'fail':
      return slot('✗', symbol.fail())
    // `!` is not amber, and not bold: amber is a person being waited on, and nothing else (0121 §2).
    // It is read because its section is drawn above the green ones.
    case 'warn':
      return slot('!', '!')
    case 'info':
      return slot('note', 'note')
    case 'skip':
      return slot('skip', paint.muted('skip'))
  }
}

/**
 * **`0 failed` is a claim about what ran**, so the line beside it says what did
 * not ([#214](https://github.com/steven-zhc/lingtai/issues/214)).
 *
 * The two kinds of skip were one number and one sentence — *N not implemented
 * yet* — which is true of the three in `DEFERRED` and a lie about a check this
 * machine did not get. On a machine whose log is a file it covered the one row
 * that stood in for twelve checks — among them the only asker of *is the log
 * reachable* — and the summary read as a clean bill of health for a machine
 * nothing had checked.
 *
 * Both halves are printed, and neither is hidden when it is zero on the green
 * line: a reader who has been told `4 not checked here` once will look for the
 * number again, and its absence would read as *none* rather than as *this
 * build stopped saying*.
 *
 * The checks are grouped by area, sections with a failure first and then those
 * with a note; each is the marker and the name, then what it found — which is
 * where the remedy is — on the next line.
 */
/** A row's time for `--verbose`: one decimal, and `<0.1s` below a tenth of a second. */
function seconds(ms: number): string {
  return ms < 100 ? '<0.1s' : `${(ms / 1000).toFixed(1)}s`
}

/** The width of the label column in the short view: `[problem]` and ` PROBLEM `. */
const LABEL_COLUMN = 9

/** A label right-aligned in the column. Padded from the plain word's width, since the rendered badge carries escapes. */
function labelled(rendered: string, word: string): string {
  return `${' '.repeat(LABEL_COLUMN - (word.length + 2))}${rendered}`
}

export function renderDoctor(report: DoctorReport, opts: { verbose?: boolean; next?: boolean } = {}): string[] {
  const { verbose = false, next = true } = opts
  const lines = [heading('doctor'), '']
  const notes = report.results.filter((r) => r.status === 'info')
  if (!verbose) {
    const todo = toFix(report.results)
    const tail = `${report.notChecked} not checked here · ${report.deferred} not implemented yet`
    lines.push(
      todo.length === 0
        ? `${paint.pass(`all ${report.ok} passed`)} · ${tail}`
        : `${todo.some((t) => t.status === 'fail') ? paint.fail(`${todo.length} to fix`) : `${todo.length} to fix`} · ${paint.pass(`${report.ok} passed`)} · ${tail}`,
    )
    for (const t of todo) {
      lines.push(
        '',
        `${labelled(badge(t.status, 'problem'), 'problem')} ${t.status === 'fail' ? `${symbol.fail()} ` : ''}${t.title ?? t.name}  ${paint.muted(`· ${t.areas.join(', ').toLowerCase()}`)}`,
        `${' '.repeat(LABEL_COLUMN + 1)}${t.detail.split('\n')[0]}`,
        ...(t.fix === undefined
          ? []
          : t.fix
              .split('\n')
              .map((line, i) =>
                i === 0
                  ? `${labelled(badge('fix', 'fix'), 'fix')} ${paint.accent(line)}`
                  : `${' '.repeat(LABEL_COLUMN + 1)}${paint.accent(line)}`,
              )),
      )
    }
    if (notes.length > 0) {
      lines.push('', ...notes.map((r) => `${labelled(badge('muted', 'note'), 'note')} ${r.detail.split('\n')[0]}`))
    }
    if (next && report.warned + report.failed > 0) {
      lines.push('', `${labelled(badge('next', 'next'), 'next')} ${paint.accent('lingtai doctor --verbose')}`)
    }
    return lines
  }
  const groups = new Map<string, CheckResult[]>()
  for (const r of report.results) {
    const area = areaOf(r)
    groups.set(area, [...(groups.get(area) ?? []), r])
  }
  const known = [...AREA_OF.map(([area]) => area), OTHER, NOT_IMPLEMENTED]
  const tier = (rs: readonly CheckResult[]): number =>
    rs.some((r) => r.status === 'fail') ? 0 : rs.some((r) => r.status === 'warn') ? 1 : 2
  const areas = known
    .filter((area) => groups.has(area))
    .map((area, order) => ({ area, order, rows: groups.get(area) ?? [] }))
    .sort((x, y) => {
      if (x.area === NOT_IMPLEMENTED || y.area === NOT_IMPLEMENTED) return x.area === NOT_IMPLEMENTED ? 1 : -1
      return tier(x.rows) - tier(y.rows) || x.order - y.order
    })
  for (const { area, rows } of areas) {
    const ordered = STATUS_ORDER.flatMap((status) => rows.filter((r) => r.status === status))
    const checks = ordered.flatMap((r) => [
      `${marker(r.status)}  ${r.name}${r.ms === undefined ? '' : paint.muted(` ${seconds(r.ms)}`)}`,
      ...r.detail.split('\n').map((line) => `${' '.repeat(6)}${line}`),
      ...(r.fix === undefined ? [] : fixLines(r.fix, 6)),
    ])
    lines.push(...section(area, checks).split('\n'))
  }
  const noted =
    (report.warned > 0 ? `, ${report.warned} need attention` : '') + (report.info > 0 ? `, ${report.info} noted` : '')
  const here = `, ${report.notChecked} not checked here`
  lines.push('')
  lines.push(
    report.failed === 0
      ? `${paint.pass(`${report.ok} ok`)}${noted}${here}, ${report.deferred} not implemented yet, 0 failed`
      : paint.fail(
          `${report.failed} check(s) FAILED — ${report.ok} ok${noted}${here}, ${report.deferred} not implemented yet`,
        ),
  )
  return lines
}

/** A `fix` block: `fix` and the first command, each further line under it. Never wrapped here — the terminal does that. */
function fixLines(fix: string, indent: number): string[] {
  return fix.split('\n').map((line, i) => `${' '.repeat(indent)}${i === 0 ? 'fix  ' : '     '}${line}`)
}

interface ToFix {
  status: 'fail' | 'warn'
  title?: string
  name: string
  detail: string
  fix?: string
  areas: string[]
}

/** What the short view draws: `fail`s then `warn`s, each in area order, rows with an identical `fix` drawn once. */
function toFix(results: readonly CheckResult[]): ToFix[] {
  const areaRank = (r: CheckResult): number => {
    const i = [...AREA_OF.map(([a]) => a), OTHER].indexOf(areaOf(r))
    return i === -1 ? AREA_OF.length + 1 : i
  }
  const rows = (['fail', 'warn'] as const).flatMap((status) =>
    results.filter((r) => r.status === status && r.deferred !== true).sort((x, y) => areaRank(x) - areaRank(y)),
  )
  const out: ToFix[] = []
  for (const r of rows) {
    const same = r.fix === undefined ? undefined : out.find((o) => o.fix === r.fix)
    if (same !== undefined) {
      if (!same.areas.includes(areaOf(r))) same.areas.push(areaOf(r))
      continue
    }
    out.push({
      status: r.status as 'fail' | 'warn',
      title: r.title,
      name: r.name,
      detail: r.detail,
      fix: r.fix,
      areas: [areaOf(r)],
    })
  }
  return out
}

/** The report as one string: what `lingtai init` shows after it has set up — the short view, and no closing `next:` (init owns its closing line). */
export function formatReport(report: DoctorReport): string {
  return renderDoctor(report, { next: false }).join('\n')
}

/**
 * The body of `lingtai doctor --json`. `checks` is in the order they ran and
 * carries its `area`, so a script groups them itself; `status` is the
 * `CheckStatus`, never a marker. `deferred` and `restartAnswers` are always
 * present — the second is what `gatingFailures` reads, so a script can tell
 * *red* from *red, and a restart fixes it*.
 */
export function doctorJson(report: DoctorReport): Record<string, unknown> {
  return {
    ok: report.ok,
    failed: report.failed,
    warned: report.warned,
    info: report.info,
    skipped: report.skipped,
    deferred: report.deferred,
    notChecked: report.notChecked,
    checks: report.results.map((r) => ({
      area: areaOf(r),
      name: r.name,
      status: r.status,
      detail: r.detail,
      deferred: r.deferred === true,
      restartAnswers: r.restartAnswers === true,
      ...(r.title === undefined ? {} : { title: r.title }),
      ...(r.fix === undefined ? {} : { fix: r.fix }),
      ...(r.ms === undefined ? {} : { ms: r.ms }),
    })),
  }
}
