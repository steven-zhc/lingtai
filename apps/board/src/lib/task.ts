/**
 * One task, folded from its streams on demand.
 *
 * Nothing here is maintained in a table. A detail view is read rarely, by one
 * person, about one task — folding a few dozen events on the spot is
 * imperceptible, and it means what this shows can change without a migration or
 * a rebuild ([0012](../../../../doc/decisions/0012-one-task-view.md)).
 *
 * **The unit is the attempt.** The log keeps one stream per run and this used to
 * flatten what the log divided: a single `runId` — the most recent — and one
 * `history` with every run's events interleaved into it, so `wi-lingtai-87`'s
 * three claims read as one 80-row list whose only marker of which attempt a row
 * belonged to was a 36-character uuid inside the row's collapsed body (#102).
 * Two things followed from that flattening and are fixed by ending it: gates
 * were a page-level section though a gate runs once *per attempt*, and nothing
 * was ever totalled although `RunFinished` carries `costUsd`, `turns` and
 * `durationMs` on every run.
 *
 * So: `runs`, oldest first, each carrying its own money, its own prompt, its own
 * files and its own verdicts; and a history still whole, still in order, but
 * grouped the way the log already divides it
 * ([the settled design](../../../../doc/design/task-detail-page.md) §1).
 *
 * It reads the item's stream and every run's. They are separate aggregates on
 * purpose (design.md §4), and joining them is a reader's job rather than a
 * reducer's.
 *
 * It also asks GitHub one question — what the ticket says — for the same
 * reason the board's Queued column does (`board.ts`): the issue body and its
 * labels are facts about GitHub and not about the log, so there is nothing to
 * fold for them. That question is allowed to fail, and its failure is a line
 * on the page rather than an absence (#76).
 *
 * The folds below take envelopes and return plain data, so what this page
 * *says* about a run is testable without a database — the same split
 * `history.ts` makes one level down.
 */
import { eventStore } from "@lingtai/event-store";
import {
  applyWorkItem,
  chatStream,
  emptyWorkItem,
  reduceControl,
  CONTROL_STREAM,
  GATE_POINTS,
  parseWorkItemStream,
  type BlockDiagnosis,
  type Envelope,
  type WorkItemLifecycle,
} from "@lingtai/domain";
import { loadProject } from "@lingtai/conductor/projects";
import { githubClientFor } from "@lingtai/conductor/filter";
import { issueUrl } from "./board.ts";
import { type HistoryLine, toLine } from "./history.ts";
import { outgoingFor, type OutgoingView } from "./prompt.ts";

export interface Finding {
  file: string;
  line: number | null;
  claim: string;
  failureScenario: string;
  severity: string;
}

export interface GateVerdict {
  gate: string;
  state: string;
  /**
   * False when the verdict was made against a commit that is no longer the
   * head. A force-push revokes nothing; it makes every verdict about a
   * different diff.
   */
  current: boolean;
  evidence: string | null;
  findings: Finding[];
}

/**
 * One of the five points, and what happened there *on one attempt*.
 *
 * `skipped` is a first-class state and not an absence. ADR 0016 §4 rests on it:
 * a gate nobody configured does not run, and that is the user's decision — but
 * it has to be *shown*, because a point that is merely omitted is
 * indistinguishable from one that was configured and silently did not run. That
 * second case is Lingtai's bug, and this is where it becomes visible.
 */
export interface PointView {
  point: string;
  /** Empty when nothing was configured. */
  planned: string[];
  verdicts: GateVerdict[];
  skipped: boolean;
}

/**
 * What was asked, as against what was done.
 *
 * The page had no reference to a title, a body or a URL: it opened on Gates,
 * and finding out what the ticket wanted meant going back to the board, reading
 * the card, and opening GitHub (#87). A detail page is where somebody decides,
 * and deciding needs the request and not only the response.
 *
 * Two sources, in this order. The **log** carries the title and the kind as
 * they were when Lingtai took responsibility, which is true whether or not
 * GitHub answers now. **GitHub** carries the body, the labels and the URL,
 * which the log has never held and which 0012 is the reason not to start
 * holding.
 */
export interface TicketView {
  project: string;
  /** The issue number, as GitHub numbers it. */
  ref: string;
  title: string | null;
  kind: string | null;
  labels: string[];
  /** From GitHub, or built from the owner the project stream recorded. */
  url: string | null;
  body: string | null;
  /**
   * Why the body and the labels are not here, when they are not.
   *
   * Said rather than left blank. An unreachable App, an unregistered project
   * and a deleted issue all render as a ticket with no body, and only the
   * reason tells them apart — the same argument #76 made about an empty Queued
   * column.
   */
  problem: string | null;
}

