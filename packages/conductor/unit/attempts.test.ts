/**
 * What a second attempt is told, and what a first one still is not.
 *
 * `#82`'s criteria are one test each. The one that would be easiest to break
 * silently is the last pair — a first attempt must stay byte-identical, and the
 * context must stay bounded — because both fail by producing *more* prompt
 * rather than by throwing.
 *
 * Unit, under `--project unit`: deciding what an attempt is told is a
 * fold over envelopes, and a decision that needed a database would be the wrong
 * shape.
 */
import { readFileSync } from 'node:fs'

import { EVIDENCE_BYTES, tail } from '@lingtai/actions'
import {
  type Action,
  type Envelope,
  type EventType,
  type Finding,
  type PayloadOf,
  SCHEMA_VER,
  parsePayload,
} from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import {
  armFor,
  attemptBrief,
  attemptOutcome,
  clamp,
  diffBaseShaOf,
  priorAttempts,
  promptVersionFor,
  type PromptBudget,
} from '../src/attempts.ts'

/**
 * The recipe's defaults (`runtime.budget`, 0029), spelled out here.
 *
 * Written rather than imported from `@lingtai/recipe`: these tests are about
 * the *shape* of the bound — that the brief does not grow with the number of
 * attempts — and importing the schema's number would make them re-assert the
 * schema instead. That the defaults are these values is the schema's own test.
 */
const BUDGET: PromptBudget = { evidence: 2_000, attempts: 5, findings: 5 }

let seq = 1n

/** One stream's envelopes, versioned in call order. Payloads go through zod. */
function stream(streamId: string) {
  let version = 0
  return function event<T extends EventType>(type: T, data: PayloadOf<T>): Envelope {
    version += 1
    return {
      seq: seq++,
      streamId,
      version,
      type,
      schemaVer: SCHEMA_VER[type],
      data: parsePayload(type, data),
      actor: 'conductor',
      causation: null,
      at: new Date('2026-09-08T12:00:00.000Z'),
    }
  }
}

const claim = (runId: string): PayloadOf<'TicketClaimed'> => ({
  runId,
  worker: 'conductor',
  title: 'A retry is a blind retry',
  kind: 'bug',
})

/** A `TicketReleased` payload with no cause worth naming — a release this file is not about. */
const released = (runId: string, reason: string): PayloadOf<'TicketReleased'> => ({ runId, reason, cause: null })

/** A `StepStarted` payload for the given step, round 0 unless said otherwise. */
const started = (runId: string, step: PayloadOf<'StepStarted'>['step'], round = 0) => ({ runId, step, round })

/** A `verdict`-yield action, the shape a gate's own check or review declares. */
const verdictAction = (
  name: string,
  evidence: string,
  verdict: 'accepted' | 'refused' = 'accepted',
  findings: Finding[] = [],
): Action => ({
  plugin: 'run',
  name,
  onSha: 'sha-1',
  evidence,
  yields: 'verdict',
  result: { _tag: 'Completed', assessment: { verdict, findings } },
})

/** A `StepEnded` payload closing the given step with one verdict action. */
const ended = (runId: string, step: PayloadOf<'StepStarted'>['step'], action: Action, round = 0) => ({
  runId,
  outcome: { step, round, actions: [action] },
})

