/**
 * What a projection's storage is, stated once so that there can be two of them.
 *
 * Until #219 there was no interface here at all: six places under `src/` built
 * a `pg.Client` or a `pg.Pool` of their own, each opening its own connection
 * from `databaseUrl()`. Nothing could be swapped, which is
 * [0055](../../../doc/decisions/0055-two-implementations-chosen-at-init.md) §1's
 * defect in one sentence — **a direct `pg.Client` outside a Postgres
 * implementation is a place the init-time choice does not reach** — and on a
 * machine with no Postgres there was no board.
 *
 * The shape is copied from `EventStore`, deliberately and exactly: an interface,
 * two implementations beside each other, and a contract file
 * (`test/contract.ts`) that neither of them owns deciding whether they agree.
 * That shape is why a SQLite `EventStore` written months after the contract
 * passed it unchanged (#178).
 *
 * **The folds do not live here and do not move.** `taskViewProjection.apply` is
 * the same fold it was, issuing the same statements through the same
 * `ProjectionContext`. What this interface covers is everything around it —
 * the checkpoint, the transaction the fold and the checkpoint share, the
 * rebuild, the catalogue read behind the shape check, and the queries the
 * board's columns are.
 *
 * **Nothing here chooses, and since #179 exactly one file next door does.**
 * `readTasks`, `readBacklog`, `projectionLag`, `projectionShape` and
 * `createProjectionRunner` each ask `choose.ts` for a store, which reads the
 * one value `~/.lingtai/config.yml` holds
 * ([0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md)). This
 * interface is what made that a single edit rather than six.
 */
import type { Envelope } from "@lingtai/domain";
// Type-only, both ways. `store.ts` names the row shapes the board reads and
// `task-view.ts` names the context a fold writes through; a cycle of types is
// erased before Node ever sees it, and keeping the board's card shape beside
// the fold that produces it is worth more than a file with no edges.
import type { BacklogEntry, BacklogStatus } from "./backlog.ts";
import type { TaskCard } from "./task-view.ts";

/** A row, as a store hands it back. Column names, not field names. */
export type ProjectionRow = Record<string, unknown>;

/**
 * SQL access inside the projection's transaction.
 *
 * The statements are the projection's own and are written once, in Postgres.
 * A store that speaks another dialect answers for the difference on the way
 * through — see `sqlite.ts`, where the list of differences is closed and
 * anything not on it reaches SQLite unchanged and fails loudly.
 */
export interface ProjectionContext {
  query<T = ProjectionRow>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

export interface Projection {
  /** The `checkpoints.name` this projection advances. */
  readonly name: string;

  /**
   * Idempotent DDL for whatever tables this projection owns. Called before every
   * catch-up, so a fresh database needs no migration step.
   *
   * **It must not read its own query results.** `declaredShape` calls this with
   * a context that records the SQL instead of executing it, which is how the
   * shape check gets the declared columns without a second list to keep in step
   * (`shape.ts`). Recording returns no rows, so a `create` that branched on one
   * would be recorded wrong.
   */
  create(ctx: ProjectionContext): Promise<void>;

  /**
   * **Removes** everything `create` made — dropped, not emptied.
   *
   * This used to truncate, and truncating is not enough. `create` is
   * `create table if not exists`, so a projection whose *shape* changed kept
   * the old columns forever and the runner died on the first write to a column
   * that was not there. The error surfaced as "subscription stopped before it
   * caught up", which names the symptom and not one word of the cause.
   *
   * Dropping is what makes the claim in `rebuild` true: a projection's shape is
   * free to change because changing it costs a rebuild rather than a migration.
   */
  reset(ctx: ProjectionContext): Promise<void>;

