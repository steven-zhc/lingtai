/**
 * Fixed event histories every reducer of the one-reduce epic (#797) is run over
 * (#798, plan `doc/design/one-reduce-per-stream.md` §3 T0a, §4, §5).
 *
 * **Append only.** `seq` is assigned here, from this module's own counter, in the
 * order the histories are built below, and `histories.hashes.json` hashes it. A
 * history added *after* the existing ones changes nothing; one inserted *before*
 * them shifts every later `seq` and fails the lock. A history is never edited: a
 * later reduce change that needs a new cell adds a new named history.
 *
 * **Nothing here reads a clock or a counter that is not this module's.**
 * `makeStream`'s `seq` is module-global (`support.ts`) and its `at` is one default
 * instant, so every history is re-stamped by `stamp` below — a fixture imported
 * after another module that also calls `makeStream` would otherwise move. Do not
 * call `aWaitId()` (a global counter, and part of a payload) or `new Date()`:
 * wait ids are literals, and every time-shaped payload value is a literal offset
 * from `NOW`.
 *
 * **`NOW` is what every reduce that reads the clock is reduced against**
 * (`reduceControl(events, NOW)`), later than every `at` in this module.
 */
import type { Action, Envelope, EventType, StepOutcome, WaitId } from '../src/index.ts'
import {
  backlogStream,
  CONTROL_FOLD_TYPES,
  CONTROL_STREAM,
  chatStream,
  integrationStream,
  attemptStream,
  STEPS,
  ticketStream,
} from '../src/index.ts'
import {
  aClaim,
  aLanding,
  aRoute,
  aRelease,
  aResolution,
  anAttempt,
  aRunFailure,
  aSplit,
  aWait,
  type AttemptFixture,
} from './events.ts'
import { makeStream } from './support.ts'

/** The instant clock-reading reduces are reduced at. After every `at` below. */
export const NOW = new Date('2026-09-01T00:00:00.000Z')

const PROJECT = 'lingtai'
const BASE = 'main'

const START_MS = Date.parse('2026-08-01T00:00:00.000Z')
const SLOT_MS = 6 * 60 * 60 * 1000
const STEP_MS = 60 * 1000

let nextSeq = 1_000n
let slot = 0

/** Gives a history (or a whole scenario) this module's `seq` and a fixed, strictly increasing `at`. */
function stamp(events: readonly Envelope[]): readonly Envelope[] {
  const start = START_MS + slot++ * SLOT_MS
  return events.map((e, i) => ({ ...e, seq: nextSeq++, at: new Date(start + i * STEP_MS) }))
}

const wait = (name: string) => `wait-${name}` as WaitId

function act(
  yields: Action['yields'],
  name: string,
  onSha: string,
  result: Record<string, unknown>,
  plugin = 'run',
  evidence = '',
): Action {
  return { plugin, name, onSha, evidence, yields, result } as Action
}

const outcome = (step: StepOutcome['step'], round: number, actions: Action[]): StepOutcome => ({ step, round, actions })
const accepted = { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } }
const refused = {
  _tag: 'Completed',
  assessment: {
    verdict: 'refused',
    findings: [
      { file: 'src/a.ts', line: 3, claim: 'off by one', failureScenario: 'n=0 reads past the end', severity: 'major' },
    ],
  },
}

function runStarted(run: AttemptFixture, ticket: string): Envelope {
  return run.event('RunStarted', {
    ticketId: ticket,
    runtime: 'claude-code',
    model: 'claude-opus-5',
    promptVersion: 'ticket@3',
    baseSha: 'base000',
    configHash: 'cfg123',
    worktree: '/tmp/wt/798',
    invocation: null,
  })
}

// ---------------------------------------------------------------- run ----

const runTicket = ticketStream(PROJECT, 9001)

function landedFirstTry(): readonly Envelope[] {
  const run = anAttempt(attemptStream('landed-first-try'))
  return stamp([
    runStarted(run, runTicket),
    run.event('RunPrompted', { promptVersion: 'ticket@3', bytes: 12, prompt: 'do the thing' }),
    run.event('RunTouchedFile', { path: 'src/a.ts', op: 'edit' }),
    run.event('RunContextExhausted', { turn: 40 }),
    run.event('RunProducedDiff', { branch: 'agent/9001', headSha: 'sha-1', files: 1, insertions: 4, deletions: 1 }),
    ...run.aStepEnded(outcome('build', 0, [act('verdict', 'test', 'sha-1', accepted)])),
    ...run.aStepEnded(outcome('review', 0, [act('verdict', 'cold', 'sha-1', accepted, 'agent')])),
    run.event('RunProposedCompletion', { headSha: 'sha-1' }),
    ...run.aStepEnded(
      outcome('merge', 0, [
        act('merge', 'land', 'sha-1', { _tag: 'Completed', integration: { _tag: 'Integrated', mergeSha: 'merge-1' } }),
      ]),
    ),
    run.event('RunFinished', { exitCode: 0, turns: 40, durationMs: 120_000 }),
  ])
}

function fixRoundThenLanded(): readonly Envelope[] {
  const run = anAttempt(attemptStream('fix-round'))
  return stamp([
    runStarted(run, runTicket),
    run.event('RunProducedDiff', { branch: 'agent/9001', headSha: 'sha-1', files: 1, insertions: 4, deletions: 1 }),
    ...run.aStepEnded(outcome('review', 0, [act('verdict', 'cold', 'sha-1', refused, 'agent')])),
    ...run.aStepEnded(
      outcome('implement', 1, [
        act('commit', 'fix', 'sha-1', { _tag: 'Completed', head: 'sha-2', question: null }, 'agent'),
      ]),
    ),
    run.event('RunProducedDiff', { branch: 'agent/9001', headSha: 'sha-2', files: 1, insertions: 5, deletions: 1 }),
    ...run.aStepEnded(outcome('review', 1, [act('verdict', 'cold', 'sha-2', accepted, 'agent')])),
    run.event('RunFinished', { exitCode: 0, turns: 70, durationMs: 300_000 }),
  ])
}

function askedThenResumed(): readonly Envelope[] {
  const run = anAttempt(attemptStream('asked'))
  return stamp([
    runStarted(run, runTicket),
    run.event('RunAwaitingInput', { prompt: 'which of the two?' }),
    run.event('RunProducedDiff', { branch: 'agent/9001', headSha: 'sha-1', files: 2, insertions: 9, deletions: 0 }),
    run.event('RunFailed', { kind: 'timeout', detail: 'wall limit' }),
  ])
}

/** D1: a `commit` action `Completed` with `question: null` and `head: null` — nothing committed, and it still clears. */
function commitCompletedNoHead(): readonly Envelope[] {
  const run = anAttempt(attemptStream('commit-no-head'))
  return stamp([
    runStarted(run, runTicket),
    ...run.aStepEnded(
      outcome('implement', 0, [
        act('commit', 'keep', 'sha-1', { _tag: 'Completed', head: null, question: null }, 'agent'),
      ]),
    ),
  ])
}

/** D1: a `worktree` action `NotDone`. */
function worktreeNotDone(): readonly Envelope[] {
  const run = anAttempt(attemptStream('worktree-not-done'))
  return stamp([
    runStarted(run, runTicket),
    ...run.aStepEnded(outcome('prepared', 0, [act('worktree', 'cut', 'base000', { _tag: 'NotDone' }, 'file')])),
  ])
}

/** D1: a `design` action `AnswerUnreadable`. */
function designAnswerUnreadable(): readonly Envelope[] {
  const run = anAttempt(attemptStream('design-unreadable'))
  return stamp([
    runStarted(run, runTicket),
    ...run.aStepEnded(
      outcome('design', 0, [
        act('design', 'draft', 'base000', { _tag: 'AnswerUnreadable', raw: '<<not json>>' }, 'agent'),
      ]),
    ),
  ])
}

/** D1: a step whose later action is `NotReached` because an earlier one refused. */
function laterActionNotReached(): readonly Envelope[] {
  const run = anAttempt(attemptStream('later-not-reached'))
  return stamp([
    runStarted(run, runTicket),
    ...run.aStepEnded(
      outcome('build', 0, [
        act('verdict', 'test', 'sha-1', refused),
        act('verdict', 'lint', 'sha-1', { _tag: 'NotReached' }),
      ]),
    ),
  ])
}

