import { Fragment } from "react";
import Link from "next/link";
import { emptyNote, loadBoard, type BoardCard } from "@/lib/board";
import { loadProjects } from "@lingtai/conductor/projects";
import { inWords } from "@lingtai/conductor/queue";
// The subpath, not the barrel: the board reads the control stream and hosts
// no work, and `@lingtai/daemon` would drag the work loop and the runtime in
// behind it — the same reason the actions import `@lingtai/conductor/decide`.
import { readControl } from "@lingtai/daemon/control";
import { Decide, Requeue } from "./decide.tsx";
import { Live } from "./live.tsx";
import { Paused } from "./paused.tsx";

/**
 * The board is not a status page. It is where the backlog gets worked, and the
 * old loop's review queue reached 45 items growing at 14 a day against zero
 * processed because working one meant leaving the tool.
 *
 * **The card carries what you scan; everything else is one click away.** It
 * used to carry the gate evidence, the findings and the diff too, and it grew
 * heavy for a structural reason: the projection made all of it available, and
 * what is available gets rendered. Since 0012 the list reads one table and the
 * detail is folded from the event stream on demand, which makes a card's
 * contents a decision instead of a consequence.
 *
 * The controls stay on the card. Deciding is the thing this exists for, and
 * making somebody open a page to approve would put back the cost that the 45
 * items measured.
 */
export const dynamic = "force-dynamic";

/**
 * The stripe down the left edge, from what the card is waiting on.
 *
 * Ordered by what a person needs to see first: a failed gate beats an abandoned
 * attempt beats a question beats a merge. A card with nothing to say gets the
 * neutral rule, not a colour — every stripe on the board would be the same as
 * none.
 *
 * `a-hold` is the one #78 added, and it is why a stripe was missing: a run
 * killed from outside fails no gate, so `gatesFailed` stayed 0 and a ticket that
 * had burned money and produced nothing came back to Queued looking new. A
 * queued card carrying a note is exactly that card — the note is the release's
 * reason, and the next claim clears it.
 */
function accent(card: BoardCard): string {
  if (card.gatesFailed > 0) return "a-fail";
  if (card.column === "queued" && card.note) return "a-hold";
  if (card.column === "waiting") return "a-sig";
  if (card.column === "landed") return "a-pass";
  if (card.column === "running") return "a-run";
  return "";
}

function Card({ card, showProject }: { card: BoardCard; showProject: boolean }) {
  return (
    <article className={`card ${accent(card)}`}>
      {/* Reference and kind are one fact — which ticket — so they are one line.
          Split apart, the kind read as a status badge, which it is not. */}
      <span className="id">
        {/* Only when the board holds more than one project. With a single
            project the bar already says which, and repeating it on every card
            is noise. */}
        {showProject ? <span className="proj">{card.project} </span> : null}#{card.ref} · {card.kind}
      </span>

      {/* The whole card title is the link. Anything smaller is a target you
          have to aim at, on the one control every card has. */}
      <Link className="ti" href={`/task/${encodeURIComponent(card.taskId)}`}>
        {card.title}
      </Link>

      <ul className="meta">
        {card.turns !== null ? <li className="pill">{card.turns} turns</li> : null}
        {card.costUsd !== null ? <li className="pill">${card.costUsd.toFixed(2)}</li> : null}
        {/* Green is a gate that ran and went green. A waiver and an approval are
            a person's word standing in for one, so they carry the held colour
            and their own word — counting either as "passed" made an override of
            a red build look identical to a green one. */}
        {card.gatesPassed > 0 ? <li className="pill pass">{card.gatesPassed} passed</li> : null}
        {card.gatesFailed > 0 ? <li className="pill fail">{card.gatesFailed} failed</li> : null}
        {card.gatesWaived > 0 ? (
          <li className="pill hold" title="a person overrode a failed gate">
            {card.gatesWaived} waived
          </li>
        ) : null}
        {card.gatesApproved > 0 ? (
          <li className="pill hold" title="a person approved, rather than a gate passing">
            {card.gatesApproved} approved
          </li>
        ) : null}
        {/* Apart from the work's cost, deliberately. A repair is default-on and
            spends an agent without being asked again, so folding it into the
            number beside it would make it an invisible bill (#84). */}
        {card.repairCostUsd !== null ? (
          <li className="pill sig" title="what diagnosing this has cost, apart from the work">
            ${card.repairCostUsd.toFixed(2)} repair
          </li>
        ) : null}
        {/* A card that keeps failing should read as one rather than looking new
            every time it comes back round. */}
        {card.attempts > 1 ? (
          <li className="pill sig" title="attempts so far">
            attempt {card.attempts}
          </li>
        ) : null}
        {/* When, not whether (#95). A card the backoff is holding sits in Queued
            looking like one nobody has got to yet, and it is the one that will
            not be taken next — so the time is the whole of the difference. The
            recipe's `source.backoff` from the last attempt (0028). */}
        {card.runnableAt ? (
          <li className="pill hold" title={`backing off until ${card.runnableAt}`}>
            runnable in {inWords(Date.parse(card.runnableAt) - Date.now())}
          </li>
        ) : null}
      </ul>

      {card.note ? <p className="question">{card.note}</p> : null}

      {/* Only where a person is actually the thing being waited on. A card in
          Gates is waiting on a process, and offering to approve it would invite
          a decision nobody is being asked for.

          And only where Approve can *work*. "Waiting, and there is a head sha"
          was also true of an item whose approved merge had hit a conflict: the
          approval consumed, the run back to `gating`, and every click refused
          with `not-awaiting-approval` (#84). That card gets the move it
          actually has — back to the queue, where the next attempt is cut from a
          base that has since moved — rather than a control that cannot act.

          `blocked` and not the column, for the same reason: the lane also holds
          a refused dispatch and a run that asked a question mid-flight, and
          neither is an item anybody can hand back. */}
      {card.blocked && card.headSha && card.awaitingApproval ? (
        <Decide
          project={card.project}
          issue={Number(card.ref)}
          onSha={card.headSha}
          gates={card.gatesFailed > 0 ? ["build"] : []}
        />
      ) : card.blocked ? (
        <Requeue project={card.project} issue={Number(card.ref)} />
      ) : null}
    </article>
  );
}

