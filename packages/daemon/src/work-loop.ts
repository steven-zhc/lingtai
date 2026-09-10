/**
 * What makes the conductor run without anyone asking it to.
 *
 * A completion event — landed, released, blocked, refused — means a task just
 * stopped occupying the conductor, so there may be something else to pick up.
 * Postgres already notifies on append, so this is a subscription and not a
 * timer, the same as everything else in the system.
 *
 * ## Three holes, and they are the whole of this file
 *
 * **Cold start.** With nothing in flight there is no completion event, so an
 * event-driven loop never begins. It runs once at startup.
 *
 * **A new issue appends nothing.** The queue comes from GitHub now (0012), so
 * somebody opening an issue produces no event and nothing here hears about it.
 *
 * This is the one place a timer is right, and it is worth being precise about
 * why. Everywhere else a timer would be substituting for a signal that exists —
 * Postgres notifies on append, so polling the log would be choosing to be slow.
 * There is no such signal for "somebody opened an issue on GitHub". A webhook
 * can supply one, and #28 does, but a webhook needs a public address and this
 * runs on a laptop: it is an optimisation, and an optimisation must not be the
 * only path. So the loop also sweeps on a long interval, and the interval is
 * long because the sweep is a fallback and not the mechanism.
 *
 * **The failure loop.** A failed run *releases* its task, a release is a
 * completion event, and a completion event triggers the next pass — where the
 * top of the queue is the ticket that just failed. That is an infinite loop at
 * agent prices, and it is not hypothetical: the old harness re-ran two tickets
 * five times for roughly $29 because nothing remembered the last attempt. The
 * guard is `last_attempt_at` on `task_view`, applied by `selectRunnable`, and it
 * lives in the table rather than in memory precisely so that a daemon crashing
 * on a bad ticket does not come back and spend the money again.
 *
 * ## One pass at a time
 *
 * A pass takes minutes and events arrive during it. Running a second one
 * concurrently would race for the same claim, so an event during a pass sets a
 * flag and the loop goes round again when it finishes — which also collapses a
 * burst of events into one extra pass rather than one each.
 *
 * ## Stopping is waiting for that pass
 *
 * **The boundary is the pass, not the agent**
 * ([0030](../../../doc/decisions/0030-shutting-down-safely.md) §1). A ticket is
 * not finished when its agent exits: the gates run, the merge lane runs, the
 * `end` point runs, and one pass spans all of it. So `stop()` waits for the
 * pass, and `pump` retains its promise for it to wait on — which is the only
 * thing that was missing. `running`, `again` and the `if (stopped) break` were
 * all already here, so from outside the loop looked as though it drained.
 *
 * ## The subscriber boundary
 *
 * Every subscriber invocation goes through `deliver`, and that is a boundary
 * rather than a convenience. The one subscriber there was — the notifier the
 * daemon built by name — used to be called as a bare `void`, so a rejected
 * promise from it was an unhandled rejection **in the process that follows the
 * log** — which is the one process that must survive anything a subscriber
 * does, because it is also the projection follower and the board's only source
 * of current. It did not bite: that notifier caught everything itself. But that
 * is a guarantee held by the callee, and a guarantee held by the callee is one
 * every future subscriber has to re-honour
 * ([0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md) puts
 * third-party code in this path on purpose). `discuss`, two lines below it,
 * already had the `.catch`.
 *
 * That future arrived with `#123`: a subscriber is another process now, started
 * from a `run:` line in somebody's recipe, and the only thing this file knows
 * about one is its name and whether its promise settled. The `.catch` is no
 * longer what stands between a bad notifier and the log's follower — the
 * process boundary is — and this is what holds until it answers.
 *
 * So the boundary holds three failures and not one: a throw before the promise
 * exists, a rejection after it, and a subscriber that never settles at all.
 * Each of them appends `PluginFailed`, because the other half of the defect was
 * that a failed subscriber left a console line and nothing else — and a
 * notifier that has silently stopped notifying is the one failure a notifier
 * must not have. `lingtai doctor` reads them back.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { type Envelope, SUBSCRIBER_STREAM, parseWorkItemStream, parsePayload } from "@lingtai/domain";
import { type EventStore, eventStore, subscribe, type Subscription } from "@lingtai/event-store";
import pg from "pg";

/**
 * The events that mean the conductor is free to look again.
 *
 * A list rather than "anything": a run appends steadily — touched files, guard
 * trips, gate verdicts — and waking on all of them would start a pass while the
 * previous one is mid-agent, dozens of times per run.
 */
