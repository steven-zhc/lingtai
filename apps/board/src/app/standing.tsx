import { inWords } from "@lingtai/conductor/queue";
// The subpath, for the reason `board.ts` gives: the barrel pulls the gate
// pipeline in behind it. `describeHold` is pure and lives beside the field it
// reads, so this block, the card and `lingtai status` say the same thing about
// the same hold rather than keeping three copies of the words.
import { describeHold, type HoldLine } from "@lingtai/projector/task-view";
import type { DiscussionView, StandingView } from "@/lib/task";
import type { OutgoingView } from "@/lib/prompt";
import { holding, place, type QueuedView } from "@/lib/queued";
import { Decide, Requeue, RunNow, Send } from "./decide.tsx";
import { Discussion } from "./discussion.tsx";
import { Outgoing } from "./outgoing.tsx";
import { Plan } from "./plan.tsx";

/**
 * Why this task is not moving, above everything else.
 *
 * **The page never stated it.** The commonest reason anybody opens this page is
 * that a card has stopped, and the state had to be inferred by reading to the
 * bottom of a 30–80 row history. On 2026-09-08 that produced a wrong reading
 * four times — #80, #87, #89, #94 — including one where the item was *not*
 * stuck at all and would have returned on its own. So `queued` and `running`
 * are stated here as loudly as `blocked` is: the absence of the word "blocked"
 * is not an answer anybody trusts at the top of a long page.
 *
 * **Two values, not a status line.** The state, and how long it has held. The
 * second is a fact of equal weight and not an annotation on the first —
 * *blocked* and *blocked for four days* are different situations and only one
 * of them is an emergency, which is #79's argument one page along and #77's
 * about the bar.
 *
 * **Two renderings, one component** (design §3). Today: the state, the age, the
 * question verbatim, the actions. Once `#83` fills `diagnosis`, its sentence
 * and its recommendation fill into the same block through `describeHold` — and
 * a block with no diagnosis renders exactly as it does today, because those
 * lines are simply absent. That degradation is #83's own requirement, not a
 * courtesy.
 *
 * **The evidence is a pointer** (design §2). One deciding line, naming the
 * attempt that holds the whole of it — with its gate output, its findings and
 * its diff — and linking to it. `diagnosis.raw` is deliberately not repeated
 * here: printing the failing gate twice, at the top and inside its attempt, is
 * how two copies of one fact come to disagree.
 *
 * **It ends in the thing that will actually run** (design §4). A recommendation
 * is the system's sentence about what it intends; the prompt is what runs, so
 * it is shown here — before the buttons that send it, and editable. That is
 * what turns approval from *yes / no* into *yes, but*, which is the answer a
 * person usually has and until `#104` could not give — and until `#111` could
 * not act on, because the box was editable and nothing sent it.
 *
 * **The discussion is inside this block**, and it is the second of the two
 * objects the layout notes allow a frame in it — the outgoing prompt is the
 * first. That is where the design puts it and it is
 * the right place for the reason the block exists: this is where somebody
 * decides, and *"why is this stuck"* is a question asked at the moment of
 * deciding rather than at the bottom of the page (0033).
 *
 * **Those two sit side by side above ~64rem**, the prompt first, and the moves
 * under both. One stack left a third of a 1440 viewport empty and put the
 * discussion below the fold of the thing it is a conversation about; DOM order
 * is reading order is tab order, so nothing is reordered by CSS.
 *
 * **No frame.** One rule states the block's extent, and it is amber only when a
 * person is the thing being waited on, because that is the only thing amber
 * means in this palette (layout notes). Every divider inside is neutral.
 *
 * **A queued item gets the same block, and only the state differs** (#113).
 * Where a block has an age this has a place in line; where it has a question
 * this has what is stopping it; where it ends in Send it ends in Run it now.
 * The one thing it does not have is a `since` — nothing in the log has ever
 * moved a ticket that has never run — and it says *never run* instead of
 * stamping the render clock on a ticket that has sat open for a week.
 */
