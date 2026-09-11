/**
 * Telling the operator when the operator is the bottleneck.
 *
 * ## Why nothing here is retried
 *
 * A retry is right for a fact somebody will read later and wrong for an
 * interruption: a notification delivered an hour late, about a decision already
 * made, is worse than none — it trains you to ignore the next one. So this is
 * fire-and-forget, and a failure is logged rather than queued. Nothing else in
 * the system retries either since 0022, but for a different reason: GitHub is
 * converged rather than retried, and this cannot be converged because there is
 * no state to compare against.
 *
 * The criterion "notification failure never blocks the event" is met by the
 * shape rather than by a queue: this reads the log and never writes to it, so
 * there is no path by which it can hold anything up.
 *
 * ## The channel is an interface because it will be replaced
 *
 * macOS notifications are what one person on one laptop needs. The thing that
 * should not have to change when that stops being true is *which events are
 * worth interrupting somebody for* — so the subscription model knows nothing
 * about how a message is delivered.
 *
 * ## Click-through is conditional, and says so
 *
 * `terminal-notifier` can open a URL when the notification is clicked;
 * `osascript` cannot. Both are used when available, in that order, and
 * `clickable` reports which one you got — a notification that silently is not
 * clickable would be a small lie repeated every time.
 */
import { spawn } from "node:child_process";
import { type Envelope, type Notification, describeEvent } from "@lingtai/domain";

// `Notification` and the wording that fills it are `@lingtai/domain`'s now
// (#125). They were this file's while the desktop was the only channel; a
// second one that formats the same events the same way makes them the event's
// and not the channel's. Re-exported because the type is in this module's
// surface — `NotifyChannel.send` takes one — and moving a file should not move
// somebody's import.
export type { Notification } from "@lingtai/domain";

export interface NotifyChannel {
  readonly name: string;
  /** True when clicking the notification opens `url`. */
  readonly clickable: boolean;
  send(notification: Notification): Promise<void>;
}

/**
 * Which events are worth interrupting somebody for.
 *
 * Four, and all four mean the same thing: **nothing will move until a person
 * does something.** Anything that the conductor will get to on its own does not
 * belong here — a notification you cannot act on is noise, and noise is how the
 * useful ones stop being read.
 *
 * **This is the desktop channel's list, and only its.** A landed task is absent
 * because a notification interrupts, not because it is uninteresting; a channel
 * read when you choose wants it. That is the recipe's to say now —
 * `subscribers:` gives each one its own `on:` list
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §3) — and
 * this constant remains what the daemon's own notifier subscribes to.
 */
export const DEFAULT_SUBSCRIPTIONS = [
  "ApprovalRequested",
  "IntegrationRefused",
  "RunAwaitingInput",
  "WorkItemBlocked",
] as const;

export interface Subscription {
  /** `*` for every project. */
  project: string;
  types: readonly string[];
}

export interface NotifyOptions {
  channel: NotifyChannel;
  /** Defaults to `DEFAULT_SUBSCRIPTIONS` for every project. */
  subscriptions?: readonly Subscription[];
  /** Where the board is, for the click-through. */
  boardUrl?: string;
  log?: (line: string) => void;
}

/** `wi-project-155` → its project, for matching a subscription. */
function projectOf(streamId: string): string | null {
  if (!streamId.startsWith("wi-")) return null;
  const body = streamId.slice(3);
  const cut = body.lastIndexOf("-");
  return cut < 0 ? null : body.slice(0, cut);
}

export function subscribed(
  event: Envelope,
  subscriptions: readonly Subscription[],
): boolean {
  const project = projectOf(event.streamId);
  return subscriptions.some(
    (s) =>
      s.types.includes(event.type) &&
      (s.project === "*" || (project !== null && s.project === project)),
  );
}

function run(bin: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
}

/**
 * macOS, through `terminal-notifier` when it is installed and `osascript`
 * otherwise.
 *
 * Which one you get is decided once, at construction, rather than per
 * notification — probing on every send would put a process spawn in front of
 * every message for an answer that does not change.
 */
export async function macNotifier(): Promise<NotifyChannel> {
  const hasTerminalNotifier = (await run("which", ["terminal-notifier"])) === 0;

  if (hasTerminalNotifier) {
    return {
      name: "terminal-notifier",
      clickable: true,
      async send(n) {
        await run("terminal-notifier", [
          "-title",
          n.title,
          "-message",
          n.body.slice(0, 200),
          ...(n.url ? ["-open", n.url] : []),
        ]);
      },
    };
  }

  return {
    name: "osascript",
    // It cannot open a URL on click. Said rather than pretended.
    clickable: false,
    async send(n) {
      // Quotes are the injection surface here: the body is a question written
      // by an agent or a person, and it goes into an AppleScript string.
      const esc = (s: string) => s.replace(/["\\]/g, "\\$&").slice(0, 200);
      await run("osascript", [
        "-e",
        `display notification "${esc(n.body)}" with title "${esc(n.title)}"`,
      ]);
    },
  };
}

/** A channel that records instead of interrupting. For tests, and for `--dry-run`. */
export function recordingChannel(): NotifyChannel & { sent: Notification[] } {
  const sent: Notification[] = [];
  return {
    name: "recording",
    clickable: true,
    sent,
    async send(n) {
      sent.push(n);
    },
  };
}

export interface Notifier {
  /** Called for every appended event; sends only what is subscribed. */
  consider(event: Envelope): Promise<void>;
}

export function createNotifier(options: NotifyOptions): Notifier {
  const log = options.log ?? (() => {});
  const subscriptions = options.subscriptions ?? [
    { project: "*", types: [...DEFAULT_SUBSCRIPTIONS] },
  ];
  const boardUrl = options.boardUrl ?? "http://localhost:3200";

  return {
    async consider(event) {
      if (!subscribed(event, subscriptions)) return;
      try {
        await options.channel.send(describeEvent(event, boardUrl));
      } catch (err) {
        // Caught here so the message can say *notification*, and no longer
        // because anything depends on it. The daemon's subscription holds every
        // subscriber at the call site now — `deliver` in `work-loop.ts` — so a
        // notifier that let this through would be recorded and dropped rather
        // than taking the log's follower, and the board with it, down.
        //
        // That is the difference #120 was about. The guarantee was real and
        // correctly stated and honoured by this function; nobody had to be
        // wrong for it to fail, somebody only had to write a second notifier.
        log(`notification failed: ${(err as Error).message}`);
      }
    },
  };
}