  /**
   * Folds one batch, in `seq` order.
   *
   * **Must be idempotent.** The checkpoint is transactional, so a clean crash
   * cannot double-apply — but a process killed after the store committed and
   * before the runner noticed will re-read the same events, and so will a
   * rebuild. `on conflict do nothing` keyed on `seq` is the cheap way.
   */
  apply(events: readonly Envelope[], ctx: ProjectionContext): Promise<void>;
}

export interface ProjectionLag {
  name: string;
  /** How far this projection has consumed. */
  lastSeq: bigint;
  /** The log's high-water mark. */
  headSeq: bigint;
  /** Events behind. Zero is caught up. */
  lag: bigint;
  updatedAt: Date | null;
}

/** What `readTasks` asks of a store, with the retention window already decided. */
export interface TaskQuery {
  project?: string;
  /**
   * How long a landed task stays visible. Resolved by the caller rather than
   * defaulted here, so a store never has to know what the board's default is —
   * and so changing it stays a different query rather than a rebuild.
   */
  retentionDays: number;
}

/** What `readBacklog` asks of a store. Absent `status` reads every status. */
export interface BacklogQuery {
  project?: string;
  status?: BacklogStatus;
  key?: string;
}

/**
 * Every read and write of `task_view`, `task_view_run`, `finding_backlog` and
 * `finding_backlog_run`, and of the checkpoint that says how far each has got.
 *
 * Grouped as the five things the ticket names, in this order: read the
 * checkpoint, apply a batch atomically, rebuild from zero, read for the board,
 * and survive a second client doing all of it at the same time.
 */
export interface ProjectionStore {
  /**
   * Runs `fn` in one transaction and commits it, or rolls the whole of it back.
   *
   * **This is the correctness argument, and it has no second half.** A
   * projection's writes and its checkpoint advance happen in here together.
   * Split them and there is no third option — a crash between the two either
   * loses a batch or applies it twice, and which one depends on which write you
   * put first. Together, the checkpoint is simply part of the projection's
   * state, and recovery is "read the checkpoint, carry on".
   */
  transact<T>(fn: (ctx: ProjectionContext) => Promise<T>): Promise<T>;

  /** How far `name` has read. `0n` for a projection with no checkpoint row. */
  checkpoint(name: string): Promise<bigint>;

  /** Moves `name`'s checkpoint to `seq`. Inside the fold's transaction, always. */
  advance(ctx: ProjectionContext, name: string, seq: bigint): Promise<void>;

  /**
   * Puts a row down at zero without moving an existing one.
   *
   * A projection with no events yet would otherwise have no checkpoint at all,
   * and `lags()` cannot tell that apart from a projection nobody ever started —
   * so `lingtai doctor` would report "nothing running" about something that is
   * running fine and merely has nothing to do.
   */
  register(ctx: ProjectionContext, name: string): Promise<void>;

  /** The same, but forces an existing row back to zero. Used by `rebuild`. */
  rewind(ctx: ProjectionContext, name: string): Promise<void>;

  /**
   * The columns each of `tables` actually has, absent from the map when the
   * table is not there.
   *
   * One catalogue read and no write at all, which is what lets the shape check
   * run on every `lingtai doctor` and at every daemon start — the whole point,
   * because the alternative is finding out when the daemon stops (#84).
   */
  columnsOf(tables: readonly string[]): Promise<Map<string, ReadonlySet<string>>>;

  /** One projection's lag, whether or not it has a checkpoint row yet. */
  lag(name: string): Promise<ProjectionLag>;

  /** Every projection that has a checkpoint, by name. What `lingtai doctor` reports. */
  lags(): Promise<ProjectionLag[]>;

  /**
   * The board's cards.
   *
   * Ordered by project, then Waiting oldest-first — it is the column that
   * stalls, and what has waited longest is what to do next — then by ticket
   * number. A store answers for the ordering as well as the rows: the order is
   * part of what the board reads, not a detail of one dialect.
   */
  tasks(query: TaskQuery): Promise<TaskCard[]>;

  /**
   * Which projects the board holds cards from, over the same retention window.
   *
   * Its own query rather than a fold over a filtered read, because that is the
   * one question a filtered read cannot answer: narrowing to one project is
   * what removes the evidence that the others exist.
   */
  taskProjects(query: Pick<TaskQuery, "retentionDays">): Promise<string[]>;

  /** The finding backlog, oldest first within a project: it is worked from the bottom. */
  backlog(query: BacklogQuery): Promise<BacklogEntry[]>;

  /** Releases whatever this store holds open. */
  close(): Promise<void>;
}
