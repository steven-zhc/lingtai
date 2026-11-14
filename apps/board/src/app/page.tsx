import { inWords } from '@lingtai/conductor/queue'
// The subpath, not the barrel: the board reads the control stream and hosts
// no work, and `@lingtai/daemon` would drag the work loop and the runtime in
// behind it — the same reason the actions import `@lingtai/conductor/decide`.
import type { Lock, RuntimeId } from '@lingtai/domain'
// Whether there is an App at all, which is where the bar's add-a-repository
// lands: the picker once it exists, step 0 before. Read here and handed down
// so `projects.tsx` stays a reducer over its arguments (#216).
import { hasGitHubAuth, storeChoice } from '@lingtai/env'
import { projectionLag } from '@lingtai/projector'
import Link from 'next/link'
import { type ComponentProps, Suspense } from 'react'

import { type BoardHalf } from '@/lib/blocker-state'
import {
  emptyHeld,
  emptyNote,
  COLUMNS,
  githubQueue,
  issueUrl,
  loadBoard,
  queuedStanding,
  selectedProject,
  columnSkeletonCount,
  queuedSkeletonCount,
  recordQueuedOffered,
  skeletonCount,
  type BoardCard,
  type GithubQueue,
  LANDED_OPEN,
} from '@/lib/board'
import { nearCeiling, readDayReading } from '@/lib/day-spend'
import { footerLags } from '@/lib/footer'
import { homeNotSetUp, theHome } from '@/lib/home'
import { kindDot } from '@/lib/kind-colour'
import { landedLink } from '@/lib/landed'
import { everyPaused, type LockMap, lockMap } from '@/lib/lock-marks.ts'
import { readControlOnce, readProjectLocks, readRegistered } from '@/lib/locks.ts'
import { elapsed } from '@/lib/progress'
import { RESOLUTION_COPY } from '@/lib/resolution-copy'
import { billHasAny, billText } from '@/lib/spend'
import { measure, timed, type Timing } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { Bar, BarActions } from './bar.tsx'
// Both halves of the sequence, in the file the task page reads them from too
// (#189): one rail, two surfaces, and never a copy.
import { codeSpans } from './code-spans.tsx'
import { Close, TriageMove } from './decide.tsx'
import { Draining } from './draining.tsx'
import { FilterMenu } from './filter-menu.tsx'
import { Footer, FooterPending, landedCount } from './footer.tsx'
import { Health } from './health.tsx'
import { HomeFrame } from './home-frame.tsx'
import { LockRows, pauseSlot } from './lock-banner.tsx'
import { NotSetUp } from './not-set-up.tsx'
import { Paused } from './paused.tsx'
import { Pending } from './pending.tsx'
import { AddProject, filterSummary, ProjectRows } from './projects.tsx'
import { QueuedAnswered, QueuedCountAnswered, QueuedCountPending, QueuedFallback } from './queued-stream.tsx'
import { Rail, Segs } from './rail.tsx'
import { sandboxSlot } from './sandbox-slot.tsx'
import { Skeleton } from './skeleton.tsx'

/**
 * The board is not a status page. It is where the backlog gets worked, and the
 * old loop's review queue reached 45 items growing at 14 a day against zero
 * processed because working one meant leaving the tool.
 *
 * **The card carries what you scan; everything else is one click away.** It
 * used to carry the gate evidence, the findings and the diff too, and it grew
 * heavy for a structural reason: the projection made all of it available, and
 * what is available gets rendered. Since 0012 the list reads one table and the
 * detail is reduced from the event stream on demand, which makes a card's
 * contents a decision instead of a consequence.
 *
 * A waiting card carries the rail, one cause line and, when triage advised, the
 * one resolution it recommends. All but that one, and the rest of the wait's
 * detail, are on the task page (0118 §2).
 *
 * **Weight follows attention, and it used not to.** Landed rendered a card each
 * and was the heaviest thing on the page while one waiting card took about a
 * twelfth of the ink; the bar led with `11 items`, a sum of four columns that
 * mean different things and that nobody acts on (#81). So history is one line
 * per item and reduces away past the most recent few, the room that frees goes to
 * the lanes where something is happening, and the bar ends on the one number an
 * operator acts on in the next minute: how many need a person.
 * None of that changes what a card *means* — that is #78 and #79.
 *
 * **The bar has weight too, and it took eleven chips to notice.** #81 put the
 * spend there and five later tickets each added one more true fact beside it,
 * none of them arguing against the row; at 1440 it wrapped, and a bar where
 * everything is emphasised is a bar where nothing is
 * ([the-bar.md](../../../../doc/design/the-bar.md)). Down to filter, health,
 * headline now that the reading has moved to the footer
 * (the-bar.md, *Since 2026-11-05*) — and the rule that keeps the row small is stated at the
 * end of the bar below, where the next chip would be added.
 *
 * **And so did the card, and two of its thirteen objects were sequences.** Same
 * story, one surface along, with one thing the bar did not have: the steps of a
 * pass run *one way*, and a wrapped row of equal pills is a set. They are a
 * bar of ten segments now, named underneath, and the rule the card keeps is in
 * `Rail` (`rail.tsx`) — *a sequence is not a set, and a pill cannot say which*
 * (#170, [the-card.md](../../../../doc/design/the-card.md)). Six objects, and
 * the ones that went were the counters the bar says better.
 */
