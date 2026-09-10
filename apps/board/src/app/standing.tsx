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
 * **Four ranks: state · reason · move · coordinates** (#132). The block used to
 * run the other way — six lines in three sizes and three greys, the further
 * down you read the more specific it got while the type got smaller, and
 * `run-5cb24ac5` in two of them. So the state is the readout, *why it stopped*
 * is second and quoted from whatever refused, *what to do* is third, and every
 * identifier is fourth and appears once.
 *
 * **The reason is the gate's own words, and the pointer is what stayed a
 * pointer.** Design §2 said the evidence is a pointer and not a copy, and the
 * block took that to mean a gate's *name* was enough: on `#121` it said *the
 * review gate refused it* when the reviewer had never run — the guard hook
 * refused its opening prompt, and the gate's evidence said so exactly, three
 * ranks down behind a disclosure. `diagnosis.raw` now carries that evidence and
 * `Reason` quotes it here, open. What is still a pointer is the *attempt*: its
 * findings, its diff and its other verdicts are down there and are not copied
 * up.
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

  // **The four ranks** (#132). `describeHold` decides the words; this decides
  // which rank each of them is. *What happened* is the reason and reads second;
  // everything else it returns — what is needed, what was already done, what is
  // recommended — is about the move and reads third.
  const what = held.find((line) => line.part === "what") ?? null;
  const move = held.filter((line) => line.part !== "what");

  /**
   * The refusal in the words of whatever refused, and who said them.
   *
   * `diagnosis.raw` used to be null on every hold a gate produced, on the
   * argument that the verdicts are on this page already — three ranks down, at
   * 0.72rem, behind a disclosure. The conductor now records the failing gate's
   * evidence there and this is where it is read (#132).
   *
   * The name comes from `failed`, which is the list Waive already names a gate
   * from, so the name on the quote and the name on the button cannot disagree.
   * A refusal that came from the merge lane rather than from a gate has no
   * verdict to name, and the quote is unattributed rather than mislabelled.
   */
  const raw = standing.diagnosis?.raw ?? null;
  const said = standing.failed.at(-1)?.replace(":", " / ") ?? null;

  /**
   * The question, only where nothing better was written down.
   *
   * `question`, `what` and `done` were three sentences saying overlapping
   * things, and the question is the weakest of them — it is a gate's name and a
   * branch, both of which the ranks below say once each. So a diagnosed block
   * drops it, and a block with no diagnosis renders exactly as it always has,
   * which is #83's requirement and every block written before it.
   *
   * Nothing is lost: `WorkItemBlocked.question` is verbatim in the history row
   * for the event that carries it.
   */
  const question = standing.diagnosis === null ? standing.question : null;

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

      {/* The reason and the move, under one neutral rule. Nothing here is
          amber: the rule at the left already says a person is being waited on,
          and a second amber would dilute it. */}
      {question !== null ||
      held.length > 0 ||
      standing.deciding !== null ||
      stopped !== null ||
      unknown ||
      queued?.problem ? (
        <div className="sbody">
          {/* ---- rank 2: why it stopped ------------------------------------ */}

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
              would bury the two that mean something. This is a queued item's
              whole second rank: it has no gate to quote (#113). */}
          {stopped !== null ? <p className="squestion">{stopped}</p> : null}

          {/* Never merely absent (#76). A recipe that will not parse and a
              GitHub behind a rate limit both leave the queue unanswered, and
              only the reason tells them apart — the same argument the Queued
              column's own `problems` make. */}
          {queued?.problem ? (
            <p className="refusal">Its place in the queue could not be read: {queued.problem}</p>
          ) : null}

          {/* Verbatim, and only where nothing better was written down — see
              `question` above. It is what the conductor wrote, and a page that
              paraphrases it is a second version of the question. */}
          {question !== null ? <p className="squestion">{question}</p> : null}

          {/* What happened, in the diagnosis' own sentence. Absent until #83
              writes one, which is every block written before it. */}
          {what !== null ? <p className={HELD_CLASS[what.part]}>{what.text}</p> : null}

          <Reason raw={raw} said={said} deciding={standing.deciding} />

          {/* ---- rank 3: what to do about it ------------------------------- */}

          {/* What is needed, what was already done, and what is recommended.
              The weights are the card's: what was already done is muted, and
              the recommendation carries the signal the primary button is the
              end of. */}
          {move.map((line) => (
            <p key={line.part} className={HELD_CLASS[line.part]}>
              {line.text}
            </p>
          ))}

        </div>
      ) : null}

      {/* ---- rank 4: where to look ---------------------------------------- */}

      {/* Every identifier the block has, and each of them once. This used to be
          the second line, in a size that made *waiting on you* and *since 07:46
          UTC* read as the answer — the answer is above it now, and a run id is
          a coordinate (#132). */}
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
        {/* The way down to the whole of it — that attempt's gate points, its
            findings and its diff. A pointer and never a copy: what the gate
            said is quoted once, above. */}
        {standing.deciding !== null ? (
          <a className="sptr" href={`#attempt-${standing.deciding.attempt}`}>
            in attempt {standing.deciding.attempt} ↓
          </a>
        ) : null}
      </p>

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

/**
 * The second rank: what refused, in its own words.
 *
 * **A gate's name is not a reason** (#132). *the review gate refused it* is
 * every word true and a reader takes the wrong thing from it — that a reviewer
 * read the diff and found problems. On `#121` the reviewer never ran, the guard
 * hook refused its opening prompt, and the gate's own evidence said so exactly.
 * That evidence was on this page the whole time: three ranks down, at 0.72rem,
 * behind a disclosure, inside the right attempt's gate points.
 *
 * **It opens in place.** The disclosure is open on load and closing it is the
 * reader's own move — the whole judgement behind this ticket is that what the
 * page already has must appear at the moment it is needed rather than waiting
 * to be found. Following the pointer to the attempt is still there, at rank 4,
 * for the findings and the diff that sit beside the verdict.
 *
 * Three states, and the middle one is the one 0016 §4 is about:
 *
 * - **evidence**, which is quoted;
 * - **a gate that refused and recorded nothing** — an empty string — which is
 *   stated, because a blank rank looks exactly like a rank that failed to
 *   render and only one of those is our bug;
 * - **nothing that refused at all** — every gate passed, or a block written
 *   before there was a `raw` to carry — which renders the deciding line if
 *   there is one and leaves no hole where a quote would be.
 */
function Reason({
  raw,
  said,
  deciding,
}: {
  /** `diagnosis.raw`: the failing gate's evidence, verbatim. */
  raw: string | null;
  /** The gate that said it, or null when what refused was not a gate. */
  said: string | null;
  deciding: StandingView["deciding"];
}) {
  if (raw === null) {
    // No quote to make. The one deciding line is what the block has always had
    // here, and it is still better than nothing — its pointer has moved down to
    // the coordinates, so this is a line and no longer a signpost.
    if (deciding === null) return null;
    return (
      <p className="sevidence">
        <span className="sgate">{deciding.source}</span>
        <span className="sline">{deciding.line}</span>
      </p>
    );
  }

  if (raw.trim() === "") {
    return (
      <p className="sevidence snone">
        {said === null ? "The refusal" : `The ${said} gate`} recorded no output, so there is
        nothing to quote.
      </p>
    );
  }

  const lines = raw.split("\n").length;
  return (
    <details className="sreason" open>
      <summary>
        <span className="sgate">{said ?? "what refused, verbatim"}</span>
        <span className="ssize">
          {lines} line{lines === 1 ? "" : "s"}
        </span>
      </summary>
      {/* Never markdown, and never a paragraph: design §6's third row and
          #111's, one page along. A log rendered as prose is not that log. */}
      <pre className="sraw">{raw}</pre>
    </details>
  );
}
