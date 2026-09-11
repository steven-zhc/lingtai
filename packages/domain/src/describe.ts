/**
 * What an event says to a person, and where on the board to go about it.
 *
 * Moved here from `packages/daemon/src/notify.ts`, where it was the desktop
 * channel's private wording, because there are two channels now and the wording
 * belongs to neither. A channel decides **whether** to interrupt somebody and
 * how the message travels; what the event *means* is a fact about the event,
 * and this is the package that holds those.
 *
 * That is also what makes an extension able to use it. `@lingtai/telegram`
 * reads one event as JSON on stdin and formats it with this function — the same
 * import a third party writing a subscriber would make, and the only Lingtai
 * package it names. Nothing here reads a file, a socket or an environment
 * variable, so importing it grants nothing: it is a pure function of an event
 * and a URL.
 *
 * ## The question, never just the fact
 *
 * `agent:blocked` carried no question, which is the whole reason the old review
 * queue was unworkable from outside the repository — you had to open the issue
 * to find out what was being asked.
 */
import type { Envelope } from "./envelope.ts";

/** What the reader is being told, and where to go about it. */
export interface Notification {
  title: string;
  body: string;
  /** The board page for the task this is about. */
  url: string | null;
}

export function describeEvent(event: Envelope, boardUrl: string): Notification {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const task = event.streamId.startsWith("wi-") ? event.streamId : null;
  const url = task ? `${boardUrl}/task/${encodeURIComponent(task)}` : null;
  const ref = task ? `#${task.slice(task.lastIndexOf("-") + 1)}` : "";

  switch (event.type) {
    case "ApprovalRequested":
      return { title: `${ref} is waiting on you`, body: String(d["question"] ?? "Approve the merge?"), url };
    case "WorkItemBlocked":
      return { title: `${ref} is blocked`, body: String(d["question"] ?? ""), url };
    case "RunAwaitingInput":
      return { title: `${ref} is asking`, body: String(d["prompt"] ?? ""), url };
    case "IntegrationRefused":
      return {
        title: `${ref} did not merge`,
        body: `${String(d["reason"] ?? "")}: ${String(d["detail"] ?? "")}`,
        url,
      };
    // The two that arrived with the first channel that wants good news (#125).
    // Without a case each they fall to the default, which says the type twice
    // and nothing else — true of a line in a log and useless as the only thing
    // a Telegram message ever says about a landing.
    case "WorkItemLanded":
      return {
        title: `${ref} landed`,
        body: `merged into ${String(d["base"] ?? "the base branch")} as ${String(d["mergeCommit"] ?? "?").slice(0, 12)}`,
        url,
      };
    case "RunFailed":
      return { title: `${ref} failed`, body: `${String(d["kind"] ?? "")}: ${String(d["detail"] ?? "")}`, url };
    default:
      return { title: ref || event.type, body: event.type, url };
  }
}