export default async function Page() {
  const { columns, repair } = await loadBoard();
  const projects = await loadProjects().catch(() => []);
  // Not caught. A control read that fails would render as "nothing is paused",
  // which is the exact silence #77 is about; and it reads the same database
  // `loadBoard` just read, so it fails when the board fails and not otherwise.
  const control = await readControl();
  const total = columns.reduce((n, c) => n + c.cards.length, 0);
  // What the *cards* say, not what is registered: a card can outlive its
  // project, and it is the cards that have to be told apart.
  const onBoard = new Set(columns.flatMap((c) => c.cards.map((card) => card.project)));

  return (
    <main>
      <div className="bar">
        <span className="brand">Lingtai</span>
        <span className="sep" />
        <span>
          {projects.length === 0
            ? "no project configured"
            : projects.map((p) => p.project).join(", ")}
        </span>
        <span className="sep" />
        <span className={`chip ${total > 0 ? "" : "idle"}`}>
          {total > 0 ? `${total} items` : "nothing in the log yet"}
        </span>
        {/* Whether a failure of this repository's buys an agent — shown when it
            is off as well as when it is on, the way an unconfigured gate point
            is shown as `skipped` rather than omitted (0025 §2). A default that
            spends money and is invisible until it fires is one nobody can
            audit. */}
        {repair.map((r) => (
          // A fragment, not a wrapper: `.bar` lays its children out directly,
          // and an element around the pair would be one flex item instead of
          // two.
          <Fragment key={r.project}>
            <span className="sep" />
            <span
              className={`chip ${r.on ? "" : "idle"}`}
              title={
                r.on
                  ? `a failure of ${r.project}'s buys an agent to fix it, at most ${r.maxAttempts} time(s) per item`
                  : `${r.project} does not repair — a failure waits for you`
              }
            >
              {repair.length > 1 ? `${r.project}: ` : ""}
              {r.on ? `repairs ×${r.maxAttempts}` : "no repair"}
            </span>
          </Fragment>
        ))}
        <span className="sep" />
        {/* Says whether what you are looking at is current. A board that has
            silently stopped updating is worse than one that admits it. */}
        <Live />
        {/* And, beside it, whether anything is going to move. Two chips because
            two facts: the projection can be at the head of the log while the
            conductor has been told to take nothing, which is what the board
            showed for four days without a word for it (#77). */}
        {control.paused ? (
          <>
            <span className="sep" />
            <Paused by={control.by} reason={control.reason} />
          </>
        ) : null}
      </div>

      <div className="cols">
        {columns.map((col) => (
          <section key={col.id} className={`col${col.id === "waiting" ? " hot" : ""}`}>
            <header className="col-h">
              <span>{col.label}</span>
              <span className="ct">{col.cards.length}</span>
            </header>
            <div className="cards">
              {/* **An empty column and an unanswerable one are different facts.**
                  They rendered identically until #76: a recipe that would not
                  parse took every issue out of Queued, and the column read
                  exactly like a repository with nothing to do. So the reason
                  goes here, where somebody is already looking, and the "nothing
                  here yet" line is kept for the case that actually means it.

                  Three cases now, and they are three: the queue could not be
                  listed (#76), the lane is empty because somebody stopped the
                  conductor (#77), and the lane is simply empty. Only the last
                  one means what it says. */}
              {col.problems?.map((p) => (
                <p key={p.project} className="empty broken">
                  <strong>{p.project}</strong>: the queue could not be listed — {p.reason}
                </p>
              ))}
              {col.cards.length === 0 && !col.problems?.length ? (
                <p className={`empty${col.id === "running" && control.paused ? " held" : ""}`}>
                  {emptyNote(col.id, control.paused)}
                </p>
              ) : (
                col.cards.map((card) => (
                  <Card key={card.taskId} card={card} showProject={onBoard.size > 1} />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
