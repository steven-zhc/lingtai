/**
 * Starting a subscriber, and not waiting for it.
 *
 * The whole of the extension mechanism's other half
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §2 and §3):
 * **an extension is a command, and the only question is whether the core
 * waits.** A gate action's exit code is a verdict, so `process-gate.ts` turns it
 * into one. Nothing reads a subscriber's, so this turns it into *did it come
 * back at all* — and hands even that to the caller as a rejection, because the
 * daemon already has the one boundary that knows what to do with a subscriber
 * that did not (`work-loop.ts`'s `deliver`, which appends `PluginFailed`).
 *
 * It is deliberately thin. The spawning, the bounded buffer, the log tail and
 * the distinction between a timeout and a refusal are `command.ts`'s, exactly
 * as they are a gate's; what is here is the payload on stdin and the reading of
 * an exit code as *nothing to report*.
 *
 * ## What it does not do
 *
 * **It does not retry.** 0015's rule, unchanged: a subscriber exists for
 * effects that are worthless late, and a notification delivered an hour after
 * the decision trains you to ignore the next one.
 *
 * **It does not read stdout for structure.** stdout is the failure output of
 * every ordinary `run:` command and is spoken for (0037 §4); a subscriber that
 * wants to say something says it by exiting non-zero, and what it printed
 * becomes the reason on the log.
 */
import { parseDuration, type Subscriber } from "@lingtai/recipe";
import type { Envelope } from "@lingtai/domain";
import { parseWorkItemStream, streamProject } from "@lingtai/domain";
import { runCommand } from "./command.ts";
import { tail } from "./command.ts";

/**
 * What an extension is handed on stdin.
 *
 * A public contract the moment somebody else writes an extension, which is why
 * it is one shape in one place rather than an object literal at the call site.
 * `schema` is here for the reason events carry `schemaVer`: 0037 records that
 * this payload has no upcaster yet, and a version nobody wrote down is a
 * version that cannot be added later without guessing.
 *
 * `seq` and `causation` are strings. They are `bigint` in the log, and
 * `JSON.stringify` refuses a bigint outright — a subscriber that received a
 * silently truncated sequence number would be worse.
 */
export interface SubscriberPayload {
  schema: 1;
  event: {
    seq: string;
    streamId: string;
    version: number;
    type: string;
    schemaVer: number;
    actor: string;
    causation: string | null;
    at: string;
    data: unknown;
  };
  /** The repository this is about, or null when it is about none. */
  project: string | null;
  /**
   * The ticket, when the event has one — 0037's *"`GateContext` gains the
   * ticket"*, for the other kind of extension.
   *
   * **Payload, not a capability.** An extension does not ask for it and is not
   * granted it: an event nobody can name a ticket for is one nobody can act on,
   * and a subscriber that had to look one up would need the log, which is the
   * thing it is deliberately not given. The attempt history stays where 0037
   * left it — in the log, behind a capability nothing has yet.
   */
  ticket: { project: string; issue: string; stream: string } | null;
  /** Where a person would go about it. The extension does not have to build a link. */
  board: { url: string; task: string | null };
}

export interface PayloadContext {
  boardUrl: string;
  /** The repository, resolved by the caller — a `run-<uuid>` does not carry one. */
  project?: string | null;
  /** The work item stream this event is about, when it is about one. */
  workItem?: string | null;
}

/**
 * The event, as an extension sees it.
 *
 * `project` and `workItem` are supplied rather than derived, because half the
 * streams a subscribed event can arrive on do not carry either: an
 * `IntegrationRefused` is on `int-<project>-<base>` and a `RunAwaitingInput` is
 * on `run-<uuid>`. Deriving what it could and leaving the rest null is what the
 * notifier this replaces did, and it is why a question from a running agent
 * reached a laptop with no ticket number and no link on it.
 */
export function subscriberPayload(event: Envelope, context: PayloadContext): SubscriberPayload {
  const workItem = context.workItem ?? (event.streamId.startsWith("wi-") ? event.streamId : null);
  const parsed = workItem === null ? null : parseWorkItemStream(workItem);
  return {
    schema: 1,
    event: {
      seq: String(event.seq),
      streamId: event.streamId,
      version: event.version,
      type: event.type,
      schemaVer: event.schemaVer,
      actor: event.actor,
      causation: event.causation === null ? null : String(event.causation),
      at: event.at.toISOString(),
      data: event.data,
    },
    project: context.project ?? streamProject(event.streamId),
    ticket:
      parsed === null || workItem === null
        ? null
        : { project: parsed.project, issue: parsed.issue, stream: workItem },
    board: {
      url: context.boardUrl,
      task: workItem === null ? null : `${context.boardUrl}/task/${encodeURIComponent(workItem)}`,
    },
  };
}

export interface RunSubscriberOptions {
  /** Where it runs. Never a worktree — a subscriber holds no verdict about a commit. */
  cwd: string;
  /** Its own, resolved by name from the recipe. Never the daemon's (0037 §1). */
  env: Record<string, string>;
  payload: SubscriberPayload;
  signal?: AbortSignal;
}

/**
 * Runs one subscriber. Resolves when it exited 0; **rejects otherwise**.
 *
 * A rejection rather than a result type, because the one caller that matters
 * already treats a rejected subscriber correctly and structurally — the
 * boundary in `work-loop.ts` holds a throw, a rejection and a hang identically
 * and records each as `PluginFailed`. Returning `{ ok: false }` here would ask
 * that caller to remember to look, which is the shape of guarantee 0037 §5 and
 * `#120` were both about removing.
 */
export async function runSubscriber(
  spec: Subscriber,
  options: RunSubscriberOptions,
): Promise<void> {
  const outcome = await runCommand({
    run: spec.run,
    timeoutMs: parseDuration(spec.timeout),
    timeoutLabel: spec.timeout,
    cwd: options.cwd,
    env: options.env,
    stdin: `${JSON.stringify(options.payload)}\n`,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (outcome.ok) return;
  // The tail again, tighter: this becomes `PluginFailed`'s `reason`, which the
  // doctor prints on one line beside three others. A gate's evidence is read on
  // a card that exists to hold it; this one is read in a list.
  throw new Error(tail(outcome.evidence, 6, 500));
}
