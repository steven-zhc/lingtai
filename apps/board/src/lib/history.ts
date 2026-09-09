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
  /** The payload as stored, pretty-printed. */
  raw: string;
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

/** One event, as a row. */
export function toLine(event: Envelope): HistoryLine {
  return {
    at: event.at.toISOString(),
    type: event.type,
    actor: event.actor,
    summary: summarise(event),
    seq: String(event.seq),
    streamId: event.streamId,
    version: event.version,
    schemaVer: event.schemaVer,
    raw: rawPayload(event.data),
  };
}