export const COMPLETION_EVENTS = [
  "WorkItemLanded",
  "WorkItemReleased",
  "WorkItemBlocked",
  "WorkItemUnblocked",
  "IntegrationSucceeded",
  "IntegrationRefused",
  // Control, for the same reason: resuming has to start work without anybody
  // restarting the daemon, and asking for a specific ticket has to be answered
  // now rather than at the next completion.
  "ConductorResumed",
  "RunRequested",
  // And a shutdown, most of all. An idle daemon appends nothing, so without
  // this a `lingtai shutdown` would sit unread until the next sweep — five
  // minutes of a command that has already returned looking ignored (0030 §2).
  "ConductorShutdownRequested",
  // A webhook said GitHub changed. The sweep would find it eventually; this
  // is what makes "eventually" mean seconds when a webhook can reach us.
  "QueueChanged",
] as const;

export type PassReason = "startup" | "completion" | "sweep";

/**
 * How often to look at GitHub without being told to.
 *
 * Five minutes rather than seconds: this is the fallback for a webhook that
 * did not arrive, not the way work is normally found. Every completion still
 * triggers a pass immediately, so the only thing this bounds is how long a
 * brand-new issue can sit unnoticed on a machine with no webhook.
 */
export const SWEEP_MS = 5 * 60_000;

/**
 * How long a subscriber may take before the boundary calls it failed.
 *
 * Generous on purpose: `discuss` buys an agent, and an agent answering a
 * question takes minutes. The number is not a deadline anything is held to — a
 * subscriber is already off the pass path, so nothing is waiting for it. It is
 * the point at which *never returned* stops being indistinguishable from *still
 * working*, which is the only thing a hang can otherwise be mistaken for.
 */
export const SUBSCRIBER_TIMEOUT_MS = 10 * 60_000;

/**
 * One thing that is told what happened and is never waited for.
 *
 * Structural rather than nominal on purpose: this package builds none of these
 * and knows nothing about how one is delivered. `@lingtai/actions` makes them
 * out of a recipe's `subscribers:` block, the CLI hands them over, and what
 * arrives here is a name and a promise — which is exactly as much as a boundary
 * needs in order to hold something it does not trust.
 */
export interface EventSubscriber {
  /** As the recipe named it. It is what `PluginFailed` records. */
  readonly name: string;
  deliver(event: Envelope): Promise<void>;
}

