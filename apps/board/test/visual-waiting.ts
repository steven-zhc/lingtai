/** Deterministic presentation data, folded from the same wait events as the unit pins. */
import type { Envelope } from '@lingtai/domain'
import type { TriageFacts, TriageResult, TriageStatus } from '@lingtai/domain/wait'
import { triageStatus } from '@lingtai/domain/wait'
import { createSqliteProjectionStore, openSqliteProjections } from '@lingtai/projector/sqlite'
import { taskViewProjection } from '@lingtai/projector/task-view'

import { toCard } from '@/lib/board'
import { foldRun, standingOf, totalsOf, type Claim, type TaskDetail } from '@/lib/task'

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

export const CASES = {
  'no-triage': { fixture: 'agentquestion', result: null, status: 'NotDeclared' },
  questions: {
    fixture: 'agentquestion',
    result: advised({ _tag: 'UndecidedQuestion', questions: [question] }, 'The next pass needs an approach decision.'),
  },
  'fixable-lines': {
    fixture: 'fixerdisagrees',
    result: advised(
      { _tag: 'FixableLines', fixes: [{ path: 'src/handler.ts', line: 42, what: 'Handle the empty result' }] },
      'One local change can address the finding.',
    ),
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
  const fixture = WAIT_FIXTURES.find((item) => item.name === spec.fixture)
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
  const projected = {
    ...row,
    issue: '533',
    title: 'Review a paused pass before continuing',
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
  const foldedRuns = [...runs.entries()].map(([runId, events], index) => {
    const claim: Claim = { runId, at: (events[0]?.at ?? new Date(0)).toISOString(), repair: false, released: null }
    return foldRun(claim, index + 1, events)
  })
  const standing = standingOf(own, foldedRuns)
  const previewStanding =
    'judgeWhy' in spec && standing.reason?._tag === 'ProposedEscalated'
      ? {
          ...standing,
          reason: { ...standing.reason, because: { _tag: 'JudgeHandedOver' as const, why: spec.judgeWhy } },
        }
      : standing
  const progress = foldedRuns.find((run) => run.runId === standing.runId)?.progress ?? null
  const card = toCard(projected, null, progress)
  const status: TriageStatus =
    'status' in spec && spec.status === 'NotDeclared'
      ? { _tag: 'NotDeclared' }
      : triageStatus(standing.reason!, facts, { declared: true, daemonStartedAt: null })
  const ticket = {
    project: 'lingtai',
    ref: '533',
    title: projected.title,
    kind: 'feature',
    labels: ['feature'],
    url: null,
    body: 'Review the paused pass and decide how work should continue.',
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
    discussions: [],
    outgoing: null,
    queued: null,
    held: null,
    totals: totalsOf(foldedRuns),
    spendCurrency: { lag: 0 },
    history: [],
  }
  return { card, task }
}