export const dynamic = 'force-dynamic'

/**
 * The stripe down the left edge, from what the card is waiting on.
 *
 * Ordered by what a person needs to see first: a failed gate beats an abandoned
 * attempt beats a question beats a merge. A card with nothing to say gets the
 * neutral rule, not a colour — every stripe on the board would be the same as
 * none.
 *
 * `a-hold` is the one #78 added, and it is why a stripe was missing: a run
 * killed from outside fails no gate, so `failed` stayed 0 and a ticket that
 * had burned money and produced nothing came back to Queued looking new. A
 * queued card carrying a note is that card, or one a dispatch refused before
 * any run started (`#405`) — the note is the release's reason or the
 * refusal's, and the next claim clears it either way.
 */
/** The same sentences the task page's band uses for a triage that has not finished. */
const TRIAGE_WORDS = {
  Queued: 'triage is waiting to run',
  Running: 'triage is running',
  Interrupted: 'the daemon stopped during triage; it will be tried again on the next start',
  Unknown: 'triage status unknown — the project list could not be read',
  RecipeUnreadable: "triage status unknown — this project's recipe could not be read",
} as const

function accent(card: BoardCard): string {
  if (card.failed > 0) return 'a-fail'
  if (card.column === 'queued' && card.note) return 'a-hold'
  if (card.column === 'waiting') return 'a-sig'
  if (card.column === 'landed') return 'a-pass'
  if (card.column === 'running') return 'a-run'
  return ''
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
  if (href === null) return <>#{issue}</>
  return (
    <a className="iss" href={href} target="_blank" rel="noreferrer" title="the issue on GitHub">
      #{issue}
    </a>
  )
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
  const colour = kindDot(card.kindColor)
  if (colour === null) return null
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
  )
}

