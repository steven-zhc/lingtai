/**
 * **The problems a step raised, and who finally answered each** (#1284, 0123 §2's
 * `problems`) — the figures behind *handled for you*.
 *
 * A problem cannot be reduced one event at a time: a route's answer is a wait that
 * may resolve days later, on another stream. So the projection keeps the raw
 * `Raised` facts (routes and redos) and calls `problemsOf` with the ticket's
 * reduced `waits` and `claims` on every save. This is the one rule; nothing else
 * decides a kind or a `system`/`you`.
 *
 * **One problem is counted once, by who finally answered it.** A route that opened
 * a wait is not a problem on its own: the pair is one, with the route's kind and
 * the wait's answer. Nothing on the log links the two (`ProposalRouted` carries no
 * `waitId`), so a wait with a `run` claims the **last** route (or redo group) on
 * that run at or before the wait's `at`, if its tags agree: the route batch is
 * appended before the pass's ending, so on one run the route that ended the pass is
 * the last one before the wait. A route whose move then failed (`Selected`, then a
 * `ProposedEscalated`) is claimed the same way, so it is one problem and not two.
 */
import type { TicketClaim, TicketWait } from './ticket.ts'
import type { WaitReason } from './wait.ts'

/** The kinds, in the page's order; `other` last. */
export const PROBLEM_KINDS = [
  'review-fixed',
  'review-restarted',
  'base-moved',
  'conflict',
  'build',
  'stopped',
  'disputed',
  'too-big',
  'asked',
  'setup',
  'other',
] as const
export type ProblemKind = (typeof PROBLEM_KINDS)[number]

export type Answerer = 'system' | 'you'

/** What the projection keeps: a route, or a step a crash cut off and was redone in place. */
export type Raised =
  | {
      readonly _tag: 'Route'
      readonly seq: string
      readonly at: string
      readonly runId: string
      readonly proposal: string
      /** The selected candidate; null for an escalation. */
      readonly candidate: string | null
      readonly decision: 'Selected' | 'Escalated'
    }
  | { readonly _tag: 'Redo'; readonly seq: string; readonly at: string; readonly runId: string; readonly step: string }
  /** A `WaitResolved`, kept because the ticket reduce keeps only the first and the last one decides. */
  | {
      readonly _tag: 'Answer'
      readonly seq: string
      readonly at: string
      readonly waitId: string
      readonly by: string
      readonly resolution: string
    }

export interface Problem {
  readonly kind: ProblemKind
  readonly at: string
  /** The number of the claim it was raised in, from 1; null where no claim is known. */
  readonly attempt: number | null
  /** Who finally answered it: `you` also while it is still open. */
  readonly answeredBy: Answerer
  /** The wait that answered it, where there was one. */
  readonly waitId: string | null
}

const KIND_OF_PROPOSAL: Readonly<Record<string, ProblemKind>> = {
  ReviewFindings: 'review-fixed',
  BaseMoved: 'base-moved',
  MergeConflict: 'conflict',
  BuildRed: 'build',
  VerifyRed: 'build',
  FixerDisagrees: 'disputed',
  DiffTooLarge: 'too-big',
  InputNeeded: 'asked',
  SetupRefused: 'setup',
}

const kindOfRoute = (proposal: string, candidate: string | null): ProblemKind =>
  proposal === 'ReviewFindings' && candidate === 'restart'
    ? 'review-restarted'
    : (KIND_OF_PROPOSAL[proposal] ?? 'other')

const KIND_OF_WAIT: Readonly<Record<string, ProblemKind>> = {
  AgentCrashed: 'stopped',
  FixerDisagrees: 'disputed',
  AgentQuestion: 'asked',
  SetupRefused: 'setup',
}

/** The reason a wait stands for: a limit wait is the question it replaced. */
const reasonOf = (w: TicketWait): WaitReason => (w.reason._tag === 'AskLimit' ? w.reason.asked : w.reason)

/** A wait's own kind, off its reason, and a triage cause or a completed split that names it. */
function kindOfWait(w: TicketWait, split: boolean): ProblemKind {
  const reason = reasonOf(w)
  const over = kindOfWaitOverride(w, split)
  if (over !== null) return over
  if (reason._tag === 'ProposedEscalated') return kindOfRoute(reason.proposal._tag, null)
  return KIND_OF_WAIT[reason._tag] ?? 'other'
}

/** Whether a wait's reason is the one a route for `proposal` opens. */
function agrees(w: TicketWait, proposal: string): boolean {
  const reason = reasonOf(w)
  switch (reason._tag) {
    case 'ProposedEscalated':
      return reason.proposal._tag === proposal
    case 'AgentQuestion':
      return proposal === 'InputNeeded'
    case 'FixerDisagrees':
      return proposal === 'FixerDisagrees'
    case 'SetupRefused':
      return proposal === 'SetupRefused'
    default:
      return false
  }
}

const runOf = (w: TicketWait): { runId: string } | null => {
  const r = reasonOf(w) as { run?: { runId: string } }
  return r.run ?? null
}

type Item =
  | { readonly t: 'route'; readonly r: Extract<Raised, { _tag: 'Route' }>; claimedBy: TicketWait | null }
  | {
      readonly t: 'redo'
      readonly runId: string
      readonly step: string
      readonly at: string
      claimedBy: TicketWait | null
    }

type Answers = ReadonlyMap<string, { by: string; resolution: string }>

