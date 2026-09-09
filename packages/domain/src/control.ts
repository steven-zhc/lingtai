/**
 * What the conductor has been told to do, folded.
 *
 * Vocabulary and a fold, in the package that holds both — for the reason
 * `streams.ts` gives about itself: this was in `daemon`, and it is needed by
 * something that must not depend on `daemon`. `conductor` is what discovers
 * that an account cannot start a run at all
 * ([0031](../../../doc/decisions/0031-a-run-that-never-started.md) §3), and
 * `daemon` already depends on `conductor`. A second copy of the fold in the
 * package that needed it would be two answers to "is the conductor paused".
 *
 * The I/O stays where it was: `@lingtai/daemon`'s `readControl` reads
 * `CONTROL_STREAM` and hands the envelopes to `reduceControl`, and everything
 * that appends to the stream still goes through the commands there.
 */
import type { Envelope } from "./envelope.ts";

/** One stream for the whole installation. Control is not per-project. */
export const CONTROL_STREAM = "ctl-conductor";

/** A standing request to drain and exit. Null when nobody has asked. */
export interface ShutdownRequest {
  by: string;
  reason: string;
  /**
   * How long the drain may take before the daemon gives up on it, or null.
   *
   * Null is the ordinary case and the safe one (0030 §6). A timeout that trips
   * leaves the agent running on purpose — the orphan `reconcile` now kills.
   */
  timeoutMs: number | null;
}

export interface ControlState {
  paused: boolean;
  /** Who paused it and why, when it is paused. */
  by: string | null;
  reason: string | null;
  /**
   * When this pause lifts by itself, or null.
   *
   * Non-null only while such a pause is actually holding: once the instant has
   * passed the fold reports the conductor as unpaused, which is what makes the
   * resume automatic rather than something a person has to remember (0031 §5).
   */
  until: Date | null;
  /**
   * Who asked it to stop and why, when somebody has.
   *
   * Separate from `paused` because they are separate facts: a paused conductor
   * is still there to be resumed, and a draining one is on its way out. The
   * board keeps them as separate chips for the same reason (#77).
   *
   * It is also why a drain and a pause that ends by itself **compose** rather
   * than race (0031 §3): one stops taking work and exits, the other stops
   * taking work and resumes, and an expiring pause clears neither this field
   * nor the exit it is asking for.
   */
  shutdown: ShutdownRequest | null;
  /** Tasks somebody asked for by hand, oldest first, not yet taken. */
  requested: { project: string; issue: string; by: string }[];
}

export const emptyControl: ControlState = {
  paused: false,
  by: null,
  reason: null,
  until: null,
  shutdown: null,
  requested: [],
};

/**
 * The control stream, as the state it describes.
 *
 * Cheap: it is a handful of events, not a history.
 *
 * `now` is a parameter because one of the answers depends on the clock — a
 * pause that carries an expiry is over when the expiry is past, and the fold is
 * where that is decided. It is decided here rather than by whoever pauses
 * because nothing else runs at the moment the limit lifts: the alternative to
 * reading it at fold time is a timer somebody has to still be holding.
 */
export function reduceControl(events: readonly Envelope[], now: Date = new Date()): ControlState {
  const state: ControlState = { ...emptyControl, requested: [] };

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const str = (k: string): string | null => (typeof d[k] === "string" ? (d[k] as string) : null);
    switch (e.type) {
      case "ConductorPaused": {
        state.paused = true;
        state.by = str("by");
        state.reason = str("reason");
        // Absent on every pause written before 0031, and null on every pause a
        // person makes. An unparseable one is the same answer as none: a pause
        // nothing can prove ends holds until somebody lifts it.
        const until = str("until");
        const at = until === null ? Number.NaN : Date.parse(until);
        state.until = Number.isNaN(at) ? null : new Date(at);
        break;
      }
      case "ConductorShutdownRequested": {
        const timeout = d["timeoutMs"];
        state.shutdown = {
          by: str("by") ?? "",
          reason: str("reason") ?? "",
          timeoutMs: typeof timeout === "number" ? timeout : null,
        };
        break;
      }
      case "ConductorResumed":
        state.paused = false;
        state.by = null;
        state.reason = null;
        state.until = null;
        // Resume is the only way to withdraw a shutdown, and it must be one:
        // the request is in the stream for ever, so a daemon started after it
        // would find it waiting and stop again, and again.
        state.shutdown = null;
        break;
      case "RunRequested":
        state.requested.push({
          project: str("project") ?? "",
          issue: str("issue") ?? "",
          by: str("by") ?? "",
        });
        break;
      default:
        break;
    }
  }

  // The pause that ends by itself, ending. Nothing is appended when it does:
  // an expiry that had to be written down would be a second thing that can be
  // missed, and the event that set it already says everything a reader needs.
  if (state.paused && state.until !== null && state.until.getTime() <= now.getTime()) {
    state.paused = false;
    state.by = null;
    state.reason = null;
    state.until = null;
  }

  return state;
}