export interface WorkLoopOptions {
  /**
   * One pass: refresh the queue, take what is runnable, run it.
   *
   * Kept as a callback so this package needs no GitHub client and no runtime —
   * the daemon hosts the loop, and the CLI knows how to build the world it runs
   * against.
   */
  pass: (reason: PassReason) => Promise<void>;
  /**
   * Whether the conductor is currently allowed to take work.
   *
   * A callback rather than a flag, because the answer lives in the log and can
   * change while a run is in flight — the point of a pause is that it lands
   * without a restart.
   */
  paused?: () => Promise<boolean>;
  /**
   * Whether somebody has asked the conductor to stop, and why.
   *
   * Asked in the same place as `paused` and for the same reason (0030 §2): the
   * answer lives in the log, so a request made while a run is in flight lands
   * at the next opportunity without anybody restarting anything.
   *
   * A shutdown is a pause that does not end. The loop stops itself when it
   * reads one — `stopped` is set here rather than waited for from outside, so
   * the `if (stopped) break` at the top of the loop retires the pending `again`
   * on its own.
   */
  shutdown?: () => Promise<string | null>;
  /**
   * Called once, when the loop has read a shutdown request and stopped taking
   * work. The host is what exits; the loop only stops looping.
   */
  onShutdown?: (why: string) => void;
  /**
   * Everything declared under `subscribers:` in a project's recipe, already
   * built. Each is told about every appended event — it decides.
   *
   * A list rather than the single `notify` callback it replaced, and the plural
   * is the whole of `#123`: there was one implementation, chosen by name in the
   * daemon's startup, and no way to declare a second
   * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §3). The
   * daemon now builds whatever the recipes declared and names none of them.
   *
   * **Each carries its own name**, because `PluginFailed` records it and
   * `lingtai doctor` reads it back: with one subscriber "notify" was enough to
   * identify it, and with two a failure that does not say which is a failure
   * nobody can act on.
   *
   * On the loop's existing subscription rather than one each: a subscriber with
   * its own connection would be another session-mode connection held open for
   * the life of the daemon, for events it is being handed anyway.
   *
   * Their failures are held by `deliver`, not by them. See the note on the
   * subscriber boundary at the top of this file.
   */
  subscribers?: readonly EventSubscriber[];
  /**
   * Somebody asked the discussion assistant a question. Answer it.
   *
   * **Off the pass path, deliberately.** A pass is minutes long and can be the
   * whole of an agent, its gates and a merge lane; a discussion is attended,
   * and queueing one behind a run would make the person who asked watch a
   * spinner for as long as the run takes. Nothing about it needs the pass's
   * single-flight either — it takes no claim, provisions nothing and appends
   * only to its own stream (0033 §1).
   *
   * It is on this subscription rather than a second one for the reason
   * `subscribers` are: the daemon already reads every append, and a second
   * session-mode connection for events it is being handed anyway is a
   * connection held open for nothing.
   *
   * Anything that escaped here would reach the subscription's handler and stop
   * the loop over a question — which is why nothing does: `deliver` holds it,
   * and holds it identically to a declared subscriber's.
   */
  discuss?: (event: Envelope) => Promise<void>;
  /**
   * How often to sweep for work nothing announced. `0` disables it, which is
   * what a test wants and what a machine with a reachable webhook can afford.
   */
  sweepMs?: number;
  /** Defaults to `COMPLETION_EVENTS`. */
  triggers?: readonly string[];
  /** Session-mode connection for the subscription. */
  url?: string;
  /**
   * How long a subscriber may take before the boundary calls it failed.
   *
   * Defaults to `SUBSCRIBER_TIMEOUT_MS`. A test sets it low; nothing else has a
   * reason to. It does not cancel anything — see `deliver`.
   */
  subscriberTimeoutMs?: number;
  /**
   * Where `PluginFailed` is appended. Defaults to the process-wide store.
   *
   * An option only so a test can hand in the store it is already cleaning up
   * after. The daemon uses the default.
   */
  store?: EventStore;
  log?: (line: string) => void;
}

export interface WorkLoop {
  /** Runs the first pass and then follows the log. */
  start(): Promise<void>;
  /**
   * Takes no more work, and waits for the pass in flight.
   *
   * **The drain**, and the whole of 0030 §1: a pass spans the agent, the
   * gates, the merge lane and the `end` point, so waiting for the pass is the
   * only wait that means "finished". `running` used to be a flag nothing read;
   * the promise it stands for is retained now, and this is what awaits it.
   */
  stop(): Promise<void>;
  /** Passes run so far. */
  readonly passes: number;
  /** True while a pass is running. What a drain is waiting for. */
  readonly busy: boolean;
}

