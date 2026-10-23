import { inWords } from '@lingtai/conductor/queue'
import { MERGE_HUNKS_ONE_BY_ONE } from '@lingtai/domain'
// The same subpath `actions.ts`'s `sendAttempt` already reads `allowedResolutions`
// off (#483) — so the page and the server action can never disagree about
// which resolutions a wait allows.
import {
  allowedResolutions,
  disagreement,
  recommendedResolution,
  type Resolution,
  type TriageStatus,
  type WaitReason,
} from '@lingtai/domain/wait'
// The subpath, for the reason `board.ts` gives: the barrel pulls the gate
// pipeline in behind it. `describeHold` is pure and lives beside the field it
// reads, so this block, the card and `lingtai status` say the same thing about
// the same hold rather than keeping three copies of the words.
import { describeHold, type HoldLine } from '@lingtai/projector/task-view'

import type { RunProgress } from '@/lib/progress'
import type { OutgoingView } from '@/lib/prompt'
import { holding, place, type QueuedView } from '@/lib/queued'
import { billHasAny, billText, emptyBill, type Bill } from '@/lib/spend'
import type { DiscussionView, StandingView } from '@/lib/task'
import { presentCause } from '@/lib/triage-cause'

import {
  Close,
  ContinueFixing,
  Decide,
  EditBodyAndRequeue,
  Requeue,
  RunNow,
  ScheduleContinuation,
  Send,
} from './decide.tsx'
import { Discussion } from './discussion.tsx'
import { DocumentBody } from './markdown.tsx'
import { Outgoing } from './outgoing.tsx'
import { Plan } from './plan.tsx'
import { Rail } from './rail.tsx'
import { FollowedLog } from './run-log.tsx'
import { TriageChoices, TriagePicks } from './triage-picks.tsx'

const MAX_TICKET_CELL = 600

const RESOLUTION_COPY: Record<Resolution['_tag'], { title: string; consequence: string }> = {
  Approve: {
    title: 'Approve and continue',
    consequence: 'Continue this run from its recorded commit. Any refusal at this hold is waived.',
  },
  GrantFixRound: {
    title: 'Continue fixing current work',
    consequence:
      'Start from the saved branch and head for one additional paid fix round. Build and review run again; this does not waive either refusal.',
  },
  AnswerQuestion: {
    title: 'Answer the question',
    consequence: 'Give the answer to the next attempt, or withdraw the question and return the ticket to the queue.',
  },
  Requeue: {
    title: 'Start over from base',
    consequence: 'Start a new pass from base with the recipe’s rounds. The saved branch is not continued.',
  },
  EditBodyAndRequeue: {
    title: 'Add to the ticket and start over',
    consequence: 'Append your text to the ticket body, then queue a new pass from main with that text.',
  },
  Close: {
    title: 'Close the ticket',
    consequence: 'End this ticket without another pass. A reason is required.',
  },
}

