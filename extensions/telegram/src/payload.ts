/**
 * What a subscriber is handed on stdin, as an extension sees it.
 *
 * A copy of `extensions/notify/src/payload.ts`, deliberately not shared. Two
 * extensions that import one another's types are one extension with two entry
 * points; the thing being proved here is that an extension written outside this
 * repository has everything it needs, and what it would have is this file —
 * written from `extensions/README.md`, against JSON.
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
