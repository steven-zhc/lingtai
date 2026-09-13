/**
 * Deciding a backlog entry: accept one and the store opens an issue, decline
 * one and that is recorded (`#137`,
 * [0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
 * §5).
 *
 * **Both hosts call these, and nothing else does.** `lingtai backlog` and the
 * board's backlog page are two doors onto the same two functions, because a
 * decision that can only be made in a browser is half a decision (#129, #130).
 *
 * ## Nothing is opened without a person
 *
 * There is no rule here, no threshold and no batch. Each call decides **one**
 * entry, named by its key, and refuses an actor that is not `human:`. Which
 * minors deserve a ticket was deliberately left undecided in code: any rule
 * general enough to write is one whose behaviour nobody can predict, and the
 * judgement is not urgent — which is what a backlog is.
 *
 * ## The decision is the log's; the issue is the store's
 *
 * A finding's decision is its own stream, `bkl-{project}-{key}`, and it is at
 * most two events long: `FindingDeclined`, or `FindingAccepted` then
 * `FindingProposed`. Every append is at the version the stream was read at.
 *
 * **The accept is appended before the store is asked**, at version 0, so a
 * decline or a second accept that races it loses there and opens nothing. After
 * it the entry cannot be declined — a person decided it exists — and what is
 * left is the store's half: opening the issue, which is **safe to repeat and to
 * race**, because `propose` is idempotent on the finding's key. So a failure of
 * any kind — the store did not answer, the answer came after a timeout, the log
 * could not record it, the process died — is answered the same way: open it
 * again. There is no state in which a person has to wait for an accept that
 * may still be running, or find an issue by hand and type its number.
 *
 * Two openers that each wrote an issue converge: the store keeps the older, and
 * if the log has already recorded the other, the one it did not record is
 * withdrawn by the call that wrote it.
 */
import {
  backlogStream,
  type Envelope,
  type PayloadOf,
  parsePayload,
  workItemStream,
} from "@lingtai/domain";
import { ConcurrencyError, type EventStore, eventStore } from "@lingtai/event-store";
import { type BacklogEntry, readBacklog } from "@lingtai/projector";
import type { ProposedRef, ProposedTicket, TicketStore } from "./ticket-store.ts";

export type BacklogDecision =
  | { ok: true; detail: string; externalRef?: string; url?: string | null }
  | { ok: false; detail: string };

type Decision = Pick<PayloadOf<"FindingAccepted">, "kind" | "labels">;

/** What an accepted entry opens. Pure, so what an issue will say is testable. */
export function proposalFor(entry: BacklogEntry, decision: Decision, since: Date): ProposedTicket {
  const firstLine = entry.claim.trim().split("\n")[0] ?? entry.claim;
  const title = firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
  const where = entry.line === null ? entry.file : `${entry.file}:${entry.line}`;
  const body = [
    `A \`${entry.severity}\` finding from a passing \`${entry.gate}:${entry.action}\` on #${entry.issue}. ` +
      `It did not stop that run, and a person accepted it from the backlog.`,
    "",
    `**\`${where}\`** — ${entry.claim.trim()}`,
    "",
    "## Failure scenario",
    "",
    entry.failureScenario.trim(),
    "",
    "## Where it came from",
    "",
    `- ticket: #${entry.issue}`,
    `- run: \`${entry.runId}\`, reviewing \`${entry.onSha.slice(0, 12)}\``,
    `- gate: \`${entry.gate}\`, action \`${entry.action}\``,
    `- finding: \`${entry.key}\` (seq ${entry.raisedSeq})`,
    "",
    "## Done when",
    "",
    "- [ ] the failure scenario above no longer happens, and a test says so",
    "",
  ].join("\n");
  return { key: entry.key, since, title, body, kind: decision.kind, labels: decision.labels };
}

export interface DecideOptions {
  project: string;
  key: string;
  by: string;
  events?: EventStore;
  /** The entry, as the backlog has it. Defaults to reading the projection. */
  entry?: (project: string, key: string) => Promise<BacklogEntry | undefined>;
}

type StreamState =
  | { state: "open" }
  | { state: "accepted"; accepted: Envelope<PayloadOf<"FindingAccepted">> }
  | { state: "decided"; last: Envelope };