describe('priorAttempts', () => {
  it('finds nothing on a work item nobody has claimed', () => {
    const e = stream('ticket-lingtai-82')
    const events = [
      e('TicketDiscovered', {
        project: 'lingtai',
        source: 'github-issue',
        externalRef: '82',
        title: 'A retry is a blind retry',
        kind: 'bug',
        labels: ['bug'],
      }),
    ]

    expect(priorAttempts(events)).toEqual([])
  })

  /**
   * The ticket's first criterion, at the level of the fold: how many attempts
   * there were and what ended each. `TicketClaimed` ×N is what `attempts: N`
   * on a card counts, so it is what this counts.
   */
  it('pairs each claim with the reason its release gives', () => {
    const e = stream('ticket-lingtai-59')
    const attempts = priorAttempts([
      e('TicketClaimed', claim('pass-1')),
      e('TicketReleased', released('pass-1', 'prepare failed at prepared:install')),
      e('TicketClaimed', claim('pass-2')),
      e('TicketReleased', released('pass-2', 'the run was killed by an operator timeout before it produced anything')),
    ])

    expect(attempts.map((a) => [a.n, a.runId, a.ended])).toEqual([
      [1, 'pass-1', 'prepare failed at prepared:install'],
      [2, 'pass-2', 'the run was killed by an operator timeout before it produced anything'],
    ])
  })

  /**
   * A second claim by one run is not a second attempt, any more than a
   * second run. **This is `continueWorkItem`'s own re-claim** (`claim.ts`,
   * #465) — every continuation appends a second `TicketClaimed` naming the
   * run already in `runs`, and `armFor` (below) depends on this guard
   * de-duplicating it so a continuation counts as the attempt it already
   * was, not a fresh one. Pinned here by name so a reader who finds the
   * guard unreached by any test does not delete it.
   */
  it("counts a continuation's re-claim by the same run once, not as a fresh attempt", () => {
    const e = stream('ticket-lingtai-59')
    expect(priorAttempts([e('TicketClaimed', claim('pass-1')), e('TicketClaimed', claim('pass-1'))])).toHaveLength(1)
  })

  /** An attempt that ended by asking a person ended, and the question is why. */
  it('reads a wait as an ending, with its question', () => {
    const e = stream('ticket-lingtai-59')
    const [attempt] = priorAttempts([
      e('TicketClaimed', claim('pass-1')),
      e('WaitStarted', {
        waitId: 'wait-1' as PayloadOf<'WaitStarted'>['waitId'],
        reason: {
          _tag: 'MergeRefused',
          run: { runId: 'pass-1' },
          reason: 'unexpected',
          raw: 'agent/59 does not merge into main',
        },
      }),
    ])

    expect(attempt?.ended).toBe('blocked, asking: unexpected: agent/59 does not merge into main')
  })
})

/**
 * **A continuation publishes to the held run's own arm, never `nextAttempt`'s**
 * (#465). `conduct.ts`'s own comment explains why: a continuation's
 * `next.attempt` is one higher than the held run's — the re-claim is on the
 * stream too — so pushing there would force-push over the commits this claim
 * exists to keep, and the next genuine attempt would compute that same
 * number for itself and force-push over them a second time.
 */
describe('armFor', () => {
  it("names the held run's own attempt for a continuation, not nextAttempt's", () => {
    const e = stream('ticket-lingtai-465')
    const before = [
      e('TicketClaimed', claim('pass-1')),
      e('WaitStarted', {
        waitId: 'wait-1' as PayloadOf<'WaitStarted'>['waitId'],
        reason: {
          _tag: 'SignoffRequired',
          run: { runId: 'pass-1' },
          step: 'merge',
          action: 'human:land',
          question: 'land it?',
        },
      }),
    ]

    expect(armFor(before, 'agent/465', 'pass-1', 2)).toBe('agent/465-attempt-1')
  })

  it("names nextAttempt's arm for a fresh claim, with no continuing run", () => {
    const e = stream('ticket-lingtai-465')
    const before = [e('TicketClaimed', claim('pass-1')), e('TicketReleased', released('pass-1', 'exhausted'))]

    expect(armFor(before, 'agent/465', null, 2)).toBe('agent/465-attempt-2')
  })

  it('throws rather than silently falling back when the continuing run has no claim on this stream', () => {
    const before: Envelope[] = []
    expect(() => armFor(before, 'agent/465', 'pass-1', 2)).toThrow('pass-1')
  })
})

/**
 * **The base a continuation diffs against must not depend on `firstDispatch`
 * ever having run** (#465). `RunStarted.baseSha` is written nowhere else, so
 * a recipe whose `implement:` is a bare `run:` action — no agent dispatch —
 * leaves it `null` for the run's whole life, and the `!` this replaced
 * asserted a field only `firstDispatch` fills. `admit`'s own `StepEnded`
 * carries the same sha regardless, because `firstDispatch` copies it from
 * there in the first place.
 */
