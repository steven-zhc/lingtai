/**
 * A subscriber: a command that is told what happened and is never waited for.
 *
 * It lives beside `createProcessGate` because it is the same primitive, and
 * that is [0037](../../../doc/decisions/0037-an-extension-is-a-command.md)'s
 * whole claim — **the taxonomy is a command, and whether the core waits for
 * it.** A gate action's exit code is a verdict, so `runGatePipeline` holds for
 * it; this one's is not, so nothing does. There is no registry, no manifest and
 * no loader, because `run:` already starts a process out of ours, on a clock,
 * from a declaration in the recipe.
 *
 * ## Who is told, and about what
 *
 * Two rules, and the second is the one that had to be built rather than
 * assumed:
 *
 * 1. **`on:` is the subscription.** A type the recipe did not name starts no
 *    process.
 * 2. **A subscriber hears about the project whose recipe declared it.** The
 *    `Subscriber` block has no `project:` field because it does not need one —
 *    it is in that repository's `.lingtai/config.yaml`, and that is the whole
 *    of the answer.
 *
 * The second rule needs somebody to say which project an event is *about*, and
 * three of the four types Lingtai's own recipe names cannot answer that from
 * their own bytes: `ApprovalRequested` and `RunAwaitingInput` are on a run
 * stream, `IntegrationRefused` on an integration lane. So `subject` is asked,
 * and it is a callback for the reason `GateDeps.env` is one — only the caller
 * has the log to read, and this package deliberately has no store. A `subject`
 * that answers null means *this event belongs to no repository*, and an event
 * belonging to no repository reaches nobody.
 *
 * ## Where the failure goes
 *
 * `deliver` **rejects** when the command could not start, refused or hung. That
 * looks at first like a contradiction of 0037 §5 — *"a subscriber has no
 * `on-error` setting; its failure is always ignored, structurally, because
 * nothing reads its exit code"* — and it is not. Ignored there means *it cannot
 * change any outcome*: no work item is blocked, no gate refuses, no pass waits.
 * §7 asks for the opposite of silence about the same fact: *"a subscriber whose
 * failure is a console line is a notifier that has silently stopped notifying —
 * the one failure mode a notifier must not have."*
 *
 * So the exit code is read in `startCommand`'s report — which that function's
 * own note calls the only place the event could come from — turned into a
 * rejection, and handed to the daemon's subscriber boundary, which appends
 * `PluginFailed` and carries on. Nothing else in the system can see it.
 *
 * The rejection is what carries it because `PluginFailed` is an append, and
 * appending needs the log. `work-loop.ts`'s `deliver` already holds a
 * subscriber's promise, serialises the appends and refuses to record a failure
 * about `PluginFailed` itself, so the rejection hands it the one thing it
 * wants. **Rejecting is not waiting**: that boundary voids the promise, and no
 * pass, gate or queue pass is behind it.
 */
import { type Envelope, workItemStream } from "@lingtai/domain";
import { parseDuration, type Subscriber as SubscriberSpec } from "@lingtai/recipe";
import { startCommand } from "./command.ts";

/**
 * How long a subscriber's process may take before it is killed.
 *
 * Fixed rather than declared, because `Subscriber` has no `timeout:` and 0037
 * §3's example has none either — a subscriber is a message being sent, not a
 * build. Deliberately well under `work-loop.ts`'s `SUBSCRIBER_TIMEOUT_MS`: that
 * one is the backstop for a promise that never settles at all, and this is what
 * actually ends the process and produces evidence saying so. If they were equal
 * the two would race and the failure recorded would be whichever timer fired
 * first, which is not a fact about anything.
 */
export const SUBSCRIBER_COMMAND_TIMEOUT = "2m";
/** Read off the label rather than written twice, so the two cannot say different things. */
export const SUBSCRIBER_COMMAND_TIMEOUT_MS = parseDuration(SUBSCRIBER_COMMAND_TIMEOUT);

/**
 * The work item an event is about, however it was found out.
 *
 * `id` is here as well as its two halves so that a subscriber never has to know
 * how a stream is spelled — the board link is `id`, and a command written by
 * somebody else should not have to reconstruct `wi-{project}-{n}` to make one.
 */
