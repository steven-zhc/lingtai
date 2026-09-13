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
  /**
   * Where the request sits on `ctl-conductor`, which is what names it.
   *
   * A request carries no id of its own and does not need one: the stream is
   * the installation's, and a position on it is unique. `ConductorShutdownWithdrawn`
   * names a request by this, so withdrawing one can never lift a newer one.
   */
  version: number;
}

/**
 * A restart whose start a supervisor is to make, not yet answered by a start.
 *
 * `lingtai restart` under launchd or systemd cannot start the daemon itself —
 * that would be a second conductor in a terminal beside the supervised one — so
 * it withdraws its drain with this and asks the supervisor. The daemon the
 * supervisor starts reads it here, and records the restart's `by` and `reason`
 * when the commit it is running is `sha` (0042 §8).
 */
export interface Handoff {
  by: string;
  reason: string;
  sha: string | null;
  dirty: boolean;
  /** The withdrawal's own version, which `ConductorStarted.handoff` names. */
  version: number;
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
  /**
   * The restart a supervisor's start is to answer, or null.
   *
   * **The next start takes it or clears it**, whoever makes it. A handoff the
   * supervisor never acted on must not be claimed days later by a daemon it
   * has nothing to do with, and a newer drain supersedes it.
   */
  handoff: Handoff | null;
  /** Tasks somebody asked for by hand, oldest first, not yet taken. */
  requested: { project: string; issue: string; by: string }[];
  /**
   * Questions asked of the discussion assistant, oldest first — every one of
   * them, answered or not.
   *
   * Not filtered here, and that is deliberate. A request is satisfied when
   * `chat-<id>` carries an answer for it, which is a fact on a different stream
   * than this fold reads; asking the chat stream is the daemon's job, and it is
   * the same shape as `requested`, which is satisfied by the item ceasing to be
   * queued. Keeping the decision out of this fold is what stops the control
   * stream growing a second state machine
   * ([0033](../../../doc/decisions/0033-the-third-kind-of-agent.md) §6).
   */
  discussions: DiscussionRequest[];
}

/** One question, as `DiscussionRequested` recorded it. */
export interface DiscussionRequest {
  chatId: string;
  workItemId: string;
  attempt: number | null;
  question: string;
  by: string;
}

export const emptyControl: ControlState = {
  paused: false,
  by: null,
  reason: null,
  until: null,
  shutdown: null,
  handoff: null,
  requested: [],
  discussions: [],
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
  const state: ControlState = { ...emptyControl, requested: [], discussions: [] };

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
          version: e.version,
        };
        // A drain asked after a handoff is a newer decision than it.
        state.handoff = null;
        break;
      }
      case "ConductorShutdownWithdrawn": {
        // The request named, or nothing. A withdrawal that lost a race to a
        // newer request must leave that request standing — it is somebody
        // else's, and lifting it is the one thing a restart may not do (0042).
        // A pause is untouched either way, which is the whole difference
        // between this and `ConductorResumed`.
        if (state.shutdown === null || state.shutdown.version !== d["version"]) break;
        state.shutdown = null;
        const h = d["handoff"] as { sha?: unknown; dirty?: unknown } | null | undefined;
        if (h && typeof h === "object") {
          state.handoff = {
            by: str("by") ?? "",
            reason: str("reason") ?? "",
            sha: typeof h.sha === "string" ? h.sha : null,
            dirty: h.dirty === true,
            version: e.version,
          };
        }
        break;
      }
      case "ConductorStarted":
        // Any start ends a handoff — the one that answered it, or one that did
        // not and so says it will not be answered (see `handoff` above).
        state.handoff = null;
        break;
      case "ConductorResumed":
        state.paused = false;
        state.by = null;
        state.reason = null;
        state.until = null;
        // Resume withdraws any shutdown, and it must: `ConductorShutdownWithdrawn`
        // lifts only the one request it names, and a person typing `lingtai
        // resume` means all of it. The request is in the stream for ever, so a
        // daemon started after it would find it waiting and stop again, and again.
        state.shutdown = null;
        break;
      case "RunRequested":
        state.requested.push({
          project: str("project") ?? "",
          issue: str("issue") ?? "",
          by: str("by") ?? "",
        });
        break;
      case "DiscussionRequested": {
        const attempt = d["attempt"];
        state.discussions.push({
          chatId: str("chatId") ?? "",
          workItemId: str("workItemId") ?? "",
          attempt: typeof attempt === "number" ? attempt : null,
          question: str("question") ?? "",
          by: str("by") ?? "",
        });
        break;
      }
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
