import { decideRoute, offerFor, type Envelope, type ProjectState, type ToAppend } from '@lingtai/domain'
import {
  aClaim,
  aLanding,
  aRelease,
  aResolution,
  aRoute,
  aRun,
  aRunRef,
  aWait,
  aWaitId,
  anIntegrationRefusal,
  aWithdrawal,
} from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore, type MemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { type ConvergeOptions, findIssueDrift } from '../src/converge.ts'
import type { DaemonStore, StreamQuery } from '../src/store.ts'
import { COMPLETION_EVENTS } from '../src/work-loop.ts'

/**
 * Pins the daemon's own decisions — what wakes `work-loop.ts`'s loop, and
 * which streams `converge.ts`'s `findIssueDrift` reads as candidates and what
 * it makes of them — against a recorded stream built from today's builders,
 * before #486 moves either file onto the read model. Every assertion names a
 * label this file chose, never an event type, so #464 — where the builders
 * start emitting 0118's new types — leaves this file's expectations alone;
 * only the fixtures it feeds through `aClaim`/`aWait`/etc. would need to
 * change, and they are the builders' own job to keep current.
 *
 * **This is unit, by 0060 §1** (`createMemoryEventStore()`, no Postgres, no
 * network) and it is the only check inside the pass of what wakes the loop:
 * `work-loop.test.ts` covers the same ground at the wire level and is
 * integration, which `pnpm test` does not run; so is `converge.test.ts`.
 * `converge-refs.test.ts` is unit and does run under
 * `pnpm test`, but its `oneStream()` answers a fixed id regardless of
 * `query.types` (`converge-refs.test.ts:48-50`), so it never exercises the
 * type filter `candidates()` applies — the decision this file's second half
 * pins.
 *
 * **A red here means the reader changed.** Fix `converge.ts` or
 * `work-loop.ts` to keep agreeing with this file — never adjust what this
 * file expects to match a moved reader, which is exactly the regression this
 * file exists to catch.
 */

const PROJECT = 'lingtai'
const OWNER = 'steven-zhc'

const project: ProjectState = {
  project: PROJECT,
  owner: OWNER,
  base: 'main',
  configHash: 'seeded',
  fromSha: '0'.repeat(40),
  refused: null,
  version: 1,
  lastSeq: null,
}

const toAppend = (e: Envelope): ToAppend => ({ type: e.type, actor: e.actor, data: e.data })

/**
 * Writes a builder's own envelopes onto the memory store, batched per stream
 * and at each stream's own next version — `versions` is the only state this
 * needs, since the store (never the builder's own `version` field) is what
 * assigns the real one.
 */
async function appendBuilt(
  store: MemoryEventStore,
  versions: Map<string, number>,
  envelopes: readonly Envelope[],
): Promise<void> {
  let i = 0
  while (i < envelopes.length) {
    const streamId = envelopes[i]!.streamId
    const batch: ToAppend[] = []
    while (i < envelopes.length && envelopes[i]!.streamId === streamId) {
      batch.push(toAppend(envelopes[i]!))
      i += 1
    }
    const at = versions.get(streamId) ?? 0
    await store.append(streamId, at, batch)
    versions.set(streamId, at + batch.length)
  }
}

/**
 * A `DaemonStore` whose `streams()` applies `query.prefixes` and
 * `query.types` to what was actually appended — never a fixed answer the way
 * `converge-refs.test.ts`'s `oneStream()` is, because the type filter is
 * exactly the decision this file pins. Mirrors `sqlite.ts`'s own `streams()`:
 * a stream qualifies if its id matches one of the prefixes (`%` is a trailing
 * wildcard, the only kind this package ever asks for) and it holds at least
 * one event of one of the types.
 */
function daemonStoreOver(store: MemoryEventStore): DaemonStore {
  return {
    events: store,
    async streams(query: StreamQuery): Promise<string[]> {
      const byStream = new Map<string, Set<string>>()
      for (const e of store.all()) {
        const types = byStream.get(e.streamId) ?? new Set<string>()
        types.add(e.type)
        byStream.set(e.streamId, types)
      }
      const prefixes = query.prefixes.map((p) => p.replace(/%$/, ''))
      return [...byStream]
        .filter(([id, types]) => prefixes.some((p) => id.startsWith(p)) && query.types.some((t) => types.has(t)))
        .map(([id]) => id)
        .sort()
    },
  } as unknown as DaemonStore
}

