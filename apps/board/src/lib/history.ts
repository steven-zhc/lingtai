/**
 * A line of history, and the payload behind it.
 *
 * The history is where an event-sourced system is legible or is not, and it
 * was legible for six types out of forty. Everything else fell to a default
 * that printed `data.gate` when there was one and the empty string when there
 * was not, so `StepsResolved` — the plan ADR 0016 §4 rests on — rendered as a
 * timestamp, a type name and nothing at all (#87).
 *
 * Three rules, and the third is the one that holds the others:
 *
 *   1. **Every event type has a sentence**, in the glossary's words
 *      (`doc/glossary.md`, *Words on the board*): an attempt is `Attempt N`,
 *      never a stream id or a run id; a path is relative to the repository; a
 *      version string is not a caption. The type is shown beside it and the
 *      fields one click further, so the sentence is the row.
 *   2. **The fallback is a sentence that points into the open row** —
 *      `recorded <Type>; open for its fields` — and never the payload printed
 *      as `key=value`. It exists so that a formatter which throws on a payload
 *      of a shape it does not know (an old schema version, a missing field)
 *      costs a sentence and not the page.
 *   3. **The catalogue test, not the type, holds rule 1.** `FORMAT` is a
 *      `Partial<Record<EventType, …>>` on purpose: a total record would make
 *      adding an event break the board's typecheck, and the types
 *      `boardFactOf` owns are already sentences in `FACT_FORMAT`, which a total
 *      `FORMAT` would write twice. `history.test.ts` renders a schema-valid
 *      sample of every type in `EVENTS` and fails on one that falls back, so
 *      being behind the catalogue is a red test rather than a blank row.
 *
 * Pure, and its own module for that reason: `task.ts` reaches the database and
 * GitHub, and what a row *says* is testable without either.
 */
import type { BoardFact, Envelope, EventType, PayloadOf, StepOutcome } from '@lingtai/domain'
import { boardFactOf, fromOf, resolveOffer, routeMove, routeNext, waitWords } from '@lingtai/domain'
import type { ClaimShape } from '@lingtai/domain'

import { sourceOfPayloadDocument, type DocumentSource } from './markdown.ts'
import { RESOLUTION_COPY } from './resolution-copy.ts'
import { billText, unknownBill, type Bill } from './spend.ts'
import { presentCause } from './triage-cause.ts'

/** One row: the four columns, plus everything the disclosure shows. */
export interface HistoryLine {
  at: string
  type: string
  /** The actor, whole. Shown as the `title` of `who` (#87). */
  actor: string
  /** The actor in words: `conductor`, `Attempt 2's agent`, a person's name. */
  who: string
  /** The event as a sentence in the glossary's words. */
  summary: string
  /** The ids the sentence could not name as an attempt of this ticket, for its `title`; empty otherwise. */
  summaryTitle: string
  /** Global order. The thing a finding cites when it wants to be believed. */
  seq: string
  streamId: string
  version: number
  schemaVer: number
  /**
   * The payload's structure, pretty-printed, with every document lifted out of
   * it and marked where it stood. See `splitPayload`.
   */
  raw: string
  /** The documents that were lifted, in the order the payload holds them. */
  documents: PayloadDocument[]
}

/**
 * A payload field whose value is itself a document.
 *
 * `RunPrompted.prompt` is the one that forced this, but it is not the only one
 * and naming them is not the fix — see `splitPayload`.
 */
export interface PayloadDocument {
  /** Where it sat in the payload: `prompt`, or `diagnosis.raw` for a nested one. */
  field: string
  /** The value itself, with its own newlines. */
  text: string
  /** Its size, in the unit `RunPrompted.bytes` already reports. */
  bytes: number
  /**
   * Who wrote it, which is the only thing that settles how it may be rendered.
   *
   * Carried on the document rather than worked out where it is displayed, so a
   * document cannot arrive at a renderer having lost its provenance on the way.
   * See `markdown.ts` for the rule and for why `log` is the default.
   */
  source: DocumentSource
}

type Payload = Record<string, unknown>

/**
 * What a sentence needs from outside its own event.
 *
 * `attempts` maps an attempt's stream id (`pass-…`, which is also the `runId`
 * a `TicketClaimed` carries and what follows `agent:` in an actor) to its
 * number N on this ticket. It is required: an empty map is a bug in the loader,
 * and the type checker is what finds the caller that forgot it.
 */
export interface LineContext {
  attempts: ReadonlyMap<string, number>
  /** The ticket's `agent/<n>`, when the caller has one to give — only `PassRouted` reads it. */
  branch?: string
  /** Set by `groupHistory` on a `TicketClaimed` / `TicketContinued`, which is the only place the stream before it is known. */
  claim?: ClaimShape
  /**
   * The `StepEnded` outcomes on this event's own stream, by version — what a
   * `ProposalRouted` names its evidence by (0100 §14, #932). Set by
   * `groupHistory`; a caller with only the one event has none, and a route that
   * needs one then says the evidence was not found.
   */
  endedAt?: (version: number) => StepOutcome | undefined
}

/** What a formatter reads besides its payload; `unknown` collects the ids it could not name. */
interface Reading extends LineContext {
  streamId: string
  unknown: Set<string>
}
type Formatter = (d: Payload, r: Reading) => string

const OTHER_TICKET = 'another ticket'

