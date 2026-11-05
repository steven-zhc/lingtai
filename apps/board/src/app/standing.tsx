import { inWords } from '@lingtai/conductor/queue'
import { MERGE_HUNKS_ONE_BY_ONE, STEPS } from '@lingtai/domain'
// The same subpath `actions.ts`'s `sendAttempt` already reads `allowedResolutions`
// off (#483) — so the page and the server action can never disagree about
// which resolutions a wait allows.
import {
  allowedResolutions,
  recommendedResolution,
  type Resolution,
  type TriageStatus,
  type WaitReason,
} from '@lingtai/domain/wait'
// The subpath, for the reason `board.ts` gives: the barrel pulls the gate
// pipeline in behind it. `describeWaitLines` is pure and lives beside the field it
// reads, so this block, the card and `lingtai status` say the same thing about
// the same hold rather than keeping three copies of the words.
import { describeWaitLines, type WaitLine } from '@lingtai/projector/task-view'
import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'

import type { AttemptProgress } from '@/lib/progress'
import type { OutgoingView } from '@/lib/prompt'
import {
  holding,
  kindOrder,
  place,
  queuedChip,
  queuedSentence,
  runNowCaption,
  whyLabel,
  type InFlight,
  type QueuedView,
} from '@/lib/queued'
import { NO_RESTART_EFFECT, RESOLUTION_COPY, moveTitle } from '@/lib/resolution-copy'
import { billHasAny, billText, emptyBill, type Bill } from '@/lib/spend'
import { attemptTabPath, ticketTabPath } from '@/lib/tabs'
import { stateWord, type DiscussionView, type StandingView, type TaskAnswer } from '@/lib/task'

/**
 * One place that reads GitHub's answer (0118 §2). Until it arrives — or always,
 * while `pending` says the caller has none to give — the place draws its
 * fallback; everything around it is the log's and is never inside a boundary, so
 * a control that does not need GitHub is drawn, hydrated and usable at once.
 */
function Gh({
  g,
  pending,
  fallback = null,
  children,
}: {
  g: Answered<TaskAnswer>
  pending: boolean
  fallback?: ReactNode
  children: (answer: TaskAnswer) => ReactNode
}) {
  if (pending) return <>{fallback}</>
  return (
    <Deferred value={g} fallback={fallback}>
      {children}
    </Deferred>
  )
}

/** Blocked, queued, running and approved pages share one frame: the `swaiting-head` header. The page class and the header both read this. */
export const framed = (state: StandingView['state']): boolean =>
  state === 'blocked' || state === 'queued' || state === 'running' || state === 'approved'

/** The page's class: the waiting page's panel rules reach the queued and running frames by name, never `detail--framed` alone. */
export function detailClass(state: StandingView['state'], afterMove: boolean): string {
  const frame =
    state === 'blocked'
      ? ' detail--waiting'
      : framed(state)
        ? ` detail--framed${state === 'queued' ? ' detail--queued' : state === 'running' ? ' detail--running' : ''}`
        : ''
  return `detail${frame}${state !== 'blocked' && afterMove ? ' detail--resolved' : ''}`
}

/**
 * The queued page's panel (0118 §2): the waiting page's frame, drawn for a
 * ticket in line. `view` is GitHub's half and null until `resolved`; *running
 * now* is the log's and is drawn whichever it is, from the same markup.
 */
function QueuedBand({
  view,
  resolved,
  inFlight,
  project,
  next,
  outgoing,
  children,
}: {
  view: QueuedView | null
  resolved: boolean
  inFlight: InFlight | null
  project: string | null
  /** The attempt the plan and the prompt are for: `attempts + 1`. */
  next: number
  outgoing: OutgoingView | null
  children?: ReactNode
}) {
  const inLine = resolved && view !== null && view.position !== null
  const asking = <Skeleton shape="lines" count={1} label="asking GitHub…" />
  const hold = resolved && view !== null ? holding(view) : null
  const running = inFlight?.running ?? []
  return (
    <section className="triage-band triage-band--advised" data-rank="triage">
      <div className="triage-head">
        <span className="triage-label">
          {resolved && view !== null && view.position === null ? 'Not in line' : 'In line'}
        </span>
        {resolved ? (
          <p className="triage-cause cause-chip cause-chip--queue">
            {view === null ? 'unknown' : queuedChip(view, inFlight)}
          </p>
        ) : (
          <div className="triage-cause cause-chip cause-chip--queue">{asking}</div>
        )}
      </div>
      {resolved ? (
        <p className="triage-summary">
          {view === null ? 'Its place in the queue could not be read.' : queuedSentence(view, inFlight)}
        </p>
      ) : (
        <div className="triage-summary">{asking}</div>
      )}
      {resolved && view !== null && view.problem === null && hold === null ? (
        <p className="triage-recommendation">Nothing is needed from you.</p>
      ) : null}
      <div className="band-facts">
        {inLine ? (
          <div className="fact">
            <span className="fk">{whyLabel(view.position)}</span>
            <span className="fv">{view.kind ?? 'unknown'}</span>
            {kindOrder(view) !== null ? <span className="fs">{kindOrder(view)}</span> : null}
          </div>
        ) : null}
        <div className="fact">
          <span className="fk">running now</span>
          <span className="fv">
            {inFlight === null
              ? 'not known'
              : running.length === 0
                ? 'nothing'
                : running.map((r, i) => (
                    <Fragment key={`${r.project}#${r.issue}`}>
                      {i > 0 ? ', ' : ''}
                      <Link href={`/task/ticket-${r.project}-${r.issue}`}>
                        {r.project === project ? `#${r.issue}` : `${r.project} #${r.issue}`}
                      </Link>
                    </Fragment>
                  ))}
          </span>
          <span className="fs">
            {inFlight === null
              ? 'the slot count is not known'
              : running.length >= inFlight.slots
                ? 'it starts when any of them ends'
                : 'a slot is free'}
          </span>
        </div>
        {resolved ? (
          inLine ? (
            <div className="fact">
              <span className="fk">behind it</span>
              <span className="fv">
                {view.behind ? `#${view.behind.issue} · ${view.behind.kind}` : 'nothing behind it'}
              </span>
            </div>
          ) : null
        ) : (
          <div className="fact">
            <span className="fk">behind it</span>
            <span className="fv">{asking}</span>
          </div>
        )}
      </div>
      {resolved && view?.dependenciesUnread ? <p className="refusal">{view.dependenciesUnread}</p> : null}
      {!resolved || view !== null ? (
        <>
          <h3 className="bandsub">What Attempt {next} will do</h3>
          {!resolved ? (
            <Skeleton shape="lines" count={1} label="asking GitHub…" />
          ) : view?.plan ? (
            <ol className="planlist">
              {view.plan.steps.map((p) => (
                <PlanStep key={p.step} step={p.step} actions={p.actions} skipped={p.skipped} />
              ))}
              {view.plan.steps.some((p) => p.skipped) ? (
                <li className="none">
                  nothing configured at:{' '}
                  {view.plan.steps
                    .filter((p) => p.skipped)
                    .map((p) => p.step)
                    .join(', ')}
                </li>
              ) : null}
              <li className="lim">{limits(view.plan)}</li>
            </ol>
          ) : (
            <p className="empty">{UNREADABLE}</p>
          )}
          {outgoing !== null ? <OutgoingPrompt outgoing={outgoing} next={next} /> : null}
        </>
      ) : null}
      {children}
    </section>
  )
}