/** The wait's deciding resolution: the last `WaitResolved` kept, else the reduce's first. */
const finalOf = (w: TicketWait, answers: Answers): { by: string; resolution: string } | null =>
  answers.get(w.waitId) ??
  (w.resolution === null ? null : { by: w.resolution.by, resolution: w.resolution.resolution._tag })

const answerOf = (w: TicketWait | null, answers: Answers): Answerer =>
  w !== null && finalOf(w, answers)?.by === 'triage' ? 'system' : 'you'

/** Always a person's: the table says a question or a broken setup is never answered by the system. */
const alwaysYou = (kind: ProblemKind): boolean => kind === 'asked' || kind === 'setup'

export function problemsOf(
  raised: readonly Raised[],
  waits: readonly TicketWait[],
  claims: readonly Pick<TicketClaim, 'runId' | 'at'>[],
): Problem[] {
  const ordered = [...raised].sort((a, b) =>
    BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0,
  )
  const answers = new Map<string, { by: string; resolution: string }>()
  /** Waits any resolution of which was a split: a completed split is a fact a later resolution does not undo. */
  const splits = new Set<string>()
  const items: Item[] = []
  const last = new Map<string, Item>()
  for (const r of ordered) {
    if (r._tag === 'Answer') {
      answers.set(r.waitId, { by: r.by, resolution: r.resolution })
      if (r.resolution === 'Split') splits.add(r.waitId)
      continue
    }
    const before = last.get(r.runId)
    if (r._tag === 'Redo' && before?.t === 'redo' && before.step === r.step) continue
    const item: Item =
      r._tag === 'Route'
        ? { t: 'route', r, claimedBy: null }
        : { t: 'redo', runId: r.runId, step: r.step, at: r.at, claimedBy: null }
    items.push(item)
    last.set(r.runId, item)
  }

  const splitOf = (w: TicketWait): boolean => splits.has(w.waitId) || w.resolution?.resolution._tag === 'Split'
  const waitsInOrder = [...waits].sort((a, b) => a.at.getTime() - b.at.getTime())
  const lonely: TicketWait[] = []
  for (const w of waitsInOrder) {
    const run = runOf(w)
    const reason = reasonOf(w)
    const mine = run === null ? [] : items.filter((i) => (i.t === 'route' ? i.r.runId : i.runId) === run.runId)
    const before = mine.filter((i) => Date.parse(i.t === 'route' ? i.r.at : i.at) <= w.at.getTime())
    // A crash's redos and a route are written apart (the routes are appended after the walk returns), so
    // each kind of wait looks only among its own kind of item: append order is not the order they happened in.
    const last =
      reason._tag === 'AgentCrashed'
        ? before.filter((i) => i.t === 'redo' && i.step === reason.step && i.claimedBy === null).at(-1)
        : before.filter((i) => i.t === 'route').at(-1)
    const hit =
      last !== undefined &&
      last.claimedBy === null &&
      (last.t === 'route' ? agrees(w, last.r.proposal) : reason._tag === 'AgentCrashed')
    if (hit) last.claimedBy = w
    else lonely.push(w)
  }

  const attemptOf = (runId: string, at: string): number | null => {
    const i = claims.findIndex((c) => c.runId === runId)
    if (i >= 0) return i + 1
    const n = claims.filter((c) => c.at.getTime() <= Date.parse(at)).length
    return n === 0 ? null : n
  }

  const out: Problem[] = []
  for (const i of items) {
    if (i.t === 'redo') {
      const w = i.claimedBy
      const kind = w === null ? 'stopped' : (kindOfWaitOverride(w, splitOf(w)) ?? 'stopped')
      out.push({
        kind,
        at: i.at,
        attempt: attemptOf(i.runId, i.at),
        answeredBy: alwaysYou(kind) ? 'you' : w === null ? 'system' : answerOf(w, answers),
        waitId: w?.waitId ?? null,
      })
      continue
    }
    const { r, claimedBy: w } = i
    const kind =
      w === null
        ? kindOfRoute(r.proposal, r.candidate)
        : (kindOfWaitOverride(w, splitOf(w)) ?? kindOfRoute(r.proposal, r.candidate))
    const handed = r.decision === 'Escalated' || r.candidate === 'hand-to-person'
    const answeredBy: Answerer = alwaysYou(kind) ? 'you' : w !== null ? answerOf(w, answers) : handed ? 'you' : 'system'
    out.push({ kind, at: r.at, attempt: attemptOf(r.runId, r.at), answeredBy, waitId: w?.waitId ?? null })
  }
  for (const w of lonely) {
    if (w.reason._tag === 'OwnQuestion') continue
    const kind = kindOfWait(w, splitOf(w))
    const at = w.at.toISOString()
    const run = runOf(w)
    out.push({
      kind,
      at,
      attempt: run === null ? attemptOf('', at) : attemptOf(run.runId, at),
      answeredBy: alwaysYou(kind) ? 'you' : answerOf(w, answers),
      waitId: w.waitId,
    })
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** Only a triage cause or a completed split overrides a route's kind; a wait's reason alone does not. */
function kindOfWaitOverride(w: TicketWait, split: boolean): ProblemKind | null {
  const result = w.triage.result
  const cause = result === null || result._tag === 'TriageFailed' ? null : result.cause._tag
  if (cause === 'UndecidedQuestion') return 'asked'
  if (cause === 'SetupBroken') return 'setup'
  return split ? 'too-big' : null
}