/**
 * How an attempt ended, in the log's own words.
 *
 * Five, because the fourth and fifth are the ones a `runId` and a gate list
 * could never say. `claimed` is a run whose stream is empty — the claim landed
 * and nothing followed it — and `released` is a claim given back without the
 * run ever finishing. Both used to render as an attempt that was simply
 * missing, which is the same complaint `skipped` answers one level up.
 */
export type RunState = "claimed" | "running" | "released" | "finished" | "failed";

export interface RunOutcome {
  state: RunState;
  /**
   * What the log said beside the word: a failure's `kind`, a non-zero exit, the
   * release's reason. Null when the word is the whole of it.
   *
   * A pointer and not a copy (design §2) — the whole of a failure is one row
   * down in this attempt's own history, and printing it twice is how two copies
   * of one fact come to disagree.
   */
  detail: string | null;
}

/** A path the agent touched, and what it did to it. */
export interface TouchedFile {
  path: string;
  op: string;
}

/**
 * The document the agent was handed.
 *
 * Raw wherever it is shown — `markdown.ts` §6 — because #88's whole
 * justification is that the log holds the exact bytes that were sent.
 */
export interface PromptView {
  version: string;
  bytes: number;
  /** Null for a v1 `RunPrompted`, which recorded the length and not the document. */
  text: string | null;
}

/** One attempt, whole. */
export interface RunView {
  runId: string;
  /** 1-based, in the order this item's claims were made. */
  attempt: number;
  /** When the claim landed, ISO. */
  at: string;
  /**
   * True when this attempt is the one a `RepairRequested` bought.
   *
   * There is no event saying so — 0025 refuses a repair a vocabulary of its own,
   * and the claim is what consumes the pending repair. This is that fold, the
   * same one `work-item.ts` and `task-view.ts` make, and it is here because a
   * page that showed one money figure would fold a default-on agent's spend into
   * the work's and make it an invisible bill (#84).
   */
  repair: boolean;
  baseSha: string | null;
  headSha: string | null;
  /** From `RunFinished`. Null until it lands, and for a run that never got there. */
  turns: number | null;
  costUsd: number | null;
  durationMs: number | null;
  outcome: RunOutcome;
  /** Every path, once, in the order it was first touched. */
  files: TouchedFile[];
  diff: { branch: string; files: number; insertions: number; deletions: number } | null;
  prompt: PromptView | null;
  /**
   * The sha an open approval is *asking* about, and null when nothing is asked.
   *
   * Not `headSha`, which is what the run *produced*: a branch repaired and
   * approval re-requested moves this and leaves that where it was, and sending
   * the wrong one is an Approve that refuses what `lingtai approve` accepts
   * (#92). The same rule `task_view.awaiting_sha` folds, read off the run's own
   * stream because that is where the approval events land.
   */
  awaitingSha: string | null;
  gates: GateVerdict[];
  /** All five, in loop order, including the ones nothing was configured at. */
  points: PointView[];
}

/**
 * What the attempts cost, added up.
 *
 * On the section's own label rather than in a band of its own: a summary that
 * sits apart from what it summarises is a second copy of the same arithmetic,
 * and the two disagree the first time one of them is changed (design, layout
 * notes).
 *
 * `repairUsd` is apart from `costUsd` for the reason the board keeps it apart
 * (#84): a repair is default-on and spends an agent without being asked again,
 * so folding the two into one figure is exactly the invisible bill.
 *
 * `discussions` and `discussionUsd` arrived with `#105`. They are apart from
 * the attempts' figures for the reason `repairUsd` is apart from `costUsd`:
 * they come out of the same budget, and 0033 §4 gives a discussion a meter
 * rather than a limit — so hiding the number inside another one would make the
 * person who is supposed to be the limit unable to see what they are limiting.
 */
export interface Totals {
  attempts: number;
  turns: number;
  durationMs: number;
  /** What the work cost. */
  costUsd: number;
  /** What diagnosing it cost. */
  repairUsd: number;
  /** How many conversations have been held about this item. */
  discussions: number;
  /** What asking cost. */
  discussionUsd: number;
}

/**
 * The one deciding line, and the attempt that holds the whole of it.
 *
 * A **pointer, and never a copy** (design §2). The failing gate's output, its
 * findings and its diff are inside that attempt, once; printing the whole of it
 * at the top as well is how two copies of one fact come to disagree — the same
 * argument `RunOutcome.detail` already makes one section down.
 */
export interface Deciding {
  /** 1-based, and an anchor: the ledger marks this attempt and opens it. */
  attempt: number;
  /** `proposed / build`, or the attempt's own outcome when no gate refused. */
  source: string;
  /** One line. Clipped, because the whole of it is one click away. */
  line: string;
}

