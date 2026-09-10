/**
 * What a subscriber is handed on stdin, as an extension sees it.
 *
 * **Restated rather than imported.** `@lingtai/actions` has this type, and
 * importing it would make this extension the one thing it must not be: a
 * first-party plugin on a privileged path, proving that a plugin written the
 * way only the core can write one works. Somebody else's extension has JSON and
 * this document; so does this one.
 *
 * It is therefore also the check on the contract. A field that moves without
 * moving here is a failure in this package's own tests rather than a Telegram
 * message that stopped arriving.
 */
export interface Payload {
  /** `1`. No upcaster exists yet — 0037 records that as open. */
  schema: number;
  event: {
    seq: string;
    streamId: string;
    version: number;
    type: string;
    schemaVer: number;
    actor: string;
    causation: string | null;
    at: string;
    data: unknown;
  };
  project: string | null;
  ticket: { project: string; issue: string; stream: string } | null;
  board: { url: string; task: string | null };
}

/**
 * Reads the payload, or says what arrived instead.
 *
 * A subscriber started with nothing on stdin is not a subscriber the core
 * started — it is somebody running it by hand to see what it does — and the
 * message says so rather than reporting a JSON parse error at position 0.
 */
export function parsePayload(text: string): Payload {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error(
      "nothing on stdin. This is a Lingtai subscriber: it is given one JSON event " +
        "on stdin by the daemon. See extensions/README.md.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`stdin was not JSON: ${(err as Error).message}`);
  }
  const payload = raw as Payload;
  if (typeof payload?.event?.type !== "string") throw new Error("no event.type on stdin");
  return payload;
}
