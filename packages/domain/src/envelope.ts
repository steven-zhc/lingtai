import { z } from "zod";

/**
 * What wraps every event. The store fills `seq` and `at`; everything else is
 * supplied by whoever appends.
 */
/**
 * Who appended it.
 *
 * `daemon` is a supervisor's start — launchd's `KeepAlive`, a systemd unit, a
 * `nohup` — and it is here because `ConductorStarted` has always *said* it was
 * (`by`'s own docstring: "a daemon whose stdin is not a terminal … is recorded
 * as `daemon`, because the log saying a person started what launchd started by
 * itself is the unattributable 23:06 again"). It was not in this pattern, so
 * every one of those starts failed to append and said so into a log nobody was
 * reading — the documented design refused by the validator, which is *true
 * where it was written and false where it is read*.
 *
 * The cost was exactly what 0042 exists to prevent: *who restarted it at 23:06*
 * is unanswerable for supervised starts, which are the ones nobody witnessed.
 * Not `conductor`: that is the process appending about its own work, and a
 * supervisor starting it is a different fact about a different actor.
 */
export const Actor = z
  .string()
  .regex(
    /^(conductor|daemon|github|agent:[\w-]+|human:[\w.@-]+)$/,
    "actor must be conductor, daemon, github, agent:<runId> or human:<id>",
  );

export const StreamId = z
  .string()
  .regex(
    /^(wi|run|int|prj|ctl|chat|ext|bkl)-[\w.-]+$/,
    // `bkl` is one minor finding's decision
    // ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
    // §5, `#137`). Not the work item's stream: a person triages the backlog
    // while a later attempt of the same ticket may be appending there, and a
    // decision must not become a `ConcurrencyError` in the middle of that run.
    // `ctl` is the operator's own aggregate: pauses, resumes and hand-picked
    // runs. One stream for the whole installation — control is not per-project,
    // and a pause that only stopped one repository would be a surprise.
    //
    // `chat` is one discussion about one work item
    // ([0033](../../../doc/decisions/0033-the-third-kind-of-agent.md) §6). Its
    // own aggregate because a forty-turn exploration on the work item's stream
    // would drown the history the detail page exists to show — permanently,
    // the log being append-only. The work item keeps one `DiscussionHeld`
    // pointing at it.
    //
    // `ext` is what an extension did that no work item is answerable for
    // ([0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md)
    // names the two kinds). A subscriber failure cannot go on the stream of the
    // event it failed on: the daemon follows the log while a run is appending
    // to that stream, so writing back to it would turn a notifier's bad day
    // into a `ConcurrencyError` in the middle of a run.
    "streamId must be wi-… (work item), run-…, int-… (integration lane), prj-… (project), ctl-… (control), chat-… (discussion), ext-… (extension) or bkl-… (backlog)",
  );

export interface Envelope<T = unknown> {
  /** Global order, assigned by the store. */
  seq: bigint;
  streamId: string;
  /** Position within the stream, from 1. */
  version: number;
  type: string;
  /** Which shape `data` is in. Upcasting on read keys off this. */
  schemaVer: number;
  data: T;
  actor: string;
  /** The seq of the event that caused this one, when there is one. */
  causation: bigint | null;
  at: Date;
}

/** What an appender supplies. `seq` and `at` belong to the store. */
export type ToAppend<T = unknown> = Pick<Envelope<T>, "type" | "data" | "actor"> & {
  schemaVer?: number;
  causation?: bigint | null;
};
