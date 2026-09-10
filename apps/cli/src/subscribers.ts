/**
 * Building the daemon's subscribers out of the recipes, and answering which
 * project an event is about.
 *
 * The whole of `#123`'s first half. The daemon used to construct its one
 * notifier by name — `macNotifier()` in `lingtai.ts` — which
 * [0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §3 names as
 * the thing to remove: a decent interface with exactly one implementation and
 * no way to declare a second. Now the daemon starts what the recipes declared
 * and names none of it, and Lingtai's own desktop notification is the first
 * thing across that boundary because it needs no credentials.
 *
 * ## Which project an event is about
 *
 * A subscriber is declared in one repository's `.lingtai/config.yaml`, so it
 * hears about that repository and nothing else — that is what makes "a project
 * with no `subscribers:` gets no notifications" true rather than approximately
 * true. The old subscription was `{ project: "*" }` and never had to answer
 * this; a per-recipe one does, and **three of the four types Lingtai's own
 * recipe names cannot answer it from their own bytes**:
 *
 *   `WorkItemBlocked`      `wi-lingtai-123`      the stream says it
 *   `IntegrationRefused`   `int-lingtai-main`    `data.workItemId` says it
 *   `ApprovalRequested`    `run-<uuid>`          neither: only `runId`
 *   `RunAwaitingInput`     `run-<uuid>`          neither
 *
 * So the last two are answered by the log: a run stream opens with
 * `RunStarted`, which carries `workItemId`, and `runSubject` reads it. That is
 * a query and not a cache on purpose — a daemon restarted mid-run has no memory
 * of a `RunStarted` it never saw, and the approval that follows is exactly the
 * event nobody can afford to miss.
 *
 * It is paid for rarely by construction: `wants` is asked first, so an event no
 * recipe named costs a set lookup, and of the ones that are named only a run
 * stream reaches the log at all.
 */
import { runnableEnv, extensionEnv, resolveAgentEnv } from "@lingtai/agent-env";
import { createSubscriber, subjectOf, type EventSubject, type Subscriber } from "@lingtai/actions";
import type { ProjectFilter } from "@lingtai/conductor";
import { type Envelope, type PayloadOf, workItemOf } from "@lingtai/domain";
import { type EventStore, eventStore } from "@lingtai/event-store";

/**
 * The board's address on the one machine this runs on
 * ([0008](../../../doc/decisions/0008-nextjs-board.md)): port 3200, localhost,
 * no authentication.
 *
 * A constant rather than a setting, because the deployment it would describe
 * does not exist yet. It is in the payload rather than compiled into the
 * subscriber so that the day it does, one place changes and no extension has to
 * be rewritten.
 */
export const BOARD_URL = "http://localhost:3200";

/**
 * The work item a run is for, off the log.
 *
 * `RunStarted` is the run stream's own first word and carries `workItemId`, so
 * this reads the stream from the beginning and stops at it. The whole stream
 * comes back — the store has no `limit` — which is why this is asked only for
 * an event some recipe actually declared.
 *
 * Null for a run stream with no `RunStarted` in it, which is a run that was
 * refused before it started, and for an unreadable log. Nobody is notified in
 * either case: a notification naming the wrong card is worse than none.
 */
async function runSubject(streamId: string, store: EventStore): Promise<EventSubject | null> {
  let events: Envelope[];
  try {
    events = await store.read(streamId);
  } catch {
    return null;
  }
  for (const event of events) {
    if (event.type !== "RunStarted") continue;
    const named = workItemOf({
      streamId,
      data: event.data as PayloadOf<"RunStarted">,
    });
    return named === null ? null : subjectOf(named.project, named.issue);
  }
  return null;
}

/**
 * Which work item an event is about, or null for one that belongs to no
 * repository — `ctl-conductor`, `chat-…`, `ext-subscribers`.
 *
 * Pure for everything but a run stream, which is the one case that has to ask.
 */
export function createSubjectResolver(
  store: EventStore = eventStore,
): (event: Envelope) => Promise<EventSubject | null> {
  return async (event) => {
    const named = workItemOf(event);
    if (named !== null) return subjectOf(named.project, named.issue);
    if (!event.streamId.startsWith("run-")) return null;
    return runSubject(event.streamId, store);
  };
}

