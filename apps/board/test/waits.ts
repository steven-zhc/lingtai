/**
 * One fixture per `WaitReason` tag (0118 §1, `@lingtai/domain/wait`), shared
 * between the card's own pin (`unit/waiting-card.test.tsx`, #482) and the
 * task page's moves-by-wait pin (`unit/moves-by-wait.test.tsx`, #442) — the
 * same events, read by two different folds. Moved out of
 * `waiting-card.test.tsx` rather than copied, so a change to one pin's wait
 * can never silently diverge from what the other asserts about it.
 *
 * **Generated from today's code, and never regenerated after the `src`**
 * **change** — see `waiting-card.test.tsx`'s own header for what that means
 * and why.
 */
import type { Envelope, Step } from '@lingtai/domain'
import { aClaim, aWait } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'

/** One wait, whole: the events a real pass would have appended for it. */
export interface WaitFixture {
  /** The `WaitReason._tag` this fixture is one of, for the coverage check both test files make. */
  tag: string
  /** Unique within the file — becomes `ticket-pin-<name>`. */
  name: string
  taskId: string
  events: Envelope[]
}

const FIXTURES: WaitFixture[] = []

/**
 * **What turns on `task_view.awaiting_sha` since #502.** `ApprovalRequested`
 * is gone — a card's Approve sha is read off `cardFactOf`'s `Verdict` fact
 * now, through the `signoff` action a `StepEnded` carries whenever one is
 * live (`task-view.ts`'s `fact.approval.onSha`, `read-model.ts`'s
 * `approvalEffectOf`). This builds exactly that `StepEnded`, standing in for
 * whatever declared the signoff (a `human:` action, or the router's own
 * floor) so this fixture file does not have to change shape, only the event
 * it is fed.
 */
export function approvalRequested(runId: string, step: Step, action: string, question: string): Envelope {
  return makeStream(runId)('StepEnded', {
    runId,
    outcome: {
      step,
      round: 0,
      actions: [
        {
          plugin: 'conductor',
          name: action,
          onSha: SHA,
          evidence: '',
          yields: 'signoff',
          result: { _tag: 'Completed', requested: { question } },
        },
      ],
    },
  })
}

const SHA = 'a'.repeat(40)

function add(tag: string, name: string, build: (item: ReturnType<typeof makeStream>) => Envelope[]): void {
  const taskId = `ticket-pin-${name}`
  FIXTURES.push({ tag, name, taskId, events: build(makeStream(taskId)) })
}

add('OwnQuestion', 'ownquestion', (item) => [
  ...aWait(item, { _tag: 'OwnQuestion', question: 'which base branch?', by: 'steven' }),
])

add('AgentQuestion', 'agentquestion', (item) => [
  ...aClaim(item, 'pass-pin-agentquestion'),
  ...aWait(item, {
    _tag: 'AgentQuestion',
    run: { runId: 'pass-pin-agentquestion' },
    step: 'implement',
    question: 'which approach?',
  }),
])

add('SignoffRequired', 'signoffrequired', (item) => [
  ...aClaim(item, 'pass-pin-signoffrequired'),
  approvalRequested('pass-pin-signoffrequired', 'merge', 'human', 'merge this?'),
  ...aWait(item, {
    _tag: 'SignoffRequired',
    run: { runId: 'pass-pin-signoffrequired' },
    step: 'merge',
    action: 'human',
    question: 'merge this?',
  }),
])

add('FixerDisagrees', 'fixerdisagrees', (item) => [
  ...aClaim(item, 'pass-pin-fixerdisagrees'),
  ...aWait(item, {
    _tag: 'FixerDisagrees',
    run: { runId: 'pass-pin-fixerdisagrees' },
    said: 'the fixer thinks this is fine',
  }),
])

add('NothingProduced', 'nothingproduced', (item) => [
  ...aClaim(item, 'pass-pin-nothingproduced'),
  ...aWait(item, { _tag: 'NothingProduced', run: { runId: 'pass-pin-nothingproduced' }, said: null }),
])

/**
 * **`branch` is back; `base` still is not.** `waitWords(reason, pass)`
 * composes `"${branch} into ${base} is waiting on you"` from a `pass`
 * argument — `WaitReason` itself carries neither, on purpose (0118 §1:
 * "branch/base live on the pass, not the wait") — and `cardFactOf`/
 * `boardFactOf` (`read-model.ts`), the only callers between the stored event
 * and this card, now supply `branch` off the ticket id's own issue number
 * (`agentBranchOf`, deterministic — `streams.ts`). `base` is still not
 * tracked by any projection, so `waitWords`'s own `subjectOf` drops the
 * `into ${base}` clause rather than opening the sentence on a blank: this
 * fixture's `name` after the last `-` stands in for the issue number
 * (`ticket-pin-proposedescalated-buildred` → `agent/buildred`, never
 * `agent/473` — that literal is only ever the `question` string fed to
 * `approvalRequested`, a separate input this fold never reads).
 */
