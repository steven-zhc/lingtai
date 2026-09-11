#!/usr/bin/env node
/**
 * The first extension somebody else could have written (#125).
 *
 * One event as JSON on stdin, a Telegram message out, exit. It is declared in
 * the recipe like anything else and reaches the core through no other door:
 *
 *     subscribers:
 *       - name: telegram
 *         on: [WorkItemLanded, WorkItemBlocked, RunFailed, ApprovalRequested, RunAwaitingInput]
 *         run: npx @lingtai/telegram
 *         env: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_BOARD_URL]
 *
 * ## What it is allowed to see
 *
 * Exactly the names above, and `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER`,
 * `LOGNAME`. Not the daemon's environment
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1): the
 * token is resolved from `~/.lingtai/env/<project>.env` into *this* process and
 * no other, and `LINGTAI_DATABASE_URL` — this system's own log — is not merely
 * absent here but undeclarable, since an extension may not name one of
 * Lingtai's own.
 *
 * ## `WorkItemLanded`, which the desktop channel deliberately refuses
 *
 * > A landed task is good news that needed nobody, and is deliberately not
 * > here. — `doc/reference.md`
 *
 * True of a notification that interrupts you, and false of a message you read
 * when you choose. Same event, different channel, different answer — which is
 * only sayable because the subscription is in the recipe rather than in the
 * daemon's source.
 *
 * ## Exit code
 *
 * Nothing reads it. `0037` §5: a subscriber's failure is always ignored,
 * structurally, and the core turns the non-zero exit into a `PluginFailed`
 * carrying whatever this printed — which is why the message on the way out is
 * written for the person who runs `lingtai doctor` a day later.
 */
import { describeEvent } from "@lingtai/domain";
import { parseEvent } from "./event.ts";
import { sendMessage } from "./telegram.ts";

/** Where the board is, when nothing says. The same default the daemon uses. */
const DEFAULT_BOARD_URL = "http://localhost:3200";

export async function main(
  stdin: NodeJS.ReadableStream = process.stdin,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const token = env["TELEGRAM_BOT_TOKEN"];
  const chatId = env["TELEGRAM_CHAT_ID"];
  // Both, before stdin is read: a missing credential is a configuration
  // mistake and not an event's fault, and saying which name is missing is the
  // difference between a fix and an investigation. `lingtai doctor`'s
  // `env: <project> extensions` says the same thing before a run.
  if (!token || !chatId) {
    const missing = [token ? null : "TELEGRAM_BOT_TOKEN", chatId ? null : "TELEGRAM_CHAT_ID"].filter(Boolean);
    console.error(
      `${missing.join(" and ")} not set — declare it in the subscriber's env: and ` +
        "set it with `lingtai env set <project> <NAME> <value>`",
    );
    return 1;
  }

  const event = parseEvent(await read(stdin));
  const notification = describeEvent(event, env["TELEGRAM_BOARD_URL"] ?? DEFAULT_BOARD_URL);

  await sendMessage({
    token,
    chatId,
    notification,
    ...(env["TELEGRAM_API_BASE"] ? { apiBase: env["TELEGRAM_API_BASE"] } : {}),
  });
  return 0;
}

async function read(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) text += chunk;
  return text;
}

// Only when run, never when imported: the test calls `main` with its own stdin
// and its own environment, and a module that posted a message on import would
// make that impossible.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try {
    process.exitCode = await main();
  } catch (err) {
    // One line, which becomes the `reason` on a `PluginFailed`. A stack there
    // would be a stack in `lingtai doctor`'s output.
    console.error((err as Error).message || String(err));
    process.exitCode = 1;
  }
}