/** A remote issue as a fixed label set, recording every `getIssue` call it serves. */
function fakeClient(labelsByIssue: ReadonlyMap<number, readonly string[]>, calls: number[]) {
  return {
    getIssue: async (n: number) => {
      calls.push(n)
      return {
        number: n,
        id: (n * 1000 + 7) as never,
        title: 'a ticket',
        body: '',
        labels: (labelsByIssue.get(n) ?? []).map((name) => ({ name, color: '000000' })),
        state: 'open' as const,
        url: `https://example.invalid/${n}`,
        dependencies: { blockedBy: 0, totalBlockedBy: 0 },
        assignees: [],
      }
    },
  }
}

describe('what wakes the loop', () => {
  it('matches `COMPLETION_EVENTS` label by label, not event type', () => {
    const item = makeStream('ticket-lingtai-701')
    const run = aRun('pass-701')
    const passed = run.aStepEnded({
      step: 'build',
      round: 0,
      actions: [
        {
          plugin: 'run',
          name: 'test',
          onSha: 'a'.repeat(40),
          evidence: 'ok',
          yields: 'verdict',
          result: { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } },
        },
      ],
    })
    const refused = run.aStepEnded({
      step: 'review',
      round: 0,
      actions: [
        {
          plugin: 'agent',
          name: 'review',
          onSha: 'a'.repeat(40),
          evidence: 'no.',
          yields: 'verdict',
          result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
        },
      ],
    })

    const ownQuestionId = aWaitId()
    const requeuedId = aWaitId()
    const withdrawnId = aWaitId()

    // `fix-lines`, offered off a `ReviewFindings` with a criterion, selected
    // by a judge — the shape `#472`'s own `FixRound` candidate takes.
    const reviewFindings = {
      _tag: 'ReviewFindings' as const,
      findings: [{ file: 'x.ts', line: 1, claim: 'no', failureScenario: 'it breaks', severity: 'blocker' as const }],
    }
    const reviewOffer = offerFor(reviewFindings, { rounds: 1, restarts: 1 }, { rounds: 0, restarts: 0 })
    const reviewReply = { _tag: 'Selected' as const, candidate: 'fix-lines' as const, why: 'fixable' }
    const reviewDecision = decideRoute(reviewOffer, reviewReply)

    // `restart`, offered off a `CheckRefused` at `proposed` with no round left
    // — the shape a restart is actually chosen from.
    const checkRefused = { _tag: 'CheckRefused' as const, from: 'proposed' as const, output: 'still refuses' }
    const restartOffer = offerFor(checkRefused, { rounds: 1, restarts: 1 }, { rounds: 1, restarts: 0 })
    const restartReply = { _tag: 'Selected' as const, candidate: 'restart' as const, why: 'start over' }
    const restartDecision = decideRoute(restartOffer, restartReply)

    const rows: [string, Envelope[]][] = [
      ['claimed', aClaim(item, run.runId)],
      ['build passed', passed],
      ['review refused', refused],
      ['own question', aWait(item, { _tag: 'OwnQuestion', question: 'why?', by: 'steven' }, ownQuestionId)],
      [
        'agent question',
        aWait(item, { _tag: 'AgentQuestion', run: aRunRef(run.runId), step: 'implement', question: 'which way?' }),
      ],
      [
        'answered',
        (() => {
          const answeredId = aWaitId()
          return [
            ...aWait(item, { _tag: 'OwnQuestion', question: 'ready?', by: 'steven' }, answeredId),
            ...aResolution(item, answeredId, { _tag: 'AnswerQuestion', choice: 'go ahead' }, 'steven'),
          ]
        })(),
      ],
      ['requeued', aResolution(item, requeuedId, { _tag: 'Requeue' })],
      ['withdrawn', aWithdrawal(item, withdrawnId)],
      ['routed to implement', aRoute(run, { offer: reviewOffer, reply: reviewReply, decision: reviewDecision })],
      [
        'restarted at claim',
        aRoute(run, { offer: restartOffer, reply: restartReply, decision: restartDecision }, item),
      ],
      ['released', aRelease(item, run.runId)],
      [
        'integration refused',
        anIntegrationRefusal(makeStream('int-lingtai-main'), 'ticket-lingtai-701', 'agent/701', { reason: 'conflict' }),
      ],
      ['landed', aLanding(item, 'a'.repeat(40))],
    ]

    const triggers = new Set<string>(COMPLETION_EVENTS)
    const woken = rows.filter(([, es]) => es.some((e) => triggers.has(e.type))).map(([label]) => label)

    // `routed to implement` stays asleep — `PassRouted` and `FixRequested`
    // wake nothing. `restarted at claim` already wakes today: `conduct.ts`'s
    // restart branch (`release(reason)` at `conduct.ts:3951`) calls
    // `releaseTicket` (`claim.ts:143`), which appends `TicketReleased` on
    // the item's own stream right after `PassRestarted` — so the row carries
    // both, the same as a plain release. #464's appendix gives that release a
    // `cause: Restart`; it does not decide whether this row wakes, only what
    // the release it already makes is tagged with.
    expect(woken).toEqual([
      'own question',
      'agent question',
      'answered',
      'requeued',
      'withdrawn',
      'restarted at claim',
      'released',
      'integration refused',
      'landed',
    ])
  })
})

