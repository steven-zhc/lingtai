#!/usr/bin/env node
/**
 * The desktop notification, as a subscriber.
 *
 * ## Why this is a command and not a channel
 *
 * It was a `NotifyChannel` built by name in the daemon's startup — a decent
 * interface with exactly one implementation and no way to declare a second
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §3). Now it
 * reads one event as JSON on stdin and displays it, and *which* events reach it
 * is four lines in `.lingtai/config.yaml` like anybody else's subscriber.
 *
 * **That is the point of doing this one first.** A first-party extension on a
 * privileged path proves nothing about the boundary — VS Code shipped its own
 * extensions on a special path early and pulled them back onto the extension
 * host later, because first-party code writes infinite loops too. This is
 * started by exactly the code that starts `packages/telegram` (`#125`), gets
 * exactly the payload it gets, renders it with the same `describe` out of
 * `@lingtai/extension`, and its failure is recorded exactly the same way. It needs no credentials, which is what makes it the right first crossing
 * rather than merely the easy one.
 *
 * ## Why this is its own entry point and not a `lingtai` subcommand
 *
 * Because a subscriber's environment holds no `LINGTAI_*` name — 0037 §1 does
 * not want an extension holding `LINGTAI_DATABASE_URL` — and `lingtai.ts`
 * imports `@lingtai/event-store`, whose `db.ts` builds a pool from that
 * variable *at module load*. A `lingtai notify` subcommand would therefore die
 * before it parsed its own argument, and the first thing anybody would reach
 * for is to stop stripping the prefix: the boundary undone to keep the
 * convenience.
 *
 * So the file is the command. `node apps/cli/src/notify.ts` loads this module
 * and `@lingtai/extension`, which depends on nothing; it needs no database and
 * no credentials, and is the same shape as `packages/telegram/src/cli.ts`. That is also the honest
 * version of 0037's open note about one process per event: this one starts in
 * milliseconds because there is nothing in it.
 *
 * ## Why nothing here is retried
 *
 * A retry is right for a fact somebody will read later and wrong for an
 * interruption: a notification delivered an hour late, about a decision already
 * made, is worse than none — it trains you to ignore the next one. So this runs
 * once per event and a failure is an exit code, which the daemon records as
 * `PluginFailed` (0037 §7) and acts on in no other way.
 */
import { spawn } from "node:child_process";
import { describe, isMain, parsePayload, readStdin } from "@lingtai/extension";
import type { Notification } from "@lingtai/extension";

export interface NotifyChannel {
  readonly name: string;
  send(notification: Notification): Promise<void>;
}

/** Spawn a binary, come back with its exit code. `null` when it never started. */
export type Exec = (bin: string, args: string[]) => Promise<number | null>;

const run: Exec = (bin, args) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });

/**
 * The same spawn, with its exit code read rather than discarded.
 *
 * Discarded is what it was, and that was defensible while this lived inside the
 * daemon: nothing above it did anything with a notifier's failure either, so
 * losing the code lost nothing that was going to be used. It is not defensible
 * now. This process's exit code is the whole of what it can say about itself,
 * and the daemon turns a non-zero one into `PluginFailed` — so a `send` that
 * returned happily after `osascript` refused would make that record report the
 * opposite of what happened, for the one subscriber whose failure mode is
 * looking like a quiet week.
 *
 * `null` is the spawn that never happened, which on a machine with no
 * `osascript` is the ordinary way this fails.
 */
async function must(exec: Exec, bin: string, args: string[]): Promise<void> {
  const code = await exec(bin, args);
  if (code === 0) return;
  throw new Error(code === null ? `${bin} could not be run` : `${bin} exited ${code}`);
}

/**
 * macOS, through `terminal-notifier` when it is installed and `osascript`
 * otherwise.
 *
 * Which one you get is decided once, at startup, rather than per notification —
 * though with one event per process that is the same thing, and it is written
 * this way so it stays true when 0037's *one process per event* note is
 * answered.
 *
 * **`osascript` cannot open a URL on click, so it writes the URL out.** That is
 * the whole of the difference between the two, and it is answered here rather
 * than reported to somebody: the old version carried a `clickable` flag that
 * the daemon printed once at startup and nothing else ever read, which told you
 * on Monday about a notification you got on Thursday. A link you can copy off
 * the notification in front of you is the same fact, delivered where it is
 * usable.
 *
 * `exec` is a seam and only that: the default is the real spawn, and the reason
 * it can be replaced is that *the notifier refused* is now the interesting case
 * and there is no way to make a working `osascript` produce it.
 */
export async function macNotifier(exec: Exec = run): Promise<NotifyChannel> {
  const hasTerminalNotifier = (await exec("which", ["terminal-notifier"])) === 0;

  if (hasTerminalNotifier) {
    return {
      name: "terminal-notifier",
      async send(n) {
        await must(exec, "terminal-notifier", [
          "-title",
          n.title,
          "-message",
          n.body.slice(0, 200),
          "-open",
          n.url,
        ]);
      },
    };
  }

  return {
    name: "osascript",
    async send(n) {
      // Quotes are the injection surface here: the body is a question written
      // by an agent or a person, and it goes into an AppleScript string.
      const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
      const body = `${n.body.slice(0, 200)}\n${n.url}`;
      await must(exec, "osascript", [
        "-e",
        `display notification "${esc(body)}" with title "${esc(n.title.slice(0, 200))}"`,
      ]);
    },
  };
}

export interface NotifyCommandDeps {
  read?: () => Promise<string>;
  channelFor?: () => Promise<NotifyChannel>;
  log?: (line: string) => void;
}

/**
 * The command. Exit 0 when the notification went out, 1 when it did not.
 *
 * The exit code is the only thing this can say about itself, and nothing waits
 * for it: the daemon has already moved on, and all a non-zero one buys is the
 * `PluginFailed` that stops a notifier which has quietly stopped notifying from
 * looking like a quiet week (0037 §7).
 */
export async function notifyCommand(deps: NotifyCommandDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.error(line));
  try {
    const payload = parsePayload(await (deps.read ?? readStdin)());
    const channel = await (deps.channelFor ?? macNotifier)();
    await channel.send(describe(payload));
    return 0;
  } catch (err) {
    log(`notification failed: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * Run directly, and only then. Imported — by a test — this does nothing,
 * because a module that notified on import would be a module nobody could read
 * from.
 */
if (isMain(import.meta.url)) {
  process.exitCode = await notifyCommand();
}
