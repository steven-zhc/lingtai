import { Fragment } from "react";
import Link from "next/link";
import {
  emptyNote,
  groupQueue,
  issueUrl,
  loadBoard,
  spend,
  type BoardCard,
  LANDED_OPEN,
} from "@/lib/board";
import { kindDot } from "@/lib/kind-colour";
import { AGENT, elapsed, type RunProgress } from "@/lib/progress";
// The subpath, for the reason `board.ts` gives: the barrel pulls the gate
// pipeline in behind it. `describeHold` is pure and lives beside the field it
// reads, so the card and `lingtai status` say the same thing about a hold.
import { describeHold, type HoldLine } from "@lingtai/projector/task-view";
import { loadProjects } from "@lingtai/conductor/projects";
import { inWords } from "@lingtai/conductor/queue";
// The subpath, not the barrel: the board reads the control stream and hosts
// no work, and `@lingtai/daemon` would drag the work loop and the runtime in
// behind it — the same reason the actions import `@lingtai/conductor/decide`.
import { readControl } from "@lingtai/daemon/control";
import { Decide, Requeue } from "./decide.tsx";
import { Draining } from "./draining.tsx";
import { Live } from "./live.tsx";
import { Paused } from "./paused.tsx";
import { Stale } from "./stale.tsx";

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
 *
 * **Weight follows attention, and it used not to.** Landed rendered a card each
 * and was the heaviest thing on the page while one waiting card took about a
 * twelfth of the ink; the bar led with `11 items`, a sum of four columns that
 * mean different things and that nobody acts on (#81). So history is one line
 * per item and folds away past the most recent few, the room that frees goes to
 * the lanes where something is happening, and the bar leads with the two numbers
 * an operator does act on: how many need a person, and what this has cost.
 * None of that changes what a card *means* — that is #78 and #79.
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

/**
 * Which pill a point's state wears. The card's existing vocabulary, reused:
 * a person's word (`waived`) is the held colour and never the green one, the
 * same distinction the counts below make.
 */
const POINT_TONE: Record<string, string> = {
  passed: "pass",
  failed: "fail",
  running: "run",
  waived: "hold",
  pending: "",
  skipped: "skip",
};

/**
 * Where the run is *now*, under the counts that say where it has been.
 *
 * The phase first — what is executing this second, and how far into whatever
 * bounds it — then all five points, so a point the recipe configured is visible
 * before it runs and a point nobody configured reads as `skipped` rather than
 * as an absence (0016 §4).
 *
 * The clock is the server's, read at render. That is exactly as current as
 * everything else on the page: an append re-renders the route (`live.tsx`), and
 * a run appends steadily enough that this moves on its own.
 */
function Now({ progress }: { progress: RunProgress }) {
  const now = progress.now;
  return (
    <ul className="meta">
      {now ? (
        <li
          className="pill run"
          title={
            now.budgetMs === null
              ? `${now.label} since ${now.since}; nothing puts a clock on it`
              : `${now.label} since ${now.since}, out of ${inWords(now.budgetMs)}`
          }
        >
          {/* The denominator is what separates *slow* from *about to be
              killed*, and it is absent rather than invented where nothing
              bounds the phase — an approval waits on a person, and a person has
              no timeout. */}
          {now.label === AGENT ? "agent" : now.label}{" "}
          {elapsed(Date.now() - Date.parse(now.since))}
          {now.budgetMs === null ? "" : ` / ${inWords(now.budgetMs)}`}
        </li>
      ) : (
        <li className="pill" title="the agent has finished and no point has started yet">
          between points
        </li>
      )}
      {/* All five, always. A point that is merely omitted is indistinguishable
          from one that was configured and silently did not run, and only the
          second of those is Lingtai's bug (0016 §4). */}
      {progress.points.map((p) => (
        <li
          key={p.point}
          className={`pill ${POINT_TONE[p.state] ?? ""}`}
          title={
            p.planned.length === 0
              ? `${p.point}: nothing configured, so nothing runs`
              : `${p.point}: ${p.planned.join(", ")} — ${p.state}`
          }
        >
          {p.point}
        </li>
      ))}
    </ul>
  );
}

/**
 * The reference, as the other destination.
 *
 * The title opens `/task/<id>` — what Lingtai did — and that is right. The
 * number beside it went nowhere at all (#81), and the issue is the other thing
 * you want from a card: what was asked, and what people have said since. Two
 * destinations, both reachable, neither one guessing which you meant.
 *
 * Plain text where the project predates `owner` being recorded. There is no
 * link to build then, and a dead one is worse than none.
 */
function IssueRef({ href, issue }: { href: string | null; issue: string }) {
  if (href === null) return <>#{issue}</>;
  return (
    <a className="iss" href={href} target="_blank" rel="noreferrer" title="the issue on GitHub">
      #{issue}
    </a>
  );
}

/**
 * The kind, in the repository's own colour, as a dot.
 *
 * **A dot and not a pill.** GitHub's default `bug` is `#d73a4a` and this
 * board's `--fail` is `#a33029`; a filled pill in a repository's own colour
 * would read as *this one failed*, which is a verdict, and the palette's rule
 * is that a verdict never reads as decoration (`globals.css:1`). A small mark
 * beside the reference is visible and scannable and cannot be mistaken for one.
 *
 * Nothing is drawn when `kindDot` returns null — GitHub had no colour, or the
 * colour is amber, which the board reserves. The kind then renders as it did
 * before #85: grey text on the same line, and no dot to explain.
 */
function KindDot({ card }: { card: BoardCard }) {
  const colour = kindDot(card.kindColor);
  if (colour === null) return null;
  // `aria-hidden`, because the kind is written out in the words beside it: the
  // dot is a second encoding of a fact already said, which is what makes it
  // safe to have no meaning of its own to a reader who cannot see it.
  return (
    <span
      className="kdot"
      style={{ background: colour }}
      title={`${card.kind}, in the colour ${card.project} gives that label`}
      aria-hidden="true"
    />
  );
}

function Card({
  card,
  showProject,
  issue,
}: {
  card: BoardCard;
  showProject: boolean;
  issue: string | null;
}) {
  return (
    <article className={`card ${accent(card)}`}>
      {/* Reference and kind are one fact — which ticket — so they are one line.
          Split apart, the kind read as a status badge, which it is not. */}
      <span className="id">
        {/* Only when the board holds more than one project. With a single
            project the bar already says which, and repeating it on every card
            is noise. */}
        {/* First on the line, before the project name, so the dots line up
            down a column whatever else a card carries — scanning by kind is
            the whole thing this is for (#85). */}
        <KindDot card={card} />
        {showProject ? <span className="proj">{card.project} </span> : null}
        <IssueRef href={issue} issue={card.ref} /> · {card.kind}
      </span>

      {/* The whole card title is the link. Anything smaller is a target you
          have to aim at, on the one control every card has. */}
      <Link className="ti" href={`/task/${encodeURIComponent(card.taskId)}`}>
        {card.title}
      </Link>

      <ul className="meta">
        {/* How long it has been where it is, in the lane's own word — because
            the number means a different thing in each: `waiting 3h` is a
            question nobody has answered, `landed 2d` is how stale the top of
            the column is (#79).

            A running card gets its run's elapsed instead, and not `updatedAt`,
            which for that one card is *the last time anything was appended*.
            Labelling that `running 12s` would say a run eight minutes in had
            just started — a plausible number, which is the worst kind.

            Absent on a card GitHub is offering that the log has never touched:
            there is no time for one, and the render clock is not it. */}
        {card.progress ? (
          <li className="pill run" title={`this run's first event was ${card.progress.since}`}>
            running {elapsed(Date.now() - Date.parse(card.progress.since))}
          </li>
        ) : card.updatedAt ? (
          <li className="pill" title={card.updatedAt}>
            {card.column} {inWords(Date.now() - Date.parse(card.updatedAt))}
          </li>
        ) : null}
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

      {/* Only where there is a run in flight to describe. Every other lane is
          describing something that is over, and the counts above are the whole
          truth about it — this is the one lane where they are not (#79). */}
      {card.progress ? <Now progress={card.progress} /> : null}

      {card.note ? <p className="question">{card.note}</p> : null}

      <Held card={card} />

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
          neither is an item anybody can hand back.

          `awaitingSha` and not `headSha`: a question is open exactly when there
          is a sha it is about, and that sha is the one the controls have to
          send. Sending what the run *produced* is what made the board refuse
          approvals the CLI accepted (#92). */}
      {card.blocked && card.awaitingSha ? (
        <Decide
          project={card.project}
          issue={Number(card.ref)}
          onSha={card.awaitingSha}
          headSha={card.headSha ?? ""}
          gates={card.gatesFailed > 0 ? ["build"] : []}
          recommended={card.diagnosis?.recommendation?.action ?? null}
        />
      ) : card.blocked ? (
        <Requeue
          project={card.project}
          issue={Number(card.ref)}
          recommended={card.diagnosis?.recommendation?.action ?? null}
        />
      ) : null}
    </article>
  );
}

/**
 * What is known about a hold, beyond the question.
 *
 * The question is rendered above this and is unchanged. Everything here is
 * absent on a block that carries only one — which is every block on the log at
 * the time #83 was written — so a card that has nothing to add reads exactly as
 * it did: the question, and the move it actually has.
 *
 * Order is what an operator does with it. Which *kind* of hold it is first,
 * because *a decision is yours* and *something failed and nobody has decided*
 * are opposite situations and the controls below mean different things in each.
 * Then what happened, then what was already done about it, then the
 * recommendation — which is also which button is primary (`decide.tsx`).
 *
 * The raw failure is last and collapsed, and it is not optional. A summary that
 * hides the git output is worse than the git output: the sentence is somebody's
 * reading of the failure, and the failure itself has to stay reachable from the
 * same card rather than only from the log.
 */
function Held({ card }: { card: BoardCard }) {
  // The sentences are `describeHold`'s, not this file's, so the card and
  // `lingtai status` cannot come to describe the same hold differently. What
  // this component decides is the weight each one is given.
  const lines = describeHold(card);
  const raw = card.diagnosis?.raw ?? null;
  if (lines.length === 0 && raw === null) return null;
  return (
    <div className="held">
      {lines.map((line) => (
        <p key={line.part} className={HELD_CLASS[line.part]}>
          {line.text}
        </p>
      ))}
      {raw !== null ? (
        <details>
          <summary>the failure, as it arrived</summary>
          <pre className="gevidence">{raw}</pre>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Which sentence gets which weight.
 *
 * `what` is ink because it is the answer; `did` is muted because it is context;
 * `rec` carries the signal colour because it is the sentence the primary button
 * is the end of. A card where all four shout says nothing.
 */
const HELD_CLASS: Record<HoldLine["part"], string> = {
  needs: "needs",
  what: "diag",
  did: "did",
  rec: "rec",
};

/**
 * One landed item, on one line.
 *
 * `#150 · enhancement · 25 turns · $1.46 · 2d` — the same facts a card carried,
 * at the weight finished work deserves. Nothing here is a new claim: the
 * numbers, their words and their absences are the card's (#78, #79), and only
 * the ink they take has changed.
 *
 * The title is not on the row and is on its hover, which is the one real cost
 * of the density. Both destinations survive it: the number goes to GitHub and
 * the rest of the line goes to the task page, so a landed item is still opened
 * from where it is listed.
 */
function LandedRow({
  card,
  showProject,
  issue,
}: {
  card: BoardCard;
  showProject: boolean;
  issue: string | null;
}) {
  const said = [
    card.kind,
    card.turns === null ? null : `${card.turns} turns`,
    card.costUsd === null ? null : `$${card.costUsd.toFixed(2)}`,
    // The lane's own word is on the card; here the column heading is already
    // saying "landed", so the row says only how long ago (#79).
    card.updatedAt === null ? null : inWords(Date.now() - Date.parse(card.updatedAt)),
  ].filter((s): s is string => s !== null);

  return (
    <li className="lrow">
      {showProject ? <span className="proj">{card.project}</span> : null}
      <IssueRef href={issue} issue={card.ref} />
      <Link
        className="lmeta"
        href={`/task/${encodeURIComponent(card.taskId)}`}
        title={card.title}
      >
        · {said.join(" · ")}
      </Link>
    </li>
  );
}

/**
 * Landed, in full: the most recent few, and a disclosure over the rest.
 *
 * Collapsed rather than truncated. What has landed is the record this system
 * exists to keep and dropping it off the page would be a different kind of lie
 * than showing too much of it — the trade every `details` on the board already
 * makes.
 */
function Landed({
  cards,
  showProject,
  issue,
}: {
  cards: BoardCard[];
  showProject: boolean;
  issue: (card: BoardCard) => string | null;
}) {
  const rows = (some: BoardCard[]) => (
    <ul className="landed">
      {some.map((c) => (
        <LandedRow key={c.taskId} card={c} showProject={showProject} issue={issue(c)} />
      ))}
    </ul>
  );
  const older = cards.slice(LANDED_OPEN);

  return (
    <>
      {rows(cards.slice(0, LANDED_OPEN))}
      {older.length > 0 ? (
        <details className="older">
          <summary>{older.length} older</summary>
          {rows(older)}
        </details>
      ) : null}
    </>
  );
}

/**
 * Queued, grouped by kind, in the order the recipe takes them.
 *
 * **Order beats colour here, and it is the only column where that is true.**
 * `source.kinds` is a priority order — earlier wins — so in this column the
 * kind *is* the position, and a heading that says which group is taken next
 * carries what a hue cannot: it tells you what happens, not what a card is.
 * A person had to know that `source.kinds` was ordered to read any of it.
 *
 * The grouping is `groupQueue`'s, not this component's, so the column and
 * `selectRunnable` cannot come to disagree about which ticket is first.
 */
function Queued({
  cards,
  order,
  showProject,
  issue,
}: {
  cards: BoardCard[];
  order: string[];
  showProject: boolean;
  issue: (card: BoardCard) => string | null;
}) {
  return (
    <>
      {groupQueue(cards, order).map((group) => (
        <Fragment key={group.kind}>
          {/* Not amber, and not any of the state colours. "This is taken first"
              is a fact about the queue's order, not about a person being
              waited on — the one thing amber is allowed to mean. */}
          <p className="qgroup">
            {group.kind}
            {group.next ? <span className="qnext"> — taken first</span> : null}
          </p>
          {group.cards.map((card) => (
            <Card key={card.taskId} card={card} showProject={showProject} issue={issue(card)} />
          ))}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The board, optionally narrowed to one project.
 *
 * `loadBoard` has taken a project since it was written and the bar rendered the
 * names as static text anyway (#81). Two projects is bearable — the cards carry
 * their own project name — and four is not, so the names in the bar are the
 * control that does it.
 *
 * **The names are `loadBoard`'s, not the register's.** A card can outlive its
 * project — which is why `onBoard` below is built from the cards rather than
 * from `loadProjects` — and a filter offering only currently registered
 * repositories would be the one control on the page that cannot reach that
 * card (#86). The list is the same whatever is selected, because the choice is
 * made from all of them every time.
 *
 * **The filter is in the URL, and that is what makes the live stream harmless.**
 * `live.tsx` asks for a re-render of *this route*, so an append from a project
 * you have filtered out re-reads the same narrowed board and reconciles to the
 * same markup. Held in component state it would instead have been thrown away
 * by the first event from the project you had just stopped looking at.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const only = (await searchParams).project;
  const { columns, repair, queueOrder, projects: filters } = await loadBoard(only);
  // The register, and only for the owners a ticket link is built from. Which
  // projects the bar can offer is `loadBoard`'s answer and not this one.
  const registered = await loadProjects().catch(() => []);
  // Not caught. A control read that fails would render as "nothing is paused",
  // which is the exact silence #77 is about; and it reads the same database
  // `loadBoard` just read, so it fails when the board fails and not otherwise.
  const control = await readControl();
  const total = columns.reduce((n, c) => n + c.cards.length, 0);
  // What the *cards* say, not what is registered: a card can outlive its
  // project, and it is the cards that have to be told apart.
  const onBoard = new Set(columns.flatMap((c) => c.cards.map((card) => card.project)));

  // The two numbers an operator acts on: how many need me, and what has this
  // cost. Neither was on the page (#81).
  const waiting = columns.find((c) => c.id === "waiting")?.cards.length ?? 0;
  const cost = spend(columns);
  // And the rest, which is what `11 items` was a sum of. Said as its parts,
  // because the parts mean different things and the sum meant nothing.
  const rest = columns
    .filter((c) => c.id !== "waiting" && c.cards.length > 0)
    .map((c) => `${c.cards.length} ${c.label.toLowerCase()}`)
    .join(" · ");

  // Where each card's ticket lives, from the owners already loaded — a lookup,
  // not a request per card.
  const owners = new Map(registered.map((p) => [p.project, p.owner]));
  const ticket = (card: BoardCard) => issueUrl(owners.get(card.project) ?? null, card.project, card.ref);

  return (
    <main>
      <div className="bar">
        {/* An empty span carrying a background, not an `<img>`: which file the
            mark is comes from `--mark`, so it follows the palette instead of
            being decided here. `aria-hidden` because the word beside it already
            says what it says. */}
        <span className="brand">
          <span className="mark" aria-hidden="true" />
          Lingtai
        </span>
        <span className="sep" />
        {/* A filter, not a caption. With one project there is nothing to choose
            between, so it stays the sentence it was. */}
        {filters.length === 0 ? (
          <span>no project configured</span>
        ) : filters.length === 1 ? (
          <span>{filters[0]}</span>
        ) : (
          <span className="filter">
            <Link className={`tab${only === undefined ? " on" : ""}`} href="/">
              all
            </Link>
            {filters.map((p) => (
              <Link
                key={p}
                className={`tab${only === p ? " on" : ""}`}
                href={`/?project=${encodeURIComponent(p)}`}
              >
                {p}
              </Link>
            ))}
          </span>
        )}
        <span className="sep" />
        {/* The headline, because it is the only column that is asking for a
            person. Amber for the same reason the lane is amber: it is reserved
            for "a human is the thing being waited on". */}
        <span
          className={`chip ${waiting > 0 ? "sig" : "idle"}`}
          title={
            waiting > 0
              ? "items that will not move until you decide"
              : "nothing on this board is blocked on a person"
          }
        >
          {waiting > 0 ? `${waiting} waiting on you` : "nothing waiting on you"}
        </span>
        <span className="sep" />
        {/* And what it has cost. The cards on this board, said plainly, because
            a total whose window is unstated is a total nobody can use. */}
        <span
          className="chip"
          title={`what the ${cost.cards} card(s) on this board cost — the visible cards, not a window over the log`}
        >
          ${cost.work.toFixed(2)}
        </span>
        {/* Apart from the work, the way the card keeps it apart: a repair is
            default-on and spends an agent without being asked again (#84). */}
        {cost.repair > 0 ? (
          <span className="chip sig" title="what diagnosing them cost, apart from the work">
            ${cost.repair.toFixed(2)} repair
          </span>
        ) : null}
        {/* Then the rest, last, and as its parts. `11 items` was the sum of
            four columns that mean different things, and adding them produced a
            number nobody could act on (#81). Nothing at all is still worth a
            word: an empty board and an unbuilt projection look alike. */}
        {total === 0 ? (
          <>
            <span className="sep" />
            {/* Under a filter, "the log" is not what is empty — it may be full
                of the project you are not looking at. The board says whose
                emptiness this is, the way the columns below do (#86). */}
            <span className="chip idle">
              {only === undefined ? "nothing in the log yet" : `nothing here for ${only}`}
            </span>
          </>
        ) : rest === "" ? null : (
          <>
            <span className="sep" />
            <span className="chip" title="everything that is not waiting on you">
              {rest}
            </span>
          </>
        )}
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
        {/* And whether it is on its way out, which is none of the above: a
            draining daemon is current, unpaused and finishing the last pass it
            will run (0030). Draws nothing when it is not. */}
        <Draining />
        {/* And a third fact, independent of both: whether the process that
            moves things is running the code we merged. A daemon holds its
            modules from the moment it started, so `current` and `not paused`
            were both true for thirty-nine minutes in which the fix that had
            landed could not run (#98). Draws nothing when it is level. */}
        <Stale />
      </div>

      <div className="cols">
        {columns.map((col) => (
          // `quiet` is the width half of the same decision the rows below are
          // the weight half of: Landed is a list of one-line rows and does not
          // need a card's column, and what it gives back goes to the lanes
          // where something is happening (#81).
          <section
            key={col.id}
            className={`col${col.id === "waiting" ? " hot" : ""}${col.id === "landed" ? " quiet" : ""}`}
          >
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
                  {emptyNote(col.id, control.paused, only)}
                </p>
              ) : col.id === "landed" ? (
                <Landed cards={col.cards} showProject={onBoard.size > 1} issue={ticket} />
              ) : col.id === "queued" ? (
                <Queued cards={col.cards} order={queueOrder} showProject={onBoard.size > 1} issue={ticket} />
              ) : (
                col.cards.map((card) => (
                  <Card
                    key={card.taskId}
                    card={card}
                    showProject={onBoard.size > 1}
                    issue={ticket(card)}
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
