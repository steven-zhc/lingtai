/**
 * What the daemon's storage is, stated once so that there can be two of them.
 *
 * Until #220 there was no interface here at all: four files under `src/` built
 * a `pg.Client` of their own — three of them in `control.ts`, for the beacon
 * alone — and on a machine with no Postgres nothing could say whether a daemon
 * was up. That is
 * [0055](../../../doc/decisions/0055-two-implementations-chosen-at-init.md)
 * §1's defect in one sentence: **a direct `pg.Client` outside a Postgres
 * implementation is a place the init-time choice does not reach.**
 *
 * The shape is `EventStore`'s and `ProjectionStore`'s, deliberately and
 * exactly: an interface, two implementations beside each other, and a contract
 * (`test/contract.ts`) that neither of them owns deciding whether they agree.
 *
 * ## The beacon is not a fold, and that is the whole reason this is its own file
 *
 * `control.ts` says it: `daemon_status` is *the only mutable operational state
 * in the system*. Everything else Lingtai keeps is append-only — the log — or a
 * fold of it — the projections. **The beacon is written over.**
 *
 * So the contract here asserts what a mutable row has to be true about, and
 * none of it transfers from the event store's:
 *
 * - **liveness** — a beat lands, and a later read sees it;
 * - **last-write-wins** — one row, and the last word written is the word read,
 *   whichever process wrote it;
 * - **stopped is not never-started** — a daemon that died leaves a row that has
 *   gone stale, and a machine where none has ever run has no row at all. Both
 *   are ordinary answers and a reader has to be able to tell them apart.
 *
 * Bundling the beacon in with the projections would have put those two shapes
 * behind one name.
 *
 * ## The control stream is here because it is the other half of one question
 *
 * *Is a daemon up* is the beacon. *Is it being told anything* is the control
 * stream, and that is the log — `ConductorPaused` and
 * `ConductorShutdownRequested` are events, for the reasons `control.ts`'s
 * header gives. A store names **which log**, so the two questions resolve
 * through one object, and the contract holds both implementations to the
 * watermark (`#159`) as well as to the beat.
 *
 * ## Nothing here chooses
 *
 * `readStatus`, `beat`, `createStatusTable`, the work loop and `reconcile` all
 * still open Postgres when nobody says otherwise. Which implementation a
 * machine gets is [#179](https://github.com/steven-zhc/lingtai/issues/179)'s
 * question, and this exists so that it has somewhere to be asked.
 */
import type { EventStore } from "@lingtai/event-store/store";

/**
 * The beacon's row, as a store hands it back.
 *
 * One row for the whole installation, enforced by its primary key. Two daemons
 * cannot both be up — the conductor lock sees to that — so a second row would
 * be a lie.
 */
export interface DaemonStatus {
  pid: number;
  host: string;
  startedAt: Date;
  lastSeenAt: Date;
  state: string;
  currentRunId: string | null;
  /**
   * The commit `HEAD` pointed at when this process started, and whether its
   * worktree was dirty.
   *
   * Null when the daemon is older than `#98` and never recorded one — which is
   * itself the finding, and is reported rather than smoothed over. Liveness and
   * currency are independent facts and this row now carries both: for
   * thirty-nine minutes a daemon beat happily while holding code that could not
   * produce the event the log had been fixed to record.
   */
  codeSha: string | null;
  codeDirty: boolean;
}

/**
 * One beat, with nothing left for the store to decide but the clock.
 *
 * The pid and the host are the caller's — `control.ts` reads them from the
 * process — so that a store is a writer and never a source of facts about who
 * is running. `startedAt` is the exception and belongs to the store: it is set
 * when the row is first inserted and never overwritten, which is what makes a
 * beat an update of a running daemon's row rather than a new life for it.
 */
export interface Beat {
  pid: number;
  host: string;
  state: string;
  currentRunId: string | null;
  codeSha: string | null;
  codeDirty: boolean;
}