/** `queued` and `running` are the lifecycle's `backlog` and `claimed`, in the board's words. */
export type StandingState = "queued" | "running" | "blocked" | "landed";

/**
 * Why this task is not moving — the answer the page never gave.
 *
 * The most frequent reason anybody opens this page is that a card has stopped,
 * and the state had to be inferred by reading to the bottom of a 30–80 row
 * history. On 2026-09-08 that produced a wrong reading four times (#80, #87,
 * #89, #94) — including one where the item was **not** stuck and would have
 * returned on its own, which is why `queued` and `running` say so here rather
 * than being an absence of the word `blocked`.
 *
 * Two values of equal weight: the state, and **how long it has held**. The
 * second is not an annotation on the first — *blocked* and *blocked for four
 * days* are different facts, and only the second is an emergency.
 *
 * Folded from the item's own stream through `applyWorkItem`, so the word here
 * is the aggregate's and not a second opinion about it. What the log cannot
 * say — the diagnosis, the recommendation — is null until #83 writes one, and
 * the block renders without it.
 */
export interface StandingView {
  state: StandingState;
  /**
   * When the state began, ISO — the event that *moved* the lifecycle, not the
   * last event on the stream. A gate reporting on a blocked item does not
   * restart the clock on how long you have been the bottleneck.
   */
  since: string;
  /**
   * Whether a person is the thing being waited on.
   *
   * The one condition under which this block is allowed to be amber. Amber
   * means *a human is being waited on* and nothing else in the palette does, so
   * a running item's block is drawn in neutrals (layout notes).
   */
  onYou: boolean;
  /** Who is being waited on, in words: `waiting on you`, `an agent is working`, … */
  who: string;
  /** The question, verbatim. Null when nothing was asked. */
  question: string | null;
  /** `judgement` or `acknowledgement`; null on every block written before #83. */
  needs: "judgement" | "acknowledgement" | null;
  /** What happened, what was done, what is recommended. Null until #83 fills it. */
  diagnosis: BlockDiagnosis | null;
  /** Which attempt produced this state, 1-based, and null when none has. */
  attempt: number | null;
  /** How many there have been, so `attempt 2 of 2` can be said. */
  attempts: number;
  runId: string | null;
  /**
   * The sha an open question is about — what Approve must send, and null when
   * there is nothing Approve could do. `Requeue` is the move that is left, the
   * same reading the card makes (#84).
   */
  awaitingSha: string | null;
  /** What that attempt produced, for a waiver, which is a verdict about the diff. */
  headSha: string | null;
  /** The verdicts that refused, by `point:action` — what a waiver would name. */
  failed: string[];
  deciding: Deciding | null;
}

/**
 * The five events that replace the lifecycle in `applyWorkItem`.
 *
 * Listed rather than inferred, because *when the state began* is the second
 * half of this block and nothing else on the item's stream may move it: a
 * `RepairRequested`, a `WorkItemLinked` or a gate reporting late are all
 * appended while the hold stands, and none of them is the hold starting.
 */
const LIFECYCLE_MOVES = new Set([
  "WorkItemClaimed",
  "WorkItemReleased",
  "WorkItemBlocked",
  "WorkItemUnblocked",
  "WorkItemLanded",
]);

