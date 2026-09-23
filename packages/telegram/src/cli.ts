#!/usr/bin/env node
/**
 * Telegram, as a subscriber — the first extension somebody else could have
 * written (`#125`).
 *
 * Reads one event as JSON on stdin, formats it, posts it, exits. The formatting
 * is `describe` from `@lingtai/extension`, the same function the desktop
 * notifier renders with; it moved there rather than being written again here.
 *
 * ## What makes it an extension and not a feature
 *
 * **It imports nothing a third party's could not.** `node:` and
 * `packages/extension`, which itself depends on nothing — asserted by
 * `packages/extension/unit/imports.test.ts`, not kept by care. No `@lingtai/domain`
 * for a type, no
 * `@lingtai/event-store`, no way to append: the only thing it can say about
 * itself is its exit code, which the daemon turns into `PluginFailed` (0037 §7).
 *
 * **It is started by the path anybody's is.** A `run:` line under
 * `subscribers:` in the recipe, spawned by `createSubscriber` in
 * `@lingtai/actions` with the environment `buildSubscribers` computes — the
 * names declared beside it plus `runnableEnv`'s six. So the token is read from
 * `~/.lingtai/env/<project>.env`, never from the daemon's own environment, and
 * `LINGTAI_DATABASE_URL` is not a name a recipe may declare at all.
 *
 * ## The two names it reads
 *
 * `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, both declared under `env:`.
 * `TELEGRAM_API_ROOT` is read when present, for a self-hosted Bot API server;
 * it reaches the process only if it is declared too.
 *
 * Nothing is retried, for `notify.ts`'s reason: one message per event, and a
 * failure is an exit code the log keeps.
 */
// By path rather than by package name, like `notify.ts`: started from the
// daemon's checkout, which a merge reaches with no `pnpm install`, so a
// workspace symlink this change introduced would not be there to resolve.
import { describe, isMain, parsePayload, readStdin } from "../../extension/src/index.ts";
import { sendMessage } from "./telegram.ts";

export interface TelegramCommandDeps {
  read?: () => Promise<string>;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * The command. Exit 0 when Telegram accepted the message, 1 when it did not.
 *
 * A missing name is an exit 1 rather than a quiet success, because a notifier
 * that exits 0 having sent nothing is the silent one 0037 §7 is about. The
 * sentence names the command that clears it, in the syntax `lingtai env` takes.
 */
export async function telegramCommand(deps: TelegramCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.error(line));
  try {
    const missing = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new Error(
        `${missing.join(" and ")} not set — declare ${missing.length === 1 ? "it" : "them"} under this ` +
          `subscriber's env: and run \`lingtai env set <project> ${missing[0]}\`, which reads the value from stdin`,
      );
    }
    const payload = parsePayload(await (deps.read ?? readStdin)());
    await sendMessage(
      { token: env["TELEGRAM_BOT_TOKEN"]!, chatId: env["TELEGRAM_CHAT_ID"]!, apiRoot: env["TELEGRAM_API_ROOT"] },
      describe(payload),
      deps.fetch,
    );
    return 0;
  } catch (err) {
    log(`telegram: ${(err as Error).message}`);
    return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await telegramCommand();
}
