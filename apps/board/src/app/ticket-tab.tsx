import { withAnswer, type TicketAnswer, type TicketTabDetail, type TicketView } from '@/lib/task'

import { Deferred, type Answered } from './deferred.tsx'
import { HistoryRow } from './history-row.tsx'
import { DocumentBody } from './markdown.tsx'
import { Skeleton } from './skeleton.tsx'

/**
 * What was asked for, in the record's prompt row.
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
export function Ticket({ ticket, pending = false }: { ticket: TicketView; pending?: boolean }) {
  return (
    <>
      <p className="tref">
        <span className="mono">#{ticket.ref}</span>
        {ticket.kind ? <span className="pill">{ticket.kind}</span> : null}
        {/* The kind *is* one of the labels — that is how `source.kinds` picks it
            up — so listing every label beside it showed `bug  bug` on every
            ticket in the repository (#111). The pill first, because it is the
            one label the conductor acts on; the rest after, once each. */}
        {ticket.labels
          .filter((l) => l !== ticket.kind)
          .map((l) => (
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

      <h3 className="ttitle">{ticket.title ?? '(no title was recorded)'}</h3>

      <div className={pending ? undefined : 'arrive'}>
        {ticket.body ? (
          <details className="tbody">
            <summary>
              The ticket, as it was written <span className="hint">closed: its table is already at the top</span>
            </summary>
            <DocumentBody source="ticket-body" text={ticket.body} rawClass="tbodytext" />
          </details>
        ) : null}

        {/* Never merely absent. An App that cannot reach the repository, a
          project that was never registered and an issue that has been deleted
          all render as a ticket with no body, and only the reason tells them
          apart (#76, one page along). The sentence names GitHub only where
          GitHub was actually asked — `askedGitHub` — because a project whose
          tickets live in the database was never going to be (#384). */}
        {pending ? (
          <Skeleton shape="lines" count={3} label="asking GitHub…" />
        ) : ticket.problem ? (
          <p className={ticket.askedGitHub ? 'refusal' : 'note'}>
            {ticket.askedGitHub ? `The issue could not be read from GitHub: ${ticket.problem}` : ticket.problem}
          </p>
        ) : ticket.body ? null : (
          <p className="empty">This issue has no body.</p>
        )}
      </div>
    </>
  )
}

/** The Ticket tab: what was asked, then the ticket stream's events (#885). */
export function TicketTab({ detail, answer }: { detail: TicketTabDetail; answer: Answered<TicketAnswer> }) {
  const base = detail.ticket
  return (
    <div className="atab">
      {base ? (
        // The log's part at once; the body, and the title and labels GitHub may
        // correct, where the answer is read (0118 §2).
        <Deferred
          value={answer}
          fallback={
            <Ticket
              pending
              ticket={withAnswer(base, {
                found: null,
                askedGitHub: false,
                title: null,
                labels: null,
                url: null,
                body: null,
                problem: null,
              })}
            />
          }
        >
          {(a) => <Ticket ticket={withAnswer(base, a)} />}
        </Deferred>
      ) : (
        <p className="empty">This id is not a ticket.</p>
      )}
      <details className="asec">
        <summary>
          <span className="hdocname">Events</span>
          <span className="hdocsize">{detail.events.length}</span>
        </summary>
        {detail.events.length === 0 ? (
          <p className="empty">
            Nothing yet — this ticket has no events, and this is where the log will record what happens to it.
          </p>
        ) : (
          <ol className="history">
            {detail.events.map((h) => (
              <li key={h.seq}>
                <HistoryRow line={h} />
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  )
}