/** The log settles it, not the projection: a decision a moment old may not be folded yet. */
function stateOf(stream: readonly Envelope[]): StreamState {
  const last = stream.at(-1);
  if (!last) return { state: "open" };
  if (last.type === "FindingAccepted") {
    return { state: "accepted", accepted: last as Envelope<PayloadOf<"FindingAccepted">> };
  }
  return { state: "decided", last };
}

function decidedDetail(key: string, last: Envelope): string {
  if (last.type === "FindingProposed") {
    const d = last.data as PayloadOf<"FindingProposed">;
    return `${key} was already accepted — it is ${d.url ?? `#${d.externalRef}`} (seq ${last.seq})`;
  }
  return `${key} was already decided — ${last.type} at seq ${last.seq}`;
}

async function readEntry(
  options: DecideOptions,
): Promise<{ entry: BacklogEntry; stream: StreamState; events: EventStore } | string> {
  if (!options.by.startsWith("human:")) {
    return `a backlog entry is decided by a person, and ${options.by} is not one`;
  }
  const read =
    options.entry ??
    (async (project: string, key: string) => (await readBacklog({ project, key }))[0]);
  const entry = await read(options.project, options.key);
  if (!entry) return `no backlog entry ${options.key} in ${options.project}`;
  const events = options.events ?? eventStore;
  const stream = stateOf(await events.read(backlogStream(options.project, options.key)));
  return { entry, stream, events };
}

/**
 * Accept one entry — or, if it is already accepted and its issue is not
 * recorded, open that issue.
 *
 * `kind` is needed only for the first: an accepted entry opens the ticket its
 * `FindingAccepted` describes, and a different kind typed at a retry is
 * refused rather than silently ignored. `kinds` is the recipe's `source.kinds`:
 * an issue carrying any other kind is one no pass will ever claim.
 */
export async function acceptFinding(
  options: DecideOptions & {
    tickets: TicketStore;
    kind?: string;
    kinds: readonly string[];
    labels?: readonly string[];
  },
): Promise<BacklogDecision> {
  const found = await readEntry(options);
  if (typeof found === "string") return { ok: false, detail: found };
  const { entry, stream, events } = found;
  const kind = options.kind?.trim() ?? "";

  if (stream.state === "decided") return { ok: false, detail: decidedDetail(options.key, stream.last) };

  if (stream.state === "accepted") {
    const d = stream.accepted.data;
    if (kind && kind !== d.kind) {
      return {
        ok: false,
        detail:
          `${options.key} was accepted as "${d.kind}" by ${d.by} at seq ${stream.accepted.seq}, ` +
          `and that is the issue opening it again opens — leave out --kind`,
      };
    }
    return open(options, entry, events, d, stream.accepted.at);
  }

  if (!kind) return { ok: false, detail: "an accepted finding needs a kind" };
  if (!options.kinds.includes(kind)) {
    return {
      ok: false,
      detail:
        `"${kind}" is not one of the recipe's source.kinds (${options.kinds.join(", ") || "none"}) — ` +
        `an issue of that kind is one the queue never sees`,
    };
  }

  const decision: Decision = { kind, labels: [...(options.labels ?? [])] };
  const since = new Date();
  try {
    await events.append(backlogStream(options.project, options.key), 0, [
      {
        type: "FindingAccepted",
        actor: options.by,
        data: parsePayload("FindingAccepted", {
          project: options.project,
          key: options.key,
          by: options.by,
          ...decision,
        }),
      },
    ]);
  } catch (err) {
    if (err instanceof ConcurrencyError) {
      return { ok: false, detail: `another decision about ${options.key} landed first — nothing was opened` };
    }
    throw err;
  }
  return open(options, entry, events, decision, since);
}

/** How to answer any failure after the decision: the same command, again. */
function again(options: DecideOptions): string {
  return `opening it again finds the issue if there is one and opens it if not: lingtai backlog accept ${options.project} ${options.key}`;
}

