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

/** Long enough that a failing ticket stops costing money; short enough to retry today. */
export const DEFAULT_BACKOFF_MS = 60 * 60_000;

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
   */
  backoffMs?: number;
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
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;

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
      return row.lastAttemptAt === null || now - row.lastAttemptAt.getTime() >= backoff;
    })
    .map((o) => ({ taskId: workItemStream(options.project, o.ref), issue: o.ref, title: o.title, kind: o.kind }))
    .sort((a, b) => {
      const byKind = kinds.indexOf(a.kind) - kinds.indexOf(b.kind);
      if (byKind !== 0) return byKind;
      // Numerically, not lexically: #402 comes before #409 and both before #4100.
      return Number(a.issue) - Number(b.issue);
    });
}

