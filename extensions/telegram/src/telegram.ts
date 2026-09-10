#!/usr/bin/env node
/**
 * Telegram, as the first extension somebody else could have written.
 *
 * It is small, and that is the point
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md)): four
 * files, no dependency, nothing imported from Lingtai, and everything it knows
 * about the system arrives on stdin. Nothing here had to be added to the core
 * for it to exist — `subscribers:` and `run:` were already there, and the
 * macOS notifier crossed the same boundary first precisely so that this one
 * would not be the thing proving it (`#123` before `#125`).
 *
 *   subscribers:
 *     - name: telegram
 *       on: [WorkItemLanded, WorkItemBlocked, RunFailed]
 *       run: node "$HOME/workspace/lingtai/extensions/telegram/src/telegram.ts"
 *       env: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
 *
 * **Its credentials are its own** (0037 §1). `env:` is the whole of what this
 * process is given besides `PATH` and `HOME`; the daemon's environment is not
 * inherited, so there is no `LINGTAI_DATABASE_URL` here to read. Set them with
 *
 *   lingtai env set <project> TELEGRAM_BOT_TOKEN
 *   lingtai env set <project> TELEGRAM_CHAT_ID
 *
 * and a declared name neither file supplies stops the command being started at
 * all, rather than becoming an HTTP 401 two minutes later.
 */
import { message } from "./message.ts";
import { parsePayload } from "./payload.ts";
import { send } from "./send.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function required(name: string): string {
  const value = process.env[name];
  // Belt as well as braces: the core refuses to start a subscriber whose
  // declared names are unset, so reaching this means the recipe did not declare
  // one — which is the same mistake said from the other side.
  if (!value) throw new Error(`${name} is not set — declare it in the subscriber's env: list`);
  return value;
}

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  await send({
    token: required("TELEGRAM_BOT_TOKEN"),
    chatId: required("TELEGRAM_CHAT_ID"),
    text: message(payload),
    // For a self-hosted Bot API server, and for the test that proves the
    // request shape without asking Telegram anything.
    ...(process.env["TELEGRAM_API_BASE"] ? { apiBase: process.env["TELEGRAM_API_BASE"] } : {}),
  });
}

await main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