describe("findIssueDrift's own choice of candidate and divergence", () => {
  it("finds exactly the drift today's reader finds, and reads no issue it has nothing to ask about", async () => {
    const store = createMemoryEventStore()
    const versions = new Map<string, number>()
    const calls: number[] = []

    // Claimed, wearing nothing: the running label is wanted.
    const claimed = makeStream(`ticket-${PROJECT}-601`)
    await appendBuilt(store, versions, aClaim(claimed, 'pass-601'))

    // Waiting, wearing the running label a previous reconcile wrote: should
    // move to the waiting label.
    const waiting = makeStream(`ticket-${PROJECT}-602`)
    await appendBuilt(store, versions, aClaim(waiting, 'pass-602'))
    await appendBuilt(
      store,
      versions,
      aWait(waiting, { _tag: 'AgentQuestion', run: aRunRef('pass-602'), step: 'implement', question: 'which way?' }),
    )

    // Waited, then requeued — never claimed, so only `WorkItemBlocked` and
    // `WorkItemUnblocked` explain the stream. The waiting label a previous
    // reconcile wrote is now stale: the item wants no label at all.
    const requeued = makeStream(`ticket-${PROJECT}-603`)
    await appendBuilt(store, versions, [
      requeued('IssueUpdated', { project: PROJECT, issue: '603', change: 'labels', detail: 'lingtai:waiting' }),
    ])
    const requeuedWaitId = aWaitId()
    await appendBuilt(
      store,
      versions,
      aWait(requeued, { _tag: 'OwnQuestion', question: 'why?', by: 'steven' }, requeuedWaitId),
    )
    await appendBuilt(store, versions, aResolution(requeued, requeuedWaitId, { _tag: 'Requeue' }))

    // Released after a claim, with the running label stale the same way.
    const released = makeStream(`ticket-${PROJECT}-604`)
    await appendBuilt(store, versions, aClaim(released, 'pass-604'))
    await appendBuilt(store, versions, [
      released('IssueUpdated', { project: PROJECT, issue: '604', change: 'labels', detail: 'lingtai:working' }),
    ])
    await appendBuilt(store, versions, aRelease(released, 'pass-604'))

    // Landed, and never asked to carry a label at all: no `IssueUpdated`, no
    // `IssueUpdateFailed` — the log has no outstanding claim, so this is read
    // off `getIssue` by neither `findIssueDrift` nor this test.
    const landed = makeStream(`ticket-${PROJECT}-605`)
    await appendBuilt(store, versions, aClaim(landed, 'pass-605'))
    await appendBuilt(store, versions, aLanding(landed, 'a'.repeat(40)))

    // A `ticket-` stream holding only `IssueUpdated` — never claimed, blocked,
    // released, landed or unblocked — is not a candidate at all: `streams()`
    // itself never returns it.
    const untouched = makeStream(`ticket-${PROJECT}-606`)
    await appendBuilt(store, versions, [
      untouched('IssueUpdated', { project: PROJECT, issue: '606', change: 'labels', detail: 'lingtai:working' }),
    ])

    const client = fakeClient(
      new Map([
        [601, []],
        [602, ['lingtai:working']],
        [603, ['lingtai:waiting']],
        [604, ['lingtai:working']],
      ]),
      calls,
    )
    const options: ConvergeOptions = {
      store,
      daemonStore: daemonStoreOver(store),
      projects: [project],
      clients: new Map([[PROJECT, client as never]]),
    }

    const found = await findIssueDrift(options)

    expect(found).toEqual([
      {
        ticketId: `ticket-${PROJECT}-601`,
        project: PROJECT,
        issue: 601,
        change: 'labels',
        expected: 'lingtai:working',
        actual: '(no labels)',
      },
      {
        ticketId: `ticket-${PROJECT}-602`,
        project: PROJECT,
        issue: 602,
        change: 'labels',
        expected: 'lingtai:waiting',
        actual: 'lingtai:working',
      },
      {
        ticketId: `ticket-${PROJECT}-603`,
        project: PROJECT,
        issue: 603,
        change: 'labels',
        expected: '(no labels)',
        actual: 'lingtai:waiting',
      },
      {
        ticketId: `ticket-${PROJECT}-604`,
        project: PROJECT,
        issue: 604,
        change: 'labels',
        expected: '(no labels)',
        actual: 'lingtai:working',
      },
    ])
    expect(calls.sort((a, b) => a - b)).toEqual([601, 602, 603, 604])
  })
})