add('ProposedEscalated', 'proposedescalated-buildred', (item) => [
  ...aClaim(item, 'pass-pin-pe-buildred'),
  // `conduct.ts`'s `judged = stopped === null || …` is true for every
  // `Routed` hold (the router handing `proposed` to a person), and this
  // fixture's run reached origin (`onOrigin !== null`), so production
  // pairs this ending with an `ApprovalRequested{step:'proposed',
  // action:'judge'}` (RUN_5/RUN_13 in `what-a-pass-shows-today.test.tsx`).
  // That is not unconditional, though: a push to origin that itself failed
  // leaves `onOrigin` null and no `ApprovalRequested` at all — the
  // `proposedescalated-unpushed` fixture below is that case.
  approvalRequested(
    'pass-pin-pe-buildred',
    'proposed',
    'conductor:judge',
    'Merge agent/473 into main anyway? agent/473 into main is waiting on you. tsc failed',
  ),
  ...aWait(item, {
    _tag: 'ProposedEscalated',
    run: { runId: 'pass-pin-pe-buildred' },
    proposal: { _tag: 'BuildRed', output: 'tsc failed' },
    because: { _tag: 'NotAsked' },
  }),
])

add('ProposedEscalated', 'proposedescalated-verifyred', (item) => [
  ...aClaim(item, 'pass-pin-pe-verifyred'),
  approvalRequested(
    'pass-pin-pe-verifyred',
    'proposed',
    'conductor:judge',
    'Merge agent/473 into main anyway? agent/473 into main is waiting on you. verify red output',
  ),
  ...aWait(item, {
    _tag: 'ProposedEscalated',
    run: { runId: 'pass-pin-pe-verifyred' },
    proposal: { _tag: 'VerifyRed', output: 'verify red output' },
    because: { _tag: 'NotAsked' },
  }),
])

add('ProposedEscalated', 'proposedescalated-mergeconflict', (item) => [
  ...aClaim(item, 'pass-pin-pe-mergeconflict'),
  approvalRequested(
    'pass-pin-pe-mergeconflict',
    'proposed',
    'conductor:judge',
    'Merge agent/473 into main anyway? agent/473 into main is waiting on you. conflict output',
  ),
  ...aWait(item, {
    _tag: 'ProposedEscalated',
    run: { runId: 'pass-pin-pe-mergeconflict' },
    proposal: {
      _tag: 'MergeConflict',
      output: 'conflict output',
      paths: ['a.ts'],
      baseSha: 'base1',
      headSha: 'head1',
    },
    because: { _tag: 'NotAsked' },
  }),
])

add('ProposedEscalated', 'proposedescalated-reviewfindings', (item) => [
  ...aClaim(item, 'pass-pin-pe-reviewfindings'),
  approvalRequested(
    'pass-pin-pe-reviewfindings',
    'proposed',
    'conductor:judge',
    'Merge agent/473 into main anyway? agent/473 into main is waiting on you. bug',
  ),
  ...aWait(item, {
    _tag: 'ProposedEscalated',
    run: { runId: 'pass-pin-pe-reviewfindings' },
    proposal: {
      _tag: 'ReviewFindings',
      findings: [{ file: 'a.ts', line: 1, claim: 'bug', failureScenario: 'breaks on empty input', severity: 'major' }],
    },
    because: { _tag: 'NotAsked' },
  }),
])

add('ProposedEscalated', 'proposedescalated-unpushed', (item) => [
  ...aClaim(item, 'pass-pin-pe-unpushed'),
  // `conduct.ts:3696` sets `unpushed` on the hold whenever the branch's own
  // push to origin failed, which makes `onOrigin` null — so
  // `conduct.ts:4008`'s `!held && judged && onOrigin !== null` is false and
  // no `ApprovalRequested` is ever appended here, unlike the sibling
  // fixtures above. `awaiting_sha` stays null (`task-view.ts:567`), so
  // `describeWait` draws no pill (`task-view.ts:1125`) and the page draws
  // no Approve button (`page.tsx:380`) — `Approve{onSha}` would otherwise
  // name a sha that reached nowhere.
  ...aWait(item, {
    _tag: 'ProposedEscalated',
    run: { runId: 'pass-pin-pe-unpushed', unpushed: { branch: 'agent/473', said: 'remote rejected the push' } },
    proposal: { _tag: 'BuildRed', output: 'tsc failed' },
    because: { _tag: 'NotAsked' },
  }),
])

