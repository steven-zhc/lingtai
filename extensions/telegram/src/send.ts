/**
 * The Bot API call, and what to do when it refuses.
 *
 * One `fetch` and no dependency: `sendMessage` is a POST with two fields, and a
 * client library for it would be more code than this file.
 *
 * **A refusal is reported with Telegram's own words.** The API answers `200`
 * with `{"ok": false, "description": "chat not found"}` as readily as it answers
 * `401`, so the status code alone is not the answer — and "chat not found" is
 * the sentence that tells somebody they used the wrong chat id, where "exited 1"
 * tells them nothing. It ends up on the log as `PluginFailed`'s reason.
 */
export interface SendOptions {
  token: string;
  chatId: string;
  text: string;
  /** `https://api.telegram.org` unless a test or a proxy says otherwise. */
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export const TELEGRAM_API = "https://api.telegram.org";

export async function send(options: SendOptions): Promise<void> {
  const base = options.apiBase ?? TELEGRAM_API;
  const call = options.fetch ?? globalThis.fetch;
  const response = await call(`${base}/bot${options.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: options.chatId,
      text: options.text,
      // The board link is the point of the message; a preview card of the board
      // under every one of them is not.
      disable_web_page_preview: true,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; description?: string }
    | null;
  if (response.ok && body?.ok === true) return;
  const said = body?.description ?? `HTTP ${response.status}`;
  // The token is in the URL, so the URL is never in the message.
  throw new Error(`telegram refused: ${said}`);
}
