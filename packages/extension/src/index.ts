/**
 * What a subscriber reads, and the one rendering of it every notifier shares.
 *
 * ## Why this is its own package
 *
 * `#125` asks that Telegram import *nothing a third party's extension could not
 * import*, and `describe` — the question, never just the fact, and the board
 * link — was already written, in `apps/cli/src/notify.ts`. Importing it from
 * there would hand Telegram the CLI, and the CLI's entry point demands
 * `LINGTAI_DATABASE_URL` at import, which a subscriber is never given. Copying
 * it would make two renderings that drift the first time a type is added.
 *
 * So it **moved** here, unchanged in what it says, into a package that depends
 * on nothing — no `@lingtai/*` name, no third-party module, only `node:`. That
 * is asserted by `test/imports.test.ts` rather than kept by good manners: the
 * day this imports `@lingtai/domain` for a type, a third party's extension
 * would need the whole monorepo to render one message, and the desktop
 * notifier and Telegram would both be on a path nobody else could take.
 *
 * ## What it is not
 *
 * Not the contract. The contract is the JSON on stdin — `SubscriberPayload` in
 * `@lingtai/actions`, 0037 §4 — and an extension that never imports this is
 * exactly as entitled to it. This is the convenience a first-party extension
 * uses, written so that a third party could use it too.
 */
import { pathToFileURL } from "node:url";

/** What the operator is being told, and where to go about it. */
export interface Notification {
  title: string;
  body: string;
  /** The board page for the task this is about. */
  url: string;
}

/**
 * The event as it arrives over a pipe, and no more of it than is read.
 *
 * Narrower than `Envelope` on purpose: this is JSON from another process, where
 * `seq` is a string and `at` is ISO-8601, so claiming the store's type for it
 * would be claiming a `bigint` and a `Date` that are not in the bytes. See
 * `SubscriberPayload` in `@lingtai/actions` for the whole shape.
 */
export interface NotifiedEvent {
  type: string;
  data: unknown;
}

/** The work item the daemon resolved this event to. `#123` and the board link come off it. */
export interface NotifiedWorkItem {
  id: string;
  project: string;
  issue: string;
}

export interface NotifyPayload {
  event: NotifiedEvent;
  workItem: NotifiedWorkItem;
  board: string;
}

/**
 * Turns an event into something worth reading on a lock screen.
 *
 * The question, never just the fact. `agent:blocked` carried no question, which
 * is the whole reason the old review queue was unworkable from outside the
 * repository — you had to open the issue to find out what was being asked.
 *
 * The card is named from `workItem` rather than from the stream id, and that is
 * `#123`'s other half. `ApprovalRequested`, `RunAwaitingInput` and `RunFailed`
 * are appended to a *run* stream, so a version that read the stream id and
 * nothing else rendered them with an empty `#` and no link, for the events that
 * most needed one.
 *
 * `WorkItemLanded` and `RunFailed` are here for `#125`: a Telegram message is
 * read when you choose, so it can carry the good news a desktop notification
 * deliberately does not interrupt you with. Which of these a channel hears is
 * its `on:` line, never this function.
 */
export function describe(payload: NotifyPayload): Notification {
  const { event, workItem } = payload;
  const d = (event.data ?? {}) as Record<string, unknown>;
  const url = `${payload.board}/task/${encodeURIComponent(workItem.id)}`;
  const ref = `#${workItem.issue}`;

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
    case "RunFailed":
      return {
        title: `${ref} run failed`,
        body: `${String(d["kind"] ?? "")}: ${String(d["detail"] ?? "")}`,
        url,
      };
    case "WorkItemLanded":
      return {
        title: `${ref} landed`,
        body: `merged into ${String(d["base"] ?? "")} at ${String(d["mergeCommit"] ?? "").slice(0, 7)}`,
        url,
      };
    default:
      return { title: ref, body: event.type, url };
  }
}

/**
 * One payload, off stdin, ready to be rendered.
 *
 * Refuses rather than guesses. A subscriber that displayed *something* for
 * malformed input would be a notifier reporting a state nothing is in, and the
 * exit code it returns instead becomes a `PluginFailed` naming this subscriber
 * — a broken contract said out loud, in the log, once per event.
 */
export function parsePayload(text: string): NotifyPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`stdin was not JSON: ${(err as Error).message}`);
  }
  const body = parsed as Partial<NotifyPayload> | null;
  const event = body?.event;
  const workItem = body?.workItem;
  if (!event || typeof event.type !== "string") {
    throw new Error('stdin carried no event — expected {"event":{"type","data"},"workItem":…}');
  }
  if (!workItem || typeof workItem.id !== "string" || typeof workItem.issue !== "string") {
    throw new Error('stdin carried no workItem — expected {"id","project","issue"}');
  }
  return {
    event,
    workItem,
    // The board's address on the one machine this runs on (0008). Defaulted
    // rather than refused: a notification with a link that may be wrong beats
    // no notification, which is the trade the rest of this file does not make
    // and this one line does.
    board: typeof body?.board === "string" ? body.board : "http://localhost:3200",
  };
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Whether the module at `url` is the one node was asked to run.
 *
 * A subscriber's file is both its command and something a test imports, and a
 * module that notified on import would be a module nobody could read from.
 */
export function isMain(url: string, argv1: string | undefined = process.argv[1]): boolean {
  return argv1 !== undefined && url === pathToFileURL(argv1).href;
}