/** The first line that says anything, clipped. The rest is in the attempt. */
function oneLine(text: string | null): string | null {
  if (text === null) return null;
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim();
  if (!line) return null;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/**
 * What refused, on the attempt that produced the state.
 *
 * The last failed verdict rather than the first: a point that failed, was
 * repaired and failed again is one attempt with two refusals, and the one being
 * decided is the most recent. Falls back to the attempt's own outcome, so a run
 * that died before any gate reported still points somewhere — that case
 * (`claimed`, `released`, a `RunFailed` with no verdicts) is exactly the one a
 * gate-shaped summary could never name.
 */
function decidingOf(run: RunView | null): Deciding | null {
  if (run === null) return null;

  const refused = [...run.gates].reverse().find((g) => g.state === "failed");
  if (refused) {
    return {
      attempt: run.attempt,
      source: refused.gate.replace(":", " / "),
      line: oneLine(refused.evidence) ?? run.outcome.detail ?? "refused, and said nothing",
    };
  }

  const detail = oneLine(run.outcome.detail);
  if (detail === null) return null;
  return { attempt: run.attempt, source: run.outcome.state, line: detail };
}

function whoWaits(life: WorkItemLifecycle): string {
  switch (life.status) {
    case "blocked":
      if (life.needsFrom === "schema") return "waiting on a schema change";
      if (life.needsFrom === "external") return "waiting on something outside Lingtai";
      return "waiting on you";
    case "claimed":
      return "an agent is working";
    case "landed":
      return `merged into ${life.base}`;
    default:
      // Not stuck. The reading #94 got wrong: an item nobody is holding comes
      // back on its own, and the page has to say so in as many words.
      return "waiting for a conductor to take it";
  }
}

/**
 * The state, since when, and which attempt produced it. See `StandingView`.
 *
 * Pure, and given the runs rather than reading them, for the reason every fold
 * in this file is: what the page *says* about a stopped item is settled by
 * envelopes and nothing else.
 */
export function standingOf(own: readonly Envelope[], runs: readonly RunView[]): StandingView {
  let item = emptyWorkItem;
  let since = own[0]?.at ?? new Date();
  for (const e of own) {
    item = applyWorkItem(item, e);
    if (LIFECYCLE_MOVES.has(e.type)) since = e.at;
  }

  const life = item.lifecycle;
  const named =
    life.status === "blocked" || life.status === "claimed"
      ? runs.find((r) => r.runId === life.runId)
      : undefined;
  // The attempt the state names, or the last one there was. A released item is
  // queued *because of* what its last attempt did, and a landed one merged what
  // its last attempt produced; neither event carries a run id.
  const run = named ?? runs.at(-1) ?? null;
  const blocked = life.status === "blocked";

  return {
    state: life.status === "claimed" ? "running" : life.status === "backlog" ? "queued" : life.status,
    since: since.toISOString(),
    onYou: blocked,
    who: whoWaits(life),
    question: blocked ? life.question : null,
    needs: blocked ? life.needs : null,
    diagnosis: blocked ? life.diagnosis : null,
    attempt: run?.attempt ?? null,
    attempts: runs.length,
    runId: run?.runId ?? null,
    // Only while a person is holding it. A run mid-flight may have an approval
    // open on its stream and no question anybody has been handed yet.
    awaitingSha: blocked ? (run?.awaitingSha ?? null) : null,
    headSha: run?.headSha ?? null,
    failed: run?.gates.filter((g) => g.state === "failed").map((g) => g.gate) ?? [],
    deciding: decidingOf(run),
  };
}

/**
 * One stream's events, in order, under a name.
 *
 * **Grouped by stream, not cut by seq.** A ticket-level event landing in the
 * middle of a run — a block, a repair request — does not split that run in two;
 * the group is the whole of what the stream holds, ordered by seq inside, and
 * the groups themselves are in the order their first event landed. The range is
 * on the group because a seq is what a finding cites when it wants to be
 * believed, and the ranges of two groups may legitimately overlap.
 */
export interface HistoryGroup {
  streamId: string;
  /** The attempt this stream is, or null for the item's own. */
  attempt: number | null;
  /** `attempt 2`, or `the ticket`. */
  label: string;
  /** Inclusive, as the store numbers them. */
  from: string;
  to: string;
  lines: HistoryLine[];
}

export interface TaskDetail {
  taskId: string;
  /**
   * Why it is not moving, above everything else. See `StandingView`.
   *
   * First on the page and first in this shape: the commonest reason anybody
   * opens it is that a card has stopped, and the answer used to be at the
   * bottom of an 80-row history or nowhere.
   */
  standing: StandingView;
  /** Null only when the id is not `wi-<project>-<n>`. */
  ticket: TicketView | null;
  /** Every attempt, oldest first. Empty when nothing has been dispatched. */
  runs: RunView[];
  /** Every conversation held about this item, oldest first. */
  discussions: DiscussionView[];
  /**
   * What the next attempt will be handed, and null when there will not be one.
   *
   * Null for an item that has landed or is running: the prompt for a run in
   * flight was already sent, and a box offering to edit it would be offering
   * something the code cannot do. See `prompt.ts` for what composing it costs
   * and why it is composed by the conductor's own function rather than here.
   */
  outgoing: OutgoingView | null;
  totals: Totals;
  /**
   * Everything, in order, for the question a summary did not anticipate — and
   * still the last thing on the page. Structure may lead a reader to it;
   * nothing may replace it.
   */
  history: HistoryGroup[];
}

// ----------------------------------------------------------- discussions ----

/** One exchange: what was asked, what was readable, and what came back. */
export interface DiscussionTurnView {
  question: string;
  by: string;
  /** ISO, from the envelope. */
  at: string;
  /**
   * Lingtai's own sentence about what could be read — including a branch that
   * was not there.
   *
   * Shown whatever the answer says, because it is recorded on the ask and not
   * on the answer (0033 §5). An assistant that forgot to mention that it was
   * reading `main` cannot make this page forget it too, which is the whole
   * reason the field is on the ask.
   */
  reading: string[];
  answer: {
    text: string;
    /** `main:packages/…` — every file that was served. */
    read: string[];
    /** What it said it could not establish without a command it does not have. */
    cannot: string[];
    proposal: { kind: "prompt" | "ticket"; text: string } | null;
    costUsd: number | null;
    /** Set when it did not finish. The turn still cost what it cost. */
    failure: string | null;
  } | null;
}

/** One conversation, whole. */
export interface DiscussionView {
  chatId: string;
  /** The attempt it was asked about, or null for the item as a whole. */
  attempt: number | null;
  turns: DiscussionTurnView[];
  /**
   * The meter (0033 §4). Null when nothing has reported a figure — which is not
   * the same as free, and is why `RunFinished.costUsd` is nullable too.
   */
  costUsd: number | null;
  /** True while a question has no answer: the daemon has not got to it yet. */
  waiting: boolean;
  /** Which artefact it produced, once it was closed. Null while it is open. */
  held: "prompt" | "ticket" | "none" | null;
}

/**
 * One `chat-<id>` stream, folded.
 *
 * Pure, like every other fold here, so what the panel *says* about a
 * conversation is testable without a database.
 */
export function foldChat(
  chatId: string,
  events: readonly Envelope[],
  held: DiscussionView["held"],
): DiscussionView {
  const turns: DiscussionTurnView[] = [];
  let attempt: number | null = null;
  let cost: number | null = null;

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === "DiscussionAsked") {
      if (typeof d["attempt"] === "number") attempt = d["attempt"];
      turns.push({
        question: String(d["question"] ?? ""),
        by: String(d["by"] ?? ""),
        at: e.at.toISOString(),
        reading: Array.isArray(d["reading"]) ? d["reading"].map(String) : [],
        answer: null,
      });
      continue;
    }
    if (e.type !== "DiscussionAnswered") continue;
    const turn = turns[turns.length - 1];
    if (!turn || turn.answer !== null) continue;
    const costUsd = typeof d["costUsd"] === "number" ? d["costUsd"] : null;
    if (costUsd !== null) cost = (cost ?? 0) + costUsd;
    const proposal = d["proposal"] as { kind?: unknown; text?: unknown } | null | undefined;
    turn.answer = {
      text: String(d["text"] ?? ""),
      read: Array.isArray(d["read"]) ? d["read"].map(String) : [],
      cannot: Array.isArray(d["cannot"]) ? d["cannot"].map(String) : [],
      proposal:
        proposal && (proposal.kind === "prompt" || proposal.kind === "ticket")
          ? { kind: proposal.kind, text: String(proposal.text ?? "") }
          : null,
      costUsd,
      failure: typeof d["failure"] === "string" ? d["failure"] : null,
    };
  }

  return {
    chatId,
    attempt,
    turns,
    costUsd: cost,
    waiting: turns.some((t) => t.answer === null),
    held,
  };
}

