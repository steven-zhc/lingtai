import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { inWords } from "@lingtai/conductor/queue";
import { describeHold } from "@lingtai/projector/task-view";
import { loadTask, totalsFact, type RunView, type TaskDetail, type TicketView } from "@/lib/task";
import { elapsed } from "@/lib/progress";
import { Evidence } from "../../evidence.tsx";
import { HistoryRow } from "../../history-row.tsx";
import { DocumentBody } from "../../markdown.tsx";
import { Latch, Reveal } from "../../latch.tsx";
import { RunLog } from "../../run-log.tsx";
import { Coords, Standing } from "../../standing.tsx";

/**
 * One task, in full.
 *
 * Everything here is folded from the event stream when the page is opened —
 * nothing on this page is maintained in a table ([0012]). That is the trade the
 * card makes: the list stays cheap and scannable, and the detail is as rich as
 * it needs to be because it costs a read that happens rarely.
 *
 * **It opens with the answer, and the rest is a record** (#152). The page is
 * opened because something stopped, and it has one job: say *what* stopped,
 * *why*, and *what you can do*. That is `standing.tsx` — the state, the words of
 * whatever stopped it (or, while it runs, the run's live log), one sentence on
 * what that means, the moves, and the prompt and discussion beside each other.
 * Every identifier is in the bar, once (`Coords`).
 *
 * **Everything else is a record, and a record is consulted, not read**: four
 * collapsed rows, always these four, always in this order — findings, files,
 * attempts, prompt — so the shape is learned once. A page that rearranged
 * itself by state was read from the top every time.
 *
 * It used to be three sections under the block — the ticket, the attempts, the
 * history — each at display size, and each attempt carried its own prompt,
 * files and findings. They are the same facts in fewer places: the findings,
 * files and prompt rows list every attempt's, newest first, and the attempts
 * row keeps the ledger — the attempt is still the skeleton (#102) — and the
 * history under it. The history is still the point of an event-sourced system
 * being legible: every summary above it is an interpretation, and that list is
 * what actually happened, in order, with who did it. Every row of it opens on
 * the payload; see `history-row.tsx`.
 */
