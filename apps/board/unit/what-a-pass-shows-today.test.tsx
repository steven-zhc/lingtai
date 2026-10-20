import type { StepPlan } from '@lingtai/conductor/filter'
/**
 * #482: what today's code shows for the history rows and the progress strip,
 * for every ending `what-a-pass-writes-today.test.ts` (#461) pins — before
 * #484 is free to rewrite `task.ts`'s `groupHistory` and `progress.ts`'s
 * `foldProgress` onto the read model (`waitsOf`/`routesOf`/`stepOutcomesOf`).
 *
 * **Mirrored, not imported.** #461's rows are `it`s inside a conductor test
 * that drives a real pass through fakes with ~1000 lines of its own setup;
 * none of it is exported (`doc/design/466.md:116`). Every row below rebuilds
 * `typesOf(theItem)` and `typesOf(theRun)` wherever that conductor test's own
 * `it` block asserts them — captured by actually running that file's own
 * fixtures once (`packages/conductor/test/one-pass.ts`) and copying the full
 * payloads back, so every field below is a real wire shape today's pass wrote
 * and not an invented one. **Not every row asserts both sequences there**:
 * 13b no item-side, 14c and 14d neither, 15/15b/15c no item-side (a declined
 * `claim` writes nothing on the work-item stream, see below), and row 16
 * (`:1786`) asserts individual payload fields rather than either sequence —
 * for those, the payloads below are still copied from the same captured run,
 * there is simply no `typesOf` call in the companion file to point a
 * disagreement at. The row number and the conductor test's own line number
 * are on each fixture's declaration; that file is the authority if the two
 * ever disagree.
 *
 * **Two helpers, so #484 edits two bodies and not forty literals.** `historyOf`
 * routes through `groupHistory` (`task.ts`) and `stripOf` through
 * `foldProgress`/`Segs` (`progress.ts`, `rail.tsx`) exactly as the task page
 * draws them (`task/[id]/page.tsx:264`'s own `labels`). If #484 moves the page
 * onto `stepOutcomesOf`/`routesOf`, these two functions are what change —
 * every literal below stays put, which is the whole point of pinning through
 * a helper rather than at the call site (0118 §1, #480).
 *
 * `historyOf` drops `at`, `seq` and `raw`: clock and log noise, not something
 * a person reads as meaning (`waiting-card.test.tsx`'s header makes the same
 * cut for the same reason). **It also drops `documents`** — the multi-line
 * blocks `splitPayload` lifts out of a payload string for `<Document>` to
 * render (`history.ts:53`, `history-row.tsx:32`), which several rows below
 * carry on `StepFailed.evidence` or `PassRouted.why`. That is a real text a
 * person loses: `StepFailed`'s own `summary` is `${stepAt(d)} — N finding(s)`
 * and never repeats `evidence` (`history.ts:303-307`), and `PassRouted`'s
 * `summary` runs its `why` through `clip`'s 160-character cut
 * (`history.ts:90-97`), so a long `why` loses its tail on the summary line
 * even where it survives on the document. `documentsOf` below checks the
 * `field` path separately for exactly that reason — a rewrite that stops
 * lifting a document, or relabels its `field`, is not something comparing
 * `summary` strings would catch, so it is not left to them. `stripOf` reduces
 * the rendered `<Segs>` markup to
 * one `{step, state}` pair per segment — the rail's own information content —
 * rather than pinning the raw HTML, which would fail on an incidental
 * attribute change that pins nothing real.
 *
 * **`RunStarted`'s summary falls to the raw-payload fallback on every row
 * here**, because this harness's fake runtime always answers `model: ''` and
 * `summarise`'s own `need()` throws on an empty string (`history.ts:108`) —
 * a real fact about today's code against this fixture, not a mistake in it.
 *
 * One `StepPlan`, empty, for every fixture that carries a real
 * `StepsResolved`: `foldProgress` reads a step's planned actions off the
 * run's own `StepsResolved` first and the passed-in plan only as a fallback
 * before that event lands (`progress.ts:539`), so for those rows the empty
 * plan is inert except for `claim`, `admit` and `implement`'s own defaults,
 * whose `planned` is `[]` by the recipe's own `steps: {}` and whose state is
 * read off the verdict regardless (the big comment on `StepState`,
 * `progress.ts:60-76`).
 *
 * **Rows 15, 15b and 15c pin no strip and no run-side history at all.** A
 * decline at `claim` never writes a `TicketClaimed`, so `claimsOf(own)`
 * (`task.ts:973`) is `[]` for this run; `loadTask` reads a run's own stream
 * only through `streams = claims.map((c) => eventStore.read(c.runId))`
 * (`task.ts:1485`), so that stream is never read, and `foldProgress` is never
 * called for it either (`task.ts:1541-1542` gates on `folded.length - 1 >=
 * 0`, and `folded = claims.map(...)` is `[]`). `history: groupHistory([...own,
 * ...streams.flat()], attempts)` (`task.ts:1578`) therefore folds `own`
 * alone — empty for rows 15 and 15b, whose item stream carries nothing of
 * this run's (row 15b's item stream does carry a `TicketClaimed`, but by
 * `pass-somebody-else`, left out here per the note on `RUN_15b` below rather
 * than pinned as if this run had written it), and just the two
 * `TicketReleased`/`IssueUpdated` events for row 15c. None of the three
 * calls `stripOf`, and none hands `historyOf` a fabricated `attempts` entry
 * for this run — either would pin a page view this ending never produces.
 *
 * **Rows 4 and 16 pin no strip either, for the same reason.** Both items end
 * on `TicketReleased`, which `work-item.ts:329` folds to `lifecycle.status:
 * 'backlog'` and `standingOf` reports as `'queued'` (`task.ts:692`).
 * `loadTask` calls `planFor` only for `'running'` or `'blocked'`
 * (`task.ts:1525-1527`), so `plan` stays `undefined`; `landed` is `false`
 * (the item never lands here); and `task.ts:1541`'s gate,
 * `last >= 0 && (landed || plan !== undefined)`, is false — `foldProgress` is
 * never called on the last attempt, `run.progress` stays `null`, and the task
 * page draws the empty-stream paragraph instead of a `<Segs>` strip. Pinning
 * a strip for either row would be the same invented page view the paragraph
 * above refuses for 15/15b/15c.
 */
import type { Envelope, EventType } from '@lingtai/domain'
import { makeStream } from '@lingtai/domain/test/support'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { Segs } from '../src/app/rail.tsx'
import { foldProgress } from '../src/lib/progress.ts'
import { groupHistory } from '../src/lib/task.ts'

/** One event, loosely typed: every fixture below is a real captured payload, re-validated through `makeStream`'s own `parsePayload`. */
interface EventSpec {
  type: string
  data: unknown
}

/** Replays a row's captured events onto one stream, in capture order — `makeStream` assigns `seq`/`version`, and validates as it goes. */
function envelopesFor(streamId: string, specs: readonly EventSpec[]): Envelope[] {
  const event = makeStream(streamId)
  return specs.map((s) => event(s.type as EventType, s.data as never))
}

/** `groupHistory`, reduced to what a person reads: the group label and each line's type/actor/summary. */
function historyOf(events: readonly Envelope[], attempts: ReadonlyMap<string, number>) {
  return groupHistory(events, attempts).map((g) => ({
    label: g.label,
    lines: g.lines.map((l) => ({ type: l.type, actor: l.actor, summary: l.summary })),
  }))
}

/**
 * `historyOf`'s own blind spot (header): the `field` path of every document
 * `splitPayload` lifted out of a line's payload, in the order the lines
 * themselves appear. `summary` does not carry this text, so a rewrite that
 * stops lifting one of these, or relabels its `field`, is caught here rather
 * than nowhere.
 */
function documentsOf(events: readonly Envelope[], attempts: ReadonlyMap<string, number>) {
  return groupHistory(events, attempts)
    .flatMap((g) => g.lines)
    .flatMap((l) => l.documents.map((d) => ({ type: l.type, field: d.field })))
}

const EMPTY_PLAN: StepPlan = new Map()

/** `foldProgress` + `<Segs labels>`, reduced to one `{step, state}` pair per segment — the rail's own information content. */
function stripOf(
  runEvents: readonly Envelope[],
  landed: boolean,
  plan: StepPlan = EMPTY_PLAN,
): { step: string; state: string }[] {
  const progress = foldProgress(runEvents, plan, landed)
  const html = renderToStaticMarkup(<Segs steps={progress?.steps ?? []} at={null} labels />)
  return [...html.matchAll(/<li class="seg s-([a-z-]+)"[^>]*>.*?<span class="slab [^"]*">([a-z]+)<\/span><\/li>/g)].map(
    (m) => ({ step: m[2]!, state: m[1]! }),
  )
}

