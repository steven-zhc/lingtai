import { githubClientFor, projectClient, projectFilter, type StepPlan } from '@lingtai/conductor/filter'
import { ownerlessClient } from '@lingtai/conductor/ownerless'
import { currentRecipe, loadProject } from '@lingtai/conductor/projects'
import { readProjectTicket } from '@lingtai/conductor/read-ticket'
import { readControl, readStatus } from '@lingtai/daemon/control'
import {
  agentBranchOf,
  emptyControl,
  evaluateControl,
  chatStream,
  reduceChat,
  reduceTicket,
  claimShapeOf,
  splitProgressOf,
  isAttemptStream,
  parseTicketStream,
  triageFactsOf,
  waitWords,
  type BlockDiagnosis,
  type Envelope,
  type PayloadOf,
  type TicketClaim,
  type TicketDiscussion,
  type SplitProgress,
  type WaitId,
  type TicketLifecycle,
  reduceAttempt,
  filesOf,
  STEPS,
  type AttemptState as DomainRunState,
} from '@lingtai/domain'
import {
  allowedResolutions,
  triageStatus,
  type AttemptRef,
  type TriageStatus,
  type WaitReason,
} from '@lingtai/domain/wait'
import { hasGitHubAuth } from '@lingtai/env'
/**
 * One task, reduced from its streams on demand.
 *
 * Nothing here is maintained in a table. A detail view is read rarely, by one
 * person, about one task — reducing a few dozen events on the spot is
 * imperceptible, and it means what this shows can change without a migration or
 * a rebuild ([0012](../../../../doc/decisions-archive/0012-one-task-view.md)).
 *
 * **The unit is the attempt.** The log keeps one stream per run and this used to
 * flatten what the log divided: a single `runId` — the most recent — and one
 * `history` with every run's events interleaved into it, so `ticket-lingtai-87`'s
 * three claims read as one 80-row list whose only marker of which attempt a row
 * belonged to was a 36-character uuid inside the row's collapsed body (#102).
 * Two things followed from that flattening and are fixed by ending it: gates
 * were a page-level section though a gate runs once *per attempt*, and nothing
 * was ever totalled although `RunFinished` carries `costUsd`, `turns` and
 * `durationMs` on every run.
 *
 * So: `runs`, oldest first, each carrying its own money, its own prompt, its own
 * files and its own verdicts; and a history still whole, still in order, but
 * grouped the way the log already divides it
 * ([the task page's design](../../../../doc/design/task-detail-page.md) §1).
 *
 * It reads the item's stream and every run's. They are separate aggregates on
 * purpose (design.md §4), and joining them is a reader's job rather than a
 * reducer's.
 *
 * It also asks GitHub one question — what the ticket says — for the same
 * reason the board's Queued column does (`board.ts`): the issue body and its
 * labels are facts about GitHub and not about the log, so there is nothing to
 * reduce for them. That question is allowed to fail, and its failure is a line
 * on the page rather than an absence (#76).
 *
 * The reducers below take envelopes and return plain data, so what this page
 * *says* about a run is testable without a database — the same split
 * `history.ts` makes one level down.
 */
import { eventStore } from '@lingtai/event-store'
// For the one distinction a message cannot carry: `status === 404` is GitHub
// saying the issue is not there, and every other failure is GitHub not saying
// anything. See `TicketView.found`.
import { GitHubError } from '@lingtai/github'
import type { SpendRow } from '@lingtai/projector'
import { readTasks, type TaskCard } from '@lingtai/projector/task-view'
import { ticketSourceOf } from '@lingtai/recipe/settings'
import { mirrorBranchSha, mirrorPathFor, refSha } from '@lingtai/repo'
import { cache } from 'react'

import {
  emptyIfUnbuilt,
  compareUrl,
  issueUrl,
  triageContextOf,
  waitingNeighbours,
  type AttemptLimitsView,
  type WaitingNeighbour,
} from './board.ts'
import { type HistoryLine, toLine } from './history.ts'
import { describeHeld, elapsed, progressOf, spentOf, type AttemptProgress } from './progress.ts'
import { outgoingFor, refused as refusedOutgoing, type OutgoingView } from './prompt.ts'
import { queuedFor, refused as refusedQueued, type QueuedView } from './queued.ts'
import { recipeOfAttempt, type AttemptRecipe } from './recipe.ts'
import { savedFixWork } from './saved-fix-work.ts'
import { boardWriterOrNone } from './snapshot-writer.ts'
import {
  addBill,
  billHasAny,
  billOf,
  billText,
  currentSpend,
  emptyBill,
  grantedOf,
  PURPOSES,
  totalBill,
  unknownBill,
  type Bill,
  type Purpose,
  type SpendCurrency,
} from './spend.ts'
import { isSplitRunning, splitInstance } from './split-instance.ts'
import { timed } from './timing.ts'
import { triageHeadLine } from './triage-head.ts'

export interface Finding {
  file: string
  line: number | null
  claim: string
  failureScenario: string
  severity: string
}

export interface StepVerdict {
  step: string
  state: string
  /**
   * True when the verdict was made against a commit that is no longer the
   * head. A force-push revokes nothing; it makes every verdict about a
   * different diff.
   */
  stale: boolean
  evidence: string | null
  findings: Finding[]
}

/**
 * What was asked, as against what was done.
 *
 * The page had no reference to a title, a body or a URL: it opened on Gates,
 * and finding out what the ticket wanted meant going back to the board, reading
 * the card, and opening GitHub (#87). A detail page is where somebody decides,
 * and deciding needs the request and not only the response.
 *
 * **Loading it was never the hard half, and for a while this comment was the
 * only place that still claimed otherwise.** #152 arranged the page into a
 * standing and a record, and all of this went into the record's last row —
 * closed, at the foot of the page, labelled `prompt` after the document that
 * comes second inside it. Measured on `ticket-lingtai-159`: the GitHub link sat at
 * y=1103 of an 1126px page and the title rendered nowhere, on a screen whose
 * first control is *Approve*. `title` and `url` now also go to `Standing` as
 * its `subject`, one line under the state; the row is `ticket` and keeps the
 * body. The fields below did not change — where they are read did.
 *
 * Two sources, in this order. The **log** carries the title and the kind as
 * they were when Lingtai took responsibility, which is true whether or not
 * GitHub answers now. **GitHub** carries the body, the labels and the URL,
 * which the log has never held and which 0012 is the reason not to start
 * holding.
 */
export interface TicketView {
  project: string
  /** The issue number, as GitHub numbers it. */
  ref: string
  title: string | null
  kind: string | null
  labels: string[]
  /** From GitHub, or built from the owner the project stream recorded. */
  url: string | null
  /**
   * GitHub's compare view of the base against `agent/<n>`, for a merge-conflict
   * wait (#590). Null where tickets are not on GitHub; `loadTask` also clears it
   * when the branch was never pushed.
   */
  compareUrl: string | null
  body: string | null
  /**
   * Whether this issue exists: **true**, **false**, or **null for "I could not
   * ask"**.
   *
   * Three values because two of them were being flattened into one 404 (#113).
   * A ticket Lingtai has never touched has no stream, so `loadTask` found
   * nothing and the route called `notFound()` — and *it does not exist* and *I
   * have not touched it* are different answers, given to every card in the one
   * column the board leads with.
   *
   * `false` is a definite absence: GitHub answered 404, or the project is not
   * one Lingtai has been told about, in which case it cannot have this work
   * item. `null` is either GitHub not answering — a rate limit, a revoked
   * installation, an App that cannot reach the repository — or GitHub never
   * being asked at all, because the project's tickets are not on GitHub to
   * begin with (`tickets === 'db'` and the read failed, #731). It must never become a 404,
   * because a page that says *this does not exist* when it means *I cannot
   * tell* is exactly the flattening this field exists to end. Which of the two
   * `null` is, `askedGitHub` says.
   */
  found: boolean | null
  /**
   * Whether `problem` is GitHub refusing to answer, as opposed to a reason
   * nothing was asked in the first place — an unregistered project, or
   * tickets that live in the database rather than on GitHub (#384), which are
   * read from the table (#731) and so are `false` here whether they were found or not.
   *
   * The renderers wrap `problem` in a sentence that names GitHub; this is what
   * tells them whether that sentence is true. `found === null` alone cannot,
   * because both reasons leave it `null`.
   */
  askedGitHub: boolean
  /**
   * Why the body and the labels are not here, when they are not.
   *
   * Said rather than left blank. An unreachable App, an unregistered project
   * and a deleted issue all render as a ticket with no body, and only the
   * reason tells them apart — the same argument #76 made about an empty Queued
   * column.
   */
  problem: string | null
}

/**
 * How an attempt ended, in the log's own words.
 *
 * Six, because the last three are the ones a `runId` and a gate list could never
 * say. `claimed` is a run whose stream is empty — the claim landed and nothing
 * followed it; `released` is a claim given back without the run ever finishing;
 * `asked` is an attempt stopped waiting for a person (D13), or one that ended
 * asking and was never released. All used to render as an attempt that was
 * simply missing, which is the same complaint `skipped` answers one level up.
 */
export type AttemptState = 'claimed' | 'running' | 'asked' | 'released' | 'finished' | 'failed'

export interface RunOutcome {
  state: AttemptState
  /**
   * What the log said beside the word: a failure's `kind`, a non-zero exit, the
   * release's reason. Null when the word is the whole of it.
   *
   * A pointer and not a copy (design §2) — the whole of a failure is one row
   * down in this attempt's own history, and printing it twice is how two copies
   * of one fact come to disagree.
   */
  detail: string | null
}

/** A path the agent touched, and what it did to it. */
export interface TouchedFile {
  path: string
  op: string
}

/**
 * The document the agent was handed.
 *
 * Raw wherever it is shown — `markdown.ts` §6 — because #88's whole
 * justification is that the log holds the exact bytes that were sent.
 */
export interface PromptView {
  version: string
  bytes: number
  /** Null for a v1 `RunPrompted`, which recorded the length and not the document. */
  text: string | null
}

