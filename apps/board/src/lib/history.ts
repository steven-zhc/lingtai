/**
 * A line of history, and the payload behind it.
 *
 * The history is where an event-sourced system is legible or is not, and it
 * was legible for six types out of forty. Everything else fell to a default
 * that printed `data.gate` when there was one and the empty string when there
 * was not, so `GatesResolved` — the plan ADR 0016 §4 rests on — rendered as a
 * timestamp, a type name and nothing at all (#87).
 *
 * Two rules, and the second is the one that matters:
 *
 *   1. A named formatter says the sentence: what happened, in the words
 *      somebody reading the log would use. Terse, because the payload is now
 *      genuinely one click below rather than merely promised to be.
 *   2. **The fallback is the payload, never the empty string.** A formatter
 *      that must learn forty types will always be behind the catalogue, so a
 *      type nobody has written a line for is exactly the one worth seeing raw.
 *      `describePayload` is what a new event type gets for free.
 *
 * `Partial<Record<EventType, …>>` and not a total record, deliberately. A total
 * one would make adding an event to `events.ts` break the board's typecheck,
 * which is the same "the renderer is behind the catalogue" failure wearing a
 * hat — and rule 2 is what makes being behind survivable. The keys are still
 * checked against the catalogue, so a formatter for a misspelled type does not
 * compile.
 *
 * Pure, and its own module for that reason: `task.ts` reaches the database and
 * GitHub, and what a row *says* is testable without either.
 */
import type { Envelope, EventType } from "@lingtai/domain";
import { sourceOfPayloadDocument, type DocumentSource } from "./markdown.ts";

/** One row: the four columns, plus everything the disclosure shows. */
export interface HistoryLine {
  at: string;
  type: string;
  /** The actor, whole. Rendered short with this in the title (#87). */
  actor: string;
  summary: string;
  /** Global order. The thing a finding cites when it wants to be believed. */
  seq: string;
  streamId: string;
  version: number;
  schemaVer: number;
  /**
   * The payload's structure, pretty-printed, with every document lifted out of
   * it and marked where it stood. See `splitPayload`.
   */
  raw: string;
  /** The documents that were lifted, in the order the payload holds them. */
  documents: PayloadDocument[];
}

/**
 * A payload field whose value is itself a document.
 *
 * `RunPrompted.prompt` is the one that forced this, but it is not the only one
 * and naming them is not the fix — see `splitPayload`.
 */
export interface PayloadDocument {
  /** Where it sat in the payload: `prompt`, or `diagnosis.raw` for a nested one. */
  field: string;
  /** The value itself, with its own newlines. */
  text: string;
  /** Its size, in the unit `RunPrompted.bytes` already reports. */
  bytes: number;
  /**
   * Who wrote it, which is the only thing that settles how it may be rendered.
   *
   * Carried on the document rather than worked out where it is displayed, so a
   * document cannot arrive at a renderer having lost its provenance on the way.
   * See `markdown.ts` for the rule and for why `log` is the default.
   */
  source: DocumentSource;
}

type Payload = Record<string, unknown>;
type Formatter = (d: Payload) => string;

/**
 * How much free text a row carries before it is cut.
 *
 * A refusal's `detail` is the raw failure verbatim and a blocking question can
 * be a paragraph; either one turns the history into a wall. Cutting is only
 * defensible because the whole value is in the disclosure — which is the half
 * of "deliberately terse" that #112 and #87 both found missing.
 */
const CLIP = 160;

function clip(v: unknown, n = CLIP): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * A field the sentence is built out of.
 *
 * Throws when it is not there, and `summarise` answers with the payload
 * instead. That is the point: a formatter given a payload it does not
 * recognise — an older schema version, a type whose shape moved on — must not
 * print `undefined · undefined`, and the raw payload is a better answer than
 * any sentence it could still assemble.
 */
function need(d: Payload, key: string): string {
  const v = d[key];
  if (v === null || v === undefined || v === "") throw new Error(`no ${key}`);
  return String(v);
}