function QueuedPanel({
  g,
  pending,
  inFlight,
  project,
  missing,
  next,
  discussion,
  children,
}: {
  g: Answered<TaskAnswer>
  pending: boolean
  inFlight: InFlight | null
  project: string | null
  missing: (a: TaskAnswer) => boolean
  next: number
  /** Outside the `Gh`: an unsent question survives GitHub's answer. */
  discussion: ReactNode
  children: ReactNode
}) {
  return (
    <div className="sreading sreading--advised">
      <Gh
        g={g}
        pending={pending}
        fallback={
          <QueuedBand view={null} resolved={false} inFlight={inFlight} project={project} next={next} outgoing={null}>
            {children}
          </QueuedBand>
        }
      >
        {(a) =>
          missing(a) ? null : (
            <QueuedBand
              view={a.queued}
              resolved
              inFlight={inFlight}
              project={project}
              next={next}
              outgoing={a.outgoing}
            >
              {children}
            </QueuedBand>
          )
        }
      </Gh>
      <div className="spair" data-rank="discussion">
        {discussion}
      </div>
    </div>
  )
}
import { presentCause } from '@/lib/triage-cause'

import { codeSpans } from './code-spans.tsx'
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
import { Deferred, type Answered } from './deferred.tsx'
import { Discussion } from './discussion.tsx'
import { DocumentBody } from './markdown.tsx'
import { Outgoing, OutgoingEditor, OutgoingPrompt } from './outgoing.tsx'
import { PlanStep, Rail, UNREADABLE, limits } from './rail.tsx'
import { FollowedLog } from './run-log.tsx'
import { Skeleton } from './skeleton.tsx'
import { SplitPlan, type SplitControls } from './split-plan.tsx'
import { ResolutionCard, TriageChoices, TriagePicks } from './triage-picks.tsx'

const MAX_TICKET_CELL = 600