/** D3: a signoff `Completed` with `requested` (awaiting approval), then a later lifecycle event of the run. */
function signoffRequestedThenLifecycle(): readonly Envelope[] {
  const run = anAttempt(attemptStream('signoff-then-lifecycle'))
  return stamp([
    runStarted(run, runTicket),
    ...run.aStepEnded(
      outcome('proposed', 0, [
        act('signoff', 'human', 'sha-1', { _tag: 'Completed', requested: { question: 'ship it?' } }, 'human'),
      ]),
    ),
    run.event('RunProposedCompletion', { headSha: 'sha-1' }),
    run.event('RunFinished', { exitCode: 0, turns: 3, durationMs: 9_000 }),
  ])
}

/** D3: a `RunFailed` followed by a `RunFinished`. */
function failedThenFinished(): readonly Envelope[] {
  const run = anAttempt(attemptStream('failed-then-finished'))
  return stamp([
    runStarted(run, runTicket),
    ...aRunFailure(run, 'crash', 'the agent exited 1'),
    run.event('RunFinished', { exitCode: 1, turns: 5, durationMs: 15_000 }),
  ])
}

/** D2: a verdict whose `onSha` is an older head than a later `RunProducedDiff`'s. */
function verdictOnOlderHead(): readonly Envelope[] {
  const run = anAttempt(attemptStream('verdict-older-head'))
  return stamp([
    runStarted(run, runTicket),
    run.event('RunProducedDiff', { branch: 'agent/9001', headSha: 'sha-old', files: 1, insertions: 1, deletions: 0 }),
    ...run.aStepEnded(outcome('review', 0, [act('verdict', 'cold', 'sha-old', accepted, 'agent')])),
    run.event('RunProducedDiff', { branch: 'agent/9001', headSha: 'sha-new', files: 1, insertions: 2, deletions: 0 }),
  ])
}

// ------------------------------------------------------------- ticket ----

function claimedReleasedClaimedLanded(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9101))
  return stamp([
    t('TicketDiscovered', {
      project: PROJECT,
      source: 'github-issue',
      externalRef: '9101',
      title: 'a ticket',
      kind: 'bug',
      labels: ['bug'],
    }),
    ...aClaim(t, attemptStream('t9101-a')),
    ...aRelease(t, attemptStream('t9101-a'), 'restart', { _tag: 'Restart', restart: 1 }),
    ...aClaim(t, attemptStream('t9101-b')),
    ...aLanding(t, 'merge-9101', BASE),
  ])
}

/** D11: a `TicketContinued` naming a run nobody claimed. */
function continuedUnclaimedRun(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9102))
  return stamp([
    ...aClaim(t, attemptStream('t9102-a')),
    t('TicketContinued', { runId: attemptStream('t9102-ghost'), worker: 'conductor:1' }),
    t('TicketContinued', { runId: attemptStream('t9102-a'), worker: 'conductor:1' }),
  ])
}

/** D6: a `TicketClaimed` after `TicketClosed` — `makeStream` checks no invariant. */
function claimedAfterClosed(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9103))
  return stamp([
    ...aClaim(t, attemptStream('t9103-a')),
    t('TicketClosed', { by: 'steven', reason: 'not wanted' }),
    ...aClaim(t, attemptStream('t9103-b')),
  ])
}

/** D5: waits resolved by `GrantFixRound` and by `Close`, before any `TicketClosed`. */
function waitsResolvedBeforeClose(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9104))
  const run = attemptStream('t9104-a')
  const check = wait('9104-check')
  const sign = wait('9104-sign')
  return stamp([
    ...aClaim(t, run),
    ...aWait(
      t,
      { _tag: 'CheckRefused', run: { runId: run }, step: 'proposed', action: 'test', evidence: 'red', findings: [] },
      check,
    ),
    ...aResolution(t, check, { _tag: 'GrantFixRound', onSha: 'sha-1', ref: 'refs/lingtai/9104' }),
    t('TicketContinued', { runId: run, worker: 'conductor:1' }),
    ...aWait(
      t,
      { _tag: 'SignoffRequired', run: { runId: run }, step: 'merge', action: 'human', question: 'land it?' },
      sign,
    ),
    ...aResolution(t, sign, { _tag: 'Close' }),
  ])
}

function approvedAfterSignoff(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9105))
  const run = attemptStream('t9105-a')
  const sign = wait('9105-sign')
  return stamp([
    ...aClaim(t, run),
    ...aWait(
      t,
      { _tag: 'SignoffRequired', run: { runId: run }, step: 'proposed', action: 'human', question: 'ship it?' },
      sign,
    ),
    ...aResolution(t, sign, { _tag: 'Approve', onSha: 'sha-1' }),
    t('TicketContinued', { runId: run, worker: 'conductor:1' }),
    ...aLanding(t, 'merge-9105', BASE),
  ])
}

function everyTicketEvent(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9106))
  const run = attemptStream('t9106-a')
  const ask = wait('9106-ask')
  const split = wait('9106-split')
  return stamp([
    t('TicketDiscovered', {
      project: PROJECT,
      source: 'manual',
      externalRef: '9106',
      title: 'every event',
      kind: 'feature',
      labels: [],
    }),
    t('PromptEdited', { text: 'mind the edge', hash: null, by: 'steven', basedOn: null, chatId: null }),
    t('DispatchRefused', { requiredTier: 'guarded', runtime: 'claude-code', missing: ['LINGTAI_TOKEN'] }),
    ...aClaim(t, run),
    ...aWait(t, { _tag: 'OwnQuestion', question: 'which one?', by: 'steven' }, ask),
    ...aResolution(t, ask, { _tag: 'AnswerQuestion', choice: 'the first' }),
    ...aSplit(t, split, [161, 162]),
    // Retired, and still a case of `reduceTicketEvent`.
    t('TicketLinked', { relation: 'follows-up', otherRef: '9001' }),
    ...aRelease(t, run, 'the pass did not finish', null),
    t('TicketClosed', { by: 'steven', reason: 'done elsewhere' }),
  ])
}

// ------------------------------------------------------------ control ----

const LIFTED_UNTIL = '2026-08-20T00:00:00.000Z' // before NOW
const HOLDING_UNTIL = '2026-09-02T00:00:00.000Z' // after NOW

const pause = (until: string | null, holdsAcrossStarts = false) => ({
  by: 'steven',
  reason: 'looking at it',
  until,
  holdsAcrossStarts,
})

function pausedUntilThenResumed(): readonly Envelope[] {
  const c = makeStream(CONTROL_STREAM)
  return stamp([c('ConductorPaused', pause(HOLDING_UNTIL)), c('ConductorResumed', { by: 'steven' })])
}

function pausedUntilLifted(): readonly Envelope[] {
  const c = makeStream(CONTROL_STREAM)
  return stamp([c('ConductorPaused', pause(LIFTED_UNTIL))])
}

function pausedUntilHolding(): readonly Envelope[] {
  const c = makeStream(CONTROL_STREAM)
  return stamp([c('ConductorPaused', pause(HOLDING_UNTIL, true))])
}

function shutdownRequestedThenWithdrawn(): readonly Envelope[] {
  const c = makeStream(CONTROL_STREAM)
  return stamp([
    c('ConductorShutdownRequested', { by: 'steven', reason: 'restart', timeoutMs: 60_000, force: false }),
    c('ConductorShutdownWithdrawn', { by: 'steven', version: 1, reason: 'changed my mind', handoff: null }),
    c('ConductorShutdownRequested', { by: 'steven', reason: 'for real', timeoutMs: null, force: true }),
  ])
}

function requestsQueued(): readonly Envelope[] {
  const c = makeStream(CONTROL_STREAM)
  return stamp([
    c('RunRequested', { project: PROJECT, issue: '9001', by: 'steven' }),
    c('ContinueRequested', { project: PROJECT, issue: '9001', runId: attemptStream('asked'), by: 'steven' }),
    c('DiscussionRequested', {
      chatId: chatStream('9001-1'),
      ticketId: runTicket,
      attempt: 1,
      question: 'why this approach?',
      by: 'steven',
    }),
  ])
}