// Row 1, `what-a-pass-writes-today.test.ts:162` — see the it() title below
const ITEM_1: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'TicketLanded',
    data: {
      mergeCommit: 'cccccccccccccccccccccccccccccccccccccccc',
      base: 'main',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: '',
    },
  },
]
const RUN_1: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-948f181b-7a61-4047-9df6-efd4055de687 at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/pass-948f181b-7a61-4047-9df6-efd4055de687',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: [],
        },
        {
          step: 'proposed',
          actions: [],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 2,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 3,
      durationMs: 1234,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      outcome: {
        step: 'review',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      step: 'proposed',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      outcome: {
        step: 'proposed',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      step: 'merge',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-948f181b-7a61-4047-9df6-efd4055de687',
      outcome: {
        step: 'merge',
        round: 0,
        actions: [
          {
            plugin: 'merge',
            name: 'land the branch',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'merged as ccccccc',
            yields: 'merge',
            result: {
              _tag: 'Completed',
              integration: {
                _tag: 'Integrated',
                mergeSha: 'cccccccccccccccccccccccccccccccccccccccc',
              },
            },
          },
        ],
      },
    },
  },
]

it('1. lands with no rounds spent', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_1)
  const runEvents = envelopesFor('pass-948f181b-7a61-4047-9df6-efd4055de687', RUN_1)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-948f181b-7a61-4047-9df6-efd4055de687', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 948f181b',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'TicketLanded',
          actor: 'conductor',
          summary: 'merged as ccccccc',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels:',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/pass-948f181b-7a6\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '3 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 step=review round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 outcome={"step":"review","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 step=proposed round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 outcome={"step":"proposed","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-948f181b-7a61-4047-9df6-efd4055de687 step=merge round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'merge \u00b7 land the branch',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, true)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'passed',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'skipped',
    },
    {
      step: 'proposed',
      state: 'skipped',
    },
    {
      step: 'merge',
      state: 'passed',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 2, `what-a-pass-writes-today.test.ts:223` — see the it() title below
const ITEM_2: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'TicketLanded',
    data: {
      mergeCommit: 'cccccccccccccccccccccccccccccccccccccccc',
      base: 'main',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: '',
    },
  },
]
const RUN_2: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-616d382e-4955-46be-9aa8-147e8eaeb58a at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      worktree: '/tmp/fake/pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: ['cold reviewer'],
        },
        {
          step: 'proposed',
          actions: ['the lines, until the rounds are spent'],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 1,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              judge: 'same-worktree',
              name: 'the lines, until the rounds are spent',
              when: 'findings',
            },
          ],
          review: [
            {
              agent: 'claude-code',
              name: 'cold reviewer',
              prompt: 'look for races',
            },
          ],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 3,
      durationMs: 1234,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'review',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
            yields: 'verdict',
            result: {
              _tag: 'Completed',
              assessment: {
                verdict: 'refused',
                findings: [
                  {
                    file: 'src/fix.ts',
                    line: 12,
                    claim: 'the approach cannot work',
                    failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
                    severity: 'blocker',
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'implement',
      round: 1,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 1,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'implement',
        round: 1,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'committed ddddddd',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'dddddddddddddddddddddddddddddddddddddddd',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'build',
      round: 1,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'build',
        round: 1,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'review',
      round: 1,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 1,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'review',
        round: 1,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'dddddddddddddddddddddddddddddddddddddddd',
            evidence: 'no findings\n\n(3 turns)',
            yields: 'verdict',
            result: {
              _tag: 'Completed',
              assessment: {
                verdict: 'accepted',
                findings: [],
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'proposed',
      round: 1,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'proposed',
        round: 1,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      step: 'merge',
      round: 1,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      outcome: {
        step: 'merge',
        round: 1,
        actions: [
          {
            plugin: 'merge',
            name: 'land the branch',
            onSha: 'dddddddddddddddddddddddddddddddddddddddd',
            evidence: 'merged as ccccccc',
            yields: 'merge',
            result: {
              _tag: 'Completed',
              integration: {
                _tag: 'Integrated',
                mergeSha: 'cccccccccccccccccccccccccccccccccccccccc',
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-616d382e-4955-46be-9aa8-147e8eaeb58a',
      offer: {
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'src/fix.ts',
              line: 12,
              claim: 'the approach cannot work',
              failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
              severity: 'blocker',
            },
          ],
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'Selected',
        candidate: 'fix-lines',
        why: 'the "the lines, until the rounds are spent" judge: the recipe declares `judge: same-worktree` for a "findings"',
      },
      decision: {
        _tag: 'Selected',
        candidate: 'fix-lines',
      },
    },
  },
]

it('2. lands after one fix round (review lines, judge, implement, green)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_2)
  const runEvents = envelopesFor('pass-616d382e-4955-46be-9aa8-147e8eaeb58a', RUN_2)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-616d382e-4955-46be-9aa8-147e8eaeb58a', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 616d382e',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'TicketLanded',
          actor: 'conductor',
          summary: 'merged as ccccccc',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels:',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a worktree=/tmp/fake/pass-616d382e-495\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines, until the rounds are spent \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '3 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=review round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer \u2014 1 finding',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=implement round=1',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":1} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=build round=1',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a outcome={"step":"build","round":1,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=review round=1',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":1} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=proposed round=1',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a outcome={"step":"proposed","round":1,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a step=merge round=1',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'merge \u00b7 land the branch',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'runId=pass-616d382e-4955-46be-9aa8-147e8eaeb58a offer={"proposal":{"_tag":"ReviewFindings","findings":[{"file":"src/fix.ts","line":12,"claim":"the approach cannot work","failureScenario":"call it twice and the second call deadlocks on the \u2026',
        },
      ],
    },
  ])
  expect(documentsOf(all, attempts)).toEqual([
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
  ])
  expect(stripOf(runEvents, true)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'passed',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'passed',
    },
    {
      step: 'proposed',
      state: 'never-ran',
    },
    {
      step: 'merge',
      state: 'passed',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 4, `what-a-pass-writes-today.test.ts:347` — see the it() title below
const ITEM_4: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'TicketReleased',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      reason:
        'the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 1',
      cause: {
        _tag: 'Restart',
        restart: 1,
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: '',
    },
  },
]
const RUN_4: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-0f01bef6-2cf7-4540-b28b-525822a76083 at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745',
      worktree: '/tmp/fake/pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      configHash: '742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: ['cold reviewer'],
        },
        {
          step: 'proposed',
          actions: ['the lines or the approach'],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 1,
            rounds: 1,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              judge: 'claude-code',
              name: 'the lines or the approach',
              when: 'findings',
            },
          ],
          review: [
            {
              agent: 'claude-code',
              name: 'cold reviewer',
              prompt: 'look for races',
            },
          ],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 5,
      durationMs: 2000,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      outcome: {
        step: 'review',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
            yields: 'verdict',
            result: {
              _tag: 'Completed',
              assessment: {
                verdict: 'refused',
                findings: [
                  {
                    file: 'src/fix.ts',
                    line: 12,
                    claim: 'the approach cannot work',
                    failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
                    severity: 'blocker',
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Judge',
        when: 'findings',
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-0f01bef6-2cf7-4540-b28b-525822a76083',
      offer: {
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'src/fix.ts',
              line: 12,
              claim: 'the approach cannot work',
              failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
              severity: 'blocker',
            },
          ],
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'restart',
            next: {
              _tag: 'Requeued',
              cause: {
                _tag: 'Restart',
                restart: 1,
              },
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [],
      },
      reply: {
        _tag: 'Selected',
        candidate: 'restart',
        why: 'the "the lines or the approach" judge: start over from a clean worktree (claude-code \u00b7 5 turns, $1.25)',
      },
      decision: {
        _tag: 'Selected',
        candidate: 'restart',
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('4. a judge restarts the pass (`PassRestarted`, `TicketReleased`)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_4)
  const runEvents = envelopesFor('pass-0f01bef6-2cf7-4540-b28b-525822a76083', RUN_4)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-0f01bef6-2cf7-4540-b28b-525822a76083', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 0f01bef6',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'TicketReleased',
          actor: 'conductor',
          summary:
            'run 0f01bef6: the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels:',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0f01bef6-2cf7-4540-b28b-525822a76083 step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0f01bef6-2cf7-4540-b28b-525822a76083 step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-0f01bef6-2cf7-4540-b28b-525822a76083 outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0f01bef6-2cf7-4540-b28b-525822a76083 step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-0f01bef6-2cf7-4540-b28b-525822a76083 outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0f01bef6-2cf7-4540-b28b-525822a76083 step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745 worktree=/tmp/fake/pass-0f01bef6-2cf\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines or the approach \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '5 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0f01bef6-2cf7-4540-b28b-525822a76083 step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-0f01bef6-2cf7-4540-b28b-525822a76083 outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0f01bef6-2cf7-4540-b28b-525822a76083 step=review round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer \u2014 1 finding',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Judge","when":"findings"} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary: 'restart 1',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(documentsOf(all, attempts)).toEqual([
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
  ])
})

// Row 5, `what-a-pass-writes-today.test.ts:471` — see the it() title below
const ITEM_5: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-606f36ee-d027-4767-91a9-de02c1805218',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'TicketReleased',
    data: {
      runId: 'pass-606f36ee-d027-4767-91a9-de02c1805218',
      reason:
        'the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 1',
      cause: {
        _tag: 'Restart',
        restart: 1,
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: '',
    },
  },
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: '81eafb82-b085-4933-b091-aa0b8413ca13',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
        },
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'src/fix.ts',
              line: 12,
              claim: 'the approach cannot work',
              failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
              severity: 'blocker',
            },
          ],
        },
        because: {
          _tag: 'CandidateUnavailable',
          excluded: {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_5: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9 at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1+failure@cc4f1d57d997',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745',
      worktree: '/tmp/fake/pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      configHash: '742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: ['cold reviewer'],
        },
        {
          step: 'proposed',
          actions: ['the lines or the approach'],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 1,
            rounds: 1,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              judge: 'claude-code',
              name: 'the lines or the approach',
              when: 'findings',
            },
          ],
          review: [
            {
              agent: 'claude-code',
              name: 'cold reviewer',
              prompt: 'look for races',
            },
          ],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 5,
      durationMs: 2000,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      outcome: {
        step: 'review',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
            yields: 'verdict',
            result: {
              _tag: 'Completed',
              assessment: {
                verdict: 'refused',
                findings: [
                  {
                    file: 'src/fix.ts',
                    line: 12,
                    claim: 'the approach cannot work',
                    failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
                    severity: 'blocker',
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Judge',
        when: 'findings',
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      offer: {
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'src/fix.ts',
              line: 12,
              claim: 'the approach cannot work',
              failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
              severity: 'blocker',
            },
          ],
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'Selected',
        candidate: 'restart',
        why: 'the "the lines or the approach" judge: start over from a clean worktree (claude-code \u00b7 5 turns, $1.25)',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'CandidateUnavailable',
          excluded: {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-2',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9',
      outcome: {
        step: 'proposed',
        round: 0,
        actions: [
          {
            plugin: 'conductor',
            name: 'judge',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'Merge agent/7 into main anyway? agent/7 into main is waiting on you. the judge chose `restart`, and `restarts` is spent',
            yields: 'signoff',
            result: {
              _tag: 'Completed',
              requested: {
                question:
                  'Merge agent/7 into main anyway? agent/7 into main is waiting on you. the judge chose `restart`, and `restarts` is spent',
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-2',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('5. restarts spent: the second arrival holds, not requeues', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_5)
  const runEvents = envelopesFor('pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9', RUN_5)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9', 2]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 606f36ee',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'TicketReleased',
          actor: 'conductor',
          summary:
            'run 606f36ee: the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels:',
        },
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 39b684e6',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary: 'judgement: agent/7 is waiting on you. the judge chose `restart`, and `restarts` is spent',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 2',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9 step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9 step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9 outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9 step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9 outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9 step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1+failure@cc4f1d57d997 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745 worktree=/tmp/f\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines or the approach \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '5 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9 step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9 outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-39b684e6-de0e-4f16-92f5-d049b83e2ec9 step=review round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer \u2014 1 finding',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Judge","when":"findings"} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary: 'review \u2192 waiting \u2014 is waiting on you. the judge chose `restart`, and `restarts` is spent',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-2 at bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary:
            'proposed \u00b7 judge \u2014 Merge agent/7 into main anyway? agent/7 into main is waiting on you. the judge chose `restart`, and `restarts` is spent',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-2 at bbbbbbb',
        },
      ],
    },
  ])
  expect(documentsOf(all, attempts)).toEqual([
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'passed',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'failed',
    },
    {
      step: 'proposed',
      state: 'pending',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 6, `what-a-pass-writes-today.test.ts:585` — see the it() title below
const ITEM_6: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: '26d5f4bc-e910-4172-9f32-779722b921e7',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
        },
        proposal: {
          _tag: 'NothingProduced',
          said: 'the agent produced no commits',
        },
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_6: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20 at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: [],
        },
        {
          step: 'proposed',
          actions: [],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 2,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 3,
      durationMs: 1234,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'the agent produced no commits',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: null,
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20',
      offer: {
        proposal: {
          _tag: 'NothingProduced',
          said: 'the agent produced no commits',
        },
        available: [
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'fix-lines',
            because: {
              _tag: 'NoCriterion',
            },
          },
          {
            id: 'restart',
            because: {
              _tag: 'NoCriterion',
            },
          },
        ],
      },
      reply: {
        _tag: 'NotAsked',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: null,
      outcome: 'nothing-committed',
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: null,
      outcome: 'nothing-committed',
      detail: null,
    },
  },
]

it('6. `implement` produces no commits at round 0 (`StepDidNotFinish`, `DidNotFinish`)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_6)
  const runEvents = envelopesFor('pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20', RUN_6)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 90cecc5b',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary: 'acknowledgement: the `implement` step did-not-finish: the agent produced no commits',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20 step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20 step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20 outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20 step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20 outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-90cecc5b-b272-4486-b9ad-bcb305fc0c20 step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/pass-90cecc5b-b27\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '3 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change \u2014 did not finish: the agent produced no commits',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary: 'implement \u2192 waiting \u2014 the `implement` step did-not-finish: the agent produced no commits',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'nothing committed, so no ref was left',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'nothing committed, so no ref was left',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'did-not-finish',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'skipped',
    },
    {
      step: 'proposed',
      state: 'skipped',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 7, `what-a-pass-writes-today.test.ts:705` — see the it() title below
const ITEM_7: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: '36d158b3-51c2-43cb-82cd-be9937e89494',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
        },
        proposal: {
          _tag: 'FixerDisagrees',
          said: '{"findings":[{"file":"src/fix.ts","line":12,"severity":"blocker","claim":"the approach cannot work","failureScenario":"call it twice and the second call deadlocks on the lock the first took"}]}',
        },
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_7: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-a8a50213-6f4b-422f-8858-157e890b1af6 at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      worktree: '/tmp/fake/pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: ['cold reviewer'],
        },
        {
          step: 'proposed',
          actions: ['the lines, until the rounds are spent'],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 1,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              judge: 'same-worktree',
              name: 'the lines, until the rounds are spent',
              when: 'findings',
            },
          ],
          review: [
            {
              agent: 'claude-code',
              name: 'cold reviewer',
              prompt: 'look for races',
            },
          ],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 5,
      durationMs: 2000,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      outcome: {
        step: 'review',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
            yields: 'verdict',
            result: {
              _tag: 'Completed',
              assessment: {
                verdict: 'refused',
                findings: [
                  {
                    file: 'src/fix.ts',
                    line: 12,
                    claim: 'the approach cannot work',
                    failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
                    severity: 'blocker',
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      step: 'implement',
      round: 1,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 1,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      outcome: {
        step: 'implement',
        round: 1,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence:
              '{"findings":[{"file":"src/fix.ts","line":12,"severity":"blocker","claim":"the approach cannot work","failureScenario":"call it twice and the second call deadlocks on the lock the first took"}]}',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: null,
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      offer: {
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'src/fix.ts',
              line: 12,
              claim: 'the approach cannot work',
              failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
              severity: 'blocker',
            },
          ],
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'Selected',
        candidate: 'fix-lines',
        why: 'the "the lines, until the rounds are spent" judge: the recipe declares `judge: same-worktree` for a "findings"',
      },
      decision: {
        _tag: 'Selected',
        candidate: 'fix-lines',
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-a8a50213-6f4b-422f-8858-157e890b1af6',
      offer: {
        proposal: {
          _tag: 'FixerDisagrees',
          said: '{"findings":[{"file":"src/fix.ts","line":12,"severity":"blocker","claim":"the approach cannot work","failureScenario":"call it twice and the second call deadlocks on the lock the first took"}]}',
        },
        available: [
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'fix-lines',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'rounds',
            },
          },
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'NotAsked',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('7. `implement` changes nothing in a fix round (`FixDeclined`/`Declined`)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_7)
  const runEvents = envelopesFor('pass-a8a50213-6f4b-422f-8858-157e890b1af6', RUN_7)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-a8a50213-6f4b-422f-8858-157e890b1af6', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run a8a50213',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary:
            'judgement: the `implement` step declined: {"findings":[{"file":"src/fix.ts","line":12,"severity":"blocker","claim":"the approach cannot work","failureScenario":"call it t\u2026',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a worktree=/tmp/fake/pass-a8a50213-6f4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines, until the rounds are spent \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '5 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 step=review round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer \u2014 1 finding',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 step=implement round=1',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":1} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary:
            'implement \u00b7 write the change \u2014 did not finish: {"findings":[{"file":"src/fix.ts","line":12,"severity":"blocker","claim":"the approach cannot work","failureScenario":"call it twice and the second call deadlo…',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'runId=pass-a8a50213-6f4b-422f-8858-157e890b1af6 offer={"proposal":{"_tag":"ReviewFindings","findings":[{"file":"src/fix.ts","line":12,"claim":"the approach cannot work","failureScenario":"call it twice and the second call deadlocks on the \u2026',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'implement \u2192 waiting \u2014 the `implement` step declined: {"findings":[{"file":"src/fix.ts","line":12,"severity":"blocker","claim":"the approach cannot work","failureScenario":"call it t\u2026',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(documentsOf(all, attempts)).toEqual([
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'did-not-finish',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'failed',
    },
    {
      step: 'proposed',
      state: 'pending',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 9, `what-a-pass-writes-today.test.ts:812` — see the it() title below
const ITEM_9: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: '1cf2d3f4-61c9-4314-ba02-3b13e50b611b',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
        },
        proposal: {
          _tag: 'CheckRefused',
          from: 'merge',
          output: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
        },
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_9: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '6353c1eaf44d11c9b8723dc1c6b369209b31628728428e2067daf91d848cf93b',
      worktree: '/tmp/fake/pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      configHash: '6353c1eaf44d11c9b8723dc1c6b369209b31628728428e2067daf91d848cf93b',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: [],
        },
        {
          step: 'proposed',
          actions: [],
        },
        {
          step: 'merge',
          actions: ['check', 'land the branch'],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 2,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [
            {
              agent: 'claude-code',
              name: 'check',
              prompt: 'does this look safe to land',
            },
            {
              merge: {
                strategy: 'merge-commit',
              },
              name: 'land the branch',
            },
          ],
          prepared: [],
          proposed: [],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 5,
      durationMs: 2000,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      outcome: {
        step: 'review',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      step: 'proposed',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      outcome: {
        step: 'proposed',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      step: 'merge',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'merge',
        name: 'check',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      outcome: {
        step: 'merge',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'check',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
            yields: 'verdict',
            result: {
              _tag: 'Completed',
              assessment: {
                verdict: 'refused',
                findings: [
                  {
                    file: 'src/fix.ts',
                    line: 12,
                    claim: 'the approach cannot work',
                    failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
                    severity: 'blocker',
                  },
                ],
              },
            },
          },
          {
            plugin: 'merge',
            name: 'land the branch',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: '',
            yields: 'merge',
            result: {
              _tag: 'NotReached',
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      offer: {
        proposal: {
          _tag: 'CheckRefused',
          from: 'merge',
          output: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'NotAsked',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb',
      outcome: {
        step: 'merge',
        round: 0,
        actions: [
          {
            plugin: 'conductor',
            name: 'unfixed',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence:
              'Merge agent/7 into main anyway? the `merge` step refused: blocker src/fix.ts:12 — the approach cannot work\n\n(5 turns) (`check`)',
            yields: 'signoff',
            result: {
              _tag: 'Completed',
              requested: {
                question:
                  'Merge agent/7 into main anyway? the `merge` step refused: blocker src/fix.ts:12 — the approach cannot work\n\n(5 turns) (`check`)',
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('9. a check before the lane at `merge` refuses (`CheckRed`)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_9)
  const runEvents = envelopesFor('pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb', RUN_9)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 19b36007',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary:
            'acknowledgement: the `merge` step refused: blocker src/fix.ts:12 \u2014 the approach cannot work (5 turns)',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=6353c1eaf44d11c9b8723dc1c6b369209b31628728428e2067daf91d848cf93b worktree=/tmp/fake/pass-19b36007-e37\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge check+land the branch \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '5 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb step=review round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb outcome={"step":"review","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb step=proposed round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb outcome={"step":"proposed","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-19b36007-e37f-41a9-b3b4-89a2ff5600cb step=merge round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"merge","name":"check","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'merge \u00b7 check \u2014 1 finding',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'merge \u2192 waiting \u2014 the `merge` step refused: blocker src/fix.ts:12 \u2014 the approach cannot work (5 turns)',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary:
            'merge \u00b7 unfixed \u2014 Merge agent/7 into main anyway? the `merge` step refused: blocker src/fix.ts:12 \u2014 the approach cannot work (5 turns) (`check`)',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(documentsOf(all, attempts)).toEqual([
    {
      type: 'WaitStarted',
      field: 'reason.proposal.output',
    },
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
    {
      type: 'PassRouted',
      field: 'offer.proposal.output',
    },
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].result.requested.question',
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'passed',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'skipped',
    },
    {
      step: 'proposed',
      state: 'skipped',
    },
    {
      step: 'merge',
      state: 'failed',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 10a, `what-a-pass-writes-today.test.ts:900` — see the it() title below
const ITEM_10a: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: 'ef8d6370-8feb-4fd0-9c7a-29822d650afb',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
        },
        proposal: {
          _tag: 'MergeConflict',
          output: 'both sides touched src/fix.ts',
          paths: null,
          baseSha: null,
          headSha: null,
        },
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_10a: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-1ba1768c-940f-4433-9095-fe318e6519df at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/pass-1ba1768c-940f-4433-9095-fe318e6519df',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: [],
        },
        {
          step: 'proposed',
          actions: [],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 2,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 3,
      durationMs: 1234,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      outcome: {
        step: 'review',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      step: 'proposed',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      outcome: {
        step: 'proposed',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      step: 'merge',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      outcome: {
        step: 'merge',
        round: 0,
        actions: [
          {
            plugin: 'merge',
            name: 'land the branch',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'both sides touched src/fix.ts',
            yields: 'merge',
            result: {
              _tag: 'Completed',
              integration: {
                _tag: 'Conflicted',
                paths: null,
                baseSha: null,
                headSha: null,
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      offer: {
        proposal: {
          _tag: 'MergeConflict',
          output: 'both sides touched src/fix.ts',
          paths: null,
          baseSha: null,
          headSha: null,
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [],
      },
      reply: {
        _tag: 'NotAsked',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-1ba1768c-940f-4433-9095-fe318e6519df',
      outcome: {
        step: 'merge',
        round: 0,
        actions: [
          {
            plugin: 'conductor',
            name: 'unfixed',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence:
              'Merge agent/7 into main anyway? agent/7 into main is waiting on you. both sides touched src/fix.ts (`land the branch`)',
            yields: 'signoff',
            result: {
              _tag: 'Completed',
              requested: {
                question:
                  'Merge agent/7 into main anyway? agent/7 into main is waiting on you. both sides touched src/fix.ts (`land the branch`)',
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('10a. the merge lane refuses on a conflict (`Routed{when: "conflict"}`)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_10a)
  const runEvents = envelopesFor('pass-1ba1768c-940f-4433-9095-fe318e6519df', RUN_10a)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-1ba1768c-940f-4433-9095-fe318e6519df', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 1ba1768c',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary: 'judgement: agent/7 is waiting on you. both sides touched src/fix.ts \u2014 recommends requeue',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/pass-1ba1768c-940\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '3 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df step=review round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df outcome={"step":"review","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df step=proposed round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df outcome={"step":"proposed","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-1ba1768c-940f-4433-9095-fe318e6519df step=merge round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'merge \u00b7 land the branch',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary: 'merge \u2192 waiting \u2014 is waiting on you. both sides touched src/fix.ts',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary:
            'merge \u00b7 unfixed \u2014 Merge agent/7 into main anyway? agent/7 into main is waiting on you. both sides touched src/fix.ts (`land the branch`)',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'passed',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'skipped',
    },
    {
      step: 'proposed',
      state: 'skipped',
    },
    {
      step: 'merge',
      state: 'failed',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 10b, `what-a-pass-writes-today.test.ts:988` — see the it() title below
const ITEM_10b: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: '6e27d9cf-0b51-4587-a5ea-ace15ed01169',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
        },
        proposal: {
          _tag: 'MergeRefused',
          reason: 'dirty-base',
          output: 'main moved under it',
        },
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_10b: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-5631c913-c309-4330-9d68-512fc7caa03f at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/pass-5631c913-c309-4330-9d68-512fc7caa03f',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: [],
        },
        {
          step: 'proposed',
          actions: [],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 2,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 3,
      durationMs: 1234,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      outcome: {
        step: 'review',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      step: 'proposed',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      outcome: {
        step: 'proposed',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      step: 'merge',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      outcome: {
        step: 'merge',
        round: 0,
        actions: [
          {
            plugin: 'merge',
            name: 'land the branch',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'main moved under it',
            yields: 'merge',
            result: {
              _tag: 'Completed',
              integration: {
                _tag: 'IntegrationRefused',
                reason: 'dirty-base',
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      offer: {
        proposal: {
          _tag: 'MergeRefused',
          reason: 'dirty-base',
          output: 'main moved under it',
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'NotAsked',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-5631c913-c309-4330-9d68-512fc7caa03f',
      outcome: {
        step: 'merge',
        round: 0,
        actions: [
          {
            plugin: 'conductor',
            name: 'unfixed',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'Merge agent/7 into main anyway? dirty-base: main moved under it (`land the branch`)',
            yields: 'signoff',
            result: {
              _tag: 'Completed',
              requested: {
                question: 'Merge agent/7 into main anyway? dirty-base: main moved under it (`land the branch`)',
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('10b. the merge lane refuses on a dirty base (`MergeRefused`)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_10b)
  const runEvents = envelopesFor('pass-5631c913-c309-4330-9d68-512fc7caa03f', RUN_10b)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-5631c913-c309-4330-9d68-512fc7caa03f', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 5631c913',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary: 'acknowledgement: dirty-base: main moved under it',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/pass-5631c913-c30\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '3 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f step=review round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f outcome={"step":"review","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f step=proposed round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f outcome={"step":"proposed","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-5631c913-c309-4330-9d68-512fc7caa03f step=merge round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'merge \u00b7 land the branch',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary: 'merge \u2192 waiting \u2014 dirty-base: main moved under it',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'merge \u00b7 unfixed \u2014 Merge agent/7 into main anyway? dirty-base: main moved under it (`land the branch`)',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'passed',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'skipped',
    },
    {
      step: 'proposed',
      state: 'skipped',
    },
    {
      step: 'merge',
      state: 'failed',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 11, `what-a-pass-writes-today.test.ts:1086` — see the it() title below
const ITEM_11: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-204c6511-9f2f-446d-a41f-e00fdfeae742',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: '4ecc3007-a49d-4f29-9fb1-39688f2d120e',
      reason: {
        _tag: 'AgentQuestion',
        run: {
          runId: 'pass-204c6511-9f2f-446d-a41f-e00fdfeae742',
        },
        step: 'design',
        question: 'The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_11: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-204c6511-9f2f-446d-a41f-e00fdfeae742',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-204c6511-9f2f-446d-a41f-e00fdfeae742',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-204c6511-9f2f-446d-a41f-e00fdfeae742 at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-204c6511-9f2f-446d-a41f-e00fdfeae742',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-204c6511-9f2f-446d-a41f-e00fdfeae742',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-204c6511-9f2f-446d-a41f-e00fdfeae742',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'design',
        name: 'draft',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 2,
      durationMs: 1234,
      usage: [],
      costUsd: 0.21,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-204c6511-9f2f-446d-a41f-e00fdfeae742',
      outcome: {
        step: 'design',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'draft',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
            yields: 'design',
            result: {
              _tag: 'Asked',
              question: 'The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
              draft: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-204c6511-9f2f-446d-a41f-e00fdfeae742',
      offer: {
        proposal: {
          _tag: 'InputNeeded',
          from: 'design',
          question: 'The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
        },
        available: [
          {
            id: 'state-assumption',
            next: {
              _tag: 'FixRound',
              to: 'design',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [],
      },
      reply: {
        _tag: 'NotAsked',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: null,
      outcome: 'nothing-committed',
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: null,
      outcome: 'nothing-committed',
      detail: null,
    },
  },
]

it('11. an agent asks a question (`StepAsked`)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_11)
  const runEvents = envelopesFor('pass-204c6511-9f2f-446d-a41f-e00fdfeae742', RUN_11)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-204c6511-9f2f-446d-a41f-e00fdfeae742', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 204c6511',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary:
            'judgement: the `design` step asked: The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-204c6511-9f2f-446d-a41f-e00fdfeae742 step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-204c6511-9f2f-446d-a41f-e00fdfeae742 step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-204c6511-9f2f-446d-a41f-e00fdfeae742 outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-204c6511-9f2f-446d-a41f-e00fdfeae742 step=design round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"design","name":"draft","round":0} runtime=claude-code turns=2 durationMs=1234 usage=[] costUsd=0.21',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary:
            'design \u00b7 draft \u2014 asked: The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'design \u2192 waiting \u2014 the `design` step asked: The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'nothing committed, so no ref was left',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'nothing committed, so no ref was left',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'asked',
    },
    {
      step: 'implement',
      state: 'skipped',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'skipped',
    },
    {
      step: 'proposed',
      state: 'skipped',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 12, `what-a-pass-writes-today.test.ts:1171` — see the it() title below
const ITEM_12: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: 'd2e320b7-60aa-43a7-9a48-86f23d04d725',
      reason: {
        _tag: 'SignoffRequired',
        run: {
          runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
        },
        step: 'proposed',
        action: 'approval',
        question: "Merge this? It is Lingtai's own code.",
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_12: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-e2696b08-8eae-4345-9b30-3c69547e0634 at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '7007dfe8eb4e956548410da6b95d931b3bb5d549ab4a9484ec8630f51af6fc30',
      worktree: '/tmp/fake/pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      configHash: '7007dfe8eb4e956548410da6b95d931b3bb5d549ab4a9484ec8630f51af6fc30',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: [],
        },
        {
          step: 'proposed',
          actions: ['approval'],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 2,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              human: "Merge this? It is Lingtai's own code.",
              name: 'approval',
            },
          ],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 3,
      durationMs: 1234,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      outcome: {
        step: 'review',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      step: 'proposed',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-e2696b08-8eae-4345-9b30-3c69547e0634',
      outcome: {
        step: 'proposed',
        round: 0,
        actions: [
          {
            plugin: 'human',
            name: 'approval',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: "Merge this? It is Lingtai's own code.",
            yields: 'signoff',
            result: {
              _tag: 'Completed',
              requested: {
                question: "Merge this? It is Lingtai's own code.",
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('12. a declared `human:` at `proposed` (`Human`)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_12)
  const runEvents = envelopesFor('pass-e2696b08-8eae-4345-9b30-3c69547e0634', RUN_12)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-e2696b08-8eae-4345-9b30-3c69547e0634', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run e2696b08',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary: "judgement: the `proposed` step held: Merge this? It is Lingtai's own code.",
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=7007dfe8eb4e956548410da6b95d931b3bb5d549ab4a9484ec8630f51af6fc30 worktree=/tmp/fake/pass-e2696b08-8ea\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed approval \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '3 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 step=review round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 outcome={"step":"review","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-e2696b08-8eae-4345-9b30-3c69547e0634 step=proposed round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: "proposed \u00b7 approval \u2014 Merge this? It is Lingtai's own code.",
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'passed',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'skipped',
    },
    {
      step: 'proposed',
      state: 'pending',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 13, `what-a-pass-writes-today.test.ts:1249` — see the it() title below
const ITEM_13: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: 'b9c1a70d-027a-4123-a047-6817ff4c2cbd',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
        },
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'src/fix.ts',
              line: 12,
              claim: 'the approach cannot work',
              failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
              severity: 'blocker',
            },
          ],
        },
        because: {
          _tag: 'UnreadableReply',
          raw: 'the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (claude-code (haiku) \u00b7 5 turns, $1.25):\nI am not sure what to say here.',
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_13: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '91dc07820041694a822997757e710f0d4da19bb28bd45e959136c3ff5303c92e',
      worktree: '/tmp/fake/pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      configHash: '91dc07820041694a822997757e710f0d4da19bb28bd45e959136c3ff5303c92e',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: ['cold reviewer'],
        },
        {
          step: 'proposed',
          actions: ['the lines or the approach'],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 1,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              judge: 'claude-code',
              limits: {
                turns: 2,
              },
              model: 'haiku',
              name: 'the lines or the approach',
              when: 'findings',
            },
          ],
          review: [
            {
              agent: 'claude-code',
              name: 'cold reviewer',
              prompt: 'look for races',
            },
          ],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 5,
      durationMs: 2000,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      outcome: {
        step: 'review',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
            yields: 'verdict',
            result: {
              _tag: 'Completed',
              assessment: {
                verdict: 'refused',
                findings: [
                  {
                    file: 'src/fix.ts',
                    line: 12,
                    claim: 'the approach cannot work',
                    failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
                    severity: 'blocker',
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Judge',
        when: 'findings',
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      offer: {
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'src/fix.ts',
              line: 12,
              claim: 'the approach cannot work',
              failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
              severity: 'blocker',
            },
          ],
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'Unreadable',
        raw: 'the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (claude-code (haiku) \u00b7 5 turns, $1.25):\nI am not sure what to say here.',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'UnreadableReply',
          raw: 'the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (claude-code (haiku) \u00b7 5 turns, $1.25):\nI am not sure what to say here.',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d',
      outcome: {
        step: 'proposed',
        round: 0,
        actions: [
          {
            plugin: 'conductor',
            name: 'judge',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence:
              'Merge agent/7 into main anyway? agent/7 into main is waiting on you. the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (claude-code (haiku) · 5 turns, $1.25): I am not sure what to say here.',
            yields: 'signoff',
            result: {
              _tag: 'Completed',
              requested: {
                question:
                  'Merge agent/7 into main anyway? agent/7 into main is waiting on you. the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (claude-code (haiku) · 5 turns, $1.25): I am not sure what to say here.',
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('13. a judge answer is unreadable', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_13)
  const runEvents = envelopesFor('pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d', RUN_13)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run c7908588',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary:
            'judgement: agent/7 is waiting on you. the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was not readable as one of the steps it was off\u2026',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=91dc07820041694a822997757e710f0d4da19bb28bd45e959136c3ff5303c92e worktree=/tmp/fake/pass-c7908588-018\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines or the approach \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '5 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-c7908588-018d-4b8b-bb1a-488dbdc25e4d step=review round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer \u2014 1 finding',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Judge","when":"findings"} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'review \u2192 waiting \u2014 is waiting on you. the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (cl\u2026',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary:
            'proposed \u00b7 judge \u2014 Merge agent/7 into main anyway? agent/7 into main is waiting on you. the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was n\u2026',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(documentsOf(all, attempts)).toEqual([
    {
      type: 'WaitStarted',
      field: 'reason.because.raw',
    },
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
    {
      type: 'PassRouted',
      field: 'reply.raw',
    },
    {
      type: 'PassRouted',
      field: 'decision.because.raw',
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'passed',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'failed',
    },
    {
      step: 'proposed',
      state: 'pending',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 13b, `what-a-pass-writes-today.test.ts:1332` — see the it() title below
const ITEM_13b: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: 'f37b6e89-6aab-4cdb-a8e2-c22ebb65d7f8',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
        },
        proposal: {
          _tag: 'AnswerUnreadable',
          from: 'review',
          raw: "the reviewer's answer was not readable as findings:\nI am not sure what to say here.",
        },
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_13b: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83 at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      worktree: '/tmp/fake/pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: ['cold reviewer'],
        },
        {
          step: 'proposed',
          actions: ['the lines, until the rounds are spent'],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 1,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              judge: 'same-worktree',
              name: 'the lines, until the rounds are spent',
              when: 'findings',
            },
          ],
          review: [
            {
              agent: 'claude-code',
              name: 'cold reviewer',
              prompt: 'look for races',
            },
          ],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 3,
      durationMs: 1234,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      outcome: {
        step: 'review',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: "the reviewer's answer was not readable as findings:\nI am not sure what to say here.",
            yields: 'verdict',
            result: {
              _tag: 'AnswerUnreadable',
              raw: "the reviewer's answer was not readable as findings:\nI am not sure what to say here.",
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83',
      offer: {
        proposal: {
          _tag: 'AnswerUnreadable',
          from: 'review',
          raw: "the reviewer's answer was not readable as findings:\nI am not sure what to say here.",
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'NotAsked',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it("13b. the cold reviewer's own answer is unreadable", () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_13b)
  const runEvents = envelopesFor('pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83', RUN_13b)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 9af1b0d2',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary:
            "judgement: agent/7 is waiting on you. `review`'s findings could not be read at all: the reviewer's answer was not readable as findings: I am not sure what to say here.",
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83 step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83 step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83 outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83 step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83 outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83 step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a worktree=/tmp/fake/pass-9af1b0d2-cd7\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines, until the rounds are spent \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '3 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83 step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83 outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-9af1b0d2-cd79-48f8-8fd8-298a7d47ac83 step=review round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer \u2014 the answer could not be read',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            "review \u2192 waiting \u2014 is waiting on you. `review`'s findings could not be read at all: the reviewer's answer was not readable as findings: I am not sure what to say here.",
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(documentsOf(all, attempts)).toEqual([
    {
      type: 'WaitStarted',
      field: 'reason.proposal.raw',
    },
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].result.raw',
    },
    {
      type: 'PassRouted',
      field: 'offer.proposal.raw',
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'passed',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'failed',
    },
    {
      step: 'proposed',
      state: 'pending',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 14a, `what-a-pass-writes-today.test.ts:1493` — see the it() title below
const ITEM_14a: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: '6b69eb08-c436-4bd7-9a0b-e9e06d8a9441',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
        },
        proposal: {
          _tag: 'BudgetExhausted',
          from: 'implement',
          kind: 'out-of-turns',
          turns: null,
          costUsd: null,
          detail: 'out-of-turns: spent all 10 turns with no commit',
        },
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_14a: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: [],
        },
        {
          step: 'proposed',
          actions: [],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 2,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 1,
      turns: 10,
      durationMs: 5000,
    },
  },
  {
    type: 'RunFailed',
    data: {
      kind: 'out-of-turns',
      detail: 'spent all 10 turns with no commit',
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 10,
      durationMs: 5000,
      usage: [],
      costUsd: 1.1,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'out-of-turns: spent all 10 turns with no commit',
            yields: 'commit',
            result: {
              _tag: 'Interrupted',
              cause: 'out-of-turns',
              head: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c',
      offer: {
        proposal: {
          _tag: 'BudgetExhausted',
          from: 'implement',
          kind: 'out-of-turns',
          turns: null,
          costUsd: null,
          detail: 'out-of-turns: spent all 10 turns with no commit',
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'NotAsked',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('14a. the turn ceiling is hit mid-run (`Ceiling`)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_14a)
  const runEvents = envelopesFor('pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c', RUN_14a)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run a5bb7a5f',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary:
            'acknowledgement: out-of-turns: out-of-turns: spent all 10 turns with no commit \u2014 recommends requeue',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-a5bb7a5f-5cd4-499e-af20-c15b88a8452c step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/pass-a5bb7a5f-5cd\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '10 turns, $0.00',
        },
        {
          type: 'RunFailed',
          actor: 'conductor',
          summary: 'out-of-turns: spent all 10 turns with no commit',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=10 durationMs=5000 usage=[] costUsd=1.1',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary:
            'implement \u00b7 write the change \u2014 did not finish: out-of-turns: spent all 10 turns with no commit',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary: 'implement \u2192 waiting \u2014 out-of-turns: out-of-turns: spent all 10 turns with no commit',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'did-not-finish',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'skipped',
    },
    {
      step: 'proposed',
      state: 'skipped',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 14b, `what-a-pass-writes-today.test.ts:1579` — see the it() title below
const ITEM_14b: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: '79bf51c0-76ab-43ea-86bb-5519a7b1572f',
      reason: {
        _tag: 'AgentCrashed',
        run: {
          runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
        },
        step: 'implement',
        cause: 'timeout',
        detail: 'timeout: exceeded wall 2m',
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_14b: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59 at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: [],
        },
        {
          step: 'proposed',
          actions: [],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 2,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFailed',
    data: {
      kind: 'timeout',
      detail: 'exceeded wall 2m',
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 2,
      durationMs: 120000,
      usage: [],
      costUsd: 0.2,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'timeout: exceeded wall 2m',
            yields: 'commit',
            result: {
              _tag: 'Interrupted',
              cause: 'timeout',
              head: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('14b. the wall is hit mid-run (`DidNotFinish`, not `Ceiling`)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_14b)
  const runEvents = envelopesFor('pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59', RUN_14b)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run c2738401',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary: 'acknowledgement: the `implement` step did-not-finish: timeout: exceeded wall 2m',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59 step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59 step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59 outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59 step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59 outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-c2738401-7e1a-45a7-9cdc-9e066eaebd59 step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/pass-c2738401-7e1\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFailed',
          actor: 'conductor',
          summary: 'timeout: exceeded wall 2m',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=2 durationMs=120000 usage=[] costUsd=0.2',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change \u2014 did not finish: timeout: exceeded wall 2m',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'did-not-finish',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'skipped',
    },
    {
      step: 'proposed',
      state: 'skipped',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 14c, `what-a-pass-writes-today.test.ts:1377` — see the it() title below
const ITEM_14c: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: 'd3456c6e-f2e1-4f24-9b1a-64a8cdf0aed8',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
        },
        proposal: {
          _tag: 'BudgetExhausted',
          from: 'implement',
          kind: 'out-of-turns',
          turns: null,
          costUsd: null,
          detail:
            'the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read',
        },
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_14c: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-35a5806a-46de-4937-ada4-a3c5b2de46ac at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      worktree: '/tmp/fake/pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: ['cold reviewer'],
        },
        {
          step: 'proposed',
          actions: ['the lines, until the rounds are spent'],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 1,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              judge: 'same-worktree',
              name: 'the lines, until the rounds are spent',
              when: 'findings',
            },
          ],
          review: [
            {
              agent: 'claude-code',
              name: 'cold reviewer',
              prompt: 'look for races',
            },
          ],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 3,
      durationMs: 1234,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      outcome: {
        step: 'review',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
            yields: 'verdict',
            result: {
              _tag: 'Completed',
              assessment: {
                verdict: 'refused',
                findings: [
                  {
                    file: 'src/fix.ts',
                    line: 12,
                    claim: 'the approach cannot work',
                    failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
                    severity: 'blocker',
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      step: 'implement',
      round: 1,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 1,
      },
      runtime: 'claude-code',
      turns: 7,
      durationMs: 3000,
      usage: [],
      costUsd: 0.77,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      outcome: {
        step: 'implement',
        round: 1,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence:
              'the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read',
            yields: 'commit',
            result: {
              _tag: 'Interrupted',
              cause: 'out-of-turns',
              head: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      offer: {
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'src/fix.ts',
              line: 12,
              claim: 'the approach cannot work',
              failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
              severity: 'blocker',
            },
          ],
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'Selected',
        candidate: 'fix-lines',
        why: 'the "the lines, until the rounds are spent" judge: the recipe declares `judge: same-worktree` for a "findings"',
      },
      decision: {
        _tag: 'Selected',
        candidate: 'fix-lines',
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-35a5806a-46de-4937-ada4-a3c5b2de46ac',
      offer: {
        proposal: {
          _tag: 'BudgetExhausted',
          from: 'implement',
          kind: 'out-of-turns',
          turns: null,
          costUsd: null,
          detail:
            'the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read',
        },
        available: [
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'fix-lines',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'rounds',
            },
          },
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'NotAsked',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it("14c. a fix round's own agent hits the turn ceiling (`DidNotFinish`, not the ticket's scope)", () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_14c)
  const runEvents = envelopesFor('pass-35a5806a-46de-4937-ada4-a3c5b2de46ac', RUN_14c)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-35a5806a-46de-4937-ada4-a3c5b2de46ac', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 35a5806a',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary:
            'acknowledgement: out-of-turns: the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read \u2014 recommends requeue',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a worktree=/tmp/fake/pass-35a5806a-46d\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines, until the rounds are spent \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '3 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac step=review round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer \u2014 1 finding',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac step=implement round=1',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":1} runtime=claude-code turns=7 durationMs=3000 usage=[] costUsd=0.77',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary:
            'implement \u00b7 write the change \u2014 did not finish: the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'runId=pass-35a5806a-46de-4937-ada4-a3c5b2de46ac offer={"proposal":{"_tag":"ReviewFindings","findings":[{"file":"src/fix.ts","line":12,"claim":"the approach cannot work","failureScenario":"call it twice and the second call deadlocks on the \u2026',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'implement \u2192 waiting \u2014 out-of-turns: the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(documentsOf(all, attempts)).toEqual([
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'did-not-finish',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'failed',
    },
    {
      step: 'proposed',
      state: 'pending',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 14d, `what-a-pass-writes-today.test.ts:1434` — see the it() title below
const ITEM_14d: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'WaitStarted',
    data: {
      waitId: '1f04a5cf-e751-41a5-8309-ad20e163a45a',
      reason: {
        _tag: 'ProposedEscalated',
        run: {
          runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
        },
        proposal: {
          _tag: 'BudgetExhausted',
          from: 'review',
          kind: 'out-of-turns',
          turns: null,
          costUsd: null,
          detail: 'the reviewer did not finish (out-of-turns): spent all 5 turns reviewing',
        },
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'comment',
      detail: '1',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:waiting',
    },
  },
]
const RUN_14d: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      worktree: '/tmp/fake/pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: ['cold reviewer'],
        },
        {
          step: 'proposed',
          actions: ['the lines, until the rounds are spent'],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 0,
            rounds: 1,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              judge: 'same-worktree',
              name: 'the lines, until the rounds are spent',
              when: 'findings',
            },
          ],
          review: [
            {
              agent: 'claude-code',
              name: 'cold reviewer',
              prompt: 'look for races',
            },
          ],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 3,
      durationMs: 1234,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 0.33,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      outcome: {
        step: 'review',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'the reviewer did not finish (out-of-turns): spent all 5 turns reviewing',
            yields: 'verdict',
            result: {
              _tag: 'Interrupted',
              cause: 'out-of-turns',
            },
          },
        ],
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae',
      offer: {
        proposal: {
          _tag: 'BudgetExhausted',
          from: 'review',
          kind: 'out-of-turns',
          turns: null,
          costUsd: null,
          detail: 'the reviewer did not finish (out-of-turns): spent all 5 turns reviewing',
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'restart',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'restarts',
            },
          },
        ],
      },
      reply: {
        _tag: 'NotAsked',
      },
      decision: {
        _tag: 'Escalated',
        because: {
          _tag: 'NotAsked',
        },
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it("14d. the cold reviewer's own wall is `DidNotFinish`, not a `Ceiling` nobody paid for", () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_14d)
  const runEvents = envelopesFor('pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae', RUN_14d)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 758fc02c',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'WaitStarted',
          actor: 'conductor',
          summary:
            'acknowledgement: out-of-turns: the reviewer did not finish (out-of-turns): spent all 5 turns reviewing \u2014 recommends requeue',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'comment: 1',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:waiting',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a worktree=/tmp/fake/pass-758fc02c-17b\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines, until the rounds are spent \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '3 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-758fc02c-17b6-4e13-9963-20b33ecfa2ae step=review round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=0.33',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary:
            'review \u00b7 cold reviewer \u2014 did not finish: the reviewer did not finish (out-of-turns): spent all 5 turns reviewing',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'review \u2192 waiting \u2014 out-of-turns: the reviewer did not finish (out-of-turns): spent all 5 turns reviewing',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    {
      step: 'claim',
      state: 'skipped',
    },
    {
      step: 'admit',
      state: 'passed',
    },
    {
      step: 'prepared',
      state: 'skipped',
    },
    {
      step: 'design',
      state: 'skipped',
    },
    {
      step: 'implement',
      state: 'passed',
    },
    {
      step: 'build',
      state: 'skipped',
    },
    {
      step: 'review',
      state: 'did-not-finish',
    },
    {
      step: 'proposed',
      state: 'pending',
    },
    {
      step: 'merge',
      state: 'skipped',
    },
    {
      step: 'end',
      state: 'skipped',
    },
  ])
})

// Row 15, `what-a-pass-writes-today.test.ts:1657` — a claim decline (`passed-over`) writes no work-item events
it('15. a claim decline (`passed-over`) writes no work-item events', () => {
  // Under #502, claim writes no run events at all for a declined take — no
  // StepStarted/StepEnded pair opens, because claim runs outside runPass (0120
  // §6). The work-item stream is untouched either way.
  expect(historyOf([], new Map())).toEqual([])
})

// Row 15b, `what-a-pass-writes-today.test.ts:1698` — a claim decline (`not-claimed`) writes no work-item events
it('15b. a claim decline (`not-claimed`) writes no work-item events', () => {
  // The item stream does carry one event here — `TicketClaimed` by
  // `pass-somebody-else`, seeded so `claimWorkItem` reads the item as held — but
  // it is that run's write, not this one's, so it is left out of the pin rather
  // than read as if this run had written it (file header). Claim writes no run
  // events at all under #502 either way.
  expect(historyOf([], new Map())).toEqual([])
})

// Row 15c, `what-a-pass-writes-today.test.ts:1742` — a claim decline (`claim-unconfirmed`) writes TicketReleased and resolves nothing
const ITEM_15c: EventSpec[] = [
  {
    type: 'TicketReleased',
    data: {
      runId: 'pass-84ec94a4-7ecc-4e33-b99c-528e22102a52',
      reason: 'the claim was not confirmed: ticket-purecheck-7 may be claimed by this run: connection lost',
      cause: {
        _tag: 'ClaimUnconfirmed',
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: '',
    },
  },
]

it('15c. a claim decline (`claim-unconfirmed`) writes TicketReleased and resolves nothing', () => {
  // Claim writes no run events at all under #502 (claim runs outside runPass,
  // 0120 §6), so there is no RUN_15c to validate here — only the item side.
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_15c)
  expect(historyOf(itemEvents, new Map())).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketReleased',
          actor: 'conductor',
          summary:
            'run 84ec94a4: the claim was not confirmed: ticket-purecheck-7 may be claimed by this run: connection lost',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels:',
        },
      ],
    },
  ])
})
// Row 16, `what-a-pass-writes-today.test.ts:1902` — see the it() title below
const ITEM_16: EventSpec[] = [
  {
    type: 'TicketClaimed',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      worker: 'local:29161',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: 'lingtai:working',
    },
  },
  {
    type: 'TicketReleased',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      reason:
        'the proposed reviewer still refused after 1 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 2',
      cause: {
        _tag: 'Restart',
        restart: 1,
      },
    },
  },
  {
    type: 'IssueUpdated',
    data: {
      project: 'purecheck',
      issue: '7',
      change: 'labels',
      detail: '',
    },
  },
]
const RUN_16: EventSpec[] = [
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      step: 'admit',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      outcome: {
        step: 'admit',
        round: 0,
        actions: [
          {
            plugin: 'worktree',
            name: 'cut the branch',
            onSha: '',
            evidence: '/tmp/fake/pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd at aaaaaaa, from origin/main',
            yields: 'worktree',
            result: {
              _tag: 'Completed',
              head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      step: 'prepared',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      outcome: {
        step: 'prepared',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      step: 'design',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      outcome: {
        step: 'design',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      step: 'implement',
      round: 0,
    },
  },
  {
    type: 'RunStarted',
    data: {
      ticketId: 'ticket-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '8a30fea5adf3c61ad10d4b25d582b1e09a9d8534e056bdba9b028ecbfdce5a9b',
      worktree: '/tmp/fake/pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      configHash: '8a30fea5adf3c61ad10d4b25d582b1e09a9d8534e056bdba9b028ecbfdce5a9b',
      steps: [
        {
          step: 'claim',
          actions: [],
        },
        {
          step: 'admit',
          actions: [],
        },
        {
          step: 'prepared',
          actions: [],
        },
        {
          step: 'design',
          actions: [],
        },
        {
          step: 'implement',
          actions: [],
        },
        {
          step: 'build',
          actions: [],
        },
        {
          step: 'review',
          actions: ['cold reviewer'],
        },
        {
          step: 'proposed',
          actions: ['the lines or the approach'],
        },
        {
          step: 'merge',
          actions: [],
        },
        {
          step: 'end',
          actions: [],
        },
      ],
      recipe: {
        discuss: {
          agent: 'claude-code',
          limits: {
            turns: 40,
            wall: '5m',
          },
        },
        env: {
          deny: [],
          plantAt: '.env.local',
          refuseHosts: [],
          required: [],
        },
        repo: {
          base: 'main',
          submodules: false,
        },
        runtime: {
          agent: 'claude-code',
          budget: {
            attempts: 5,
            diff: 400000,
            evidence: 2000,
            findings: 5,
          },
          limits: {
            restarts: 2,
            rounds: 1,
            turns: 10,
            wall: '2m',
          },
          tier: 'guarded',
        },
        source: {
          backoff: '1h',
          exclude: [],
          kinds: ['bug'],
        },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              judge: 'claude-code',
              name: 'the lines or the approach',
              when: 'findings',
            },
          ],
          review: [
            {
              agent: 'claude-code',
              name: 'cold reviewer',
              prompt: 'look for races',
            },
          ],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  {
    type: 'RunFinished',
    data: {
      exitCode: 0,
      turns: 3,
      durationMs: 1234,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 3,
      durationMs: 1234,
      usage: [],
      costUsd: 0.42,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunProposedCompletion',
    data: {
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      outcome: {
        step: 'implement',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            evidence: 'committed bbbbbbb',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      step: 'build',
      round: 0,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      outcome: {
        step: 'build',
        round: 0,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      step: 'review',
      round: 0,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 0,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      outcome: {
        step: 'review',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
            yields: 'verdict',
            result: {
              _tag: 'Completed',
              assessment: {
                verdict: 'refused',
                findings: [
                  {
                    file: 'src/fix.ts',
                    line: 12,
                    claim: 'the approach cannot work',
                    failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
                    severity: 'blocker',
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Judge',
        when: 'findings',
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      step: 'implement',
      round: 1,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'implement',
        name: 'write the change',
        round: 1,
      },
      runtime: 'claude-code',
      turns: 8,
      durationMs: 90000,
      usage: [],
      costUsd: 1.5,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      outcome: {
        step: 'implement',
        round: 1,
        actions: [
          {
            plugin: 'agent',
            name: 'write the change',
            onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            evidence: 'committed ddddddd',
            yields: 'commit',
            result: {
              _tag: 'Completed',
              head: 'dddddddddddddddddddddddddddddddddddddddd',
              question: null,
            },
          },
        ],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      step: 'build',
      round: 1,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      outcome: {
        step: 'build',
        round: 1,
        actions: [],
      },
    },
  },
  {
    type: 'StepStarted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      step: 'review',
      round: 1,
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Action',
        step: 'review',
        name: 'cold reviewer',
        round: 1,
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'StepEnded',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      outcome: {
        step: 'review',
        round: 1,
        actions: [
          {
            plugin: 'agent',
            name: 'cold reviewer',
            onSha: 'dddddddddddddddddddddddddddddddddddddddd',
            evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns)',
            yields: 'verdict',
            result: {
              _tag: 'Completed',
              assessment: {
                verdict: 'refused',
                findings: [
                  {
                    file: 'src/fix.ts',
                    line: 12,
                    claim: 'the approach cannot work',
                    failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
                    severity: 'blocker',
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
  {
    type: 'RunSpent',
    data: {
      for: {
        _tag: 'Judge',
        when: 'findings',
      },
      runtime: 'claude-code',
      turns: 5,
      durationMs: 2000,
      usage: [],
      costUsd: 1.25,
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      offer: {
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'src/fix.ts',
              line: 12,
              claim: 'the approach cannot work',
              failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
              severity: 'blocker',
            },
          ],
        },
        available: [
          {
            id: 'fix-lines',
            next: {
              _tag: 'FixRound',
              to: 'implement',
              round: 1,
            },
          },
          {
            id: 'restart',
            next: {
              _tag: 'Requeued',
              cause: {
                _tag: 'Restart',
                restart: 1,
              },
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [],
      },
      reply: {
        _tag: 'Selected',
        candidate: 'fix-lines',
        why: 'the "the lines or the approach" judge: round 1 (claude-code \u00b7 5 turns, $1.25)',
      },
      decision: {
        _tag: 'Selected',
        candidate: 'fix-lines',
      },
    },
  },
  {
    type: 'PassRouted',
    data: {
      runId: 'pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd',
      offer: {
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'src/fix.ts',
              line: 12,
              claim: 'the approach cannot work',
              failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
              severity: 'blocker',
            },
          ],
        },
        available: [
          {
            id: 'restart',
            next: {
              _tag: 'Requeued',
              cause: {
                _tag: 'Restart',
                restart: 1,
              },
            },
          },
          {
            id: 'hand-to-person',
            next: {
              _tag: 'HandToPerson',
            },
          },
        ],
        unavailable: [
          {
            id: 'fix-lines',
            because: {
              _tag: 'CeilingReached',
              ceiling: 'rounds',
            },
          },
        ],
      },
      reply: {
        _tag: 'Selected',
        candidate: 'restart',
        why: 'the "the lines or the approach" judge: round 2 (claude-code \u00b7 5 turns, $1.25)',
      },
      decision: {
        _tag: 'Selected',
        candidate: 'restart',
      },
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      outcome: 'published',
      branchCarries: true,
      armSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      detail: null,
    },
  },
  {
    type: 'RunKeptUncommitted',
    data: {
      arm: 'agent/7-attempt-1',
      sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      parentSha: 'dddddddddddddddddddddddddddddddddddddddd',
      stoppedBy: 'out-of-turns',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      outcome: 'already-published',
      branchCarries: true,
      armSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      detail: null,
    },
  },
]

it('16. a judge restarts a pass that kept a WIP (`RunKeptUncommitted`, `PassRestarted` spends the ceiling)', () => {
  const itemEvents = envelopesFor('ticket-purecheck-7', ITEM_16)
  const runEvents = envelopesFor('pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd', RUN_16)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        {
          type: 'TicketClaimed',
          actor: 'conductor',
          summary: 'run 0870ddf8',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels: lingtai:working',
        },
        {
          type: 'TicketReleased',
          actor: 'conductor',
          summary:
            'run 0870ddf8: the proposed reviewer still refused after 1 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 2',
        },
        {
          type: 'IssueUpdated',
          actor: 'conductor',
          summary: 'labels:',
        },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd step=admit round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'admit \u00b7 cut the branch',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd step=prepared round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd outcome={"step":"prepared","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd step=design round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd outcome={"step":"design","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd step=implement round=0',
        },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'ticketId=ticket-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=8a30fea5adf3c61ad10d4b25d582b1e09a9d8534e056bdba9b028ecbfdce5a9b worktree=/tmp/fake/pass-0870ddf8-142\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines or the approach \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        {
          type: 'RunFinished',
          actor: 'conductor',
          summary: '3 turns, $0.00',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":0} runtime=claude-code turns=3 durationMs=1234 usage=[] costUsd=0.42',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'RunProposedCompletion',
          actor: 'conductor',
          summary: 'head bbbbbbb',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd step=build round=0',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd outcome={"step":"build","round":0,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd step=review round=0',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":0} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer \u2014 1 finding',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Judge","when":"findings"} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd step=implement round=1',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"implement","name":"write the change","round":1} runtime=claude-code turns=8 durationMs=90000 usage=[] costUsd=1.5',
        },
        {
          type: 'RunProducedDiff',
          actor: 'conductor',
          summary: '1 files +3 \u22121',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd step=build round=1',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd outcome={"step":"build","round":1,"actions":[]}',
        },
        {
          type: 'StepStarted',
          actor: 'conductor',
          summary: 'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd step=review round=1',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Action","step":"review","name":"cold reviewer","round":1} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'StepEnded',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer \u2014 1 finding',
        },
        {
          type: 'RunSpent',
          actor: 'conductor',
          summary:
            'for={"_tag":"Judge","when":"findings"} runtime=claude-code turns=5 durationMs=2000 usage=[] costUsd=1.25',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'runId=pass-0870ddf8-1424-4bf5-8af1-1fb8902fe8bd offer={"proposal":{"_tag":"ReviewFindings","findings":[{"file":"src/fix.ts","line":12,"claim":"the approach cannot work","failureScenario":"call it twice and the second call deadlocks on the \u2026',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary: 'restart 1',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 at ddddddd and agent/7-attempt-1 at eeeeeee',
        },
        {
          type: 'RunKeptUncommitted',
          actor: 'conductor',
          summary: 'kept 1 file(s) +3 \u22121 as eeeeeee on agent/7-attempt-1 \u2014 stopped by out-of-turns',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 at ddddddd and agent/7-attempt-1 at eeeeeee',
        },
      ],
    },
  ])
  expect(documentsOf(all, attempts)).toEqual([
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
    {
      type: 'StepEnded',
      field: 'outcome.actions[0].evidence',
    },
  ])
})
