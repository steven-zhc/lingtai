/**
 * How a notification actually reaches a laptop.
 *
 * ## Click-through is conditional, and says so
 *
 * `terminal-notifier` can open a URL when the notification is clicked;
 * `osascript` cannot. Both are used when available, in that order, and
 * `clickable` reports which one you got — a notification that silently is not
 * clickable would be a small lie repeated every time.
 *
 * Which one is decided once, at construction, rather than per notification:
 * probing on every send would put a process spawn in front of every message for
 * an answer that does not change. One process per event is the extension model's
 * own cost (0037, Open), and this does not add a second.
 */
import { spawn } from "node:child_process";
import type { Notification } from "./render.ts";

export interface NotifyChannel {
  readonly name: string;
  /** True when clicking the notification opens `url`. */
  readonly clickable: boolean;
  send(notification: Notification): Promise<void>;
}

function run(bin: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
}

export async function macNotifier(): Promise<NotifyChannel> {
  const hasTerminalNotifier = (await run("which", ["terminal-notifier"])) === 0;

  if (hasTerminalNotifier) {
    return {
      name: "terminal-notifier",
      clickable: true,
      async send(n) {
        const code = await run("terminal-notifier", [
          "-title",
          n.title,
          "-message",
          n.body.slice(0, 200),
          ...(n.url ? ["-open", n.url] : []),
        ]);
        // Reported, where the old in-process notifier logged and returned. The
        // exit code is the whole of what a subscriber may say, so a channel
        // that refused has to reach it.
        if (code !== 0) throw new Error(`terminal-notifier exited ${code ?? "without running"}`);
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
      const code = await run("osascript", [
        "-e",
        `display notification "${esc(n.body)}" with title "${esc(n.title)}"`,
      ]);
      if (code !== 0) throw new Error(`osascript exited ${code ?? "without running"}`);
    },
  };
}

/** A channel that records instead of interrupting. For tests. */
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