// --------------------------------------------------------------- chat ----

const ASK = { ticketId: runTicket, attempt: 1, by: 'steven', question: 'why this approach?', reading: ['src/a.ts'] }
const ANSWER = {
  text: 'because the other leaks',
  read: ['src/a.ts'],
  cannot: [],
  proposal: null,
  turns: 4,
  durationMs: 8_000,
  failure: null,
}

function askedThenAnswered(): readonly Envelope[] {
  const c = makeStream(chatStream('9001-1'))
  return stamp([c('DiscussionAsked', ASK), c('DiscussionAnswered', ANSWER)])
}

/** D7: a `DiscussionAnswered` with no open ask. */
function orphanAnswer(): readonly Envelope[] {
  const c = makeStream(chatStream('9001-2'))
  return stamp([c('DiscussionAnswered', ANSWER)])
}

// ------------------------------------------------------------ finding ----

const finding = (key: string) => ({ project: PROJECT, key, by: 'steven' })

function acceptedThenProposed(): readonly Envelope[] {
  const f = makeStream(`fnd-${PROJECT}-minor-1`)
  return stamp([
    f('FindingAccepted', { ...finding('minor-1'), kind: 'tech-debt', labels: ['tech-debt'] }),
    f('FindingProposed', { ...finding('minor-1'), externalRef: '9200', url: null }),
  ])
}

function declined(): readonly Envelope[] {
  const f = makeStream(`fnd-${PROJECT}-minor-2`)
  return stamp([f('FindingDeclined', { ...finding('minor-2'), reason: 'not worth a ticket' })])
}

// ------------------------------------------------------------ exports ----

/** Single-stream histories, by the kind of stream they sit on. Built in this order; append only. */
export const histories = {
  attempt: {
    landedFirstTry: landedFirstTry(),
    fixRoundThenLanded: fixRoundThenLanded(),
    askedThenResumed: askedThenResumed(),
    commitCompletedNoHead: commitCompletedNoHead(),
    worktreeNotDone: worktreeNotDone(),
    designAnswerUnreadable: designAnswerUnreadable(),
    laterActionNotReached: laterActionNotReached(),
    signoffRequestedThenLifecycle: signoffRequestedThenLifecycle(),
    failedThenFinished: failedThenFinished(),
    verdictOnOlderHead: verdictOnOlderHead(),
  },
  ticket: {
    claimedReleasedClaimedLanded: claimedReleasedClaimedLanded(),
    continuedUnclaimedRun: continuedUnclaimedRun(),
    claimedAfterClosed: claimedAfterClosed(),
    waitsResolvedBeforeClose: waitsResolvedBeforeClose(),
    approvedAfterSignoff: approvedAfterSignoff(),
    everyTicketEvent: everyTicketEvent(),
  },
  control: {
    pausedUntilThenResumed: pausedUntilThenResumed(),
    pausedUntilLifted: pausedUntilLifted(),
    pausedUntilHolding: pausedUntilHolding(),
    shutdownRequestedThenWithdrawn: shutdownRequestedThenWithdrawn(),
    requestsQueued: requestsQueued(),
  },
  chat: {
    askedThenAnswered: askedThenAnswered(),
    orphanAnswer: orphanAnswer(),
  },
  finding: {
    acceptedThenProposed: acceptedThenProposed(),
    declined: declined(),
  },
} as const

/** Streams that join: a ticket, the runs it claimed and (where a landing was attempted) its integration stream. */
export interface Scenario {
  readonly ticket: readonly Envelope[]
  readonly runs: readonly (readonly Envelope[])[]
  readonly integration?: readonly Envelope[]
}

/** One bundle, written in the order things happened, stamped once and split by stream. */
function bundle(ticketId: string, events: readonly Envelope[], integrationId?: string): Scenario {
  const stamped = stamp(events)
  const ticket = stamped.filter((e) => e.streamId === ticketId)
  const integration = integrationId === undefined ? undefined : stamped.filter((e) => e.streamId === integrationId)
  const runIds = [...new Set(stamped.map((e) => e.streamId))].filter((id) => id !== ticketId && id !== integrationId)
  const runs = runIds.map((id) => stamped.filter((e) => e.streamId === id))
  return integration === undefined ? { ticket, runs } : { ticket, runs, integration }
}

/** D5: an `IntegrationSucceeded` on the integration stream with no `TicketLanded` on the ticket. */
function integratedWithoutLanding(): Scenario {
  const ticketId = ticketStream(PROJECT, 9301)
  const integrationId = integrationStream(PROJECT, BASE)
  const t = makeStream(ticketId)
  const run = anAttempt(attemptStream('s9301-a'))
  const i = makeStream(integrationId)
  return bundle(
    ticketId,
    [
      t('TicketDiscovered', {
        project: PROJECT,
        source: 'github-issue',
        externalRef: '9301',
        title: 'integrated, never landed',
        kind: 'bug',
        labels: ['bug'],
      }),
      ...aClaim(t, run.runId),
      runStarted(run, ticketId),
      run.event('RunProducedDiff', { branch: 'agent/9301', headSha: 'sha-1', files: 1, insertions: 1, deletions: 0 }),
      ...run.aStepEnded(
        outcome('merge', 0, [
          act('merge', 'land', 'sha-1', {
            _tag: 'Completed',
            integration: { _tag: 'Integrated', mergeSha: 'merge-9301' },
          }),
        ]),
      ),
      i('IntegrationSucceeded', { ticketId, branch: 'agent/9301', base: BASE, mergeCommit: 'merge-9301' }),
    ],
    integrationId,
  )
}

/** D5: a wait whose answer is recorded after the run stream's `RunAwaitingInput` overwrote the open wait's note. */
function answerAfterRunNote(): Scenario {
  const ticketId = ticketStream(PROJECT, 9302)
  const t = makeStream(ticketId)
  const run = anAttempt(attemptStream('s9302-a'))
  const ask = wait('9302-ask')
  return bundle(ticketId, [
    ...aClaim(t, run.runId),
    runStarted(run, ticketId),
    ...aWait(
      t,
      { _tag: 'AgentQuestion', run: { runId: run.runId }, step: 'implement', question: 'which of the two?' },
      ask,
    ),
    // After the wait opened: the run stream's note overwrites the wait's own before the answer lands.
    run.event('RunAwaitingInput', { prompt: 'which of the two, really?' }),
    ...aResolution(t, ask, { _tag: 'EditBodyAndRequeue' }, 'steven', 'the first'),
  ])
}

/** A ticket that ran, was integrated and landed: the join `standingOf` reads. */
function landedWithRun(): Scenario {
  const ticketId = ticketStream(PROJECT, 9303)
  const integrationId = integrationStream(PROJECT, BASE)
  const t = makeStream(ticketId)
  const run = anAttempt(attemptStream('s9303-a'))
  const i = makeStream(integrationId)
  return bundle(
    ticketId,
    [
      t('TicketDiscovered', {
        project: PROJECT,
        source: 'github-issue',
        externalRef: '9303',
        title: 'landed',
        kind: 'feature',
        labels: ['feature'],
      }),
      ...aClaim(t, run.runId),
      runStarted(run, ticketId),
      run.event('RunProducedDiff', { branch: 'agent/9303', headSha: 'sha-1', files: 1, insertions: 1, deletions: 0 }),
      run.event('RunFinished', { exitCode: 0, turns: 9, durationMs: 30_000 }),
      i('IntegrationSucceeded', { ticketId, branch: 'agent/9303', base: BASE, mergeCommit: 'merge-9303' }),
      ...aLanding(t, 'merge-9303', BASE),
    ],
    integrationId,
  )
}

export const scenarios = {
  integratedWithoutLanding: integratedWithoutLanding(),
  answerAfterRunNote: answerAfterRunNote(),
  landedWithRun: landedWithRun(),
} as const

/**
 * Histories added after `scenarios` (#822), so no locked `seq` above moves. Same rule: append only.
 */