/** One attempt, whole. */
export interface AttemptView {
  runId: string
  /** 1-based, in the order this item's claims were made. */
  attempt: number
  /** When the claim landed, ISO. */
  at: string
  baseSha: string | null
  headSha: string | null
  /**
   * The recipe this run was given, as `StepsResolved` hashed it. Null where the
   * stream has no `StepsResolved`, which is a run whose recipe nothing can
   * prove (#190).
   */
  configHash: string | null
  /**
   * The recipe the page shows beside this attempt's gate actions, and whether
   * it is provably this run's — see `AttemptRecipe`. Absent where nothing asked:
   * a reducer on its own has no GitHub to ask, and `loadTask` fills it in.
   */
  recipe?: AttemptRecipe
  /** From `RunFinished`. Null until it lands, and for a run that never got there. */
  turns: number | null
  /**
   * Every purpose's bill reduced into one, over the `spend` rows whose `pass`
   * is this run's own stream (`#498`). `presentAttemptEvents` cannot read it — there is no
   * database inside a pure reduce — so it returns an empty bill here and
   * `loadTask` fills it in, the same way it fills in `recipe`.
   */
  costUsd: Bill
  durationMs: number | null
  outcome: RunOutcome
  /** Every path, once, in the order it was first touched. */
  files: TouchedFile[]
  diff: { branch: string; files: number; insertions: number; deletions: number } | null
  prompt: PromptView | null
  /**
   * The sha an open approval is *asking* about, and null when nothing is asked.
   *
   * Not `headSha`, which is what the run *produced*: a branch repaired and
   * approval re-requested moves this and leaves that where it was, and sending
   * the wrong one is an Approve that refuses what `lingtai approve` accepts
   * (#92). The same rule `task_view.awaiting_sha` reduces, read off the run's own
   * stream because that is where the approval events land.
   */
  awaitingSha: string | null
  steps: StepVerdict[]
  /**
   * Where this attempt got to, as the board's rail reads it — all ten steps,
   * one verdict per action, and the phase in flight with its bound. Null for a
   * claim whose stream is empty: there is no start to measure from.
   *
   * **`progress.ts`'s reduce, and not one of this file's.** This used to be
   * `points: PointView[]`, a second reduce over the same events that had
   * `skipped`, *has verdicts* and *fewer verdicts than planned* — and so no
   * `running` and no `never-ran`. It cited 0016 §4 and could not keep it: a
   * point configured and never run arrived as `N pending`, the word for *not
   * reached yet* (#189). With the rail on this page `PointView` had no reader
   * left that `AttemptProgress` does not serve better, so it went rather than
   * stayed a second opinion — two reduces over one stream is how they came
   * apart.
   */
  progress: AttemptProgress | null
}

/**
 * What the attempts cost, added up, by purpose (`#498`, 0110 §7).
 *
 * On the section's own label rather than in a band of its own: a summary that
 * sits apart from what it summarises is a second copy of the same arithmetic,
 * and the two disagree the first time one of them is changed (design, layout
 * notes).
 *
 * **Five bills, not two.** *Answering* is apart from *Work* for the reason
 * the board keeps it apart (#84): a repair was default-on and spent an agent
 * without being asked again, so reducing the two into one figure is exactly
 * the invisible bill. *Judge* and *Triage* are new here — `task_view` never
 * carried either — and *Discussion* is apart from the attempts' for the
 * reason it always was: discussions come out of the same budget, and 0033 §4
 * gives one a meter rather than a limit, so hiding its number inside another
 * one would make the person who is supposed to be the limit unable to see
 * what they are limiting.
 *
 * `discussions` arrived with `#105`, counting conversations rather than
 * dollars — the dollars are `byPurpose.Discussion` now.
 */
export interface Totals {
  attempts: number
  turns: number
  durationMs: number
  /** How many conversations have been held about this item. */
  discussions: number
  byPurpose: Record<Purpose, Bill>
}

/**
 * The one deciding line, and the attempt that holds the whole of it.
 *
 * A **pointer, and never a copy** (design §2). The failing gate's output, its
 * findings and its diff are inside that attempt, once; printing the whole of it
 * at the top as well is how two copies of one fact come to disagree — the same
 * argument `RunOutcome.detail` already makes one section down.
 */
export interface Deciding {
  /** 1-based, and an anchor: the ledger marks this attempt and opens it. */
  attempt: number
  /** `proposed / build`, or the attempt's own outcome when no gate refused. */
  source: string
  /** One line. Clipped, because the whole of it is one click away. */
  line: string
  /**
   * The refusal's whole evidence, verbatim and never clipped; null when none was
   * recorded. An added field: `line` is also the blocked page's `Reason` fallback.
   */
  evidence: string | null
  /** True when `source` is a step (`proposed / build`), false when it is an attempt's outcome. */
  fromStep: boolean
}

/** `queued` and `running` are the lifecycle's `backlog` and `claimed`, in the board's words. */
export type StandingState = 'queued' | 'running' | 'blocked' | 'landed' | 'closed' | 'approved'

/**
 * The word the page draws for a state. `blocked` is the reducer's value for an item
 * a person must answer, and drawn big it read as a fault on a pass that was held
 * for approval exactly as the recipe asked — the page's own prose already says
 * `waiting on you` (`whoWaits`). A `Record`, so a seventh state cannot fall back
 * to printing the raw enum.
 */
const STATE_WORD: Record<StandingState, string> = {
  queued: 'queued',
  running: 'running',
  blocked: 'waiting for you',
  landed: 'landed',
  closed: 'closed',
  approved: 'approved',
}

export function stateWord(state: StandingState): string {
  return STATE_WORD[state]
}

/**
 * Why this task is not moving — the answer the page never gave.
 *
 * The most frequent reason anybody opens this page is that a card has stopped,
 * and the state had to be inferred by reading to the bottom of a 30–80 row
 * history. On 2026-09-08 that produced a wrong reading four times (#80, #87,
 * #89, #94) — including one where the item was **not** stuck and would have
 * returned on its own, which is why `queued` and `running` say so here rather
 * than being an absence of the word `blocked`.
 *
 * Two values of equal weight: the state, and **how long it has held**. The
 * second is not an annotation on the first — *blocked* and *blocked for four
 * days* are different facts, and only the second is an emergency.
 *
 * Reduced from the item's own stream through `reduceTicketEvent`, so the word here
 * is the aggregate's and not a second opinion about it. What the log cannot
 * say — the diagnosis, the recommendation — is null until #83 writes one, and
 * the block renders without it.
 */
export interface StandingView {
  state: StandingState
  /** The last person's move, only when its resulting lifecycle is still current. */
  afterMove?: {
    resolution: string
    by: string
    note: string
    result: 'closed' | 'requeued' | 'continued'
    reason: string
    ref?: string
    head?: string
  } | null
  /** Render-time check only; resolveWait checks the remote again under the decision lock. */
  fixWork?: { head: string; ref: string } | { refusal: string } | null
  /** A body I/O fact on this stream; these events do not identify a wait. */
  bodyOutcome?: { result: 'updated' | 'failed'; detail: string } | null
  /** Derived for this wait alone, after matching the projection row. */
  triageStatus: TriageStatus | null
  /** A comparison with the local mirror, only for a completed current triage. */
  triageHeadLine?: string | null
  /** The split write the log shows for this wait, where Split is offered (#603). */
  split?: { progress: SplitProgress; tickets: 'github' | 'db' }
  /**
   * When the state began, ISO — the event that *moved* the lifecycle, not the
   * last event on the stream. A gate reporting on a blocked item does not
   * restart the clock on how long you have been the bottleneck.
   *
   * **Null when the log has never touched this item**, which is every ticket
   * GitHub is offering and nothing has run (#113). There is no timestamp for
   * one — neither the log nor the issue list supplies it — and this used to
   * fall back to `new Date()`, which would put *queued now* on a ticket that
   * has sat open for a week. The card refuses the render clock for exactly
   * this reason (`BoardCard.updatedAt`) and so does this.
   */
  since: string | null
  /**
   * Whether a person is the thing being waited on.
   *
   * The one condition under which this block is allowed to be amber. Amber
   * means *a human is being waited on* and nothing else in the palette does, so
   * a running item's block is drawn in neutrals (layout notes).
   */
  onYou: boolean
  /** Who is being waited on, in words: `waiting on you`, `an agent is working`, … */
  who: string
  /**
   * The question, as its one deciding line. Null when nothing was asked.
   *
   * **Not verbatim, and that is the fix.** A wait's own question is a
   * sentence with a gate's tail appended to it — `pnpm typecheck` with fifteen
   * workspace projects announcing themselves — and a `<p>` collapses its
   * newlines, so the block opened with an entire build log flattened into prose.
   * That is what `markdown.ts`'s third rule forbids: *a log rendered as
   * markdown is not that log*, and rendered as a paragraph it is not either
   * (#106, #111).
   *
   * So the first line that says anything, clipped, and the rest where the rest
   * already is: inside the attempt `deciding` names, and untouched in the
   * history row for the event itself. One deciding line plus a pointer is
   * design §2 applied to the question as well as to the evidence.
   */
  question: string | null
  /** `judgement` or `acknowledgement`; null on every block written before #83. */
  needs: 'judgement' | 'acknowledgement' | null
  /** What happened, what was done, what is recommended. Null until #83 fills it. */
  diagnosis: BlockDiagnosis | null
  /** Which attempt produced this state, 1-based, and null when none has. */
  attempt: number | null
  /** How many there have been, so `attempt 2 of 2` can be said. */
  attempts: number
  runId: string | null
  /**
   * The sha an open question is about — what Approve must send, and null when
   * there is nothing Approve could do (#84). Requeue is offered either way
   * (#150).
   */
  awaitingSha: string | null
  /**
   * Whether the block is a question asked before any run (`lingtai ask`, #147).
   * Read off the lifecycle and not `runId` above, which falls back to the last
   * attempt there was. Then the moves are Answer and Withdraw: Send would hand
   * the question to `requeue()`, which withdraws it.
   */
  asked: boolean
  /**
   * That question whole, when `asked` — `question` above is clipped to a line,
   * and Answer sends this so `answer()` can refuse one that has since changed.
   */
  askedQuestion: string | null
  /** What that attempt produced, for a waiver, which is a verdict about the diff. */
  headSha: string | null
  /**
   * The verdicts that refused, by `point:action`. Whether to ask for a reason
   * before Approve; `approve()` reads the gates it waives off the run (#150).
   */
  failed: string[]
  /**
   * The failed verdict whose evidence `diagnosis.raw` is, by `point:action` — and
   * null when the quote is not any gate's words.
   *
   * Not `failed.at(-1)`. A hold the merge lane wrote carries git's output in
   * `raw`, and a gate that failed earlier on the same run (and was merged over)
   * is still in `failed`; naming the quote from that list heads a conflict with a
   * build gate's name, which is a cause the words never had (#132). So the name
   * is only given where the gate's own evidence is what was quoted.
   */
  saidBy: string | null
  deciding: Deciding | null
  /**
   * How many approaches this ticket has abandoned, and the ceiling of the
   * arm that bought it — `item.restarts.length` and the last record's `of`,
   * read off `reduceTicketEvent` rather than re-reduced here (`#415`).
   *
   * The same two numbers `TaskCard.restarts`/`.restartsOf` carry, so the
   * page's own `held` line and the board's cannot word one ticket's budget
   * two ways. **`restartsOf` is zero regardless of `restarts`, since `#502`**
   * — `TicketReleased{cause: Restart}` carries `{after, restart}` alone, so
   * there is no ceiling left on any event for this reduce to read, however
   * many times the ticket has restarted. `describeArm` (#504) no longer
   * reads this column at all — every caller passes the recipe's own
   * `limits.restarts` as the ceiling directly — and `describeHeld` falls
   * back to that same `limits.restarts` wherever this reads zero.
   */
  restarts: number
  restartsOf: number
  /**
   * The wait a card renders, so `Approve`/`Requeue`/`AnswerQuestion`/`Close`
   * can send back **the wait it was shown**, not whatever the ticket is
   * blocked on by the time the click lands (#465). Set while `blocked` *and*
   * while `approved` (#508) — an `approved` item still names the wait
   * `WaitResolved{Approve}` resolved, which is exactly what
   * `ScheduleContinuation` has to send back so a click made after the item
   * has since moved to a *new* wait is refused by name rather than resolving
   * whatever is open now. Null only off the render path entirely (a command
   * run under `deciding` reads and resolves inside one lock hold, so sending
   * nothing there is correct) or on a card with neither status.
   */
  waitId: WaitId | null
  /**
   * The current wait's own `WaitReason`, for `allowedResolutions` (0118 §1,
   * `#442`) — which controls the moves row may draw, and nothing else. Set
   * exactly where `waitId` is: a blocked lifecycle carries a reason by
   * construction (`ticket.ts`'s `WaitStarted` case), so the two are null
   * together and non-null together. `approved` carries no reason — the
   * question is already answered — so this is null there even though
   * `waitId` is not.
   */
  reason: WaitReason | null
  /** Unpushed work on the current blocked wait's run, never an earlier wait's. */
  unpushed: AttemptRef['unpushed'] | null
  /**
   * The sha `WaitResolved{Approve}` recorded, while `approved` — what
   * `ScheduleContinuation` sends back as `onSha` (#508), so a click made
   * after the item has moved to a new wait at a new sha is refused rather
   * than rescheduling a continuation nobody looked at. Null off every other
   * state: there is no approval on record for them to have a sha.
   */
  approvedSha: string | null
}