/** A sha, at the length everything else in this app shows one. */
function sha(d: Payload, key: string, n = 7): string {
  return need(d, key).slice(0, n);
}

/** `run-78db72ff-d659-…` → `78db72ff`. The same cut `WorkItemClaimed` made. */
function runShort(d: Payload, key: string): string {
  return need(d, key).slice(4, 12);
}

function list(v: unknown): string {
  return Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "");
}

/**
 * A gate row names the **action**, not only the point.
 *
 * Three gates at one point printed `prepared` three times and were
 * indistinguishable, which is the same confusion `gate`/`action` was split
 * into two fields to end.
 */
function gateAt(d: Payload): string {
  return `${need(d, "gate")} · ${need(d, "action")}`;
}

const FORMAT: Partial<Record<EventType, Formatter>> = {
  // ------------------------------------------------------------ work item --
  WorkItemDiscovered: (d) => `#${need(d, "externalRef")} ${need(d, "kind")} — ${clip(need(d, "title"))}`,
  WorkItemClaimed: (d) => `run ${runShort(d, "runId")}`,
  WorkItemReleased: (d) => `run ${runShort(d, "runId")}: ${clip(need(d, "reason"))}`,
  /**
   * Which kind of hold, then the question, then the move that was recommended.
   *
   * The kind leads because it is what the log could not say (#83): *held at the
   * merge gate* and *conflict: agent/112 does not merge into develop* were both
   * `WorkItemBlocked` with a string, and they are opposite kinds of thing. A v1
   * block recorded neither, so it prints the question alone, exactly as before.
   */
  WorkItemBlocked: (d) => {
    const said = [d["needs"] ? `${String(d["needs"])}:` : null, clip(need(d, "question"))];
    const rec = (d["diagnosis"] as { recommendation?: { action?: string } } | null)?.recommendation;
    if (rec?.action) said.push(`— recommends ${rec.action}`);
    return said.filter((s) => s !== null).join(" ");
  },
  WorkItemUnblocked: (d) => `${need(d, "by")}: ${clip(d["note"])}`,
  WorkItemLinked: (d) => `${need(d, "relation")} ${need(d, "otherRef")}`,
  WorkItemLanded: (d) => `merged as ${sha(d, "mergeCommit")}`,
  DispatchRefused: (d) =>
    `${need(d, "runtime")} cannot run ${need(d, "requiredTier")} — missing ${list(d["missing"])}`,

  // ------------------------------------------------------------------ run --
  // Four of the five fields it carries; the worktree path is in the payload.
  RunStarted: (d) =>
    `${need(d, "runtime")} · ${need(d, "model")} · base ${sha(d, "baseSha")} · recipe ${sha(d, "configHash", 12)}`,
  RunPrompted: (d) => `${need(d, "promptVersion")}, ${need(d, "bytes")} bytes`,
  RunTouchedFile: (d) => `${need(d, "op")} ${need(d, "path")}`,
  RunContextExhausted: (d) => `compacted at turn ${need(d, "turn")}`,
  RunAwaitingInput: (d) => clip(need(d, "prompt")),
  RunProducedDiff: (d) =>
    `${need(d, "files")} files +${need(d, "insertions")} −${need(d, "deletions")}`,
  RunProposedCompletion: (d) => `head ${sha(d, "headSha")}`,
  RunFinished: (d) => `${need(d, "turns")} turns, $${Number(d["costUsd"] ?? 0).toFixed(2)}`,
  RunFailed: (d) => `${need(d, "kind")}: ${clip(d["detail"])}`,

  // ----------------------------------------------------------------- gate --
  /**
   * The plan, in full. It is the evidence behind every `skipped` on this page,
   * and it rendered as nothing — so a point that was configured and did not
   * run had no record on the page that says it should have.
   */
  GatesResolved: (d) => {
    const points = d["points"];
    if (!Array.isArray(points) || points.length === 0) throw new Error("no points");
    return (points as { gate: string; actions: string[] }[])
      .map((p) => `${p.gate} ${p.actions?.length > 0 ? p.actions.join("+") : "—"}`)
      .join(" · ");
  },
  EndActionsResolved: (d) => {
    const outcome = need(d, "outcome");
    const actions = d["actions"];
    if (!Array.isArray(actions) || actions.length === 0) return `${outcome}: nothing to do`;
    const said = (actions as { name: string; close?: true; labels?: string[] }[]).map((a) =>
      a.close ? `${a.name} (close)` : `${a.name} → ${list(a.labels)}`,
    );
    return `${outcome}: ${said.join(" · ")}`;
  },
  GateRequested: gateAt,
  GateStarted: gateAt,
  GatePassed: gateAt,
  GateFailed: (d) => {
    const n = Array.isArray(d["findings"]) ? (d["findings"] as unknown[]).length : 0;
    return n > 0 ? `${gateAt(d)} — ${n} finding${n === 1 ? "" : "s"}` : gateAt(d);
  },
  GateNeverRan: (d) => `${gateAt(d)} — never ran: ${clip(d["detail"])}`,
  GateWaived: (d) => `${gateAt(d)} — ${need(d, "by")}: ${clip(d["reason"])}`,
  ApprovalRequested: (d) => `${gateAt(d)} — ${clip(need(d, "question"))}`,
  ApprovalGranted: (d) => `${gateAt(d)} — ${need(d, "by")}${d["note"] ? `: ${clip(d["note"])}` : ""}`,
  ApprovalRevoked: (d) => `${gateAt(d)} — ${need(d, "by")}: ${clip(d["reason"])}`,

  // ---------------------------------------------------------- integration --
  IntegrationAttempted: (d) => `${need(d, "branch")} at ${sha(d, "headSha")}`,
  IntegrationRefused: (d) => `${need(d, "reason")}: ${clip(d["detail"])}`,
  IntegrationSucceeded: (d) =>
    `${need(d, "branch")} → ${need(d, "base")} as ${sha(d, "mergeCommit")}`,

  // --------------------------------------------------------------- repair --
  // Both of a failure's outcomes read on the history, including the one where
  // nothing happened: "no agent was bought, and here is the rule that said
  // so" is the half an operator otherwise has to guess at.
  RepairRequested: (d) => `attempt ${need(d, "attempt")} on ${need(d, "reason")}`,
  RepairDeclined: (d) => `${need(d, "reason")} — ${clip(d["why"])}`,

  // -------------------------------------------------------------- control --
  ConductorPaused: (d) => `${need(d, "by")}: ${clip(d["reason"])}`,
  ConductorResumed: (d) => need(d, "by"),
  // The timeout is on the row because it is the whole difference between a
  // drain that waits for the pass and one that walks away from it (0030 §6).
  ConductorShutdownRequested: (d) =>
    `${need(d, "by")}: ${clip(d["reason"])}` +
    (typeof d["timeoutMs"] === "number" ? ` (timeout ${Math.round(d["timeoutMs"] / 1000)}s)` : ""),
  // Retired, and still read for ever (0019). A row that renders nothing is
  // exactly as unreadable whether or not anything appends the type again.
  OutboxDelivered: (d) =>
    `${need(d, "kind")} → ${need(d, "target")}${d["detail"] ? `: ${clip(d["detail"])}` : ""}`,
  OutboxFailed: (d) =>
    `${need(d, "kind")} → ${need(d, "target")}: ${clip(d["error"])}${d["permanent"] === true ? " (permanent)" : ""}`,
  IssueUpdated: (d) => `${need(d, "change")}: ${clip(d["detail"])}`,
  IssueUpdateFailed: (d) => `${need(d, "change")} refused: ${clip(d["error"])}`,
  QueueChanged: (d) => `${need(d, "project")}: ${need(d, "reason")}`,
  RunRequested: (d) => `${need(d, "project")}#${need(d, "issue")} by ${need(d, "by")}`,

  // ---------------------------------------------------------- discussion --
  DiscussionRequested: (d) => `${need(d, "by")} asked: ${clip(need(d, "question"))}`,
  DiscussionAsked: (d) => `${need(d, "by")}: ${clip(need(d, "question"))}`,
  /**
   * The money and what could not be established, in that order.
   *
   * `cannot` is on the row rather than only in the payload because it is the
   * one thing a person skimming this must not miss: `#89` cost two attempts
   * because a guess was read as a finding, and a summary that printed only the
   * answer would put this assistant one skim away from the same failure.
   */
  DiscussionAnswered: (d) => {
    const cost = typeof d["costUsd"] === "number" ? ` · $${d["costUsd"].toFixed(2)}` : "";
    const failure = typeof d["failure"] === "string" ? d["failure"] : null;
    if (failure !== null) return `did not answer: ${clip(failure)}${cost}`;
    const cannot = Array.isArray(d["cannot"]) ? d["cannot"].length : 0;
    const read = Array.isArray(d["read"]) ? d["read"].length : 0;
    return `${clip(d["text"], 100)} — ${read} file(s)${cannot > 0 ? `, ${cannot} unanswerable` : ""}${cost}`;
  },
  DiscussionHeld: (d) => {
    const cost = typeof d["costUsd"] === "number" ? ` · $${d["costUsd"].toFixed(2)}` : "";
    return `${need(d, "chatId")} → ${need(d, "outcome")}${cost}`;
  },
  // Blank is the removal, and the row says so — an edit taken back off the next
  // attempt is a decision somebody made, not the absence of one (#104).
  PromptEdited: (d) => {
    const text = String(d["text"] ?? "");
    const hash = typeof d["hash"] === "string" ? ` · human@${d["hash"]}` : "";
    const on = typeof d["basedOn"] === "string" ? ` on ${d["basedOn"]}` : "";
    return text.trim() === ""
      ? `${need(d, "by")} removed the edit from the next run${on}`
      : `${need(d, "by")} added ${text.length} bytes for the next run${on}${hash}`;
  },

  // -------------------------------------------------------------- project --
  ProjectConfigured: (d) =>
    `${need(d, "project")} recipe ${sha(d, "configHash", 12)} from ${d["base"] ?? "(no base recorded)"}`,
  Reconciled: (d) => {
    const findings = d["findings"];
    if (!Array.isArray(findings) || findings.length === 0) return "nothing found";
    const said = (findings as { stream: string; action: string }[])
      .slice(0, 3)
      .map((f) => `${f.stream} ${f.action}`)
      .join(", ");
    return findings.length > 3 ? `${findings.length} findings: ${said}, …` : said;
  },
};

