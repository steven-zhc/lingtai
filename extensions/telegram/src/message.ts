/**
 * One event, as a line of Telegram.
 *
 * Plain text and never Markdown: a ticket title, an agent's question and a
 * merge conflict's detail all arrive here unescaped, and `_`, `*` and `[` are
 * ordinary characters in every one of them. A message that fails to send
 * because a branch was called `fix_the_thing` is a worse outcome than one
 * without bold in it.
 *
 * **The link is always the last line**, because that is what the message is
 * for: Telegram is where you find out, and the board is where you do something.
 */
import type { Payload } from "./payload.ts";

function field(payload: Payload, name: string): string {
  const data = (payload.event.data ?? {}) as Record<string, unknown>;
  const value = data[name];
  return value === undefined || value === null ? "" : String(value);
}

function headline(payload: Payload, ref: string): string {
  switch (payload.event.type) {
    case "WorkItemLanded": {
      const sha = field(payload, "mergeCommit").slice(0, 7);
      const base = field(payload, "base");
      return `${ref} landed${sha ? ` — ${sha}` : ""}${base ? ` on ${base}` : ""}`;
    }
    case "WorkItemBlocked":
      return `${ref} is blocked\n${field(payload, "question")}`;
    case "ApprovalRequested":
      return `${ref} is waiting on you\n${field(payload, "question") || "Approve the merge?"}`;
    case "RunAwaitingInput":
      return `${ref} is asking\n${field(payload, "prompt")}`;
    case "RunFailed":
      return `${ref} failed — ${field(payload, "kind")}\n${field(payload, "detail")}`;
    case "IntegrationRefused":
      return `${ref} did not merge — ${field(payload, "reason")}\n${field(payload, "detail")}`;
    default:
      return `${ref} ${payload.event.type}`;
  }
}

/** Telegram's own ceiling is 4096 characters; an agent's question can pass it. */
const LIMIT = 3_500;

export function message(payload: Payload): string {
  const ref = payload.ticket
    ? `${payload.ticket.project} #${payload.ticket.issue}`
    : (payload.project ?? "lingtai");
  const body = headline(payload, ref).trimEnd();
  const clipped = body.length > LIMIT ? `${body.slice(0, LIMIT)}…` : body;
  return payload.board.task ? `${clipped}\n${payload.board.task}` : clipped;
}
