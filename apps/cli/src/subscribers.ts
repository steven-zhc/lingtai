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
 * It is paid for rarely by construction: `deliver` checks `on:` before it asks,
 * so an event no recipe named costs a set lookup, and of the ones that are named
 * only a run stream reaches the log at all.
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
 * refused before it started: a notification naming the wrong card is worse
 * than none.
 *
 * **An unreadable log is not that, and is not answered null.** A null resolves
 * the delivery as a success, so a read that failed would drop the notification
 * with no `PluginFailed` and no line — the silent notifier 0037 §7 exists to
 * prevent. The read's rejection is left to reach `createSubscriber`'s `deliver`,
 * which rejects with it, and `work-loop.ts`'s boundary records it.
 */
async function runSubject(streamId: string, store: EventStore): Promise<EventSubject | null> {
  const events = await store.read(streamId);
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
   *  could not be read has no `recipe` on it, and is returned as `unread` — never
   *  as a project that declared nothing. */
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

/** A project whose declaration is not known — its recipe or its env files could not be read. */
export interface UnreadProject {
  project: string;
  problem: string;
}

export interface SubscriberBuild {
  built: BuiltSubscriber[];
  /**
   * Every project whose recipe read and declares no `subscribers:`, by name.
   *
   * Kept per project rather than inferred from `built` being empty, because it
   * never is on a machine where *one* project declares something: a project
   * that used to be told through `DEFAULT_SUBSCRIPTIONS` and declares none now
   * has to be named at startup, or its silence looks like a quiet week.
   */
  quiet: string[];
  /**
   * Said apart from `built` because *declared none* and *could not be read* are
   * different answers, and only the first is a quiet project. A daemon started
   * at login before the network is up reads every recipe as the second.
   */
  unread: UnreadProject[];
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
export async function buildSubscribers(options: BuildSubscribersOptions): Promise<SubscriberBuild> {
  const resolve = options.resolveEnv ?? resolveAgentEnv;
  const built: BuiltSubscriber[] = [];
  const quiet: string[] = [];
  const unread: UnreadProject[] = [];

  for (const filter of options.filters) {
    if (!filter.ok) {
      unread.push({ project: filter.project, problem: filter.problem });
      continue;
    }
    if (filter.recipe.subscribers.length === 0) {
      quiet.push(filter.project);
      continue;
    }
    const declared = [...new Set(filter.recipe.subscribers.flatMap((s) => s.env))];

    // One read of the two files per project, not one per subscriber: `merged`
    // is the same data for all of them, and `extensionEnv` is what narrows it
    // to each one's own names. `required: []` because `env.required` is the
    // *agent's* declaration and refuses a whole pass when a name is absent
    // (0020) — one missing agent credential silencing every notification is a
    // different decision from the one that was made.
    const env = await resolve({ project: filter.project, required: [], allow: declared }).catch(
      (err: unknown) => {
        // Returned as unread, and then this project's subscribers are not built.
        // Silence is the one thing a notifier must not fail into, so it is said
        // rather than swallowed — and it is not fatal, because the daemon's job
        // is to conduct and a subscriber has never been allowed to stop it.
        unread.push({
          project: filter.project,
          problem: `declares ${declared.length} name(s) and none could be read — ${(err as Error).message}`,
        });
        return null;
      },
    );
    if (env === null) continue;

    for (const spec of filter.recipe.subscribers) {
      const project = filter.project;
      built.push({
        on: spec.on,
        subscriber: createSubscriber({
          project,
          spec,
          subject: options.subject,
          cwd: options.cwd,
          // Read again per delivery, not kept from the read above. The recipe is
          // what a running daemon holds until it restarts; the env file is not:
          // `lingtai env set` is what a missing name's `PluginFailed` tells the
          // operator to run, and a subscriber that went on spawning with the
          // env it was built with would keep telling them to run it after they
          // had. The read above stays, as the startup answer to *unread*.
          env: async () => {
            const now = await resolve({ project, required: [], allow: declared });
            return runnableEnv(extensionEnv(now.merged, spec.env).values);
          },
          board: options.board ?? BOARD_URL,
        }),
      });
    }
  }

  return { built, quiet, unread };
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
 *
 * And it is said **per project**, not only when nothing anywhere declared one:
 * beside a project that declares `desktop`, a project that declares none would
 * otherwise get no line at all.
 */
export function describeSubscribers({ built, quiet, unread }: SubscriberBuild): string[] {
  // Not "declared none" while any project is unread: that sentence would tell
  // the operator a project chose to be quiet when its recipe did not load.
  if (built.length === 0 && quiet.length === 0 && unread.length === 0) {
    return ["no subscriber declared — nothing is told about anything (recipe: subscribers:)"];
  }
  return [
    ...built.map(
      ({ subscriber, on }) => `subscriber ${subscriber.project}/${subscriber.name} on ${on.join(", ")}`,
    ),
    ...quiet.map(
      (project) => `subscribers: ${project} declares none — nothing about it is told to anybody (recipe: subscribers:)`,
    ),
    ...unread.map(
      ({ project, problem }) =>
        `subscribers: ${project} unknown, so nothing it declares is running yet — asked again each pass: ${problem}`,
    ),
  ];
}

export interface SubscriberSetOptions extends BuildSubscribersOptions {
  /** Reads these projects' recipes again. The daemon's is `projectFilters` over the registered projects. */
  reread: (projects: readonly string[]) => Promise<readonly ProjectFilter[]>;
}

/** The daemon's subscribers, as they are now — which a later pass can add to. */
export interface SubscriberSet {
  /** Asked on every event, so a project built after startup is told about what follows. */
  subscribers(): readonly Subscriber[];
  /** The lines the daemon prints at startup. */
  describe(): string[];
  /**
   * Reads every unread project's recipe again, and builds what it declares.
   * Costs nothing once every project has been read. Never rejects.
   */
  retry(): Promise<void>;
}

/**
 * The subscribers, built at startup and completed later.
 *
 * Built once and never again would leave a daemon started before its recipes
 * could be read — `launchd`'s `RunAtLoad`, at login, before the network is up —
 * with no subscriber until somebody restarted it, while every pass after the
 * first conducted normally off the same recipe. So an unread project is asked
 * again, and the daemon calls `retry` before each pass: that is when the
 * recipe is being read anyway, and it is no more often than a pass is.
 *
 * Only an *unread* project is asked. A project that was read keeps what it
 * declared until the daemon restarts, which is what the recipe's own note on
 * `subscribers:` promises. What it declared, not the values: each delivery
 * reads the project's env file again, so `lingtai env set` needs no restart.
 */
export async function createSubscriberSet(options: SubscriberSetOptions): Promise<SubscriberSet> {
  const log = options.log ?? (() => {});
  let current = await buildSubscribers(options);

  return {
    subscribers: () => current.built.map((b) => b.subscriber),
    describe: () => describeSubscribers(current),
    async retry() {
      if (current.unread.length === 0) return;
      try {
        const filters = await options.reread(current.unread.map((u) => u.project));
        const next = await buildSubscribers({ ...options, filters });
        const still = new Set(next.unread.map((u) => u.project));
        for (const { project } of current.unread) {
          if (still.has(project)) continue;
          const mine = next.built.filter((b) => b.subscriber.project === project);
          if (mine.length === 0) log(`subscribers: ${project} read — it declares none`);
          for (const { subscriber, on } of mine) {
            log(`subscriber ${subscriber.project}/${subscriber.name} on ${on.join(", ")}`);
          }
        }
        // Replaced, not mutated: `subscribers()` may be mid-iteration on an event.
        current = {
          built: [...current.built, ...next.built],
          quiet: [...current.quiet, ...next.quiet],
          unread: next.unread,
        };
      } catch (err) {
        log(`subscribers: could not ask the unread recipes again — ${(err as Error).message}`);
      }
    },
  };
}