/** `Attempt N`, or `an attempt of another ticket` — the id goes to the row's `title`, never the text. */
function attemptName(r: Reading, id: string): string {
  const n = r.attempts.get(id)
  if (n !== undefined) return `Attempt ${n}`
  r.unknown.add(id)
  return `an attempt of ${OTHER_TICKET}`
}

/** `Attempt N's agent`, or `an agent of another ticket`. */
function attemptAgent(r: Reading, id: string): string {
  const n = r.attempts.get(id)
  if (n !== undefined) return `Attempt ${n}'s agent`
  r.unknown.add(id)
  return `an agent of ${OTHER_TICKET}`
}

/** A name for whoever `by` is: a person by name, an attempt's agent as `Attempt N's agent`. */
function byName(r: Reading, by: string): string {
  return by.startsWith('agent:') ? attemptAgent(r, by.slice('agent:'.length)) : personName(by)
}

/** `human:steven` → `steven`; anything else as it was written. */
function personName(by: string): string {
  return by.startsWith('human:') ? by.slice('human:'.length) : by
}

const upper = (s: string) => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1))

/** Everything up to and including `/worktrees/<project>/<stream id>/` is where the attempt happened to be checked out. */
const WORKTREE_PREFIX = /^.*\/worktrees\/[^/]+\/[^/]+\//