function fixRoundRouted(): readonly Envelope[] {
  const run = anAttempt(attemptStream('fix-round-routed'))
  const offer = {
    proposal: { _tag: 'BuildRed' as const, output: 'review refused' },
    available: [
      { id: 'fix-lines', next: { _tag: 'FixRound' as const, to: 'implement' as const, round: 1 } },
      { id: 'hand-to-person', next: { _tag: 'HandToPerson' as const } },
    ],
    unavailable: [],
  }
  const reply = { _tag: 'Selected' as const, candidate: 'fix-lines', why: 'the lines are wrong' }
  const decision = { _tag: 'Selected' as const, candidate: 'fix-lines' }
  return stamp([
    runStarted(run, runTicket),
    ...run.aStepEnded(
      outcome('implement', 0, [
        act('commit', 'fix', 'sha-1', { _tag: 'Completed', head: 'sha-1', question: null }, 'agent'),
      ]),
    ),
    ...run.aStepEnded(outcome('review', 0, [act('verdict', 'cold', 'sha-1', refused, 'agent')])),
    ...aRoute(run, { offer, reply, decision }),
    run.event('StepStarted', { runId: run.runId, step: 'implement', round: 1 }),
  ])
}

/** D12: a `StepEnded` for a step other than the one entered leaves the step. */
function stepEndedForAnother(): readonly Envelope[] {
  const run = anAttempt(attemptStream('step-ended-for-another'))
  return stamp([
    runStarted(run, runTicket),
    run.event('StepStarted', { runId: run.runId, step: 'implement', round: 0 }),
    run.event('StepEnded', { runId: run.runId, outcome: outcome('review', 0, []) }),
  ])
}

/** A ceiling stop inside a step: `RunFinished` then `RunFailed`, as one append (#825). */
function failedInsideStep(): readonly Envelope[] {
  const run = anAttempt(attemptStream('failed-inside-step'))
  return stamp([
    runStarted(run, runTicket),
    run.event('StepStarted', { runId: run.runId, step: 'implement', round: 0 }),
    run.event('RunFinished', { exitCode: 1, turns: 30, durationMs: 90_000 }),
    ...aRunFailure(run, 'out-of-turns', 'the turn ceiling'),
  ])
}

/** A refused review, then the run crashes in the fix round (#825). */
function refusedThenFailed(): readonly Envelope[] {
  const run = anAttempt(attemptStream('refused-then-failed'))
  return stamp([
    runStarted(run, runTicket),
    run.event('RunProducedDiff', { branch: 'agent/9001', headSha: 'sha-1', files: 1, insertions: 4, deletions: 1 }),
    run.event('StepStarted', { runId: run.runId, step: 'review', round: 0 }),
    ...run.aStepEnded(outcome('review', 0, [act('verdict', 'cold', 'sha-1', refused, 'agent')])),
    run.event('StepStarted', { runId: run.runId, step: 'implement', round: 1 }),
    ...aRunFailure(run, 'crash', 'the agent exited 1'),
  ])
}

type Published = {
  outcome: 'published' | 'nothing-committed' | 'already-published' | 'arm-only' | 'refused' | 'unrecorded'
  headSha: string | null
  branchCarries?: boolean
  armSha?: string | null
}

/** A run that published (#823); each kept WIP follows its `RunRefsPublished`, as the writer appends them. */
function publishedRun(
  name: string,
  row: Published,
  kept: readonly { arm: string; sha: string }[] = [],
): readonly Envelope[] {
  const run = anAttempt(attemptStream(name))
  return stamp([
    runStarted(run, runTicket),
    run.event('RunRefsPublished', { branch: 'agent/9', arm: 'agent/9-attempt-1', detail: name, ...row }),
    ...kept.map((k) =>
      run.event('RunKeptUncommitted', {
        ...k,
        parentSha: 'sha-1',
        stoppedBy: 'interrupted',
        files: 1,
        insertions: 2,
        deletions: 0,
      }),
    ),
  ])
}

/** #827: a run, then the plan it was given — all ten steps. */
function planResolved(): readonly Envelope[] {
  const run = anAttempt(attemptStream('plan-resolved'))
  return stamp([
    runStarted(run, runTicket),
    run.event('StepsResolved', {
      runId: run.runId,
      configHash: 'cfg-plan',
      steps: STEPS.map((step) => ({ step, actions: step === 'build' ? ['test', 'lint'] : [] })),
    }),
  ])
}

/** #827: a pass waits for the merge lane inside `merge`, then merge ends. */
function laneWaited(): readonly Envelope[] {
  const run = anAttempt(attemptStream('lane-waited'))
  return stamp([
    runStarted(run, runTicket),
    run.event('StepStarted', { runId: run.runId, step: 'merge', round: 0 }),
    run.event('MergeLaneWaited', { behind: { runId: 'pass-other', issue: '12' } }),
    run.event('StepEnded', {
      runId: run.runId,
      outcome: outcome('merge', 0, [act('verdict', 'lane', 'sha-1', refused, 'merge')]),
    }),
  ])
}

/** #828 D2: `implement`'s commit is on the base, a later verdict is on `sha-1`, and the head then moves to `sha-2`. */
function implementThenReviewed(): readonly Envelope[] {
  const run = anAttempt(attemptStream('implement-then-reviewed'))
  return stamp([
    runStarted(run, runTicket),
    ...run.aStepEnded(
      outcome('implement', 0, [
        act('commit', 'agent', 'base000', { _tag: 'Completed', head: 'sha-1', question: null }, 'agent'),
      ]),
    ),
    run.event('RunProducedDiff', { branch: 'agent/9001', headSha: 'sha-1', files: 1, insertions: 1, deletions: 0 }),
    ...run.aStepEnded(outcome('review', 0, [act('verdict', 'cold', 'sha-1', accepted, 'agent')])),
    run.event('RunProducedDiff', { branch: 'agent/9001', headSha: 'sha-2', files: 1, insertions: 2, deletions: 0 }),
  ])
}

const late_fixRoundRouted = fixRoundRouted()
const late_stepEndedForAnother = stepEndedForAnother()
const late_publishedClean = publishedRun('published-clean', { outcome: 'published', headSha: 'sha-1' })
const late_publishedWithWip = publishedRun(
  'published-with-wip',
  { outcome: 'published', headSha: 'sha-1', branchCarries: true, armSha: 'sha-wip' },
  [{ arm: 'agent/9-attempt-1', sha: 'sha-wip' }],
)
const late_wipRecorded = publishedRun(
  'wip-recorded',
  { outcome: 'published', headSha: 'sha-1', branchCarries: false, armSha: 'sha-wip' },
  [{ arm: 'agent/9-attempt-1', sha: 'sha-wip' }],
)
const late_wipOnAnotherArm = publishedRun(
  'wip-on-another-arm',
  { outcome: 'published', headSha: 'sha-1', branchCarries: false, armSha: 'sha-wip' },
  [{ arm: 'agent/9-attempt-2', sha: 'sha-wip' }],
)
const late_armOnly = publishedRun('arm-only', { outcome: 'arm-only', headSha: 'sha-1' })
const late_nothingCommitted = publishedRun('nothing-committed', { outcome: 'nothing-committed', headSha: null })
const late_failedInsideStep = failedInsideStep()
const late_refusedThenFailed = refusedThenFailed()
const late_planResolved = planResolved()
const late_laneWaited = laneWaited()
const late_implementThenReviewed = implementThenReviewed()

/** D4: titles come from the claims, the latest non-null winning. */
const late_titledByClaims = (() => {
  const t = makeStream(ticketStream(PROJECT, 9107))
  const claim = (r: string, title: string | null, kind: string | null) =>
    t('TicketClaimed', { runId: attemptStream(r), worker: 'conductor:1', title, kind })
  const released = (r: string) => t('TicketReleased', { runId: attemptStream(r), reason: 'failed', cause: null })
  return stamp([
    claim('t9107-1', 'first', 'bug'),
    released('t9107-1'),
    claim('t9107-2', null, null),
    released('t9107-2'),
    claim('t9107-3', 'renamed', 'feature'),
  ])
})()