export function createWorkLoop(options: WorkLoopOptions): WorkLoop {
  const log = options.log ?? (() => {});
  const triggers = new Set<string>(options.triggers ?? COMPLETION_EVENTS);

  let subscription: Subscription | null = null;
  let sweep: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let again = false;
  let stopped = false;
  let passes = 0;
  /**
   * The pass in flight, retained.
   *
   * This one reference is what makes a drain possible. Everything else was
   * already here — `running`, `again`, `if (stopped) break` — and from outside
   * the loop looked as though it drained; nothing held the promise, so nothing
   * could wait for it (0030).
   */
  let inFlight: Promise<void> | null = null;

  // ------------------------------------------------ the subscriber boundary --

  const store = options.store ?? eventStore;
  const subscribers = options.subscribers ?? [];
  const subscriberTimeoutMs = options.subscriberTimeoutMs ?? SUBSCRIBER_TIMEOUT_MS;

  /**
   * `ext-subscribers`'s version, as this process last left it.
   *
   * Held rather than re-read, because the alternative is quadratic exactly when
   * it hurts: a subscriber that fails on every event appends once per event,
   * and reading the whole stream to find its length each time would make a
   * broken notifier progressively more expensive. Null means *ask the log* —
   * which is what a conflict sets it back to.
   */
  let failuresAt: number | null = null;

  /**
   * Appends serially, whatever order the failures arrive in.
   *
   * Two `deliver` calls can fail within the same tick — every subscriber and
   * `discuss` are handed the same event — and each would otherwise read the
   * same version and race the others for it.
   */
  let recording: Promise<void> = Promise.resolve();

  function record(name: string, event: Envelope, reason: string): void {
    // The loop, closed. A `PluginFailed` is an append like any other, so the
    // subscription hands it back to the subscribers, and a subscriber that is
    // failing on everything would fail on this one too — appending another, for
    // ever. The failure is still logged; what it does not do is write itself
    // down again.
    if (event.type === "PluginFailed") return;

    const project = parseWorkItemStream(event.streamId)?.project ?? null;
    const data = { name, eventType: event.type, project, reason };
    recording = recording.then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          failuresAt ??= (await store.read(SUBSCRIBER_STREAM)).length;
          await store.append(SUBSCRIBER_STREAM, failuresAt, [
            { type: "PluginFailed", actor: "conductor", data: parsePayload("PluginFailed", data) },
          ]);
          failuresAt += 1;
          return;
        } catch (err) {
          // Somebody else moved the stream, or the log is unreachable. Ask it
          // again; on the third refusal say so and stop, because a boundary
          // that could throw is the boundary this file exists to remove.
          failuresAt = null;
          if (attempt === 2) log(`could not record ${name}'s failure: ${(err as Error).message}`);
        }
      }
      // Nothing above can reject, and the chain is caught anyway. A rejected
      // `recording` would poison every failure after it — and an unhandled
      // rejection in this process is the whole of what #120 is about.
    }).catch(() => {});
  }

  /**
   * Hands one event to one subscriber, and holds everything it does back.
   *
   * Three failures, not one. A subscriber that throws before returning a
   * promise never gets as far as `.catch`, so the call is inside the `try`; one
   * that rejects afterwards is caught there; and one that never settles is
   * reported by the timer, because *never returned* and *still working* are
   * otherwise the same observation.
   *
   * **The timeout does not cancel anything**, and cannot: there is no way to
   * stop a promise. Nothing is waiting for the subscriber either — it is off
   * the pass path by construction — so what the timer buys is the record.
   * `settled` is why a subscriber that rejects an hour after timing out does
   * not append a second `PluginFailed` for the same event.
   */
  function deliver(name: string, event: Envelope, run: (e: Envelope) => Promise<void>): void {
    let settled = false;
    const failed = (reason: string): void => {
      if (settled) return;
      settled = true;
      log(`${name} failed on ${event.type}: ${reason}`);
      record(name, event, reason);
    };

    const timer = setTimeout(
      () => failed(`did not return within ${Math.round(subscriberTimeoutMs / 1000)}s`),
      subscriberTimeoutMs,
    );
    // Never a reason for the process to stay alive. A daemon whose last
    // obligation is a timer waiting on a hung notifier cannot exit.
    timer.unref?.();

    try {
      void run(event).then(
        () => {
          settled = true;
          clearTimeout(timer);
        },
        (err: unknown) => {
          clearTimeout(timer);
          failed(String(err instanceof Error ? err.message : err));
        },
      );
    } catch (err) {
      clearTimeout(timer);
      failed(String(err instanceof Error ? err.message : err));
    }
  }

  function pump(reason: PassReason): Promise<void> {
    if (running) {
      // A pass is in flight. Remember to go round again rather than starting a
      // second one into the same queue.
      again = true;
      return inFlight ?? Promise.resolve();
    }
    running = true;
    const pass = drain(reason).finally(() => {
      running = false;
      inFlight = null;
    });
    inFlight = pass;
    return pass;
  }

  async function drain(reason: PassReason): Promise<void> {
    try {
      do {
        again = false;
        if (stopped) break;
        // Asked before every pass, not cached: a pause issued mid-run has to
        // take effect at the next opportunity, and the next opportunity is
        // here.
        //
        // A shutdown is asked first, because it is the stronger answer: a
        // conductor that has been told to stop does not need to know whether
        // it was also paused.
        const why = await options.shutdown?.();
        if (why) {
          // Set here, not by the caller. The pending `again` from events that
          // arrived during the pass lapses on the `if (stopped) break` above,
          // which is the whole reason that line was already worth having.
          stopped = true;
          log(`shutting down — ${why}`);
          options.onShutdown?.(why);
          break;
        }
        if (await options.paused?.()) {
          // Nothing is left pending by a pause any more: a run tells GitHub
          // as it goes, so a paused conductor has nothing owed (0022). What
          // used to sit here was a drain for the outbox's queue.
          log("paused — taking no work");
          break;
        }
        passes += 1;
        try {
          await options.pass(reason);
        } catch (err) {
          // A pass that throws must not take the loop with it: the next
          // completion event is exactly when you want it to try again.
          log(`pass failed: ${(err as Error).message}`);
        }
        reason = "completion";
      } while (again);
    } catch (err) {
      // Reaching here means the loop's own bookkeeping threw, not the pass —
      // the pass has its own catch. It must still not escape into a caller
      // that is only draining.
      log(`loop failed: ${(err as Error).message}`);
    }
  }

  return {
    get passes() {
      return passes;
    },

    get busy() {
      return running;
    },

    async start() {
      // From the head, not from zero. Replaying history would fire a pass for
      // every task that has ever landed.
      const from = await headSeq(options.url);

      subscription = subscribe({
        fromSeq: from,
        name: "lingtai-daemon",
        ...(options.url === undefined ? {} : { url: options.url }),
        onEvent: (event) => {
          // Before the trigger check: the events worth interrupting somebody
          // for are mostly *not* the ones that wake the conductor. A task being
          // blocked is both; a run asking a question is only the first.
          //
          // Through `deliver`, every one of them, and never called directly.
          // That is the boundary this file's header is about: what a subscriber
          // does with an event is its own business, and what it does *to the
          // process following the log* is not its business at all.
          for (const s of subscribers) deliver(s.name, event, (e) => s.deliver(e));
          // Before the trigger check too, and never through `pump`. See
          // `discuss` above: a question must not wait for a run.
          if (event.type === "DiscussionRequested" && options.discuss) {
            deliver("discuss", event, options.discuss);
          }
          if (!triggers.has(event.type)) return;
          void pump("completion");
        },
        onError: (error, phase) => log(`subscription ${phase}: ${String(error)}`),
      });

      // The cold start. Nothing is in flight, so nothing will tell us to begin.
      await pump("startup");

      const every = options.sweepMs ?? SWEEP_MS;
      if (every > 0) {
        sweep = setInterval(() => void pump("sweep"), every);
        // Never hold the process open on its own account. A daemon whose only
        // remaining reason to live is its own fallback timer is a daemon that
        // cannot exit.
        sweep.unref?.();
      }
    },

    async stop() {
      stopped = true;
      clearInterval(sweep);
      await subscription?.close().catch(() => {});
      subscription = null;
      // And then the drain. The subscription is closed first so nothing new
      // arrives to set `again` while this waits — though it would lapse on
      // `if (stopped) break` if it did.
      //
      // There is no timeout here on purpose (0030 §6). A pass may take as long
      // as `runtime.limits.wall`, and a wait that gave up after some minutes
      // would recreate the orphan this exists to prevent, silently, at the
      // moment it matters most. Whoever wants to accept that asks for it.
      await inFlight?.catch(() => {});
    },
  };
}

/**
 * The log's current end, so the subscription starts there rather than replaying.
 *
 * One query rather than paging the whole log: the answer is a single number and
 * walking a hundred thousand events to find it would make starting the daemon
 * slower the longer it has been useful.
 */
async function headSeq(url?: string): Promise<bigint> {
  const client = new pg.Client({ connectionString: url ?? directDatabaseUrl() });
  await client.connect();
  try {
    const r = await client.query<{ head: string }>("select coalesce(max(seq), 0)::text as head from events");
    return BigInt(r.rows[0]?.head ?? "0");
  } finally {
    await client.end();
  }
}