export function Card({
  card,
  showProject,
  issue,
  paused,
  projectLocks = [],
  arrive = false,
  next = false,
}: {
  card: BoardCard
  showProject: boolean
  issue: string | null
  /** Fades in: GitHub's card, newly on the board (#897). */
  arrive?: boolean
  /** The card `selectRunnable` takes first (#956). */
  next?: boolean
  /**
   * Whether the conductor is taking anything at all — one fact about the whole
   * installation, and one of the three states a Queued card can be in (#100).
   * Passed to every card because `queuedStanding` is what decides it matters,
   * and it matters in exactly one column.
   */
  paused: boolean
  /** What holds this card's project (#995): only marked here, the banner explains. */
  projectLocks?: readonly Lock[]
}) {
  if (card.column === 'waiting') {
    const fallback = card.note?.split(/\r?\n/, 1)[0]?.trim() ?? null
    return (
      <article className={`card waiting-card ${accent(card)}`}>
        <span className="id">
          <IssueRef href={issue} issue={card.ref} />
        </span>
        <Link className="ti" href={`/task/${encodeURIComponent(card.taskId)}`}>
          {card.title}
        </Link>
        {card.progress ? (
          <Rail progress={card.progress} live={false} held={card.held} line={card.short === null} />
        ) : null}
        {card.short !== null ? (
          <p className="waiting-held">
            <span className="waiting-held-badge">WAITING ON YOU</span> {card.short}
            {card.updatedAt ? ` · ${inWords(Date.now() - Date.parse(card.updatedAt))}` : ''}
          </p>
        ) : card.cause ? (
          <p className="waiting-cause">
            <span className={`waiting-cause-label cause-chip cause-chip--${card.cause.chip}`}>{card.cause.label}</span>
            <span className="waiting-cause-summary">{card.cause.summary}</span>
          </p>
        ) : card.triage ? (
          <p className="question waiting-fallback">
            {card.triage === 'RecipeUnreadable' ? (
              <Link href={`/recipe/${encodeURIComponent(card.project)}`}>{TRIAGE_WORDS[card.triage]}</Link>
            ) : (
              TRIAGE_WORDS[card.triage]
            )}
          </p>
        ) : fallback ? (
          <p className="question waiting-fallback">{codeSpans(fallback)}</p>
        ) : null}
        {card.move?.advised ? (
          <p className="question waiting-advised">
            Triage advised {RESOLUTION_COPY[card.move.advised].title}; a fix round is drawn first.
          </p>
        ) : null}
        {card.move && card.waitId !== null ? (
          <TriageMove
            project={card.project}
            issue={Number(card.ref)}
            taskId={card.taskId}
            waitId={card.waitId}
            move={card.move}
          />
        ) : null}
      </article>
    )
  }
  const standing = queuedStanding(card, paused, Date.now(), projectLocks)
  // Dropped wherever the rail draws `held` instead (`#415`): a card with a
  // rail outside the Running lane says the same approach-abandoned fact under
  // the bar, and two places saying it is the drift #100 already named.
  const arm = card.progress !== null && card.column !== 'running' ? null : card.arm
  return (
    <article
      className={`card ${accent(card)}${arrive ? ' arrive' : ''}${
        // Only the project's own pause dims: the conductor-wide one keeps its sentences as they were.
        standing?.state === 'paused' && !paused ? ' paused-card' : ''
      }`}
    >
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
        {/* Not amber, and not any of the state colours: "taken first" is a
            fact about the queue's order, not about a person being waited on. */}
        {next ? <span className="qnext"> — taken first</span> : null}
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
            there is no time for one, and the render clock is not it.

            **The lane decides this and not the rail.** Until #170 only a
            running card had `progress`, so the two tests were the same one;
            Waiting reduces now, and a card stopped on a person would have read
            `running 13h58m` about a run that was refused and is not in flight
            — a plausible number, which is the worst kind. It is the lane's own
            word here for the same reason it is everywhere else in this
            sentence. */}
        {card.column === 'running' && card.progress ? (
          <li className="pill run" title={`this attempt's first event was ${card.progress.since}`}>
            running {elapsed(Date.now() - Date.parse(card.progress.since))}
          </li>
        ) : card.updatedAt ? (
          <li className="pill" title={card.updatedAt}>
            {card.column} {inWords(Date.now() - Date.parse(card.updatedAt))}
          </li>
        ) : null}
        {card.turns !== null ? <li className="pill">{card.turns} turns</li> : null}
        {billHasAny(card.costUsd) ? <li className="pill">{billText(card.costUsd)}</li> : null}
        {/* **The counters are the fallback, not the reading** (#170).

            `1 passed` and a green `prepared` segment are one fact at two
            granularities, and the ticket that drew the rail would not carry
            both unexamined — that is how this card reached thirteen objects.
            So where there is a rail the counters go: it says the same thing per
            point, in order, and a point holding more than one action draws a
            cell each, which is the granularity the counter had and the rail was
            missing. The four of them, and not `passed` alone: a count of
            failures and a count of waivers are the same fact at the same two
            granularities, and keeping three of the four would have left the
            reader deciding which list to believe.

            Where there is no rail they stay, unchanged, and are the whole of
            what the card says about its gates — a card in a lane that does not
            reduce, a run whose stream would not read, a row the Landed lane keeps
            collapsed. Green is a gate that ran and went green; a waiver and an
            approval are a person's word standing in for one, so they carry the
            held colour and their own word. */}
        {card.progress === null ? (
          <>
            {card.passed > 0 ? <li className="pill pass">{card.passed} passed</li> : null}
            {card.failed > 0 ? <li className="pill fail">{card.failed} failed</li> : null}
            {card.waived > 0 ? (
              <li className="pill hold" title="a person overrode a failed step">
                {card.waived} waived
              </li>
            ) : null}
            {card.approved > 0 ? (
              <li className="pill hold" title="a person approved, rather than a step passing">
                {card.approved} approved
              </li>
            ) : null}
          </>
        ) : null}
        {/* Apart from the work's cost, deliberately. Answering a refusal is
            default-on and spends an agent without being asked again, so reducing
            it into the number beside it would make it an invisible bill (#84).

            It says *answering* rather than *repair* since 0039 §3: the column
            holds every round a pass bought — a refused review, a red build, and
            after `#142` a conflict — and only one of those was ever a repair.
            The figure is `spend`'s `Action` rows at round 1 or above (0039 §3,
            `#498`) — `BoardCard.repairCostUsd`'s own doc says the same — and
            not the `repair_costs` projection column this used to read. */}
        {billHasAny(card.repairCostUsd) ? (
          <li className="pill sig" title="what answering refusals on this has cost, apart from the work">
            {billText(card.repairCostUsd)} answering
          </li>
        ) : null}
        {/* **Which round, as one object** (#170). A card that keeps failing
            should read as one rather than looking new every time it comes back
            round — and *which attempt* and *which arm* are 0040's two axes, not
            two unrelated counters. They sat as two pills among the scalars,
            which is the question they answered worst.

            They are not the same number and the difference is what a person
            acts on: an attempt is a claim, so a crash, a backoff and an
            abandoned approach all read as `attempt 3`, while the arm says the
            reviewer refused a whole approach and the ticket was started over.
            One reading, said in one place, in the order they nest — an arm
            contains attempts. The second sequence deserves a form that shows
            its order the way the rail below does, and that is not this ticket's
            (the-card.md); one object is what stops it being drawn as a set.

            The arm's sentence is `describeArm`'s, so this and `lingtai status`
            cannot drift apart (#100). Null on every card whose recipe leaves
            `restarts` at zero, which is all of them today.

            **Moved off this pill wherever the rail says it instead** (`#415`).
            A card with a rail in a lane that is not Running draws `held`'s
            line under it — rounds spent, restarts left — and the arm here
            would be the same fact in a second place, which is the drift #100
            already named. `attempt N` stays: it counts claims, which `held`
            does not say anything about. */}
        {card.attempts > 1 || arm ? (
          <li
            className="pill sig"
            title={arm ? "attempts so far, and approaches abandoned against the recipe's ceiling" : 'attempts so far'}
          >
            {[card.attempts > 1 ? `Attempt ${card.attempts}` : null, arm]
              .filter((s): s is string => s !== null)
              .join(' · ')}
          </li>
        ) : null}
        {/* When, not whether (#95) — and, since #100, which of the three a
            Queued card is. A card the backoff is holding, a card nothing will
            start because the conductor is stopped, and a card nobody has got to
            yet all sat here reading identically; the third says nothing, which
            is what makes the other two worth reading. The sentences are
            `queuedStanding`'s and the backoff's is `lingtai status`'s own, so
            the two places this is asked cannot drift apart again. */}
        {standing ? (
          <li className="pill hold" title={standing.title}>
            {standing.text}
          </li>
        ) : null}
      </ul>

      {/* Wherever the run's stream was read — Running, and Waiting since #170.
          It used to be Running alone, on the argument that every other lane
          describes something over and the counts above are the whole truth
          about it (#79). They are not: a point that was configured and did not
          run is invisible in a count, and that is the one state 0016 §4 calls
          our bug. `laneProgress` decides which cards have one.

          The lane's own word goes with it, for the reason the elapsed pill
          above takes it: *this run is in flight* is a fact about the column and
          not one the reducer can reach. */}
      {card.progress ? <Rail progress={card.progress} live={card.column === 'running'} held={card.held} /> : null}

      {card.note ? <p className="question">{codeSpans(card.note)}</p> : null}
      {card.split ? <p className="question">{card.split}</p> : null}

      {/* And on a queued card, where it is the only move there is. The state
          this was written for is the item nothing is asking about: five sat in
          Queued that GitHub had closed hours earlier, because `gh issue close`
          appends nothing and the reducer went on calling them `backlog`. */}
      {card.column === 'queued' ? (
        <div className="btnrow">
          <Close project={card.project} issue={Number(card.ref)} waitId={null} />
        </div>
      ) : null}
    </article>
  )
}

