/**
 * What the conductor may pick up next.
 *
 * **The subtraction, in one place.** GitHub says what it is offering
 * (`runnableNow`), the log says what Lingtai is already doing (`task_view`),
 * and this returns the difference. Neither side is stored: the offer is asked
 * for at the moment it is needed, and the log's side is a fold and nothing
 * else ([0022](../../../doc/decisions/0022-the-seams.md), `#65`).
 *
 * It reads the projector's view and decides — which is why it is here and not
 * there. A projection folds; it does not choose what to run next.
 */
import { workItemStream } from "@lingtai/domain";
import { readTasks } from "@lingtai/projector";

/** What a caller needs to run one: enough to nominate it, and nothing more. */
export interface Runnable {
  taskId: string;
  issue: string;
  title: string;
  kind: string;
}

export interface RunnableOptions {
  project: string;
  /**
   * What GitHub offers right now, from `runnableNow`.
   *
   * Passed in rather than read from a table: the queue was a cache and its two
   * bugs were both cache invalidation (#56, #57). Its own consumer refreshed it
   * immediately before every read, so it was a holding place inside one pass.
   */
  offered: readonly { ref: string; title: string; kind: string }[];
  /** The recipe's priority order. Priority is asked, not stored. */
  kinds: readonly string[];
  /**
   * Skip anything attempted inside this window.
   *
   * The whole of the loop guard. A failed run releases its task, a release is a
   * completion event, and a completion event is what tells the conductor to
   * pick up the next one — so without this the top of the queue is the ticket
   * that just failed, forever, at agent prices. The old harness re-ran #58 and
   * #59 five times for roughly $29 exactly this way.
   *
   * In the table rather than in memory on purpose: an in-memory set forgets on
   * restart, and a daemon that crashes on a bad ticket would come back and
   * spend the money again.
   *
   * **Required, and it comes from `source.backoff`**
   * ([0028](../../../doc/decisions/0028-the-backoff-is-the-recipes.md)). It was
   * an optional overriding a `DEFAULT_BACKOFF_MS` constant here, which made the
   * hour a fact of Lingtai's source that no recipe stated and no output named —
   * the shape 0027 deleted the lease for. Naming it at each call site is what
   * makes the recipe the only place it is decided; `0` is a caller saying *this
   * one is not blind*, and `lingtai now` is the caller that says it.
   */
  backoffMs: number;
  /** Injectable so a test does not have to wait an hour. */
  now?: Date;
  url?: string;
}

/**
 * What the conductor may pick up next, best first.
 *
 * The subtraction, in one place: GitHub says what it is offering, the log says
 * what Lingtai is already doing, and this returns the difference. Neither side
 * is stored — the offer is asked for at the moment it is needed, and the log's
 * side is this table, which is now nothing but a fold.
 */
export async function selectRunnable(options: RunnableOptions): Promise<Runnable[]> {
  const kinds = options.kinds.length > 0 ? [...options.kinds] : ["bug"];
  // Every row, not just the queued ones: a row's *existence* is what says the
  // log has an opinion about this issue, and its state is that opinion.
  const seen = new Map(
    (
      await readTasks({
        project: options.project,
        retentionDays: 36_500,
        ...(options.url === undefined ? {} : { url: options.url }),
      })
    ).map((t) => [t.issue, t]),
  );

  const now = (options.now ?? new Date()).getTime();
  const backoff = options.backoffMs;

  return options.offered
    .filter((o) => kinds.includes(o.kind))
    .filter((o) => {
      const row = seen.get(o.ref);
      // No row: Lingtai has never touched it, and GitHub is offering it.
      if (!row) return true;
      // A row that is not `queued` is one the log says is claimed, waiting on a
      // person, or finished. GitHub still listing the issue does not overrule
      // the log about what Lingtai is doing with it.
      if (row.state !== "queued") return false;
      return heldUntil(row, backoff, now) === null;
    })
    .map((o) => ({ taskId: workItemStream(options.project, o.ref), issue: o.ref, title: o.title, kind: o.kind }))
    .sort((a, b) => {
      const byKind = kinds.indexOf(a.kind) - kinds.indexOf(b.kind);
      if (byKind !== 0) return byKind;
      // Numerically, not lexically: #402 comes before #409 and both before #4100.
      return Number(a.issue) - Number(b.issue);
    });
}

/** The bit of a `task_view` row the backoff reads, and nothing more. */
export interface BackoffInput {
  lastAttemptAt: Date | null;
  /**
   * A repair bought and not yet claimed. Only a retired `RepairRequested` sets
   * it (`#143`), so it is false on every new ticket.
   */
  repairPending: boolean;
}

/**
 * When the backoff stops holding this row — `null` when it is not holding it.
 *
 * The same rule `selectRunnable` filters on, read forwards so that something
 * can be *said* about a held item rather than only subtracted. `[backing off]`
 * with no time on it is a state a person can see and cannot act on, which is
 * `#95`; the answer is one addition, and it belongs beside the subtraction that
 * uses it rather than in the CLI and again in the board.
 *
 * **A pending repair jumps it, and nothing new can buy one.** A repair was told
 * what went wrong, there was at most one per distinct failure, and the recipe
 * capped how many an item could buy, so it was neither blind nor unbounded
 * (0025 §3). A lane refusal buys no run since `#143`, so the exemption is only
 * ever read off a log written before it: an item the old code released for a
 * repair just before the daemon restarted is still owed the run it was
 * released for, and making it wait an hour would leave it stuck for an hour
 * longer. What answers a refusal inside the hour now is a round in the pass
 * that was refused, which never releases the item and never reaches this rule;
 * `lingtai now` is what a person uses to jump it.
 */
export function heldUntil(row: BackoffInput, backoffMs: number, now: number = Date.now()): Date | null {
  if (row.repairPending) return null;
  if (row.lastAttemptAt === null) return null;
  const until = row.lastAttemptAt.getTime() + backoffMs;
  return until > now ? new Date(until) : null;
}

/**
 * `2_700_000` → `45m`. What a person needs from a backoff is *when*, not how
 * many milliseconds — and both the CLI and the board have to say it, so they
 * say it the same way and in the units the recipe writes.
 *
 * Days, because the board asks this a second question. Every card carries how
 * long it has sat (#79), and "five minutes and three days look identical" was
 * the complaint — which `48h` answers correctly and unreadably. Nothing below a
 * day changes wording, so a backoff still reads exactly as it did.
 */
export function inWords(ms: number): string {
  if (ms <= 0) return "now";
  if (ms < 60_000) return "under a minute";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) {
    const hours = Math.floor(ms / 3_600_000);
    // Floored, not rounded: `Math.round` turns 1h 59m 40s into "1h 60m".
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/**
 * What a queued item the backoff is holding says, in one phrase.
 *
 * **The words, not the arithmetic.** `heldUntil` already stops the CLI and the
 * board having their own versions of *when*; this stops them having their own
 * versions of *what to call it*. `lingtai status` has printed
 * `[backing off — runnable in 32m]` since 0028 §4 and the board printed
 * `runnable in 32m` beside a hover nobody hovers, so the two places an operator
 * asks *why is this not moving* answered the same question in different words
 * (`#100`). They are one string now.
 *
 * `until` is `heldUntil`'s answer and is never null here: a row nothing is
 * holding has no backing-off to describe, and saying "runnable in now" would be
 * a phrase for a state that is not one.
 */
export function backingOff(until: Date, now: number = Date.now()): string {
  return `backing off — runnable in ${inWords(until.getTime() - now)}`;
}
