/**
 * The backlog page's read, and whether what it read is current (`#137`).
 *
 * `finding_backlog` is a second projection, and nothing guarantees anything is
 * folding it: a daemon started before it existed keeps the code it started with
 * and follows `task_view` alone, and the board holds no projector. Read bare,
 * a table nobody built is an empty list and a table nobody follows is a frozen
 * one — both of which render as *nothing open*, which is the one thing a
 * backlog page must never say falsely.
 *
 * So the read folds to the head first, the way `lingtai backlog` does: a
 * catch-up that closes, not a projector left following. Two folders on one log
 * converge, and every handler in the backlog is idempotent on its key. Then it
 * says how far behind it still is — and the page says *nothing open* only when
 * that is zero.
 */
import {
  type BacklogEntry,
  backlogProjection,
  createProjectionRunner,
  readBacklog,
} from "@lingtai/projector";

export interface BacklogCurrency {
  /** Events between the backlog and the head, after the fold. Null when unknown. */
  lag: number | null;
  /** Why the fold, or the read of its lag, did not succeed. */
  error?: string;
}

/** Fold `finding_backlog` to the head, then read it. */
export async function currentBacklog(): Promise<{ entries: BacklogEntry[]; currency: BacklogCurrency }> {
  const runner = createProjectionRunner({ projection: backlogProjection });
  let error: string | undefined;
  let lag: number | null = null;
  try {
    await runner.start();
  } catch (err) {
    error = (err as Error).message;
  }
  try {
    lag = Number((await runner.lag()).lag);
  } catch (err) {
    error ??= (err as Error).message;
  } finally {
    await runner.close().catch(() => {});
  }
  const entries = await readBacklog();
  return { entries, currency: error ? { lag, error } : { lag } };
}

/** What the bar says about the backlog's currency. Ordered worst-first. */
export function backlogChip(c: BacklogCurrency): {
  current: boolean;
  label: string;
  tone: "live" | "idle" | "warn";
  title: string;
} {
  const repair = "lingtai projection rebuild finding_backlog";
  if (c.error) {
    return {
      current: false,
      label: c.lag === null ? "not current" : `behind ${c.lag}`,
      tone: "warn",
      title: `the backlog could not be brought to the head: ${c.error} — ${repair}`,
    };
  }
  if (c.lag === null) {
    return { current: false, label: "unknown", tone: "warn", title: `could not read the backlog's lag — ${repair}` };
  }
  if (c.lag === 0) return { current: true, label: "current", tone: "live", title: "finding_backlog is at the head" };
  // The fold reached the head it saw; appends since then are the ordinary case
  // on a busy log, and the next render folds them.
  return {
    current: false,
    label: `behind ${c.lag}`,
    tone: "idle",
    title: `${c.lag} event(s) arrived after this page folded the backlog — reload to fold them`,
  };
}
