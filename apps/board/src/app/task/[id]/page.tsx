import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { inWords } from "@lingtai/conductor/queue";
import { loadTask, type RunView, type TicketView, type Totals } from "@/lib/task";
import { elapsed } from "@/lib/progress";
import { Evidence } from "../../evidence.tsx";
import { HistoryRow } from "../../history-row.tsx";
import { DocumentBody } from "../../markdown.tsx";

/**
 * One task, in full.
 *
 * Everything here is folded from the event stream when the page is opened —
 * nothing on this page is maintained in a table ([0012]). That is the trade the
 * card makes: the list stays cheap and scannable, and the detail is as rich as
 * it needs to be because it costs a read that happens rarely.
 *
 * **It opens with the ticket**, because this is where somebody decides and
 * deciding needs what was asked and not only what was done. The page had no
 * reference to a title or a body at all, so answering "what was this supposed
 * to do" meant going back to the board and then out to GitHub (#87).
 *
 * **Then the attempts, because the attempt is the skeleton** (the settled
 * design, §1). The log keeps one stream per run and this page used to flatten
 * what the log divided — one `runId`, one list — so three claims read as one
 * 80-row list and gates that run *per attempt* sat in a page-level section
 * (#102). A ledger: one row per attempt, opening on that attempt's whole arc —
 * its prompt, its files, its gates, its verdicts and its money.
 *
 * The history at the bottom is the point of an event-sourced system being
 * legible. Every summary above it is an interpretation; that list is what
 * actually happened, in order, with who did it — grouped by the stream it came
 * off and otherwise untouched. Every row of it opens on the payload, and a
 * payload that carries a document opens on the document too; see
 * `history-row.tsx`.
 */
export const dynamic = "force-dynamic";

/**
 * A section label, with the section's one fact at the right of the same rule.
 *
 * There is no separate summary band, deliberately: a band that totals what is
 * under it is a second copy of the same arithmetic, and the two disagree the
 * first time one of them is changed.
 */
function Label({ children, fact }: { children: ReactNode; fact?: string | null }) {
  return (
    <h2>
      <span>{children}</span>
      {fact ? <span className="hfact">{fact}</span> : null}
    </h2>
  );
}

/**
 * What was asked for, at the top.
 *
 * Collapsed body, expanded everything else. The title, the kind, the labels and
 * the link are the fact of which ticket this is and belong in one glance; the
 * body is a document, and a page that opens three screens tall is its own kind
 * of unreadable — the same trade the evidence disclosures make.
 *
 * The body renders as markdown, sanitised, because it *is* markdown: somebody
 * wrote it on GitHub in a box that says so. It is also the one thing on this
 * page written by whoever can file an issue on a managed repository, so how it
 * is rendered is a security question and is answered once, in `markdown.tsx`.
 */
function Ticket({ ticket }: { ticket: TicketView }) {
  return (
    <>
      <p className="tref">
        <span className="mono">#{ticket.ref}</span>
        {ticket.kind ? <span className="pill">{ticket.kind}</span> : null}
        {ticket.labels.map((l) => (
          <span key={l} className="pill">
            {l}
          </span>
        ))}
        {ticket.url ? (
          <a className="tlink" href={ticket.url} target="_blank" rel="noreferrer">
            on GitHub ↗
          </a>
        ) : null}
      </p>

      <h3 className="ttitle">{ticket.title ?? "(no title was recorded)"}</h3>

      {ticket.body ? (
        <details className="tbody">
          <summary>The ticket, as it was written</summary>
          <DocumentBody source="ticket-body" text={ticket.body} rawClass="tbodytext" />
        </details>
      ) : null}

      {/* Never merely absent. An App that cannot reach the repository, a
          project that was never registered and an issue that has been deleted
          all render as a ticket with no body, and only the reason tells them
          apart (#76, one page along). */}
      {ticket.problem ? (
        <p className="refusal">The issue could not be read from GitHub: {ticket.problem}</p>
      ) : ticket.body ? null : (
        <p className="empty">This issue has no body.</p>
      )}
    </>
  );
}

