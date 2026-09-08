/**
 * One task, folded from its streams on demand.
 *
 * Nothing here is maintained in a table. A detail view is read rarely, by one
 * person, about one task — folding a few dozen events on the spot is
 * imperceptible, and it means what this shows can change without a migration or
 * a rebuild ([0012](../../../../doc/decisions/0012-one-task-view.md)).
 *
 * It reads two streams: the task's own, and the run's. They are separate
 * aggregates on purpose (design.md §4), and joining them is a reader's job
 * rather than a reducer's.
 *
 * It also asks GitHub one question — what the ticket says — for the same
 * reason the board's Queued column does (`board.ts`): the issue body and its
 * labels are facts about GitHub and not about the log, so there is nothing to
 * fold for them. That question is allowed to fail, and its failure is a line
 * on the page rather than an absence (#76).
 */
import { eventStore } from "@lingtai/event-store";
import { GATE_POINTS, parseWorkItemStream, type Envelope } from "@lingtai/domain";
import { loadProject } from "@lingtai/conductor/projects";
import { githubClientFor } from "@lingtai/conductor/filter";
import { type HistoryLine, toLine } from "./history.ts";

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
 * One of the five points, and what happened there.
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

export interface TaskDetail {
  taskId: string;
  /** Null only when the id is not `wi-<project>-<n>`. */
  ticket: TicketView | null;
  runId: string | null;
  headSha: string | null;
  baseSha: string | null;
  gates: GateVerdict[];
  /** All five, in loop order, including the ones nothing was configured at. */
  points: PointView[];
  /** Everything, in order, for the question a summary did not anticipate. */
  history: HistoryLine[];
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
  const url = state.owner ? `https://github.com/${state.owner}/${project}/issues/${issue}` : null;
  try {
    const client = await githubClientFor(state);
    const live = await client.getIssue(Number(issue));
    return {
      ...base,
      title: live.title,
      labels: live.labels,
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

  // The most recent run. A task can have several attempts; the detail view is
  // about the one that produced what is on screen.
  let runId: string | null = null;
  for (const e of own) {
    if (e.type === "WorkItemClaimed") runId = String((e.data as { runId: string }).runId);
  }

  // Beside the run's stream rather than after it: one is a database read and
  // the other is two calls to GitHub, and the page waits for the slower of the
  // two instead of for both.
  const [run, ticket] = await Promise.all([
    runId ? eventStore.read(runId) : Promise.resolve([]),
    loadTicket(taskId, own),
  ]);

  let headSha: string | null = null;
  let baseSha: string | null = null;
  const gates = new Map<string, GateVerdict>();

  for (const e of run) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === "RunStarted") baseSha = String(d["baseSha"] ?? "") || null;
    if (e.type === "RunProducedDiff" || e.type === "RunProposedCompletion") {
      headSha = String(d["headSha"] ?? "") || null;
    }
    const verdict = VERDICT[e.type];
    if (verdict && typeof d["gate"] === "string") {
      // `point:action` — see task-view. Two points may run an action of the
      // same name, and the card has to show both.
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

  // Applied after the fold, because `headSha` is only final once every event
  // has been seen — a verdict recorded before a force-push is stale, and which
  // ones those are is not knowable while still reading.
  for (const g of gates.values()) {
    const onSha = run.find(
      (e) => (e.data as { gate?: string })?.gate === g.gate && (e.data as { onSha?: string })?.onSha,
    );
    const sha = (onSha?.data as { onSha?: string } | undefined)?.onSha ?? null;
    g.current = headSha === null || sha === null || sha === headSha;
  }

  const history = [...own, ...run]
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
    .map(toLine);

  // The plan the conductor wrote down when the run started. Without it the page
  // could only show points that reported, which is exactly the omission ADR
  // 0016 §4 forbids.
  const resolved = run.find((e) => e.type === "GatesResolved");
  const plan = (resolved?.data as { points?: { gate: string; actions: string[] }[] } | undefined)?.points;

  const all = [...gates.values()];
  const points: PointView[] = GATE_POINTS.map((point) => {
    const planned = plan?.find((p) => p.gate === point)?.actions ?? [];
    const verdicts = all.filter((g) => g.gate.startsWith(`${point}:`));
    return { point, planned, verdicts, skipped: planned.length === 0 && verdicts.length === 0 };
  });

  return { taskId, ticket, runId, headSha, baseSha, gates: all, points, history };
}