describe('diffBaseShaOf', () => {
  it("reads admit's own worktree cut, with no RunStarted on the stream at all", () => {
    const e = stream('pass-465')
    const runEvents = [
      e('StepStarted', { runId: 'pass-465', step: 'admit', round: 0 }),
      e('StepEnded', {
        runId: 'pass-465',
        outcome: {
          step: 'admit',
          round: 0,
          actions: [
            {
              plugin: 'worktree',
              name: 'cut the branch',
              onSha: 'a'.repeat(40),
              evidence: '',
              yields: 'worktree',
              result: { _tag: 'Completed', head: 'a'.repeat(40) },
            },
          ],
        },
      }),
    ]

    expect(diffBaseShaOf(runEvents)).toBe('a'.repeat(40))
  })

  it('answers null, rather than throwing, when admit itself is missing from the slice', () => {
    expect(diffBaseShaOf([])).toBeNull()
  })
})

describe('attemptOutcome', () => {
  it('reports what the run committed and what the gate said about it', () => {
    const e = stream('pass-2')
    const outcome = attemptOutcome(
      [
        e('RunProducedDiff', {
          branch: 'agent/59',
          headSha: '1a2b3c4d5e6f',
          files: 4,
          insertions: 120,
          deletions: 3,
        }),
        e('StepStarted', started('pass-2', 'build')),
        e(
          'StepEnded',
          ended(
            'pass-2',
            'build',
            verdictAction('tsc', 'tsc: apps/board/src/lib/board.ts(12,5): error TS2322', 'refused'),
          ),
        ),
        e('RunFinished', { exitCode: 0, turns: 31, durationMs: 900_000 }),
      ],
      BUDGET,
    )

    expect(outcome.produced).toEqual({
      branch: 'agent/59',
      headSha: '1a2b3c4d5e6f',
      files: 4,
      insertions: 120,
      deletions: 3,
    })
    expect(outcome.evidence?.what).toBe('build:tsc')
    expect(outcome.evidence?.text).toContain('error TS2322')
    expect(outcome.receipt).toEqual({ turns: 31 })
  })

  /** A review gate's findings are the evidence; its output alone is a summary. */
  it("lists a review gate's findings under its output", () => {
    const e = stream('pass-2')
    const outcome = attemptOutcome(
      [
        e(
          'StepEnded',
          ended(
            'pass-2',
            'review',
            verdictAction('cold reviewer', '1 blocker', 'refused', [
              {
                file: 'packages/conductor/src/queue.ts',
                line: 44,
                claim: 'the backoff is never applied',
                failureScenario: 'a failing item is retaken on the next pass',
                severity: 'blocker',
              },
            ]),
          ),
        ),
      ],
      BUDGET,
    )

    expect(outcome.evidence?.text).toContain('packages/conductor/src/queue.ts:44')
    expect(outcome.evidence?.text).toContain('the backoff is never applied')
  })

  /** The run's own ending, when no gate ever refused. */
  it("falls back to the run's failure", () => {
    const e = stream('pass-1')
    const outcome = attemptOutcome(
      [
        e('RunFailed', {
          kind: 'timeout',
          detail: 'the run was killed by an operator timeout before it produced anything',
        }),
      ],
      BUDGET,
    )

    expect(outcome.produced).toBeNull()
    expect(outcome.evidence?.what).toBe('the run itself (timeout)')
    expect(outcome.evidence?.text).toContain('operator timeout')
  })

  /**
   * The ticket's "which point it died at": a `StepStarted` with no matching
   * verdict. There is no output to quote, and the fact is the finding — a fold
   * that only knows verdicts cannot say this, which is why this reads the
   * envelopes rather than `reduceRun`.
   */
  it('names the point a run died inside', () => {
    const e = stream('pass-1')
    const outcome = attemptOutcome([e('StepStarted', started('pass-1', 'build'))], BUDGET)

    expect(outcome.evidence?.what).toBe('build')
    expect(outcome.evidence?.text).toContain('never returned a verdict')
  })

  it('says nothing about a gate that passed', () => {
    const e = stream('pass-1')
    const outcome = attemptOutcome(
      [
        e('StepStarted', started('pass-1', 'build')),
        e('StepEnded', ended('pass-1', 'build', verdictAction('tsc', 'ok', 'accepted'))),
      ],
      BUDGET,
    )

    expect(outcome.evidence).toBeNull()
  })
})

