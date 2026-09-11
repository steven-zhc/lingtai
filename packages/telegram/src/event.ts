/**
 * The JSON on stdin, back into an event.
 *
 * 0037 §4 fixes the shape of the conversation — *context in on stdin* — and
 * this is the other end of it. Two fields do not survive JSON and are restored
 * here: `seq` is a `bigint`, which `JSON.stringify` refuses outright, so the
 * core sends it as a decimal string; `at` is a `Date`, which arrives as ISO
 * text. Anything that parses is accepted, because an extension that refused an
 * event it could have read would be a channel that goes quiet on the day a
 * field is added — the fields this actually reads are `type`, `streamId` and
 * `data`.
 *
 * 0037's open item on a protocol version is exactly about this function: there
 * is no `schema_ver` on the envelope-as-payload yet, so being lenient is the
 * whole of the compatibility story for now.
 */
import type { Envelope } from "@lingtai/domain";

export class NotAnEventError extends Error {
  override readonly name = "NotAnEventError";
}

export function parseEvent(text: string): Envelope {
  if (text.trim() === "") {
    throw new NotAnEventError(
      "nothing on stdin — this is a Lingtai subscriber and is handed one event as JSON",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new NotAnEventError(`stdin is not JSON: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object") throw new NotAnEventError("stdin is not an event object");

  const o = raw as Record<string, unknown>;
  if (typeof o["type"] !== "string" || typeof o["streamId"] !== "string") {
    throw new NotAnEventError("stdin has no `type` and `streamId`, so it is not an event");
  }

  return {
    seq: toBigInt(o["seq"]),
    streamId: o["streamId"],
    version: typeof o["version"] === "number" ? o["version"] : 0,
    type: o["type"],
    schemaVer: typeof o["schemaVer"] === "number" ? o["schemaVer"] : 1,
    data: o["data"] ?? {},
    actor: typeof o["actor"] === "string" ? o["actor"] : "conductor",
    causation: o["causation"] === null || o["causation"] === undefined ? null : toBigInt(o["causation"]),
    at: typeof o["at"] === "string" ? new Date(o["at"]) : new Date(),
  };
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
}