/**
 * Which conversations this item has had, and how each ended.
 *
 * The requests are on `ctl-conductor` and the exchanges are on their own
 * streams, so this is a **join done by a reader at read time** — where 0012
 * puts every join of this kind. `DiscussionHeld` on the item's own stream is
 * what says a conversation was closed and what it produced.
 */
export function chatIdsFor(
  control: readonly { chatId: string; workItemId: string }[],
  own: readonly Envelope[],
  taskId: string,
): { chatId: string; held: DiscussionView["held"] }[] {
  const order: string[] = [];
  for (const d of control) {
    if (d.workItemId === taskId && !order.includes(d.chatId)) order.push(d.chatId);
  }
  const held = new Map<string, DiscussionView["held"]>();
  for (const e of own) {
    if (e.type !== "DiscussionHeld") continue;
    const d = (e.data ?? {}) as Record<string, unknown>;
    const chatId = String(d["chatId"] ?? "");
    const outcome = d["outcome"];
    if (!order.includes(chatId)) order.push(chatId);
    held.set(
      chatId,
      outcome === "prompt" || outcome === "ticket" || outcome === "none" ? outcome : "none",
    );
  }
  return order.map((chatId) => ({ chatId, held: held.get(chatId) ?? null }));
}

/** A claim, as the item's own stream recorded it. */
export interface Claim {
  runId: string;
  /** ISO, from the envelope: the log's own time and not a field on the payload. */
  at: string;
  repair: boolean;
  /** The reason the claim was given back, or null while it is still held. */
  released: string | null;
}