/** Agent-written fields stay React text; there is no markdown path in this band. */
export function TriageBand({
  reason,
  status,
  headLine,
  savedHead,
  split,
}: {
  reason: WaitReason
  status: TriageStatus
  headLine?: string | null
  savedHead?: boolean
  split?: SplitControls
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
                    <span className="triage-location" title={fix.line === null ? fix.path : `${fix.path}:${fix.line}`}>
                      <span className="triage-path">{fix.path}</span>
                      {fix.line === null ? null : <span className="triage-line">:{fix.line}</span>}
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
        case 'TicketTooBig':
          parts = cause.split === undefined ? null : <SplitPlan plan={cause.split} controls={split} />
          break
        case 'WrongApproach':
        case 'SetupBroken':
          break
      }
      // Triage's advice is the recommendation, whatever route the judge took:
      // its routing is why this wait exists, and is not drawn as a competing
      // reading (decided 2026-10-25).
      const kept = recommendedResolution(reason, status, { savedHead }) === result.resolution
      return (
        <section id="triage" className="triage-band triage-band--advised" data-rank="triage">
          <div className="triage-head">
            <span className="triage-label">Triage</span>
            <p className={`triage-cause cause-chip cause-chip--${presentation.chip}`}>{presentation.label}</p>
          </div>
          {headLine ? <p>{headLine}</p> : null}
          <p className="triage-summary">{result.summary}</p>
          <p className="triage-recommendation">
            {kept
              ? `Recommends ${RESOLUTION_COPY[result.resolution].title}`
              : cause._tag === 'WrongApproach'
                ? 'The approach is wrong; start over from base instead of continuing saved work.'
                : cause._tag === 'FixableLines' && result.resolution === 'Approve'
                  ? 'Triage suggested approval, which waives the refusal. Use Continue fixing to repair the failed check when saved work is available.'
                  : cause._tag === 'ConflictingHunks' &&
                      recommendedResolution(reason, status, { savedHead }) === 'GrantFixRound'
                    ? `Triage advised ${RESOLUTION_COPY[result.resolution].title}. With ${cause.total} hunk${cause.total === 1 ? '' : 's'} to resolve, a fix round is drawn first instead${cause.hunks.some((h) => h._tag === 'Divergent') ? ': each divergent hunk’s recommended answer goes to the fixer' : ''}.`
                    : `Triage advised ${RESOLUTION_COPY[result.resolution].title}, which this decision does not offer.`}
            {kept && result.resolution === 'GrantFixRound' ? ' — only your click grants the paid round.' : null}
          </p>
          {parts ? (
            <div className="triage-evidence" role="group" aria-label="Triage’s evidence">
              {parts}
            </div>
          ) : null}
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

function TicketContext({
  opening,
  body,
  taskId,
  pending = false,
  problem = null,
}: {
  opening: ReturnType<typeof ticketOpening>
  body: string | null
  taskId: string
  /** GitHub has not answered: the opening is not known yet, which is not the same as there being none. */
  pending?: boolean
  /** GitHub answered and the issue could not be read: said here, so a failed read is not drawn as an issue with no opening. */
  problem?: { text: string; askedGitHub: boolean } | null
}) {
  const references = body?.match(/^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm)?.join('\n') ?? ''
  return (
    <div className={`topening${pending ? '' : ' arrive'}`}>
      {pending ? <Skeleton shape="lines" count={3} label="asking GitHub…" /> : null}
      {problem ? (
        <p className={problem.askedGitHub ? 'refusal' : 'note'}>
          {problem.askedGitHub ? `The issue could not be read from GitHub: ${problem.text}` : problem.text}
        </p>
      ) : null}
      {opening === null ? null : (
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
              <div className={`tcontext-field${label === 'Watch out' ? ' tcontext-field--watch' : ''}`} key={label}>
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
      <Link href={ticketTabPath(taskId)} scroll={false}>
        The whole ticket ↓
      </Link>
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
 * and its recommendation fill into the same block through `describeWaitLines` — and
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
 * and put the discussion below the reducer of the thing it is a conversation
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
/**
 * What a merge-conflict wait recorded about the conflict (#590): the paths, and
 * either GitHub's compare view or the two shas. Nothing at all for a wait that
 * recorded none of them, so an older one reads as it always did.
 */
function ConflictEvidence({
  conflict,
  compareUrl,
}: {
  conflict: { paths: readonly string[] | null; baseSha: string | null; headSha: string | null }
  compareUrl: string | null
}) {
  const { paths, baseSha, headSha } = conflict
  const shas = compareUrl === null && (baseSha !== null || headSha !== null)
  if (!paths?.length && compareUrl === null && !shas) return null
  return (
    <div className="sconflict">
      {paths?.length ? (
        <ul className="sconflict-paths">
          {paths.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {compareUrl !== null ? (
        <a className="sconflict-compare" href={compareUrl} target="_blank" rel="noreferrer">
          compare on GitHub ↗
        </a>
      ) : null}
      {shas ? (
        <p className="sconflict-shas">
          base <code>{baseSha ?? 'unknown'}</code>, branch <code>{headSha ?? 'unknown'}</code>
        </p>
      ) : null}
    </div>
  )
}

export function Standing({
  standing,
  subject,
  body = null,
  want = null,
  compareUrl = null,
  project,
  issue,
  taskId,
  discussions,
  discussionBill = emptyBill(),
  outgoing,
  queued,
  inFlight = null,
  unknown,
  pending = false,
  untouched = false,
  ticketProblem = null,
  github,
  progress = null,
  // Renamed on the way in: the component already has a `held` of its own —
  // `describeWaitLines`'s lines, rank 2 and 3's words — and this is a different
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
  /**
   * GitHub's compare view of the base against the branch, for a merge-conflict
   * wait (#590). Null where there is none to give: tickets not on GitHub, no
   * owner, or a branch that was never pushed — the shas are drawn instead.
   */
  compareUrl?: string | null
  /** From the ticket, and null when the id is not a work item — nothing can be decided then. */
  project: string | null
  issue: number | null
  taskId: string
  discussions: DiscussionView[]
  /**
   * Every closed conversation's own total, already reduced — `task.totals.byPurpose.Discussion`,
   * `spend`'s Discussion rows for this ticket — so the box's meter agrees with
   * the Attempts label's split rather than summing a figure per
   * conversation itself (`#498`).
   */
  discussionBill?: Bill
  /** What the next attempt will be handed. Null when there will not be one. */
  outgoing: OutgoingView | null
  /** Where it is in line and what taking it runs. Null in every other state. */
  queued: QueuedView | null
  /** What the conductor is holding, from the log — never inside a GitHub boundary. Null in every state but queued. */
  inFlight?: InFlight | null
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
   * GitHub has not answered yet (0118 §2), and `body`, `outgoing` and `queued`
   * are null for that reason and not because there is none. The opening, a
   * queued ticket's reasons and Send say *asking GitHub…* / *waiting for GitHub*
   * instead of drawing as if GitHub had said nothing. `DeferredStanding` is the
   * one caller that sets it.
   */
  pending?: boolean
  /**
   * The log has never touched this ticket (`events === 0`), so GitHub's answer
   * decides whether there is anything to act on: the state and the moves wait for
   * it, and a 404 replaces them with *GitHub has no issue #N*. **Everything else —
   * Discussion above all — is drawn at once and in the same place whatever this
   * says**, so the first event does not remount it and an unsent question survives.
   */
  untouched?: boolean
  /** Why the issue's body is null when GitHub answered and it could not be read; drawn in the opening. */
  ticketProblem?: { text: string; askedGitHub: boolean } | null
  /**
   * GitHub's answer — resolved, or the promise `loadTaskAnswer` returned. Each
   * place that reads it is its own boundary (`Gh`), so the log's part of this
   * block, its controls included, never waits. Without it the props above are
   * the answer, already in.
   */
  github?: Answered<TaskAnswer>
  /**
   * Where the run in flight has got to — the board's rail, drawn at rank 2 of
   * a running item and nowhere else in this block.
   *
   * **The card said it and the page could not** (#189): which point, how long
   * it has been there, and what bounds it, on the page about that one run. It
   * was a list of the five points inside a closed attempt, off a reducer with no
   * state for *running*, so nothing was lit and `N pending` covered both *not
   * reached* and *never ran*. The same `Rail` the card draws, from the same
   * reduce, and its clock ticks here because `Follow` re-renders on an append
   * (#172). Null for a run with nothing on its stream yet.
   */
  progress?: AttemptProgress | null
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
  const held = describeWaitLines(standing)
  const g: Answered<TaskAnswer> = github ?? {
    ticket: {
      found: null,
      askedGitHub: ticketProblem?.askedGitHub ?? subject?.askedGitHub ?? false,
      title: null,
      labels: null,
      url: null,
      body,
      problem: ticketProblem?.text ?? null,
    },
    outgoing,
    queued,
  }
  const actable = project !== null && issue !== null
  const missingOf = (a: TaskAnswer) => untouched && a.ticket.found === false && subject !== null
  const unknownOf = (a: TaskAnswer) =>
    unknown ?? (untouched && a.ticket.found === null && a.ticket.askedGitHub ? a.ticket.problem : null)
  // The moves: for an untouched ticket, only once GitHub has said the issue exists.
  const open = (render: (ids: { project: string; issue: number } | null) => ReactNode) =>
    untouched ? (
      <Gh g={g} pending={pending} fallback={render(null)}>
        {(a) => render(actable && !missingOf(a) ? { project, issue } : null)}
      </Gh>
    ) : (
      render(actable ? { project, issue } : null)
    )
  // What is stopping it and where it is in line — two facts, and the second is
  // not an annotation on the first. `holding` is null for the item that is
  // simply next, which is the answer rather than an omission.
  // 0118 §1's own answer to *which controls does this wait allow*, and the
  // only thing the moves row below reads to decide (#442). `[]` where there
  // is no reason to read — a wait that could not be reduced, or no wait at all
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
  const sendableOf = (o: OutgoingView | null) =>
    o !== null && o.problem === null && !allowed.includes('AnswerQuestion') ? o.attempt : null

  // The only place a recommendation is decided is `recommendedResolution`
  // (0118 §1); this page draws what it returns and orders by it (#572). A card
  // that is not drawn cannot be the one drawn first.
  const savedHead = Boolean(standing.fixWork && 'head' in standing.fixWork)
  const triageAdvised =
    standing.triageStatus?._tag === 'Done' && standing.triageStatus.result._tag === 'TriageAdvised'
      ? standing.triageStatus.result
      : null
  const advice =
    standing.reason !== null && standing.triageStatus !== null
      ? recommendedResolution(standing.reason, standing.triageStatus, { savedHead })
      : null
  const closePrefill = triageAdvised?.summary ?? null
  // `Split` has no card until its editor exists (#563): a card with no action
  // under it is worse than none. The triage band still carries the advice.
  const drawable = allowed.filter((tag) => tag !== 'Split')
  // Whatever `recommendedResolution` returned is drawn first; with no saved
  // head it does not return `GrantFixRound`, so nothing is swapped in (#572).
  const recommended = drawable.find((tag) => tag === advice) ?? null
  // Badged only when triage advised it: a wait's own default orders the cards
  // but is not called a recommendation.
  const triageRecommended = triageAdvised !== null ? recommended : null
  const orderedResolutions =
    recommended === null
      ? drawable
      : [...drawable].sort((a, b) => Number(b === recommended) - Number(a === recommended))
  // Keep the keyed body editor mounted across Follow refreshes so an unsent
  // draft remains available after somebody else resolves the wait.
  const resolutionCards: Resolution['_tag'][] = actable
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

  // `describeWaitLines` decides the words. *What happened* is the reason and reads
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
  const waiting = standing.state === 'blocked'
  const isFramed = framed(standing.state)
  const conflict =
    standing.reason?._tag === 'ProposedEscalated' && standing.reason.proposal._tag === 'MergeConflict'
      ? standing.reason.proposal
      : null
  const refOf = (subj: NonNullable<typeof subject>, url: string | null) =>
    url !== null ? (
      <a className="sref" href={url} target="_blank" rel="noreferrer">
        #{subj.ref} ↗
      </a>
    ) : (
      <span className="sref">#{subj.ref}</span>
    )
  const subjectRef =
    subject === null ? null : (
      <Gh g={g} pending={pending} fallback={refOf(subject, subject.url)}>
        {(a) => refOf(subject, a.ticket.url ?? subject.url)}
      </Gh>
    )
  const subjectTitle =
    subject === null ? null : (
      <Gh g={g} pending={pending} fallback={<span className="stitle">{subject.title ?? `#${subject.ref}`}</span>}>
        {(a) => (
          <span className="stitle">
            {a.ticket.title ??
              subject.title ??
              (a.ticket.askedGitHub
                ? 'GitHub did not answer, so the title is not on this page'
                : 'the title is not on this page')}
          </span>
        )}
      </Gh>
    )
  const readout = (inLine: string | null) => (
    <p className="sread" data-rank="state">
      <span className="sstate">{stateWord(standing.state)}</span>
      {standing.since !== null ? (
        <span className="sage" title={standing.since}>
          {inWords(now - Date.parse(standing.since))}
        </span>
      ) : null}
      {inLine !== null ? <span className="sage">{inLine}</span> : null}
    </p>
  )
  const stateReadout = (
    <Gh g={g} pending={pending} fallback={readout(null)}>
      {(a) =>
        subject !== null && missingOf(a) ? (
          <p className="refusal">GitHub has no issue #{subject.ref}</p>
        ) : (
          readout(a.queued === null ? null : place(a.queued))
        )
      }
    </Gh>
  )
  const opening = (
    <Gh g={g} pending={pending} fallback={<TicketContext opening={null} body={null} taskId={taskId} pending />}>
      {(a) => {
        if (missingOf(a)) return null
        const text = a.ticket.body
        return (
          <TicketContext
            opening={text === null ? null : ticketOpening(text)}
            body={text}
            taskId={taskId}
            problem={
              text === null && a.ticket.problem && !unknownOf(a)
                ? { text: a.ticket.problem, askedGitHub: a.ticket.askedGitHub }
                : null
            }
          />
        )
      }}
    </Gh>
  )

  // Never inside a boundary: it needs nothing of GitHub's, and it stays where it is
  // whatever the answer says or the first event does.
  const discussion = (
    <Discussion
      taskId={taskId}
      attempt={standing.attempt}
      reason={standing.reason}
      triageStatus={standing.triageStatus}
      discussions={discussions}
      discussionTotal={billHasAny(discussionBill) ? billText(discussionBill) : null}
      quiet={standing.state === 'running' || standing.state === 'queued'}
    />
  )
  const requeueForm = (
    ids: { project: string; issue: number; waitId: NonNullable<typeof standing.waitId> },
    recommendedAs: 'requeue' | null,
  ) => <Requeue {...ids} asked={false} question={standing.askedQuestion} recommended={recommendedAs} />
  const advisedSurface = standing.triageStatus?._tag === 'Done' && standing.triageStatus.result._tag === 'TriageAdvised'
  // Once triage has advised a wait, its panel says what stopped and why, in the
  // judge's words and triage's. Saying it a second time above that panel, as a
  // section of its own, was the heaviest thing on the page and the least read
  // (0118's Hold has the rail, then triage): the heading, the conductor's
  // sentence and the so-what step back, and anything else this section holds
  // — a conflict's paths, an unknown ticket, a log — still draws.
  const quiet = waiting && advisedSurface
  const soWhatLine = () => {
    const text = soWhat(standing)
    return quiet || text === null ? null : (
      <p className="sowhat" data-rank="so-what">
        {text}
      </p>
    )
  }

  return (
    <TriagePicks
      waitId={standing.state === 'blocked' ? standing.waitId : null}
      cause={cause}
      recommended={triageRecommended}
    >
      <section className={`standing${mark}`}>
        {isFramed ? (
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
                {opening}
              </div>
            ) : null}
            <Gh
              g={g}
              pending={pending}
              fallback={
                progress !== null ? (
                  <Rail progress={progress} live={standing.state === 'running'} held={budget} />
                ) : standing.state === 'queued' ? (
                  <Skeleton shape="cells" count={STEPS.length} label="asking GitHub…" />
                ) : null
              }
            >
              {(a) =>
                progress !== null || a.queued !== null ? (
                  <div className="arrive">
                    <Rail progress={progress} live={standing.state === 'running'} held={budget} plan={a.queued?.plan} />
                  </div>
                ) : null
              }
            </Gh>
          </header>
        ) : subject !== null ? (
          <div className="sticket">
            <p className="ssubject" data-rank="subject">
              {subjectRef}
              {subjectTitle}
            </p>
            {want !== null ? <p className="swant">Triage’s reading: {want}</p> : null}
            {opening}
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
                    : 'The ticket returned to the queue for a new attempt from base.'}
              </span>
            </p>
            <p>
              Decided: {moveTitle(standing.afterMove.resolution)} · by {standing.afterMove.by}
            </p>
            {standing.afterMove.note ? <p>Note: {standing.afterMove.note}</p> : null}
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
            <p>The body update event does not identify a decision. Current ticket state: {standing.state}.</p>
          </section>
        ) : null}
        {/* The readout. Two values at one weight, and the age is `inWords` — the
          same arithmetic and the same words the card uses for the same
          question, so `4h 12m` means there as it does here. */}
        {/* A queued page's place is the panel below, so the section is not drawn
        as *Where it is* there — but it stays mounted, with `FollowedLog` in the
        same place, so a page that follows a run into a requeue keeps the
        tail it had (a live refresh changes the state, never the tree). */}
        <section
          className={`swhere${quiet || standing.state === 'queued' ? ' swhere--quiet' : ''}`}
          aria-label={standing.state === 'queued' ? undefined : 'Where it is'}
          data-rank="where"
        >
          {quiet || standing.state === 'queued' ? null : <h2 className="ssectiontitle">Where it is</h2>}
          {isFramed ? null : stateReadout}

          {!isFramed &&
          (standing.state === 'running' || standing.state === 'blocked' || standing.afterMove) &&
          progress !== null ? (
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
                <Gh g={g} pending={pending}>
                  {(a) => {
                    const why = unknownOf(a)
                    return why ? (
                      <p className="refusal">
                        Lingtai has never touched this ticket and GitHub could not be asked, so whether it exists is not
                        known here: {why}
                      </p>
                    ) : null
                  }}
                </Gh>

                {/* Verbatim, and only where nothing better was written down — see
              `question` above. It is what the conductor wrote, and a page that
              paraphrases it is a second version of the question. */}
                {question !== null && !quiet ? <p className="squestion">{codeSpans(question)}</p> : null}

                {/* What happened, in the diagnosis' own sentence. Absent until #83
              writes one, which is every block written before it. */}
                {what !== null && !quiet ? <p className={HELD_CLASS[what.part]}>{codeSpans(what.text)}</p> : null}

                {conflict !== null ? <ConflictEvidence conflict={conflict} compareUrl={compareUrl} /> : null}

                {standing.state === 'queued' ? null : standing.state !== 'blocked' || !raw?.trim() ? (
                  <Reason
                    raw={raw}
                    said={said}
                    diagnosed={standing.diagnosis !== null}
                    refused={standing.failed}
                    deciding={standing.deciding}
                    attempt={standing.attempt}
                    taskId={taskId}
                  />
                ) : null}
              </FollowedLog>
            </div>

            {/* ---- rank 3: so what ---------------------------------------------- */}

            {/* One sentence in one element. `soWhat` returns a string or null, so there is
            no path by which a second paragraph lands here; a sentence a later
            ticket wants on this page goes to rank 2 or to the record, and the
            snapshots in `task-page.test.tsx` make it say which (#152). */}
            {standing.state === 'queued' ? null : (
              <Gh g={g} pending={pending} fallback={soWhatLine()}>
                {(a) => (missingOf(a) ? null : soWhatLine())}
              </Gh>
            )}
          </div>
        </section>

        {standing.state === 'queued' ? (
          <QueuedPanel
            g={g}
            pending={pending}
            inFlight={inFlight}
            project={project}
            missing={missingOf}
            next={standing.attempts + 1}
            discussion={discussion}
          >
            <LastAttempt deciding={standing.deciding} attempts={standing.attempts} taskId={taskId} />
          </QueuedPanel>
        ) : null}

        {standing.state === 'blocked' ? (
          <div className={`sreading${advisedSurface ? ' sreading--advised' : ''}`}>
            {standing.reason !== null && standing.triageStatus !== null ? (
              <TriageBand
                reason={standing.reason}
                status={standing.triageStatus}
                headLine={standing.triageHeadLine}
                savedHead={savedHead}
                split={
                  standing.split !== undefined && project !== null && issue !== null && standing.waitId !== null
                    ? { project, issue, waitId: standing.waitId, ...standing.split }
                    : undefined
                }
              />
            ) : null}
            <div className="spair" data-rank="discussion">
              {discussion}
            </div>
          </div>
        ) : null}

        <section
          className={standing.state === 'blocked' || standing.state === 'queued' ? 'sresolutions' : 'sactions'}
          aria-label={
            standing.state === 'blocked' ? 'Your decision' : standing.state === 'queued' ? 'Moves' : 'Actions'
          }
          data-rank={standing.state === 'blocked' || standing.state === 'queued' ? 'resolutions' : undefined}
          // The other moves wait while a split is being written; the decision lock refuses them anyway.
          inert={standing.split?.progress.state === 'writing' ? true : undefined}
        >
          {standing.state === 'blocked' ? <h2 className="ssectiontitle">Your decision</h2> : null}
          {standing.state === 'queued' ? <h2 className="ssectiontitle">Moves</h2> : null}

          {/* ---- rank 4: the moves ---------------------------------------------- */}

          {open((ids) => {
            if (ids === null) return null
            const { project, issue } = ids
            return (
              <>
                {standing.state === 'blocked' && (standing.waitId === null || standing.reason === null) ? (
                  <p className="refusal">the decision on this card could not be read — reload and read it again</p>
                ) : null}
                {
                  <div className="sresolutiongrid" data-rank="moves">
                    {resolutionCards.map((tag) => {
                      const visible = standing.state === 'blocked' && allowed.includes(tag)
                      const waitId = standing.waitId
                      const copy = RESOLUTION_COPY[tag]
                      const fixUnavailable =
                        tag === 'GrantFixRound' && !(standing.fixWork && 'head' in standing.fixWork)
                      const consequenceOf = (sendable: number | null) =>
                        fixUnavailable
                          ? 'The saved branch and head must be available before a fix round can be granted.'
                          : tag === 'Requeue' && sendable !== null
                            ? `Send the composed prompt for attempt ${sendable}; the new attempt starts from base with the recipe’s rounds. ${NO_RESTART_EFFECT}`
                            : copy.consequence
                      return (
                        <ResolutionCard
                          key={tag}
                          recommended={triageRecommended === tag}
                          className={`sresolution${!visible ? ' sresolution--draft' : ''}`}
                          data-resolution={visible ? tag : undefined}
                          id={visible ? `resolution-${tag}` : undefined}
                          hidden={!visible && tag !== 'EditBodyAndRequeue'}
                          head={visible ? <h3>{fixUnavailable ? 'Cannot continue saved work' : copy.title}</h3> : null}
                        >
                          {visible ? (
                            <>
                              <p className="sresolutionconsequence">
                                {tag === 'Requeue' ? (
                                  <Gh g={g} pending={pending} fallback={consequenceOf(null)}>
                                    {(a) => consequenceOf(sendableOf(a.outgoing))}
                                  </Gh>
                                ) : (
                                  consequenceOf(null)
                                )}
                              </p>
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
                            {visible &&
                            tag === 'GrantFixRound' &&
                            (!standing.fixWork || 'refusal' in standing.fixWork) ? (
                              <p className="refusal">
                                {standing.fixWork && 'refusal' in standing.fixWork
                                  ? standing.fixWork.refusal
                                  : 'Saved work could not be verified; reload this page before continuing.'}
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
                              <p className="refusal">
                                nothing to approve — this attempt recorded no commit to continue from
                              </p>
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
                            {visible && tag === 'Requeue' && waitId !== null ? (
                              allowed.includes('AnswerQuestion') ? (
                                // Never sendable (#147): the form needs nothing of GitHub's.
                                requeueForm({ project, issue, waitId }, recommended === 'Requeue' ? 'requeue' : null)
                              ) : (
                                // Send needs the body, and the body is GitHub's: drawn disabled,
                                // and said why, until the answer is in.
                                <Gh
                                  g={g}
                                  pending={pending}
                                  fallback={
                                    <button type="button" className="btn" disabled title="waiting for GitHub">
                                      Send · waiting for GitHub
                                    </button>
                                  }
                                >
                                  {(a) => {
                                    const sendable = sendableOf(a.outgoing)
                                    return sendable !== null ? (
                                      <Send taskId={taskId} attempt={sendable} primary={recommended === 'Requeue'} />
                                    ) : (
                                      requeueForm(
                                        { project, issue, waitId },
                                        recommended === 'Requeue' ? 'requeue' : null,
                                      )
                                    )
                                  }}
                                </Gh>
                              )
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
                        </ResolutionCard>
                      )
                    })}
                  </div>
                }

                {/* A queued ticket's moves: three cards, none recommended, none amber. Every
          head and sentence is drawn at once; only the action that needs GitHub's
          answer waits for it. `lingtai now` was the only control this state ever
          had and it lived in a terminal (0028 §3). */}
                {standing.state === 'queued' ? (
                  <div className="sresolutiongrid" data-rank="moves">
                    <ResolutionCard recommended={false} className="sresolution" head={<h3>Run it now</h3>}>
                      <p className="sresolutionconsequence">
                        Taken on the conductor’s next turn, ahead of the queue. It still waits for a free slot.
                      </p>
                      <div className="sresolutionaction">
                        <Gh
                          g={g}
                          pending={pending}
                          fallback={<Skeleton shape="lines" count={1} label="asking GitHub…" />}
                        >
                          {(a) =>
                            a.queued === null ? (
                              <p className="empty">Its place in the queue could not be read.</p>
                            ) : (
                              <RunNow
                                project={project}
                                issue={String(issue)}
                                holding={runNowCaption(a.queued)}
                                primary={false}
                                go
                              />
                            )
                          }
                        </Gh>
                      </div>
                    </ResolutionCard>
                    <ResolutionCard recommended={false} className="sresolution" head={<h3>Edit the prompt</h3>}>
                      <p className="sresolutionconsequence">
                        Change what Attempt {standing.attempts + 1} is sent. The edit applies to Attempt{' '}
                        {standing.attempts + 1} only.
                      </p>
                      <div className="sresolutionaction">
                        <Gh
                          g={g}
                          pending={pending}
                          fallback={<Skeleton shape="lines" count={1} label="asking GitHub…" />}
                        >
                          {(a) =>
                            a.outgoing === null || a.outgoing.problem !== null ? (
                              <p className="empty">The prompt could not be composed, so there is nothing to edit.</p>
                            ) : (
                              <OutgoingEditor taskId={taskId} outgoing={a.outgoing} sendable={false} />
                            )
                          }
                        </Gh>
                      </div>
                    </ResolutionCard>
                    <ResolutionCard recommended={false} className="sresolution" head={<h3>Close the ticket</h3>}>
                      <p className="sresolutionconsequence">{RESOLUTION_COPY.Close.consequence}</p>
                      <div className="sresolutionaction">
                        <Close project={project} issue={issue} waitId={null} />
                      </div>
                    </ResolutionCard>
                  </div>
                ) : null}

                {/* The one control an `approved` item offers (#465's board-recovery
          finding). `WaitResolved{Approve}` already landed, so there is
          nothing left to decide — the only thing that can still be missing
          is the continuation itself, and this is the only way to ask again
          without shell access to the conducting machine. See
          `ScheduleContinuation`'s own comment for what the click now sends
          and why that is what makes it safe (#508). */}
                {standing.state === 'approved' && standing.waitId !== null && standing.approvedSha !== null ? (
                  <div className="btnrow smoves" data-rank="moves">
                    <ScheduleContinuation
                      project={project}
                      issue={issue}
                      onSha={standing.approvedSha}
                      waitId={standing.waitId}
                      grant={standing.afterMove?.resolution === 'GrantFixRound'}
                    />
                  </div>
                ) : null}
              </>
            )
          })}

          {/* ---- rank 5: the outgoing prompt and nonblocked discussion ---------- */}

          {/* On blocked pages Discussion follows triage, before these moves. The
          prompt stays below the moves it belongs to. Other states retain the
          pair: prompt first, then Discussion in reading and tab order. */}
          {standing.state === 'queued' ? null : (
            <div className="spair" data-rank="pair">
              {/* The document that will actually run, beside the discussion and under
            the buttons that send it. Only where there is a next attempt to be
            handed one — a run in flight has already been given its prompt
            (`loadTask`). */}
              <Gh g={g} pending={pending}>
                {(a) =>
                  a.outgoing === null ? null : (
                    <Outgoing
                      taskId={taskId}
                      outgoing={a.outgoing}
                      // The editor offers Send only where the row above it does. A
                      // sentence typed and not staged is otherwise lost to the click that
                      // was meant to send it.
                      sendable={actable && standing.state === 'blocked' && sendableOf(a.outgoing) !== null}
                      // Reduced where the opening above already says it; open on blocked,
                      // where Send is the move.
                      reduced={standing.state === 'queued' || standing.state === 'approved'}
                    />
                  )
                }
              </Gh>

              {/* Discussion is offered in every state; only its placement changes. */}
              {standing.state === 'blocked' ? null : discussion}
            </div>
          )}
        </section>
      </section>
    </TriagePicks>
  )
}

/**
 * Rank 3: what the quote means for the decision, in one sentence.
 *
 * **A string, so it cannot be a paragraph** (#152). What it replaces was
 * `describeWaitLines`'s lines printed one after another — *your judgement is
 * needed*, then the fix rounds and the decline (#142), then the recommendation
 * with the restart refusal (0040) inside its why — which were four tickets'
 * sentences and nobody's one. So: who is needed, and the move the diagnosis
 * recommends with the first clause of its reason, and it stops. What was done,
 * and the rest of the why, are in the record's attempts row.
 *
 * A blocked item says the recommendation alone, or nothing (null) when it has
 * none: who is waited on is the state word's to say. Every other state says who
 * is being waited on, which is the fact a running or a queued item's reader
 * came for.
 */
export function soWhat(standing: StandingView): string | null {
  if (standing.state !== 'blocked') return standing.who
  const rec = standing.diagnosis?.recommendation ?? null
  if (rec === null) return null
  const why = firstClause(rec.why)
  return why === '' ? `recommends ${rec.action}` : `recommends ${rec.action}, because ${why}`
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
  /** Null until GitHub has answered, and for every state but `queued`: *offered by GitHub* is omitted then. */
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
          claiming a reducer it did not make (0012). */}
      {queued !== null && queued.problem === null && queued.notOffered === null ? <span>offered by GitHub</span> : null}
      {/* The coordinate is the pointer: which attempt produced this state, and
          the way down to it. `of N` because the number alone reads as the whole
          story on an item that has had three (#102). */}
      {standing.attempt !== null ? (
        <Link
          className="sfrom sptr"
          href={attemptTabPath(taskId, standing.attempt)}
          scroll={false}
          title={standing.runId ?? undefined}
        >
          {standing.state === 'queued' ? 'after' : 'from'} Attempt {standing.attempt} of {standing.attempts} ↓
        </Link>
      ) : null}
    </span>
  )
}

/** The card's weights, said once there and read here. See `page.tsx`'s `HELD_CLASS`. */
const HELD_CLASS: Record<WaitLine['part'], string> = {
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
  taskId,
}: {
  taskId: string
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
          <Link className="sptr" href={attemptTabPath(taskId, deciding.attempt)} scroll={false}>
            in Attempt {deciding.attempt} ↓
          </Link>
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

/**
 * The queued page's refusal: the last pass's, whole, and named as such. The
 * label drops "the last pass" when the refusal is an earlier attempt's.
 */
function LastAttempt({
  deciding,
  attempts,
  taskId,
}: {
  deciding: StandingView['deciding']
  attempts: number
  taskId: string
}) {
  if (deciding === null) return null
  const lead =
    deciding.attempt === attempts ? `the last attempt, attempt ${deciding.attempt}` : `attempt ${deciding.attempt}`
  const label = `${lead} · ${deciding.fromStep ? 'stopped at ' : ''}${deciding.source}`
  if (deciding.evidence?.trim())
    return (
      <>
        <RawEvidence raw={deciding.evidence} said={label} />
        <Link className="sptr" href={attemptTabPath(taskId, deciding.attempt)} scroll={false}>
          ↓
        </Link>
      </>
    )
  return (
    <p className="sevidence">
      <span className="sstep">{label}</span>
      <span className="sline">{deciding.line}</span>
      <Link className="sptr" href={attemptTabPath(taskId, deciding.attempt)} scroll={false}>
        ↓
      </Link>
    </p>
  )
}

/** Verbatim stopping evidence, as the record's Attempts tab shows it. */
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

type StandingProps = Parameters<typeof Standing>[0]

/**
 * `Standing`, with the parts only GitHub's answer knows read where they are drawn
 * (0118 §2): the heading's title and link, the opening, Send, a queued ticket's
 * reasons and plan. Until it arrives the block is drawn with `pending`, from the
 * log alone — the state line says what the log says, and each place that waits
 * says so.
 *
 * **`untouched` is a ticket the log has never touched** (`events === 0`): there
 * the answer decides whether there is anything to act on. Until it is in, no move
 * is offered; a 404 replaces the state and the moves with the sentence, and no
 * queued line is drawn; a GitHub that could not be asked says so and offers the
 * moves, as it always did (#113). **The component tree is the same for every
 * `events`**: only those places read `untouched`, so Discussion is never inside a
 * boundary and an unsent question survives the ticket's first event.
 */
export function DeferredStanding({
  answer,
  untouched,
  ...props
}: Omit<
  StandingProps,
  'body' | 'outgoing' | 'queued' | 'unknown' | 'pending' | 'github' | 'ticketProblem' | 'untouched'
> & {
  answer: Answered<TaskAnswer>
  untouched: boolean
}) {
  // One tree whatever `untouched` says: the first event on a ticket changes a
  // prop, never the component's ancestry, so nothing typed into it is remounted.
  return <Standing {...props} github={answer} untouched={untouched} outgoing={null} queued={null} />
}

/** `Coords`, with *offered by GitHub* omitted until the answer is in (0118 §2). */
export function DeferredCoords({
  answer,
  ...props
}: { answer: Answered<TaskAnswer> } & Omit<Parameters<typeof Coords>[0], 'queued'>) {
  return (
    <Deferred value={answer} fallback={<Coords {...props} queued={null} />}>
      {(a) => <Coords {...props} queued={a.queued} />}
    </Deferred>
  )
}
