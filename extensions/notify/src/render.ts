/**
 * An event, as something worth reading on a lock screen.
 *
 * **The question, never just the fact.** `agent:blocked` carried no question,
 * which is the whole reason the old review queue was unworkable from outside
 * the repository — you had to open the issue to find out what was being asked.
 *
 * Which events are worth interrupting somebody for is no longer decided here.
 * It was `DEFAULT_SUBSCRIPTIONS`, a module constant, the same four types for
 * every project; it is `on:` in each project's own recipe now, and this file
 * renders whatever arrives. The four it knows by name are the four that block
 * on a person, and anything else gets its type — a subscriber declared on a
 * type this has never seen still says something true.
 */
import type { Payload } from "./payload.ts";

export interface Notification {
  title: string;
  body: string;
  /** The board page for the task this is about, when there is one. */
  url: string | null;
}

function field(payload: Payload, name: string): string {
  const data = (payload.event.data ?? {}) as Record<string, unknown>;
  const value = data[name];
  return value === undefined || value === null ? "" : String(value);
}

export function describe(payload: Payload): Notification {
  // `#126`, from the ticket the core resolved. It used to be parsed out of the
  // stream id, which is why a question from a running agent — `run-<uuid>` —
  // arrived with no reference on it at all.
  const ref = payload.ticket ? `#${payload.ticket.issue}` : "";
  const url = payload.board.task;

  switch (payload.event.type) {
    case "ApprovalRequested":
      return {
        title: `${ref} is waiting on you`,
        body: field(payload, "question") || "Approve the merge?",
        url,
      };
    case "WorkItemBlocked":
      return { title: `${ref} is blocked`, body: field(payload, "question"), url };
    case "RunAwaitingInput":
      return { title: `${ref} is asking`, body: field(payload, "prompt"), url };
    case "IntegrationRefused":
      return {
        title: `${ref} did not merge`,
        body: `${field(payload, "reason")}: ${field(payload, "detail")}`,
        url,
      };
    case "WorkItemLanded":
      return {
        title: `${ref} landed`,
        body: field(payload, "mergeCommit").slice(0, 7),
        url,
      };
    default:
      return { title: ref || payload.event.type, body: payload.event.type, url };
  }
}