/**
 * A column's heading: a word, for every column. The way into `/landed` is the
 * Landed column's count (#895, #949), see `LandedCount`. A second way out of
 * the reading and not a fifth object in the bar (`the-bar.md`).
 */
export function ColumnLabel({ label }: { label: string }) {
  return <span>{label}</span>
}

/**
 * The Landed column's count, drawn as a pill button to `/landed`, carrying
 * `?project=` as the `/report` link does. The number is the column's own
 * (landed and closed cards), not the footer's `landedCount`.
 */
export function LandedCount({ count, only }: { count: number; only: string | undefined }) {
  return (
    <Link className="ctbtn" href={landedLink(only)} title="what Lingtai changed, newest first">
      <span className="ct">{count}</span>
      <span className="lbl">all</span>
      <span aria-hidden="true">→</span>
    </Link>
  )
}

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
export function LandedRow({
  card,
  showProject,
  issue,
}: {
  card: BoardCard
  showProject: boolean
  issue: string | null
}) {
  const said = [
    // First, and only when it is true: this column's heading says *Landed*, and
    // a closed item did not land — it was ended by a person because nobody was
    // going to do it (`#151`). The two share the column because both are over
    // and Landed is already the archive, so the row is the only place the
    // difference can be said. Without it the heading speaks for a row it is
    // wrong about, which is the shape this repository keeps finding in itself:
    // a claim that is true where it was written and false where it is read.
    card.closed ? 'closed' : null,
    card.kind,
    card.turns === null ? null : `${card.turns} turns`,
    billHasAny(card.costUsd) ? billText(card.costUsd) : null,
    // The lane's own word is on the card; here the column heading is already
    // saying "landed", so the row says only how long ago (#79).
    card.updatedAt === null ? null : inWords(Date.now() - Date.parse(card.updatedAt)),
  ].filter((s): s is string => s !== null)

  return (
    <li className="lrow">
      {/* **The ten steps, on the row that says it landed** (#170).

          The counts never carried the one state that matters here. `lingtai
          doctor` fails on three of this repository's own items for having
          landed past a step that was configured and did not run — #49, #53,
          #55 at `merge` — and the board said nothing at all about them, because
          the row lists what a run accumulated and *nothing happened here* is
          not a number. The hatch is that mark, and it is the only thing on this
          rail that breaks its rhythm.

          First on the line, before the reference, so the rails line up down the
          column and the one that is wrong is found by scanning rather than by
          reading. Absent on the rows the lane keeps collapsed — `laneProgress`
          says why it stops where it does. */}
      {card.progress ? (
        <span className="lseq">
          <Segs steps={card.progress.steps} at={null} labels={false} />
        </span>
      ) : null}
      {showProject ? <span className="proj">{card.project}</span> : null}
      <IssueRef href={issue} issue={card.ref} />
      <Link className="lmeta" href={`/task/${encodeURIComponent(card.taskId)}`} title={card.title}>
        · {said.join(' · ')}
      </Link>
    </li>
  )
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
  cards: BoardCard[]
  showProject: boolean
  issue: (card: BoardCard) => string | null
}) {
  const rows = (some: BoardCard[]) => (
    <ul className="landed">
      {some.map((c) => (
        <LandedRow key={c.taskId} card={c} showProject={showProject} issue={issue(c)} />
      ))}
    </ul>
  )
  const older = cards.slice(LANDED_OPEN)

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
  )
}

/**
 * The three places the page waits for GitHub (#884), each an `await` of the one
 * promise `Page` started and nothing else — what they draw is
 * `queued-stream.tsx`'s, which a test renders without a promise.
 */
async function AwaitedQueued({
  queue,
  ...props
}: { queue: Promise<GithubQueue> } & Omit<ComponentProps<typeof QueuedAnswered>, 'github'>) {
  return <QueuedAnswered github={await queue} {...props} />
}

