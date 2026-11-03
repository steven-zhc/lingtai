/**
 * Fixed event histories every fold of the one-fold epic (#797) is run over
 * (#798, plan `doc/design/one-fold-per-stream.md` §3 T0a, §4, §5).
 *
 * **Append only.** `seq` is assigned here, from this module's own counter, in the
 * order the histories are built below, and `histories.hashes.json` hashes it. A
 * history added *after* the existing ones changes nothing; one inserted *before*
 * them shifts every later `seq` and fails the lock. A history is never edited: a
 * later fold change that needs a new cell adds a new named history.
 *
 * **Nothing here reads a clock or a counter that is not this module's.**
 * `makeStream`'s `seq` is module-global (`support.ts`) and its `at` is one default
 * instant, so every history is re-stamped by `stamp` below — a fixture imported
 * after another module that also calls `makeStream` would otherwise move. Do not
 * call `aWaitId()` (a global counter, and part of a payload) or `new Date()`:
 * wait ids are literals, and every time-shaped payload value is a literal offset
 * from `NOW`.
 *
 * **`NOW` is what every fold that reads the clock is folded against**
 * (`reduceControl(events, NOW)`), later than every `at` in this module.
 */
import type { Action, Envelope, EventType, StepOutcome, WaitId } from '../src/index.ts'
import {
  CONTROL_FOLD_TYPES,
  CONTROL_STREAM,
  chatStream,
  integrationStream,
  passStream,
  STEPS,
  ticketStream,
} from '../src/index.ts'
import {
  aClaim,
  aLanding,
  aRoute,
  aRelease,
  aResolution,
  aRun,
  aRunFailure,
  aSplit,
  aWait,
  type RunFixture,
} from './events.ts'
import { makeStream } from './support.ts'

/** The instant clock-reading folds are folded at. After every `at` below. */
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

function runStarted(run: RunFixture, ticket: string): Envelope {
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
  const run = aRun(passStream('landed-first-try'))
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
  const run = aRun(passStream('fix-round'))
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
  const run = aRun(passStream('asked'))
  return stamp([
    runStarted(run, runTicket),
    run.event('RunAwaitingInput', { prompt: 'which of the two?' }),
    run.event('RunProducedDiff', { branch: 'agent/9001', headSha: 'sha-1', files: 2, insertions: 9, deletions: 0 }),
    run.event('RunFailed', { kind: 'timeout', detail: 'wall limit' }),
  ])
}

/** D1: a `commit` action `Completed` with `question: null` and `head: null` — nothing committed, and it still clears. */
function commitCompletedNoHead(): readonly Envelope[] {
  const run = aRun(passStream('commit-no-head'))
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
  const run = aRun(passStream('worktree-not-done'))
  return stamp([
    runStarted(run, runTicket),
    ...run.aStepEnded(outcome('prepared', 0, [act('worktree', 'cut', 'base000', { _tag: 'NotDone' }, 'file')])),
  ])
}

/** D1: a `design` action `AnswerUnreadable`. */
function designAnswerUnreadable(): readonly Envelope[] {
  const run = aRun(passStream('design-unreadable'))
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
  const run = aRun(passStream('later-not-reached'))
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
  const run = aRun(passStream('signoff-then-lifecycle'))
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
  const run = aRun(passStream('failed-then-finished'))
  return stamp([
    runStarted(run, runTicket),
    ...aRunFailure(run, 'crash', 'the agent exited 1'),
    run.event('RunFinished', { exitCode: 1, turns: 5, durationMs: 15_000 }),
  ])
}

/** D2: a verdict whose `onSha` is an older head than a later `RunProducedDiff`'s. */
function verdictOnOlderHead(): readonly Envelope[] {
  const run = aRun(passStream('verdict-older-head'))
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
    ...aClaim(t, passStream('t9101-a')),
    ...aRelease(t, passStream('t9101-a'), 'restart', { _tag: 'Restart', restart: 1 }),
    ...aClaim(t, passStream('t9101-b')),
    ...aLanding(t, 'merge-9101', BASE),
  ])
}

/** D11: a `TicketContinued` naming a run nobody claimed. */
function continuedUnclaimedRun(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9102))
  return stamp([
    ...aClaim(t, passStream('t9102-a')),
    t('TicketContinued', { runId: passStream('t9102-ghost'), worker: 'conductor:1' }),
    t('TicketContinued', { runId: passStream('t9102-a'), worker: 'conductor:1' }),
  ])
}

