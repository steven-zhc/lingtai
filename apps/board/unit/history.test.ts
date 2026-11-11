import { decideRoute, EVENTS, offerFor, STEPS, stripEvidence } from '@lingtai/domain'
import type { Action, Envelope, EventType, Finding, JudgeReply, PayloadOf, Proposal, WaitId } from '@lingtai/domain'
import { anOutcome, aResolution, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
/**
 * Every event type renders something, and the ones the ticket named render the
 * thing they carry.
 *
 * The first test is driven off `EVENTS` — the catalogue itself, not the list a
 * test happened to think of — so a forty-first type is covered the moment it is
 * added. That is the property #87 was about: `summarise` handled six types and
 * the other thirty-four fell to a default that printed the empty string, so
 * *what actually happened* was a column of timestamps and type names.
 *
 * It asserts against an **empty** payload on purpose. A formatter is allowed
 * not to recognise what it is given; it is not allowed to say nothing.
 */
import { describe, expect, it } from 'vitest'

import { summarise as summariseWith, toLine, type LineContext } from '../src/lib/history.ts'

/** `summarise` with an empty attempts map, which is right for every event that names none. */
const summarise = (event: Envelope, ctx: Partial<LineContext> = {}) =>
  summariseWith(event, { attempts: new Map(), ...ctx })

function e(type: string, data: unknown, actor = 'conductor', streamId = 'ticket-lingtai-59'): Envelope {
  return {
    seq: 1n,
    streamId,
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor,
    causation: null,
    at: new Date('2026-09-04T17:12:15Z'),
  }
}

const WAIT = 'wait-1' as WaitId
const RUN = 'pass-948f181b-7a61-4047-9df6-efd4055de687'
const SHA = 'a'.repeat(40)
const ONE_ACTION: Action = {
  plugin: 'agent',
  name: 'cold reviewer',
  onSha: SHA,
  evidence: 'exit 1',
  yields: 'verdict',
  result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
}
const BUILD_RED: Proposal = { _tag: 'BuildRed', output: 'tsc failed' }
const NOT_ASKED = offerFor(BUILD_RED, { rounds: 0, restarts: 0 }, { rounds: 0, restarts: 0 })
const ADVISED: PayloadOf<'WaitTriaged'>['result'] = {
  _tag: 'TriageAdvised',
  cause: { _tag: 'FixableLines', fixes: [] },
  resolution: 'EditBodyAndRequeue',
  summary: 'One edit remains',
  want: null,
}
const USAGE = [{ model: 'claude-opus-5-5', tokens: { fresh: 10, output: 20 } }]
const ISSUE_CHANGE = { project: 'lingtai', issue: '59', change: 'labels' as const, detail: 'lingtai:working' }

/**
 * **A schema-valid sample of every type in the catalogue**, and more than one
 * where the shape changes what the sentence has to say. The record is total over
 * `EventType` and that is the point: a new event type is a red typecheck *here*
 * and nowhere in the board's source, which is what lets `FORMAT` stay `Partial`
 * (`history.ts`, rule 3) without the renderer being allowed to fall behind.
 *
 * Three of these are the payloads that threw: a `StepStarted` (no `action`), a
 * `StepEnded` with `actions: []`, and a `TriageStarted` whose `model` is `""`.
 */
const SAMPLES = {
  TicketDiscovered: [
    { project: 'lingtai', source: 'github-issue', externalRef: '59', title: 'a race', kind: 'bug', labels: ['bug'] },
  ],
  TicketClaimed: [{ runId: RUN, worker: 'conductor:1', title: null, kind: null }],
  TicketContinued: [{ runId: RUN, worker: 'conductor:1' }],
  TicketReleased: [
    { runId: RUN, reason: 'the pass did not finish', cause: null },
    { runId: RUN, reason: 'restart', cause: { _tag: 'Restart', restart: 1 } },
  ],
  WaitStarted: [{ waitId: WAIT, reason: { _tag: 'OwnQuestion', question: 'which one?', by: 'human:steven' } }],
  WaitResolved: [{ waitId: WAIT, by: 'human:steven', resolution: { _tag: 'Requeue' }, note: '' }],
  TicketSplit: [
    {
      waitId: WAIT,
      children: [
        { key: 'a', number: 161, id: 5_000_000_161 },
        { key: 'b', number: 162, id: 5_000_000_162 },
      ],
      blockedBy: [{ ticket: 'b', blockedBy: 'a' }],
    },
  ],
  SplitStarted: [
    {
      waitId: WAIT,
      plan: { children: [{ key: 'a', title: 'first', body: 'do it', kind: 'bug' }], blockedBy: [] },
      instance: 'conductor:1',
    },
  ],
  SplitChildWritten: [{ waitId: WAIT, key: 'a', number: 161, id: 5_000_000_161 }],
  SplitLinkWritten: [{ waitId: WAIT, ticket: 'b', blockedBy: 'a' }],
  SplitFailed: [{ waitId: WAIT, step: 'write-children', detail: 'GitHub refused' }],
  TicketLinked: [{ relation: 'follows-up', otherRef: '58' }],
  TicketLanded: [{ mergeCommit: SHA, base: 'main' }],
  TicketClosed: [{ by: 'human:steven', reason: 'no longer wanted' }],
  DispatchRefused: [{ requiredTier: 'sandboxed', runtime: 'codex', missing: ['sandbox'] }],
  RunStarted: [
    {
      ticketId: 'ticket-lingtai-59',
      runtime: 'claude-code',
      model: 'opus-5',
      promptVersion: 'ticket@1911',
      baseSha: SHA,
      configHash: 'b'.repeat(40),
      worktree: `/Users/steven/.lingtai/worktrees/lingtai/${RUN}`,
      invocation: null,
    },
  ],
  RunPrompted: [{ promptVersion: 'ticket@1911', bytes: 4593, prompt: null }],
  RunTouchedFile: [
    { path: `/Users/steven/.lingtai/worktrees/lingtai/${RUN}/apps/board/src/lib/history.ts`, op: 'edit' },
    { path: '/tmp/elsewhere.ts', op: 'delete' },
  ],
  RunContextExhausted: [{ turn: 12 }],
  RunAwaitingInput: [{ prompt: 'which branch?' }],
  RunProducedDiff: [{ branch: 'agent/59', headSha: SHA, files: 1, insertions: 3, deletions: 1 }],
  RunRefsPublished: [
    { branch: 'agent/59', arm: 'agent/59-attempt-1', headSha: SHA, outcome: 'published', detail: null },
  ],
  RunKeptUncommitted: [
    {
      arm: 'agent/59-attempt-1',
      sha: SHA,
      parentSha: SHA,
      stoppedBy: 'timeout',
      files: 1,
      insertions: 1,
      deletions: 0,
    },
  ],
  RunProposedCompletion: [{ headSha: SHA }],
  RunFinished: [{ exitCode: 0, turns: 3, durationMs: 1000 }],
  RunFailed: [{ kind: 'timeout', detail: 'the wall was hit' }],
  RunSpent: [
    {
      for: { _tag: 'Action', step: 'implement', name: 'write the change', round: 0 },
      runtime: 'claude-code',
      turns: 2,
      durationMs: 13_537,
      usage: USAGE,
      costUsd: 0.729924,
    },
    {
      for: { _tag: 'Judge', when: 'findings' },
      runtime: 'claude-code',
      turns: 1,
      durationMs: 900,
      usage: [],
      costUsd: null,
    },
    {
      for: { _tag: 'Triage', waitId: WAIT },
      runtime: 'claude-code',
      turns: 2,
      durationMs: 13_537,
      usage: USAGE,
      costUsd: 0.1,
    },
    { for: { _tag: 'Discussion' }, runtime: 'codex', turns: 1, durationMs: 2000, usage: [], costUsd: 0 },
  ],
  RecipeRecorded: [{ configHash: 'c'.repeat(64), recipe: { version: 2 } }],
  StepsResolved: [{ runId: RUN, configHash: 'c'.repeat(40), steps: STEPS.map((step) => ({ step, actions: [] })) }],
  EndActionsResolved: [
    { outcome: 'landed', actions: [{ name: 'comment', labels: ['done'] }] },
    { outcome: 'closed', actions: [] },
  ],
  StepStarted: [{ runId: RUN, step: 'build', round: 0 }],
  StepEnded: [
    { runId: RUN, outcome: anOutcome('review', 0, [ONE_ACTION]) },
    { runId: RUN, outcome: anOutcome('prepared', 0, []) },
  ],
  FindingAccepted: [{ project: 'lingtai', key: 'k1', by: 'human:steven', kind: 'bug', labels: ['bug'] }],
  FindingProposed: [{ project: 'lingtai', key: 'k1', by: 'agent:' + RUN, externalRef: '60', url: null }],
  FindingDeclined: [{ project: 'lingtai', key: 'k1', by: 'human:steven', reason: 'not a bug' }],
  MergeLaneWaited: [{ behind: { runId: RUN, issue: 'agent/58' } }],
  IntegrationAttempted: [{ ticketId: 'ticket-lingtai-59', branch: 'agent/59', headSha: SHA }],
  IntegrationRefused: [{ ticketId: 'ticket-lingtai-59', branch: 'agent/59', reason: 'conflict', detail: 'a.ts' }],
  IntegrationSucceeded: [{ ticketId: 'ticket-lingtai-59', branch: 'agent/59', base: 'main', mergeCommit: SHA }],
  BaseChecked: [
    {
      base: 'main',
      baseSha: SHA,
      command: 'pnpm test',
      ok: true,
      exitCode: 0,
      durationMs: 5,
      evidence: '',
      runId: RUN,
    },
    {
      base: 'main',
      baseSha: SHA,
      command: 'pnpm test',
      ok: false,
      exitCode: 1,
      durationMs: 5,
      evidence: 'red',
      runId: RUN,
    },
  ],
  PassRouted: [
    {
      runId: RUN,
      offer: NOT_ASKED,
      reply: { _tag: 'NotAsked' },
      decision: decideRoute(NOT_ASKED, { _tag: 'NotAsked' }),
    },
  ],
  ProposalRouted: [
    {
      runId: RUN,
      offer: { ...NOT_ASKED, ended: null },
      reply: { _tag: 'NotAsked' },
      decision: decideRoute(NOT_ASKED, { _tag: 'NotAsked' }),
    },
  ],
  ConductorPaused: [{ by: 'human:steven', reason: 'maintenance', until: null, holdsAcrossStarts: false }],
  ConductorResumed: [{ by: 'human:steven' }],
  ConductorShutdownRequested: [{ by: 'human:steven', reason: 'picking up #88', timeoutMs: null, force: false }],
  ConductorStarted: [
    { by: 'daemon', reason: null, sha: SHA, dirty: false, worker: 'h:1', handoff: null },
    { by: 'daemon', reason: null, sha: null, dirty: true, worker: 'h:1', handoff: null },
  ],
  ConductorShutdownWithdrawn: [{ by: 'human:steven', version: 1, reason: 'changed my mind', handoff: null }],
  OutboxDelivered: [{ ref: 'r1', kind: 'comment', target: 'lingtai#59', detail: '' }],
  OutboxFailed: [{ ref: 'r1', kind: 'comment', target: 'lingtai#59', error: 'boom', permanent: false }],
  IssueUpdated: [ISSUE_CHANGE],
  IssueUpdateFailed: [{ project: 'lingtai', issue: '59', change: 'labels', error: 'boom' }],
  QueueChanged: [{ project: 'lingtai', reason: 'a ticket was labelled', delivery: 'webhook' }],
  RunRequested: [{ project: 'lingtai', issue: '59', by: 'human:steven' }],
  ContinueRequested: [{ project: 'lingtai', issue: '59', runId: RUN, by: 'human:steven' }],
  DiscussionRequested: [
    { chatId: 'chat-1', ticketId: 'ticket-lingtai-59', attempt: 1, question: 'why?', by: 'human:steven' },
  ],
  DiscussionAsked: [
    { ticketId: 'ticket-lingtai-59', attempt: null, by: 'human:steven', question: 'why?', reading: [] },
  ],
  DiscussionAnswered: [
    { text: 'because', read: ['a.ts'], cannot: [], proposal: null, turns: 1, durationMs: 1, failure: null },
  ],
  DiscussionHeld: [{ chatId: 'chat-1', outcome: 'ticket', by: 'human:steven' }],
  PromptEdited: [
    { text: 'also do x', hash: null, by: 'human:steven', basedOn: null, chatId: null },
    { text: '', hash: null, by: 'human:steven', basedOn: null, chatId: null },
  ],
  ProjectOnboardingStarted: [{ slug: 'lingtai', base: 'main', by: 'human:steven' }],
  ProjectConfigured: [{ project: 'lingtai', owner: null, base: null, configHash: 'c'.repeat(40), fromSha: SHA }],
  ProjectRefused: [{ project: 'lingtai', detail: 'no recipe', ref: null, codeSha: null }],
  ProjectRecovered: [{ project: 'lingtai', ref: null, codeSha: null }],
  ProjectPaused: [{ project: 'lingtai', by: 'human:steven' }],
  ProjectResumed: [{ project: 'lingtai', by: 'human:steven' }],
  Reconciled: [{ findings: [{ stream: 'ticket-lingtai-59', expected: 'a', actual: 'b', action: 'released' }] }],
  GitHubAppCreated: [{ appId: '123', slug: 'lingtai-app' }],
  TriageStarted: [
    { waitId: WAIT, attempt: 1, by: { _tag: 'Agent', runtime: 'claude-code', model: 'opus-5' } },
    { waitId: WAIT, attempt: 1, by: { _tag: 'Agent', runtime: 'claude-code', model: '' } },
    { waitId: WAIT, attempt: 2, by: { _tag: 'Mechanical' } },
  ],
  WaitTriaged: [
    {
      waitId: WAIT,
      attempt: 1,
      headSha: SHA,
      result: ADVISED,
      by: { _tag: 'Agent', runtime: 'claude-code', model: 'opus-5' },
    },
    {
      waitId: WAIT,
      attempt: 1,
      headSha: SHA,
      result: { _tag: 'TriageFailed', why: 'no answer' },
      by: { _tag: 'Mechanical' },
    },
  ],
  PluginFailed: [{ name: 'notify', eventType: 'TicketLanded', project: null, reason: 'boom' }],
} satisfies { [K in EventType]: PayloadOf<K>[] }

describe('a line of history', () => {
  it('uses the readable cause in triage history', () => {
    const said = summarise(
      e('WaitTriaged', {
        attempt: 2,
        result: {
          _tag: 'TriageAdvised',
          cause: { _tag: 'FixableLines', fixes: [] },
          resolution: 'Requeue',
          summary: 'One edit remains',
          want: null,
        },
      }),
    )
    expect(said).toContain('Lines to fix')
    expect(said).toContain('Start over from base')
    expect(said).not.toContain('FixableLines')
    expect(said).not.toContain('Requeue')
  })

  /**
   * **Every type in the catalogue has a sentence, and none of them is the
   * fallback** (#887). A key in `FORMAT` is not enough: three formatters existed
   * and threw on ordinary payloads (`StepStarted`, a `StepEnded` with no actions,
   * a `TriageStarted` with `model: ""`), so the commonest rows fell back anyway.
   * Each sample is parsed through the type's own schema first, so a sample that
   * drifts from the catalogue fails here and not as a formatter that "works".
   */
  it('says a sentence for a schema-valid sample of every type in the catalogue', () => {
    const types = Object.keys(EVENTS) as EventType[]
    expect(Object.keys(SAMPLES).sort()).toEqual([...types].sort())
    for (const type of types) {
      for (const sample of SAMPLES[type] as unknown[]) {
        const data = EVENTS[type].parse(sample)
        const said = summarise(e(type, data, 'conductor', RUN), {
          attempts: new Map([[RUN, 1]]),
          branch: 'agent/59',
        })
        const label = `${type} with ${JSON.stringify(sample)}`
        expect(said, label).not.toBe('')
        expect(said, label).not.toMatch(/^recorded /)
        expect(said, label).not.toMatch(/\w=/)
        expect(said, label).not.toContain('{"')
      }
    }
  })

  /**
   * A formatter that throws must still never break the page, and what it says
   * instead points at the fields rather than printing them (#887).
   */
  it('says that it recorded the type, and not the payload, when no sentence can be built', () => {
    const fallback = (type: string) => `recorded ${type}; open for its fields`
    for (const type of Object.keys(EVENTS)) {
      for (const data of [{}, null, { of: 'an unexpected shape' }]) {
        const said = summarise(e(type, data))
        expect(said, `${type} with ${JSON.stringify(data)}`).not.toBe('')
        expect(said, `${type} with ${JSON.stringify(data)}`).not.toMatch(/\w=/)
      }
    }
    expect(summarise(e('WaitStarted', {}))).toBe(fallback('WaitStarted'))
    expect(summarise(e('RunPrompted', null))).toBe(fallback('RunPrompted'))
  })

  it('falls back to a sentence that points into the open row for a type no formatter has learned', () => {
    // Not in the catalogue at all — the case a renderer is always one commit
    // away from, and the one that used to render as a blank row.
    const said = summarise(e('SomethingNobodyHasWrittenYet', { thing: 'happened', n: 3 }))
    expect(said).toBe('recorded SomethingNobodyHasWrittenYet; open for its fields')
  })

  /** The rows #698's Ticket tab showed as `key=value` and JSON, with the payloads shaped as they were. */
  describe('the rows #698 showed as fields', () => {
    const attempts = new Map([[RUN, 1]])
    const line = (event: Envelope) => toLine(event, { attempts })
    const WORKTREE = `/Users/steven/.lingtai/worktrees/lingtai/${RUN}`

    it('says who claimed, as an attempt and not as a run id', () => {
      const claimed = line(e('TicketClaimed', { runId: RUN, worker: 'conductor:1', title: null, kind: null }))
      expect(claimed.summary).toBe('Attempt 1 claimed')
      expect(claimed.summary).not.toMatch(/pass-|run [0-9a-f]{8}/)
      expect(
        summarise(e('TicketClaimed', { runId: RUN, worker: 'w', title: null, kind: null }), {
          attempts,
          claim: 'continuation',
        }),
      ).toBe('Attempt 1 continued')
    })

    it('names an attempt of another ticket without printing its id', () => {
      const other = line(e('TicketClaimed', { runId: 'pass-other-ticket', worker: 'w', title: null, kind: null }))
      expect(other.summary).toBe('an attempt of another ticket claimed')
      expect(other.summaryTitle).toBe('pass-other-ticket')
    })

    it('says triage run N for an agent and triage N (mechanical) for the other arm, never Attempt N', () => {
      const agent = line(
        e('TriageStarted', { waitId: 'w', attempt: 1, by: { _tag: 'Agent', runtime: 'claude-code', model: '' } }),
      )
      expect(agent.summary).toBe('Triage run 1 started (claude-code)')
      const mechanical = line(e('TriageStarted', { waitId: 'w', attempt: 2, by: { _tag: 'Mechanical' } }))
      expect(mechanical.summary).toBe('Triage 2 (mechanical) started')
      expect(`${agent.summary} ${mechanical.summary}`).not.toContain('Attempt')
      expect(agent.who).toBe('triage')
    })

    it('prints the money of a RunSpent as a bill, and an unknown cost as unknown', () => {
      const judge = {
        for: { _tag: 'Triage', waitId: 'w' },
        runtime: 'claude-code',
        turns: 2,
        durationMs: 13537,
        usage: [{ model: 'claude-opus-5-5', tokens: { fresh: 1 } }],
      }
      const spent = line(e('RunSpent', { ...judge, costUsd: 0.729924 }))
      expect(spent.summary).toBe('Triage: 2 turns, 13.5 s · cost $0.73')
      expect(spent.summary).not.toContain('{"')
      expect(line(e('RunSpent', { ...judge, costUsd: null })).summary).toContain('cost unknown')
      expect(line(e('RunSpent', { ...judge, costUsd: null })).summary).not.toContain('$0.00')
      expect(spent.who).toBe('triage')
      expect(line(e('RunSpent', { ...judge, for: { _tag: 'Judge', when: 'findings' }, costUsd: 1 })).who).toBe(
        'the judge',
      )
    })

    it("names the move a triage advised by the board's own title for it", () => {
      const advised = line(
        e('WaitTriaged', {
          waitId: 'w',
          attempt: 1,
          headSha: 'abc',
          by: { _tag: 'Agent', runtime: 'claude-code', model: 'opus-5' },
          result: {
            _tag: 'TriageAdvised',
            cause: { _tag: 'UndecidedQuestion' },
            resolution: 'EditBodyAndRequeue',
            summary: 'Held because the body is silent',
            want: null,
          },
        }),
      )
      expect(advised.summary).toContain('Triage run 1 advised: Add to the ticket and start over')
      expect(advised.summary).not.toContain('EditBodyAndRequeue')
      expect(advised.summary).not.toContain('Attempt')
    })

    it('shows a touched path relative to the repository, and leaves another path alone', () => {
      const inside = line(
        e('RunTouchedFile', { path: `${WORKTREE}/apps/board/src/x.ts`, op: 'edit' }, 'agent:' + RUN, RUN),
      )
      expect(inside.summary).toBe("Attempt 1's agent edited apps/board/src/x.ts")
      expect(inside.summary).not.toContain('/worktrees/')
      expect(line(e('RunTouchedFile', { path: '/tmp/x.ts', op: 'write' }, 'agent:' + RUN, RUN)).summary).toContain(
        '/tmp/x.ts',
      )
    })

    it('says the actor in words', () => {
      expect(line(e('RunPrompted', { promptVersion: 'v', bytes: 1, prompt: null }, 'agent:' + RUN, RUN)).who).toBe(
        "Attempt 1's agent",
      )
      expect(line(e('TicketClosed', { by: 'human:steven', reason: 'x' }, 'human:steven')).who).toBe('steven')
      expect(line(e('QueueChanged', { project: 'p', reason: 'r', delivery: 'd' })).who).toBe('conductor')
      expect(line(e('DiscussionHeld', { chatId: 'c', outcome: 'none', by: 'human:steven' })).who).toBe('a discussion')
      expect(
        line(e('RunPrompted', { promptVersion: 'v', bytes: 1, prompt: null }, 'agent:pass-zzz', 'pass-zzz')).who,
      ).toBe('an agent of another ticket')
    })
  })

  /**
   * A requeue's note is optional (#424), and `WorkItemUnblocked.note` can be
   * `""` on the real log now — rendered without a dangling colon, which is
   * what `${by}: ${note}` would leave behind for an empty one.
   */
  it('renders a note-free unblock as just who, with no trailing colon', () => {
    const itemStream = makeStream('ticket-lingtai-59')
    const said = summarise(aResolution(itemStream, aWaitId(), { _tag: 'Requeue' }, 'human:steven', '')[0]!)
    expect(said).toBe('human:steven')

    const withNote = summarise(
      aResolution(itemStream, aWaitId(), { _tag: 'Requeue' }, 'human:steven', 'main has moved')[0]!,
    )
    expect(withNote).toBe('human:steven: main has moved')
  })

  /**
   * **Where a route landed on a person, since `#502` changed what the event
   * stores.** `PassRouted` carries `{offer, reply, decision}` now, not the
   * five derived fields this row used to print — a route that bought a round
   * or spent a restart is read through `boardFactOf`'s own `RoundOpened`/
   * `Restarted` facts, so `history.ts`'s own `FORMAT.PassRouted` entry is
   * only ever reached for the remaining case, `routeNext` answering
   * `WaitOnPerson`. Two ways there: no judge declared (`NotAsked`), and a
   * judge choosing a candidate a spent ceiling had already excluded.
   *
   * **The subject comes from `groupHistory`'s own reading of `RunStarted`**
   * (`#505`), not from this event — `PassRouted` sits on the run's stream,
   * which has no ticket id of its own, so the branch is the second argument
   * a caller supplies, same as `boardFactOf` supplies it from the item
   * stream.
   */
  it('says where a route went, when it lands on a person', () => {
    const buildRed: Proposal = { _tag: 'BuildRed', output: 'tsc failed' }
    const notAsked = offerFor(buildRed, { rounds: 0, restarts: 0 }, { rounds: 0, restarts: 0 })
    const said = summarise(
      e('PassRouted', {
        runId: 'pass-1',
        offer: notAsked,
        reply: { _tag: 'NotAsked' },
        decision: decideRoute(notAsked, { _tag: 'NotAsked' }),
      }),
      { branch: 'agent/7' },
    )
    expect(said).toContain('build → waiting')
    expect(said).toContain('agent/7 is waiting on you')
    expect(said).toContain('tsc failed')

    const reviewFindings: Proposal = {
      _tag: 'ReviewFindings',
      findings: [{ file: 'x.ts', line: 1, claim: 'no', failureScenario: 'it breaks', severity: 'blocker' }],
    }
    const spent = offerFor(reviewFindings, { rounds: 1, restarts: 1 }, { rounds: 1, restarts: 1 })
    const reply: JudgeReply = { _tag: 'Selected', candidate: 'restart', why: 'start over' }
    const said2 = summarise(
      e('PassRouted', { runId: 'pass-1', offer: spent, reply, decision: decideRoute(spent, reply) }),
      { branch: 'agent/7' },
    )
    expect(said2).toContain('review → waiting')
    expect(said2).toContain('agent/7 is waiting on you')
    expect(said2).toContain('restarts` is spent')
  })

  /**
   * **A route reads the same stored whole and stored by reference** (#932). The
   * pair is one route: the `ProposalRouted` is the `PassRouted` put through the
   * writer's own `stripEvidence`, with the `StepEnded` it names on the stream.
   */
  it('reads a route the same whether it kept its evidence or names its StepEnded', () => {
    const output = 'tsc failed: 3 errors'
    const buildRed: Proposal = { _tag: 'BuildRed', output }
    const offer = offerFor(buildRed, { rounds: 0, restarts: 0 }, { rounds: 0, restarts: 0 })
    const reply: JudgeReply = { _tag: 'NotAsked' }
    const decision = decideRoute(offer, reply)
    const outcome = {
      step: 'build',
      round: 0,
      actions: [
        {
          plugin: 'run',
          name: 'tests',
          onSha: SHA,
          evidence: output,
          yields: 'verdict',
          result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
        },
      ],
    } as never
    const whole = summarise(e('PassRouted', { runId: 'pass-1', offer, reply, decision }), { branch: 'agent/7' })
    const byReference = e('ProposalRouted', {
      runId: 'pass-1',
      offer: { ...offer, proposal: stripEvidence(buildRed), ended: { version: 3, action: 'tests' } },
      reply,
      decision,
    })
    expect(whole).toContain('tsc failed')
    expect(summarise(byReference, { branch: 'agent/7', endedAt: (v) => (v === 3 ? outcome : undefined) })).toBe(whole)

    // Its StepEnded is not in the slice: the move is said, the evidence is said to be missing, nothing throws.
    const missing = summarise(byReference, { branch: 'agent/7', endedAt: () => undefined })
    expect(missing).toContain('build → waiting')
    expect(missing).toContain('version 3')
    expect(missing).not.toContain('no findings')
  })

  it('names the missing StepEnded version for a fix-round and for a restart route', () => {
    const f = { _tag: 'ReviewFindings' as const }
    const base = { ...offerFor({ ...f, findings: [] }, { rounds: 0, restarts: 0 }, { rounds: 0, restarts: 0 }) }
    const route = (candidate: string, next: object) => {
      const offer = {
        ...base,
        proposal: f,
        available: [{ id: candidate, next }, ...base.available.filter((c) => c.id === 'hand-to-person')],
        ended: { version: 9, action: 'cold' },
      } as never
      return e('ProposalRouted', {
        runId: 'pass-1',
        offer,
        reply: { _tag: 'Selected', candidate, why: 'w' },
        decision: { _tag: 'Selected', candidate },
      })
    }
    const fix = route('fix-lines', { _tag: 'FixRound', to: 'implement', round: 1 })
    expect(summarise(fix, { branch: 'agent/7', endedAt: () => undefined })).toContain(
      'round 1 — findings not found (StepEnded version 9)',
    )
    const restart = route('restart', { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } })
    expect(summarise(restart, { branch: 'agent/7', endedAt: () => undefined })).toContain(
      'restart 1 — evidence not found (StepEnded version 9)',
    )
  })

  /**
   * **No branch, no subject — the fallback is the payload, never a sentence
   * that opens on nothing** (#505, rule 2). `groupHistory` always has one by
   * the time it reaches a `PassRouted`, because `RunStarted` is the first
   * event on every run stream; a caller with none is the case this guards.
   */
  it('falls back to the payload for a routed wait with no branch to open on', () => {
    const buildRed: Proposal = { _tag: 'BuildRed', output: 'tsc failed' }
    const notAsked = offerFor(buildRed, { rounds: 0, restarts: 0 }, { rounds: 0, restarts: 0 })
    const said = summarise(
      e('PassRouted', {
        runId: 'pass-1',
        offer: notAsked,
        reply: { _tag: 'NotAsked' },
        decision: decideRoute(notAsked, { _tag: 'NotAsked' }),
      }),
    )
    expect(said).toBe('recorded PassRouted; open for its fields')
  })

  /** A copy with no checkout records `sha: null`, which the schema allows. */
  it('says who started a conductor with no recorded commit, rather than the raw payload', () => {
    const said = summarise(
      e('ConductorStarted', { by: 'daemon', reason: null, sha: null, dirty: false, worker: 'h:1', handoff: null }),
    )
    expect(said).toBe('daemon started an unrecorded commit')
  })

  /**
   * **The two silent outcomes get a sentence, or the silence is back on the
   * page** (`#251`).
   *
   * `#250` left no ref and no account of why, and the row that would have said
   * so is this one. A `RunRefsPublished` rendering as a bare `—` would put a
   * reader back where that incident left them, so the four outcomes are four
   * sentences — and a refusal says the head, because that is what says whether
   * there is anything still to rescue.
   */
  it('says what a claim left on origin, including when it left nothing', () => {
    const row = (data: Record<string, unknown>) =>
      summarise(e('RunRefsPublished', { branch: 'agent/250', arm: 'agent/250-attempt-1', ...data }))

    expect(row({ outcome: 'published', headSha: 'a'.repeat(40), detail: null })).toContain(
      'agent/250 and agent/250-attempt-1 at aaaaaaa',
    )
    expect(row({ outcome: 'already-published', headSha: 'a'.repeat(40), detail: null })).toContain('already there')
    expect(row({ outcome: 'nothing-committed', headSha: null, detail: null })).toBe(
      'nothing committed, so no ref was left',
    )
    // With a head: there are commits behind the refusal, so there is something
    // to go and get.
    expect(row({ outcome: 'refused', headSha: 'a'.repeat(40), detail: 'stale info' })).toBe(
      'agent/250 at aaaaaaa was not pushed: stale info',
    )
    // Without one: the `rev-parse` itself failed and nothing is known to exist.
    expect(row({ outcome: 'refused', headSha: null, detail: 'not a git repository' })).toBe(
      'agent/250 was not pushed, and no head was read: not a git repository',
    )
    // Both halves, because they are opposite: the branch is somebody else's
    // and the arm is this run's work, on origin, fetchable.
    expect(row({ outcome: 'arm-only', headSha: 'a'.repeat(40), detail: 'stale info' })).toBe(
      'agent/250 was not pushed: stale info — agent/250-attempt-1 at aaaaaaa is there',
    )
    // The refs went and the record did not, so the row above this one on the
    // page says the opposite of what a reader needs to act on (`#252`).
    expect(
      row({
        outcome: 'unrecorded',
        headSha: 'a'.repeat(40),
        detail: 'agent/250 — the connection is closed, and again — the connection is closed',
      }),
    ).toBe(
      'aaaaaaa is on origin and nothing records it: agent/250 — the connection is closed, and again — the connection is closed',
    )
  })

  /**
   * **`published`/`already-published` never name `branch` beside a sha it was
   * never pushed** (`#468`). `branchCarries` is the typed field that says so
   * — never whether `detail` happens to be set, since a failed WIP keep also
   * writes `detail` on these two outcomes while `branch` was pushed at
   * exactly `headSha`.
   */
  it('never says branch and arm share a sha the branch never got', () => {
    const row = (data: Record<string, unknown>) =>
      summarise(e('RunRefsPublished', { branch: 'agent/7', arm: 'agent/7-attempt-1', ...data }))

    expect(row({ outcome: 'published', headSha: 'c'.repeat(40), detail: null, branchCarries: false })).toBe(
      'agent/7-attempt-1 at ccccccc',
    )
    expect(row({ outcome: 'already-published', headSha: 'c'.repeat(40), detail: null, branchCarries: false })).toBe(
      'already there — agent/7-attempt-1 at ccccccc',
    )
  })

  /**
   * **A failed WIP keep's `detail` on `published`/`already-published` is not
   * `branch`'s absence** (`#468`) — `branchCarries` stays `true` because
   * `branch` was pushed at exactly `headSha`, and the row names both refs
   * alongside the keep's own failure.
   */
  it('names both refs when a WIP keep failed but branch still carries the sha', () => {
    const row = (data: Record<string, unknown>) =>
      summarise(e('RunRefsPublished', { branch: 'agent/7', arm: 'agent/7-attempt-1', ...data }))

    const detail = 'the dirty tree was not kept — git commit failed: disk full'
    expect(row({ outcome: 'published', headSha: 'c'.repeat(40), detail, branchCarries: true })).toBe(
      `agent/7 and agent/7-attempt-1 at ccccccc — ${detail}`,
    )
  })

  /**
   * **A kept WIP sits on the arm one commit ahead of what `branch` carries,
   * and the row must not say the two refs share a sha** (`#468`). `armSha` is
   * the field that says the arm's own head differs from `headSha`; without
   * it the row before this fix read `agent/7 and agent/7-attempt-1 at
   * bbbbbbb` though the arm was actually at `ccccccc` — a sentence a person
   * fetching `agent/7-attempt-1` would find false.
   */
  it('names the arm at its own later sha when a kept WIP sits ahead of what branch carries', () => {
    const row = (data: Record<string, unknown>) =>
      summarise(e('RunRefsPublished', { branch: 'agent/7', arm: 'agent/7-attempt-1', ...data }))

    expect(
      row({
        outcome: 'published',
        headSha: 'b'.repeat(40),
        armSha: 'c'.repeat(40),
        detail: null,
        branchCarries: true,
      }),
    ).toBe('agent/7 at bbbbbbb and agent/7-attempt-1 at ccccccc')

    expect(
      row({
        outcome: 'already-published',
        headSha: 'b'.repeat(40),
        armSha: 'c'.repeat(40),
        detail: null,
        branchCarries: true,
      }),
    ).toBe('already there — agent/7 at bbbbbbb and agent/7-attempt-1 at ccccccc')
  })

  /**
   * **Absent `branchCarries` means carried** (`#468`) — every row written
   * before this field existed had `branch` at `headSha`, and replaying one
   * must read exactly as it always did.
   */
  it('reads an old row with no branchCarries field as branch carrying the sha', () => {
    const row = (data: Record<string, unknown>) =>
      summarise(e('RunRefsPublished', { branch: 'agent/7', arm: 'agent/7-attempt-1', ...data }))

    expect(row({ outcome: 'published', headSha: 'c'.repeat(40), detail: null })).toBe(
      'agent/7 and agent/7-attempt-1 at ccccccc',
    )
  })

  /**
   * The two kinds of block, told apart on the row (#83). `held at the merge
   * gate: …` and `conflict: agent/112 does not merge into develop: …` were both
   * `WorkItemBlocked` with a string, and the history printed the string.
   */
  it('says which kind of block it was, and what it recommends', () => {
    const itemStream = makeStream('ticket-lingtai-59')
    const [blocked] = aWait(itemStream, {
      _tag: 'MergeRefused',
      run: { runId: 'pass-1' },
      reason: 'no-commits',
      raw: 'agent/112 holds nothing main does not.',
    })
    const said = summarise(blocked!)
    expect(said).not.toContain('acknowledgement:')
    expect(said).toContain('no-commits: agent/112 holds nothing main does not.')
    expect(said).toContain('recommends requeue')
  })

  it('prints the bare question when nothing is recommended', () => {
    const itemStream = makeStream('ticket-lingtai-59')
    const [blocked] = aWait(itemStream, {
      _tag: 'OwnQuestion',
      question: 'held at the merge gate: agent/112 into develop',
      by: 'human:steven',
    })
    const said = summarise(blocked!)
    expect(said).toContain('held at the merge gate: agent/112 into develop')
    expect(said).not.toContain('recommends')
  })

  it('points into the open row when hold does not parse — an old or unrecognised shape', () => {
    const said = summarise(e('WorkItemBlocked', { hold: { _tag: 'SomethingElse' } }))
    expect(said).toBe('recorded WorkItemBlocked; open for its fields')
  })

  /** `StepStarted` carries a step and a round and no action: `stepAt` threw on every one of them. */
  it('says which step began, and in which round, from a payload that names no action', () => {
    expect(summarise(e('StepStarted', { runId: 'pass-1', step: 'prepared', round: 0 }))).toBe('prepared started')
    expect(summarise(e('StepStarted', { runId: 'pass-1', step: 'review', round: 2 }))).toBe('review started (round 2)')
  })

  it('says a step ended with nothing to run, rather than falling back', () => {
    const ended = e('StepEnded', { runId: 'pass-1', outcome: anOutcome('prepared', 0, []) })
    expect(summarise(ended)).toBe('prepared ended with no action to run')
  })

  /**
   * **A dropped answer and a clean review used to be the same row** (`#279`).
   *
   * `StepFailed` with `findings: []` renders as the bare step, which is what a
   * reviewer that read the diff and had nothing to refuse it on writes. `#269`'s
   * third review said four things, ended one closing brace short of valid JSON, and
   * had this row as its only appearance on the page.
   */
  it('says the answer could not be read, where a zero would have said nothing', () => {
    const event = makeStream('pass-1')
    const ended = (
      evidence: string,
      result:
        | { _tag: 'AnswerUnreadable'; raw: string }
        | { _tag: 'Completed'; assessment: { verdict: 'refused'; findings: Finding[] } },
    ): Envelope => {
      const action: Action = {
        plugin: 'agent',
        name: 'cold reviewer',
        onSha: 'a'.repeat(40),
        evidence,
        yields: 'verdict',
        result,
      }
      return event('StepEnded', { runId: 'pass-1', outcome: anOutcome('review', 0, [action]) })
    }

    const dropped = summarise(ended('…', { _tag: 'AnswerUnreadable', raw: '…' }))

    expect(dropped).toBe('review · cold reviewer — the answer could not be read')
    // The row it was, and still is for every failure whose answer was read: a
    // refusal with no findings is silent and a refusal with them counts them.
    const refused = { _tag: 'Completed' as const, assessment: { verdict: 'refused' as const, findings: [] } }
    expect(summarise(ended('exit 1', refused))).toBe('review · cold reviewer')
    expect(dropped).not.toBe(summarise(ended('exit 1', refused)))
  })

  it('renders the plan StepsResolved carries, including the empty points', () => {
    const said = summarise(
      e('StepsResolved', {
        runId: 'pass-1',
        configHash: '3f8a1c2b9d04',
        steps: [
          { step: 'admit', actions: [] },
          { step: 'prepared', actions: ['build', 'lint'] },
          { step: 'proposed', actions: ['review'] },
          { step: 'merge', actions: [] },
          { step: 'end', actions: ['comment', 'close'] },
        ],
      }),
    )
    // The evidence behind every `skipped` on the page: a point with nothing
    // planned reads as nothing planned, rather than as a point that vanished.
    expect(said).toBe('admit — · prepared build+lint · proposed review · merge — · end comment+close')
  })

  it('says what IssueUpdated changed and to what', () => {
    const said = summarise(
      e('IssueUpdated', { project: 'lingtai', issue: '59', change: 'labels', detail: 'lingtai:working' }),
    )
    expect(said).toBe('labels: lingtai:working')
  })

  it('says how the run was started', () => {
    const said = summarise(
      e('RunStarted', {
        ticketId: 'ticket-lingtai-59',
        runtime: 'claude-code',
        model: 'opus-5',
        promptVersion: 'ticket@1911',
        baseSha: '1f7d07be3c2a91',
        configHash: '3f8a1c2b9d04ee',
        worktree: '/tmp/wt',
        invocation: null,
      }),
    )
    // The worktree, the prompt version and the recipe hash are in the fields.
    expect(said).toBe('an agent of another ticket started on claude-code (opus-5) from base 1f7d07b')
  })

  it('gives RunPrompted a detail of its own, so its actor is not read as one', () => {
    const said = summarise(
      e('RunPrompted', { promptVersion: 'ticket@1911', bytes: 4593, prompt: '…' }, 'agent:pass-78db72ff-d659'),
    )
    // Its size; a version string is not a caption.
    expect(said).toBe('an agent of another ticket was prompted (4593 bytes)')
    expect(said).not.toContain('ticket@1911')
  })
})