describe('attemptBrief', () => {
  const item = stream('ticket-lingtai-59')
  const history = [
    item('TicketClaimed', claim('pass-1')),
    item('TicketReleased', released('pass-1', 'prepare failed at prepared:install')),
    item('TicketClaimed', claim('pass-2')),
    item('TicketReleased', released('pass-2', 'gates refused the diff')),
  ]

  const filled = () => {
    const attempts = priorAttempts(history)
    const run = stream('pass-2')
    attempts[attempts.length - 1]!.outcome = attemptOutcome(
      [
        run('RunProducedDiff', {
          branch: 'agent/59',
          headSha: '1a2b3c4d5e6f',
          files: 4,
          insertions: 120,
          deletions: 3,
        }),
        run(
          'StepEnded',
          ended(
            'pass-2',
            'build',
            verdictAction('tsc', 'tsc: apps/board/src/lib/board.ts(12,5): error TS2322', 'refused'),
          ),
        ),
        run('RunFinished', { exitCode: 0, turns: 31, durationMs: 900_000 }),
      ],
      BUDGET,
    )
    return attempts
  }

  /**
   * **Attempt 1 is unchanged.** A first attempt has no history, so it must not
   * carry an empty "previous attempts" section — an empty block renders a
   * template byte-identically to the one this feature never touched, and
   * `promptVersionFor` then leaves the version alone as well.
   */
  it('is empty for a first attempt', () => {
    expect(attemptBrief([], BUDGET)).toBe('')
    expect(promptVersionFor('ticket@1932', '')).toBe('ticket@1932')
  })

  /** How many there were, and what ended each. */
  it('states the count and every ending', () => {
    const brief = attemptBrief(filled(), BUDGET)

    expect(brief).toContain('attempted 2 times already')
    expect(brief).toContain('This is attempt 3')
    expect(brief).toContain('prepare failed at prepared:install')
    expect(brief).toContain('gates refused the diff')
  })

  /** The failing evidence, not just a category. */
  it('quotes what refused the last attempt', () => {
    expect(attemptBrief(filled(), BUDGET)).toContain('tsc: apps/board/src/lib/board.ts(12,5): error TS2322')
  })

  /** What the previous attempt produced, so building on it is an option. */
  it('says what the last attempt committed and where it is', () => {
    const brief = attemptBrief(filled(), BUDGET)

    expect(brief).toContain('4 file(s), +120 −3')
    expect(brief).toContain('git fetch origin agent/59')
    expect(brief).toContain('1a2b3c4')
  })

  it('says so plainly when the last attempt committed nothing', () => {
    const attempts = priorAttempts(history)
    const run = stream('pass-2')
    attempts[attempts.length - 1]!.outcome = attemptOutcome(
      [run('RunFailed', { kind: 'timeout', detail: 'killed by an operator timeout' })],
      BUDGET,
    )

    const brief = attemptBrief(attempts, BUDGET)
    expect(brief).toContain('It committed no change')
    expect(brief).not.toContain('git fetch origin')
  })

  /**
   * **`checkout <sha> -- .` is never offered for a kept WIP** (`#468`). That
   * command writes every path the WIP commit's tree holds into the worktree —
   * including files unrelated tickets changed on the base since the WIP was
   * made — which is not "taking its contents" the way a diff applied from the
   * WIP's own parent is. The brief must name `parentSha`, not just `sha`, so
   * only the WIP's own edits are offered.
   */
  it('offers a kept WIP as a diff from its own parent, never as a checkout', () => {
    const attempts = priorAttempts(history)
    const run = stream('pass-2')
    attempts[attempts.length - 1]!.outcome = attemptOutcome(
      [
        run('RunFailed', { kind: 'out-of-turns', detail: '60 turns, and the recipe allows 60' }),
        run('RunKeptUncommitted', {
          arm: 'agent/59-attempt-2',
          sha: 'c'.repeat(40),
          parentSha: 'a'.repeat(40),
          stoppedBy: 'out-of-turns',
          files: 3,
          insertions: 40,
          deletions: 2,
        }),
      ],
      BUDGET,
    )

    const brief = attemptBrief(attempts, BUDGET)
    expect(brief).toContain('git fetch origin agent/59-attempt-2')
    expect(brief).toContain('git diff aaaaaaa ccccccc | git apply')
    expect(brief).not.toContain('checkout')
    expect(brief).not.toContain('reset --hard')
  })

  /**
   * Not knowing and knowing there was nothing are different facts, and only one
   * of them is true when the run's stream was never read. Saying "it committed
   * no change" there would be an invention in a prompt.
   */
  it('claims nothing about a run whose stream nobody read', () => {
    const brief = attemptBrief(priorAttempts(history), BUDGET)

    expect(brief).toContain('gates refused the diff')
    expect(brief).not.toContain('### What attempt 2 produced')
    expect(brief).not.toContain('It committed no change')
  })

  /**
   * **The context is bounded**, and both bounds are here: a fifth attempt names
   * at most `budget.attempts` earlier ones and quotes exactly one run's output,
   * clamped to `budget.evidence`. Nothing in the shape of this brief grows with
   * the number of attempts except one table row.
   */
  it('keeps a long history and a long gate log bounded', () => {
    const many = stream('ticket-lingtai-59')
    const events = Array.from({ length: 8 }, (_, i) => [
      many('TicketClaimed', claim(`pass-${i + 1}`)),
      many('TicketReleased', released(`pass-${i + 1}`, `attempt ${i + 1} failed`)),
    ]).flat()

    const attempts = priorAttempts(events)
    const run = stream('pass-8')
    attempts[attempts.length - 1]!.outcome = attemptOutcome(
      [run('StepEnded', ended('pass-8', 'build', verdictAction('tsc', 'x'.repeat(10_000), 'refused')))],
      BUDGET,
    )

    const brief = attemptBrief(attempts, BUDGET)
    const rows = brief.split('\n').filter((l) => l.startsWith('| ') && l.includes('`pass-'))

    expect(rows).toHaveLength(BUDGET.attempts)
    expect(brief).toContain('3 earlier attempt(s), omitted')
    expect(brief).toContain(`…elided ${10_000 - BUDGET.evidence} of 10000 characters here`)
    expect(brief.length).toBeLessThan(BUDGET.evidence + 3_000)
    // The one that would break the bound: an earlier run's output, pasted too.
    expect(brief).not.toContain('attempt 1 failed')
  })

  /**
   * **#171.** A vitest run prints every passing file before the first `FAIL`, so
   * the head of a failed build is the part that says nothing went wrong. A fix
   * round on #169 was shown 2000 characters of `✓` and committed nothing.
   *
   * The fixture is the build's evidence as `runCommand` stores it — the exit
   * line, then `tail()` of the output — with two failing tests, a diff of an
   * ordinary event payload each, and `pnpm`'s `ELIFECYCLE` after the summary, so
   * the first ` FAIL ` sits well over 1000 characters from the end. Quoted at
   * this repository's own `runtime.budget.evidence`, it names the test and the
   * assertion; quoted at the default's two ends, it does not, and that is the
   * reason the recipe does not use the default.
   */
  it("quotes a vitest-shaped failure at this recipe's budget with its FAIL still in it", () => {
    const passes = Array.from(
      { length: 200 },
      (_, i) =>
        ` ✓ packages/conductor/test/run-once-${i}.test.ts > the merge lane > holds at a human action (48 tests | 3 skipped) 12034ms`,
    )
    const failed = (name: string) => [
      ` FAIL  packages/event-store/test/store.test.ts > ${name}`,
      "AssertionError: expected { type: 'TicketClaimed', …(3) } to deeply equal { type: 'TicketClaimed', …(3) }",
      '',
      '- Expected',
      '+ Received',
      '',
      '  {',
      ...Array.from(
        { length: 5 },
        (_, i) =>
          `-   "field${i}": "ticket-lingtai-169/pass-42ae0c78-1c72-480b-9b1e-be4bd6b0a819/expected-${i}",\n+   "field${i}": "ticket-lingtai-169/pass-42ae0c78-1c72-480b-9b1e-be4bd6b0a819/received-${i}",`,
      ),
      '  }',
      '',
      ` ❯ packages/event-store/test/store.test.ts:88:21`,
      '',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯',
    ]
    const output = [
      ...passes,
      ...failed('appends'),
      ...failed('reads back'),
      ' Test Files  1 failed | 200 passed (201)',
      '      Tests  2 failed | 2400 passed (2402)',
      '   Start at  23:06:11',
      '   Duration  370.12s',
      ' ELIFECYCLE  Test failed. See above for more details.',
      'ELIFECYCLE  Command failed with exit code 1.',
    ].join('\n')
    const evidence = `pnpm typecheck && pnpm test && pnpm test:db exited 1 after 370.1s\n\n${tail(output)}`
    expect(evidence.length - evidence.indexOf(' FAIL  ')).toBeGreaterThan(1_000)
    expect(tail(output)).toContain(' FAIL  packages/event-store/test/store.test.ts > appends')

    const own = readFileSync(new URL('../../../.lingtai/config.yaml', import.meta.url), 'utf8')
    const recipe = Number(/^  budget:\n    evidence: (\d+)$/m.exec(own)?.[1])
    expect(recipe).toBeGreaterThanOrEqual(EVIDENCE_BYTES)

    const briefAt = (evidenceBudget: number) => {
      const budget = { ...BUDGET, evidence: evidenceBudget }
      const run = stream('pass-1')
      const attempts = priorAttempts([
        stream('ticket-lingtai-169')('TicketClaimed', claim('pass-1')),
        stream('ticket-lingtai-169')('TicketReleased', released('pass-1', 'gates refused the diff')),
      ])
      attempts[0]!.outcome = attemptOutcome(
        [run('StepEnded', ended('pass-1', 'build', verdictAction('tsc', evidence, 'refused')))],
        budget,
      )
      return attemptBrief(attempts, budget)
    }

    const brief = briefAt(recipe)
    expect(brief).toContain('FAIL  packages/event-store/test/store.test.ts > appends')
    expect(brief).toContain("AssertionError: expected { type: 'TicketClaimed'")
    expect(brief).toContain('exited 1 after 370.1s')
    expect(brief).not.toContain('…elided')

    const atDefault = briefAt(BUDGET.evidence)
    expect(atDefault).not.toContain('FAIL  packages/event-store/test/store.test.ts > appends')
    expect(atDefault).toContain(`…elided ${evidence.length - BUDGET.evidence} of ${evidence.length} characters here`)
  })

  /**
   * The other runner: `tsc` prints its errors first, and a tail-only capture
   * loses them before `clamp` is ever reached. The fixture is this repository's
   * own `pnpm typecheck` failing — its preamble verbatim, 31 lines of `pnpm -r`
   * before the first error — with 200 more errors after it, and it goes through
   * `tail()` as `runCommand` stores it, not straight into `clamp`.
   */
  it('quotes a tsc-shaped failure past the capture with its first error still in it', () => {
    const output = [
      '$ pnpm -r --if-present typecheck',
      'Scope: 18 of 19 workspace projects',
      'packages/domain typecheck$ tsc --noEmit',
      'packages/extension typecheck$ tsc --noEmit',
      'packages/env typecheck$ tsc --noEmit',
      'packages/hook typecheck$ tsc --noEmit',
      'packages/hook typecheck: Done',
      'packages/telegram typecheck$ tsc --noEmit',
      'packages/extension typecheck: Done',
      'packages/env typecheck: Done',
      'packages/domain typecheck: Done',
      'packages/telegram typecheck: Done',
      'packages/event-store typecheck$ tsc --noEmit',
      'packages/agent-env typecheck$ tsc --noEmit',
      'packages/github typecheck$ tsc --noEmit',
      'packages/recipe typecheck$ tsc --noEmit',
      'packages/agent-env typecheck: Done',
      'packages/github typecheck: Done',
      'packages/recipe typecheck: Done',
      'packages/event-store typecheck: Done',
      'packages/agent typecheck$ tsc --noEmit',
      'packages/repo typecheck$ tsc --noEmit',
      'packages/projector typecheck$ tsc --noEmit',
      'packages/projector typecheck: Done',
      'packages/agent typecheck: Done',
      'packages/repo typecheck: Done',
      'apps/site typecheck$ tsc --noEmit',
      'packages/actions typecheck$ tsc --noEmit',
      'packages/actions typecheck: Done',
      'apps/site typecheck: Done',
      'packages/conductor typecheck$ tsc --noEmit',
      "packages/conductor typecheck: src/attempts.ts(393,10): error TS2322: Type 'number' is not assignable to type 'string'.",
      ...Array.from(
        { length: 200 },
        (_, i) =>
          `packages/conductor typecheck: src/generated-${i}.ts(1,1): error TS6133: 'unused' is declared but its value is never read.`,
      ),
      'packages/conductor typecheck: Found 201 errors in 201 files.',
      'packages/conductor typecheck: Failed',
      '[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @lingtai/conductor@0.0.0 typecheck: `tsc --noEmit`',
      'Exit status 2',
      '[ELIFECYCLE] Command failed with exit code 2.',
    ].join('\n')
    const evidence = `pnpm typecheck && pnpm test && pnpm test:db exited 2 after 41.2s\n\n${tail(output)}`
    expect(output.split('\n').slice(-60).join('\n')).not.toContain('TS2322')
    expect(evidence).toContain("error TS2322: Type 'number' is not assignable")
    expect(evidence).toContain('Found 201 errors in 201 files.')
    expect(evidence.length).toBeLessThanOrEqual(EVIDENCE_BYTES * 1.25 + 200)

    const own = readFileSync(new URL('../../../.lingtai/config.yaml', import.meta.url), 'utf8')
    const recipe = Number(/^  budget:\n    evidence: (\d+)$/m.exec(own)?.[1])
    const quoted = clamp(evidence, recipe)

    expect(quoted).toContain("error TS2322: Type 'number' is not assignable")
    expect(quoted).toContain('Found 201 errors in 201 files.')
    expect(quoted).toContain('exited 2 after 41.2s')
  })

  /** What fits is quoted whole, and says nothing about truncation it did not do. */
  it('leaves an output within the budget whole and unmarked', () => {
    const short = 'pnpm typecheck exited 2 after 9s\n\nsrc/x.ts(1,1): error TS2304'
    expect(clamp(short, BUDGET.evidence)).toBe(short)
    expect(clamp('x'.repeat(BUDGET.evidence), BUDGET.evidence)).not.toContain('elided')
  })

  /** The bound is still a bound: the two ends together are the budget, not twice it. */
  it("keeps exactly the budget's worth of characters across the two ends", () => {
    const text = `${'a'.repeat(5_000)}${'b'.repeat(5_000)}`
    const quoted = clamp(text, 101)
    const [head, marker, tail] = quoted.split('\n')

    expect(head).toBe('a'.repeat(51))
    expect(tail).toBe('b'.repeat(50))
    expect(marker).toBe('…elided 9899 of 10000 characters here; the start and the end are shown…')
  })

  /** A reason with a newline in it must not break the table it sits in. */
  it('keeps a multi-line release reason on one row', () => {
    const e = stream('ticket-lingtai-59')
    const brief = attemptBrief(
      priorAttempts([
        e('TicketClaimed', claim('pass-1')),
        e('TicketReleased', released('pass-1', 'conflict:\napps/page.tsx\napps/x.tsx')),
      ]),
      BUDGET,
    )

    expect(brief).toContain('| 1 | `pass-1` | conflict: apps/page.tsx apps/x.tsx |')
  })
})