/** D4: an escalated proposal answered with a requeue — the answer's question names the branch. */
const late_escalatedThenRequeued = (() => {
  const t = makeStream(ticketStream(PROJECT, 9108))
  const r1 = attemptStream('t9108-1')
  const w = wait('9108-escalated')
  return stamp([
    ...aClaim(t, r1),
    ...aWait(
      t,
      {
        _tag: 'ProposedEscalated',
        run: { runId: r1 },
        proposal: { _tag: 'VerifyRed', output: 'red' },
        because: { _tag: 'NotAsked' },
      } as never,
      w,
    ),
    ...aResolution(t, w, { _tag: 'Requeue' }, 'steven', 'not this way'),
  ])
})()

/** #832 D9: what Lingtai wrote to GitHub — a waiting comment, labels, a body, an edit, two refusals. */
function githubLedger(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9201))
  const run = attemptStream('t9201-a')
  const w1 = wait('ledger-1')
  const at = { project: PROJECT, issue: '9201' }
  return stamp([
    ...aClaim(t, run),
    ...aWait(
      t,
      { _tag: 'SignoffRequired', run: { runId: run }, step: 'merge', action: 'human', question: 'ship it?' },
      w1,
    ),
    t('IssueUpdated', { ...at, change: 'comment', detail: '101', waitId: w1, question: 'ship it?' }),
    t('IssueUpdated', { ...at, change: 'labels', detail: 'lingtai:waiting' }),
    t('IssueUpdated', { ...at, change: 'body', detail: 'section written' }),
    ...aResolution(t, w1, { _tag: 'EditBodyAndRequeue' }),
    t('IssueUpdated', { ...at, change: 'comment-edited', detail: '101', waitId: w1 }),
    t('IssueUpdateFailed', { ...at, change: 'labels', error: 'HTTP 502' }),
    t('IssueUpdateFailed', { ...at, change: 'closed', error: 'HTTP 502' }),
  ])
}

/** #832 D9: a body write, its wait resolved, and another wait started after it. */
function bodyBeforeAnotherWait(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9202))
  const run = attemptStream('t9202-a')
  const w1 = wait('body-1')
  const w2 = wait('body-2')
  const at = { project: PROJECT, issue: '9202' }
  const reason = (question: string) =>
    ({ _tag: 'SignoffRequired', run: { runId: run }, step: 'merge', action: 'human', question }) as const
  return stamp([
    ...aClaim(t, run),
    ...aWait(t, reason('first?'), w1),
    t('IssueUpdated', { ...at, change: 'body', detail: 'section written' }),
    ...aResolution(t, w1, { _tag: 'EditBodyAndRequeue' }),
    t('TicketContinued', { runId: run, worker: 'conductor:1' }),
    ...aWait(t, reason('second?'), w2),
  ])
}

const githubLedgerH = githubLedger()
const bodyBeforeAnotherWaitH = bodyBeforeAnotherWait()

/** A day-ceiling pause, as `dayCeilingPause` writes one. */
const ceilingPause = (until: string) => ({
  by: 'lingtai',
  reason: 'daily ceiling reached — $5.00 of $5.00',
  until,
  holdsAcrossStarts: false,
  cause: 'day-ceiling' as const,
})

/** 0124 §2, D8: a person's resume of the ceiling's pause waives it until that pause's midnight. */
const late_ceilingResumedByPerson = (() => {
  const c = makeStream(CONTROL_STREAM)
  return stamp([c('ConductorPaused', ceilingPause(HOLDING_UNTIL)), c('ConductorResumed', { by: 'steven' })])
})()

/** The ceiling lifting its own pause is not a waiver. */
const late_ceilingResumedByLingtai = (() => {
  const c = makeStream(CONTROL_STREAM)
  return stamp([c('ConductorPaused', ceilingPause(HOLDING_UNTIL)), c('ConductorResumed', { by: 'lingtai' })])
})()

/** A person's pause on top of the ceiling's makes the standing pause theirs, so their resume waives nothing. */
const late_ceilingThenPersonPause = (() => {
  const c = makeStream(CONTROL_STREAM)
  return stamp([
    c('ConductorPaused', ceilingPause(HOLDING_UNTIL)),
    c('ConductorPaused', { ...pause(null), cause: 'person' as const }),
    c('ConductorResumed', { by: 'steven' }),
  ])
})()

/** A new ceiling pause clears the waiver the last one was given. */
const late_ceilingWaivedThenRepaused = (() => {
  const c = makeStream(CONTROL_STREAM)
  return stamp([
    c('ConductorPaused', ceilingPause(HOLDING_UNTIL)),
    c('ConductorResumed', { by: 'steven' }),
    c('ConductorPaused', ceilingPause(HOLDING_UNTIL)),
  ])
})()

/** A waiver whose pause's midnight is already past at `NOW` has lapsed. */
const late_ceilingLapsedThenResumed = (() => {
  const c = makeStream(CONTROL_STREAM)
  return stamp([c('ConductorPaused', ceilingPause(LIFTED_UNTIL)), c('ConductorResumed', { by: 'steven' })])
})()

/** D14: an ask, the same question asked again after a crash, then one answer. */
const late_retriedRequest = (() => {
  const c = makeStream(chatStream('9001-3'))
  return stamp([c('DiscussionAsked', ASK), c('DiscussionAsked', ASK), c('DiscussionAnswered', ANSWER)])
})()

/** D14: two asks, then two answers — the first answer belongs to the second ask. */
const late_twoAsksTwoAnswers = (() => {
  const c = makeStream(chatStream('9001-4'))
  return stamp([
    c('DiscussionAsked', ASK),
    c('DiscussionAsked', { ...ASK, question: 'and the second?' }),
    c('DiscussionAnswered', ANSWER),
    c('DiscussionAnswered', { ...ANSWER, text: 'second answer' }),
  ])
})()

/** #829 D13: an attempt that asked, was requeued by a person, and so was released in the same append. */
const late_askedThenReleasedByPerson = (() => {
  const t = makeStream(ticketStream(PROJECT, 9109))
  const r1 = attemptStream('t9109-1')
  const w = wait('9109-check')
  return stamp([
    ...aClaim(t, r1),
    ...aWait(
      t,
      { _tag: 'CheckRefused', run: { runId: r1 }, step: 'proposed', action: 'test', evidence: 'red', findings: [] },
      w,
    ),
    ...aResolution(t, w, { _tag: 'Requeue' }),
    ...aRelease(t, r1, 'Requeued by steven.', { _tag: 'ByPerson', waitId: w }),
  ])
})()

/** #829 D13: an attempt that asked and was answered, which returns the ticket to the backlog with no release. */
const late_askedThenAnswered = (() => {
  const t = makeStream(ticketStream(PROJECT, 9110))
  const r1 = attemptStream('t9110-1')
  const w = wait('9110-ask')
  return stamp([
    ...aClaim(t, r1),
    ...aWait(t, { _tag: 'AgentQuestion', run: { runId: r1 }, step: 'design', question: 'which of the two?' }, w),
    ...aResolution(t, w, { _tag: 'AnswerQuestion', choice: 'the first' }),
  ])
})()

/** #829 D13: a release whose reason is empty stays empty. */
const late_releasedWithoutReason = (() => {
  const t = makeStream(ticketStream(PROJECT, 9111))
  const r1 = attemptStream('t9111-1')
  return stamp([...aClaim(t, r1), ...aRelease(t, r1, '')])
})()

/** #831: a person closed the ticket from a sign-off, and the close followed their move. */
const late_closedByPerson = (() => {
  const t = makeStream(ticketStream(PROJECT, 9112))
  const r1 = attemptStream('t9112-1')
  const w = wait('9112-sign')
  return stamp([
    ...aClaim(t, r1),
    ...aWait(
      t,
      { _tag: 'SignoffRequired', run: { runId: r1 }, step: 'proposed', action: 'human', question: 'ship it?' },
      w,
    ),
    ...aResolution(t, w, { _tag: 'Close' }),
    t('TicketClosed', { by: 'steven', reason: 'not wanted' }),
  ])
})()

/** #831 D6: the same close, on its own stream, then a claim `closed` absorbs. */
const late_closedByPersonThenClaimed = (() => {
  const t = makeStream(ticketStream(PROJECT, 9113))
  const r1 = attemptStream('t9113-1')
  const r2 = attemptStream('t9113-2')
  const w = wait('9113-sign')
  return stamp([
    ...aClaim(t, r1),
    ...aWait(
      t,
      { _tag: 'SignoffRequired', run: { runId: r1 }, step: 'proposed', action: 'human', question: 'ship it?' },
      w,
    ),
    ...aResolution(t, w, { _tag: 'Close' }),
    t('TicketClosed', { by: 'steven', reason: 'not wanted' }),
    ...aClaim(t, r2),
  ])
})()

