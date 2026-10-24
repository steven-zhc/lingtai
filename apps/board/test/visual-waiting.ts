/** Deterministic presentation data, folded from local wait events. */
import { decideRoute, offerFor, STEPS, type Envelope, type Finding, type Proposal, type Step } from '@lingtai/domain'
import { aClaim, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { TriageFacts, TriageResult, TriageStatus } from '@lingtai/domain/wait'
import { triageStatus } from '@lingtai/domain/wait'
import { createSqliteProjectionStore, openSqliteProjections } from '@lingtai/projector/sqlite'
import { taskViewProjection } from '@lingtai/projector/task-view'

import { toCard } from '@/lib/board'
import { describeHeld } from '@/lib/progress'
import {
  foldChat,
  foldRun,
  savedFixWork,
  standingOf,
  totalsOf,
  type Claim,
  type StandingView,
  type TaskDetail,
} from '@/lib/task'

import { WAIT_FIXTURES } from './waits.ts'

export const PREVIEW_NOW = Date.parse('2026-08-31T16:00:00.000Z')

const question = {
  id: 'approach',
  text: 'Which approach should the next pass take?',
  answers: [
    { id: 'small', text: 'Make the smaller change' },
    { id: 'broad', text: 'Change the shared interface' },
  ],
  recommended: 'small',
}

const advised = (cause: Extract<TriageResult, { _tag: 'TriageAdvised' }>['cause'], summary: string): TriageResult => ({
  _tag: 'TriageAdvised',
  cause,
  resolution: 'Requeue',
  summary,
  want: 'A maintainable fix that keeps the existing behavior.',
})

const HEAD = 'b'.repeat(40)
const FINDINGS: Finding[] = [
  {
    file: 'apps/board/src/lib/task.ts',
    line: 892,
    claim: 'A saved head is required before a fix round',
    failureScenario: 'A missing branch makes continuation impossible',
    severity: 'major',
  },
  {
    file: 'apps/board/src/app/standing.tsx',
    line: 544,
    claim: 'Advice must respect saved work',
    failureScenario: 'A recommendation can point at a disabled move',
    severity: 'major',
  },
  {
    file: 'apps/board/src/app/standing.tsx',
    line: 868,
    claim: 'The unavailable state needs a reason',
    failureScenario: 'A reader cannot tell why continuation is refused',
    severity: 'minor',
  },
  {
    file: 'apps/board/src/lib/progress.ts',
    line: 608,
    claim: 'The rail should retain all ten steps',
    failureScenario: 'An omitted step hides where the pass stopped',
    severity: 'minor',
  },
  {
    file: 'apps/board/src/lib/task.ts',
    line: 1428,
    claim: 'Missing spend stays unknown',
    failureScenario: 'An unmetered run reads as free',
    severity: 'minor',
  },
]

const FIXABLE_RESULT: TriageResult = {
  _tag: 'TriageAdvised',
  cause: { _tag: 'FixableLines', fixes: FINDINGS.map((f) => ({ path: f.file, line: f.line, what: f.claim })) },
  resolution: 'GrantFixRound',
  summary: 'Address the recorded findings on the saved branch, then run build and review again.',
  want: 'A fix round that keeps the current branch and checks the five findings.',
}

const FIXABLE_BODY = `| | |
|---|---|
| **Problem** | A waiting pass hides its review findings and saved branch state. |
| **Want** | The reader can compare the evidence and choose a possible next move. |
| **Fix** | Show the ten-step run, five findings, discussion, and available resolutions. |
| **Watch out** | A fix round requires a published head; missing spend must stay unknown. |

---

The review found five concrete cases. Continue the saved branch only when its published head is available.`

function fixableFixture(published: boolean) {
  const taskId = 'ticket-lingtai-393'
  const runId = 'pass-preview-393'
  const item = makeStream(taskId)
  const run = makeStream(runId)
  const chat = makeStream('chat-preview-393')
  const at = (minute: number) => ({ at: new Date(Date.parse('2026-08-31T13:00:00Z') + minute * 60_000) })
  const routed = (proposal: Proposal, spent: number, minute: number) => {
    const offer = offerFor(proposal, { rounds: 2, restarts: 1 }, { rounds: spent, restarts: 0 })
    const reply = { _tag: 'Selected' as const, candidate: 'fix-lines' as const, why: 'Fix the recorded findings' }
    return run('PassRouted', { runId, offer, reply, decision: decideRoute(offer, reply) }, at(minute))
  }
  const step = (
    name: Step,
    round: number,
    verdict: 'accepted' | 'refused',
    minute: number,
    findings: Finding[] = [],
  ) => [
    run('StepStarted', { runId, step: name, round }, at(minute)),
    run(
      'StepEnded',
      {
        runId,
        outcome: {
          step: name,
          round,
          actions: [
            {
              plugin: 'run',
              name,
              onSha: HEAD,
              evidence: verdict === 'refused' ? 'Review found five cases' : 'passed',
              yields: 'verdict',
              result: { _tag: 'Completed', assessment: { verdict, findings } },
            },
          ],
        },
      },
      at(minute + 1),
    ),
  ]
  const events: Envelope[] = [
    ...aClaim(item, runId),
    run(
      'RunStarted',
      {
        ticketId: taskId,
        runtime: 'claude-code',
        model: 'preview',
        promptVersion: 'ticket@393',
        baseSha: 'a'.repeat(40),
        configHash: 'preview',
        worktree: '/preview',
        invocation: { command: 'claude', args: [], tier: 'guarded', limits: { turns: 100, wallMs: 3_600_000 } },
      },
      at(0),
    ),
    run(
      'StepsResolved',
      {
        runId,
        configHash: 'preview',
        steps: STEPS.map((name) => ({ step: name, actions: name === 'design' ? [] : [name] })),
      },
      at(1),
    ),
    ...step('claim', 0, 'accepted', 2),
    ...step('admit', 0, 'accepted', 4),
    ...step('prepared', 0, 'accepted', 6),
    ...step('implement', 0, 'accepted', 8),
    ...step('build', 0, 'refused', 10),
    routed({ _tag: 'BuildRed', output: 'Build failed' }, 0, 11),
    ...step('implement', 1, 'accepted', 12),
    ...step('build', 1, 'accepted', 14),
    ...step('review', 1, 'refused', 16, FINDINGS),
    routed({ _tag: 'ReviewFindings', findings: FINDINGS }, 1, 17),
    ...step('implement', 2, 'accepted', 18),
    ...step('build', 2, 'accepted', 20),
    ...step('review', 2, 'refused', 22, FINDINGS),
    run('RunProducedDiff', { branch: 'agent/393', headSha: HEAD, files: 3, insertions: 42, deletions: 16 }, at(24)),
    run('RunProposedCompletion', { headSha: HEAD }, at(24)),
    run('RunFinished', { exitCode: 0, turns: 67, durationMs: 24 * 60_000 }, at(24)),
    ...(published
      ? [
          run(
            'RunRefsPublished',
            {
              branch: 'agent/393',
              arm: 'agent/393-attempt-1',
              headSha: HEAD,
              outcome: 'published',
              branchCarries: true,
              armSha: null,
              detail: null,
            },
            at(25),
          ),
        ]
      : []),
    ...(published
      ? [
          run(
            'StepEnded',
            {
              runId,
              outcome: {
                step: 'proposed',
                round: 2,
                actions: [
                  {
                    plugin: 'conductor',
                    name: 'conductor:judge',
                    onSha: HEAD,
                    evidence: '',
                    yields: 'signoff',
                    result: { _tag: 'Completed', requested: { question: 'Merge agent/393 into main anyway?' } },
                  },
                ],
              },
            },
            at(26),
          ),
        ]
      : []),
    item(
      'WaitStarted',
      {
        waitId: aWaitId(),
        reason: {
          _tag: 'ProposedEscalated',
          run: { runId },
          proposal: { _tag: 'ReviewFindings', findings: FINDINGS },
          because: { _tag: 'NotAsked' },
        },
      },
      at(27),
    ),
    chat(
      'DiscussionAsked',
      {
        ticketId: taskId,
        attempt: 1,
        by: 'human:steven',
        question: 'Can these findings be handled on the current branch?',
        reading: [
          published ? 'agent/393: saved review head' : 'agent/393: no published head recorded',
          'Five review findings remain after two rounds',
        ],
      },
      at(28),
    ),
    chat(
      'DiscussionAnswered',
      {
        text: published
          ? 'The findings are local to the saved branch. Keep its published head and rerun build and review after editing.'
          : 'The findings are local, but no published head is recorded. Publish or recover the branch before continuing saved work.',
        read: ['apps/board/src/lib/task.ts', 'apps/board/src/app/standing.tsx'],
        cannot: ['Whether the remote ref has moved since this snapshot'],
        proposal: null,
        turns: 5,
        durationMs: 180_000,
        failure: null,
      },
      at(31),
    ),
  ]
  return { tag: 'ProposedEscalated', name: published ? 'fixable-preview' : 'fixable-no-head-preview', taskId, events }
}

const FIXABLE_FIXTURES = [fixableFixture(true), fixableFixture(false)]

export const CASES = {
  'no-triage': { fixture: 'agentquestion', result: null, status: 'NotDeclared' },
  questions: {
    fixture: 'agentquestion',
    result: advised({ _tag: 'UndecidedQuestion', questions: [question] }, 'The next pass needs an approach decision.'),
  },
  'fixable-lines': {
    fixture: 'fixable-preview',
    result: FIXABLE_RESULT,
  },
  'fixable-lines-no-head': {
    fixture: 'fixable-no-head-preview',
    result: FIXABLE_RESULT,
  },
  'wrong-approach': {
    fixture: 'fixerdisagrees',
    result: advised({ _tag: 'WrongApproach' }, 'Patching the current approach will not converge.'),
  },
  disagreement: {
    fixture: 'proposedescalated-reviewfindings',
    result: advised({ _tag: 'WrongApproach' }, 'The approach needs to change before another pass.'),
    judgeWhy: 'The judge read the recorded finding as a local fix.',
  },
  'conflicting-hunks': {
    fixture: 'proposedescalated-mergeconflict',
    result: advised(
      {
        _tag: 'ConflictingHunks',
        total: 2,
        hunks: [
          { _tag: 'Mechanical', path: 'src/handler.ts', line: 42 },
          { _tag: 'Divergent', path: 'src/route.ts', line: 18, question },
        ],
      },
      'The branch and base made different choices.',
    ),
  },
  'ticket-too-big': {
    fixture: 'budgetexhausted',
    result: advised({ _tag: 'TicketTooBig' }, 'This ticket needs a smaller scope.'),
  },
  'setup-broken': {
    fixture: 'setuprefused',
    result: advised({ _tag: 'SetupBroken' }, 'The repository setup needs repair.'),
  },
  'triage-failed': {
    fixture: 'agentquestion',
    result: { _tag: 'TriageFailed', why: 'The response could not be read.' },
  },
  'triage-running': { fixture: 'agentquestion', result: null, status: 'Running' },
  'resolution-cards': {
    fixture: 'proposedescalated-reviewfindings',
    result: advised(
      { _tag: 'FixableLines', fixes: [{ path: 'src/check.ts', line: 12, what: 'Address the finding' }] },
      'A new pass can address the finding.',
    ),
  },
} as const

export type CaseName = keyof typeof CASES
export const CASE_NAMES = Object.keys(CASES) as CaseName[]

function split(taskId: string, events: readonly Envelope[]) {
  const own: Envelope[] = []
  const runs = new Map<string, Envelope[]>()
  for (const event of events) {
    if (event.streamId === taskId) own.push(event)
    else runs.set(event.streamId, [...(runs.get(event.streamId) ?? []), event])
  }
  return { own, runs }
}

export async function preview(name: CaseName) {
  const spec = CASES[name]
  const fixture = [...WAIT_FIXTURES, ...FIXABLE_FIXTURES].find((item) => item.name === spec.fixture)
  if (fixture === undefined) throw new Error(`Missing wait fixture: ${spec.fixture}`)

  const db = openSqliteProjections(':memory:')
  let row
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((context) => taskViewProjection.create(context))
    await store.transact((context) => taskViewProjection.apply(fixture.events, context))
    row = (await store.tasks({ retentionDays: 2 })).find((item) => item.taskId === fixture.taskId)
  } finally {
    db.close()
  }
  if (row === undefined) throw new Error(`Missing projected wait: ${name}`)

  const facts: TriageFacts = {
    started: 'status' in spec && spec.status === 'Running' ? { attempt: 1, at: new Date(PREVIEW_NOW) } : null,
    result: spec.result,
  }
  const representative = name === 'fixable-lines' || name === 'fixable-lines-no-head'
  const projected = {
    ...row,
    issue: representative ? '393' : '533',
    title: representative ? 'Show the waiting outcome for review findings' : 'Review a paused pass before continuing',
    kind: 'feature',
    triage: facts,
  }
  const { own, runs } = split(fixture.taskId, fixture.events)
  const runId = row.wait?.reason && 'run' in row.wait.reason ? row.wait.reason.run.runId : null
  // Some wait pins name a claimed run but omit its stream. Give those previews
  // a minimal run event so both production surfaces can draw the same rail.
  if (runId !== null && !runs.has(runId)) {
    runs.set(runId, [
      {
        ...fixture.events[0]!,
        streamId: runId,
        type: 'RunStarted',
        at: new Date(PREVIEW_NOW - 86_400_000),
        data: {
          ticketId: fixture.taskId,
          runtime: 'claude-code',
          model: 'preview',
          promptVersion: 'preview',
          baseSha: 'a'.repeat(40),
          configHash: 'preview',
          worktree: '/preview',
          invocation: null,
        },
      },
    ])
  }
  const chats = [...runs.entries()].filter(([id]) => id.startsWith('chat-'))
  for (const [id] of chats) runs.delete(id)
  const discussions = chats.map(([id, events]) => foldChat(id, events, null))
  const foldedRuns = [...runs.entries()].map(([runId, events], index) => {
    const claim: Claim = { runId, at: (events[0]?.at ?? new Date(0)).toISOString(), repair: false, released: null }
    return foldRun(claim, index + 1, events)
  })
  const standing = standingOf(own, foldedRuns)
  const previewStanding: StandingView =
    'judgeWhy' in spec && standing.reason?._tag === 'ProposedEscalated'
      ? {
          ...standing,
          reason: { ...standing.reason, because: { _tag: 'JudgeHandedOver' as const, why: spec.judgeWhy } },
        }
      : standing
  if (representative && standing.runId !== null) {
    // This inert preview uses its recorded published ref/head as the remote
    // answer; loadTask checks that ref again before offering a live move.
    previewStanding.fixWork = savedFixWork(standing.runId, runs.get(standing.runId) ?? [])
  }
  const progress = foldedRuns.find((run) => run.runId === standing.runId)?.progress ?? null
  const card = toCard(projected, null, progress)
  const status: TriageStatus =
    'status' in spec && spec.status === 'NotDeclared'
      ? { _tag: 'NotDeclared' }
      : triageStatus(standing.reason!, facts, { declared: true, daemonStartedAt: null })
  const ticket = {
    project: 'lingtai',
    ref: representative ? '393' : '533',
    title: projected.title,
    kind: 'feature',
    labels: ['feature'],
    url: null,
    body: representative ? FIXABLE_BODY : 'Review the paused pass and decide how work should continue.',
    found: true,
    askedGitHub: false,
    problem: null,
  }
  const task: TaskDetail = {
    taskId: fixture.taskId,
    unpushedMirror: null,
    standing: { ...previewStanding, triageStatus: status },
    want: spec.result?._tag === 'TriageAdvised' ? spec.result.want : null,
    ticket,
    runs: foldedRuns,
    discussions,
    outgoing: null,
    queued: null,
    held:
      representative && progress
        ? describeHeld({
            spent: progress.rounds.spent,
            granted: progress.granted,
            roundsOf: 2,
            restarts: 0,
            restartsOf: 1,
          })
        : null,
    totals: totalsOf(foldedRuns, discussions),
    spendCurrency: { lag: 0 },
    history: [],
  }
  return { card, task }
}
