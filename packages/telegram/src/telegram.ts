/**
 * One event → one Telegram message.
 *
 * The whole extension, minus reading stdin. It is deliberately this small:
 * [0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §3 says a
 * subscriber is a command the core does not wait for, so everything that would
 * make it bigger — retries, queues, batching, a connection held open — belongs
 * to nothing here. A message that arrives late is worse than one that never
 * arrives (`notify.ts`, on why nothing is retried), and the core already
 * bounds how long this may take.
 *
 * ## Plain text, no `parse_mode`
 *
 * The body is a question written by an agent or a person. In MarkdownV2 an
 * unescaped `_`, `*`, `[` or `.` is either a 400 from Telegram or — worse —
 * silently swallowed formatting, so a block whose question contains a file path
 * would arrive with half of it missing. Plain text cannot be malformed, and the
 * link is a bare URL that Telegram makes clickable on its own.
 */
import type { Notification } from "@lingtai/domain";

/** Telegram's own, overridable so a test can point at localhost. */
export const DEFAULT_API_BASE = "https://api.telegram.org";

/**
 * How long one `sendMessage` may take.
 *
 * Shorter than anything in the core on purpose. The conductor bounds this
 * process too, but its bound is about a subscriber that has hung; this one is
 * about a network that is merely slow, and exiting non-zero with "timed out" is
 * a better `PluginFailed` than "did not return within 10m".
 */
export const SEND_TIMEOUT_MS = 15_000;

export interface SendOptions {
  token: string;
  chatId: string;
  notification: Notification;
  apiBase?: string;
  /** Injected by the test. Node's own, everywhere else. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * Title, body, link — in that order, and the link last because it is the thing
 * you tap.
 *
 * Exported because it is the whole of what a reader sees, and a test that
 * asserts on the posted body rather than on an internal shape is the one that
 * would catch losing the board link.
 */
export function messageText(notification: Notification): string {
  const lines = [notification.title];
  if (notification.body.trim() !== "") lines.push(notification.body.trim());
  if (notification.url) lines.push(notification.url);
  return lines.join("\n\n");
}

/**
 * Posts, and throws with what Telegram said when it will not take it.
 *
 * Throwing rather than returning a result: the caller's only response is to
 * exit non-zero, and the message it exits with is the `reason` on the
 * `PluginFailed` somebody reads later. A silent failure here is the one failure
 * a notifier must not have (0037 §7).
 */
export async function sendMessage(options: SendOptions): Promise<void> {
  const call = options.fetch ?? globalThis.fetch;
  const base = options.apiBase ?? DEFAULT_API_BASE;
  const url = `${base.replace(/\/$/, "")}/bot${options.token}/sendMessage`;

  const response = await call(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: options.chatId, text: messageText(options.notification) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? SEND_TIMEOUT_MS),
  });

  // Telegram answers 200 with `ok: false` for some refusals and 4xx for
  // others, so both are read. The token never appears in either message: this
  // text ends up in the log as a `PluginFailed` reason, and `bot<token>` is in
  // the URL a careless `${url}` would print.
  const body = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!response.ok) {
    throw new Error(`telegram refused with ${response.status}: ${body?.description ?? "no description"}`);
  }
  if (body?.ok === false) {
    throw new Error(`telegram refused: ${body.description ?? "no description"}`);
  }
}