export function Standing({
  standing,
  project,
  issue,
  taskId,
  discussions,
  outgoing,
  queued,
  unknown,
}: {
  standing: StandingView;
  /** From the ticket, and null when the id is not a work item — nothing can be decided then. */
  project: string | null;
  issue: number | null;
  taskId: string;
  discussions: DiscussionView[];
  /** What the next attempt will be handed. Null when there will not be one. */
  outgoing: OutgoingView | null;
  /** Where it is in line and what taking it runs. Null in every other state. */
  queued: QueuedView | null;
  /**
   * Why Lingtai cannot say whether this ticket exists at all, when it cannot.
   *
   * The half of #113 that is not a page: a GitHub that will not answer about an
   * item the log has never touched is *"I cannot tell"*, and it used to be a
   * 404 — which says *"it does not exist"*, which is a different sentence and
   * is not one Lingtai is in a position to say.
   */
  unknown?: string | null;
}) {
  const held = describeHold(standing);
  const acting = project !== null && issue !== null;
  // What is stopping it and where it is in line — two facts, and the second is
  // not an annotation on the first. `holding` is null for the item that is
  // simply next, which is the answer rather than an omission.
  const stopped = queued === null ? null : holding(queued);
  const inLine = queued === null ? null : place(queued);
  // There is a document to send exactly when there is one to show. `problem` is
  // the case #76 is about — an unregistered project, a template that is not
  // there — and a Send on a prompt nobody could compose would send whatever the
  // conductor composes later, unseen, which is the opposite of this column.
  const sendable = outgoing !== null && outgoing.problem === null ? outgoing.attempt : null;

  // **Amber wins over teal, and that ordering is the whole rule.** If somebody
  // is being waited on, that is what this page exists to say, whatever else is
  // also true — a run that is mid-flight while an approval sits unanswered is
  // still your move. `live` only ever paints when nothing is on you.
  const mark = standing.onYou ? " onyou" : standing.state === "running" ? " live" : "";

  return (
    <section className={`standing${mark}`}>
      {/* The readout. Two values at one weight, and the age is `inWords` — the
          same arithmetic and the same words the card uses for the same
          question, so `4h 12m` means there as it does here. */}
      <p className="sread">
        <span className="sstate">{standing.state}</span>
        {/* The age, where there is one. Null is a ticket nothing in the log has
            ever moved, and the render clock is not an answer for it — the card
            refuses the same substitution for the same reason (#113). */}
        {standing.since !== null ? (
          <span className="sage" title={standing.since}>
            {inWords(Date.now() - Date.parse(standing.since))}
          </span>
        ) : null}
        {/* Where it is in line, at the same weight. On a queued item this is
            the second value the age is everywhere else: *queued* and *queued,
            fourteenth* are different situations. */}
        {inLine !== null ? <span className="sage">{inLine}</span> : null}
      </p>

      <p className="ssince">
        <span>
          {/* Said in as many words. An item with no attempts is not a stalled
              one, and the absence of a run is exactly what the page could not
              show before it could be opened at all. */}
          {standing.attempts === 0 ? "never run · " : ""}
          {standing.who}
          {standing.since !== null
            ? ` · since ${standing.since.slice(0, 10)} ${standing.since.slice(11, 16)} UTC`
            : ""}
          {/* Whose fact this is. `queued` is the one state that is not in the
              log, so a page that stated it without saying where it came from
              would be claiming a fold it did not make (0012). */}
          {queued !== null && queued.problem === null && queued.notOffered === null
            ? " · offered by GitHub"
            : ""}
        </span>
        {/* Which attempt produced it. `of N` because the number alone reads as
            the whole story on an item that has had three (#102). */}
        {standing.attempt !== null ? (
          <span className="sfrom" title={standing.runId ?? undefined}>
            from attempt {standing.attempt} of {standing.attempts}
            {standing.runId ? ` · ${standing.runId.slice(0, 12)}` : ""}
          </span>
        ) : null}
      </p>

      {/* The question, the diagnosis and the pointer sit under one neutral
          rule. Nothing below it is amber: the rule at the left already says a
          person is being waited on, and a second amber would dilute it. */}
      {standing.question !== null ||
      held.length > 0 ||
      standing.deciding !== null ||
      stopped !== null ||
      unknown ||
      queued?.problem ? (
        <div className="sbody">
          {/* The sentence a 404 was standing in for. Lingtai has nothing on this
              stream *and* could not ask GitHub, so what it knows is that it does
              not know — which is not the same claim as "there is no such
              ticket", and is the whole of #113's first requirement. */}
          {unknown ? (
            <p className="refusal">
              Lingtai has never touched this ticket and GitHub could not be asked, so whether it
              exists is not known here: {unknown}
            </p>
          ) : null}

          {/* Why it is not moving, in the wording `lingtai status` and the card
              use for the same hold. Null — and absent — for the item that is
              simply next, because `runnable now` on every ordinary queued item
              would bury the two that mean something. */}
          {stopped !== null ? <p className="squestion">{stopped}</p> : null}

          {/* Never merely absent (#76). A recipe that will not parse and a
              GitHub behind a rate limit both leave the queue unanswered, and
              only the reason tells them apart — the same argument the Queued
              column's own `problems` make. */}
          {queued?.problem ? (
            <p className="refusal">Its place in the queue could not be read: {queued.problem}</p>
          ) : null}

          {/* Verbatim. It is what the conductor wrote down, and a page that
              paraphrases it is a second version of the question. */}
          {standing.question !== null ? <p className="squestion">{standing.question}</p> : null}

          {/* Absent until #83 writes one, which is every block on the log
              today. The weights are the card's: what happened is ink, what was
              already done is muted, the recommendation carries the signal the
              primary button is the end of. */}
          {held.map((line) => (
            <p key={line.part} className={HELD_CLASS[line.part]}>
              {line.text}
            </p>
          ))}

          {standing.deciding !== null ? (
            <p className="sevidence">
              <span className="sgate">{standing.deciding.source}</span>
              <span className="sline">{standing.deciding.line}</span>
              {/* The whole of it is down there, marked and open. */}
              <a className="sptr" href={`#attempt-${standing.deciding.attempt}`}>
                in attempt {standing.deciding.attempt} ↓
              </a>
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Side by side above ~64rem, and stacked below it. The outgoing prompt
          first in the DOM and first on the line, so reading order, use order
          and tab order are one order — the column was a single stack wasting a
          third of a 1440 viewport (#111). The two boxes are the two objects the
          layout notes allow a frame around, which is why these two are the pair
          and nothing else joins them. */}
      <div className="spair">
        {/* The document that will actually run, above the buttons that send it.
            Only where there is a next attempt to be handed one — a run in
            flight has already been given its prompt (`loadTask`). */}
        {outgoing !== null ? (
          <Outgoing
            taskId={taskId}
            outgoing={outgoing}
            // The editor offers Send only where the row below it does. A
            // sentence typed and not staged is otherwise lost to the click that
            // was meant to send it.
            sendable={acting && standing.state === "blocked" && sendable !== null}
          />
        ) : null}

        {/* What the button does, beside the document it sends. Only on a queued
            item: every other state is describing a run that has already been
            given its plan, and its verdicts are in its own attempt. */}
        {queued !== null ? <Plan plan={queued.plan} /> : null}

        {/* Offered whatever the state, deliberately. The commonest question is
            about something that has stopped, but "what did attempt 1 actually
            change" is asked of a landed item too, and a box that appeared only
            on a blocked card would be one more thing to find out about. */}
        <Discussion taskId={taskId} attempt={standing.attempt} discussions={discussions} />
      </div>

      {/* The moves, under both boxes rather than inside either: the design's own
          row, and the end of the one sentence this column is.

          Every move that can work, and no move that cannot. The card's reading
          (#84, #92): a question is open exactly when there is a sha it is about,
          so Approve, Reject and Waive are offered there and nowhere — an item
          whose approved merge hit a conflict has none of them. Send is offered
          wherever there is a composed prompt to send, which is the case the
          column exists for and the one that had no button at all (#111). */}
      {acting && standing.state === "blocked" ? (
        <div className="smoves">
          {standing.awaitingSha !== null ? (
            <Decide
              project={project}
              issue={issue}
              onSha={standing.awaitingSha}
              headSha={standing.headSha ?? ""}
              gates={standing.failed}
              recommended={standing.diagnosis?.recommendation?.action ?? null}
            />
          ) : null}

          {sendable !== null ? (
            <Send
              taskId={taskId}
              attempt={sendable}
              // Amber once per screen. Send carries it where there is no
              // Approve beside it — sending is then the only move that moves
              // anything, whatever a diagnosis written before #83 recommends —
              // and otherwise only when the recommendation points here.
              primary={
                standing.awaitingSha === null ||
                standing.diagnosis?.recommendation?.action === "requeue"
              }
            />
          ) : null}

          {/* The fallback, for the one case that has neither: no approval open
              and no prompt anybody could compose. Putting it back in the queue
              is then the only move there is, and it keeps asking why — the
              reason Send does not is that Send's reason is the document, and
              this has none. */}
          {standing.awaitingSha === null && sendable === null ? (
            <Requeue
              project={project}
              issue={issue}
              recommended={standing.diagnosis?.recommendation?.action ?? null}
            />
          ) : null}
        </div>
      ) : null}

      {/* The queued item's own row, and it has exactly one move. `lingtai now`
          was the only control this state ever had and it lived in a terminal;
          the page that says why the item is not moving is the page the button
          belongs on. It jumps the backoff, and says so when there is one to
          jump (0028 §3). */}
      {acting && standing.state === "queued" && queued !== null ? (
        <div className="smoves">
          <RunNow project={project} issue={String(issue)} holding={stopped} />
        </div>
      ) : null}
    </section>
  );
}

/** The card's weights, said once there and read here. See `page.tsx`'s `HELD_CLASS`. */
const HELD_CLASS: Record<HoldLine["part"], string> = {
  needs: "needs",
  what: "diag",
  did: "did",
  rec: "rec",
};