const VERDICT: Record<string, string> = {
  GateRequested: "pending",
  GateStarted: "running",
  GatePassed: "passed",
  GateFailed: "failed",
  GateWaived: "waived",
  ApprovalRequested: "pending",
  ApprovalGranted: "passed",
  ApprovalRevoked: "pending",
};

/**
 * Every claim this item made, oldest first.
 *
 * Deduplicated by `runId` the way `work-item.ts` deduplicates `runs`: a second
 * claim naming a run already claimed is the same attempt, not a fourth one.
 *
 * The repair walk mirrors that fold exactly — `RepairRequested` leaves a repair
 * pending and the next claim consumes it — and is written here rather than
 * borrowed because this needs it for *every* run, where the aggregate keeps
 * only the current one.
 */
export function claimsOf(own: readonly Envelope[]): Claim[] {
  const claims: Claim[] = [];
  let pendingRepair = false;

  for (const e of own) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === "RepairRequested") pendingRepair = true;
    if (e.type === "WorkItemClaimed") {
      const runId = String(d["runId"] ?? "");
      if (runId && !claims.some((c) => c.runId === runId)) {
        claims.push({ runId, at: e.at.toISOString(), repair: pendingRepair, released: null });
      }
      pendingRepair = false;
    }
    if (e.type === "WorkItemReleased") {
      const held = claims.find((c) => c.runId === String(d["runId"] ?? ""));
      if (held) held.released = String(d["reason"] ?? "") || "released";
    }
  }

  return claims;
}

/**
 * One attempt, folded from its own stream and the claim that opened it.
 *
 * The gate fold is what used to run once for the page; it runs once per run
 * now, which is the whole of "a gate runs once per attempt". `current` is still
 * applied after the fold, because `headSha` is only final once every event has
 * been seen — a verdict recorded before a force-push is stale, and which ones
 * those are is not knowable while still reading.
 */
export function foldRun(claim: Claim, attempt: number, run: readonly Envelope[]): RunView {
  let baseSha: string | null = null;
  let headSha: string | null = null;
  let turns: number | null = null;
  let costUsd: number | null = null;
  let durationMs: number | null = null;
  let exitCode: number | null = null;
  let failure: string | null = null;
  let started = false;
  let finished = false;
  let prompt: PromptView | null = null;
  let diff: RunView["diff"] = null;
  let awaitingSha: string | null = null;
  /** Keyed by path: an agent touches one file many times and the page wants the file. */
  const files = new Map<string, TouchedFile>();
  const gates = new Map<string, GateVerdict>();

  for (const e of run) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case "RunStarted":
        started = true;
        baseSha = String(d["baseSha"] ?? "") || null;
        break;
      case "RunPrompted":
        prompt = {
          version: String(d["promptVersion"] ?? ""),
          bytes: Number(d["bytes"] ?? 0),
          text: typeof d["prompt"] === "string" ? d["prompt"] : null,
        };
        break;
      case "RunTouchedFile": {
        const path = String(d["path"] ?? "");
        // The last op wins: a file written and then deleted is a deletion, and
        // what the reader wants is what became of the file rather than the
        // order the agent got there in.
        if (path) files.set(path, { path, op: String(d["op"] ?? "") });
        break;
      }
      case "RunProducedDiff":
        headSha = String(d["headSha"] ?? "") || null;
        diff = {
          branch: String(d["branch"] ?? ""),
          files: Number(d["files"] ?? 0),
          insertions: Number(d["insertions"] ?? 0),
          deletions: Number(d["deletions"] ?? 0),
        };
        break;
      case "RunProposedCompletion":
        headSha = String(d["headSha"] ?? "") || null;
        break;
      case "RunFinished":
        finished = true;
        turns = Number(d["turns"] ?? 0);
        durationMs = Number(d["durationMs"] ?? 0);
        // Nullable in the catalogue, and a null is not a zero: a run whose cost
        // was never reported has not been shown to be free.
        costUsd = d["costUsd"] === null || d["costUsd"] === undefined ? null : Number(d["costUsd"]);
        exitCode = Number(d["exitCode"] ?? 0);
        break;
      case "RunFailed":
        failure = String(d["kind"] ?? "") || "failed";
        break;
      // The three that decide whether anything is being asked. Requested opens
      // the question, granted spends it, revoked opens it again on the sha the
      // withdrawal names — the same three lines `task_view` folds, so the page
      // and the card cannot come to disagree about whether Approve can work.
      case "ApprovalRequested":
      case "ApprovalRevoked":
        awaitingSha = String(d["onSha"] ?? "") || null;
        break;
      case "ApprovalGranted":
        awaitingSha = null;
        break;
    }

    const verdict = VERDICT[e.type];
    if (verdict && typeof d["gate"] === "string") {
      // `point:action` — see task-view. Two points may run an action of the
      // same name, and the page has to show both.
      const key = `${String(d["gate"])}:${String(d["action"] ?? "")}`;
      gates.set(key, {
        gate: key,
        state: verdict,
        current: true,
        evidence: (d["evidence"] as string) ?? null,
        findings: (d["findings"] as Finding[]) ?? [],
      });
    }
  }

  for (const g of gates.values()) {
    const onSha = run.find(
      (e) => (e.data as { gate?: string })?.gate === g.gate && (e.data as { onSha?: string })?.onSha,
    );
    const sha = (onSha?.data as { onSha?: string } | undefined)?.onSha ?? null;
    g.current = headSha === null || sha === null || sha === headSha;
  }

  // The plan the conductor wrote down when this run started. Without it the
  // attempt could only show points that reported, which is exactly the omission
  // ADR 0016 §4 forbids.
  const resolved = run.find((e) => e.type === "GatesResolved");
  const plan = (resolved?.data as { points?: { gate: string; actions: string[] }[] } | undefined)?.points;

  const all = [...gates.values()];
  const points: PointView[] = GATE_POINTS.map((point) => {
    const planned = plan?.find((p) => p.gate === point)?.actions ?? [];
    const verdicts = all.filter((g) => g.gate.startsWith(`${point}:`));
    return { point, planned, verdicts, skipped: planned.length === 0 && verdicts.length === 0 };
  });

  return {
    runId: claim.runId,
    attempt,
    at: claim.at,
    repair: claim.repair,
    baseSha,
    headSha,
    turns,
    costUsd,
    durationMs,
    outcome: outcomeOf({ failure, finished, exitCode, started, released: claim.released }),
    files: [...files.values()],
    diff,
    prompt,
    awaitingSha,
    gates: all,
    points,
  };
}