export interface EventSubject {
  id: string;
  project: string;
  issue: string;
}

/**
 * What arrives on the command's stdin (0037 §4).
 *
 * A public contract from the moment somebody else writes a subscriber, and it
 * has no version of its own yet — which 0037 records as open. Two fields are
 * not the envelope as the store holds it, and both are because this is JSON:
 * `seq` is a string, because a 64-bit integer does not survive a JSON number,
 * and `at` is ISO-8601.
 */
export interface SubscriberPayload {
  event: {
    /** Decimal, as a string. `bigint` has no JSON representation. */
    seq: string;
    streamId: string;
    version: number;
    type: string;
    schemaVer: number;
    actor: string;
    causation: string | null;
    /** ISO-8601, UTC. */
    at: string;
    data: unknown;
  };
  /** The work item it is about — never null, because an event without one is never delivered. */
  workItem: EventSubject;
  /** Where the board is, so a subscriber can link without knowing the deployment. */
  board: string;
}

/**
 * One built subscriber.
 *
 * `wants` is public and `deliver` re-asks it, which is a duplicate only if you
 * read them as the same question. `wants` is *would this type ever interest
 * anyone here* — the caller's, so that resolving an event's project, which can
 * cost a read of the log, is not paid for an event nobody named. `deliver`'s
 * check is the subscription itself, and it is inside `deliver` for `#120`'s
 * reason: a filter the caller is relied upon to apply holds until somebody
 * writes the second caller.
 */
export interface Subscriber {
  /** As the recipe named it. It is what `PluginFailed` records. */
  readonly name: string;
  /** The project whose recipe declared it. */
  readonly project: string;
  /** True when the recipe named this type in `on:`. */
  wants(type: string): boolean;
  /** Starts the command, and resolves without one for an event it is not owed. */
  deliver(event: Envelope): Promise<void>;
}

export interface SubscriberOptions {
  /** The project whose recipe declared it. It hears about that project and nothing else. */
  project: string;
  spec: SubscriberSpec;
  /**
   * Which work item an event is about, or null for one that belongs to no
   * repository.
   *
   * Asked at most once per delivered event, and only after `on:` has already
   * matched — an answer can cost a read of the run's stream, and paying that
   * for every append would make following the log more expensive the more
   * subscribers exist.
   */
  subject: (event: Envelope) => Promise<EventSubject | null>;
  /** Where the command runs. There is no worktree for an event, so this is the daemon's own. */
  cwd: string;
  /** Every credential it gets — the names declared beside it, plus `runnableEnv`'s six (0037 §1). */
  env: Record<string, string>;
  board: string;
}

export function createSubscriber(options: SubscriberOptions): Subscriber {
  const { spec } = options;
  const on = new Set(spec.on);

  return {
    name: spec.name,
    project: options.project,
    wants: (type) => on.has(type),

    async deliver(event) {
      if (!on.has(event.type)) return;
      const workItem = await options.subject(event);
      if (workItem === null || workItem.project !== options.project) return;

      const payload: SubscriberPayload = {
        event: {
          seq: event.seq.toString(),
          streamId: event.streamId,
          version: event.version,
          type: event.type,
          schemaVer: event.schemaVer,
          actor: event.actor,
          causation: event.causation === null ? null : event.causation.toString(),
          at: event.at.toISOString(),
          data: event.data,
        },
        workItem,
        board: options.board,
      };

      await new Promise<void>((resolve, reject) => {
        startCommand(
          {
            run: spec.run,
            timeoutMs: SUBSCRIBER_COMMAND_TIMEOUT_MS,
            timeoutLabel: SUBSCRIBER_COMMAND_TIMEOUT,
            cwd: options.cwd,
            env: options.env,
            payload,
          },
          // Read here and acted on nowhere else. See the note on where the
          // failure goes: this is the only reader of a subscriber's exit code
          // in the system, and all it does is choose which way to settle.
          (outcome) => (outcome.ok ? resolve() : reject(new Error(outcome.evidence))),
        );
      });
    },
  };
}

/** `wi-{project}-{n}` and its two halves, from the halves. */
export function subjectOf(project: string, issue: string): EventSubject {
  return { id: workItemStream(project, issue), project, issue };
}