/** #842: two triage attempts, a late result for the first, a duplicate result, and a second resolution. */
const late_triagedTwice = (() => {
  const t = makeStream(ticketStream(PROJECT, 9114))
  const r1 = attemptStream('t9114-1')
  const w = wait('9114-crash')
  const agent = { _tag: 'Agent', runtime: 'claude-code', model: 'sonnet' } as const
  const failed = (why: string) => ({ _tag: 'TriageFailed', why }) as const
  const by = { _tag: 'Mechanical' } as const
  const triaged = (attempt: number, why: string) =>
    t('WaitTriaged', { waitId: w, attempt, headSha: `head-${attempt}`, result: failed(why), by })
  return stamp([
    ...aClaim(t, r1),
    ...aWait(t, { _tag: 'AgentCrashed', run: { runId: r1 }, step: 'implement', cause: 'crash', detail: 'died' }, w),
    t('TriageStarted', { waitId: w, attempt: 1, by: agent }),
    triaged(1, 'first'),
    t('TriageStarted', { waitId: w, attempt: 2, by: agent }),
    triaged(1, 'late'),
    triaged(2, 'second'),
    triaged(2, 'duplicate'),
    ...aResolution(t, w, { _tag: 'Requeue' }),
    ...aResolution(t, w, { _tag: 'Requeue' }, 'someone'),
  ])
})()

/** #842: a wait begun after the ticket closed is still a wait. */
const late_waitAfterClosed = (() => {
  const t = makeStream(ticketStream(PROJECT, 9115))
  const r1 = attemptStream('t9115-1')
  return stamp([
    ...aClaim(t, r1),
    t('TicketClosed', { by: 'steven', reason: 'not wanted' }),
    ...aWait(
      t,
      { _tag: 'AgentCrashed', run: { runId: r1 }, step: 'implement', cause: 'crash', detail: 'died' },
      wait('9115-late'),
    ),
  ])
})()

/** #842: two approved waits, then a landing, which belongs to the second. */
const late_waitThenLanded = (() => {
  const t = makeStream(ticketStream(PROJECT, 9116))
  const r1 = attemptStream('t9116-1')
  const w1 = wait('9116-one')
  const w2 = wait('9116-two')
  const reason = {
    _tag: 'SignoffRequired',
    run: { runId: r1 },
    step: 'proposed',
    action: 'human',
    question: 'ship it?',
  } as const
  return stamp([
    ...aClaim(t, r1),
    ...aWait(t, reason, w1),
    ...aResolution(t, w1, { _tag: 'Approve', onSha: 'sha-1' }),
    t('TicketContinued', { runId: r1, worker: 'conductor:1' }),
    ...aWait(t, reason, w2),
    ...aResolution(t, w2, { _tag: 'Approve', onSha: 'sha-2' }),
    ...aLanding(t, 'abcdef1234567', BASE),
  ])
})()

/** #843: latest outcome wins, held order is kept, and a close does not absorb a held. */
const late_discussionsHeld = (() => {
  const t = makeStream(ticketStream(PROJECT, 9117))
  const r1 = attemptStream('t9117-1')
  return stamp([
    ...aClaim(t, r1),
    t('DiscussionHeld', { chatId: 'c1', outcome: 'prompt', by: 'steven' }),
    t('DiscussionHeld', { chatId: 'c2', outcome: 'none', by: 'steven' }),
    t('DiscussionHeld', { chatId: 'c1', outcome: 'ticket', by: 'steven' }),
    t('TicketClosed', { by: 'steven', reason: 'not wanted' }),
    t('DiscussionHeld', { chatId: 'c3', outcome: 'none', by: 'steven' }),
  ])
})()

/** #835: a kinded claim, a release, a kindless claim, then a triage `RunSpent` — spend reads `bug`. */
const late_kindThenTriage = (() => {
  const t = makeStream(ticketStream(PROJECT, 9118))
  const r1 = attemptStream('t9118-1')
  const r2 = attemptStream('t9118-2')
  return stamp([
    t('TicketClaimed', { runId: r1, worker: 'conductor:1', title: null, kind: 'bug' }),
    ...aRelease(t, r1),
    t('TicketClaimed', { runId: r2, worker: 'conductor:1', title: null, kind: null }),
    t('RunSpent', {
      for: { _tag: 'Triage', waitId: 'wait-9118' as WaitId },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1000,
      usage: [{ model: 'claude-opus-5', tokens: { fresh: 100, output: 20 } }],
      costUsd: 0.1,
    }),
  ])
})()

/** #835: a kinded claim after a close is absorbed by the ticket reduce, so a triage `RunSpent` reads `bug`. */
const late_kindedClaimAfterClosed = (() => {
  const t = makeStream(ticketStream(PROJECT, 9119))
  const r1 = attemptStream('t9119-1')
  const r2 = attemptStream('t9119-2')
  return stamp([
    t('TicketClaimed', { runId: r1, worker: 'conductor:1', title: null, kind: 'bug' }),
    t('TicketClosed', { by: 'steven', reason: 'not wanted' }),
    t('TicketClaimed', { runId: r2, worker: 'conductor:1', title: null, kind: 'feature' }),
    t('RunSpent', {
      for: { _tag: 'Triage', waitId: 'wait-9119' as WaitId },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1000,
      usage: [{ model: 'claude-opus-5', tokens: { fresh: 100, output: 20 } }],
      costUsd: 0.1,
    }),
  ])
})()

/** D7: an accept with nothing after it — opening the issue is still owed. */
const late_acceptedOnly = (() => {
  const f = makeStream(backlogStream(PROJECT, 'minor-3'))
  return stamp([f('FindingAccepted', { ...finding('minor-3'), kind: 'tech-debt', labels: [] })])
})()

/** D7: a stream no writer makes — a decline, then an accept. It throws. */
const late_declinedThenAccepted = (() => {
  const f = makeStream(backlogStream(PROJECT, 'minor-4'))
  return stamp([
    f('FindingDeclined', { ...finding('minor-4'), reason: 'not worth a ticket' }),
    f('FindingAccepted', { ...finding('minor-4'), kind: 'tech-debt', labels: [] }),
  ])
})()

/**
 * #932: a route stored by reference. The `ProposalRouted` carries no findings;
 * it names the refusing `StepEnded` by its version on the stream and the action.
 */
function proposalRoutedByReference(): readonly Envelope[] {
  const run = anAttempt(attemptStream('proposal-routed'))
  const started = runStarted(run, runTicket)
  const ended = run.aStepEnded(outcome('review', 0, [act('verdict', 'cold', 'sha-1', refused, 'agent')]))
  // The route names the `StepEnded` itself, not the `StepStarted` before it.
  const endedVersion = ended.find((e) => e.type === 'StepEnded')!.version
  const offer = {
    proposal: { _tag: 'ReviewFindings' as const },
    available: [
      { id: 'fix-lines', next: { _tag: 'FixRound' as const, to: 'implement' as const, round: 1 } },
      { id: 'hand-to-person', next: { _tag: 'HandToPerson' as const } },
    ],
    unavailable: [],
    ended: { version: endedVersion, action: 'cold' },
  }
  const reply = { _tag: 'Selected' as const, candidate: 'fix-lines', why: 'the lines are wrong' }
  const decision = { _tag: 'Selected' as const, candidate: 'fix-lines' }
  // Not `stamp`: it spends the module's seq and slot counters, and a history
  // built in the middle would shift every one after it (see the header).
  return [
    started,
    ...ended,
    run.event('ProposalRouted', { runId: run.runId, offer, reply, decision }),
    run.event('StepStarted', { runId: run.runId, step: 'implement', round: 1 }),
  ].map((e, i) => ({ ...e, seq: BigInt(900_000_000 + i), at: new Date(START_MS - (10 - i) * STEP_MS) }))
}

