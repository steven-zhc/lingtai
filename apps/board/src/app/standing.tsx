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
import { FollowedLog } from "./run-log.tsx";

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
 * **The ranks: state · why · so what · moves · pair** (#132, #152). The block
 * used to run the other way — six lines in three sizes and three greys, the
 * further down you read the more specific it got while the type got smaller,
 * and `run-5cb24ac5` in two of them. So the state is the readout, *why it
 * stopped* is second and quoted from whatever refused, *what that means for the
 * decision* is third, the moves are fourth and the pair is fifth. Every
 * identifier is in the bar (`Coords`), once.
 *
 * **Rank 3 is one sentence, and `soWhat` is the only thing that fills it**
 * (#152). It was a paragraph assembled from four tickets — the round count,
 * the decline (#142), the restart refusal (0040) — each sentence true when it
 * was added and nobody holding the whole, so the reader composed the answer out
 * of them. What those sentences said is in the record's attempts row.
 *
 * **The state chooses what fills rank 2** (#152). For a blocked item it is the
 * refusal. For a running item *what it is doing* is the whole answer, so rank 2
 * is that run's live log — same slot, same size, teal. It used to be filed as
 * an attachment on an attempt row, so the one state it answers had to already
 * know it was there: *"if it is running I can never find where to attach to the
 * agent log."*
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
 * it is shown here — beside the discussion, under the buttons that send it, and editable. That is
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
 * **Those two sit side by side above ~64rem**, the prompt first, and **the
 * moves above both** (#152). One stack left a third of a 1440 viewport empty
 * and put the discussion below the fold of the thing it is a conversation
 * about; under the pair, a pane that grew pushed the button you were deciding
 * with off the screen, and above it nothing the pair does can move them. DOM
 * order is reading order is tab order, so nothing is reordered by CSS.
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
  //
  // **And not on a question asked before any run** (#147): what that block wants
  // is an answer, and sending would put it back in the queue unanswered — the
  // server refuses it, and a row offering only that would be #84 again.
  const sendable =
    outgoing !== null && outgoing.problem === null && !standing.asked ? outgoing.attempt : null;

  // **Amber wins over teal, and that ordering is the whole rule.** If somebody
  // is being waited on, that is what this page exists to say, whatever else is
  // also true — a run that is mid-flight while an approval sits unanswered is
  // still your move. `live` only ever paints when nothing is on you.
  const mark = standing.onYou ? " onyou" : standing.state === "running" ? " live" : "";

  // `describeHold` decides the words. *What happened* is the reason and reads
  // second; what is needed and what is recommended are `soWhat`'s one sentence,
  // and what was already done is the record's (#152).
  const what = held.find((line) => line.part === "what") ?? null;
  // The run whose log is rank 2, when the item is running. See the doc above.
  const following = standing.state === "running" ? standing.runId : null;

  /**
   * The refusal in the words of whatever refused, and who said them.
   *
   * `diagnosis.raw` used to be null on every hold a gate produced, on the
   * argument that the verdicts are on this page already — three ranks down, at
   * 0.72rem, behind a disclosure. The conductor now records the failing gate's
   * evidence there and this is where it is read (#132).
   *
   * The name is `saidBy`: the failed verdict whose own evidence is what was
   * quoted, and never merely the last of `failed`. A refusal that came from the
   * merge lane rather than from a gate is git's words, and a gate that failed
   * earlier on the same run did not say them — so the quote is unattributed
   * rather than mislabelled.
   *
   * Both are read off the *named* attempt — `saidBy` is one of that run's
   * failed verdicts and `diagnosis` is the hold written when it stopped — which
   * is why neither needs to say which attempt it came from and `deciding` does.
   */
  const raw = standing.diagnosis?.raw ?? null;
  const said = standing.saidBy?.replace(":", " / ") ?? null;

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
      <p className="sread" data-rank="state">
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

      {/* The reason and what it means, under one neutral rule. Always drawn:
          rank 3 has a sentence in every state, so there is no block with
          nothing under the readout. */}
      <div className="sbody">
        {/* ---- rank 2: why it stopped, or what it is doing ------------------ */}
        <div className="swhy" data-rank="why">
          {/* The run in flight, following (#152). The `RunLog` the attempt row
              had, moved and not changed — latched open, tailing, pinned to its
              last line — and told so by its class, which is the slot's size and
              the teal the running state already wears. It stays, no longer
              following, when the run ends under a reader: see `heldRun` — and
              goes under the lines below, which are its children so that it
              can, because the refusal is the answer then (`logBelow`). */}
          <FollowedLog running={following} className="alog slog">

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

          {/* Not a hold, so not in `holding`: the order above was not checked
              against a chain for this repository, or for the issues it names,
              and a place in line that does not say so reads as next (#131). */}
          {queued?.dependenciesUnread ? (
            <p className="refusal">{queued.dependenciesUnread}</p>
          ) : null}

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

          <Reason
            raw={raw}
            said={said}
            diagnosed={standing.diagnosis !== null}
            refused={standing.failed}
            deciding={standing.deciding}
            attempt={standing.attempt}
          />
          </FollowedLog>
        </div>

        {/* ---- rank 3: so what ---------------------------------------------- */}

        {/* One sentence in one element. `soWhat` returns a string, so there is
            no path by which a second paragraph lands here; a sentence a later
            ticket wants on this page goes to rank 2 or to the record, and the
            snapshots in `task-page.test.tsx` make it say which (#152). */}
        <p className="sowhat" data-rank="so-what">
          {soWhat(standing)}
        </p>
      </div>

      {/* ---- rank 4: the moves ---------------------------------------------- */}

      {/* Above both boxes rather than under them (#152). Under them, a
          discussion that grew pushed the button you were deciding with off the
          screen; above them, nothing that grows is before it.

          Every move that can work, and no move that cannot. The card's reading
          (#84, #92): a question is open exactly when there is a sha it is about,
          so Approve is offered there and nowhere — an item whose approved
          merge hit a conflict has none. Send is offered wherever there is a
          composed prompt to send, which is the case the column exists for and
          the one that had no button at all (#111). Reject and Waive are gone
          (#150): neither moved the card, and a waiver is what Approve records
          when a gate still refuses. */}
      {acting && standing.state === "blocked" ? (
        <div className="smoves" data-rank="moves">
          {standing.awaitingSha !== null ? (
            <Decide
              project={project}
              issue={issue}
              onSha={standing.awaitingSha}
              refusing={standing.failed.length > 0}
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
                standing.diagnosis?.recommendation?.action === "requeue" ||
                standing.diagnosis?.recommendation?.action === "reject"
              }
            />
          ) : null}

          {/* Wherever there is no prompt to send, whether or not an approval is
              open (#150): Send is this move with a document, and without one a
              card asking for approval still needs *run it again* beside
              Approve. It keeps asking why — the reason Send does not is that
              Send's reason is the document, and this has none. */}
          {sendable === null ? (
            <Requeue
              project={project}
              issue={issue}
              asked={standing.asked}
              question={standing.askedQuestion}
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
        <div className="smoves" data-rank="moves">
          <RunNow project={project} issue={String(issue)} holding={stopped} />
        </div>
      ) : null}

      {/* ---- rank 5: the pair ----------------------------------------------- */}

      {/* Side by side above ~64rem, and stacked below it. The outgoing prompt
          first in the DOM and first on the line, so reading order, use order
          and tab order are one order — the column was a single stack wasting a
          third of a 1440 viewport (#111). The two boxes are the two objects the
          layout notes allow a frame around, which is why these two are the pair
          and nothing else joins them. */}
      <div className="spair" data-rank="pair">
        {/* The document that will actually run, beside the discussion and under
            the buttons that send it. Only where there is a next attempt to be
            handed one — a run in flight has already been given its prompt
            (`loadTask`). */}
        {outgoing !== null ? (
          <Outgoing
            taskId={taskId}
            outgoing={outgoing}
            // The editor offers Send only where the row above it does. A
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
            on a blocked card would be one more thing to find out about.

            `quiet` while it runs: nobody is waiting on you while the machine
            works, so nothing in the box wears the brass either (#152). */}
        <Discussion
          taskId={taskId}
          attempt={standing.attempt}
          discussions={discussions}
          quiet={standing.state === "running"}
        />
      </div>
    </section>
  );
}

/**
 * Rank 3: what the quote means for the decision, in one sentence.
 *
 * **A string, so it cannot be a paragraph** (#152). What it replaces was
 * `describeHold`'s lines printed one after another — *your judgement is
 * needed*, then the fix rounds and the decline (#142), then the recommendation
 * with the restart refusal (0040) inside its why — which were four tickets'
 * sentences and nobody's one. So: who is needed, and the move the diagnosis
 * recommends with the first clause of its reason, and it stops. What was done,
 * and the rest of the why, are in the record's attempts row.
 *
 * The needs wording is `describeHold`'s, so this page, the card and `lingtai
 * status` still say the same thing about the same hold. A state with nothing
 * needed of anybody says who is being waited on instead, which is the fact a
 * running or a queued item's reader came for.
 */
export function soWhat(standing: StandingView): string {
  const needed =
    standing.needs === null
      ? null
      : (describeHold({ needs: standing.needs, diagnosis: null })[0]?.text ?? null);
  const head = needed ?? standing.who;
  const rec = standing.diagnosis?.recommendation ?? null;
  if (rec === null) return head;
  const why = firstClause(rec.why);
  return why === "" ? `${head} — recommends ${rec.action}` : `${head} — recommends ${rec.action}, because ${why}`;
}

/** How long rank 3's reason may run before it is clipped. The whole is in the record. */
const CLAUSE_MAX = 160;

/**
 * The first sentence of a recommendation's why, flattened to one line.
 *
 * Whitespace and newlines collapse, the first sentence end is the end, and a
 * sentence that is still a paragraph by length is clipped — the same trade
 * `oneLine` makes for the question, for the same reason.
 */
function firstClause(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  let clause = (end === -1 ? flat : flat.slice(0, end)).replace(/[\s.;:,—-]+$/, "");
  // `Develop has moved` reads as a new sentence after *because*; `CONFLICT`
  // and `PR` are words that stay as written.
  if (/^[A-Z][a-z]/.test(clause)) clause = clause[0]!.toLowerCase() + clause.slice(1);
  return clause.length > CLAUSE_MAX ? `${clause.slice(0, CLAUSE_MAX - 1)}…` : clause;
}

/**
 * Rank 8: every identifier the page has, each once, as one muted line in the
 * bar (#152).
 *
 * This was the block's own fourth rank, and the attempt row printed the same
 * run id again as a full uuid — `run-52feebd1` twice on one page. So the bar
 * says which item and which attempt, and the run id is that link's title; the
 * attempt row is where the id, the shas and the branch are printed, once.
 */
export function Coords({
  standing,
  taskId,
  queued,
}: {
  standing: StandingView;
  taskId: string;
  queued: QueuedView | null;
}) {
  return (
    <span className="coords" data-rank="coords">
      <span className="mono">{taskId}</span>
      {/* Said in as many words. An item with no attempts is not a stalled one,
          and the absence of a run is exactly what the page could not show
          before it could be opened at all. */}
      {standing.attempts === 0 ? <span>never run</span> : null}
      {standing.since !== null ? (
        <span>
          since {standing.since.slice(0, 10)} {standing.since.slice(11, 16)} UTC
        </span>
      ) : null}
      {/* Whose fact this is. `queued` is the one state that is not in the log,
          so a page that stated it without saying where it came from would be
          claiming a fold it did not make (0012). */}
      {queued !== null && queued.problem === null && queued.notOffered === null ? (
        <span>offered by GitHub</span>
      ) : null}
      {/* The coordinate is the pointer: which attempt produced this state, and
          the way down to it. `of N` because the number alone reads as the whole
          story on an item that has had three (#102). */}
      {standing.attempt !== null ? (
        <a className="sfrom sptr" href={`#attempt-${standing.attempt}`} title={standing.runId ?? undefined}>
          from attempt {standing.attempt} of {standing.attempts} ↓
        </a>
      ) : null}
    </span>
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
 * to be found. Following the coordinate at rank 4 is still how you get to the
 * findings and the diff that sit beside the verdict.
 *
 * **A diagnosis answers this rank, or nothing does.** `raw` is written by the
 * conductor beside `what` and is about *this* hold — but null there does not
 * mean nothing refused. `diagnoseUnfixed` writes null for a command that printed
 * nothing, `diagnoseDisagreement` for a reviewer that recorded no findings, and
 * every gate hold written before #132 carries null too. So whether anything
 * refused is `refused` — the named attempt's verdicts that still stand failed —
 * and only when that is empty (every gate passed, or a gate asked for a person)
 * is the honest rendering no rank at all. `deciding` is the older, weaker thing
 * and it is a *search*: `decidingOf` walks back through earlier attempts, so on
 * a block whose own gates passed it can hold attempt 1's build failure. Printed
 * under *every gate passed* with the pointer that used to attribute it moved
 * away, that reads as this block's reason and is not one. So it appears only
 * where there is no diagnosis to displace it — every block written before #83 —
 * and it says which attempt it came from whenever that is not the attempt rank
 * 4 already names.
 *
 * Three states where there is a diagnosis, and the middle one is 0016 §4:
 *
 * - **evidence**, which is quoted;
 * - **a refusal with nothing quoted** — an empty string, or null beside a
 *   failed verdict — which is stated: this attempt's own deciding line where
 *   there is one, and the absence in words where there is not, because a blank
 *   rank looks exactly like a rank that failed to render and only one of those
 *   is our bug;
 * - **nothing that refused at all**, which is no rank and no hole.
 */
function Reason({
  raw,
  said,
  diagnosed,
  refused,
  deciding,
  attempt,
}: {
  /** `diagnosis.raw`: the failing gate's evidence, verbatim. */
  raw: string | null;
  /** The gate that said it, or null when what refused was not a gate. */
  said: string | null;
  /** Whether the hold carries a diagnosis at all. See above: it decides the rank. */
  diagnosed: boolean;
  /** The named attempt's verdicts that stand failed, by `point:action`. */
  refused: readonly string[];
  deciding: StandingView["deciding"];
  /** The attempt rank 4 names, so this rank names one only when it differs. */
  attempt: number | null;
}) {
  if (!diagnosed) {
    // The block as it was before #83, and the one deciding line is all it has
    // ever had here. Attributed, because it may be an earlier attempt's.
    if (deciding === null) return null;
    return (
      <p className="sevidence">
        <span className="sgate">{deciding.source}</span>
        <span className="sline">{deciding.line}</span>
        {deciding.attempt !== attempt ? (
          <a className="sptr" href={`#attempt-${deciding.attempt}`}>
            in attempt {deciding.attempt} ↓
          </a>
        ) : null}
      </p>
    );
  }

  if (raw === null) {
    // Nothing refused: `what` has already said so in a sentence, and a quote of
    // something else under it would be a cause this hold does not have.
    if (refused.length === 0) return null;

    // Something did, and the diagnosis quoted none of it. This attempt's own
    // deciding line is that refusal — `decidingOf` takes the named attempt's
    // first, and it has a failed verdict — so it is this hold's and needs no
    // pointer beside the coordinate rank 4 already is.
    if (deciding !== null && deciding.attempt === attempt) {
      return (
        <p className="sevidence">
          <span className="sgate">{deciding.source}</span>
          <span className="sline">{deciding.line}</span>
        </p>
      );
    }
    const gate = refused.at(-1)!.replace(":", " / ");
    return (
      <p className="sevidence snone">
        The {gate} gate refused, and nothing it said was recorded here to quote.
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