/**
 * How the attempt ended, worst-first and never "running" by omission.
 *
 * The order is the point. A run released without ever finishing is `released`
 * and not `running` — reading a claim that was given back three days ago as a
 * run still in flight is the card's own #100, one page along — and a claim whose
 * stream is empty says so rather than borrowing a state from a run that never
 * appended anything.
 */
function outcomeOf(seen: {
  failure: string | null;
  finished: boolean;
  exitCode: number | null;
  started: boolean;
  released: string | null;
}): RunOutcome {
  if (seen.failure !== null) return { state: "failed", detail: seen.failure };
  if (seen.finished) {
    const bad = seen.exitCode !== null && seen.exitCode !== 0;
    return { state: "finished", detail: bad ? `exit ${seen.exitCode}` : null };
  }
  if (seen.released !== null) return { state: "released", detail: seen.released };
  if (seen.started) return { state: "running", detail: null };
  return { state: "claimed", detail: "nothing on its stream" };
}

/** What the attempts cost, added up. See `Totals`. */
export function totalsOf(
  runs: readonly RunView[],
  discussions: readonly DiscussionView[] = [],
): Totals {
  return {
    attempts: runs.length,
    turns: runs.reduce((n, r) => n + (r.turns ?? 0), 0),
    durationMs: runs.reduce((n, r) => n + (r.durationMs ?? 0), 0),
    costUsd: runs.reduce((n, r) => n + (r.repair ? 0 : (r.costUsd ?? 0)), 0),
    repairUsd: runs.reduce((n, r) => n + (r.repair ? (r.costUsd ?? 0) : 0), 0),
    discussions: discussions.length,
    discussionUsd: discussions.reduce((n, d) => n + (d.costUsd ?? 0), 0),
  };
}

/**
 * Every event, in order, under the stream it came off. See `HistoryGroup`.
 *
 * Nothing is dropped and nothing is reordered inside a group: this is *what
 * actually happened, in order, with who did it*, and the grouping is a way in
 * rather than a filter.
 */
export function groupHistory(
  events: readonly Envelope[],
  attempts: ReadonlyMap<string, number>,
): HistoryGroup[] {
  // Insertion order is first-seq order, which is the order the groups read in.
  const groups = new Map<string, HistoryGroup>();

  for (const e of [...events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))) {
    let group = groups.get(e.streamId);
    if (!group) {
      const attempt = attempts.get(e.streamId) ?? null;
      group = {
        streamId: e.streamId,
        attempt,
        label: attempt === null ? "the ticket" : `attempt ${attempt}`,
        from: String(e.seq),
        to: String(e.seq),
        lines: [],
      };
      groups.set(e.streamId, group);
    }
    group.lines.push(toLine(e));
    group.to = String(e.seq);
  }

  return [...groups.values()];
}

