/**
 * One message to one chat through the Bot API, and a failure that says which
 * half failed without saying the token.
 *
 * `sendMessage` and nothing else: no polling, no webhook, no chat discovery.
 * A subscriber is told what happened and exits (0037 §3), so the only request
 * it ever makes is the one that tells you.
 */
import type { Notification } from "../../extension/src/index.ts";

/** Telegram's own limit on a message's text, in characters. */
export const MAX_TEXT = 4096;

/**
 * How long the request may take before it is given up.
 *
 * Under `SUBSCRIBER_COMMAND_TIMEOUT`'s two minutes in `@lingtai/actions`, so an
 * unreachable Telegram is reported by this process in its own words — *could
 * not reach* — rather than by the daemon killing it and recording only that it
 * was slow.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

export const DEFAULT_API_ROOT = "https://api.telegram.org";

export interface TelegramTarget {
  token: string;
  chatId: string;
  /** Telegram's, unless a self-hosted Bot API server is in front of it. */
  apiRoot?: string;
}

/**
 * Plain text, three lines: what happened, the question or the detail, the card.
 *
 * No `parse_mode`, on purpose. The body is a question written by an agent or a
 * person, and Markdown or HTML would make every `_` and `<` in it either an
 * escaping bug or a message Telegram refuses — which is a notifier that stops
 * notifying on exactly the questions with code in them. A bare URL is linked by
 * the client anyway.
 */
export function messageText(n: Notification): string {
  const lines = [n.title, n.body, n.url].filter((line) => line.trim() !== "");
  const text = lines.join("\n");
  if (text.length <= MAX_TEXT) return text;
  // The link is the part that must survive: cut the body, never the URL.
  const room = MAX_TEXT - n.title.length - n.url.length - 3;
  let body = n.body.slice(0, Math.max(0, room - 1));
  // `slice` counts UTF-16 code units, so it can keep half of an emoji. A lone
  // surrogate is not UTF-8 and Telegram refuses the whole message over it —
  // on exactly the long question that most needed forwarding.
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
  return [n.title, `${body}…`, n.url].join("\n");
}

/**
 * Sends it, and rejects with a sentence when it did not arrive.
 *
 * Two failures and they are said differently, because they are answered
 * differently: *could not reach* is the network or Telegram, and waits; *refused*
 * is the token or the chat id, and is yours. Neither carries the token — a
 * rejection here becomes `PluginFailed`'s `reason`, on the log, forever.
 */
export async function sendMessage(
  target: TelegramTarget,
  n: Notification,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<void> {
  const root = (target.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, "");
  const redact = (s: string) => s.split(target.token).join("<token>");

  let response: Response;
  try {
    response = await fetchImpl(`${root}/bot${target.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: target.chatId, text: messageText(n) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    const why = cause ? `${(err as Error).message}: ${cause}` : (err as Error).message;
    throw new Error(`could not reach Telegram at ${root} — ${redact(why)}`);
  }

  if (response.ok) return;
  const text = await response.text().catch(() => "");
  let description = text;
  try {
    description = String((JSON.parse(text) as { description?: unknown }).description ?? text);
  } catch {
    // Not JSON — a proxy's error page, say. The status is still the answer.
  }
  throw new Error(`Telegram refused the message: ${response.status} ${redact(description).slice(0, 300)}`);
}