export const dynamic = "force-dynamic";

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
export function Ticket({ ticket }: { ticket: TicketView }) {
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
 * One attempt, in the record's attempts row.
 *
 * `alone` is the whole of "a one-attempt item does not carry the scaffolding of
 * a three-attempt one": the single run is open, and it is not numbered, because
 * *attempt 1 of 1* is a distinction nobody on that page is drawing.
 *
 * **Its coordinates, its log and its gate points** — and not its prompt, its
 * files or its findings, which are the record's other three rows (#152). Each
 * of those lists every attempt's under the attempt's name, so a fact is in one
 * row rather than in a row and again inside the attempt.
 */
export function Attempt({
  run,
  alone,
  deciding,
  followed = false,
}: {
  run: RunView;
  alone: boolean;
  /**
   * True when the block at the top points here.
   *
   * Marked *and* open: the pointer carries one line and this attempt holds the
   * whole of it, so following the link has to land on something readable
   * without a second click. It is inside the record's attempts row, which is
   * closed on load, so that row is opened for it by `Reveal` — on the click, on
   * a hash change and on a load at the hash (#152). Without JavaScript that is
   * left to the browser, and not every browser does it.
   */
  deciding: boolean;
  /**
   * True when this attempt's log is already being followed at rank 2 of the
   * page, which is where a running item's log is (#152). The row says where it
   * went rather than opening a second follower on the same file.
   */
  followed?: boolean;
}) {
  /**
   * The one attempt that is producing output while you read the page.
   *
   * It opens itself, for the reason `deciding` does and one more: a run in
   * flight is the only thing on this page that will be different in a minute,
   * and it was two disclosures deep with nothing saying it was there (#132).
   * Its `RunLog` opens with it and follows; every other attempt stays closed
   * and reads nothing.
   *
   * **`Latch` and not an `open` attribute**, because this one is derived from
   * the fold and the board re-renders on every append: written as an attribute
   * it would open when the run started and then *close under the person reading
   * it* the moment the run finished, which is the one second they were there
   * for. Opening is a signal, closing is the reader's — see `latch.tsx`.
   */
  const running = run.outcome.state === "running";
  return (
    <Latch
      className={deciding ? "attempt deciding" : "attempt"}
      id={`attempt-${run.attempt}`}
      initial={alone || deciding || running}
      openWhen={running}
    >
      <summary>
        {/* The disclosure triangle is `details > summary::before`, drawn once for
            every disclosure on the board. In a grid it is the row's first cell,
            which is why the column template opens with one for it. */}
        <span className="aname">
          <span className="anum">{alone ? "the run" : `attempt ${run.attempt}`}</span>
          <span className={`pill ${outcomeClass(run.outcome.state)}`}>{run.outcome.state}</span>
          {/* Named, because a repair was an ordinary run with no vocabulary of
              its own (0025) and its spend is counted apart from the work's
              (#84). **Only ever on an attempt from before `#143`**: a refusal
              buys no run now, so nothing can put this chip on a new one — and
              it stays because an old ticket's second attempt really was one,
              and dropping the chip would fold that money into the work's. */}
          {run.repair ? (
            <span
              className="pill hold"
              title="this attempt is the one a failure bought — a purchase retired by #143"
            >
              repair
            </span>
          ) : null}
          {/* A pointer, not a copy: the whole of a failure is in this attempt's
              own history, and printing it twice is how two copies of one fact
              come to disagree (design §2). */}
          {run.outcome.detail ? <span className="adetail">{run.outcome.detail}</span> : null}
        </span>
        {/* Four figures, each in its own column, **each rendered whether or not
            it has a value**. Joined into one string they lined up with nothing;
            the ledger's whole use of the page's width is that these read *down*.
            A column that vanishes when null is a column that stops aligning, and
            an em dash is a different fact from a shorter row: this run recorded
            no cost, rather than this row being narrower. Same rule as 0016 §4,
            one page along. */}
        <span className="afig">{run.turns === null ? "—" : `${run.turns} turns`}</span>
        <span className="afig">
          {run.durationMs === null ? "—" : elapsed(run.durationMs)}
        </span>
        <span className="afig">{run.costUsd === null ? "—" : `$${run.costUsd.toFixed(2)}`}</span>
        <span className="afig">
          {run.diff === null
            ? "—"
            : `${run.diff.files}f +${run.diff.insertions} −${run.diff.deletions}`}
        </span>
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

      {/* What it was doing between being told and being judged (`#110`). Closed,
          and nothing is read until it is opened: a page with six attempts would
          otherwise follow six files nobody asked to see — **except the one that
          is still going**, which opens with its attempt and follows (#132). And
          when the item itself is running, that log is the page's rank 2, so
          this row points up to it instead of following the same file twice
          (#152). */}
      {followed ? (
        <p className="empty">Its run log is being followed at the top of this page.</p>
      ) : (
        <RunLog runId={run.runId} live={running} />
      )}

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
                  //
                  // Not amber. Amber is "a human is being waited on" and since
                  // #103 there is one on this page that means it; a second use
                  // for "worth seeing" is the dilution the layout notes forbid,
                  // and a gate with no verdict is waiting on nobody.
                  <span className="pill" title="planned, no verdict yet">
                    {p.planned.length - p.verdicts.length} pending
                  </span>
                ) : null}
              </span>
            )}
          </li>
        ))}
      </ol>
    </Latch>
  );
}

/**
 * The names of the record's rows, in their order. **Always these four, always
 * this order, whatever the state** (#152): a record is consulted rather than
 * read, and a shape that is the same every time is learned once.
 */
export const RECORD_ROWS = ["findings", "files", "attempts", "prompt"] as const;