const late_proposalRoutedByReference = proposalRoutedByReference()

export const lateHistories = {
  attempt: {
    fixRoundRouted: late_fixRoundRouted,
    stepEndedForAnother: late_stepEndedForAnother,
    publishedClean: late_publishedClean,
    publishedWithWip: late_publishedWithWip,
    wipRecorded: late_wipRecorded,
    wipOnAnotherArm: late_wipOnAnotherArm,
    armOnly: late_armOnly,
    nothingCommitted: late_nothingCommitted,
    failedInsideStep: late_failedInsideStep,
    refusedThenFailed: late_refusedThenFailed,
    planResolved: late_planResolved,
    laneWaited: late_laneWaited,
    implementThenReviewed: late_implementThenReviewed,
    proposalRoutedByReference: late_proposalRoutedByReference,
  },
  ticket: {
    titledByClaims: late_titledByClaims,
    escalatedThenRequeued: late_escalatedThenRequeued,
    githubLedger: githubLedgerH,
    bodyBeforeAnotherWait: bodyBeforeAnotherWaitH,
    askedThenReleasedByPerson: late_askedThenReleasedByPerson,
    askedThenAnswered: late_askedThenAnswered,
    releasedWithoutReason: late_releasedWithoutReason,
    closedByPerson: late_closedByPerson,
    closedByPersonThenClaimed: late_closedByPersonThenClaimed,
    triagedTwice: late_triagedTwice,
    waitAfterClosed: late_waitAfterClosed,
    waitThenLanded: late_waitThenLanded,
    discussionsHeld: late_discussionsHeld,
    kindThenTriage: late_kindThenTriage,
    kindedClaimAfterClosed: late_kindedClaimAfterClosed,
  },
  control: {
    ceilingResumedByPerson: late_ceilingResumedByPerson,
    ceilingResumedByLingtai: late_ceilingResumedByLingtai,
    ceilingThenPersonPause: late_ceilingThenPersonPause,
    ceilingWaivedThenRepaused: late_ceilingWaivedThenRepaused,
    ceilingLapsedThenResumed: late_ceilingLapsedThenResumed,
  },
  chat: {
    retriedRequest: late_retriedRequest,
    twoAsksTwoAnswers: late_twoAsksTwoAnswers,
  },
  finding: {
    acceptedOnly: late_acceptedOnly,
    declinedThenAccepted: late_declinedThenAccepted,
  },
} as const

// ----------------------------------------------------------- late scenarios ----

/**
 * Scenarios added after `scenarios` (#844), so no locked `seq` above moves. Each is built here, after the
 * last history in the file, and exported from `lateScenarios`: `scenarios` is locked, and a bundle placed
 * before the histories above would shift every `seq` after it. Append only.
 */
const lateTicket = (n: number) => ticketStream(PROJECT, n)
const askedQuestion = 'merge this?'
const signoffEnded = (run: AttemptFixture, sha: string) =>
  run.aStepEnded(
    outcome('merge', 0, [
      act('signoff', 'human', sha, { _tag: 'Completed', requested: { question: askedQuestion } }, 'human'),
    ]),
  )
const verdictEnded = (run: AttemptFixture) =>
  run.aStepEnded(outcome('review', 0, [act('verdict', 'cold', 'sha-1', accepted, 'agent')]))

/** A signoff asked, approved, continued, then refused at the lane: the spent approval's sha is not offered again. */
const late_staleSignoff = (() => {
  const ticketId = lateTicket(9401)
  const t = makeStream(ticketId)
  const run = anAttempt(attemptStream('s9401-a'))
  return bundle(ticketId, [
    ...aClaim(t, run.runId),
    runStarted(run, ticketId),
    ...signoffEnded(run, 'sha-1'),
    ...aWait(
      t,
      { _tag: 'SignoffRequired', run: { runId: run.runId }, step: 'merge', action: 'human', question: askedQuestion },
      wait('9401-sign'),
    ),
    ...aResolution(t, wait('9401-sign'), { _tag: 'Approve', onSha: 'sha-1' }),
    t('TicketContinued', { runId: run.runId, worker: 'conductor:1' }),
    ...run.aStepEnded(
      outcome('merge', 0, [
        act('merge', 'land', 'sha-1', {
          _tag: 'Completed',
          integration: { _tag: 'Conflicted', paths: null, baseSha: null, headSha: null },
        }),
      ]),
    ),
    ...aWait(
      t,
      { _tag: 'MergeRefused', run: { runId: run.runId }, reason: 'dirty-base', raw: 'uncommitted changes' },
      wait('9401-refused'),
    ),
  ])
})()

/** The first dispatch proposes completion, a review refuses, the router opens a fix round: `verifying`, then `running`. */
const late_fixRoundAfterCompletion = (() => {
  const ticketId = lateTicket(9402)
  const t = makeStream(ticketId)
  const run = anAttempt(attemptStream('s9402-a'))
  const offer = {
    proposal: { _tag: 'ReviewFindings' as const, findings: [] },
    available: [
      { id: 'fix-lines', next: { _tag: 'FixRound' as const, to: 'implement' as const, round: 1 } },
      { id: 'hand-to-person', next: { _tag: 'HandToPerson' as const } },
    ],
    unavailable: [],
  }
  return bundle(ticketId, [
    ...aClaim(t, run.runId),
    runStarted(run, ticketId),
    run.event('RunProducedDiff', { branch: 'agent/9402', headSha: 'sha-1', files: 2, insertions: 5, deletions: 1 }),
    run.event('RunFinished', { exitCode: 0, turns: 12, durationMs: 60_000 }),
    run.event('RunProposedCompletion', { headSha: 'sha-1' }),
    ...run.aStepEnded(outcome('review', 0, [act('verdict', 'cold', 'sha-1', refused, 'agent')])),
    ...aRoute(run, {
      offer,
      reply: { _tag: 'Selected', candidate: 'fix-lines', why: 'the lines are wrong' },
      decision: { _tag: 'Selected', candidate: 'fix-lines' },
    }),
    run.event('StepStarted', { runId: run.runId, step: 'implement', round: 1 }),
    ...run.aStepEnded(
      outcome('implement', 1, [
        act('commit', 'fix', 'sha-2', { _tag: 'Completed', head: 'sha-2', question: null }, 'agent'),
      ]),
    ),
    run.event('StepStarted', { runId: run.runId, step: 'build', round: 1 }),
  ])
})()

/** A second claim: the card shows the new run's base and no head, files or turns until it produces its own. */
const late_secondRun = (() => {
  const ticketId = lateTicket(9403)
  const t = makeStream(ticketId)
  const r1 = anAttempt(attemptStream('s9403-a'))
  const r2 = anAttempt(attemptStream('s9403-b'))
  return bundle(ticketId, [
    ...aClaim(t, r1.runId),
    runStarted(r1, ticketId),
    r1.event('RunProducedDiff', { branch: 'agent/9403', headSha: 'sha-1', files: 1, insertions: 4, deletions: 1 }),
    r1.event('RunFinished', { exitCode: 0, turns: 9, durationMs: 30_000 }),
    ...aRelease(t, r1.runId, 'the pass did not finish'),
    ...aClaim(t, r2.runId),
    r2.event('RunStarted', {
      ticketId,
      runtime: 'claude-code',
      model: 'claude-opus-5',
      promptVersion: 'ticket@3',
      baseSha: 'base222',
      configHash: 'cfg123',
      worktree: '/tmp/wt/9403-b',
      invocation: null,
    }),
  ])
})()

/** `lingtai ask` after a release: no run is the card's, so no verdict pills. */
const late_askAfterRelease = (() => {
  const ticketId = lateTicket(9404)
  const t = makeStream(ticketId)
  const run = anAttempt(attemptStream('s9404-a'))
  return bundle(ticketId, [
    ...aClaim(t, run.runId),
    runStarted(run, ticketId),
    ...verdictEnded(run),
    ...aRelease(t, run.runId, 'the pass did not finish'),
    ...aWait(t, { _tag: 'OwnQuestion', question: 'which base?', by: 'steven' }, wait('9404-ask')),
  ])
})()