/**
 * The ticket, from the log first and GitHub second.
 *
 * The order matters. A title recorded on `WorkItemClaimed` is what the ticket
 * said when the run started, and it survives a repository the App can no longer
 * reach — so it is read first and only overwritten by an answer. GitHub is
 * asked once, for the three things the log has never carried, and a refusal
 * costs the body and not the page.
 */
async function loadTicket(taskId: string, own: readonly Envelope[]): Promise<TicketView | null> {
  const parsed = parseWorkItemStream(taskId);
  if (!parsed) return null;
  const { project, issue } = parsed;

  let title: string | null = null;
  let kind: string | null = null;
  let labels: string[] = [];
  for (const e of own) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    // `WorkItemDiscovered` is the queue's own event and predates 0012; a claim
    // carries the same two fields precisely so a rebuilt projection has them.
    if (e.type === "WorkItemDiscovered" || e.type === "WorkItemClaimed") {
      title = (d["title"] as string | null) ?? title;
      kind = (d["kind"] as string | null) ?? kind;
      if (Array.isArray(d["labels"])) labels = d["labels"] as string[];
    }
  }

  const state = await loadProject(project).catch(() => null);
  const base = { project, ref: issue, title, kind, labels };
  if (!state) {
    return { ...base, url: null, body: null, problem: `${project} is not a registered project` };
  }

  // Buildable without GitHub, and worth building: a link to the issue is the
  // thing the page exists to save a trip for, and it does not need an answer.
  // The same shape the cards link to, said once (`board.ts`).
  const url = issueUrl(state.owner, project, issue);
  try {
    const client = await githubClientFor(state);
    const live = await client.getIssue(Number(issue));
    return {
      ...base,
      title: live.title,
      // Names only. The colours GitHub sends with them are the board's, for the
      // dot on a card (#85); this page lists every label a ticket carries, and
      // a row of coloured pills here would be the filled pill that ticket
      // refused — a taxonomy wearing the palette's verdict colours.
      labels: live.labels.map((l) => l.name),
      url: live.url,
      body: live.body,
      problem: null,
    };
  } catch (err) {
    return { ...base, url, body: null, problem: (err as Error).message };
  }
}

export async function loadTask(taskId: string): Promise<TaskDetail | null> {
  const own = await eventStore.read(taskId);
  if (own.length === 0) return null;

  // Every claim, and not the last one. A task can be claimed several times —
  // `wi-lingtai-87` three, `wi-lingtai-89` twice — and each claim opens a stream
  // of its own that the page kept no room for (#102).
  const claims = claimsOf(own);

  // Beside the run streams rather than after them: one side is a handful of
  // database reads and the other is two calls to GitHub, and the page waits for
  // the slower of the two instead of for both.
  //
  // The control stream is read whole, which is cheap for the reason
  // `readControl` gives: it is a handful of events, not a history. It is here
  // because a discussion that has not been concluded exists only as a request
  // on it — the work item learns about the conversation when it ends (0033 §6).
  const [streams, ticket, control] = await Promise.all([
    Promise.all(claims.map((c) => eventStore.read(c.runId))),
    loadTicket(taskId, own),
    eventStore.read(CONTROL_STREAM).catch(() => [] as Envelope[]),
  ]);

  const runs = claims.map((c, i) => foldRun(c, i + 1, streams[i] ?? []));
  const attempts = new Map(runs.map((r) => [r.runId, r.attempt]));

  const chats = chatIdsFor(reduceControl(control).discussions, own, taskId);
  const chatStreams = await Promise.all(chats.map((c) => eventStore.read(chatStream(c.chatId))));
  const discussions = chats.map((c, i) => foldChat(c.chatId, chatStreams[i] ?? [], c.held));

  const standing = standingOf(own, runs);
  // Only where a next attempt is possible. A run in flight has already been
  // handed its prompt and a landed item will never be handed another, so the
  // file read and the recipe fetch are spent on the two states that can still
  // take one — the person pressing Send, and the loop after a backoff (0032 §5).
  const outgoing =
    standing.state === "blocked" || standing.state === "queued"
      ? await outgoingFor({ own, streams, ticket })
      : null;

  return {
    taskId,
    standing,
    ticket,
    runs,
    discussions,
    outgoing,
    totals: totalsOf(runs, discussions),
    // The chat streams are **not** in the history, and that is 0033 §6 read the
    // other way round: the point of giving a conversation its own stream is
    // that forty turns of exploration do not drown the thirty-six events this
    // section exists to show. The work item's own `DiscussionHeld` is here, and
    // it is the two lines the ticket's history was promised to grow by.
    history: groupHistory([...own, ...streams.flat()], attempts),
  };
}