/**
 * A payload rendered as itself: every key, including the null ones.
 *
 * The nulls stay because in this catalogue a null is a statement — "a v1 event
 * genuinely did not record this" — and dropping it would turn a fact into an
 * absence, which is the whole complaint one level down.
 */
export function describePayload(data: unknown): string {
  if (data === null || data === undefined) return "(no payload)";
  if (typeof data !== "object") return clip(data);
  const entries = Object.entries(data as Payload);
  if (entries.length === 0) return "(no payload)";
  return clip(entries.map(([k, v]) => `${k}=${scalar(v)}`).join(" "), 240);
}

function scalar(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return `[${v.map(scalar).join(", ")}]`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * What a row says. Never the empty string — see rule 2 above.
 *
 * A formatter that cannot fill its sentence yields to the payload: `need`
 * throws on a field that is not there, and an event of a shape this file does
 * not recognise is the one an operator most needs to see raw. It is also why
 * this is a reader that cannot break the page — a throw here costs a sentence,
 * not a render.
 */
export function summarise(event: Envelope): string {
  const data = event.data ?? {};
  const format = FORMAT[event.type as EventType];
  if (format) {
    try {
      const said = format(data as Payload).trim();
      if (said) return said;
    } catch {
      // Fall through to the payload.
    }
  }
  return describePayload(data);
}

/**
 * The actor, short enough to stay in the actor column.
 *
 * `agent:run-78db72ff-d659-4515-a5d3-150a0e8a3b33` is 45 characters against a
 * 9rem column, so it ran past the summary and read as the row's detail — which
 * is how `RunPrompted` came to look like an event whose content was its own
 * actor. The whole value goes in the row's `title`.
 */
export function shortActor(actor: string): string {
  if (!actor.startsWith("agent:run-")) return actor;
  return `agent:run-${actor.slice("agent:run-".length, "agent:run-".length + 8)}`;
}

/** The payload as stored, for the disclosure under every row. */
export function rawPayload(data: unknown): string {
  try {
    return JSON.stringify(data ?? null, null, 2);
  } catch {
    // Cyclic or otherwise unserialisable — impossible for something read back
    // out of JSONB, and still not a reason for the page to fail.
    return String(data);
  }
}

/** What stands in the JSON where a document was lifted out of it. */
function mark(bytes: number): string {
  return `‹document, ${bytes} bytes — below›`;
}

/**
 * The payload, split into its structure and the documents inside it.
 *
 * Pretty-printing indents the *structure*; it cannot help a value that is
 * itself a document, because the escaping is what makes the value valid JSON
 * and is exactly what makes it unreadable. `seq 1800` is 6,268 bytes of
 * markdown on one line, every newline a literal `\n` — the most valuable event
 * on the stream rendered as the least readable thing on the page (#101).
 *
 * **The rule is a newline in a string, not a list of field names.** A payload
 * that carries a document is not a property of `RunPrompted`: `RunFailed.detail`
 * is a gate's stdout, `RepairRequested.detail` is a whole typecheck run, and
 * `WorkItemBlocked.question` has a build log inside it. An allowlist would fail
 * the same way for the next type that starts carrying one — which is rule 2 at
 * the top of this file, one level down.
 *
 * Nested and inside arrays too, labelled by path (`diagnosis.raw`), because
 * whether a document sits at the top of the payload or one key in is an
 * accident of the schema and not of what it is.
 *
 * **Nothing is dropped.** Every key stays, with a mark in place of the value
 * saying how big it was and that it is below — so the structure is still whole
 * and the document is still there, byte for byte, in the one form you can copy
 * into `claude -p`. What is not reproduced is the JSON escaping, which is how
 * the value travels and not what is stored.
 *
 * The event's `type` is taken so each document can be stamped with its source
 * — the same argument one step on: whether a document may be *rendered* is a
 * fact about who wrote it, and the payload is where that is still known. Omit
 * it and every document is `log`, which is the reading that is never wrong
 * (`markdown.ts`).
 */
export function splitPayload(
  data: unknown,
  type?: string,
): { raw: string; documents: PayloadDocument[] } {
  const documents: PayloadDocument[] = [];

  function lift(value: unknown, path: string): unknown {
    if (typeof value === "string" && value.includes("\n")) {
      const bytes = new TextEncoder().encode(value).length;
      const field = path || "(the payload)";
      // A payload that is itself a document has no key to be named by.
      documents.push({ field, text: value, bytes, source: sourceOfPayloadDocument(type, field) });
      return mark(bytes);
    }
    if (Array.isArray(value)) return value.map((v, i) => lift(v, `${path}[${i}]`));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Payload).map(([k, v]) => [k, lift(v, path ? `${path}.${k}` : k)]),
      );
    }
    return value;
  }

  return { raw: rawPayload(lift(data ?? null, "")), documents };
}

/** One event, as a row. */
export function toLine(event: Envelope): HistoryLine {
  const { raw, documents } = splitPayload(event.data, event.type);
  return {
    at: event.at.toISOString(),
    type: event.type,
    actor: event.actor,
    summary: summarise(event),
    seq: String(event.seq),
    streamId: event.streamId,
    version: event.version,
    schemaVer: event.schemaVer,
    raw,
    documents,
  };
}