/** The store's half: have the ticket, then record which one it is. */
async function open(
  options: DecideOptions & { tickets: TicketStore },
  entry: BacklogEntry,
  events: EventStore,
  decision: Decision,
  since: Date,
): Promise<BacklogDecision> {
  const streamId = backlogStream(options.project, options.key);
  let ref: ProposedRef;
  try {
    ref = await options.tickets.propose(proposalFor(entry, decision, since));
  } catch (err) {
    return {
      ok: false,
      detail:
        `${options.key} is accepted, but the store did not say it has the issue: ${(err as Error).message}. ` +
        again(options),
    };
  }

  try {
    await events.append(streamId, 1, [
      {
        type: "FindingProposed",
        actor: options.by,
        data: parsePayload("FindingProposed", {
          project: options.project,
          key: options.key,
          by: options.by,
          externalRef: ref.externalRef,
          url: ref.url,
        }),
      },
    ]);
  } catch (err) {
    if (!(err instanceof ConcurrencyError)) {
      return {
        ok: false,
        detail: `${ref.url ?? ref.externalRef} is the issue, but the log did not record it: ${(err as Error).message}. ${again(options)}`,
      };
    }
    return settle(options, events, ref);
  }
  return {
    ok: true,
    detail: `${ref.created ? "opened" : "recorded"} ${ref.url ?? ref.externalRef} for ${options.key} (${workItemStream(entry.project, entry.issue)})`,
    externalRef: ref.externalRef,
    url: ref.url,
  };
}

/**
 * Another opener recorded first. If it recorded a different issue and this call
 * wrote the one it holds, this call withdraws its own — the log names the
 * finding's issue, and nothing it does not name is left open.
 */
async function settle(
  options: DecideOptions & { tickets: TicketStore },
  events: EventStore,
  ref: ProposedRef,
): Promise<BacklogDecision> {
  const last = (await events.read(backlogStream(options.project, options.key))).at(-1);
  if (last?.type !== "FindingProposed") {
    return { ok: false, detail: `${options.key} changed while it was being opened — ${last?.type ?? "nothing"} is on the log` };
  }
  const recorded = last.data as PayloadOf<"FindingProposed">;
  const is = recorded.url ?? `#${recorded.externalRef}`;
  // The same issue, or one this call only found: nothing of this call's to withdraw.
  if (recorded.externalRef === ref.externalRef || !ref.created) {
    return { ok: true, detail: `${options.key} is ${is}`, externalRef: recorded.externalRef, url: recorded.url };
  }
  try {
    await options.tickets.withdraw(
      ref.externalRef,
      recorded.externalRef,
      `the backlog recorded #${recorded.externalRef} as finding ${options.key}'s issue while this one was being opened`,
    );
  } catch (err) {
    return {
      ok: false,
      detail:
        `${options.key} is ${is}, and ${ref.url ?? ref.externalRef} is a duplicate this call opened ` +
        `and could not close: ${(err as Error).message} — close it by hand`,
    };
  }
  return {
    ok: true,
    detail: `${options.key} is ${is}; the duplicate this call opened, ${ref.url ?? ref.externalRef}, is closed`,
    externalRef: recorded.externalRef,
    url: recorded.url,
  };
}

/**
 * Decline one entry. A reason is required: a decline nobody can explain is asked again.
 *
 * Only an open entry: one already accepted is a ticket a person decided exists,
 * and declining it afterwards would leave an issue the backlog says was refused.
 */
export async function declineFinding(
  options: DecideOptions & { reason: string },
): Promise<BacklogDecision> {
  if (!options.reason.trim()) return { ok: false, detail: "a decline needs a reason" };
  const found = await readEntry(options);
  if (typeof found === "string") return { ok: false, detail: found };
  const { stream, events } = found;
  if (stream.state === "accepted") {
    return {
      ok: false,
      detail: `${options.key} was accepted by ${stream.accepted.data.by} at seq ${stream.accepted.seq} — ${again(options)}`,
    };
  }
  if (stream.state === "decided") return { ok: false, detail: decidedDetail(options.key, stream.last) };

  try {
    await events.append(backlogStream(options.project, options.key), 0, [
      {
        type: "FindingDeclined",
        actor: options.by,
        data: parsePayload("FindingDeclined", {
          project: options.project,
          key: options.key,
          by: options.by,
          reason: options.reason.trim(),
        }),
      },
    ]);
  } catch (err) {
    if (err instanceof ConcurrencyError) {
      return { ok: false, detail: `another decision about ${options.key} landed first` };
    }
    throw err;
  }
  return { ok: true, detail: `declined ${options.key} — it will not be asked again` };
}