export interface BuildSubscribersOptions {
  /** One per registered project, recipe already resolved. A project whose recipe
   *  will not parse has no `recipe` on it and therefore declares nothing. */
  filters: readonly ProjectFilter[];
  /** Where a subscriber's process runs. The daemon's own directory; there is no worktree for an event. */
  cwd: string;
  subject: (event: Envelope) => Promise<EventSubject | null>;
  board?: string;
  /** Reads `~/.lingtai/env/<project>.env` over the machine's file. Replaced only by a test. */
  resolveEnv?: typeof resolveAgentEnv;
  log?: (line: string) => void;
}

/** One built subscriber and the declaration it came from, for the line the daemon prints. */
export interface BuiltSubscriber {
  subscriber: Subscriber;
  /** As the recipe wrote it, so the operator can see what it will and will not hear. */
  on: readonly string[];
}

/**
 * Everything the registered projects declared, built.
 *
 * **A project that declares nothing produces nothing**, which is 0016 §4's
 * condition applied here: an empty `subscribers:` is a declared empty rather
 * than a silence, and `describeSubscribers` says which of the two you have.
 *
 * Each subscriber's environment is 0037 §1's — the names it declared beside
 * itself, plus `runnableEnv`'s six — and never the daemon's, which is the whole
 * of why a Telegram token put in one place will not reach this one. `allow` is
 * set to the union of what the project's subscribers declared so that the
 * production guard is asked about exactly those names: an agent's credential
 * that looks like production is a refusal for the agent to hit, and it must not
 * be able to silence a notifier that never asked for it.
 *
 * A declared name this machine does not hold is *not* refused here. `lingtai
 * doctor`'s `env: <project> extensions` says so before a run, which is where
 * the answer is still cheap; an operator's typo does not belong between an
 * event and the person waiting to hear about it.
 */
export async function buildSubscribers(options: BuildSubscribersOptions): Promise<BuiltSubscriber[]> {
  const resolve = options.resolveEnv ?? resolveAgentEnv;
  const log = options.log ?? (() => {});
  const built: BuiltSubscriber[] = [];

  for (const filter of options.filters) {
    if (!filter.ok || filter.recipe.subscribers.length === 0) continue;
    const declared = [...new Set(filter.recipe.subscribers.flatMap((s) => s.env))];

    // One read of the two files per project, not one per subscriber: `merged`
    // is the same data for all of them, and `extensionEnv` is what narrows it
    // to each one's own names. `required: []` because `env.required` is the
    // *agent's* declaration and refuses a whole pass when a name is absent
    // (0020) — one missing agent credential silencing every notification is a
    // different decision from the one that was made.
    const env = await resolve({ project: filter.project, required: [], allow: declared }).catch(
      (err: unknown) => {
        // Said, and then this project's subscribers are not built. Silence is
        // the one thing a notifier must not fail into, so it is a line rather
        // than a swallow — and it is not fatal, because the daemon's job is to
        // conduct and a subscriber has never been allowed to stop it.
        log(`subscribers: ${filter.project} declares ${declared.length} name(s) and none could be read — ${(err as Error).message}`);
        return null;
      },
    );
    if (env === null) continue;

    for (const spec of filter.recipe.subscribers) {
      built.push({
        on: spec.on,
        subscriber: createSubscriber({
          project: filter.project,
          spec,
          subject: options.subject,
          cwd: options.cwd,
          env: runnableEnv(extensionEnv(env.merged, spec.env).values),
          board: options.board ?? BOARD_URL,
        }),
      });
    }
  }

  return built;
}

/**
 * What the daemon prints about them on its way past.
 *
 * The name, the project and the types, and nothing else. It cannot say
 * "notifications via terminal-notifier" any more, and that is the change rather
 * than a loss: the daemon no longer chooses a channel and has no way to know
 * what a `run:` line does. Whether a notification is clickable is a fact about
 * that command, and it belongs beside the command in the recipe that declares
 * it.
 *
 * **A declared none is a sentence and not a blank line**, for the reason
 * `GatesResolved` records an empty point (0016 §4): a machine with no
 * `subscribers:` anywhere and one whose notifier has stopped working look
 * identical from a quiet afternoon, and only the first of them is fine.
 */
export function describeSubscribers(built: readonly BuiltSubscriber[]): string[] {
  if (built.length === 0) {
    return ["no subscriber declared — nothing is told about anything (recipe: subscribers:)"];
  }
  return built.map(
    ({ subscriber, on }) => `subscriber ${subscriber.project}/${subscriber.name} on ${on.join(", ")}`,
  );
}
