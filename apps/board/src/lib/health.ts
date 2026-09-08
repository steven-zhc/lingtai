/**
 * Whether the board you are looking at is current — and if not, whether
 * anything is going to fix it.
 *
 * The chip used to report whether the SSE socket was open, which is the one
 * thing that was never in doubt on the morning it lied: socket open, chip
 * green, board frozen for the whole of a `lingtai run` (`#64`). An open socket
 * says events are arriving; it says nothing about whether anything folded them.
 *
 * So this reads the two facts that actually decide it. **Lag** is the
 * projection's distance from the head of the log, and it is the answer on its
 * own when it is zero. **The beacon** only matters when lag is not zero, and
 * then it is the whole difference between "catching up" and "nobody is coming":
 * since [0022](../../../../doc/decisions/0022-the-seams.md) a `lingtai run`
 * holds a projector of its own, so lag with no daemon is normal during a run
 * and a standing accusation after one.
 */
import { STALE_AFTER_MS, readStatus } from "@lingtai/daemon/control";
import { projectionLag } from "@lingtai/projector";

export interface Health {
  /** Events between the projection and the head. Null when it was never built. */
  lag: number | null;
  /** `up` while something is beating; `stale` after three missed beats. */
  daemon: "up" | "stale" | "never";
  /** Milliseconds since the last beat, for the tooltip. Null when never. */
  sinceBeatMs: number | null;
  /** Set when the health read itself failed, which is its own kind of answer. */
  error?: string;
}

const PROJECTION = "task_view";

export async function readHealth(): Promise<Health> {
  try {
    // Two reads rather than one join: they are different tables owned by
    // different mechanisms, and a join would imply they fail together.
    const [lags, status] = await Promise.all([
      projectionLag().catch(() => []),
      readStatus().catch(() => null),
    ]);

    const row = lags.find((l) => l.name === PROJECTION);
    const lag = row ? Number(row.lag) : null;

    if (!status) return { lag, daemon: "never", sinceBeatMs: null };
    const since = Date.now() - status.lastSeenAt.getTime();
    return {
      lag,
      daemon: since > STALE_AFTER_MS ? "stale" : "up",
      sinceBeatMs: since,
    };
  } catch (err) {
    // Reported as its own state. A board that cannot tell you whether it is
    // current must not render as though it is.
    return { lag: null, daemon: "never", sinceBeatMs: null, error: (err as Error).message };
  }
}
