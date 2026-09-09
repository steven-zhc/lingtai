import Link from "next/link";
import { notFound } from "next/navigation";
import { loadTask, type TicketView } from "@/lib/task";
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
 * The history at the bottom is the point of an event-sourced system being
 * legible. Every summary above it is an interpretation; that list is what
 * actually happened, in order, with who did it — and every row of it opens on
 * the payload, which is the click the docstring used to promise and the page
 * did not have. A payload that carries a document opens on the document too;
 * see `history-row.tsx`.
 */
export const dynamic = "force-dynamic";

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

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await loadTask(decodeURIComponent(id));
  if (!task) notFound();

  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href="/">
          ← Lingtai
        </Link>
        <span className="sep" />
        <span className="mono">{task.taskId}</span>
        {task.headSha ? (
          <>
            <span className="sep" />
            <span className="mono">{task.headSha.slice(0, 7)}</span>
          </>
        ) : null}
      </div>

      <div className="detail-body">
        {/* First, because it is the question every other section is an answer
            to. */}
        <section>
          <h2>Ticket</h2>
          {task.ticket ? (
            <Ticket ticket={task.ticket} />
          ) : (
            <p className="empty">This id is not a work item, so there is no ticket behind it.</p>
          )}
        </section>

        {/* The gate that refused, what it said, the findings with their
            failure scenarios, and the diff. If you have to open GitHub to
            decide, nothing changed. */}
        <section>
          <h2>Gates</h2>
          {/* All five, always — including the ones nothing was configured at.
              A point that is merely omitted looks exactly like a point that was
              configured and silently did not run, and only one of those is our
              bug (ADR 0016 §4). */}
          <ol className="points">
            {task.points.map((p) => (
              <li key={p.point} className={p.skipped ? "point skipped" : "point"}>
                <span className="mono name">{p.point}</span>
                {p.skipped ? (
                  <span className="pill">skipped</span>
                ) : (
                  <span className="actions">
                    {p.planned.length > 0 ? p.planned.join(", ") : "\u2014"}
                    {p.planned.length > p.verdicts.length ? (
                      // Planned but no verdict. Either it is still running, or
                      // it did not run — and the second is the one worth seeing.
                      <span className="pill sig" title="planned, no verdict yet">
                        {p.planned.length - p.verdicts.length} pending
                      </span>
                    ) : null}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2>Verdicts</h2>
          {task.gates.length === 0 ? (
            <p className="empty">No gate has reported yet.</p>
          ) : (
            <Evidence
              // The ticket already parsed the id. A fifth copy of that split is
              // what `parseWorkItemStream` exists to stop.
              project={task.ticket?.project ?? ""}
              baseSha={task.baseSha}
              headSha={task.headSha ?? ""}
              gates={task.gates}
            />
          )}
        </section>

        <section>
          <h2>History</h2>
          <ol className="history">
            {task.history.map((h) => (
              // Keyed by seq, which the store assigns and nothing reuses.
              <li key={h.seq}>
                <HistoryRow line={h} />
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