/** A close after a release leaves the run un-named. */
const late_closeAfterRelease = (() => {
  const ticketId = lateTicket(9405)
  const t = makeStream(ticketId)
  const run = anAttempt(attemptStream('s9405-a'))
  return bundle(ticketId, [
    ...aClaim(t, run.runId),
    runStarted(run, ticketId),
    ...verdictEnded(run),
    ...aRelease(t, run.runId, 'the pass did not finish'),
    t('TicketClosed', { by: 'steven', reason: 'not wanted' }),
  ])
})()

/** A person requeues a run's wait: the resolution and the release are one append (`resolve-wait.ts`). */
const late_requeueOfRunWait = (() => {
  const ticketId = lateTicket(9406)
  const t = makeStream(ticketId)
  const run = anAttempt(attemptStream('s9406-a'))
  const ask = wait('9406-ask')
  return bundle(ticketId, [
    ...aClaim(t, run.runId),
    runStarted(run, ticketId),
    ...aWait(
      t,
      { _tag: 'AgentQuestion', run: { runId: run.runId }, step: 'implement', question: 'which approach?' },
      ask,
    ),
    ...aResolution(t, ask, { _tag: 'Requeue' }),
    ...aRelease(t, run.runId, 'Requeued by steven.', { _tag: 'ByPerson', waitId: ask }),
  ])
})()

export const lateScenarios = {
  staleSignoff: late_staleSignoff,
  fixRoundAfterCompletion: late_fixRoundAfterCompletion,
  secondRun: late_secondRun,
  askAfterRelease: late_askAfterRelease,
  closeAfterRelease: late_closeAfterRelease,
  requeueOfRunWait: late_requeueOfRunWait,
} as const

/**
 * The event types each stream kind's histories must contain: every catalogue
 * `case` label of `reduceAttemptEvent` / `reduceTicketEvent` (the retired `TicketLinked`
 * included), exactly `CONTROL_FOLD_TYPES`, and the chat and finding streams'
 * own types. Types reached only through board or projector helpers are not here.
 */
export const COVERS = {
  attempt: [
    'RunStarted',
    'RunPrompted',
    'RunTouchedFile',
    'RunContextExhausted',
    'RunAwaitingInput',
    'RunProducedDiff',
    'RunProposedCompletion',
    'RunFinished',
    'RunFailed',
    'StepStarted',
    'StepEnded',
    'StepsResolved',
    'MergeLaneWaited',
    'PassRouted',
    'ProposalRouted',
    'RunRefsPublished',
    'RunKeptUncommitted',
  ],
  ticket: [
    'TicketDiscovered',
    'TicketContinued',
    'TicketClaimed',
    'PromptEdited',
    'TicketReleased',
    'WaitStarted',
    'WaitResolved',
    'TriageStarted',
    'WaitTriaged',
    'TicketSplit',
    'TicketLinked',
    'DiscussionHeld',
    'TicketClosed',
    'TicketLanded',
    'DispatchRefused',
    'IssueUpdated',
    'IssueUpdateFailed',
  ],
  control: [...CONTROL_FOLD_TYPES],
  chat: ['DiscussionAsked', 'DiscussionAnswered'],
  finding: ['FindingProposed', 'FindingAccepted', 'FindingDeclined'],
} as const satisfies Record<string, readonly EventType[]>

// --------------------------------------------------- reducer fixtures ----

/**
 * What `reducer-versions.json` hashes (0124 §3, #867): one history per
 * registered reducer, holding every type it handles. Frozen for a version — it
 * changes only in the commit that raises the version and adds the row.
 */
const controlStream = makeStream(CONTROL_STREAM)
const late_everyControlEvent = stamp(
  (() => {
    const c = controlStream
    return [
      c('ConductorPaused', { ...pause('2026-08-03T00:00:00.000Z', true), cause: 'day-ceiling' }),
      c('ConductorResumed', { by: 'steven' }),
      c('ConductorPaused', pause(HOLDING_UNTIL)),
      c('ConductorShutdownRequested', { by: 'steven', reason: 'restart', timeoutMs: 60_000, force: false }),
      c('ConductorShutdownWithdrawn', { by: 'steven', version: 4, reason: 'changed my mind', handoff: null }),
      c('ConductorShutdownRequested', { by: 'steven', reason: 'for real', timeoutMs: null, force: true }),
      c('RunRequested', { project: PROJECT, issue: '9002', by: 'steven' }),
      c('ContinueRequested', { project: PROJECT, issue: '9002', runId: attemptStream('fixture'), by: 'steven' }),
      c('DiscussionRequested', {
        chatId: chatStream('9002-1'),
        ticketId: ticketStream(PROJECT, 9002),
        attempt: 1,
        question: 'why this approach?',
        by: 'steven',
      }),
      c('DiscussionRequested', {
        chatId: chatStream('9002-2'),
        ticketId: ticketStream(PROJECT, 9002),
        attempt: null,
        question: 'and before any attempt?',
        by: 'steven',
      }),
    ]
  })(),
)

/**
 * The ticket reducer's fixture (#876): one event of each type it handles, taken from the ticket histories above
 * in the order they first appear, on one stream. `histories.ticket.everyTicketEvent` is not this — it holds
 * fewer types, and a frozen history cannot be added to.
 */
const late_everyTicketTypeOnOneStream = stamp(
  (() => {
    const seen = new Set<string>()
    const picked: Envelope[] = []
    for (const e of [...Object.values(histories.ticket), ...Object.values(lateHistories.ticket)].flat()) {
      if (seen.has(e.type)) continue
      seen.add(e.type)
      picked.push(e)
    }
    // Order matters: `closed` is absorbing, so `TicketClosed` goes last or every event after it is a no-op, and
    // `TicketContinued` follows the `WaitResolved` that approves the run it continues (not a ghost run).
    const started = picked.find((e) => e.type === 'WaitStarted')
    const approvedRun = (started!.data as { reason: { run: { runId: string } } }).reason.run.runId
    const rest = picked.filter((e) => e.type !== 'TicketClosed' && e.type !== 'TicketContinued')
    const continued = picked
      .filter((e) => e.type === 'TicketContinued')
      .map((e) => ({ ...e, data: { ...(e.data as object), runId: approvedRun } }) as Envelope)
    const closed = picked.filter((e) => e.type === 'TicketClosed')
    const at = rest.findIndex((e) => e.type === 'WaitResolved') + 1
    const ordered = [...rest.slice(0, at), ...continued, ...rest.slice(at), ...closed]
    const streamId = ticketStream(PROJECT, 9002)
    return ordered.map((e, i) => ({ ...e, streamId, version: i + 1 }))
  })(),
)

/**
 * The attempt reducer's fixture (#878): the first event of each type it handles, taken from the attempt histories
 * above in the order they first appear, on one stream. The terminal events go last, so nothing after them is a no-op.
 */
const late_everyAttemptType = stamp(
  (() => {
    const seen = new Set<string>()
    const picked: Envelope[] = []
    for (const e of [...Object.values(histories.attempt), ...Object.values(lateHistories.attempt)].flat()) {
      if (seen.has(e.type)) continue
      seen.add(e.type)
      picked.push(e)
    }
    const last = (e: Envelope) => e.type === 'RunFinished' || e.type === 'RunFailed'
    const ordered = [...picked.filter((e) => !last(e)), ...picked.filter(last)]
    const streamId = attemptStream('every-type')
    return ordered.map((e, i) => ({ ...e, streamId, version: i + 1 }))
  })(),
)

/**
 * The control fixture's last event (version 3 of the control reducer): a start after a standing request, which
 * ends it. Stamped here, after the ticket and attempt fixtures, because `stamp` numbers `seq` and `at` across
 * the module and stamping it beside the others would move their hashes (their versions did not change).
 */
const late_controlStarted = stamp([
  controlStream('ConductorStarted', {
    by: 'steven',
    reason: 'restart',
    sha: 'a'.repeat(40),
    dirty: false,
    worker: 'fixture',
    handoff: null,
  }),
])

export const reducerFixtures = {
  control: { everyControlEvent: [...late_everyControlEvent, ...late_controlStarted] },
  ticket: { everyTicketType: late_everyTicketTypeOnOneStream },
  attempt: { everyAttemptEvent: late_everyAttemptType },
} as const
