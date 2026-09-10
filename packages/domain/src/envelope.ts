import { z } from "zod";

/**
 * What wraps every event. The store fills `seq` and `at`; everything else is
 * supplied by whoever appends.
 */
export const Actor = z
  .string()
  .regex(
    /^(conductor|github|agent:[\w-]+|human:[\w.@-]+)$/,
    "actor must be conductor, github, agent:<runId> or human:<id>",
  );

export const StreamId = z
  .string()
  .regex(
    /^(wi|run|int|prj|ctl|chat|ext)-[\w.-]+$/,
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
    "streamId must be wi-… (work item), run-…, int-… (integration lane), prj-… (project), ctl-… (control), chat-… (discussion) or ext-… (extension)",
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
