import { integrationStream } from '@lingtai/domain'
/**
 * `task_view`, against the real store.
 *
 * It spans all three aggregates — the task's own stream, the run's, and the
 * integration lane's — so the seed writes to all of them and the cases assert
 * what a card ends up saying.
 *
 * Two properties matter more than the rest:
 *
 * **Rebuilding changes nothing.** This is what makes the table's shape free to
 * change, and it is why every timestamp here comes from the event rather than
 * from `now()`.
 *
 * **Retention is a query.** A landed task falling out of the window must still
 * be a row. Deleting it would make the projection depend on when it last ran.
 */
import type { ToAppend } from '@lingtai/domain'
import {
  aFixApplied,
  aFixRound,
  aLegacyHold,
  anAnswer,
  anApprovalGranted,
  aRepairRequested,
  aRoute,
  aRun,
  aStepWaived,
  aWait,
} from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { directPostgresUrl } from '@lingtai/env'
import { createDb, createEventStore, type Db, type EventStore } from '@lingtai/event-store'
import { postgresUnderTest } from '@lingtai/event-store/test/postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createProjectionRunner,
  describeArm,
  describeHold,
  describeWait,
  readTasks,
  taskViewProjection,
} from '../src/index.ts'

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`
const created = new Set<string>()
let client: Db
let store: EventStore

const wi = (n: number) => {
  const id = `ticket-${PROJECT}-${n}`
  created.add(id)
  return id
}
const run = (n: number) => {
  const id = `pass-${PROJECT}-${n}`
  created.add(id)
  return id
}

const discovered = (n: number, title: string, kind = 'bug') => ({
  type: 'TicketDiscovered',
  actor: 'github',
  data: {
    project: PROJECT,
    source: 'github-issue' as const,
    externalRef: String(n),
    title,
    kind,
    labels: [],
  },
})

/**
 * A second run id for the same issue, so two attempts can be told apart.
 *
 * `run(n)` is one per issue, which is fine while an issue is only ever run once
 * — and the whole of #78 is what happens when it is not.
 */
const attempt = (n: number, which: string) => {
  const id = `pass-${PROJECT}-${n}${which}`
  created.add(id)
  return id
}

const claimedWith = (runId: string) => ({
  type: 'TicketClaimed',
  actor: 'conductor',
  data: { runId, worker: 'w', title: null, kind: null },
})

const claimed = (n: number) => claimedWith(run(n))

const released = (runId: string, reason: string) => ({
  type: 'TicketReleased',
  actor: 'conductor',
  data: { runId, reason },
})

const KILLED = 'the run was killed by an operator timeout before it produced anything'

/** `{ type, actor, data }` off a builder's own `Envelope`, or off one of this file's own non-retired literals — both already carry the three fields `append` wants. */
function toAppend(e: { type: string; actor: string; data: unknown }): ToAppend {
  return { type: e.type, actor: e.actor, data: e.data }
}

/**
 * `StepPassed`, built through `aStepEnded` — 0120 retires it, so this fixture
 * goes through the builder rather than the wire shape directly (#480).
 */
function passed(
  runId: string,
  step: 'claim' | 'admit' | 'prepared' | 'design' | 'implement' | 'build' | 'review' | 'proposed' | 'merge' | 'end',
  action: string,
  onSha: string,
): ToAppend[] {
  return aRun(runId)
    .aStepEnded({
      step,
      round: 0,
      actions: [
        {
          plugin: 'agent',
          name: action,
          onSha,
          evidence: 'exit 0',
          yields: 'verdict',
          result: { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } },
        },
      ],
    })
    .map(toAppend)
}

const started = (n: number) => ({
  type: 'RunStarted',
  actor: 'conductor',
  data: {
    ticketId: wi(n),
    runtime: 'claude-code',
    model: 'm',
    promptVersion: 'p',
    baseSha: 'base000',
    configHash: 'c',
    worktree: '/tmp/wt',
    invocation: null,
  },
})

/** Each stream's own version, so an append below never has to carry its own number. */
const versions = new Map<string, number>()

/** `store.append`, with the expected version read off `versions` rather than counted by hand. */
async function append(
  streamId: string,
  events: ReadonlyArray<{ type: string; actor: string; data: unknown }>,
): Promise<void> {
  const before = versions.get(streamId) ?? 0
  await store.append(streamId, before, events.map(toAppend))
  versions.set(streamId, before + events.length)
}

/**
 * An event this build refuses to append, written the way an older build did.
 *
 * `store.append` refuses a retired type, which is right for everything that
 * writes — and would make it impossible to seed the one thing a rebuild has to
 * survive: a log from before the type was retired. So the row goes in beneath
 * the store, with the next version on the stream, and the store reads it back
 * exactly as it reads a real one. Tracked on the same `versions` map as
 * `append`, since the two share a stream's version sequence.
 */
async function appendRetired(streamId: string, type: string, data: object): Promise<void> {
  const before = versions.get(streamId) ?? 0
  const c = new pg.Client({ connectionString: directPostgresUrl() })
  await c.connect()
  try {
    await c.query(
      "insert into events (stream_id, version, type, data, actor) values ($1, $2, $3, $4::jsonb, 'conductor')",
      [streamId, before + 1, type, JSON.stringify(data)],
    )
  } finally {
    await c.end()
  }
  versions.set(streamId, before + 1)
}

async function seed(): Promise<void> {
  // 1 — queued and nothing else.
  await append(wi(1), [discovered(1, 'still waiting')])

  // 2 — running, guard tripped twice, cost recorded.
  await append(wi(2), [discovered(2, 'a race in the importer'), claimed(2)])
  await append(run(2), [
    started(2),
    { type: 'RunFinished', actor: 'conductor', data: { exitCode: 0, turns: 63, durationMs: 100, costUsd: 5.42 } },
  ])

  // 3 — at the gates, one passed and one failed.
  await append(wi(3), [discovered(3, 'gates in progress', 'feature'), claimed(3)])
  await append(run(3), [
    started(3),
    {
      type: 'RunProducedDiff',
      actor: 'conductor',
      data: { branch: 'agent/3', headSha: 'sha-a', files: 3, insertions: 40, deletions: 2 },
    },
    { type: 'RunProposedCompletion', actor: 'conductor', data: { headSha: 'sha-a' } },
    ...aRun(run(3))
      .aStepEnded({
        step: 'proposed',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'build',
            onSha: 'sha-a',
            evidence: 'exit 0',
            yields: 'verdict',
            result: { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } },
          },
          {
            plugin: 'agent',
            name: 'review',
            onSha: 'sha-a',
            evidence: 'two findings',
            yields: 'verdict',
            result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
          },
        ],
      })
      .map(toAppend),
  ])

  // 4 — refused by the integrator.
  await append(wi(4), [discovered(4, 'will not merge')])
  const lane = integrationStream(PROJECT, 'develop')
  created.add(lane)
  await append(lane, [
    {
      type: 'IntegrationAttempted',
      actor: 'conductor',
      data: { ticketId: wi(4), branch: 'agent/4', headSha: 'sha' },
    },
    {
      type: 'IntegrationRefused',
      actor: 'conductor',
      data: { ticketId: wi(4), branch: 'agent/4', reason: 'dirty-base', detail: 'uncommitted changes' },
    },
  ])

  // 5 — landed.
  await append(wi(5), [
    discovered(5, 'landed a while ago'),
    { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: 'abc1234def', base: 'develop' } },
  ])

  // 6 — attempt 1 passed a gate and was then killed from outside. Attempt 2
  //     arrives in `secondAttempt`, after the rebuild, so the window this is
  //     about is folded the way production folds it.
  await append(wi(6), [discovered(6, 'killed, then run again'), claimedWith(attempt(6, 'a'))])
  await append(attempt(6, 'a'), [started(6), ...passed(attempt(6, 'a'), 'prepared', 'install', 'sha-6a')])

  // 7 — the same kill, with nothing after it: still in the queue, and the only
  //     thing it has to show for the attempt is the sentence the release gave.
  await append(wi(7), [discovered(7, 'killed and not picked up again'), claimedWith(attempt(7, 'a'))])
  await append(attempt(7, 'a'), [started(7), ...passed(attempt(7, 'a'), 'prepared', 'install', 'sha-7')])
  await append(wi(7), [released(attempt(7, 'a'), KILLED)])

  // 8 — a person's word, twice: a red build waived, and the merge approved.
  await append(wi(8), [discovered(8, 'overridden by a person'), claimed(8)])
  {
    const run8 = aRun(run(8))
    await append(run(8), [
      started(8),
      { type: 'RunProposedCompletion', actor: 'conductor', data: { headSha: 'sha-8' } },
      ...run8
        .aStepEnded({
          step: 'proposed',
          round: 0,
          actions: [
            {
              plugin: 'agent',
              name: 'build',
              onSha: 'sha-8',
              evidence: 'exit 1',
              yields: 'verdict',
              result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
            },
          ],
        })
        .map(toAppend),
      ...aStepWaived(
        { event: run8.event, step: 'proposed', action: 'build', runId: run(8) },
        'sha-8',
        'human:steven',
        'known flake',
      ).map(toAppend),
      // `aResolution`'s `Approve` case writes the same event with a fixed
      // `by`/`note` ('steven'/'looks right') that nothing here reads;
      // `anApprovalGranted` takes them explicitly instead, so the actor this
      // fixture is about stays on the row.
      ...anApprovalGranted(
        { event: run8.event, step: 'merge', action: 'human', runId: run(8) },
        'sha-8',
        'human:steven',
        '',
      ).map(toAppend),
    ])
  }

  // 9 — approved, and the merge hit a conflict anyway. The whole of #84 in one
  //     stream: the approval is spent, `approve()` refuses every further click,
  //     and the item is blocked with a diagnosis rather than a headstone.
  //
  //     It used to buy an agent here, and the fixture used to carry the second
  //     attempt that agent was. `#143` takes the purchase away — and takes
  //     `RepairRequested` with it, which `store.append` now refuses as retired,
  //     so this could not be seeded even if it were still meant.
  await append(wi(9), [discovered(9, 'approved, then conflicted'), claimedWith(attempt(9, 'a'))])
  {
    const run9a = aRun(attempt(9, 'a'))
    await append(attempt(9, 'a'), [
      started(9),
      { type: 'RunProposedCompletion', actor: 'conductor', data: { headSha: 'sha-9a' } },
      ...run9a
        .aStepEnded({
          step: 'merge',
          round: 0,
          actions: [
            {
              plugin: 'human',
              name: 'approval',
              onSha: 'sha-9a',
              evidence: '',
              yields: 'signoff',
              result: { _tag: 'Completed', requested: { question: 'Merge?' } },
            },
          ],
        })
        .map(toAppend),
      { type: 'RunFinished', actor: 'conductor', data: { exitCode: 0, turns: 20, durationMs: 10, costUsd: 2.1 } },
      ...anApprovalGranted(
        { event: run9a.event, step: 'merge', action: 'approval', runId: attempt(9, 'a') },
        'sha-9a',
        'human:steven',
        '',
      ).map(toAppend),
    ])
  }
  await append(lane, [
    {
      type: 'IntegrationRefused',
      actor: 'conductor',
      data: {
        ticketId: wi(9),
        branch: 'agent/9',
        reason: 'conflict',
        detail: 'agent/9 does not merge into develop: page.tsx',
      },
    },
  ])
  await append(wi(9), [
    // A failure to acknowledge and not a judgement: the approval was spent and
    // the merge still refused, so nothing is being asked of anybody's opinion
    // — `legacyColumns` reads the diagnosis off `diagnoseRefusal`.
    //
    // **No `WaitReason` reaches this shape.** `aWait`'s `holdOf` always writes
    // `afterApproval: false` (`adapters.ts`'s `mergeRefusedHold`) — the pass's
    // own refusal, nobody has approved this sha yet. `true` is `approve.ts`'s
    // own producer: a person already approved this exact sha and the lane
    // still refused (`hold.ts`'s own comment on the field) — a different code
    // path than any `WaitReason` models, so `aLegacyHold` pins the `Hold`
    // directly rather than inventing a `WaitReason` that does not produce it.
    toAppend(
      aLegacyHold(makeStream(wi(9)), {
        _tag: 'MergeRefused',
        run: { runId: attempt(9, 'a') },
        reason: 'conflict',
        why: 'agent/9 does not merge into develop.',
        raw: 'agent/9 does not merge into develop: page.tsx',
        paths: null,
        baseSha: null,
        headSha: null,
        afterApproval: true,
      })[0]!,
    ),
  ])

  // 15 — a ticket from before #143: run-a finished, the lane refused, the old
  //      code bought a repair, and run-b was that repair. The rebuild has to
  //      keep the repair's money apart, exactly as the live projection did and
  //      as the task page's own fold still does.
  await append(wi(15), [discovered(15, 'repaired before #143'), claimedWith(attempt(15, 'a'))])
  await append(attempt(15, 'a'), [
    started(15),
    { type: 'RunFinished', actor: 'conductor', data: { exitCode: 0, turns: 20, durationMs: 10, costUsd: 2.1 } },
  ])
  await appendRetired(
    wi(15),
    'RepairRequested',
    aRepairRequested(makeStream(wi(15)), attempt(15, 'a'))[0]!.data as object,
  )
  await append(wi(15), [
    released(attempt(15, 'a'), 'repairing verify-failed (attempt 1)'),
    claimedWith(attempt(15, 'b')),
  ])
  await append(attempt(15, 'b'), [
    started(15),
    { type: 'RunFinished', actor: 'conductor', data: { exitCode: 0, turns: 9, durationMs: 10, costUsd: 0.75 } },
  ])

  // 16 — the old code bought a repair and released the item, and then the
  //      daemon restarted onto #143. Nothing has claimed it, so it is still
  //      owed the backoff exemption the repair was bought with.
  await append(wi(16), [discovered(16, 'released for a repair, then deployed'), claimed(16)])
  await appendRetired(wi(16), 'RepairRequested', aRepairRequested(makeStream(wi(16)), run(16))[0]!.data as object)
  await append(wi(16), [released(run(16), 'repairing verify-failed (attempt 1)')])

  // 10 — the branch was repaired and approval re-requested on the new head.
  //      The run produced `sha-10a` and is asking about `sha-10b`, which is
  //      the whole of #92: the card held only the first and offered it as the
  //      second, so the board's Approve refused what the CLI accepted.
  await append(wi(10), [discovered(10, 'repaired, then re-offered'), claimed(10)])
  await append(run(10), [
    started(10),
    {
      type: 'RunProducedDiff',
      actor: 'conductor',
      data: { branch: 'agent/10', headSha: 'sha-10a', files: 1, insertions: 2, deletions: 0 },
    },
    { type: 'RunProposedCompletion', actor: 'conductor', data: { headSha: 'sha-10a' } },
    ...aRun(run(10))
      .aStepEnded({
        step: 'merge',
        round: 0,
        actions: [
          {
            plugin: 'human',
            name: 'no-merge',
            onSha: 'sha-10a',
            evidence: '',
            yields: 'signoff',
            result: { _tag: 'Completed', requested: { question: 'Merge?' } },
          },
          {
            plugin: 'human',
            name: 'repair',
            onSha: 'sha-10b',
            evidence: '',
            yields: 'signoff',
            result: { _tag: 'Completed', requested: { question: 'Merge the repair?' } },
          },
        ],
      })
      .map(toAppend),
  ])
  await append(wi(10), [
    // A `Human` hold, injected by `--no-merge` or a repair — the question
    // is all it carries itself, and `legacyColumns` composes the rest.
    toAppend(
      aWait(makeStream(wi(10)), {
        _tag: 'SignoffRequired',
        run: { runId: run(10) },
        step: 'merge',
        action: 'human',
        question: 'a repair is waiting on you',
      })[0]!,
    ),
  ])

  // 11 — a block that carries a diagnosis and a recommended action (#83). 12 is
  //      the same block answered, because the diagnosis has to *go* when the
  //      hold does: one left behind would report last week's failure on a card
  //      nobody is being asked about.
  await append(wi(11), [discovered(11, 'diagnosed, with a move'), claimed(11)])
  await append(wi(11), [
    // No `WaitReason` reaches this shape either — same gap as item 9's, a few
    // lines up. `reason: 'conflict'` is excluded from
    // `WaitReason.MergeRefused` outright (`wait.ts`); a conflict today
    // escalates through `ProposedEscalated` to `Hold.Routed{when: 'conflict'}`
    // instead (`escalatedHold`), a different tag with different composed
    // text. This exact shape has been dead since `#472` (`hold-of.ts`'s own
    // comment on `holdOfPass`'s `MergeRefused` branch); `aLegacyHold` pins it
    // directly because no `WaitReason`, dead or alive, produces it.
    toAppend(
      aLegacyHold(makeStream(wi(11)), {
        _tag: 'MergeRefused',
        run: { runId: run(11) },
        reason: 'conflict',
        why: 'agent/11 does not merge into develop.',
        raw: 'CONFLICT (content): Merge conflict in apps/web/src/page.tsx',
        paths: null,
        baseSha: null,
        headSha: null,
        afterApproval: false,
      })[0]!,
    ),
  ])

  // 12 — diagnosed, then unblocked by a person.
  await append(wi(12), [discovered(12, 'diagnosed, then answered'), claimed(12)])
  await append(wi(12), [
    // Same gap as 11's, two items up: dead since #472, no `WaitReason`
    // reaches it.
    toAppend(
      aLegacyHold(makeStream(wi(12)), {
        _tag: 'MergeRefused',
        run: { runId: run(12) },
        reason: 'conflict',
        why: 'agent/12 does not merge into develop.',
        raw: 'CONFLICT (content): Merge conflict in apps/web/src/other.tsx',
        paths: null,
        baseSha: null,
        headSha: null,
        afterApproval: false,
      })[0]!,
    ),
    ...anAnswer(makeStream(wi(12)), 'human:steven', 'requeued').map(toAppend),
  ])

  // 13 — a round in flight, so the note has to say which round *of how many*.
  //      `FixRequested.of` is what makes that readable off the log: a
  //      projection is a fold and may not read the recipe the ceiling is in.
  await append(wi(13), [discovered(13, 'patching, round one'), claimed(13)])
  {
    const run13 = aRun(run(13))
    await append(run(13), [
      started(13),
      { type: 'RunProposedCompletion', actor: 'conductor', data: { headSha: 'sha-13' } },
      ...run13
        .aStepEnded({
          step: 'proposed',
          round: 0,
          actions: [
            {
              plugin: 'agent',
              name: 'review',
              onSha: 'sha-13',
              evidence: 'one finding',
              yields: 'verdict',
              result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
            },
          ],
        })
        .map(toAppend),
      // `FixRequested`/`FixApplied` with these exact round/cost figures have
      // no dedicated builder either — `aStepEnded`'s own round>0 bookkeeping
      // hardcodes `of: round` and `turns: 1, costUsd: null` (`events.ts`'s
      // `openRound`/`contextFor`), so `aFixRound`/`aFixApplied` take them
      // explicitly instead.
      ...aFixRound(run13, 1, 3, 'review', 'sha-13').map(toAppend),
      // What the round cost, which is the only thing `repair_costs` holds since
      // `#143`: a run is never a repair, so a run's money is always the work's
      // and what answering a refusal cost is keyed by the round that bought it.
      ...aFixApplied(run13, 1, 'sha-13b', 7, 0.75).map(toAppend),
      { type: 'RunFinished', actor: 'conductor', data: { exitCode: 0, turns: 31, durationMs: 10, costUsd: 2.1 } },
    ])
  }

  // 14 — the rounds were spent and the ticket started over
  //      ([0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md)).
  //      Released rather than blocked, which is the whole of the change, and
  //      carrying which arm it is now on — the thing `attempts` cannot say.
  await append(wi(14), [discovered(14, 'started over once'), claimed(14)])
  {
    const run14 = aRun(run(14))
    await append(run(14), [
      started(14),
      { type: 'RunProposedCompletion', actor: 'conductor', data: { headSha: 'sha-14' } },
      ...run14
        .aStepEnded({
          step: 'proposed',
          round: 0,
          actions: [
            {
              plugin: 'agent',
              name: 'review',
              onSha: 'sha-14',
              evidence: 'still refused',
              yields: 'verdict',
              result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
            },
          ],
        })
        .map(toAppend),
    ])
    // `aRoute`'s `to: 'claim'` branch writes `PassRouted` on the run's own
    // stream and `PassRestarted` on the item's — real conduct.ts's own split
    // (`pass-next.ts`) — and `rounds: 0` rather than this fixture's `3`, which
    // `task_view` never reads (`cardFactOf`'s `Restarted` fact carries only
    // `restart`/`of`).
    const [routed, restarted] = aRoute(run14, { from: 'review', to: 'claim', restart: 1, of: 2 }, makeStream(wi(14)))
    await append(run(14), [toAppend(routed!)])
    await append(wi(14), [
      toAppend(restarted!),
      released(run(14), 'the review reviewer still refused after 3 round(s) — restart 1 of 2'),
    ])
  }

  // 17 — a question asked before any run (#147), with nothing before it on the
  //      stream: no discovery, no claim. The block is the task's first event,
  //      so the row has to be made by it or the queue would not see the hold.
  await append(wi(17), [
    toAppend(
      aWait(makeStream(wi(17)), {
        _tag: 'OwnQuestion',
        question: 'Which of the three designs should the tripwire use?',
        by: 'human:steven',
      })[0]!,
    ),
  ])

  // 18 — the same question, answered. The answer is what a rebuild has to be
  //      able to say, and it outlives the claim that follows it.
  await append(wi(18), [
    toAppend(
      aWait(makeStream(wi(18)), {
        _tag: 'OwnQuestion',
        question: 'Refuse at the hook, or at the claim?',
        by: 'human:steven',
      })[0]!,
    ),
    // `aResolution`'s `AnswerQuestion` case hardcodes `by: 'steven'`; the
    // assertion below needs the real actor, so `anAnswer` takes it explicitly.
    ...anAnswer(makeStream(wi(18)), 'human:steven', 'at the hook').map(toAppend),
    claimed(18),
  ])
}