add('CheckRefused', 'checkrefused', (item) => [
  ...aClaim(item, 'pass-pin-checkrefused'),
  // `CheckRed`'s hold reads `needs: 'acknowledgement'` (`wait-words.ts`),
  // so `describeWait` still answers null for the pill — but `conduct.ts`'s
  // `judged` is true for a `stopped.ending.ending === 'refused'` hold same as
  // this one, and `onOrigin !== null` (the diff reached origin before
  // `merge` ran), so production pairs this ending with
  // `ApprovalRequested{step:'merge',action:'unfixed'}` regardless (RUN_9),
  // which still turns on the Approve button.
  approvalRequested(
    'pass-pin-checkrefused',
    'merge',
    'conductor:unfixed',
    'Merge agent/473 into main anyway? the `merge` step refused: ci red (`ci`)',
  ),
  ...aWait(item, {
    _tag: 'CheckRefused',
    run: { runId: 'pass-pin-checkrefused' },
    step: 'merge',
    action: 'ci',
    evidence: 'ci red',
    findings: [],
  }),
])

add('MergeRefused', 'mergerefused', (item) => [
  ...aClaim(item, 'pass-pin-mergerefused'),
  // Same shape as `CheckRefused` above — `needs: 'acknowledgement'` keeps
  // the pill null, but `onOrigin !== null` and the refused lane's own
  // ending still pair an `ApprovalRequested{step:'merge',action:'unfixed'}`
  // (RUN_10b), so Approve is offered.
  approvalRequested(
    'pass-pin-mergerefused',
    'merge',
    'conductor:unfixed',
    'Merge agent/473 into main anyway? dirty-base: uncommitted changes present (`land the branch`)',
  ),
  ...aWait(item, {
    _tag: 'MergeRefused',
    run: { runId: 'pass-pin-mergerefused' },
    reason: 'dirty-base',
    raw: 'uncommitted changes present',
  }),
])

add('BudgetExhausted', 'budgetexhausted', (item) => [
  ...aClaim(item, 'pass-pin-budgetexhausted'),
  ...aWait(item, {
    _tag: 'BudgetExhausted',
    run: { runId: 'pass-pin-budgetexhausted' },
    cause: 'out-of-turns',
    detail: 'spent 80 turns',
  }),
])

add('AgentCrashed', 'agentcrashed', (item) => [
  ...aClaim(item, 'pass-pin-agentcrashed'),
  ...aWait(item, {
    _tag: 'AgentCrashed',
    run: { runId: 'pass-pin-agentcrashed' },
    step: 'implement',
    cause: 'crash',
    detail: 'segfault',
  }),
])

add('SetupRefused', 'setuprefused', (item) => [
  ...aClaim(item, 'pass-pin-setuprefused'),
  ...aWait(item, {
    _tag: 'SetupRefused',
    run: { runId: 'pass-pin-setuprefused' },
    step: 'prepared',
    action: 'install',
    why: 'npm install failed',
  }),
])

add('AnswerUnreadable', 'answerunreadable', (item) => [
  ...aClaim(item, 'pass-pin-answerunreadable'),
  // This variant (`step: 'review'`) only arises through `routedToReason`'s
  // `hold.when === 'findings'` branch — a `Routed` hold, same as
  // `ProposedEscalated` — so it reads `needs: 'judgement'` and `conduct.ts`
  // treats it as `stopped === null`: the request it writes names
  // `step: 'proposed', action: 'judge'` (never `'review'`/`'reviewer'`,
  // which are the failure's own step/action, not the request's — RUN_13b).
  approvalRequested(
    'pass-pin-answerunreadable',
    'proposed',
    'conductor:judge',
    "Merge agent/473 into main anyway? agent/473 into main is waiting on you. `review`'s findings could not be read at all: not json",
  ),
  ...aWait(item, {
    _tag: 'AnswerUnreadable',
    run: { runId: 'pass-pin-answerunreadable' },
    step: 'review',
    action: 'reviewer',
    raw: 'not json',
  }),
])

export const WAIT_FIXTURES: readonly WaitFixture[] = FIXTURES