/** D6: a `TicketClaimed` after `TicketClosed` — `makeStream` checks no invariant. */
function claimedAfterClosed(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9103))
  return stamp([
    ...aClaim(t, passStream('t9103-a')),
    t('TicketClosed', { by: 'steven', reason: 'not wanted' }),
    ...aClaim(t, passStream('t9103-b')),
  ])
}

/** D5: waits resolved by `GrantFixRound` and by `Close`, before any `TicketClosed`. */
function waitsResolvedBeforeClose(): readonly Envelope[] {
  const t = makeStream(ticketStream(PROJECT, 9104))
  const run = passStream('t9104-a')
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
  const run = passStream('t9105-a')
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
  const run = passStream('t9106-a')
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
    // Retired, and still a case of `applyTicket`.
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
    c('ContinueRequested', { project: PROJECT, issue: '9001', runId: passStream('asked'), by: 'steven' }),
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
  run: {
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
  const run = aRun(passStream('s9301-a'))
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
  const run = aRun(passStream('s9302-a'))
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
  const run = aRun(passStream('s9303-a'))
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
  const run = aRun(passStream('fix-round-routed'))
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
  const run = aRun(passStream('step-ended-for-another'))
  return stamp([
    runStarted(run, runTicket),
    run.event('StepStarted', { runId: run.runId, step: 'implement', round: 0 }),
    run.event('StepEnded', { runId: run.runId, outcome: outcome('review', 0, []) }),
  ])
}

/** A ceiling stop inside a step: `RunFinished` then `RunFailed`, as one append (#825). */
function failedInsideStep(): readonly Envelope[] {
  const run = aRun(passStream('failed-inside-step'))
  return stamp([
    runStarted(run, runTicket),
    run.event('StepStarted', { runId: run.runId, step: 'implement', round: 0 }),
    run.event('RunFinished', { exitCode: 1, turns: 30, durationMs: 90_000 }),
    ...aRunFailure(run, 'out-of-turns', 'the turn ceiling'),
  ])
}

/** A refused review, then the run crashes in the fix round (#825). */
function refusedThenFailed(): readonly Envelope[] {
  const run = aRun(passStream('refused-then-failed'))
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
  const run = aRun(passStream(name))
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
  const run = aRun(passStream('plan-resolved'))
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
  const run = aRun(passStream('lane-waited'))
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
  const run = aRun(passStream('implement-then-reviewed'))
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
    t('TicketClaimed', { runId: passStream(r), worker: 'conductor:1', title, kind })
  const released = (r: string) => t('TicketReleased', { runId: passStream(r), reason: 'failed', cause: null })
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
  const r1 = passStream('t9108-1')
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

/** A day-ceiling pause, as `dayCeilingPause` writes one. */
const ceilingPause = (until: string) => ({
  by: 'lingtai',
  reason: 'daily ceiling reached — $5.00 of $5.00',
  until,
  holdsAcrossStarts: false,
  cause: 'day-ceiling',
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
    c('ConductorPaused', { ...pause(null), cause: 'person' }),
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

export const lateHistories = {
  run: {
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
  },
  ticket: {
    titledByClaims: late_titledByClaims,
    escalatedThenRequeued: late_escalatedThenRequeued,
  },
  control: {
    ceilingResumedByPerson: late_ceilingResumedByPerson,
    ceilingResumedByLingtai: late_ceilingResumedByLingtai,
    ceilingThenPersonPause: late_ceilingThenPersonPause,
    ceilingWaivedThenRepaused: late_ceilingWaivedThenRepaused,
    ceilingLapsedThenResumed: late_ceilingLapsedThenResumed,
  },
} as const

/**
 * The event types each stream kind's histories must contain: every catalogue
 * `case` label of `applyRun` / `applyTicket` (the retired `TicketLinked`
 * included), exactly `CONTROL_FOLD_TYPES`, and the chat and finding streams'
 * own types. Types reached only through board or projector helpers are not here.
 */
export const COVERS = {
  run: [
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
    'TicketSplit',
    'TicketLinked',
    'TicketClosed',
    'TicketLanded',
    'DispatchRefused',
  ],
  control: [...CONTROL_FOLD_TYPES],
  chat: ['DiscussionAsked', 'DiscussionAnswered'],
  finding: ['FindingProposed', 'FindingAccepted', 'FindingDeclined'],
} as const satisfies Record<string, readonly EventType[]>