/** Appended after the rebuild, so `fold` is what folds it. */
async function secondAttempt(): Promise<void> {
  await append(wi(6), [released(attempt(6, 'a'), KILLED)])
  await append(wi(6), [claimedWith(attempt(6, 'b'))])
  await append(attempt(6, 'b'), [started(6)])
}

async function build(): Promise<void> {
  const runner = createProjectionRunner({ projection: taskViewProjection, store })
  try {
    await runner.rebuild()
  } finally {
    await runner.close()
  }
}

/** Forward from the checkpoint, which is what a live projector does. */
async function fold(): Promise<void> {
  const runner = createProjectionRunner({ projection: taskViewProjection, store })
  try {
    await runner.start()
  } finally {
    await runner.close()
  }
}

const card = (tasks: Awaited<ReturnType<typeof readTasks>>, n: number) => tasks.find((t) => t.issue === String(n))

// #275: `seed()` calls `appendRetired`, a raw insert of a retired event type
// straight into `events` — the store's own `append` refuses one, which is
// right for every real writer and leaves this as the only way to put a
// pre-retirement row in front of a rebuild. The insert's placeholders and its
// `::jsonb` cast are Postgres's syntax, so the whole fixture — and every case
// below, since all of them read what `seed()` wrote — needs the real thing.
// Skipped rather than converted where no LINGTAI_TEST_DATABASE_URL is set, so
// the skip is visible in vitest's own count.
describe.skipIf(!postgresUnderTest())('against the real store', () => {
  beforeAll(async () => {
    client = createDb()
    store = createEventStore(client)
    await seed()
    await build()
    // Half the history is rebuilt and half is folded forward, so the rebuild case
    // below compares the two paths rather than a rebuild against itself.
    await secondAttempt()
    await fold()
  }, 120_000)

  afterAll(async () => {
    await client.close()
    const c = new pg.Client({ connectionString: directPostgresUrl() })
    await c.connect()
    try {
      await c.query('alter table events disable rule lingtai_events_no_delete')
      for (const id of created) await c.query('delete from events where stream_id = $1', [id])
    } finally {
      await c.query('alter table events enable rule lingtai_events_no_delete')
      await c.end()
    }
  })

  describe('task_view', () => {
    it('puts each task in the state its stream says it is in', async () => {
      const tasks = await readTasks({ project: PROJECT })

      expect(card(tasks, 1)?.state).toBe('queued')
      expect(card(tasks, 2)?.state).toBe('running')
      expect(card(tasks, 3)?.state).toBe('verifying')
      expect(card(tasks, 4)?.state).toBe('queued')
      expect(card(tasks, 5)?.state).toBe('landed')
    })

    it('carries what a card shows and leaves the rest in the log', async () => {
      const tasks = await readTasks({ project: PROJECT })

      const two = card(tasks, 2)!
      expect(two.turns).toBe(63)
      expect(two.costUsd).toBeCloseTo(5.42)
      // No tier on the card any more: it is the recipe's (ADR 0016 §7), and the
      // board does not read recipes.

      const three = card(tasks, 3)!
      expect(three.passed).toBe(1)
      expect(three.failed).toBe(1)
      expect(three.headSha).toBe('sha-a')
      expect(three.files).toBe(3)
    })

    it('records the attempt, which is what a backoff reads', async () => {
      const tasks = await readTasks({ project: PROJECT })
      const two = card(tasks, 2)!

      // In the table rather than in memory: an in-memory set forgets on restart,
      // and the loop it prevents cost the old harness roughly $29.
      expect(two.attempts).toBe(1)
      expect(two.lastAttemptAt).toBeInstanceOf(Date)
      expect(card(tasks, 1)!.attempts).toBe(0)
    })

    /**
     * **Which arm, beside how many attempts**
     * ([0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md) §3).
     *
     * `attempts` counts claims, so a claim after a crash, after a backoff and
     * after an approach was thrown away all read as the same number — which is
     * why *round 2 of 3, restart 1 of 2* had to become sayable and *attempt 3*
     * was not enough. The sentence is `describeArm`'s so that the board and
     * `lingtai status` cannot word it differently (#100).
     */
    it('says which arm a ticket is on, and which round of that arm', async () => {
      const tasks = await readTasks({ project: PROJECT })

      // The depth half, while a pass is in flight. `of` is what makes the
      // denominator readable: a fold cannot open the recipe the ceiling is in.
      expect(card(tasks, 13)!.note).toBe('fixing round 1 of 3: 0 finding(s) from review')

      // The breadth half, which outlives the pass that spent it.
      const over = card(tasks, 14)!
      expect(over.restarts).toBe(1)
      expect(over.restartsOf).toBe(2)
      expect(describeArm(over)).toBe('restart 1 of 2')
      // **Released, not waiting.** A question for a person sits in the waiting
      // lane; a restarted ticket is back in the queue for an ordinary claim.
      expect(over.state).toBe('queued')
      expect(over.waiting).toBe(false)
      expect(over.note).toContain('restart 1 of 2')

      // Nothing on a ticket that has only ever had one approach, so a card on a
      // project that buys no restart reads exactly as it did.
      expect(card(tasks, 2)!.restarts).toBe(0)
      expect(describeArm(card(tasks, 2)!)).toBeNull()
    })

    it('says why a task is waiting, in one line', async () => {
      const tasks = await readTasks({ project: PROJECT })
      expect(card(tasks, 4)!.note).toContain('dirty-base')
    })

    /**
     * #78. `ticket-lingtai-59` read `1 passed · attempt 2` on the board, and the pass
     * belonged to attempt 1 — a run an operator had killed eleven hours earlier,
     * which produced nothing. The verdicts were keyed `point:action` with no run
     * in the key, so the map was one shared set of cells and nothing ever cleared
     * it.
     */
    it('counts only the gates of the run the card names', async () => {
      const tasks = await readTasks({ project: PROJECT })
      const six = card(tasks, 6)!

      expect(six.attempts).toBe(2)
      expect(six.runId).toBe(`pass-${PROJECT}-6b`)
      // Attempt 2 has reached no gate. Attempt 1's `prepared:install` is still in
      // the map, against the run that earned it, and is not this card's.
      expect(six.passed).toBe(0)
      expect(six.failed).toBe(0)
    })

    /**
     * A run killed from outside fails no gate, so `failed` stayed 0 and the
     * card came back to Queued with a green pill and nothing else — a ticket that
     * had burned money and produced nothing, looking like a fresh one.
     */
    it('marks a task whose attempt ended without landing', async () => {
      const tasks = await readTasks({ project: PROJECT })
      const seven = card(tasks, 7)!

      expect(seven.state).toBe('queued')
      // No run named, so no verdict is this card's to show.
      expect(seven.runId).toBeNull()
      expect(seven.passed).toBe(0)
      // The sentence the release already carried.
      expect(seven.note).toBe(KILLED)
    })

    /**
     * A waiver records who and why precisely because it is not a pass. Counting
     * it as one threw away the distinction the record exists for — and the same
     * held for a human approval, which is not a build going green either.
     */
    it("does not read a person's word as a gate that ran", async () => {
      const tasks = await readTasks({ project: PROJECT })
      const eight = card(tasks, 8)!

      expect(eight.passed).toBe(0)
      // The waiver replaced the failure in its own cell: one verdict per point
      // per run, and the latest one is what stands.
      expect(eight.failed).toBe(0)
      expect(eight.waived).toBe(1)
      expect(eight.approved).toBe(1)
    })

    /**
     * The dead end `#84` is about, as the card sees it.
     *
     * "Waiting, and there is a head sha" was true of this row while `approve()`
     * would refuse every click — the approval had been spent on the merge that
     * conflicted, and the run was back to `gating`. Sitting in the column and
     * being asked a question are two facts, and the card now carries both.
     *
     * **And the refusal reaches a person**, which since `#143` is the only place
     * it can reach: no agent is bought, so the block and its diagnosis are the
     * whole outcome and the card has to carry a sentence rather than a control
     * that refuses.
     */
    it('stops offering an approval once the merge that consumed it failed', async () => {
      const tasks = await readTasks({ project: PROJECT, retentionDays: 3650 })
      const nine = card(tasks, 9)!

      expect(nine.awaitingApproval).toBe(false)
      // Somebody's question, with the reason on it.
      expect(nine.state).toBe('waiting')
      expect(nine.waiting).toBe(true)
      expect(nine.needs).toBe('acknowledgement')
      expect(nine.diagnosis?.done).toContain('No agent was bought')
      expect(nine.diagnosis?.recommendation?.action).toBe('requeue')

      // The lane holds more than questions: a refused dispatch with no block
      // after it leaves `state` alone — #406 — so card 4 is whatever
      // `TicketDiscovered` wrote, with the refusal as its note.
      expect(card(tasks, 4)!.state).toBe('queued')
      expect(card(tasks, 4)!.waiting).toBe(false)
    })

    /**
     * #92. The card sent `head_sha` to `approve()`, which compares against what
     * the run is *asking* about — so an item whose branch had been repaired and
     * re-offered refused every click on the board while `lingtai approve`, which
     * sends no sha and falls through to the run's own, landed it.
     *
     * Two facts, so the row carries both, and the one a control has to send is
     * the one the question is bound to.
     */
    it('carries the sha the run is asking about, apart from the one it produced', async () => {
      const tasks = await readTasks({ project: PROJECT })
      const ten = card(tasks, 10)!

      expect(ten.headSha).toBe('sha-10a')
      expect(ten.awaitingSha).toBe('sha-10b')
      // And a question is open exactly when there is a sha it is about, so the
      // card cannot offer Approve without the value Approve needs.
      expect(ten.awaitingApproval).toBe(true)
      expect(ten.waiting).toBe(true)

      // Granted spends it: #84's row is asking nothing and carries nothing.
      expect(card(tasks, 9)!.awaitingSha).toBeNull()
      expect(card(tasks, 9)!.awaitingApproval).toBe(false)
    })

    /**
     * A block carries what was worked out about it, or says it carries nothing.
     *
     * #83: the whole vocabulary was `question`, so a conflict reached a person as
     * a git message with a colon in it and a `human:` gate reached them as the
     * same event — no diagnosis, no recommendation, and the card's only honest
     * control was one that could not act. The projection is where the card and
     * `lingtai status` both read it from, which is what stops the two of them
     * describing one block differently.
     */
    it("surfaces a block's diagnosis and its recommended action", async () => {
      const eleven = card(await readTasks({ project: PROJECT }), 11)!

      expect(eleven.waiting).toBe(true)
      expect(eleven.needs).toBe('acknowledgement')
      expect(eleven.diagnosis?.what).toBe('agent/11 does not merge into develop.')
      expect(eleven.diagnosis?.done).toContain('No agent was bought')
      // The raw failure is still reachable: a summary that hides the git output is
      // worse than the git output.
      expect(eleven.diagnosis?.raw).toContain('CONFLICT (content)')
      expect(eleven.diagnosis?.recommendation?.action).toBe('requeue')
      // And the note names the reason, with git's own words behind it.
      expect(eleven.note).toContain('conflict:')
      expect(eleven.note).toContain('CONFLICT (content)')
      // The same four facts, as the sentences the card and `status` share.
      expect(describeHold(eleven).map((l) => l.part)).toEqual(['needs', 'what', 'did', 'rec'])
    })

    /**
     * A `Human` hold carries nothing of its own but the question — the
     * `--no-merge`/repair case — and `legacyColumns` composes the rest from
     * the step alone, including the merge recommendation (#445).
     */
    it('renders a Human hold from its question, with the merge recommendation', async () => {
      const ten = card(await readTasks({ project: PROJECT }), 10)!

      expect(ten.waiting).toBe(true)
      expect(ten.note).toBe('the `merge` step held: a repair is waiting on you')
      expect(ten.needs).toBe('judgement')
      expect(ten.diagnosis?.recommendation?.action).toBe('approve')
      expect(describeHold(ten).map((l) => l.part)).toEqual(['needs', 'what', 'rec'])
    })

    /** And the diagnosis goes when the hold is answered, not one lap later. */
    it('drops the diagnosis when the block is answered', async () => {
      const twelve = card(await readTasks({ project: PROJECT }), 12)!

      expect(twelve.state).toBe('queued')
      expect(twelve.waiting).toBe(false)
      expect(twelve.needs).toBeNull()
      expect(twelve.diagnosis).toBeNull()
    })

    /**
     * A question asked before any run, and its answer (#147).
     *
     * The block is 17's first event, so it has to *make* the row: `selectRunnable`
     * passes over an issue only when the log has a row saying so, and with no
     * row the item would be offered and claimed straight past the question.
     */
    it('holds a question asked before any run, and keeps the answer through a rebuild', async () => {
      const tasks = await readTasks({ project: PROJECT })

      const seventeen = card(tasks, 17)!
      expect(seventeen.state).toBe('waiting')
      expect(seventeen.waiting).toBe(true)
      expect(seventeen.asked).toBe(true)
      expect(seventeen.note).toBe('Which of the three designs should the tripwire use?')
      expect(describeWait(seventeen)).toBe('waiting for your answer')

      const eighteen = card(tasks, 18)!
      expect(eighteen.state).toBe('running')
      expect(eighteen.asked).toBe(false)
      expect(eighteen.answer).toEqual({
        question: 'Refuse at the hook, or at the claim?',
        answer: 'at the hook',
        by: 'human:steven',
      })

      // And a review is not an answer: 10 is a run holding a sha.
      expect(describeWait(card(tasks, 10)!)).toBe('waiting for your review')
      // A failure needing acknowledgement is neither, and stays `describeHold`'s.
      expect(describeWait(card(tasks, 11)!)).toBeNull()
    })

    /**
     * **A block can be both, and only one of them is a question to the person**
     * (`#197`).
     *
     * The rule above held by accident for as long as it was documented: the only
     * blocks written `acknowledgement` — the merge lane's, the out-of-turns one,
     * a spent approval's — left no open `ApprovalRequested`, so `awaitingSha` was
     * null and this returned null without ever asking `needs`. A fixing agent
     * killed mid-round now writes `acknowledgement` on a block that *does* hold a
     * sha, and the chip read *waiting for your review* — whose move is approve or
     * reject what is there (#147) — beside a headline reading *this is
     * infrastructure and not your call: send it again*. Two chips on one card
     * prescribing opposite moves is the failure #147 split the chip to end, so
     * the rule is asserted rather than inherited from which blocks happen to
     * exist.
     */
    it('does not call an acknowledgement a review, even when it holds a sha', () => {
      const stopped = {
        waiting: true,
        asked: false,
        awaitingSha: 'a7663f9000000000',
        needs: 'acknowledgement' as const,
      }

      expect(describeWait(stopped)).toBeNull()
      // And the sha still means a review where the block is somebody's call —
      // the common case must not be lost to fix the combination.
      expect(describeWait({ ...stopped, needs: 'judgement' })).toBe('waiting for your review')
      expect(describeWait({ ...stopped, needs: null })).toBe('waiting for your review')
      // An answer is still an answer: a question asked before any run outranks
      // both, because there is no diff for a review to be about.
      expect(describeWait({ ...stopped, asked: true })).toBe('waiting for your answer')
    })

    /**
     * What diagnosis costs, apart from the work.
     *
     * Answering a refusal is on by default and spends an agent without being
     * asked again, so folding its cost into the number beside it would make it an
     * invisible bill (#84).
     *
     * **It is a round's cost and nothing else since `#143`.** The bill used to be
     * a whole *run* the merge lane bought, told which column to land in by the
     * row's own `repair_run_id`; nothing buys a run now, so a run's money is
     * always the work's and this figure is exactly the rounds a pass spent.
     */
    it("counts what answering a refusal cost separately from the work's", async () => {
      const tasks = await readTasks({ project: PROJECT, retentionDays: 3650 })
      const thirteen = card(tasks, 13)!

      expect(thirteen.costUsd).toBe(2.1)
      expect(thirteen.repairCostUsd).toBe(0.75)
      // A ticket from before #143 keeps its repair's money apart on a rebuild:
      // the second attempt *was* a repair, and the task page still says so.
      const fifteen = card(tasks, 15)!
      expect(fifteen.costUsd).toBe(2.1)
      expect(fifteen.repairCostUsd).toBe(0.75)
      expect(fifteen.repairPending).toBe(false)
      // And an item released for one and not yet claimed is still owed the
      // exemption from the backoff.
      expect(card(tasks, 16)!.repairPending).toBe(true)

      // And a card that never bought a round says nothing rather than zero:
      // nothing bought and something bought for free are different facts.
      expect(card(tasks, 2)!.repairCostUsd).toBeNull()
    })

    /**
     * The property that makes this table's shape free to change. It only holds
     * because every timestamp comes from `event.at` — a projection that read the
     * clock would produce different rows on every rebuild, and the workflow for
     * changing a projection would stop being "rebuild it".
     *
     * `before` is genuinely the two paths mixed: `beforeAll` rebuilds most of the
     * history and then folds the rest forward from the checkpoint. That is what
     * makes this a claim about the incremental path and not a rebuild compared
     * with itself — and it is the claim the run-scoped gate keys have to survive,
     * since assignment into a keyed map is the only reason a replay lands on the
     * same numbers.
     *
     * **Its own deadline, the same one `beforeAll` gives the same call.** A
     * rebuild costs a round trip per event in the *log*, not per row in this
     * table (`projection.ts`), so what it takes is decided by how much history the
     * shared test database is carrying and not by anything this file seeded. The
     * file's 60s default was the one number here that assumed otherwise, and on
     * 2026-09-11 a swept-up test log of 2,688 events walked past it — the same
     * rebuild two lines above, under 120s, passed. Two limits on one call was the
     * bug; the log's length is kept in hand by `test-support/teardown.ts`.
     */
    it('rebuilds to exactly what the incremental path produced', async () => {
      const before = await readTasks({ project: PROJECT })
      await build()
      const after = await readTasks({ project: PROJECT })

      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    }, 120_000)

    /**
     * Retention filters, it does not delete. If the projection dropped old rows
     * its contents would depend on when it last ran, and a rebuild would no longer
     * reproduce itself.
     */
    it('filters a landed task out of the window while keeping its row', async () => {
      const visible = await readTasks({ project: PROJECT, retentionDays: 0 })
      expect(card(visible, 5)).toBeUndefined()
      // Still queued and running tasks — the filter is about closed ones only.
      expect(card(visible, 1)).toBeDefined()

      const kept = await readTasks({ project: PROJECT, retentionDays: 3650 })
      expect(card(kept, 5)?.note).toBe('abc1234def')
    })
  })
})