/** Agent-written fields stay React text; there is no markdown path in this band. */
export function TriageBand({
  reason,
  status,
  headLine,
  raw,
  said,
}: {
  reason: WaitReason
  status: TriageStatus
  headLine?: string | null
  raw?: string | null
  said?: string | null
}) {
  switch (status._tag) {
    case 'NotNeeded':
    case 'NotDeclared':
      return null
    case 'Queued':
      return (
        <section className="triage-band" data-rank="triage">
          <span className="triage-label">Triage</span>
          <p>triage is waiting to run</p>
        </section>
      )
    case 'Running':
      return (
        <section className="triage-band" data-rank="triage">
          <span className="triage-label">Triage</span>
          <p>triage is running</p>
        </section>
      )
    case 'Interrupted':
      return (
        <section className="triage-band" data-rank="triage">
          <span className="triage-label">Triage</span>
          <p>the daemon stopped during triage; it will be tried again on the next start</p>
        </section>
      )
    case 'Done': {
      const result = status.result
      if (result._tag === 'TriageFailed')
        return (
          <section className="triage-band triage-band--failed" data-rank="triage">
            <span className="triage-label">Triage · failed</span>
            {headLine ? <p>{headLine}</p> : null}
            <p>triage failed: “{result.why}”</p>
          </section>
        )
      const cause = result.cause
      const presentation = presentCause(cause)
      let parts: React.ReactNode = null
      switch (cause._tag) {
        case 'UndecidedQuestion':
          parts = cause.questions.map((question, index) => (
            <div key={question.id}>
              <TriageChoices question={question} index={index} />
            </div>
          ))
          break
        case 'FixableLines':
          parts =
            cause.fixes.length > 0 ? (
              <ol className="triage-fixes">
                {cause.fixes.map((fix, index) => (
                  <li key={index}>
                    <span className="triage-number">{index + 1}</span>
                    <span className="triage-location">
                      {fix.path}
                      {fix.line === null ? '' : `:${fix.line}`}
                    </span>
                    <span>{fix.what}</span>
                  </li>
                ))}
              </ol>
            ) : null
          break
        case 'ConflictingHunks':
          const mechanical = cause.hunks.filter((hunk) => hunk._tag === 'Mechanical')
          const divergent = cause.hunks.filter((hunk) => hunk._tag === 'Divergent')
          parts = (
            <>
              <p className="triage-hunk-count">
                {cause.total} conflicting {cause.total === 1 ? 'hunk' : 'hunks'}
              </p>
              {mechanical.length > 0 ? (
                <div className="triage-hunk-group">
                  <h3>Mechanical · {mechanical.length}</h3>
                  <ul>
                    {mechanical.map((hunk, index) => (
                      <li key={index} className="triage-hunk triage-hunk--mechanical">
                        <span className="triage-location">
                          {hunk.path}
                          {hunk.line === null ? '' : `:${hunk.line}`}
                        </span>
                        <span>Mechanical</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {divergent.length > 0 ? (
                <div className="triage-hunk-group">
                  <h3>
                    Divergent · {divergent.length} {divergent.length === 1 ? 'question' : 'questions'}
                  </h3>
                  <ol>
                    {divergent.map((hunk, index) => (
                      <li key={index} className="triage-hunk triage-hunk--divergent">
                        <span className="triage-location">
                          {hunk.path}
                          {hunk.line === null ? '' : `:${hunk.line}`}
                        </span>
                        <TriageChoices question={hunk.question} index={index} />
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
              {cause.hunks.length === 0 && cause.total > MERGE_HUNKS_ONE_BY_ONE ? (
                <p>The conflict is past one-by-one resolution; start over from the new base.</p>
              ) : null}
            </>
          )
          break
        case 'WrongApproach':
        case 'TicketTooBig':
        case 'SetupBroken':
          break
      }
      const readings = disagreement(reason, result)
      const triageReading = (
        <>
          <p className={`triage-cause cause-chip cause-chip--${presentation.chip}`}>{presentation.label}</p>
          <p className="triage-summary">{result.summary}</p>
          <p className="triage-recommendation">
            Recommends {RESOLUTION_COPY[result.resolution].title}
            {result.resolution === 'GrantFixRound' ? ' — only your click grants the paid round.' : null}
          </p>
          {parts ? <div className="triage-evidence">{parts}</div> : null}
        </>
      )
      return (
        <section className="triage-band triage-band--advised" data-rank="triage">
          <span className="triage-label">Triage</span>
          {headLine ? <p>{headLine}</p> : null}
          {readings === null ? (
            triageReading
          ) : (
            <>
              <p className="triage-disagreement">Which reading is right?</p>
              <div className="triage-readings">
                <div>
                  <p className="triage-reading-label">Judge</p>
                  <p className="triage-reading-choice">Chose {readings.judge.chose}</p>
                  {readings.judge.why !== null ? <p className="triage-reading-why">{readings.judge.why}</p> : null}
                  {raw !== null && raw !== undefined && raw.trim() !== '' ? (
                    <RawEvidence raw={raw} said={said ?? null} />
                  ) : null}
                </div>
                <div>
                  <p className="triage-reading-label">Triage</p>
                  {triageReading}
                </div>
              </div>
            </>
          )}
        </section>
      )
    }
  }
}

export function ticketOpening(body: string): { problem: string; want: string; watchOut: string | null } | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  if (!/^\|\s*\|\s*\|\s*$/.test(lines[0] ?? '') || !/^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*$/.test(lines[1] ?? ''))
    return null

  const row = (line: string | undefined, label: string): string | null => {
    if (!line) return null
    const cells = line.split('|')
    if (
      cells.length !== 4 ||
      cells[0] !== '' ||
      cells[3]?.trim() !== '' ||
      cells[1] === undefined ||
      cells[2] === undefined
    )
      return null
    if (cells[1].trim() !== `**${label}**`) return null
    const value = cells[2].trim()
    // A cell is a short, single-line statement. Raw HTML and extra pipes make
    // the table ambiguous; neither gets promoted into a ticket fact.
    if (!value || value.length > MAX_TICKET_CELL || /[<>]/.test(value)) return null
    return value
  }

  const problem = row(lines[2], 'Problem')
  const want = row(lines[3], 'Want')
  const fix = row(lines[4], 'Fix')
  if (problem === null || want === null || fix === null) return null
  const watchOut = row(lines[5], 'Watch out')
  if (lines[5]?.trim().startsWith('|') && watchOut === null) return null
  if (lines[6]?.trim().startsWith('|') || (watchOut === null && lines[5]?.trim().startsWith('|'))) return null
  return { problem, want, watchOut }
}

function TicketContext({ opening, body }: { opening: ReturnType<typeof ticketOpening>; body: string | null }) {
  const references = body?.match(/^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm)?.join('\n') ?? ''
  return (
    <div className="topening">
      {opening === null ? (
        <p>The ticket’s context is in the complete issue.</p>
      ) : (
        <div className="tcontext">
          {(
            [
              ['Problem', opening.problem],
              ['Want', opening.want],
              ['Watch out', opening.watchOut],
            ] as const
          )
            .filter(([, value]) => value !== null)
            .map(([label, value]) => (
              <div className="tcontext-field" key={label}>
                <h2>{label}</h2>
                <DocumentBody
                  source="ticket-body"
                  text={references ? `${value!}\n\n${references}` : value!}
                  rawClass="tbodytext"
                />
              </div>
            ))}
        </div>
      )}
      <a href="#record-ticket">The whole ticket ↓</a>
    </div>
  )
}

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
 * and `pass-5cb24ac5` in two of them. So the state is the readout, *why it
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
  subject,
  body = null,
  want = null,
  project,
  issue,
  taskId,
  discussions,
  discussionBill = emptyBill(),
  outgoing,
  queued,
  unknown,
  progress = null,
  // Renamed on the way in: the component already has a `held` of its own —
  // `describeHold`'s lines, rank 2 and 3's words — and this is a different
  // fact entirely, the rail's own budget (`#415`).
  held: budget = null,
  now = Date.now(),
}: {
  standing: StandingView
  /**
   * What was asked, in one line, under the state and above the reason.
   *
   * **The page is a decision, and this names what is being decided about.**
   * #87 put the title, the body and the URL on this page for that reason and
   * its comment in `task.ts` still says so; #152 then arranged the page into a
   * standing and a record, and the ticket went into the record's last row under
   * the label `prompt` — closed, at the bottom, named after the document that
   * comes second inside it. So a page that opens on *Approve / Send attempt 3 /
   * Leave blocked / Close* identified the thing it was asking about as
   * `ticket-lingtai-159` and nothing else, and arriving from a link meant reading
   * four rows to find out what it was. The fix keeps `BLOCKED` at rank 1 —
   * somebody who already knows the ticket opened this to find out why it
   * stopped (#132) — and gives the subject the line under it.
   *
   * Null when the id is not a work item: there is no ticket to name.
   */
  subject: { ref: string; title: string | null; url: string | null; askedGitHub: boolean } | null
  body?: string | null
  want?: string | null
  /** From the ticket, and null when the id is not a work item — nothing can be decided then. */
  project: string | null
  issue: number | null
  taskId: string
  discussions: DiscussionView[]
  /**
   * Every closed conversation's own total, already folded — `task.totals.byPurpose.Discussion`,
   * `spend`'s Discussion rows for this ticket — so the box's meter agrees with
   * the Attempts label's split rather than re-summing `DiscussionView.costUsd`
   * itself (`#498`).
   */
  discussionBill?: Bill
  /** What the next attempt will be handed. Null when there will not be one. */
  outgoing: OutgoingView | null
  /** Where it is in line and what taking it runs. Null in every other state. */
  queued: QueuedView | null
  /**
   * Why Lingtai cannot say whether this ticket exists at all, when it cannot.
   *
   * The half of #113 that is not a page: a GitHub that will not answer about an
   * item the log has never touched is *"I cannot tell"*, and it used to be a
   * 404 — which says *"it does not exist"*, which is a different sentence and
   * is not one Lingtai is in a position to say.
   */
  unknown?: string | null
  /**
   * Where the run in flight has got to — the board's rail, drawn at rank 2 of
   * a running item and nowhere else in this block.
   *
   * **The card said it and the page could not** (#189): which point, how long
   * it has been there, and what bounds it, on the page about that one run. It
   * was a list of the five points inside a closed attempt, off a fold with no
   * state for *running*, so nothing was lit and `N pending` covered both *not
   * reached* and *never ran*. The same `Rail` the card draws, from the same
   * fold, and its clock ticks here because `Follow` re-renders on an append
   * (#172). Null for a run with nothing on its stream yet.
   */
  progress?: RunProgress | null
  /**
   * The budget line the rail carries beside its sentence — rounds spent
   * against their ceiling, restarts left against theirs (`#415`), composed by
   * `loadTask` so the page and the board's card cannot word one ticket's hold
   * two ways. `Rail` itself only ever prints it in the two non-live readings,
   * so passing it on a running item costs nothing extra there.
   */
  held?: string | null
  /** Fixed only by the development visual gallery. */
  now?: number
}) {
  const held = describeHold(standing)
  const opening = body === null ? null : ticketOpening(body)
  const acting = project !== null && issue !== null
  // What is stopping it and where it is in line — two facts, and the second is
  // not an annotation on the first. `holding` is null for the item that is
  // simply next, which is the answer rather than an omission.
  const stopped = queued === null ? null : holding(queued)
  const inLine = queued === null ? null : place(queued)
  // 0118 §1's own answer to *which controls does this wait allow*, and the
  // only thing the moves row below reads to decide (#442). `[]` where there
  // is no reason to read — a wait that could not be folded, or no wait at all
  // — so every move below is drawn as absent rather than guessed at.
  const allowed = standing.reason === null ? [] : allowedResolutions(standing.reason)
  // There is a document to send exactly when there is one to show. `problem` is
  // the case #76 is about — an unregistered project, a template that is not
  // there — and a Send on a prompt nobody could compose would send whatever the
  // conductor composes later, unseen, which is the opposite of this column.
  //
  // **And not where `AnswerQuestion` is allowed** (#147): what that wait wants
  // is an answer, and sending would put it back in the queue unanswered — the
  // same rule `sendAttempt` enforces on the server (`actions.ts`, #483), so the
  // page and the action can never disagree.
  const sendable =
    outgoing !== null && outgoing.problem === null && !allowed.includes('AnswerQuestion') ? outgoing.attempt : null

  const advised =
    standing.reason !== null && standing.triageStatus !== null
      ? recommendedResolution(standing.reason, standing.triageStatus)
      : null
  const recommended =
    advised === 'GrantFixRound' && !(standing.fixWork && 'head' in standing.fixWork) ? 'Requeue' : advised
  const triageRecommended =
    standing.triageStatus?._tag === 'Done' &&
    standing.triageStatus.result._tag === 'TriageAdvised' &&
    advised === recommended
      ? recommended
      : null
  const closePrefill =
    triageRecommended === 'Close' &&
    standing.triageStatus?._tag === 'Done' &&
    standing.triageStatus.result._tag === 'TriageAdvised'
      ? standing.triageStatus.result.summary
      : null
  const orderedResolutions =
    recommended === null ? allowed : [...allowed].sort((a, b) => Number(b === recommended) - Number(a === recommended))
  // Keep the keyed body editor mounted across Follow refreshes so an unsent
  // draft remains available after somebody else resolves the wait.
  const resolutionCards: Resolution['_tag'][] = acting
    ? standing.state === 'blocked'
      ? orderedResolutions.includes('EditBodyAndRequeue')
        ? orderedResolutions
        : [...orderedResolutions, 'EditBodyAndRequeue']
      : ['EditBodyAndRequeue']
    : []

  // **Amber wins over teal, and that ordering is the whole rule.** If somebody
  // is being waited on, that is what this page exists to say, whatever else is
  // also true — a run that is mid-flight while an approval sits unanswered is
  // still your move. `live` only ever paints when nothing is on you.
  const mark = standing.onYou ? ' onyou' : standing.state === 'running' ? ' live' : ''

  // `describeHold` decides the words. *What happened* is the reason and reads
  // second; what is needed and what is recommended are `soWhat`'s one sentence,
  // and what was already done is the record's (#152).
  const what = held.find((line) => line.part === 'what') ?? null
  // The run whose log is rank 2, when the item is running. See the doc above.
  const following = standing.state === 'running' ? standing.runId : null

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
  const raw = standing.diagnosis?.raw ?? null
  const said = standing.saidBy?.replace(':', ' / ') ?? null

  /**
   * The question, only where nothing better was written down.
   *
   * `question`, `what` and `done` were three sentences saying overlapping
   * things, and the question is the weakest of them — it is a gate's name and a
   * branch, both of which the ranks below say once each. So a diagnosed block
   * drops it, and a block with no diagnosis renders exactly as it always has,
   * which is #83's requirement and every block written before it.
   *
   * Nothing is lost: the wait's own question is verbatim in the history row
   * for the event that carries it.
   */
  const question = standing.diagnosis === null ? standing.question : null
  const cause =
    standing.triageStatus?._tag === 'Done' && standing.triageStatus.result._tag === 'TriageAdvised'
      ? standing.triageStatus.result.cause
      : null
  const triageQuestions =
    cause?._tag === 'UndecidedQuestion'
      ? cause.questions
      : cause?._tag === 'ConflictingHunks'
        ? cause.hunks.flatMap((hunk) => (hunk._tag === 'Divergent' ? [hunk.question] : []))
        : []
  const waiting = standing.state === 'blocked'
  const subjectRef =
    subject === null ? null : subject.url !== null ? (
      <a className="sref" href={subject.url} target="_blank" rel="noreferrer">
        #{subject.ref} ↗
      </a>
    ) : (
      <span className="sref">#{subject.ref}</span>
    )
  const subjectTitle =
    subject === null ? null : (
      <span className="stitle">
        {subject.title ??
          (subject.askedGitHub
            ? 'GitHub did not answer, so the title is not on this page'
            : 'the title is not on this page')}
      </span>
    )
  const stateReadout = (
    <p className="sread" data-rank="state">
      <span className="sstate">{standing.state}</span>
      {standing.since !== null ? (
        <span className="sage" title={standing.since}>
          {inWords(now - Date.parse(standing.since))}
        </span>
      ) : null}
      {inLine !== null ? <span className="sage">{inLine}</span> : null}
    </p>
  )

  return (
    <TriagePicks waitId={standing.state === 'blocked' ? standing.waitId : null} questions={triageQuestions}>
      <section className={`standing${mark}`}>
        {waiting ? (
          <header className="swaiting-head">
            <div className="swaiting-meta">
              {subjectRef}
              {stateReadout}
            </div>
            {subjectTitle !== null ? (
              <h1 className="swaiting-title" data-rank="subject">
                {subjectTitle}
              </h1>
            ) : null}
            {subject !== null ? (
              <div className="sticket">
                {want !== null ? <p className="swant">Triage’s reading: {want}</p> : null}
                <TicketContext opening={opening} body={body} />
              </div>
            ) : null}
          </header>
        ) : subject !== null ? (
          <div className="sticket">
            <p className="ssubject" data-rank="subject">
              {subjectRef}
              {subjectTitle}
            </p>
            {want !== null ? <p className="swant">Triage’s reading: {want}</p> : null}
            <TicketContext opening={opening} body={body} />
          </div>
        ) : null}
        {standing.afterMove ? (
          <section
            className={`saftermove saftermove--${standing.afterMove.result}`}
            aria-label="After the move"
            data-rank="after-move"
          >
            <h2>After the move</h2>
            <p className="saftermove-title">
              <strong>
                {standing.afterMove.result === 'closed'
                  ? 'Closed'
                  : standing.afterMove.result === 'continued'
                    ? 'Continued saved work'
                    : 'Started over from base'}
              </strong>
              <span>
                {standing.afterMove.result === 'closed'
                  ? 'The ticket was closed.'
                  : standing.afterMove.result === 'continued'
                    ? `Continued ${standing.afterMove.ref} at ${standing.afterMove.head}.`
                    : 'The ticket returned to the queue for a new pass from base.'}
              </span>
            </p>
            <p>
              Move: {standing.afterMove.resolution} · by {standing.afterMove.by}
            </p>
            {standing.afterMove.note ? <p>Decision: {standing.afterMove.note}</p> : null}
            <p>Result: {standing.afterMove.reason}</p>
          </section>
        ) : null}
        {standing.bodyOutcome ? (
          <section
            className={`saftermove saftermove--${standing.bodyOutcome.result === 'failed' ? 'failed' : 'partial'}`}
            aria-label="Body update record"
            data-rank="after-move"
          >
            <h2>Body update record</h2>
            <p>{standing.bodyOutcome.result === 'failed' ? 'A body update failed.' : 'A body update was recorded.'}</p>
            <p>{standing.bodyOutcome.detail}</p>
            <p>The body update event does not identify a wait. Current ticket state: {standing.state}.</p>
          </section>
        ) : null}
        {/* The readout. Two values at one weight, and the age is `inWords` — the
          same arithmetic and the same words the card uses for the same
          question, so `4h 12m` means there as it does here. */}
        <section className="swhere" aria-label="Where it is" data-rank="where">
          <h2 className="ssectiontitle">Where it is</h2>
          {waiting ? null : stateReadout}

          {(standing.state === 'running' || standing.state === 'blocked' || standing.afterMove) && progress !== null ? (
            <Rail progress={progress} live={standing.state === 'running'} held={budget} />
          ) : null}

          {/* The reason and what it means, under one neutral rule. Always drawn:
          rank 3 has a sentence in every state, so there is no block with
          nothing under the readout. */}
          <div className="sbody">
            {/* ---- what was asked, in one line (see `subject`) ------------------
            The number is the way out to GitHub, which is where the ticket is
            edited and where a reader goes to argue with it; the title is the
            sentence. The title is null either because GitHub could not be
            asked or because it was never going to be — a `db` project's
            tickets (#384) — and `askedGitHub` is what tells those two apart,
            because only the first may say GitHub did not answer. The number
            still stands on its own either way, because *which ticket this is*
            is a fact the log holds and does not need GitHub to answer. */}
            {/* ---- rank 2: why it stopped, or what it is doing ------------------ */}
            <div className="swhy" data-rank="why">
              {/* Above the log, because it is the answer the log is the detail of:
              *proposed, build 2m34s / 20m* is read in a glance, and the tail
              under it is what that build is printing. `live`, because the
              state is `running` — the lane's word, which is what `Rail` asks
              for rather than its own guess.

              **And a blocked item too, since `#415`.** A held item's rail was
              drawn only while a run was in flight, so the one line a reader
              came here for — what refused, what is left to spend — was
              missing on every card that actually needed it. `live` stays tied
              to `running` alone: a blocked item's pass is not in flight,
              whatever its last phase was. */}
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
                    Lingtai has never touched this ticket and GitHub could not be asked, so whether it exists is not
                    known here: {unknown}
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
                {queued?.dependenciesUnread ? <p className="refusal">{queued.dependenciesUnread}</p> : null}

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

                {standing.state !== 'blocked' || !raw?.trim() ? (
                  <Reason
                    raw={raw}
                    said={said}
                    diagnosed={standing.diagnosis !== null}
                    refused={standing.failed}
                    deciding={standing.deciding}
                    attempt={standing.attempt}
                  />
                ) : null}
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
        </section>

        {standing.state === 'blocked' && standing.reason !== null && standing.triageStatus !== null ? (
          <TriageBand
            reason={standing.reason}
            status={standing.triageStatus}
            headLine={standing.triageHeadLine}
            raw={raw}
            said={said}
          />
        ) : null}

        <section
          className={standing.state === 'blocked' ? 'sresolutions' : 'sactions'}
          aria-label={standing.state === 'blocked' ? 'Resolutions' : 'Actions'}
          data-rank={standing.state === 'blocked' ? 'resolutions' : undefined}
        >
          {standing.state === 'blocked' ? <h2 className="ssectiontitle">Resolutions</h2> : null}

          {/* ---- rank 4: the moves ---------------------------------------------- */}

          {acting && standing.state === 'blocked' && (standing.waitId === null || standing.reason === null) ? (
            <p className="refusal">the wait on this card could not be read — reload and read it again</p>
          ) : null}
          {acting ? (
            <div className="sresolutiongrid" data-rank="moves">
              {resolutionCards.map((tag) => {
                const visible = standing.state === 'blocked' && allowed.includes(tag)
                const waitId = standing.waitId
                const copy = RESOLUTION_COPY[tag]
                const fixUnavailable = tag === 'GrantFixRound' && !(standing.fixWork && 'head' in standing.fixWork)
                const consequence = fixUnavailable
                  ? 'The saved branch and head must be available before a fix round can be granted.'
                  : tag === 'Requeue' && sendable !== null
                    ? `Send the composed prompt for attempt ${sendable}; the new pass starts from base with the recipe’s rounds.`
                    : copy.consequence
                return (
                  <article
                    key={tag}
                    className={`sresolution${triageRecommended === tag ? ' sresolution--recommended' : ''}${!visible ? ' sresolution--draft' : ''}`}
                    data-resolution={visible ? tag : undefined}
                    hidden={!visible && tag !== 'EditBodyAndRequeue'}
                  >
                    {visible ? (
                      <>
                        <div className="sresolutionhead">
                          <h3>{fixUnavailable ? 'Cannot continue saved work' : copy.title}</h3>
                          {triageRecommended === tag ? (
                            <span className="sresolutionbadge">Triage recommended</span>
                          ) : null}
                        </div>
                        <p className="sresolutionconsequence">{consequence}</p>
                        {tag === 'AnswerQuestion' || tag === 'EditBodyAndRequeue' || tag === 'Close' ? (
                          <p className="sresolutioninput">
                            {tag === 'AnswerQuestion'
                              ? 'An answer is required to continue; withdrawing needs no answer.'
                              : tag === 'Close'
                                ? 'A closing reason is required.'
                                : 'Enter the text to add before this can run.'}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    <div className="sresolutionaction">
                      {visible &&
                      tag === 'GrantFixRound' &&
                      standing.fixWork &&
                      'head' in standing.fixWork &&
                      waitId !== null ? (
                        <ContinueFixing
                          project={project}
                          issue={issue}
                          waitId={waitId}
                          onSha={standing.fixWork.head}
                          primary={recommended === 'GrantFixRound'}
                        />
                      ) : null}
                      {visible && tag === 'GrantFixRound' && (!standing.fixWork || 'refusal' in standing.fixWork) ? (
                        <p className="refusal">
                          {standing.fixWork && 'refusal' in standing.fixWork
                            ? standing.fixWork.refusal
                            : 'Saved work could not be verified; reload this wait before continuing.'}
                        </p>
                      ) : null}
                      {visible && tag === 'Approve' && waitId !== null && standing.awaitingSha !== null ? (
                        <Decide
                          project={project}
                          issue={issue}
                          onSha={standing.awaitingSha}
                          waitId={waitId}
                          refusing={standing.failed.length > 0}
                          recommended={recommended === 'Approve' ? 'approve' : null}
                        />
                      ) : null}
                      {visible && tag === 'Approve' && standing.awaitingSha === null ? (
                        <p className="refusal">nothing to approve — this run recorded no sha to continue from</p>
                      ) : null}
                      {visible && tag === 'AnswerQuestion' && waitId !== null ? (
                        <Requeue
                          project={project}
                          issue={issue}
                          waitId={waitId}
                          asked={true}
                          question={standing.askedQuestion}
                          recommended={recommended === 'AnswerQuestion' ? 'answer' : null}
                        />
                      ) : null}
                      {visible && tag === 'Requeue' && sendable !== null && waitId !== null ? (
                        <Send taskId={taskId} attempt={sendable} primary={recommended === 'Requeue'} />
                      ) : null}
                      {visible && tag === 'Requeue' && sendable === null && waitId !== null ? (
                        <Requeue
                          project={project}
                          issue={issue}
                          waitId={waitId}
                          asked={false}
                          question={standing.askedQuestion}
                          recommended={recommended === 'Requeue' ? 'requeue' : null}
                        />
                      ) : null}
                      {tag === 'EditBodyAndRequeue' ? (
                        <EditBodyAndRequeue
                          project={project}
                          issue={issue}
                          waitId={visible ? waitId : null}
                          reason={standing.reason}
                        />
                      ) : null}
                      {visible && tag === 'Close' && waitId !== null ? (
                        <Close
                          key={closePrefill ?? ''}
                          project={project}
                          issue={issue}
                          waitId={waitId}
                          primary={recommended === 'Close'}
                          prefill={closePrefill}
                        />
                      ) : null}
                    </div>
                  </article>
                )
              })}
            </div>
          ) : null}

          {/* The queued item's own row, and it has exactly one move. `lingtai now`
          was the only control this state ever had and it lived in a terminal;
          the page that says why the item is not moving is the page the button
          belongs on. It jumps the backoff, and says so when there is one to
          jump (0028 §3). */}
          {acting && standing.state === 'queued' && queued !== null ? (
            <div className="btnrow smoves" data-rank="moves">
              <RunNow project={project} issue={String(issue)} holding={stopped} />
              {/* Beside it, the opposite move. A queued item has exactly two
              things a person can say about it — *sooner* and *never* — and
              until `#151` the page offered only the first. */}
              <Close project={project} issue={issue} waitId={null} />
            </div>
          ) : null}

          {/* The one control an `approved` item offers (#465's board-recovery
          finding). `WaitResolved{Approve}` already landed, so there is
          nothing left to decide — the only thing that can still be missing
          is the continuation itself, and this is the only way to ask again
          without shell access to the conducting machine. See
          `ScheduleContinuation`'s own comment for what the click now sends
          and why that is what makes it safe (#508). */}
          {acting && standing.state === 'approved' && standing.waitId !== null && standing.approvedSha !== null ? (
            <div className="btnrow smoves" data-rank="moves">
              <ScheduleContinuation
                project={project}
                issue={issue}
                onSha={standing.approvedSha}
                waitId={standing.waitId}
              />
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
                sendable={acting && standing.state === 'blocked' && sendable !== null}
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
              reason={standing.reason}
              triageStatus={standing.triageStatus}
              discussions={discussions}
              discussionTotal={billHasAny(discussionBill) ? billText(discussionBill) : null}
              quiet={standing.state === 'running'}
            />
          </div>
        </section>
      </section>
    </TriagePicks>
  )
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
    standing.needs === null ? null : (describeHold({ needs: standing.needs, diagnosis: null })[0]?.text ?? null)
  const head = needed ?? standing.who
  const rec = standing.diagnosis?.recommendation ?? null
  if (rec === null) return head
  const why = firstClause(rec.why)
  return why === '' ? `${head} — recommends ${rec.action}` : `${head} — recommends ${rec.action}, because ${why}`
}

/** How long rank 3's reason may run before it is clipped. The whole is in the record. */
const CLAUSE_MAX = 160

/**
 * The first sentence of a recommendation's why, flattened to one line.
 *
 * Whitespace and newlines collapse, the first sentence end is the end, and a
 * sentence that is still a paragraph by length is clipped — the same trade
 * `oneLine` makes for the question, for the same reason.
 */
function firstClause(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?](\s|$)/)
  let clause = (end === -1 ? flat : flat.slice(0, end)).replace(/[\s.;:,—-]+$/, '')
  // `Develop has moved` reads as a new sentence after *because*; `CONFLICT`
  // and `PR` are words that stay as written.
  if (/^[A-Z][a-z]/.test(clause)) clause = clause[0]!.toLowerCase() + clause.slice(1)
  return clause.length > CLAUSE_MAX ? `${clause.slice(0, CLAUSE_MAX - 1)}…` : clause
}

/**
 * Rank 8: every identifier the page has, each once, as one muted line in the
 * bar (#152).
 *
 * This was the block's own fourth rank, and the attempt row printed the same
 * run id again as a full uuid — `pass-52feebd1` twice on one page. So the bar
 * says which item and which attempt, and the run id is that link's title; the
 * attempt row is where the id, the shas and the branch are printed, once.
 */
export function Coords({
  standing,
  taskId,
  queued,
}: {
  standing: StandingView
  taskId: string
  queued: QueuedView | null
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
      {queued !== null && queued.problem === null && queued.notOffered === null ? <span>offered by GitHub</span> : null}
      {/* The coordinate is the pointer: which attempt produced this state, and
          the way down to it. `of N` because the number alone reads as the whole
          story on an item that has had three (#102). */}
      {standing.attempt !== null ? (
        <a className="sfrom sptr" href={`#attempt-${standing.attempt}`} title={standing.runId ?? undefined}>
          from attempt {standing.attempt} of {standing.attempts} ↓
        </a>
      ) : null}
    </span>
  )
}

/** The card's weights, said once there and read here. See `page.tsx`'s `HELD_CLASS`. */
const HELD_CLASS: Record<HoldLine['part'], string> = {
  needs: 'needs',
  what: 'diag',
  did: 'did',
  rec: 'rec',
}

/**
 * The holder's words when there is no raw stopping output on the first screen.
 *
 * **A gate's name is not a reason** (#132). *the review gate refused it* is
 * every word true and a reader takes the wrong thing from it — that a reviewer
 * read the diff and found problems. On `#121` the reviewer never ran, the guard
 * hook refused its opening prompt, and the gate's own evidence said so exactly.
 * That evidence was on this page the whole time: three ranks down, at 0.72rem,
 * behind a disclosure, inside the right attempt's gate points.
 *
 * 0118 puts a blocked wait's raw output in Attempts; `Standing` omits this
 * component for that case. The same raw disclosure is also shown beside the
 * judge's reading when triage disagrees.
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
  raw: string | null
  /** The gate that said it, or null when what refused was not a gate. */
  said: string | null
  /** Whether the hold carries a diagnosis at all. See above: it decides the rank. */
  diagnosed: boolean
  /** The named attempt's verdicts that stand failed, by `point:action`. */
  refused: readonly string[]
  deciding: StandingView['deciding']
  /** The attempt rank 4 names, so this rank names one only when it differs. */
  attempt: number | null
}) {
  if (!diagnosed) {
    // The block as it was before #83, and the one deciding line is all it has
    // ever had here. Attributed, because it may be an earlier attempt's.
    if (deciding === null) return null
    return (
      <p className="sevidence">
        <span className="sstep">{deciding.source}</span>
        <span className="sline">{deciding.line}</span>
        {deciding.attempt !== attempt ? (
          <a className="sptr" href={`#attempt-${deciding.attempt}`}>
            in attempt {deciding.attempt} ↓
          </a>
        ) : null}
      </p>
    )
  }

  if (raw === null) {
    // Nothing refused: `what` has already said so in a sentence, and a quote of
    // something else under it would be a cause this hold does not have.
    if (refused.length === 0) return null

    // Something did, and the diagnosis quoted none of it. This attempt's own
    // deciding line is that refusal — `decidingOf` takes the named attempt's
    // first, and it has a failed verdict — so it is this hold's and needs no
    // pointer beside the coordinate rank 4 already is.
    if (deciding !== null && deciding.attempt === attempt) {
      return (
        <p className="sevidence">
          <span className="sstep">{deciding.source}</span>
          <span className="sline">{deciding.line}</span>
        </p>
      )
    }
    const step = refused.at(-1)!.replace(':', ' / ')
    return <p className="sevidence snone">The {step} step refused, and nothing it said was recorded here to quote.</p>
  }

  if (raw.trim() === '') {
    return (
      <p className="sevidence snone">
        {said === null ? 'The refusal' : `The ${said} step`} recorded no output, so there is nothing to quote.
      </p>
    )
  }

  return <RawEvidence raw={raw} said={said} />
}

/** Verbatim stopping evidence, shared by the record and a judge/triage disagreement. */
export function RawEvidence({ raw, said }: { raw: string; said: string | null }) {
  const lines = raw.split('\n').length
  return (
    <details className="sreason" open>
      <summary>
        <span className="sstep">{said ?? 'what refused, verbatim'}</span>
        <span className="ssize">
          {lines} line{lines === 1 ? '' : 's'}
        </span>
      </summary>
      {/* Never markdown, and never a paragraph: design §6's third row and
          #111's, one page along. A log rendered as prose is not that log. */}
      <pre className="sraw">{raw}</pre>
    </details>
  )
}
