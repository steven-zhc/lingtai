/**
 * A subscriber declared in the recipe, as something the log's follower can call.
 *
 * The other half of the taxonomy, and the same primitive:
 * [0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §3 — *"the
 * whole taxonomy is: a command, and whether the core waits for it."* A gate
 * action's exit code is a verdict about a commit, so `process-gate.ts` awaits
 * it; a subscriber's is discarded, so this does not, and `startCommand` is the
 * caller that does not wait.
 *
 * ## Not waiting is not the same as not looking
 *
 * `consider` returns a promise that settles when the command does — resolved on
 * exit 0, rejected with the evidence on anything else. Nobody awaits it:
 * `deliver` in `work-loop.ts` holds it exactly as it holds the in-process
 * notifier's, which is what turns a refusal into a `PluginFailed` (§7) without
 * putting the command on the pass path. A subscriber that hangs, exits 1 or
 * cannot be spawned at all is three sentences in one stream and no effect on
 * the run.
 *
 * The bound is here as well as there, and the two are different questions. This
 * one is the command's own timeout, and it is short: a subscriber is an HTTP
 * call and a process start, so a minute is already generous. `deliver`'s ten
 * minutes is about a subscriber that never settles at all, and with this timer
 * in front of it the reason recorded is the useful one.
 *
 * ## The event has to survive JSON
 *
 * `Envelope.seq` is a `bigint` and `JSON.stringify` **throws** on one — so a
 * subscriber that sent the envelope as it stands would fail on every event,
 * inside the boundary, and read as a broken extension. `seq` and `causation`
 * go as decimal strings and `at` as ISO text; `parseEvent` on the other side
 * puts them back. That is the whole of the wire format, and 0037's open item on
 * a protocol version is about it.
 */
import type { Envelope } from "@lingtai/domain";
import type { Subscriber } from "@lingtai/recipe";
import { startCommand } from "./command.ts";

/**
 * How long a subscriber's process may take before it is killed and recorded.
 *
 * Not configurable, because `Subscriber` has no `timeout:` field and adding one
 * would be a recipe change rather than this file's decision. A minute for a
 * message and a process start; the failure a longer one buys is a notifier that
 * looks fine and is minutes behind.
 */
export const SUBSCRIBER_COMMAND_TIMEOUT_MS = 60_000;
const TIMEOUT_LABEL = "1m";

/** One subscriber, ready to be handed events. */
export interface EventSubscriber {
  /** The recipe's `name:`. It is what `PluginFailed` records. */
  readonly name: string;
  /** The project whose recipe declared it. */
  readonly project: string;
  /**
   * Whether this event is one of its own — answered without spending a
   * process, which is what `on:` being the subscription buys (0037 §3).
   *
   * Two questions, and the second is the one that is easy to forget.
   * `subscribers:` is declared in **a project's** recipe, so a second project's
   * landing is not this subscriber's business; a work item's stream names the
   * project, and that is the match. An event that names none — a pause, a
   * shutdown, a discussion — belongs to the installation rather than to a
   * repository, so every subscriber that asked for the type is told. The
   * alternative is a `ConductorPaused` in an `on:` list that parses, resolves
   * and never fires, which is the failure `SubscribedEvent` exists to refuse.
   */
  wants(event: Envelope): boolean;
  /**
   * Runs it. The promise settles with the command; the caller does not await
   * it, and must hold it — see `deliver`.
   */
  consider(event: Envelope): Promise<void>;
}

export interface SubscriberDeps {
  /**
   * The declared names of this subscriber → the whole environment its process
   * gets (0037 §1), including `runnableEnv`'s six.
   *
   * A function for the reason `GateDeps.env` is one: only the caller can read
   * 0021's layers, and this package has no machine to read.
   */
  env: (declared: readonly string[]) => Record<string, string>;
  /**
   * Where the command runs. A subscriber has no worktree — it is not judging a
   * diff — so the caller names somewhere neutral rather than the directory the
   * daemon happens to have been started in.
   */
  cwd: string;
  timeoutMs?: number;
}

export function subscribersFromRecipe(
  project: string,
  subscribers: readonly Subscriber[],
  deps: SubscriberDeps,
): EventSubscriber[] {
  return subscribers.map((declared) => {
    // A Set built once, not a scan per event: the follower offers every append
    // to every subscriber, which is thousands of questions a run.
    const on = new Set(declared.on);
    const env = deps.env(declared.env);
    const timeoutMs = deps.timeoutMs ?? SUBSCRIBER_COMMAND_TIMEOUT_MS;

    return {
      name: declared.name,
      project,
      wants(event) {
        if (!on.has(event.type)) return false;
        const of = projectOf(event.streamId);
        return of === null || of === project;
      },
      consider(event) {
        return new Promise<void>((resolve, reject) => {
          startCommand(
            {
              run: declared.run,
              timeoutMs,
              timeoutLabel: TIMEOUT_LABEL,
              cwd: deps.cwd,
              env,
              payload: wireEvent(event),
            },
            (outcome) => {
              if (outcome.ok) resolve();
              else reject(new Error(outcome.evidence));
            },
          );
        });
      },
    };
  });
}

/**
 * `wi-project-155` → its project, and null for every other stream.
 *
 * The `wi-` prefix is required rather than stripped-if-present, which is what
 * `parseWorkItemStream` does: without it `ctl-conductor` parses as the project
 * "ctl", and a pause would be delivered to whichever project was unluckily
 * named. The same rule, for the same reason, as `projectOf` in
 * `packages/daemon/src/notify.ts`.
 */
function projectOf(streamId: string): string | null {
  if (!streamId.startsWith("wi-")) return null;
  const body = streamId.slice(3);
  const cut = body.lastIndexOf("-");
  return cut <= 0 ? null : body.slice(0, cut);
}

/** The envelope as JSON can carry it. See the note at the top of this file. */
export function wireEvent(event: Envelope): Record<string, unknown> {
  return {
    seq: event.seq.toString(),
    streamId: event.streamId,
    version: event.version,
    type: event.type,
    schemaVer: event.schemaVer,
    data: event.data,
    actor: event.actor,
    causation: event.causation === null ? null : event.causation.toString(),
    at: event.at.toISOString(),
  };
}