function repoPath(path: string): string {
  return path.replace(WORKTREE_PREFIX, '')
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

/** What a row says when the sentence could not be built; the fields are in the open row. */
function recorded(type: string): string {
  return `recorded ${type}; open for its fields`
}

/**
 * How much free text a row carries before it is cut.
 *
 * A refusal's `detail` is the raw failure verbatim and a blocking question can
 * be a paragraph; either one turns the history into a wall. Cutting is only
 * defensible because the whole value is in the disclosure — which is the half
 * of "deliberately terse" that #112 and #87 both found missing.
 */
const CLIP = 160

function clip(v: unknown, n = CLIP): string {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/**
 * A field the sentence is built out of.
 *
 * Throws when it is not there, and `summarise` answers with the payload
 * instead. That is the point: a formatter given a payload it does not
 * recognise — an older schema version, a type whose shape moved on — must not
 * print `undefined · undefined`, and the raw payload is a better answer than
 * any sentence it could still assemble.
 */
function need(d: Payload, key: string): string {
  const v = d[key]
  if (v === null || v === undefined || v === '') throw new Error(`no ${key}`)
  return String(v)
}

/** A sha, at the length everything else in this app shows one. */
function sha(d: Payload, key: string, n = 7): string {
  return need(d, key).slice(0, n)
}

function list(v: unknown): string {
  return Array.isArray(v) ? v.map(String).join(', ') : String(v ?? '')
}

/**
 * A gate row names the **action**, not only the point.
 *
 * Three gates at one point printed `prepared` three times and were
 * indistinguishable, which is the same confusion `gate`/`action` was split
 * into two fields to end.
 */
function stepAt(d: Payload): string {
  return `${need(d, 'step')} · ${need(d, 'action')}`
}

/** `StepStarted` carries the step and the round and no action: it begins once per step (events.ts). */
const stepStarted: Formatter = (d) => {
  const round = typeof d['round'] === 'number' && d['round'] > 0 ? ` (round ${d['round']})` : ''
  return `${need(d, 'step')} started${round}`
}

/** Who a `RunSpent` paid for, from its `for` — the same switch `who` reads. */
function spentBy(d: Payload, r: Reading): string {
  const spentFor = d['for'] as { _tag?: string; step?: string; name?: string } | undefined
  switch (spentFor?._tag) {
    case 'Action':
      return `${attemptAgent(r, r.streamId)} (${spentFor.name ?? spentFor.step})`
    case 'Judge':
      return 'the judge'
    case 'Triage':
      return 'triage'
    case 'Discussion':
      return 'a discussion'
    default:
      throw new Error('no for')
  }
}

/** `triage run 2` for an agent, `triage 2 (mechanical)` for the other arm. */
function triageName(by: { _tag?: string }, attempt: string | number): string {
  return by._tag === 'Agent' ? `Triage run ${attempt}` : `Triage ${attempt} (mechanical)`
}

function agentOf(by: { runtime?: string; model?: string }): string {
  return by.runtime ? ` (${by.runtime}${by.model ? `, ${by.model}` : ''})` : ''
}

const FORMAT: Partial<Record<EventType, Formatter>> = {
  // ------------------------------------------------------------ work item --
  TicketDiscovered: (d) => `#${need(d, 'externalRef')} ${need(d, 'kind')} — ${clip(need(d, 'title'))}`,
  // A claim whose run an earlier claim already carried is a continuation (`claimShapeOf`).
  TicketClaimed: (d, r) =>
    `${attemptName(r, need(d, 'runId'))} ${r.claim === 'continuation' ? 'continued' : 'claimed'}`,
  TicketContinued: (d, r) => `${attemptName(r, need(d, 'runId'))} continued`,
  TicketReleased: (d, r) => `${attemptName(r, need(d, 'runId'))} released: ${clip(need(d, 'reason'))}`,
  TicketClosed: (d) => `Ticket closed by ${personName(need(d, 'by'))}: ${clip(d['reason'])}`,
  TicketSplit: (d) => {
    const children = Array.isArray(d['children']) ? (d['children'] as { number: number }[]) : []
    if (children.length === 0) throw new Error('no children')
    return `Ticket split into ${children.length} tickets: ${children.map((c) => `#${c.number}`).join(', ')}`
  },
  SplitStarted: (d) => {
    const plan = d['plan'] as { children?: unknown[] } | undefined
    if (!Array.isArray(plan?.children)) throw new Error('no plan')
    return `Split started: ${plan.children.length} child ticket${plan.children.length === 1 ? '' : 's'} to write`
  },
  SplitChildWritten: (d) => `Child ticket #${need(d, 'number')} written`,
  SplitLinkWritten: (d) => `Link written: ${need(d, 'ticket')} is blocked by ${need(d, 'blockedBy')}`,
  SplitFailed: (d) => `Split failed at ${need(d, 'step')}: ${clip(d['detail'])}`,
  TicketLinked: (d) => `${need(d, 'relation')} ${need(d, 'otherRef')}`,
  TicketLanded: (d) => `merged as ${sha(d, 'mergeCommit')}`,
  DispatchRefused: (d) => `${need(d, 'runtime')} cannot run ${need(d, 'requiredTier')} — missing ${list(d['missing'])}`,

  // ------------------------------------------------------------------ run --
  // The runtime, the model (which a runtime may not name: `""`) and the base. The
  // prompt version, the recipe hash and the worktree are in the fields.
  RunStarted: (d, r) =>
    `${attemptAgent(r, r.streamId)} started on ${need(d, 'runtime')}${d['model'] ? ` (${String(d['model'])})` : ''} from base ${sha(d, 'baseSha')}`,
  // Its size; the version string is not a caption.
  RunPrompted: (d, r) => `${attemptAgent(r, r.streamId)} was prompted (${need(d, 'bytes')} bytes)`,
  RunTouchedFile: (d, r) => {
    const verb = { edit: 'edited', write: 'wrote', delete: 'deleted' }[need(d, 'op')] ?? need(d, 'op')
    return `${attemptAgent(r, r.streamId)} ${verb} ${repoPath(need(d, 'path'))}`
  },
  RunContextExhausted: (d) => `compacted at turn ${need(d, 'turn')}`,
  RunAwaitingInput: (d) => clip(need(d, 'prompt')),
  RunProducedDiff: (d) => `${need(d, 'files')} files +${need(d, 'insertions')} −${need(d, 'deletions')}`,
  /**
   * What the claim left on origin, and the account when it left nothing (`#251`).
   *
   * The two silent outcomes get a sentence here for the same reason they get an
   * event: *no ref* and *no account of why there is no ref* are what cost `#250`
   * a whole run, and a row that read `—` would put the silence back on the page.
   *
   * **A refusal says the head, because that is what says whether anything was
   * lost.** A push rejected with commits behind it is a run somebody can still
   * rescue — `#250`'s was, from unreachable objects — and a `rev-parse` that
   * errored has nothing behind it at all. Those are the two halves of `refused`,
   * `headSha` is the only thing on the payload that tells them apart, and a
   * reader who has to open the disclosure to find that out is being asked to do
   * the triage the row exists to do.
   *
   * **`arm-only` says both halves in one sentence**, because the two facts are
   * opposite and a reader needs each: `agent/<n>` was rejected and holds
   * somebody else's commits, and this claim's own arm is on origin at a head
   * the next attempt is being sent to. Rendering it as a refusal would put the
   * work back out of sight, which is the whole of `#251`.
   *
   * **`unrecorded` is the row that contradicts the one above it** (`#252`): the
   * refs went and the store refused the `RunProducedDiff` twice, so the next
   * attempt's brief will say *Nothing* over commits that are on origin. It reads
   * as the rescue it is asking for — the head to fetch, and whose words the
   * refusal was — because a reader who sees `published` and stops has been told
   * the opposite of what happened.
   */
  RunRefsPublished: (d) => {
    const outcome = need(d, 'outcome')
    if (outcome === 'nothing-committed')
      return d['detail']
        ? `nothing committed, so no ref was left — ${clip(d['detail'])}`
        : 'nothing committed, so no ref was left'
    if (outcome === 'unrecorded')
      return `${sha(d, 'headSha')} is on origin and nothing records it: ${clip(d['detail'])}`
    if (outcome === 'arm-only')
      return `${need(d, 'branch')} was not pushed: ${clip(d['detail'])} — ${need(d, 'arm')} at ${sha(d, 'headSha')} is there`
    if (outcome === 'refused')
      return d['headSha']
        ? `${need(d, 'branch')} at ${sha(d, 'headSha')} was not pushed: ${clip(d['detail'])}`
        : `${need(d, 'branch')} was not pushed, and no head was read: ${clip(d['detail'])}`
    const prefix = outcome === 'already-published' ? 'already there — ' : ''
    // **#468**: `branchCarries === false` is what says `headSha` is the
    // arm's own and `branch` never got it — a typed field, not whether
    // `detail` happens to be set, because a failed WIP keep also writes
    // `detail` here while `branch` was pushed at exactly this sha.
    const suffix = d['detail'] ? ` — ${clip(d['detail'])}` : ''
    if (d['branchCarries'] === false) return `${prefix}${need(d, 'arm')} at ${sha(d, 'headSha')}${suffix}`
    // **`armSha` is the arm's own head only where it is not `headSha`**
    // (`#468`) — a kept WIP commit one ahead of what `branch` carries, which
    // the row below must not read as a sha the two refs share.
    if (typeof d['armSha'] === 'string' && d['armSha'] !== d['headSha']) {
      return `${prefix}${need(d, 'branch')} at ${sha(d, 'headSha')} and ${need(d, 'arm')} at ${sha(d, 'armSha')}${suffix}`
    }
    return `${prefix}${need(d, 'branch')} and ${need(d, 'arm')} at ${sha(d, 'headSha')}${suffix}`
  },
  /**
   * **A stopped run's dirty tree, kept rather than lost with the worktree**
   * (`#468`). `arm` is the only ref it is ever on — never `branch`, and never
   * `main`.
   */
  RunKeptUncommitted: (d) =>
    `kept ${need(d, 'files')} file(s) +${need(d, 'insertions')} −${need(d, 'deletions')} as ${sha(d, 'sha')} ` +
    `on ${need(d, 'arm')} — stopped by ${need(d, 'stoppedBy')}`,
  RunProposedCompletion: (d) => `head ${sha(d, 'headSha')}`,
  RunFinished: (d) => `${need(d, 'turns')} turns, $${Number(d['costUsd'] ?? 0).toFixed(2)}`,

  // ----------------------------------------------------------------- gate --
  /**
   * The plan, in full. It is the evidence behind every `skipped` on this page,
   * and it rendered as nothing — so a point that was configured and did not
   * run had no record on the page that says it should have.
   */
  StepsResolved: (d) => {
    const steps = d['steps']
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('no steps')
    return (steps as { step: string; actions: string[] }[])
      .map((p) => `${p.step} ${p.actions?.length > 0 ? p.actions.join('+') : '—'}`)
      .join(' · ')
  },
  // On `rcp-<hash>`, not on a run's own stream, so no run page shows it; the sentence
  // is for the catalogue's promise that every type has one.
  RecipeRecorded: (d) => `Recipe ${need(d, 'configHash').slice(0, 12)} written down once`,
  EndActionsResolved: (d) => {
    const outcome = need(d, 'outcome')
    const actions = d['actions']
    if (!Array.isArray(actions) || actions.length === 0) return `${outcome}: nothing to do`
    // Three shapes, and the fall-through is the labels one: a `refs:` action
    // drawn by it would read `name → ` with nothing after the arrow, which is
    // the row saying an effect ran and not saying which (`#240`).
    const said = (actions as { name: string; close?: true; labels?: string[]; refs?: true; branch?: boolean }[]).map(
      (a) =>
        a.close
          ? `${a.name} (close)`
          : a.refs
            ? `${a.name} (delete ${a.branch ? 'the branch and its arms' : 'the arms'})`
            : `${a.name} → ${list(a.labels)}`,
    )
    return `${outcome}: ${said.join(' · ')}`
  },
  StepStarted: stepStarted,
  // Reached only when `boardFactOf` gave nothing: a step whose actions are
  // none, or none reached. Said, because it was the commonest row to fall back.
  StepEnded: (d) => {
    const step = (d['outcome'] as { step?: string } | undefined)?.step
    if (step === undefined) throw new Error('no step')
    return `${step} ended with no action to run`
  },
  RunSpent: (d, r) => {
    const turns = Number(d['turns'] ?? 0)
    const bill: Bill =
      typeof d['costUsd'] === 'number'
        ? { reportedCents: Math.round(d['costUsd'] * 100), reportedRuns: 1, estimates: [], unknown: 0 }
        : unknownBill(1)
    return (
      `${upper(spentBy(d, r))}: ${turns} turn${turns === 1 ? '' : 's'}, ${seconds(Number(d['durationMs'] ?? 0))}` +
      ` · cost ${billText(bill)}`
    )
  },

  // ---------------------------------------------------------- integration --
  IntegrationAttempted: (d) => `${need(d, 'branch')} at ${sha(d, 'headSha')}`,
  IntegrationRefused: (d) => `${need(d, 'reason')}: ${clip(d['detail'])}`,
  IntegrationSucceeded: (d) => `${need(d, 'branch')} → ${need(d, 'base')} as ${sha(d, 'mergeCommit')}`,

  // -------------------------------------------------------------- findings --
  FindingProposed: (d, r) =>
    `Finding ${need(d, 'key')} proposed by ${byName(r, need(d, 'by'))} as #${need(d, 'externalRef')}`,
  FindingAccepted: (d, r) =>
    `Finding ${need(d, 'key')} accepted by ${byName(r, need(d, 'by'))} as a ${need(d, 'kind')}`,
  FindingDeclined: (d, r) => `Finding ${need(d, 'key')} declined by ${byName(r, need(d, 'by'))}: ${clip(d['reason'])}`,
  MergeLaneWaited: (d) => {
    const behind = d['behind'] as { issue?: string } | undefined
    if (!behind?.issue) throw new Error('no behind')
    return `Merge waited behind ${behind.issue}`
  },
  BaseChecked: (d) =>
    `Base ${need(d, 'base')} at ${sha(d, 'baseSha')} ${d['ok'] === true ? 'passed' : 'failed'} ${need(d, 'command')}`,
  ContinueRequested: (d, r) =>
    `${personName(need(d, 'by'))} asked to continue ${attemptName(r, need(d, 'runId'))} of #${need(d, 'issue')}`,
  ProjectOnboardingStarted: (d) =>
    `${personName(need(d, 'by'))} started onboarding ${need(d, 'slug')} on ${need(d, 'base')}`,
  ProjectRefused: (d) => `${need(d, 'project')} was refused: ${clip(d['detail'])}`,
  ProjectRecovered: (d) => `${need(d, 'project')} recovered`,
  GitHubAppCreated: (d) => `GitHub App ${need(d, 'slug')} created`,
  PluginFailed: (d) => `Plugin ${need(d, 'name')} failed on ${need(d, 'eventType')}: ${clip(d['reason'])}`,

  // ---------------------------------------------------------------- route --
  /**
   * **Where the router sent a pass, when it bought nothing** (`#271`, `#502`).
   *
   * `PassRouted` stores `{offer, reply, decision}` since the switch, not the
   * five derived fields this row used to print — `boardFactOf` reads the
   * common case off the same triple (`RoundOpened` for a bought round,
   * `Restarted` for a fresh pass), so this entry is only ever reached for the
   * remaining case, a route that landed on a person (`routeNext`'s
   * `WaitOnPerson`): `candidate.next._tag === 'HandToPerson'`, an escalated
   * decision, or a reply a judge never gave one for. The `WaitStarted` row
   * right after this one carries the same `WaitReason` in full; this one
   * only has to say which step asked and why, through `waitWords` —
   * never `routedVisit`'s own `chose`/`ceiling` split, which is
   * `packages/conductor`'s own reading of the offer and not this package's
   * to duplicate.
   */
  PassRouted: routedLine,
  ProposalRouted: routedLine,

  // -------------------------------------------------------------- control --
  // The commit is the row, not a detail under it. A start is the only moment a
  // process's code is chosen, and "who restarted it at 23:06" was unanswerable
  // until this event existed (0042).
  ConductorStarted: (d) =>
    // A null sha is a copy with no checkout, which the schema allows — said, not
    // a reason to fall back to the raw payload.
    `${need(d, 'by')} started ${d['sha'] == null ? 'an unrecorded commit' : sha(d, 'sha')}` +
    `${d['dirty'] === true ? ' (worktree dirty)' : ''}` +
    (d['reason'] ? `: ${clip(d['reason'])}` : ''),
  ConductorPaused: (d) => `${need(d, 'by')}: ${clip(d['reason'])}`,
  ConductorResumed: (d) => need(d, 'by'),
  // The timeout is on the row because it is the whole difference between a
  // drain that waits for the pass and one that walks away from it (0030 §6).
  ConductorShutdownRequested: (d) =>
    `${need(d, 'by')}: ${clip(d['reason'])}` +
    (typeof d['timeoutMs'] === 'number' ? ` (timeout ${Math.round(d['timeoutMs'] / 1000)}s)` : ''),
  // Which request, because a withdrawal lifts that one and no other (0042).
  ConductorShutdownWithdrawn: (d) => `${need(d, 'by')} withdrew request v${need(d, 'version')}: ${clip(d['reason'])}`,
  // Retired, and still read for ever (0019). A row that renders nothing is
  // exactly as unreadable whether or not anything appends the type again.
  OutboxDelivered: (d) => `${need(d, 'kind')} → ${need(d, 'target')}${d['detail'] ? `: ${clip(d['detail'])}` : ''}`,
  OutboxFailed: (d) =>
    `${need(d, 'kind')} → ${need(d, 'target')}: ${clip(d['error'])}${d['permanent'] === true ? ' (permanent)' : ''}`,
  IssueUpdated: (d) => `${need(d, 'change')}: ${clip(d['detail'])}`,
  IssueUpdateFailed: (d) => `${need(d, 'change')} refused: ${clip(d['error'])}`,
  QueueChanged: (d) => `${need(d, 'project')}: ${need(d, 'reason')}`,
  RunRequested: (d) => `${need(d, 'project')}#${need(d, 'issue')} by ${need(d, 'by')}`,

  // ---------------------------------------------------------- discussion --
  DiscussionRequested: (d) => `${personName(need(d, 'by'))} asked: ${clip(need(d, 'question'))}`,
  DiscussionAsked: (d) => `${personName(need(d, 'by'))}: ${clip(need(d, 'question'))}`,
  /**
   * The money and what could not be established, in that order.
   *
   * `cannot` is on the row rather than only in the payload because it is the
   * one thing a person skimming this must not miss: `#89` cost two attempts
   * because a guess was read as a finding, and a summary that printed only the
   * answer would put this assistant one skim away from the same failure.
   */
  DiscussionAnswered: (d) => {
    const cost = typeof d['costUsd'] === 'number' ? ` · $${d['costUsd'].toFixed(2)}` : ''
    const failure = typeof d['failure'] === 'string' ? d['failure'] : null
    if (failure !== null) return `did not answer: ${clip(failure)}${cost}`
    const cannot = Array.isArray(d['cannot']) ? d['cannot'].length : 0
    const read = Array.isArray(d['read']) ? d['read'].length : 0
    return `${clip(d['text'], 100)} — ${read} file(s)${cannot > 0 ? `, ${cannot} unanswerable` : ''}${cost}`
  },
  DiscussionHeld: (d) => {
    const cost = typeof d['costUsd'] === 'number' ? ` · $${d['costUsd'].toFixed(2)}` : ''
    const outcome = { prompt: 'a prompt edit', ticket: 'a ticket edit', none: 'no change' }[need(d, 'outcome')]
    return `Discussion ended with ${outcome ?? need(d, 'outcome')}${cost}`
  },
  // Blank is the removal, and the row says so — an edit taken back off the next
  // attempt is a decision somebody made, not the absence of one (#104).
  PromptEdited: (d) => {
    const text = String(d['text'] ?? '')
    const by = personName(need(d, 'by'))
    return text.trim() === ''
      ? `${by} removed the edit from the next attempt's prompt`
      : `${by} added ${text.length} bytes to the next attempt's prompt`
  },

  // -------------------------------------------------------------- project --
  ProjectConfigured: (d) =>
    `${need(d, 'project')} recipe ${sha(d, 'configHash', 12)} from ${d['base'] ?? '(no base recorded)'}`,
  Reconciled: (d, r) => {
    const findings = d['findings']
    if (!Array.isArray(findings) || findings.length === 0) return 'Reconciled: nothing found'
    const said = (findings as { stream: string; action: string }[])
      .slice(0, 3)
      .map((f) => `${r.attempts.has(f.stream) ? attemptName(r, f.stream) : f.stream} ${f.action}`)
      .join(', ')
    return findings.length > 3
      ? `Reconciled ${findings.length} findings: ${said}, …`
      : `Reconciled ${findings.length} finding${findings.length === 1 ? '' : 's'}: ${said}`
  },

  // ---------------------------------------------------------------- triage --
  // **`attempt` here counts triage's tries, not the ticket's attempts**, so it is
  // never `Attempt N`. The model may be `""` (a runtime that names none), and
  // that is a sentence without a model rather than a throw.
  TriageStarted: (d) => {
    const by = d['by']
    if (by === null || typeof by !== 'object') throw new Error('no by')
    const tagged = by as { _tag?: string; runtime?: string; model?: string }
    return `${triageName(tagged, need(d, 'attempt'))} started${tagged._tag === 'Agent' ? agentOf(tagged) : ''}`
  },
}

type FactFormatter<Tag extends BoardFact['_tag']> = (fact: Extract<BoardFact, { _tag: Tag }>, event: Payload) => string

/**
 * The sentence for a `boardFactOf` fact — `summarise`'s first table, tried
 * before `FORMAT` above. One entry per `BoardFact` tag, so this is as total
 * as the fact type itself; `summarise` still wraps a call in the same
 * try/catch `FORMAT` gets, so a fact a formatter cannot fill (`WaitStarted`
 * with no `question` at all) falls to the fallback sentence.
 */
const FACT_FORMAT: { [K in BoardFact['_tag']]: FactFormatter<K> } = {
  StepEnded: (f) => {
    const head = stepAt({ step: f.step, action: f.action })
    switch (f.ending) {
      case 'Passed':
        return head
      /**
       * **And *the answer could not be read* rather than the silence a zero
       * is** (`#279`).
       *
       * `0 findings` renders as the bare step, which is the same row a
       * reviewer that read the diff and had nothing to refuse it on writes.
       * `#269`'s third review said four things and ended one closing brace
       * short of valid JSON, and this row was the only place on the page it
       * appeared at all — as nothing.
       *
       * The count is not printed beside it, because there is none to print:
       * an answer that did not parse carries no findings by construction,
       * and a `0` next to the sentence would invite the reading that the
       * reviewer found nothing.
       */
      case 'Failed': {
        if (f.unreadable === true) return `${head} — the answer could not be read`
        const n = f.findings?.length ?? 0
        return n > 0 ? `${head} — ${n} finding${n === 1 ? '' : 's'}` : head
      }
      case 'NeverRan':
        return `${head} — never ran: ${clip(f.detail ?? '')}`
      // One line, because the action ran once: 0057 §4's retry is deleted
      // (`#234`), and with it the *attempt 2, no more attempts* this line
      // used to print about a second attempt that never left the starting
      // block.
      case 'DidNotFinish':
        return `${head} — did not finish: ${clip(f.detail ?? '')}`
      // Its own line since `#296`, and the verb is the whole of it: this row
      // read *did not finish* over a question for as long as the two shared
      // an event.
      case 'Asked':
        return `${head} — asked: ${clip(f.detail ?? '')}`
      // Not run: a person approved past it in that wait (0120 §6). One more
      // `StepEnded` outcome since #502, not a fact of its own.
      case 'Waived':
        return `${head} — waived`
    }
  },

  SignoffRequested: (f) =>
    `${stepAt({ step: f.step, action: f.action })} — ${clip(need({ question: f.question }, 'question'))}`,

  // The other purse (0038 §4). A round says how many findings it was bought
  // for, because that is the size of what the fixer was asked to do; the
  // scenarios themselves are in the disclosure, verbatim, where the contract
  // lives.
  //
  // **No denominator since #502.** `RouteOffer` never stored the recipe's
  // own `policy.rounds`, only what it decided from it, so there is nothing
  // here for "round 1 of N" to read — the ceiling is `routing.ts`'s own
  // argument, not a field on the event.
  //
  // **No action either, since #505.** `boardFactOf` always sets `action: ''`
  // — `PassRouted` never carried the name a round was bought for, only the
  // offer and reply a round was routed from, so there is nothing here `need`
  // could fall back over: the field is never present, not merely sometimes
  // empty. The next row is already `StepStarted … step=implement round=1`,
  // so the destination a `for ${action}` clause used to name is still on the
  // page.
  RoundOpened: (f) => {
    if (f.findingsUnknown === true) return `round ${f.round} — findings not found`
    const n = f.findings.length
    return `round ${f.round} — ${n} finding${n === 1 ? '' : 's'}`
  },

  // **Just the ordinal since #502.** `PassRouted{decision: Selected{restart}}`
  // carries the offer and the reply it chose from, not the abandoned branch,
  // its head or the findings still live — those are on the *previous* run's
  // own stream, which `attempts.ts`'s `lastRun` already reads (`TicketReleased`
  // is what used to repeat them here, and `#502`'s header says there is
  // nothing left for the release to repeat).
  Restarted: (f) => `restart ${f.restart}`,

  /**
   * Which kind of hold, then the question, then the move that was
   * recommended.
   *
   * The kind leads because it is what the log could not say (#83): *held at
   * the merge gate* and *conflict: agent/112 does not merge into develop*
   * were both the same shape of wait, and they are opposite kinds of thing.
   *
   * `boardFactOf` already tried to parse the wait and read it through
   * `waitWords` (or, where that did not parse, read the v1/v2 fields
   * instead) — `question` is `undefined` only where neither had anything,
   * which this throws on, the same way `need` does, so `summarise` falls to
   * the fallback sentence.
   */
  WaitStarted: (f) => {
    if (f.question === undefined) throw new Error('no question')
    // The question already says what it asks for; the old `judgement:` /
    // `acknowledgement:` prefix was the log's word for it, and the open row has it.
    const said = [clip(f.question)]
    if (f.recommendation?.action) said.push(`— recommends ${f.recommendation.action}`)
    return said.join(' ')
  },
  WaitResolved: (f) => {
    const note = clip(f.note)
    return note ? `${f.by}: ${note}` : f.by
  },
  // **`attempt` is triage's try, not the ticket's** — see `FORMAT.TriageStarted`.
  // The move is named by the board's own title for it, never by its tag.
  WaitTriaged: (f, event) => {
    const by = event['by']
    const name = triageName(by !== null && typeof by === 'object' ? (by as { _tag?: string }) : {}, f.attempt)
    const result = f.result
    if (result._tag === 'TriageFailed') return `${name} failed: ${clip(result.why)}`
    return `${name} advised: ${RESOLUTION_COPY[result.resolution].title} — ${presentCause(result.cause).label}: ${clip(result.summary)}`
  },

  RunEnded: (f) => `${f.kind}: ${clip(f.detail)}`,
}

/**
 * The row for a route that landed on a person, read the same whether the route
 * kept the copy (`PassRouted`) or names its `StepEnded` (`ProposalRouted`,
 * #932). A route whose `StepEnded` is not in the slice says so rather than
 * showing an empty list.
 */
function routedLine(d: Payload, { branch, endedAt }: Reading): string {
  const data = d as unknown as PayloadOf<'PassRouted'> | PayloadOf<'ProposalRouted'>
  const from = fromOf(data.offer.proposal)
  const move = routeMove(data.offer, data.reply, data.decision)
  if (move._tag !== 'WaitOnPerson') {
    // `boardFactOf` already answers `RoundOpened`/`Restarted` for these —
    // reaching here with one is that mapping disagreeing with this one.
    throw new Error(`a route formatted as a wait, but routeMove answered ${move._tag}`)
  }
  const resolved = resolveOffer(data.offer, endedAt ?? (() => undefined))
  if (resolved._tag === 'Unresolved') {
    return `${from} → waiting — the evidence was not found: ${resolved.why}`
  }
  const next = routeNext(resolved.offer, data.reply, data.decision, { runId: data.runId })
  if (next._tag !== 'WaitOnPerson') {
    throw new Error(`a route formatted as a wait, but routeNext answered ${next._tag}`)
  }
  // The run's own stream carries no ticket id — `branch` is `groupHistory`'s
  // reading of that run's `RunStarted`. Most `WaitReason`s never open on it
  // (an agent's own question names no subject), so a missing branch is only a
  // problem once `waitWords` reaches for one: `"${subjectOf} is waiting on
  // you. …"` reads as the empty string when `branch` is `''`. Falling back to
  // the payload there, rather than rendering a sentence open on nothing, is rule 2.
  const question = waitWords(next.reason, { branch: branch ?? '', base: '', findings: [] }).line
  if (branch === undefined && question.trimStart().startsWith('is waiting on you')) {
    throw new Error('a route opens on a subject, but no branch was given')
  }
  return `${from} → waiting — ${clip(question)}`
}

/**
 * What a row says, and the ids it could not name as an attempt of this ticket.
 * Never the empty string, and never the payload — see rule 2 above.
 *
 * A formatter that cannot fill its sentence yields to `recorded <Type>; open
 * for its fields`: `need` throws on a field that is not there, and an event of
 * a shape this file does not recognise is the one an operator most needs to
 * open. It is also why this is a reader that cannot break the page — a throw
 * here costs a sentence, not a render.
 *
 * `boardFactOf` is tried first: a type it owns answers through `FACT_FORMAT`,
 * and a type it gives no fact for falls to `FORMAT`.
 */
function read(event: Envelope, ctx: LineContext): { said: string; unknown: string[] } {
  const data = (event.data ?? {}) as Payload
  const r: Reading = { ...ctx, streamId: event.streamId, unknown: new Set() }
  const done = (said: string) => ({ said, unknown: [...r.unknown] })
  try {
    const facts = boardFactOf(event, ctx.endedAt ?? (() => undefined))
    // One event may answer several facts since #502 — a `StepEnded` names
    // one per action the step declared, and a `PassRouted` may open a round
    // and record a restart at once. One row still renders one sentence, so
    // this joins them in the order `boardFactOf` gave them.
    if (facts.length > 0) {
      const said = facts
        .map((fact) => (FACT_FORMAT[fact._tag] as (f: typeof fact, d: Payload) => string)(fact, data).trim())
        .filter((s) => s !== '')
        .join('; ')
      return done(said || recorded(event.type))
    }
  } catch {
    // A malformed payload for a type `boardFactOf` owns.
    return done(recorded(event.type))
  }
  const format = FORMAT[event.type as EventType]
  if (format) {
    try {
      const said = format(data, r).trim()
      if (said) return done(said)
    } catch {
      // Fall through to the fallback sentence.
    }
  }
  return done(recorded(event.type))
}

export function summarise(event: Envelope, ctx: LineContext): string {
  return read(event, ctx).said
}

/**
 * The actor in words. Triage, the judge and a discussion all run as
 * `conductor`, so they are named from the event, not the actor.
 */
function whoOf(event: Envelope, ctx: LineContext): string {
  const { actor } = event
  if (actor.startsWith('human:')) return personName(actor)
  if (actor.startsWith('agent:')) {
    const n = ctx.attempts.get(actor.slice('agent:'.length))
    return n === undefined ? `an agent of ${OTHER_TICKET}` : `Attempt ${n}'s agent`
  }
  if (actor !== 'conductor') return actor
  if (event.type === 'TriageStarted' || event.type === 'WaitTriaged') return 'triage'
  if (event.type.startsWith('Discussion')) return 'a discussion'
  if (event.type === 'RunSpent') {
    switch ((event.data as { for?: { _tag?: string } } | null)?.for?._tag) {
      case 'Judge':
        return 'the judge'
      case 'Triage':
        return 'triage'
      case 'Discussion':
        return 'a discussion'
    }
  }
  return actor
}

/** The payload as stored, for the disclosure under every row. */
export function rawPayload(data: unknown): string {
  try {
    return JSON.stringify(data ?? null, null, 2)
  } catch {
    // Cyclic or otherwise unserialisable — impossible for something read back
    // out of JSONB, and still not a reason for the page to fail.
    return String(data)
  }
}

/** What stands in the JSON where a document was lifted out of it. */
function mark(bytes: number): string {
  return `‹document, ${bytes} bytes — below›`
}

/**
 * The payload, split into its structure and the documents inside it.
 *
 * Pretty-printing indents the *structure*; it cannot help a value that is
 * itself a document, because the escaping is what makes the value valid JSON
 * and is exactly what makes it unreadable. `seq 1800` is 6,268 bytes of
 * markdown on one line, every newline a literal `\n` — the most valuable event
 * on the stream rendered as the least readable thing on the page (#101).
 *
 * **The rule is a newline in a string, not a list of field names.** A payload
 * that carries a document is not a property of `RunPrompted`: a failed run's
 * own detail is a gate's stdout, a bought repair's detail is a whole
 * typecheck run, and a wait's own question has a build log inside it. An
 * allowlist would fail the same way for the next type that starts carrying
 * one — which is rule 2 at the top of this file, one level down.
 *
 * Nested and inside arrays too, labelled by path (`diagnosis.raw`), because
 * whether a document sits at the top of the payload or one key in is an
 * accident of the schema and not of what it is.
 *
 * **Nothing is dropped.** Every key stays, with a mark in place of the value
 * saying how big it was and that it is below — so the structure is still whole
 * and the document is still there, byte for byte, in the one form you can copy
 * into `claude -p`. What is not reproduced is the JSON escaping, which is how
 * the value travels and not what is stored.
 *
 * The event's `type` is taken so each document can be stamped with its source
 * — the same argument one step on: whether a document may be *rendered* is a
 * fact about who wrote it, and the payload is where that is still known. Omit
 * it and every document is `log`, which is the reading that is never wrong
 * (`markdown.ts`).
 */
export function splitPayload(data: unknown, type?: string): { raw: string; documents: PayloadDocument[] } {
  const documents: PayloadDocument[] = []

  function lift(value: unknown, path: string): unknown {
    if (typeof value === 'string' && value.includes('\n')) {
      const bytes = new TextEncoder().encode(value).length
      const field = path || '(the payload)'
      // A payload that is itself a document has no key to be named by.
      documents.push({ field, text: value, bytes, source: sourceOfPayloadDocument(type, field) })
      return mark(bytes)
    }
    if (Array.isArray(value)) return value.map((v, i) => lift(v, `${path}[${i}]`))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Payload).map(([k, v]) => [k, lift(v, path ? `${path}.${k}` : k)]),
      )
    }
    return value
  }

  return { raw: rawPayload(lift(data ?? null, '')), documents }
}

/** One event, as a row. */
export function toLine(event: Envelope, ctx: LineContext): HistoryLine {
  const { raw, documents } = splitPayload(event.data, event.type)
  const { said, unknown } = read(event, ctx)
  return {
    at: event.at.toISOString(),
    type: event.type,
    actor: event.actor,
    who: whoOf(event, ctx),
    summary: said,
    summaryTitle: unknown.join(' '),
    seq: String(event.seq),
    streamId: event.streamId,
    version: event.version,
    schemaVer: event.schemaVer,
    raw,
    documents,
  }
}