/**
 * **Where an earlier attempt's commits are** (#315, 0072 §4): the arm's name,
 * derived from the attempt's ordinal and printed only when `origin` has it, in
 * the row that says how that attempt ended.
 */
describe('attemptBrief, naming the arms', () => {
  const item = stream('ticket-lingtai-314')
  const history = [
    item('TicketClaimed', claim('pass-1')),
    item('TicketReleased', released('pass-1', 'the run hit its session limit')),
    item('TicketClaimed', claim('pass-2')),
    item('TicketReleased', released('pass-2', 'refused: the approach')),
  ]
  const onOrigin = (...names: string[]) => ({ branch: 'agent/314', onOrigin: new Set(names) })

  it("names an attempt's arm in the same row as how it ended", () => {
    const brief = attemptBrief(priorAttempts(history), BUDGET, onOrigin('agent/314-attempt-1'))

    expect(brief).toContain('| 1 | `pass-1` | the run hit its session limit | `agent/314-attempt-1` |')
  })

  /** An attempt that died before it committed pushed no arm, and its name is not offered. */
  it('names no ref for an attempt that pushed nothing', () => {
    const brief = attemptBrief(priorAttempts(history), BUDGET, onOrigin('agent/314-attempt-1'))
    const row = brief.split('\n').find((line) => line.startsWith('| 2 |'))

    expect(row).toBe('| 2 | `pass-2` | refused: the approach |  |')
    expect(brief).not.toContain('agent/314-attempt-2')
  })

  /** Null is *nobody asked*; an empty set is *origin has none*. Neither names a ref. */
  it('renders a lookup nobody made the same as one that found nothing', () => {
    const attempts = priorAttempts(history)

    expect(attemptBrief(attempts, BUDGET, null)).toBe(attemptBrief(attempts, BUDGET, onOrigin()))
    expect(attemptBrief(attempts, BUDGET, null)).not.toContain('-attempt-')
  })

  it('is still empty for a first attempt, whatever it is told about arms', () => {
    expect(attemptBrief([], BUDGET, onOrigin('agent/314-attempt-1'))).toBe('')
  })

  /**
   * **The brief offers and does not instruct** (0072 §5). This is the half that
   * erodes silently: a sentence telling the agent to continue from an arm reads
   * as helpful, and it is the accretion 0072 refused.
   */
  it('offers the arms without telling the agent to build on them', () => {
    const attempts = priorAttempts(history)
    const brief = attemptBrief(attempts, BUDGET, onOrigin('agent/314-attempt-1'))

    expect(brief).toContain('git show <ref>:<path>')
    expect(brief).toContain('Read them against how')
    expect(brief).toContain('yours to judge')
    expect(brief).not.toMatch(/build(ing)? on|continu(e|ing) from|start(ing)? from|cherry-pick/i)
    expect(attemptBrief(attempts, BUDGET, onOrigin())).not.toContain('git show <ref>')
  })
})

describe('promptVersionFor', () => {
  /**
   * The criterion that made the defect invisible. Both attempts at `#59`
   * recorded `promptVersion: "ticket@1911"`, so the log could not say that the
   * second one had been told anything the first had not — and it had not.
   */
  it('distinguishes two attempts told different things', () => {
    const first = promptVersionFor('ticket@1932', '')
    const second = promptVersionFor('ticket@1932', 'the build refused')
    const third = promptVersionFor('ticket@1932', 'the review refused')

    expect(first).toBe('ticket@1932')
    expect(second).not.toBe(first)
    expect(third).not.toBe(second)
    expect(second).toMatch(/^ticket@1932\+failure@[0-9a-f]{12}$/)
  })

  /** The same context twice is the same version — it is a fingerprint, not a counter. */
  it('is stable for the same context', () => {
    expect(promptVersionFor('ticket@1932', 'the build refused')).toBe(
      promptVersionFor('ticket@1932', 'the build refused'),
    )
  })
})