/** Green is a run that ended well; red is one that did not; amber is neither yet. */
function outcomeClass(state: RunView["outcome"]["state"]): string {
  if (state === "failed") return "fail";
  if (state === "finished") return "pass";
  return "hold";
}

/**
 * The totals, as the Attempts label's one fact.
 *
 * Money only when there is money: `RunFinished.costUsd` is nullable, so a run
 * whose cost was never reported has not been shown to be free and `$0.00` would
 * say it had. A repair's spend is beside the work's and never inside it, the
 * way the board keeps it (#84).
 *
 * The design's example reads `2 attempts + 3 discussions · …`. There are no
 * discussions to count yet — §5's `DiscussionHeld` is not in the catalogue —
 * and a clause that is always `0 discussions` would be furniture.
 */
function totalsFact(totals: Totals): string | null {
  if (totals.attempts === 0) return null;
  return [
    `${totals.attempts} attempt${totals.attempts === 1 ? "" : "s"}`,
    totals.turns > 0 ? `${totals.turns} turns` : null,
    totals.durationMs > 0 ? elapsed(totals.durationMs) : null,
    totals.costUsd > 0 ? `$${totals.costUsd.toFixed(2)}` : null,
    totals.repairUsd > 0 ? `$${totals.repairUsd.toFixed(2)} repair` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(" · ");
}

/**
 * One attempt, opening on the whole of it.
 *
 * `alone` is the whole of "a one-attempt item does not carry the scaffolding of
 * a three-attempt one": the single run is open, and it is not numbered, because
 * *attempt 1 of 1* is a distinction nobody on that page is drawing.
 */
function Attempt({ run, alone, project }: { run: RunView; alone: boolean; project: string }) {
  const facts = [
    run.turns === null ? null : `${run.turns} turns`,
    run.durationMs === null ? null : elapsed(run.durationMs),
    run.costUsd === null ? null : `$${run.costUsd.toFixed(2)}`,
    run.diff === null ? null : `${run.diff.files} files +${run.diff.insertions} −${run.diff.deletions}`,
  ].filter((s): s is string => s !== null);

  return (
    <details className="attempt" open={alone}>
      <summary>
        <span className="anum">{alone ? "the run" : `attempt ${run.attempt}`}</span>
        <span className={`pill ${outcomeClass(run.outcome.state)}`}>{run.outcome.state}</span>
        {/* A pointer, not a copy: the whole of a failure is in this attempt's
            own history, and printing it twice is how two copies of one fact
            come to disagree (design §2). */}
        {run.outcome.detail ? <span className="adetail">{run.outcome.detail}</span> : null}
        {/* Named, because a repair is an ordinary run with no vocabulary of its
            own (0025) and its spend is counted apart from the work's (#84). */}
        {run.repair ? (
          <span className="pill hold" title="this attempt is the one a failure bought">
            repair
          </span>
        ) : null}
        <span className="afacts">{facts.join(" · ")}</span>
        {/* Dated *and* relative. `04:12:15` alone cannot tell a run from three
            days ago apart from one ten minutes old (#102). */}
        <span className="aage" title={run.at}>
          {run.at.slice(0, 10)} · {inWords(Date.now() - Date.parse(run.at))} ago
        </span>
      </summary>

      <p className="ameta">
        <span className="mono">{run.runId}</span>
        {run.baseSha ? <span className="mono">base {run.baseSha.slice(0, 7)}</span> : null}
        {run.headSha ? <span className="mono">head {run.headSha.slice(0, 7)}</span> : null}
        {run.diff ? <span className="mono">{run.diff.branch}</span> : null}
      </p>

      {/* Raw, always. #88's justification is that the log holds the exact
          document the agent was given; `markdown.tsx` offers the reading. */}
      {run.prompt ? (
        <details className="aprompt">
          <summary>
            <span className="hdocname">prompt</span>
            <span className="hdocsize">
              {run.prompt.version} · {run.prompt.bytes} bytes
            </span>
          </summary>
          {run.prompt.text === null ? (
            <p className="empty">
              This run predates the prompt being recorded, so the log has its length and not the
              document (#88).
            </p>
          ) : (
            <DocumentBody source="prompt" text={run.prompt.text} rawClass="hdoctext" />
          )}
        </details>
      ) : null}

      {run.files.length > 0 ? (
        <details className="afiles">
          <summary>
            <span className="hdocname">files touched</span>
            <span className="hdocsize">{run.files.length}</span>
          </summary>
          <ul className="flist">
            {run.files.map((f) => (
              <li key={f.path}>
                <span className="pill">{f.op}</span>
                <span className="fpath">{f.path}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* All five, always — including the ones nothing was configured at. A
          point that is merely omitted looks exactly like a point that was
          configured and silently did not run, and only one of those is our bug
          (ADR 0016 §4). Under the attempt, because a gate runs once per
          attempt: attempt 1's failing `proposed` and attempt 2's have nothing
          to do with each other and used to sit in one list. */}
      <ol className="points">
        {run.points.map((p) => (
          <li key={p.point} className={p.skipped ? "point skipped" : "point"}>
            <span className="mono name">{p.point}</span>
            {p.skipped ? (
              <span className="pill">skipped</span>
            ) : (
              <span className="actions">
                {p.planned.length > 0 ? p.planned.join(", ") : "—"}
                {p.planned.length > p.verdicts.length ? (
                  // Planned but no verdict. Either it is still running, or it
                  // did not run — and the second is the one worth seeing.
                  <span className="pill sig" title="planned, no verdict yet">
                    {p.planned.length - p.verdicts.length} pending
                  </span>
                ) : null}
              </span>
            )}
          </li>
        ))}
      </ol>

      {/* The gate that refused, what it said, the findings with their failure
          scenarios, and this attempt's diff. If you have to open GitHub to
          decide, nothing changed. */}
      {run.gates.length > 0 ? (
        <Evidence
          // The ticket already parsed the id. A fifth copy of that split is
          // what `parseWorkItemStream` exists to stop.
          project={project}
          baseSha={run.baseSha}
          headSha={run.headSha ?? ""}
          gates={run.gates}
        />
      ) : (
        <p className="empty">No gate reported on this attempt.</p>
      )}
    </details>
  );
}

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await loadTask(decodeURIComponent(id));
  if (!task) notFound();

  // The bar names the commit somebody is looking at, which is the newest
  // attempt's — the one figure on this page that is still about the latest run
  // rather than about all of them.
  const head = task.runs.at(-1)?.headSha ?? null;
  const events = task.history.reduce((n, g) => n + g.lines.length, 0);

  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href="/">
          ← Lingtai
        </Link>
        <span className="sep" />
        <span className="mono">{task.taskId}</span>
        {head ? (
          <>
            <span className="sep" />
            <span className="mono">{head.slice(0, 7)}</span>
          </>
        ) : null}
      </div>

      <div className="detail-body">
        {/* First, because it is the question every other section is an answer
            to. */}
        <section>
          <Label>Ticket</Label>
          {task.ticket ? (
            <Ticket ticket={task.ticket} />
          ) : (
            <p className="empty">This id is not a work item, so there is no ticket behind it.</p>
          )}
        </section>

        <section>
          <Label fact={totalsFact(task.totals)}>Attempts</Label>
          {task.runs.length === 0 ? (
            <p className="empty">No agent has been dispatched for this ticket yet.</p>
          ) : (
            <div className="ledger">
              {task.runs.map((run) => (
                <Attempt
                  key={run.runId}
                  run={run}
                  alone={task.runs.length === 1}
                  project={task.ticket?.project ?? ""}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <Label fact={`${events} events · grouped by run`}>History</Label>
          {task.history.map((group) => (
            <div key={group.streamId} className="hgroup">
              {/* Dropped when there is only one stream to name: an item with
                  nothing but its own events does not need to be told which
                  events these are. */}
              {task.history.length > 1 ? (
                <p className="hglabel">
                  <span className="hgname">{group.label}</span>
                  <span className="mono">{group.streamId}</span>
                  <span className="hgseq">
                    seq {group.from}–{group.to} · {group.lines.length} events
                  </span>
                </p>
              ) : null}
              <ol className="history">
                {group.lines.map((h) => (
                  // Keyed by seq, which the store assigns and nothing reuses.
                  <li key={h.seq}>
                    <HistoryRow line={h} />
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