async function AwaitedCount({ queue, logCards }: { queue: Promise<GithubQueue>; logCards: BoardCard[] }) {
  return <QueuedCountAnswered github={await queue} logCards={logCards} />
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
type LockRead = Awaited<ReturnType<typeof readProjectLocks>>

/**
 * The reads `/` waits for, together and not in a row (#112) — and once: this is
 * the only `loadBoard` call in a render. **Each is its own promise**, so a part
 * awaits the reads it draws from and no others: the cards do not wait for the
 * day's spend, nor the footer for the locks. `day` and `lags` follow
 * `loadBoard`: its `currentSpend` reduces the spend projection to the head, and
 * `readDayReading` reads that projection without refreshing it, so run beside
 * it the day's total could be read before today's `RunSpent` events were
 * projected. `day` also follows `control`, which it is handed.
 *
 * `registered` is the register, and only for the owners a ticket link is built
 * from. `readControlOnce` is not caught — a control read that failed would
 * render as "nothing is paused", which is the exact silence #77 is about.
 */
function startReads(param: string | undefined) {
  const board = loadBoard(param)
  const registered = timed('projects.read', () => readRegistered()).catch(() => [])
  const control = timed('events.control', () => readControlOnce())
  const settled = Promise.all([board, control])
  const day = settled.then(() =>
    timed('spend.day', () => control.then((c) => readDayReading(undefined, c)), { failed: (r) => r.day === null }),
  )
  const lags = board.then(() => timed('projections.lag', () => projectionLag()).then(footerLags, () => null))
  return { board, registered, control, day, lags }
}
type Reads = ReturnType<typeof startReads>

/** What every keyed part is handed: the promises it awaits, and the URL's choice. */
type Ctx = {
  reads: Reads
  locks: Promise<LockRead>
  measured: Promise<readonly [void, readonly Timing[]]>
  param: string | undefined
}

type BoardRead = Awaited<Reads['board']>

/** What the board alone says: the selection, and what the columns hold. */
function shape(board: BoardRead, param: string | undefined) {
  const { columns, askable } = board
  // The selection: the URL's choice, else the only project there is (#993).
  const only = selectedProject(param, board.projects)
  // What the *cards* say, not what is registered: a card can outlive its
  // project, and it is the cards that have to be told apart.
  const onBoard = new Set(columns.flatMap((c) => c.cards.map((card) => card.project)))
  // What a blocker chip needs from the columns (#960): where each ticket the
  // log holds stands, and each project's own repository. The table is
  // `blockerChip`'s; the inputs can only be built here.
  const boardHalf: BoardHalf = {
    columns: new Map(
      columns.flatMap((c): [string, 'running' | 'waiting' | 'queued'][] => {
        const id = c.id
        return id === 'landed' ? [] : c.cards.map((card): [string, typeof id] => [`${card.project}#${card.ref}`, id])
      }),
    ),
    repositories: new Map(
      askable.flatMap((f) => (f.links === null ? [] : [[f.project, `${f.links.owner}/${f.links.repo}`] as const])),
    ),
  }
  // The one number an operator acts on *in the next minute*: how many need me.
  // What it has cost is the other number #81 wanted, and it is a click away on
  // `/report` — a running total on a rail glanced at every few seconds is one
  // you learn to stop seeing (`the-bar.md`).
  const waiting = columns.find((c) => c.id === 'waiting')?.cards.length ?? 0
  return { only, onBoard, boardHalf, waiting }
}

type Registered = Awaited<Reads['registered']>

/** What holds each project, read once for the filter, the cards and the empty Running line (#995). */
function lockShape(lockRead: LockRead, only: string | undefined, registered: Registered) {
  // A failed read is the empty map, and C1's banner says why.
  const projectLocks = lockMap(lockRead)
  // An unread control stream leaves the ceiling unknown: no one is claimed to take work.
  const uses =
    lockRead.ok && lockRead.uses && lockRead.controlProblem === undefined
      ? lockRead.uses
      : new Map<string, readonly RuntimeId[]>()
  const registeredNames = registered.map((p) => p.project).filter((p): p is string => p !== null)
  const locksInScope: LockMap = new Map([...projectLocks].filter(([p]) => only === undefined || p === only))
  const allPaused = only === undefined && everyPaused(projectLocks, registeredNames)
  return { projectLocks, uses, registeredNames, locksInScope, allPaused }
}

/** The loading mark: a pulse, never a figure, a tone or an absence that reads as a claim. */
const Pulse = () => <span className="ct-pulse" aria-hidden="true" />

/** A column's count while the log is being read: the pulse alone, as the number is not known. */
const CountPending = () => (
  <span className="ct">
    <Pulse />
  </span>
)

/** The filter's rows: `board`, the register and the locks, and not the day's reading. */
async function readMenu({ reads, locks, param }: Ctx) {
  const [board, registered, lockRead] = await Promise.all([reads.board, reads.registered, locks])
  const { only } = shape(board, param)
  return { filters: board.projects, only, registered, ...lockShape(lockRead, only, registered) }
}

async function MenuRows({ ctx, app }: { ctx: Ctx; app: boolean }) {
  const m = await readMenu(ctx)
  return (
    <ProjectRows filters={m.filters} only={m.only} app={app} registered={m.registeredNames} locks={m.projectLocks} />
  )
}

async function FilterSlot({ ctx, app }: { ctx: Ctx; app: boolean }) {
  const m = await readMenu(ctx)
  const rows = (
    <ProjectRows filters={m.filters} only={m.only} app={app} registered={m.registeredNames} locks={m.projectLocks} />
  )
  // Nothing configured is the one board with somewhere to go: the sentence is the link (#169).
  if (m.filters.length === 0) return rows
  return (
    <FilterMenu className="filter" summary={filterSummary(m.only ?? 'all projects')}>
      {rows}
    </FilterMenu>
  )
}

async function ActionsPart({ ctx }: { ctx: Ctx }) {
  const [board, registered] = await Promise.all([ctx.reads.board, ctx.reads.registered])
  const { only } = shape(board, ctx.param)
  if (only === undefined || !registered.some((p) => p.project === only)) return null
  return <BarActions project={only} pause={await pauseSlot(only)} />
}

/**
 * The paused chip and the drain, from the control read alone. An absent chip is
 * a claim that nothing is paused (#77), so until it is read the rail says
 * nothing of the kind: its fallback is the pulse.
 */
async function PausedPart({ ctx }: { ctx: Ctx }) {
  const control = await ctx.reads.control
  return (
    <>
      {/* And whether anything is going to move, which is neither the health nor
        the count: the projection can be at the head of the log while the
        conductor is under the setup's pause, which is what the board showed for
        four days without a word for it (#77). Draws nothing when it is not
        paused. */}
      {control.paused ? (
        <>
          <span className="sep" />
          <Paused by={control.by} reason={control.reason} />
        </>
      ) : null}
      {/* And whether it is on its way out (0030). Draws nothing when it is not. */}
      <Draining />
    </>
  )
}

/**
 * **The headline, and the last thing on the row.** It is the only reason to
 * look up: the only column that is asking for a person, and the only amber on
 * the bar. With nothing waiting there is no headline at all.
 */
async function HeadlinePart({ ctx }: { ctx: Ctx }) {
  const { waiting } = shape(await ctx.reads.board, ctx.param)
  return waiting > 0 ? (
    <a className="head sig" href="#waiting" title="tickets that will not move until you decide">
      {`${waiting} waiting on you`}
    </a>
  ) : null
}

async function BannerPart({ ctx }: { ctx: Ctx }) {
  const [board, lockRead] = await Promise.all([ctx.reads.board, ctx.locks])
  const { only } = shape(board, ctx.param)
  return (
    <>
      <LockRows locks={lockRead} scope={only} now={new Date()} />
      {/* Repositories that are recorded and not yet conducted (#163). Above
        the lanes because it is not work, and absent entirely when there are none. */}
      <Pending projects={board.pending} />
    </>
  )
}

async function TimingPart({ ctx }: { ctx: Ctx }) {
  return <TimingMeta timings={(await ctx.measured)[1]} />
}

async function FooterPart({ ctx }: { ctx: Ctx }) {
  const [board, day, lags] = await Promise.all([ctx.reads.board, ctx.reads.day, ctx.reads.lags])
  return (
    <Footer
      day={day}
      lags={lags}
      landed={landedCount(board.columns.find((c) => c.id === 'landed')?.cards ?? [])}
      home={theHome()}
    />
  )
}

async function CountPart({
  id,
  ctx,
  queue,
  projectKey,
}: {
  id: string
  ctx: Ctx
  queue: Promise<GithubQueue>
  projectKey: string
}) {
  const board = await ctx.reads.board
  const col = board.columns.find((c) => c.id === id)
  if (col === undefined) return null
  if (col.id === 'queued') {
    return (
      <Suspense key={`queued-count:${projectKey}`} fallback={<QueuedCountPending logCount={col.cards.length} />}>
        <AwaitedCount queue={queue} logCards={col.cards} />
      </Suspense>
    )
  }
  if (col.id === 'landed') return <LandedCount count={col.cards.length} only={shape(board, ctx.param).only} />
  return <span className="ct">{col.cards.length}</span>
}

async function CardsPart({
  id,
  ctx,
  queue,
  projectKey,
}: {
  id: string
  ctx: Ctx
  queue: Promise<GithubQueue>
  projectKey: string
}) {
  const [board, registered, control, lockRead] = await Promise.all([
    ctx.reads.board,
    ctx.reads.registered,
    ctx.reads.control,
    ctx.locks,
  ])
  const col = board.columns.find((c) => c.id === id)
  if (col === undefined) return null
  const { only, onBoard, boardHalf } = shape(board, ctx.param)
  const { projectLocks, uses, locksInScope, allPaused } = lockShape(lockRead, only, registered)
  const { ticketSources, queueOrder, askable } = board
  // Where each card's ticket lives, from the owners already loaded — a lookup,
  // not a request per card.
  const owners = new Map(registered.map((p) => [p.project, p.owner]))
  const ticket = (card: BoardCard) =>
    issueUrl(owners.get(card.project) ?? null, card.project, card.ref, ticketSources.get(card.project) ?? null)
  const queuedColumn = col.id === 'queued' ? col : undefined
  const list = (
    card: BoardCard,
    showProject: boolean,
    next?: ComponentProps<typeof Card>['next'],
    arrive?: boolean,
  ) => (
    <Card
      card={card}
      showProject={showProject}
      issue={ticket(card)}
      paused={control.paused}
      projectLocks={projectLocks.get(card.project) ?? []}
      next={next}
      arrive={arrive}
    />
  )
  // **An empty column and an unanswerable one are different facts.** They
  // rendered identically until #76: a recipe that would not parse took every
  // issue out of Queued, and the column read exactly like a repository with
  // nothing to do. Three cases, and they are three: the queue could not be
  // listed (#76), the lane is empty because somebody stopped the conductor
  // (#77), and the lane is simply empty. Only the last one means what it says.
  if (queuedColumn !== undefined) {
    // **GitHub's half streams in after the rest** (#884). The fallback is what
    // the log already says, and the answer is the whole column again.
    return (
      <Suspense
        key={`queued-cards:${projectKey}`}
        fallback={
          <QueuedFallback
            unreadable={queuedColumn.problems ?? []}
            logCards={queuedColumn.cards}
            onBoard={onBoard}
            count={skeletonCount(askable.map((f) => f.project))}
            order={queueOrder}
            list={list}
          />
        }
      >
        <AwaitedQueued
          queue={queue}
          unreadable={queuedColumn.problems ?? []}
          logCards={queuedColumn.cards}
          onBoard={onBoard}
          order={queueOrder}
          epicHref={(project, ref) =>
            issueUrl(owners.get(project) ?? null, project, String(ref), ticketSources.get(project) ?? null)
          }
          list={list}
          board={boardHalf}
          empty={<p className="empty">{emptyNote(col.id, control.paused, only)}</p>}
        />
      </Suspense>
    )
  }
  if (col.cards.length === 0) {
    return (
      <p
        className={`empty${emptyHeld(col.id, control.paused, only, locksInScope, allPaused, new Date(), uses) ? ' held' : ''}`}
      >
        {emptyNote(col.id, control.paused, only, locksInScope, allPaused, new Date(), uses)}
      </p>
    )
  }
  if (col.id === 'landed') return <Landed cards={col.cards} showProject={onBoard.size > 1} issue={ticket} />
  return (
    <>
      {col.cards.map((card) => (
        <Card
          key={card.taskId}
          card={card}
          showProject={onBoard.size > 1}
          issue={ticket(card)}
          paused={control.paused}
          projectLocks={projectLocks.get(card.project) ?? []}
        />
      ))}
    </>
  )
}

export default async function Page({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const param = (await searchParams).project
  // Before any read of the log: a refused store makes `loadBoard` throw the
  // same sentence, and Next would show that as its default error page. The
  // screen below says it instead, and mounts no `Live` — there is no log to
  // follow (#767).
  const choice = storeChoice()
  if ('refused' in choice) return <NotSetUp home={theHome()} choice={choice} nothing={homeNotSetUp(choice)} />

  // **A boundary around a read is keyed, and its key contains `projectKey`**
  // (#1037). Choosing another project is a navigation to this same route: an
  // unkeyed boundary that already revealed its content is not hidden again, so
  // it holds the whole switch until its read resolves and the page looks as it
  // did before. A live re-render of the same project keeps the key, and so
  // shows no fallback. Siblings need distinct keys, hence the prefix. `Live`
  // is never inside one: a remount closes the `EventSource`.
  const projectKey = param ?? ''
  const key = (part: string) => `${part}:${projectKey}`

  // The reads start here, once each, and the parts below only await them. The
  // page awaits nothing past this line, so the frame is drawn at once.
  let started: Reads | undefined
  const measured = measure(
    async () => {
      started = startReads(param)
      await Promise.all(Object.values(started))
    },
    { label: '/' },
  )
  // `measure` calls its function before it returns, so the reads are started
  // inside its scope and every `timed` below lands in `/`'s timings.
  if (started === undefined) throw new Error('measure did not start the reads')
  const ctx: Ctx = { reads: started, locks: readProjectLocks(), measured, param }
  // GitHub's half of the Queued column (#884). It needs the board's `askable`
  // and nothing else, so it waits for `board` alone: the day's spend and the
  // lags are not its reads. `.then` is registered here, outside `/`'s scope,
  // and `measure` opens a scope of its own, so these timings land in the
  // `/ queue` array and never in the one already serialised. Started once and
  // awaited from both boundaries; two calls would be two fan-outs to GitHub.
  const queue: Promise<GithubQueue> = ctx.reads.board
    .then((board) =>
      measure(() => timed('board.queue', () => githubQueue(board.askable, board.known)), { label: '/ queue' }).then(
        (answered) => {
          recordQueuedOffered(param, board.askable, answered[0].problems)
          return answered
        },
      ),
    )
    .then(([github]) => github)
  const app = hasGitHubAuth()

  return (
    <HomeFrame
      footer={
        <Suspense key={key('footer')} fallback={<FooterPending home={theHome()} />}>
          <FooterPart ctx={ctx} />
        </Suspense>
      }
    >
      <>
        <Suspense key={key('timing')} fallback={null}>
          <TimingPart ctx={ctx} />
        </Suspense>
        <Bar
          sandbox={sandboxSlot(param, key('sandbox'))}
          project={param}
          actions={
            <Suspense key={key('actions')} fallback={null}>
              <ActionsPart ctx={ctx} />
            </Suspense>
          }
        >
          <span className="sep" />
          {/* The projects, and the way to add one — `projects.tsx`, which is
            where that argument is made. The filter is one of the objects the
            rule below names, a list gaining an action at its end is that object
            rather than a fifth one (#216). With a `project` in the URL the
            summary is the shell's and only the rows stream; without one, the
            selection needs `filters` (#993), so the whole slot waits and says
            nothing it could have to take back. */}
          {param !== undefined ? (
            <FilterMenu className="filter" summary={filterSummary(param)}>
              <Suspense key={key('menu')} fallback={null}>
                <MenuRows ctx={ctx} app={app} />
              </Suspense>
            </FilterMenu>
          ) : (
            <Suspense
              key={key('filter')}
              fallback={
                <FilterMenu className="filter" summary={filterSummary(<Pulse />)}>
                  {null}
                </FilterMenu>
              }
            >
              <FilterSlot ctx={ctx} app={app} />
            </Suspense>
          )}
          {/* The `+` needs only `app`, so the shell draws it before any read. */}
          <AddProject app={app} />
          <span className="sep" />
          {/* Everything from here is the right rail, and it is a rail rather than
            more children of `.bar` so that a narrow window breaks between
            the filters and the rail rather than in the middle of the
            rail. Its order is the eye's: whether the
            board can be believed, and — last, where the eye lands — the one
            thing that is asking for a person. */}
          <span className="rail">
            {/* One health, out of two facts that were two chips. `#64` asks
              whether what you are looking at is current and `#98` asks whether
              the process that moves it is running the code we merged; both are
              real, and two boxes for one question is two things to learn to
              read. Green and silent when both are true, and a sentence with the
              action in it when either is not. Never amber — that is the
              headline's, below. Outside every keyed boundary: it holds the
              subscription. */}
            <Health
              projectKey={projectKey}
              near={ctx.reads.day.then((d) => nearCeiling(d.day, d.ceilingUsd))}
              runnable={queue.then(
                (q) => q.runnable,
                () => null,
              )}
            />
            <Suspense key={key('paused')} fallback={<Pulse />}>
              <PausedPart ctx={ctx} />
            </Suspense>
            <Suspense key={key('headline')} fallback={<Pulse />}>
              <HeadlinePart ctx={ctx} />
            </Suspense>
            {/* **A chip is not free, and the row is the unit.**
              [the-bar.md](../../../../doc/design/the-bar.md)

              Eleven objects stood here, nine of them boxed, wrapping to a second
              line at 1440. Every one had been argued for on its own — #81 split
              a sum nobody could act on, #84 separated a repair's spend, #86 said
              whose emptiness an empty board is, 0025 §2 put a spending default
              on screen, #64 and #98 each added a health chip — and **none of
              those arguments was about the row**.

              A bar carries what changes what you do next, and answers two
              questions and no third: *is anything waiting on me?* and *is the
              system doing what the code says?* Anything added here has to be
              argued against the objects that are left — filter, health,
              headline — and not against the empty space beside them. A fact
              that does not fit that test has a page: spend is on the report
              and the pass limits are on the recipe page.

              **The objects are not all on `.rail`, and #216 is where that
              mattered.** The filter is one of them, so *it is on the other
              side of the separator* is not an argument this rule accepts. What
              #216 added — a `+` that onboards a repository — passes instead by
              adding nothing to the count: the filter has been a list of tabs
              since #81, and a list gaining an action at its end is that object
              and not a fourth one. A fourth object is still argued for here. */}
          </span>
        </Bar>
        <Suspense key={key('banner')} fallback={null}>
          <BannerPart ctx={ctx} />
        </Suspense>

        <div className="cols">
          {COLUMNS.map((col) => (
            // `quiet` is the width half of the same decision the rows below are
            // the weight half of: Landed is a list of one-line rows and does not
            // need a card's column, and what it gives back goes to the lanes
            // where something is happening (#81).
            <section
              key={col.id}
              id={col.id === 'waiting' ? 'waiting' : undefined}
              className={`col${col.id === 'waiting' ? ' hot' : ''}${col.id === 'landed' ? ' quiet' : ''}`}
            >
              <header className="col-h">
                <ColumnLabel label={col.label} />
                <Suspense key={key(`count-${col.id}`)} fallback={<CountPending />}>
                  <CountPart id={col.id} ctx={ctx} queue={queue} projectKey={projectKey} />
                </Suspense>
              </header>
              <div className="cards">
                <Suspense
                  key={key(`cards-${col.id}`)}
                  fallback={
                    <Skeleton
                      shape={col.id === 'landed' ? 'lines' : 'card'}
                      count={
                        col.id === 'queued' ? queuedSkeletonCount(ctx.param) : columnSkeletonCount(ctx.param, col.id)
                      }
                    />
                  }
                >
                  {/* Fade on mount, never on render: the boundary is keyed by
                      project, so this element mounts once per switch and a
                      live re-render of the same project replays nothing. */}
                  <div className="cards-in arrive">
                    <CardsPart id={col.id} ctx={ctx} queue={queue} projectKey={projectKey} />
                  </div>
                </Suspense>
              </div>
            </section>
          ))}
        </div>
      </>
    </HomeFrame>
  )
}