/**
 * Whether `raw` quotes this verdict. A gate that printed nothing is quoted only
 * by a quote that is also empty — an empty string is in every string, and a
 * conflict is not a silent build.
 *
 * **A reviewer is quoted by its findings, not its evidence.** A disagreement
 * hold's `raw` is `quoteFindings` — `[major] src/x.ts:4 — claim` and the
 * scenario — while the review gate's evidence is its own summary, `major
 * src/x.ts:4 — claim` and a turns line, which is in no quote. Matched on the
 * evidence alone, the most common gate hold there is never named the gate it
 * quoted. So a verdict with findings is quoted when every finding's head line,
 * as `quoteFindings` (`packages/conductor/src/fix.ts`) writes it, is in `raw`.
 */
function quotes(raw: string, verdict: StepVerdict): boolean {
  if (
    verdict.findings.length > 0 &&
    verdict.findings.every((f) =>
      raw.includes(`[${f.severity}] ${f.line === null ? f.file : `${f.file}:${f.line}`} — ${f.claim}`),
    )
  ) {
    return true
  }
  const said = (verdict.evidence ?? '').trim()
  return said === '' ? raw.trim() === '' : raw.includes(said)
}

/** The first line that says anything, clipped. The rest is in the attempt. */
function oneLine(text: string | null): string | null {
  if (text === null) return null
  const line = text
    .split('\n')
    .find((l) => l.trim().length > 0)
    ?.trim()
  if (!line) return null
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/**
 * What refused, on one attempt, or null if that attempt refused nothing.
 *
 * The last failed verdict rather than the first: a point that failed, was
 * repaired and failed again is one attempt with two refusals, and the one being
 * decided is the most recent. Falls back to the attempt's own outcome, so a run
 * that died before any gate reported still points somewhere — that case
 * (`claimed`, `released`, a run that failed with no verdicts) is exactly the
 * one a gate-shaped summary could never name.
 */
function refusalOn(run: AttemptView): Deciding | null {
  /**
   * A gate that never ran stopped this attempt without refusing it (#133).
   *
   * Named here because otherwise nothing does: the run itself *finished* — exit
   * 0, turns taken, money spent — so `outcomeOf` calls it `finished` and this
   * would fall through to an earlier attempt's genuine refusal, putting an old
   * red line at the top of a page whose actual answer is that the account ran
   * out. The line says nothing judged the diff, and names no refusal.
   *
   * **Before the refusals, not after.** `presentAttemptEvents` keeps one entry per gate for
   * the whole attempt, so a `failed` from an earlier round of the same pass is
   * still in `run.gates` — about a commit that is no longer the head. A gate
   * that never ran is always the last thing a pass did (the pipeline and the
   * pass both stop there, 0041 §4), so when there is one it is the ending, and
   * any refusal beside it is history.
   */
  const never = [...run.steps].reverse().find((g) => g.state === 'never-ran')
  if (never) {
    return {
      attempt: run.attempt,
      source: never.step.replace(':', ' / '),
      line: `never ran — nothing judged this diff: ${oneLine(never.evidence) ?? 'no detail was recorded'}`,
      evidence: never.evidence,
      fromStep: true,
    }
  }

  /**
   * And the neighbouring ending, for the same reason and with the same argument
   * ([0057](../../../../doc/decisions-archive/0057-a-gate-that-did-not-finish.md), `#196`).
   *
   * The run finished — exit 0, turns taken, money spent — so without this line
   * the page falls through to an earlier round's genuine refusal and puts a red
   * line about a commit that has moved at the top of a page whose actual answer
   * is that the reviewer crashed. A gate that did not finish is always the last
   * thing a pass did, so any refusal beside it is history.
   *
   * The sentence says the machinery and never the diff: *did not finish*, not
   * *refused*.
   */
  const unfinished = [...run.steps].reverse().find((g) => g.state === 'did-not-finish')
  if (unfinished) {
    return {
      attempt: run.attempt,
      source: unfinished.step.replace(':', ' / '),
      line: 'did not finish — nothing judged this diff: ' + (oneLine(unfinished.evidence) ?? 'no detail was recorded'),
      evidence: unfinished.evidence,
      fromStep: true,
    }
  }

  /**
   * And the third absence, which is the one that is not a fault (`#296`).
   *
   * Above the refusal below it for `did-not-finish`'s reason — the pipeline stops
   * where a step asked, so a `failed` beside it is an earlier round's, about a
   * commit that has moved — and *below* the two above it, because a fault is the
   * more urgent reading where a run somehow carries both.
   *
   * The sentence is the question and says so. Reading *did not finish — nothing
   * judged this diff* over a design agent's question, which is what this page did
   * while the two shared an ending, asks a person to acknowledge a failure that
   * did not happen instead of answering what was asked.
   */
  const question = [...run.steps].reverse().find((g) => g.state === 'asked')
  if (question) {
    return {
      attempt: run.attempt,
      source: question.step.replace(':', ' / '),
      line: 'asked — ' + (oneLine(question.evidence) ?? 'no question was recorded'),
      evidence: question.evidence,
      fromStep: true,
    }
  }

  const refused = [...run.steps].reverse().find((g) => g.state === 'failed')
  if (refused) {
    return {
      attempt: run.attempt,
      source: refused.step.replace(':', ' / '),
      line: oneLine(refused.evidence) ?? run.outcome.detail ?? 'refused, and said nothing',
      evidence: refused.evidence?.trim() ? refused.evidence : run.outcome.detail,
      fromStep: true,
    }
  }

  const detail = oneLine(run.outcome.detail)
  if (detail === null) return null
  return {
    attempt: run.attempt,
    source: run.outcome.state,
    line: detail,
    evidence: run.outcome.detail,
    fromStep: false,
  }
}

/**
 * The one deciding line, and the attempt that holds the whole of it.
 *
 * **The attempt that decided is not always the attempt that is named.** A
 * repair is an ordinary run (0025) and it ends like one: `ticket-lingtai-89`'s
 * second attempt finished with exit 0 and no commits, so it has no failed
 * verdict and no outcome detail, and the failure everybody is looking at —
 * `proposed / build`, `error TS2741` — is attempt 1's. Pointing only at the
 * named run left the block with nothing, which is how the whole flattened
 * a wait's own question came to be the only evidence on screen (#111).
 *
 * So: the named attempt first, then back through the earlier ones. That is the
 * design's own example read literally — *from attempt 2 of 2* at the top and
 * *in attempt 1 ↓* on the evidence — and it is still a pointer and never a
 * copy, because the whole of it stays in the attempt it names (design §2).
 */
function decidingOf(runs: readonly AttemptView[], named: AttemptView | null): Deciding | null {
  if (named !== null) {
    const own = refusalOn(named)
    if (own !== null) return own
  }

  const before = named === null ? runs : runs.slice(0, runs.indexOf(named))
  for (const run of [...before].reverse()) {
    const refused = refusalOn(run)
    if (refused !== null) return refused
  }
  return null
}

function whoWaits(life: TicketLifecycle): string {
  switch (life.status) {
    case 'blocked':
      // The two a person can tell apart at a glance (#147): nothing has run, or
      // a run is holding something. `describeWait` words the card's chip the
      // same way; this page has the reducer rather than the row, so it asks it.
      if (life.reason._tag === 'OwnQuestion') return 'waiting for your answer'
      return 'waiting on you'
    case 'claimed':
      return 'an agent is working'
    case 'landed':
      return `merged into ${life.base}`
    case 'approved':
      return 'approved — waiting for a conductor to continue it'
    case 'closed':
      return 'this ticket is closed'
    default:
      // Not stuck. The reading #94 got wrong: an item nobody is holding comes
      // back on its own, and the page has to say so in as many words.
      return 'waiting for a conductor to take it'
  }
}

/**
 * The state, since when, and which attempt produced it. See `StandingView`.
 *
 * Pure, and given the runs rather than reading them, for the reason every reduce
 * in this file is: what the page *says* about a stopped item is settled by
 * envelopes and nothing else.
 */
export function standingOf(own: readonly Envelope[], runs: readonly AttemptView[]): StandingView {
  const item = reduceTicket(own)
  const since = item.since

  const life = item.lifecycle
  const named =
    life.status === 'blocked'
      ? runs.find((r) => r.runId === ('run' in life.reason ? life.reason.run.runId : null))
      : life.status === 'claimed'
        ? runs.find((r) => r.runId === life.runId)
        : undefined
  // The attempt the state names, or the last one there was. A released item is
  // queued *because of* what its last attempt did, and a landed one merged what
  // its last attempt produced; neither event carries a run id.
  const run = named ?? runs.at(-1) ?? null
  const blocked = life.status === 'blocked'
  const approved = life.status === 'approved'
  const issue = item.externalRef
  const words = blocked
    ? waitWords(life.reason, {
        branch: issue === null ? '' : agentBranchOf(issue),
        base: '',
        findings: [],
      })
    : null
  const raw = words?.diagnosis?.raw ?? null
  // The last person's move and what followed it are the reducer's (`TicketState.lastMove`), not a rescan.
  const m = item.lastMove
  const live = m !== null && m.current
  const closed = live && m.then?.kind === 'closed' && life.status === 'closed' && m.resolution._tag === 'Close'
  const released =
    live &&
    m.then?.kind === 'released' &&
    life.status === 'backlog' &&
    (m.resolution._tag === 'Requeue' || m.resolution._tag === 'EditBodyAndRequeue') &&
    m.then.cause?._tag === 'ByPerson' &&
    m.then.cause.waitId === m.waitId
  const requeued =
    live &&
    m.then === null &&
    life.status === 'backlog' &&
    (m.resolution._tag === 'Requeue' ||
      m.resolution._tag === 'EditBodyAndRequeue' ||
      m.resolution._tag === 'AnswerQuestion')
  const continued = live && m.then === null && life.status === 'approved' && m.resolution._tag === 'GrantFixRound'
  const body = item.github.last.body

  return {
    state: life.status === 'claimed' ? 'running' : life.status === 'backlog' ? 'queued' : life.status,
    afterMove:
      m !== null && (closed || released || requeued || continued)
        ? {
            resolution: m.resolution._tag,
            by: m.by,
            note: m.note,
            result: closed ? 'closed' : continued ? 'continued' : 'requeued',
            reason: continued
              ? 'Continued saved work for one additional fix round; build and review run again.'
              : requeued
                ? 'The wait was resolved; a new attempt starts from base.'
                : released
                  ? `${m.then?.reason ?? ''} A new attempt starts from base.`
                  : (m.then?.reason ?? ''),
            ...(continued && m.resolution._tag === 'GrantFixRound'
              ? { ref: m.resolution.ref, head: m.resolution.onSha }
              : {}),
          }
        : null,
    bodyOutcome:
      body !== undefined && item.github.bodyAfterWait !== null && item.github.bodyAfterWait === item.github.lastWait
        ? { result: body.outcome, detail: body.text }
        : null,
    triageStatus: null,
    since: since === null ? null : since.toISOString(),
    onYou: blocked,
    who: whoWaits(life),
    // One line, and the same clip the evidence pointer gets. See `question`.
    question: words === null ? null : oneLine(words.line),
    needs: words?.needs ?? null,
    diagnosis: words?.diagnosis ?? null,
    attempt: run?.attempt ?? null,
    attempts: runs.length,
    runId: run?.runId ?? null,
    // Only while a person is holding it. A run mid-flight may have an approval
    // open on its stream and no question anybody has been handed yet.
    awaitingSha: blocked ? (run?.awaitingSha ?? null) : null,
    asked: blocked && life.reason._tag === 'OwnQuestion',
    askedQuestion: blocked && life.reason._tag === 'OwnQuestion' ? (words?.line ?? null) : null,
    headSha: run?.headSha ?? null,
    failed: run?.steps.filter((g) => g.state === 'failed').map((g) => g.step) ?? [],
    saidBy:
      raw === null
        ? null
        : ([...(run?.steps ?? [])].reverse().find((g) => g.state === 'failed' && quotes(raw, g))?.step ?? null),
    deciding: decidingOf(runs, run),
    restarts: item.restarts.length,
    // `RestartRecord` carries no ceiling since #502 (`TicketReleased{cause:
    // Restart}` is `{after, restart}` alone — the policy it was spent against
    // lives in the recipe, never on the event). Zero here is "the log has
    // none", the same reading a missing ceiling always got; `board.ts`'s own
    // `restartsOf > 0 ? … : limits?.restarts` already falls back to the
    // recipe for it.
    restartsOf: 0,
    waitId: life.status === 'blocked' || life.status === 'approved' ? life.waitId : null,
    reason: blocked ? life.reason : null,
    unpushed: blocked && 'run' in life.reason ? (life.reason.run.unpushed ?? null) : null,
    approvedSha: approved ? life.onSha : null,
  }
}

export { savedFixWork }

/**
 * One stream's events, in order, under a name.
 *
 * **Grouped by stream, not cut by seq.** A ticket-level event landing in the
 * middle of a run — a block, a repair request — does not split that run in two;
 * the group is the whole of what the stream holds, ordered by seq inside, and
 * the groups themselves are in the order their first event landed. The range is
 * on the group because a seq is what a finding cites when it wants to be
 * believed, and the ranges of two groups may legitimately overlap.
 */
export interface HistoryGroup {
  streamId: string
  /** The attempt this stream is, or null for the item's own. */
  attempt: number | null
  /** `attempt 2`, or `the ticket`. */
  label: string
  /** Inclusive, as the store numbers them. */
  from: string
  to: string
  lines: HistoryLine[]
}

/** What the log and the register give of a ticket — everything but GitHub's answer. */
export type TicketBase = Pick<TicketView, 'project' | 'ref' | 'title' | 'kind' | 'labels' | 'url' | 'compareUrl'>

/**
 * What only the issue's answer knows (0118 §2). A field it has no value for is
 * null and the log's stands: `withAnswer` is the one place they meet.
 */
export interface TicketAnswer extends Pick<TicketView, 'found' | 'askedGitHub' | 'title' | 'url' | 'body' | 'problem'> {
  labels: string[] | null
}

/**
 * The deferred part of the task page: the answer, and the two reads that need it.
 * `outgoing` is what the next attempt will be handed (null when there will not be
 * one — see `prompt.ts`); `queued` is where the item is in line and what taking
 * it runs, the one thing that is not a reducer because an issue nobody has run
 * has no stream (0012, `queued.ts`).
 */
export interface TaskAnswer {
  ticket: TicketAnswer
  outgoing: OutgoingView | null
  queued: QueuedView | null
}

export interface TaskDetail {
  taskId: string
  /** Neighbours in the Waiting lane, read from `readTasks` on every render (#584). */
  waiting: { previous: WaitingNeighbour | null; next: WaitingNeighbour | null }
  /** Local mirror check for the current wait's kept ref; null for every other case. */
  unpushedMirror: { path: string; sha: string | null } | null
  /**
   * Why it is not moving, above everything else. See `StandingView`.
   *
   * First on the page and first in this shape: the commonest reason anybody
   * opens it is that a card has stopped, and the answer used to be at the
   * bottom of an 80-row history or nowhere.
   */
  standing: StandingView
  /** Triage's reading of what the ticket wants, only for the current blocked wait. */
  want: string | null
  /**
   * What the log and the register give: no body, no `found`, no GitHub (0118 §2).
   * Null only when the id is not `ticket-<project>-<n>` — and `loadTask` is null
   * then, so a page never has it.
   */
  ticket: TicketBase | null
  /** Every attempt, oldest first. Empty when nothing has been dispatched. */
  runs: AttemptView[]
  /** Every conversation held about this item, oldest first. */
  discussions: DiscussionView[]
  /**
   * The budget line the standing's own rail carries — rounds spent against
   * their ceiling, restarts left against theirs (`describeHeld`, `#415`).
   * Null wherever the state names no run to read it off.
   */
  held: string | null
  totals: Totals
  /**
   * Whether `totals` and every attempt's `costUsd` are off a `spend` that
   * is how far behind the head — `currentSpend`'s own currency, kept
   * rather than discarded (`#498`'s review): a lag that could not be read must not
   * read the same as a ticket with nothing spent, which is exactly what
   * every attempt reading `unknown (1 run)` would otherwise look like.
   */
  spendCurrency: SpendCurrency
  /**
   * How many events the ticket's own stream holds — the Ticket tab's fact, and
   * what says a page has no history at all. The events themselves are read by
   * the tab that shows them (#885).
   */
  events: number
}

// ----------------------------------------------------------- discussions ----

/** One exchange: what was asked, what was readable, and what came back. */
export interface DiscussionTurnView {
  question: string
  by: string
  /** ISO, from the envelope. */
  at: string
  /**
   * Lingtai's own sentence about what could be read — including a branch that
   * was not there.
   *
   * Shown whatever the answer says, because it is recorded on the ask and not
   * on the answer (0033 §5). An assistant that forgot to mention that it was
   * reading `main` cannot make this page forget it too, which is the whole
   * reason the field is on the ask.
   */
  reading: string[]
  answer: {
    text: string
    /** `main:packages/…` — every file that was served. */
    read: string[]
    /** What it said it could not establish without a command it does not have. */
    cannot: string[]
    proposal: { kind: 'prompt' | 'ticket'; text: string } | null
    /** Set when it did not finish. The turn still cost what it cost. */
    failure: string | null
  } | null
}

/** One conversation, whole. */
export interface DiscussionView {
  chatId: string
  /** The attempt it was asked about, or null for the item as a whole. */
  attempt: number | null
  turns: DiscussionTurnView[]
  /** True while a question has no answer: the daemon has not got to it yet. */
  waiting: boolean
  /** Which artefact it produced, once it was closed. Null while it is open. */
  held: 'prompt' | 'ticket' | 'none' | null
}

/**
 * One `chat-<id>` stream, reduced.
 *
 * Pure, like every other reduce here, so what the panel *says* about a
 * conversation is testable without a database.
 */
export function presentChat(chatId: string, events: readonly Envelope[], held: DiscussionView['held']): DiscussionView {
  const chat = reduceChat(events)
  return {
    chatId,
    attempt: chat.attempt,
    turns: chat.turns.map((t) => ({
      question: t.question,
      by: t.by,
      at: t.at.toISOString(),
      reading: [...t.reading],
      // Field by field: the view is serialised to the client, and the payload
      // also carries `turns` and `durationMs`.
      answer:
        t.answer === null
          ? null
          : {
              text: t.answer.text,
              read: [...t.answer.read],
              cannot: [...t.answer.cannot],
              proposal: t.answer.proposal,
              failure: t.answer.failure,
            },
    })),
    waiting: chat.turns.some((t) => t.answer === null),
    held,
  }
}

/**
 * Which conversations this item has had, and how each ended.
 *
 * The requests are on `ctl-conductor` and the exchanges are on their own
 * streams, so this is a **join done by a reader at read time** — where 0012
 * puts every join of this kind. The held half is the ticket reduce's
 * (`TicketState.discussions`); this lists control's chats for the ticket first,
 * then any held chat control did not name, in held order.
 */
export function chatIdsFor(
  control: readonly { chatId: string; ticketId: string }[],
  held: readonly TicketDiscussion[],
  taskId: string,
): { chatId: string; held: DiscussionView['held'] }[] {
  const order: string[] = []
  for (const d of control) {
    if (d.ticketId === taskId && !order.includes(d.chatId)) order.push(d.chatId)
  }
  for (const h of held) if (!order.includes(h.chatId)) order.push(h.chatId)
  const outcomes = new Map(held.map((h) => [h.chatId, h.outcome]))
  return order.map((chatId) => ({ chatId, held: outcomes.get(chatId) ?? null }))
}

/**
 * A path as the repository names it. The agent's file tools report absolute
 * paths under the run's worktree, which is a place on one machine; a path not
 * under it is shown as recorded rather than guessed at.
 */
export function relativeTo(worktree: string | null, path: string): string {
  if (worktree === null || worktree === '') return path
  const root = worktree.endsWith('/') ? worktree : `${worktree}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

/**
 * One attempt, drawn from the run's `AttemptState` and the claim that opened it.
 *
 * There is no second reducer of the run stream here: `reduceAttempt` is the one, and
 * this is a drawing of what it holds. Joined from outside are the claim (when
 * it was opened, why it was released) and `progress`, which needs the recipe's
 * plan and whether this attempt landed — neither is on the stream.
 */
export function presentAttempt(
  state: DomainRunState,
  claim: TicketClaim,
  attempt: number,
  progress: AttemptProgress | null,
  /** Whether the ticket is stopped at **this attempt's** wait now (`loadTask` reads it off the lifecycle). */
  held: boolean = false,
  /** The branch `waitWords` words an `asked` detail with. */
  branch: string = '',
): AttemptView {
  const build = STEPS.indexOf('build')
  const steps: StepVerdict[] = Object.values(state.steps).map((s) => {
    const name = s.step.slice(0, s.step.indexOf(':'))
    // Steps before `build` make the head, so their `onSha` is the commit they
    // started on and is never the final head (D2).
    const stale = !(
      STEPS.indexOf(name as (typeof STEPS)[number]) < build ||
      state.headSha === null ||
      s.onSha === state.headSha
    )
    return { step: s.step, state: s.verdict, stale, evidence: s.evidence, findings: [...s.findings] }
  })
  if (state.step !== null) {
    steps.push({ step: `${state.step.step}:`, state: 'running', stale: false, evidence: null, findings: [] })
  }

  return {
    runId: claim.runId,
    attempt,
    at: claim.at.toISOString(),
    baseSha: state.baseSha,
    headSha: state.headSha,
    configHash: state.resolved?.configHash ?? null,
    turns: state.receipt?.turns ?? null,
    // Filled in by `loadTask`, from `spend` — this reduce has no database to
    // read it off (0110 §13: `RunFinished` stopped being a spend source).
    costUsd: emptyBill(),
    durationMs: state.receipt?.durationMs ?? null,
    outcome: outcomeOf(state, claim, held, branch),
    files: filesOf(state).map((f) => ({ ...f, path: relativeTo(state.worktree, f.path) })),
    diff:
      state.produced === null
        ? null
        : {
            branch: state.produced.branch,
            files: state.produced.files,
            insertions: state.produced.insertions,
            deletions: state.produced.deletions,
          },
    prompt: state.promptMeta === null ? null : { ...state.promptMeta, text: state.prompt },
    // Offered only while the lifecycle still awaits it (D3).
    awaitingSha: state.lifecycle.status === 'awaiting-approval' ? state.lifecycle.onSha || null : null,
    steps,
    progress,
  }
}

/** `presentAttempt` for a caller holding events rather than a state. */
export function presentAttemptEvents(
  claim: TicketClaim,
  attempt: number,
  run: readonly Envelope[],
  /**
   * `progressOf`'s two arguments, which only the caller can hold: the
   * recipe's plan, for the bound on a gate in flight, and whether **this**
   * attempt is the one that landed — the whole difference between `pending`
   * and `never-ran`. Neither is on the run's own stream. See `loadTask`.
   */
  {
    plan,
    over = false,
    held = false,
    branch = '',
  }: { plan?: StepPlan; over?: boolean; held?: boolean; branch?: string } = {},
): AttemptView {
  const state = reduceAttempt(run)
  return presentAttempt(state, claim, attempt, progressOf(state, plan, over), held, branch)
}

/**
 * How the attempt ended, worst-first and never "running" by omission.
 *
 * The order is the point. `failed` first (D3). Then `asked` **while the ticket is
 * stopped at this attempt's wait** (`held`), ahead of `finished`: an attempt held
 * at a signoff after its agent finished is waiting for a person, not done. A run
 * released without ever finishing is `released` and not `running` — reading a
 * claim that was given back three days ago as a run still in flight is the
 * card's own #100, one page along. A past ask, one nobody released and the
 * lifecycle has moved on from, ranks just above `claimed`, so the attempt reads
 * by its run wherever its run got anywhere. A claim whose stream is empty says
 * so rather than borrowing a state from a run that never appended anything.
 */
function outcomeOf(state: DomainRunState, claim: TicketClaim, held: boolean, branch: string): RunOutcome {
  const asked = (): RunOutcome => {
    const ended = claim.ended
    return {
      state: 'asked',
      detail: ended?.kind === 'asked' ? waitWords(ended.reason, { branch, base: '', findings: [] }).line : null,
    }
  }
  if (state.failure !== null) return { state: 'failed', detail: state.failure.kind }
  if (held && claim.ended?.kind === 'asked') return asked()
  if (state.receipt !== null) {
    return { state: 'finished', detail: state.receipt.exitCode !== 0 ? `exit ${state.receipt.exitCode}` : null }
  }
  if (claim.ended?.kind === 'released') return { state: 'released', detail: claim.ended.reason }
  if (state.agentStartedAt !== null) return { state: 'running', detail: null }
  if (claim.ended?.kind === 'asked') return asked()
  return { state: 'claimed', detail: 'nothing on its stream' }
}

/**
 * What the attempts cost, added up. See `Totals`.
 *
 * `rows` is this ticket's whole `spend` — `loadTask`'s `currentSpend({ ticket })`
 * — and `billOf` is the one classifier every purpose goes through, here as
 * everywhere else: a fact one layer down the stack must not also decide its
 * own purpose.
 *
 * **A run that contributed not one `Action` row is unknown, never free**
 * (0110 §7): `ticket-lingtai-89`'s two attempts predate `RunSpent`, so `rows` is
 * empty and `billOf([])` reduces to five empty bills — which reads as nothing
 * spent, the defect this ticket exists to remove. Credited to Work, the
 * purpose `billOf` gives a row that did arrive.
 */
export function totalsOf(
  runs: readonly AttemptView[],
  discussions: readonly DiscussionView[] = [],
  rows: readonly SpendRow[] = [],
): Totals {
  const byPurpose = billOf(rows)
  for (const run of runs) {
    if (rows.some((row) => row.pass === run.runId && row.purpose === 'Action')) continue
    byPurpose.Work = addBill(byPurpose.Work, unknownBill(1))
  }
  return {
    attempts: runs.length,
    turns: runs.reduce((n, r) => n + (r.turns ?? 0), 0),
    durationMs: runs.reduce((n, r) => n + (r.durationMs ?? 0), 0),
    discussions: discussions.length,
    byPurpose,
  }
}

const PURPOSE_LABEL: Record<Purpose, string> = {
  Work: 'work',
  Answering: 'answering',
  Judge: 'judge',
  Triage: 'triage',
  Discussion: 'asking',
}

/**
 * The totals, as the Attempts label's one fact.
 *
 * **The total leads.** Five bills and no sum is arithmetic done by every
 * reader: the figure in front is the number somebody acts on — it is what
 * `#89` is remembered by, and what decides whether a fourth attempt is worth
 * buying — and the split is detail (#111). So the sum first, then what
 * bought it, then how it divides.
 *
 * It still divides, for the reason the board keeps it divided (#84, 0033 §4):
 * a repair is default-on and spends an agent without being asked again, and a
 * discussion has a meter instead of a limit. Those figures have to be
 * *stated* and not merely derivable — but they are the detail, not the
 * headline, and the per-attempt figure stays on each attempt's own row.
 *
 * **`billText`'s table, not `$0.00`.** A purpose with nothing reported and no
 * unknown run is dropped from the split entirely — `$7.81 · $7.81 work` is
 * one fact twice — and a purpose with an unknown run says so rather than
 * reading as free.
 *
 * `2 attempts + 3 discussions · …`, as the design's example reads it — and the
 * discussions are counted for the reason 0033's consequences give: they come
 * out of the same budget, so hiding one of the two figures would misstate the
 * other. The clause is dropped when there have been none, because a permanent
 * `0 discussions` is furniture.
 */
export function totalsFact(totals: Totals): string | null {
  if (totals.attempts === 0 && totals.discussions === 0) return null
  const held = totals.discussions
  const total = totalBill(totals.byPurpose)
  const split = PURPOSES.map((p) => {
    const bill = totals.byPurpose[p]
    return billHasAny(bill) ? `${billText(bill)} ${PURPOSE_LABEL[p]}` : null
  }).filter((s): s is string => s !== null)

  return [
    billHasAny(total) ? billText(total) : null,
    `${totals.attempts} attempt${totals.attempts === 1 ? '' : 's'}` +
      (held > 0 ? ` + ${held} discussion${held === 1 ? '' : 's'}` : ''),
    totals.turns > 0 ? `${totals.turns} turns` : null,
    totals.durationMs > 0 ? elapsed(totals.durationMs) : null,
    ...(split.length > 1 ? split : []),
  ]
    .filter((s): s is string => s !== null)
    .join(' · ')
}

/**
 * Every event, in order, under the stream it came off. See `HistoryGroup`.
 *
 * Nothing is dropped and nothing is reordered inside a group: this is *what
 * actually happened, in order, with who did it*, and the grouping is a way in
 * rather than a filter.
 */
export function groupHistory(events: readonly Envelope[], attempts: ReadonlyMap<string, number>): HistoryGroup[] {
  // Insertion order is first-seq order, which is the order the groups read in.
  const groups = new Map<string, HistoryGroup>()
  // A run stream's own subject, which the run's reducer reads off its
  // `RunStarted` (#505). Without it, a `PassRouted` on that same stream has
  // nothing to open its sentence on. Only pass streams are run streams: the
  // ticket's own stream never reaches `reduceAttempt`.
  const sorted = [...events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
  const byRun = new Map<string, Envelope[]>()
  for (const e of sorted) {
    if (!isAttemptStream(e.streamId)) continue
    const own = byRun.get(e.streamId)
    if (own) own.push(e)
    else byRun.set(e.streamId, [e])
  }
  // Which `runId`s each stream has claimed so far: a claim of one it already
  // carried is a continuation (`claimShapeOf`), and only a `TicketClaimed`
  // adds to the set.
  const claimedByStream = new Map<string, Set<string>>()
  const branchByRun = new Map<string, string>()
  for (const [streamId, own] of byRun) {
    const { ticketId } = reduceAttempt(own)
    const parsed = typeof ticketId === 'string' ? parseTicketStream(ticketId) : null
    if (parsed) branchByRun.set(streamId, agentBranchOf(parsed.issue))
  }

  for (const e of sorted) {
    let group = groups.get(e.streamId)
    if (!group) {
      const attempt = attempts.get(e.streamId) ?? null
      group = {
        streamId: e.streamId,
        attempt,
        label: attempt === null ? 'the ticket' : `attempt ${attempt}`,
        from: String(e.seq),
        to: String(e.seq),
        lines: [],
      }
      groups.set(e.streamId, group)
    }
    const claimed = claimedByStream.get(e.streamId) ?? new Set<string>()
    const claim = claimShapeOf(e, claimed) ?? undefined
    // `claim` is answered for a `TicketClaimed` that is new to the stream and for
    // nothing else, so it is exactly the case that adds to the set.
    if (claim === 'claim') {
      claimed.add((e.data as PayloadOf<'TicketClaimed'>).runId)
      claimedByStream.set(e.streamId, claimed)
    }
    group.lines.push(toLine(e, { attempts, branch: branchByRun.get(e.streamId), claim }))
    group.to = String(e.seq)
  }

  return [...groups.values()]
}

/**
 * The ticket as the log and the register give it, with no GitHub in it (0118 §2).
 *
 * A title recorded on `TicketClaimed` is what the ticket said when the run
 * started, and it survives a repository the App can no longer reach — so it is
 * what the page draws until an answer overwrites it. The link is buildable
 * without GitHub, and worth building: it is the thing the page exists to save a
 * trip for. A recipe that will not parse costs the link, not the page.
 *
 * Null for an id that is not `ticket-<project>-<n>` and for a project Lingtai
 * has never been told about: **the two things a 404 may rest on**, because
 * neither needs GitHub to decide (`knowable`).
 */
async function loadTicketBase(taskId: string, own: readonly Envelope[]): Promise<TicketBase | null> {
  const parsed = parseTicketStream(taskId)
  if (!parsed) return null
  const { project, issue } = parsed
  const state = await loadProject(project).catch(() => null)
  if (!state) return null

  const reduced = reduceTicket(own)
  const tickets = await currentRecipe(state)
    .then((r) => ticketSourceOf(r.recipe))
    .catch(() => null)
  return {
    project,
    ref: issue,
    title: reduced.title,
    kind: reduced.kind,
    labels: [...reduced.labels],
    url: issueUrl(state.owner, project, issue, tickets),
    compareUrl: compareUrl(state.owner, project, state.base, agentBranchOf(issue), tickets),
  }
}

/** The ticket, once GitHub (or the table, for a `db` project) has answered: the base and the answer, as one. */
export function withAnswer(base: TicketBase, answer: TicketAnswer): TicketView {
  return {
    ...base,
    title: answer.title ?? base.title,
    labels: answer.labels ?? base.labels,
    url: answer.url ?? base.url,
    body: answer.body,
    found: answer.found,
    askedGitHub: answer.askedGitHub,
    problem: answer.problem,
  }
}

const NO_ANSWER: TicketAnswer = {
  found: null,
  askedGitHub: false,
  title: null,
  labels: null,
  url: null,
  body: null,
  problem: null,
}

/**
 * What only the issue's answer knows, asked once per render and **never
 * rejecting** (0118 §2).
 *
 * A promise that rejected would be read under a `<Suspense>` and go to the error
 * boundary, which replaces the page, where every place that reads it should say
 * *what failed* in its own words. So everything is caught and becomes `problem`.
 *
 * One reader for the three places a ticket is read (#731). A `db` ticket's
 * number is not a GitHub issue number — it can collide with an unrelated issue
 * on the same repository — so the reader never asks GitHub about it (#384).
 *
 * **The one question this has to answer twice.** A 404 from GitHub is an answer
 * — there is no such issue — and everything else is the absence of one.
 * Collapsing the two is what made `ticket-lingtai-99999` and a repository behind
 * a rate limit render identically (#113).
 */
export const loadTicketAnswer = cache(async (taskId: string): Promise<TicketAnswer> => {
  try {
    const parsed = parseTicketStream(taskId)
    if (!parsed) return { ...NO_ANSWER, found: false, problem: 'this id is not a ticket' }
    const state = await loadProject(parsed.project).catch(() => null)
    if (!state) return { ...NO_ANSWER, found: false, problem: `${parsed.project} is not a registered project` }
    const read = await timed('github.issue', () => readProjectTicket(state, Number(parsed.issue)), {
      failed: (r) => !r.ok,
    })
    if (read.ok) {
      const live = read.ticket
      return {
        found: true,
        askedGitHub: read.from === 'github',
        title: live.title,
        // Names only. The colours GitHub sends with them are the board's, for the
        // dot on a card (#85); this page lists every label a ticket carries, and
        // a row of coloured pills here would be the filled pill that ticket
        // refused — a taxonomy wearing the palette's verdict colours.
        labels: live.labels.map((l) => l.name),
        // The ticket table has no page of its own, so the link built from the log stays.
        url: read.from === 'github' ? (live.url ?? null) : null,
        body: live.body,
        problem: null,
      }
    }
    const missing = read.error instanceof GitHubError && read.error.status === 404
    return {
      ...NO_ANSWER,
      found: missing ? false : null,
      askedGitHub: read.from === 'github',
      problem: (read.error as Error).message,
    }
  } catch (err) {
    return { ...NO_ANSWER, problem: (err as Error).message }
  }
})

/**
 * Whether there is a page here at all — **the one thing a 404 may rest on**, and
 * the only thing it may rest on without asking GitHub (0118 §2, #113).
 *
 * The id parses as `ticket-<project>-<n>` and the project is one Lingtai has been
 * told about. Whether the *issue* exists is GitHub's to say and arrives after the
 * page is sent: a ticket the log has never touched and GitHub has no issue for
 * is a page that says so (`TaskAnswer`), not a 404; an item the log has touched
 * is a page whatever GitHub says today.
 */
export async function knowable(taskId: string): Promise<boolean> {
  const parsed = parseTicketStream(taskId)
  if (!parsed) return false
  return (await loadProject(parsed.project).catch(() => null)) !== null
}

/**
 * The recipe's gate plan, for the bound a running attempt's phase is measured
 * against — or undefined, which draws the phase with no denominator.
 *
 * `currentRecipe`, as the board's own `askProject` reads it, so the card and
 * this page measure one gate against one number. Never throws: a recipe that
 * will not read costs the page its `/ 20m` and nothing else, and no bound is
 * drawn as no denominator rather than as zero.
 *
 * **`limits` rides beside the plan rather than being its own call** (`#415`):
 * both come off the one `projectFilter` read, and asking twice would be a
 * second recipe fetch for a number that arrived with the first. It is
 * `held`'s fallback ceiling — the recipe only where the run's own stream
 * named none of its own.
 */
async function planFor(
  project: string,
): Promise<{ plan: StepPlan; limits: Pick<AttemptLimitsView, 'rounds' | 'restarts'> } | undefined> {
  const state = await loadProject(project).catch(() => null)
  if (!state) return undefined
  const filter = await projectFilter(state)
  return filter.ok
    ? { plan: filter.plan, limits: { rounds: filter.limits.rounds, restarts: filter.limits.restarts } }
    : undefined
}

/**
 * The recipe each attempt was given, keyed by run — or, where that cannot be
 * proved, head's, named as head's (#190). See `recipeOfAttempt`.
 *
 * **No round trip per render for a proved run**: the recipe at a base commit
 * is kept per `(repo, sha)`, which is exact because a commit never changes.
 * Head's — the machine's current recipe — is read once however many attempts
 * want it, through `currentRecipe`.
 *
 * Never throws: a project that will not load is every attempt saying so.
 */
async function recipesFor(project: string, runs: readonly AttemptView[]): Promise<Map<string, AttemptRecipe>> {
  if (runs.length === 0) return new Map()
  let recipes: AttemptRecipe[]
  try {
    const state = await loadProject(project)
    if (!state) throw new Error('it is not a registered project')
    const client = await githubClientFor(state)
    let head: ReturnType<typeof currentRecipe> | null = null
    const atHead = () => (head ??= currentRecipe(state))
    recipes = await timed('recipe.run', () => Promise.all(runs.map((r) => recipeOfAttempt(r, client, atHead))))
  } catch (err) {
    const why = `no recipe could be read for ${project}: ${(err as Error).message}`
    recipes = runs.map(() => ({ of: 'none', why }))
  }
  return new Map(runs.map((r, i) => [r.runId, recipes[i]!]))
}

/**
 * One task, whole — **or null, which means only that no such ticket exists.**
 *
 * That `null` used to mean *the log has nothing on this stream*, and the route
 * turns it into a 404. Every card in the Queued column is a ticket the log has
 * nothing on, by definition: `queued` is the one state no event carries (0012),
 * so a ticket that has never run has no stream and the one column the board
 * leads with was the one column you could not open (#113).
 *
 * So the emptiness of the stream decides nothing, and **neither does GitHub**
 * (0118 §2): the page is a 404 only for what needs no GitHub to decide — an id
 * that is not `ticket-<project>-<n>`, or a project Lingtai has never been told
 * about (`knowable`). Whether the *issue* exists is the answer's
 * (`loadTaskAnswer`), which arrives after the page is sent: GitHub's 404 for a
 * ticket the log never touched is a page that says so, and a GitHub that could
 * not be asked is a page that says that, never a 404.
 */
/** Only the wait the blocked lifecycle names can lend its paraphrase to the page. */
export function currentWaitWant(own: readonly Envelope[], standing: StandingView): string | null {
  if (standing.state !== 'blocked' || standing.waitId === null || standing.reason === null) return null
  const status = triageStatus(standing.reason, triageFactsOf(own, standing.waitId), {
    declared: false,
    daemonStartedAt: null,
  })
  return status._tag === 'Done' && status.result._tag === 'TriageAdvised' ? status.result.want : null
}

/** A projected triage belongs on the page only while it names the reduced current wait. */
export function currentTriageStatus(
  standing: StandingView,
  card: Pick<TaskCard, 'wait' | 'triage' | 'triageHeadSha'> | null,
  context: { declared: boolean; daemonStartedAt: Date | null },
): { status: TriageStatus; headSha: string | null } | null {
  if (standing.state !== 'blocked' || standing.waitId === null || standing.reason === null) return null
  if (card?.wait?.waitId !== standing.waitId) return null
  const status = triageStatus(standing.reason, card.triage, context)
  return { status, headSha: status._tag === 'Done' ? card.triageHeadSha : null }
}

/** Read the inputs for this wait; a failed read must reach the page as an error. */
export async function loadCurrentTriageStatus(
  taskId: string,
  projectName: string,
  standing: StandingView,
): Promise<{ status: TriageStatus; headSha: string | null } | null> {
  const [cards, project, daemon] = await Promise.all([
    readTasks({ project: projectName }),
    loadProject(projectName).then((state) => (state === null ? null : currentRecipe(state))),
    readStatus(),
  ])
  const card = cards.find((row) => row.taskId === taskId)
  return currentTriageStatus(standing, card ?? null, triageContextOf(project?.recipe.triage !== undefined, daemon))
}

/** The run whose wait the ticket is stopped at now, else null; an `OwnQuestion` hold names none (D13). */
export function heldRunOf(life: TicketLifecycle): string | null {
  return life.status === 'blocked' ? life.runId : null
}

/**
 * The control stream, read once however many places of one render ask: the
 * layout's reductions and the queue's `paused` (0118 §2). Never rejects.
 */
const readConductor = cache(() =>
  timed('events.control', async () => readControl(undefined, 0, { writer: await boardWriterOrNone() })).catch(() =>
    evaluateControl(emptyControl, new Date()),
  ),
)

/** The ticket's own stream, read once however many segments of one render ask (#885). */
const readOwn = cache((taskId: string) => timed('events.task', () => eventStore.read(taskId)))

/**
 * What the layout and the open tab share: the ticket stream, every claim's
 * stream, the spend rows, and the attempts reduced from them — `presentAttempt`,
 * `standingOf`, the last attempt's `progressOf` with the recipe's plan, and each
 * attempt's bill. **One function, so nothing is reduced a second way** (#885):
 * `loadTask` and `loadAttemptTab` both call it.
 *
 * Keyed by the id string, because React's `cache` memoizes on argument identity
 * and any array a caller built would never hit. The project comes from the id
 * (`parseTicketStream`), never from GitHub, so a tab reads no issue to learn it.
 */
export const readAttempts = cache(async (taskId: string) => {
  const own = await readOwn(taskId)

  // Every claim, and not the last one. A task can be claimed several times —
  // `ticket-lingtai-87` three, `ticket-lingtai-89` twice — and each claim opens a stream
  // of its own that the page kept no room for (#102).
  const ticketState = reduceTicket(own)
  const claims = ticketState.claims

  // `spend` beside the run streams: this ticket's whole bill, read once rather
  // than per run or per discussion (`#498`). Reduced to the head first, the way
  // `loadBoard`'s card read does — a bare read left the task page and the board
  // reading two different currencies of the same money (`#498`'s review).
  const [streams, spendFold] = await Promise.all([
    claims.length > 0
      ? timed('events.run', () => Promise.all(claims.map((c) => eventStore.read(c.runId))), {
          desc: String(claims.length),
        })
      : Promise.resolve([] as Envelope[][]),
    timed('spend.read', () => currentSpend({ ticket: taskId })),
  ])
  const spend = spendFold.rows

  // Each stream is reduced once; everything below draws from these states.
  const states = claims.map((_, i) => reduceAttempt(streams[i] ?? []))
  // Held here: the ticket is stopped at a wait **this** attempt's run asked (D13).
  const heldRun = heldRunOf(ticketState.lifecycle)
  const branch = ticketState.externalRef === null ? '' : agentBranchOf(ticketState.externalRef)
  const reduced = claims.map((c, i) =>
    presentAttempt(states[i]!, c, i + 1, progressOf(states[i]!, undefined, false), c.runId === heldRun, branch),
  )
  const standing = standingOf(own, reduced)

  // `plan` where the item is running or blocked: a gate's bound is the
  // recipe's, and a phase in flight or one that stopped mid-gate are the two
  // readings with a denominator to draw — and the second is also `held`'s
  // only source for a ceiling the run's own stream never named (`#415`). The
  // project is the id's, from `parseTicketStream`.
  const project = parseTicketStream(taskId)?.project ?? null
  const planAndLimits =
    (standing.state === 'running' || standing.state === 'blocked') && project !== null
      ? await timed('next.plan', () => planFor(project))
      : undefined
  const plan = planAndLimits?.plan
  const limits = planAndLimits?.limits ?? null

  // The last attempt reduced again with what only this function holds. **Only
  // the last**, and `over` only where the item landed: an earlier attempt was
  // released or refused, and its later points recorded nothing because nothing
  // should have run in them — the same line `RailCandidate.over` holds, and
  // drawing the hatch there would be inventing Lingtai's bug (0041 §4).
  const last = reduced.length - 1
  const landed = standing.state === 'landed'
  const runs = (
    last >= 0 && (landed || plan !== undefined)
      ? reduced.map((r, i) => (i === last ? { ...r, progress: progressOf(states[i]!, plan, landed) } : r))
      : reduced
  ).map((r) => {
    // This attempt's own spend: the rows whose `pass` is this run's stream —
    // `Action` and `Judge` both land there, because a dispatch within one
    // pass appends to the pass's own stream (`spend.ts`, `@lingtai/projector`).
    // An attempt that predates `RunSpent` contributes not one row, and that
    // is unknown rather than free (0110 §7, `#498`'s review).
    const rowsForRun = spend.filter((row) => row.pass === r.runId)
    const costUsd = rowsForRun.length > 0 ? totalBill(billOf(rowsForRun)) : unknownBill(1)
    return { ...r, costUsd }
  })

  return { own, ticketState, claims, streams, states, spendFold, standing, runs, limits }
})

export async function loadTask(taskId: string): Promise<TaskDetail | null> {
  // The control stream is read for the seven types the reducer handles only: it
  // also holds a `Reconciled` per daemon start, 22 KB each and never read here
  // (#796). It is here
  // because a discussion that has not been concluded exists only as a request
  // on it — the work item learns about the conversation when it ends (0033 §6).
  //
  // Beside the attempts rather than after them: one side is a handful of
  // database reads and the other is two calls to GitHub, and the page waits for
  // the slower of the two instead of for both.
  //
  // **No GitHub in it** (0118 §2): the issue's answer is `loadTaskAnswer`, which
  // the layout starts beside this and the page reads where it is drawn.
  const [shared, ticket, control, lane] = await Promise.all([
    readAttempts(taskId),
    readOwn(taskId).then((own) => loadTicketBase(taskId, own)),
    readConductor(),
    timed('tasks.read', () => readTasks({})).catch(emptyIfUnbuilt),
  ])
  const { own, ticketState, claims, streams, states, spendFold, standing: foldedStanding, runs, limits } = shared
  const spend = spendFold.rows

  // **The only thing that decides a 404**, and it needs no GitHub. See `knowable`.
  if (ticket === null) return null

  const chats = chatIdsFor(control.discussions, ticketState.discussions, taskId)
  const chatStreams =
    chats.length > 0
      ? await timed('events.chat', () => Promise.all(chats.map((c) => eventStore.read(chatStream(c.chatId)))), {
          desc: String(chats.length),
        })
      : []
  const discussions = chats.map((c, i) => presentChat(c.chatId, chatStreams[i] ?? [], c.held))

  const keptAt = foldedStanding.unpushed?.keptAt
  const unpushedMirror =
    keptAt?._tag === 'Mirror'
      ? {
          path: mirrorPathFor(ticket.project),
          sha: await timed('mirror.ref', () => refSha({ project: ticket.project, ref: keptAt.ref })),
        }
      : null
  let triage: Awaited<ReturnType<typeof loadCurrentTriageStatus>> = null
  if (foldedStanding.state === 'blocked' && foldedStanding.waitId !== null && foldedStanding.reason !== null) {
    triage = await timed('triage.read', () => loadCurrentTriageStatus(taskId, ticket.project, foldedStanding))

    // A crash that stands in for a wait is advised by the triage the person saw
    // for that wait, which the projected card does not carry (#654).
    if (foldedStanding.reason._tag === 'AgentCrashed' && foldedStanding.reason.standing !== undefined) {
      triage = {
        status: triageStatus(
          foldedStanding.reason.standing.reason,
          triageFactsOf(own, foldedStanding.reason.standing.waitId),
          { declared: false, daemonStartedAt: null },
        ),
        headSha: null,
      }
    }
  }
  const status = triage?.status ?? null
  const triageHeadLineText =
    status?._tag === 'Done' && triage?.headSha !== null && triage?.headSha !== undefined
      ? triageHeadLine(
          triage.headSha,
          await timed('mirror.ref', () =>
            mirrorBranchSha({ project: ticket.project, ref: `refs/heads/${agentBranchOf(ticket.ref)}` }),
          ),
        )
      : null
  const standing: StandingView = { ...foldedStanding, triageStatus: status, triageHeadLine: triageHeadLineText }
  if (
    standing.state === 'blocked' &&
    standing.reason !== null &&
    allowedResolutions(standing.reason).includes('GrantFixRound') &&
    standing.runId !== null
  ) {
    const runIndex = claims.findIndex((claim) => claim.runId === standing.runId)
    const saved = savedFixWork(standing.runId, streams[runIndex] ?? [])
    if ('refusal' in saved) standing.fixWork = saved
    else {
      try {
        const state = await loadProject(ticket.project)
        if (!state) throw new Error(`no project named "${ticket.project}" — run lingtai add first`)
        const client =
          state.owner === null
            ? (await ownerlessClient(state, (await currentRecipe(state)).recipe)).client
            : hasGitHubAuth()
              ? (await projectClient(state)).client
              : null
        if (client === null) throw new Error('no GitHub App configured')
        const remote = await timed('github.ref', () => client.refSha(`heads/${saved.ref}`))
        standing.fixWork =
          remote === saved.head
            ? saved
            : {
                refusal: `${saved.ref} is ${remote ?? 'missing'}, not the saved ${saved.head}. Restore that ref to the saved head or start over from base.`,
              }
      } catch (err) {
        standing.fixWork = { refusal: `The saved ref could not be checked: ${(err as Error).message}` }
      }
    }
  }
  if (
    standing.state === 'blocked' &&
    standing.waitId !== null &&
    standing.reason !== null &&
    allowedResolutions(standing.reason).includes('Split')
  ) {
    const state = await loadProject(ticket.project)
    const tickets = state === null ? 'github' : ticketSourceOf((await currentRecipe(state)).recipe)
    standing.split = {
      progress: splitProgressOf(own, {
        waitId: standing.waitId,
        instance: splitInstance(),
        running: isSplitRunning(standing.waitId),
      }),
      tickets,
    }
  }
  const want = status?._tag === 'Done' && status.result._tag === 'TriageAdvised' ? status.result.want : null
  // The run the state names, reduced with the recipe's bounds above — the same
  // one `Standing`'s own `progress` prop reads (`#415`). Null wherever there
  // is nothing to spend yet, or the run that is running will not say.
  const named = runs.find((r) => r.runId === standing.runId)?.progress ?? null
  // The rounds come off the run's state and the grants off `spend` (#826); only
  // where there is progress, so a run with nothing to spend has no held line.
  const namedGranted = grantedOf(spend.filter((row) => row.pass === standing.runId))
  const held =
    named === null
      ? null
      : describeHeld({
          spent: spentOf(states[claims.findIndex((c) => c.runId === standing.runId)]?.roundsOpened ?? [], namedGranted),
          granted: namedGranted,
          roundsOf: limits?.rounds ?? null,
          restarts: standing.restarts,
          restartsOf: standing.restartsOf > 0 ? standing.restartsOf : (limits?.restarts ?? null),
        })

  return {
    taskId,
    unpushedMirror,
    standing,
    want,
    // An unpushed branch is not GitHub's `agent/<n>`, so its compare view would
    // show some other diff or none; the page falls back to the shas (#590).
    ticket: standing.unpushed !== null ? { ...ticket, compareUrl: null } : ticket,
    runs,
    discussions,
    held,
    totals: totalsOf(runs, discussions, spend),
    spendCurrency: spendFold.currency,
    waiting: waitingNeighbours(lane, taskId),
    events: own.length,
  }
}

/** What one attempt's tab shows: the attempt, and the page's standing for the reasoning it may carry. */
export interface AttemptTabDetail {
  taskId: string
  project: string
  run: AttemptView
  /** The folded standing — `diagnosis`, `saidBy`, `deciding` and `state` are all the tab reads. */
  standing: StandingView
  /** This attempt's stream, as history rows. */
  events: HistoryLine[]
}

/**
 * One attempt's tab, and nothing above the record (#885).
 *
 * **It never calls `loadTask`**, so a soft navigation between tabs reads no
 * GitHub issue, no control stream, no triage and no queue: those belong to the
 * layout, which Next does not re-render on a navigation. It shares
 * `readAttempts` with the layout — the same reduction, one read each within a
 * render — and adds the one thing only this tab shows, the recipe attempt `n`
 * was given (`client.fileAt` is cached per sha). Null for an attempt this
 * ticket does not have.
 */
export async function loadAttemptTab(taskId: string, n: number): Promise<AttemptTabDetail | null> {
  const { runs, streams, standing } = await readAttempts(taskId)
  const run = runs[n - 1]
  if (run === undefined) return null
  const project = parseTicketStream(taskId)?.project ?? null
  const recipe = project === null ? undefined : (await recipesFor(project, [run])).get(run.runId)
  const group = groupHistory(streams[n - 1] ?? [], new Map(runs.map((r, i) => [r.runId, i + 1])))[0]
  return {
    taskId,
    project: project ?? '',
    run: recipe ? { ...run, recipe } : run,
    standing,
    events: group?.lines ?? [],
  }
}

/**
 * Everything on the task page that only the issue's answer knows, in one promise
 * that **never rejects** (0118 §2): the ticket's title, labels, link and body,
 * and the two reads that need them — what the next attempt will be handed
 * (`outgoingFor` wants the body) and where the item is in line (`queuedFor` asks
 * GitHub).
 *
 * The layout starts it beside `loadTask`, in a `measure` of its own, and does
 * not await it: the page is sent when the log and the database have answered,
 * and each place that reads this draws *asking GitHub…* until it arrives.
 *
 * Asked only where it says anything, as it always was: `outgoing` where a next
 * attempt is possible (a run in flight has been handed its prompt already and a
 * landed item will never be handed another, 0032 §5), `queued` where the item is
 * queued, the one state that is not in the log at all. And neither for a ticket
 * the log has never touched and GitHub has no issue for: that page says so.
 */
export async function loadTaskAnswer(taskId: string): Promise<TaskAnswer> {
  const ticket = await loadTicketAnswer(taskId)
  const parsed = parseTicketStream(taskId)
  if (!parsed) return { ticket, outgoing: null, queued: null }
  try {
    const [shared, control] = await Promise.all([readAttempts(taskId), readConductor()])
    const { own, streams, standing } = shared
    if (ticket.found === false && own.length === 0) return { ticket, outgoing: null, queued: null }
    const reduced = reduceTicket(own)
    const base: TicketBase = {
      project: parsed.project,
      ref: parsed.issue,
      title: reduced.title,
      kind: reduced.kind,
      labels: [...reduced.labels],
      url: null,
      compareUrl: null,
    }
    const [outgoing, queued] = await Promise.all([
      standing.state === 'blocked' || standing.state === 'queued'
        ? timed('next.outgoing', () => outgoingFor({ own, streams, ticket: withAnswer(base, ticket) })).catch((err) =>
            refusedOutgoing((err as Error).message),
          )
        : null,
      standing.state === 'queued'
        ? timed('next.queued', () =>
            queuedFor({ project: parsed.project, issue: parsed.issue, own, paused: control.paused }),
          ).catch((err) => refusedQueued((err as Error).message, null, control.paused))
        : null,
    ])
    return { ticket, outgoing, queued }
  } catch {
    // The log could not be read; `loadTask` says so for itself. What GitHub said stands.
    return { ticket, outgoing: null, queued: null }
  }
}

/** The Ticket tab: the ticket as it was written, and the ticket stream's events. */
export interface TicketTabDetail {
  taskId: string
  /** What the log and the register give; GitHub's part is `loadTicketAnswer`. Null for an id that is not a ticket id. */
  ticket: TicketBase | null
  events: HistoryLine[]
}

/**
 * The Ticket tab's reads: the ticket stream, and **nothing from GitHub** (0118 §2).
 * The tab draws the log's part at once and reads `loadTicketAnswer` where the
 * body goes. Null only for an id a 404 may rest on (`knowable`).
 */
export async function loadTicketTab(taskId: string): Promise<TicketTabDetail | null> {
  const own = await readOwn(taskId)
  const ticket = await loadTicketBase(taskId, own)
  if (ticket === null) return null
  // The ticket stream's claims are what its `TicketClaimed` rows name, so the
  // map is built from the same reduction `readAttempts` numbers the tabs by.
  const attempts = new Map(reduceTicket(own).claims.map((c, i) => [c.runId, i + 1]))
  return { taskId, ticket, events: groupHistory(own, attempts).flatMap((g) => g.lines) }
}