/** One row of the record: a name, its one fact, and closed until asked. */
function Row({
  name,
  fact,
  children,
}: {
  name: (typeof RECORD_ROWS)[number];
  fact: string | null;
  children: ReactNode;
}) {
  return (
    <details className="rrow" id={`record-${name}`}>
      <summary>
        <span className="rname">{name}</span>
        {fact ? <span className="rfact">{fact}</span> : null}
      </summary>
      <div className="rbody">{children}</div>
    </details>
  );
}

/** `attempt 2`, above an attempt's share of a row — only where there is more than one to tell apart. */
function Of({ run, many }: { run: RunView; many: boolean }) {
  return many ? <p className="rof">attempt {run.attempt}</p> : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Rank 7: everything the first screen does not need, as four collapsed rows.
 *
 * Each row lists every attempt's share of it, newest first — the newest is the
 * one a decision is about, and an older one is still one line down.
 */
export function Record({ task }: { task: TaskDetail }) {
  const newest = [...task.runs].reverse();
  const many = task.runs.length > 1;
  const project = task.ticket?.project ?? "";

  const verdicts = task.runs.reduce((n, r) => n + r.gates.length, 0);
  const findings = task.runs.reduce(
    (n, r) => n + r.gates.reduce((m, g) => m + g.findings.length, 0),
    0,
  );
  const paths = new Set(task.runs.flatMap((r) => r.files.map((f) => f.path))).size;
  const events = task.history.reduce((n, g) => n + g.lines.length, 0);

  // What the diagnosis said beyond rank 3's sentence: what was already done, and
  // the recommendation with the whole of its why. These were the block's rank 3
  // until #152 made that one sentence; they are true and they are record.
  const beyond = describeHold({ needs: null, diagnosis: task.standing.diagnosis }).filter(
    (line) => line.part === "did" || line.part === "rec",
  );

  return (
    <section className="record" data-rank="record">
      <Row
        name="findings"
        fact={verdicts === 0 ? "no gate reported" : `${plural(verdicts, "verdict")} · ${plural(findings, "finding")}`}
      >
        {/* The gate that refused, what it said, the findings with their failure
            scenarios, and that attempt's diff. If you have to open GitHub to
            decide, nothing changed. */}
        {verdicts === 0 ? (
          <p className="empty">No gate has reported on any attempt.</p>
        ) : (
          newest
            .filter((run) => run.gates.length > 0)
            .map((run) => (
              <div key={run.runId} className="rpart">
                <Of run={run} many={many} />
                <Evidence
                  // The ticket already parsed the id. A fifth copy of that split
                  // is what `parseWorkItemStream` exists to stop.
                  project={project}
                  baseSha={run.baseSha}
                  headSha={run.headSha ?? ""}
                  gates={run.gates}
                />
              </div>
            ))
        )}
      </Row>

      <Row name="files" fact={paths === 0 ? "none touched" : plural(paths, "path")}>
        {paths === 0 ? (
          <p className="empty">No attempt has touched a file.</p>
        ) : (
          newest
            .filter((run) => run.files.length > 0)
            .map((run) => (
              <div key={run.runId} className="rpart">
                <Of run={run} many={many} />
                <ul className="flist">
                  {run.files.map((f) => (
                    <li key={f.path}>
                      <span className="pill">{f.op}</span>
                      <span className="fpath">{f.path}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
        )}
      </Row>

      <Row name="attempts" fact={totalsFact(task.totals)}>
        {beyond.map((line) => (
          <p key={line.part} className="rhow">
            {line.text}
          </p>
        ))}

        {task.runs.length === 0 ? (
          <p className="empty">No agent has been dispatched for this ticket yet.</p>
        ) : (
          <div className="ledger">
            {task.runs.map((run) => (
              <Attempt
                key={run.runId}
                run={run}
                alone={task.runs.length === 1}
                deciding={task.standing.deciding?.attempt === run.attempt}
                followed={task.standing.state === "running" && task.standing.runId === run.runId}
              />
            ))}
          </div>
        )}

        {/* The history, under the ledger it is the whole of. Still the question
            a summary did not anticipate, and still last. */}
        <p className="rof">{events === 0 ? "history" : `history · ${events} events · grouped by run`}</p>
        {/* Stated, not omitted. ADR 0016 §4's rule reaches here too: a list that
            renders nothing looks exactly like a list whose events failed to
            load, and only one of those is our bug. A ticket nothing has run has
            an empty log *and that is the whole of its story* (#113). */}
        {task.history.length === 0 ? (
          <p className="empty">
            Nothing yet — this ticket has no events, and this is where the log will record what
            happens to it.
          </p>
        ) : null}
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
      </Row>

      <Row name="prompt" fact={task.ticket?.title ?? null}>
        {/* What was asked, then what each attempt was handed for it. */}
        {task.ticket ? (
          <Ticket ticket={task.ticket} />
        ) : (
          <p className="empty">This id is not a work item, so there is no ticket behind it.</p>
        )}
        {newest
          .filter((run) => run.prompt !== null)
          .map((run) => (
            // Raw, always. #88's justification is that the log holds the exact
            // document the agent was given; `markdown.tsx` offers the reading.
            <details key={run.runId} className="aprompt">
              <summary>
                <span className="hdocname">{many ? `attempt ${run.attempt}'s prompt` : "prompt"}</span>
                <span className="hdocsize">
                  {run.prompt!.version} · {run.prompt!.bytes} bytes
                </span>
              </summary>
              {run.prompt!.text === null ? (
                <p className="empty">
                  This run predates the prompt being recorded, so the log has its length and not the
                  document (#88).
                </p>
              ) : (
                <DocumentBody source="prompt" text={run.prompt!.text} rawClass="hdoctext" />
              )}
            </details>
          ))}
      </Row>
    </section>
  );
}

/**
 * The page, given what `loadTask` folded. Apart from the route so a test can
 * render the whole arrangement without a database (#152).
 */
export function TaskBody({ task }: { task: TaskDetail }) {
  // The issue the controls would act on. `ref` is GitHub's own number, so
  // anything that does not parse is an id that was never one.
  const ref = Number(task.ticket?.ref);
  const issueNumber = Number.isSafeInteger(ref) && ref > 0 ? ref : null;

  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href="/">
          ← Lingtai
        </Link>
        <span className="sep" />
        {/* Rank 8: one muted line, each identifier once. */}
        <Coords standing={task.standing} taskId={task.taskId} queued={task.queued} />
      </div>

      {/* Every `#attempt-N` on this page points into the record's closed
          attempts row; this opens the row on the way there. See `openTo`. */}
      <Reveal />

      <div className="detail-body">
        {/* Ranks 1 to 6: the answer, and the moves, on the first screen. */}
        <Standing
          standing={task.standing}
          taskId={task.taskId}
          discussions={task.discussions}
          outgoing={task.outgoing}
          project={task.ticket?.project ?? null}
          // The controls act on a GitHub issue. An id that is not `wi-<p>-<n>`
          // has none, and the block states the state without offering a move.
          issue={issueNumber}
          queued={task.queued}
          // The one thing a 404 used to be standing in for: nothing in the log
          // and no answer from GitHub is *I cannot tell*, and a page that said
          // "it does not exist" was making a claim Lingtai is not in a position
          // to make (#113). Only when the log has nothing at all — an item it
          // has touched is a page whatever GitHub says today.
          unknown={
            task.history.length === 0 && task.ticket?.found === null ? task.ticket.problem : null
          }
        />

        <Record task={task} />
      </div>
    </main>
  );
}

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await loadTask(decodeURIComponent(id));
  if (!task) notFound();
  return <TaskBody task={task} />;
}