/**
 * Which streams the daemon wants to look at, as the two questions that ask.
 *
 * `reconcile` wants the work items some conductor has claimed, within the
 * projects it knows; `converge` wants every work item the log has moved at all.
 * Both are *find the streams*, and neither is a fold — they exist so that the
 * fold that follows reads a handful of streams rather than the whole log.
 */
export interface StreamQuery {
  /** `wi-lingtai-%` — matched as SQL `like`, so `%` is the wildcard. */
  prefixes: readonly string[];
  /** A stream qualifies if it holds at least one event of one of these types. */
  types: readonly string[];
}

/**
 * Everything the daemon reads and writes that is not a fold: the beacon, the
 * log its control stream lives in, and the two questions it asks of that log
 * which `EventStore` does not answer.
 */
export interface DaemonStore {
  /**
   * The log. `readControl`, `controlWatermark`, `pauseConductor` and the rest
   * go through this, which is what makes the beacon and the control stream one
   * interface rather than two.
   */
  readonly events: EventStore;

  /**
   * Idempotent DDL for the beacon's row. Called at every daemon start, so a
   * fresh machine needs no migration step.
   *
   * **Deliberately outside the write model's contract** and so outside 0004's
   * migration rules: `daemon_status` is the one mutable operational row, and it
   * is created and widened where it is read.
   */
  create(): Promise<void>;

  /**
   * Says "still here", overwriting whatever the row said before.
   *
   * **It is the caller that must not let this throw**, and `startBeacon` is
   * where that is decided: a daemon that died on a beat would strand the
   * conductor lock it is holding while it conducts nothing. A row that cannot
   * be written reports itself by going stale.
   */
  beat(beat: Beat): Promise<void>;

  /** Null when no daemon has ever run. Stale is reported, never hidden. */
  status(): Promise<DaemonStatus | null>;

  /**
   * The log's current end.
   *
   * What the work loop subscribes from, so a daemon starting does not replay
   * every task that has ever landed. One question rather than a page walk: the
   * answer is a single number, and reading it by paging would make starting the
   * daemon slower the longer it has been useful.
   */
  head(): Promise<bigint>;

  /** The stream ids matching `query`, in `stream_id` order. */
  streams(query: StreamQuery): Promise<string[]>;

  /** Releases whatever this store holds open. */
  close(): Promise<void>;
}

/**
 * How often the beacon is refreshed.
 *
 * The one timer in the system, and it is not driving any decision — it says
 * "still here". Everything that *decides* still wakes on an append.
 */
export const HEARTBEAT_MS = 5_000;

/** Considered down after this long without a beat. Three missed beats. */
export const STALE_AFTER_MS = HEARTBEAT_MS * 3;

/**
 * What the beacon says, read from **both** of its fields.
 *
 * The staleness test lived in five places — two rows of `lingtai doctor`, three
 * chips on the board — each spelling `Date.now() - lastSeenAt > STALE_AFTER_MS`
 * for itself and each throwing the state word away. `#64` is the ticket about
 * two readers of this row disagreeing; one function is how they cannot.
 *
 * **The age is what decides whether anything is beating, and it is the only
 * thing that can.** A state word is what a process *said*, and a process that
 * has died goes on saying it forever, so exempting `starting` from staleness
 * would trade a wrong answer that lasted twelve seconds for one that lasts
 * until the next daemon starts. What the word adds is what it was doing when it
 * stopped — `starting` is a daemon that died on the way up, `stopping` one that
 * was told to go — so the sentence can name that instead of flattening both
 * into "not running".
 */
export interface Beating {
  /** Something is beating: a beat landed within `STALE_AFTER_MS`. */
  up: boolean;
  /** The word the beacon carries — `starting`, `up`, `draining`, `stopping`. */
  state: string;
  /** Since the last beat. */
  ageMs: number;
}

/**
 * A row, read. Pure, and over the interface rather than over either store, so
 * that *stopped* and *never started* are told apart the same way on both:
 * `null` is the second, and this is how the first is recognised.
 */
export function lastBeat(status: DaemonStatus, now: number = Date.now()): Beating {
  const ageMs = now - status.lastSeenAt.getTime();
  return { up: ageMs <= STALE_AFTER_MS, state: status.state, ageMs };
}
