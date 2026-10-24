import type { QueueActionDeps, WorkActionDeps } from '@lingtai/actions'
import {
  NO_DESIGN,
  createAgentAction,
  createDraftAction,
  createKeptRunAction,
  createMergeAction,
  createQueueAction,
  createWorkAction,
  createWorktreeAction,
  type Action,
  type ActionContext,
  type ActionFinding,
  type ActionResult,
  type CutAnswer,
  type LandAnswer,
  type MergeStrategy,
  type TakeAnswer,
} from '@lingtai/actions'
/**
 * The six bodies, read through the loop rather than beside it.
 *
 * Every test here calls `runPass` with `bodiesFor(ports)` and asserts on the
 * `PassResult`, because a body's whole job is *which ending this answer is* and
 * an ending only means something where the loop reads it: a refusal travels to
 * `proposed`, a `needs-input` is the one `did-not-finish` with anywhere to go,
 * and a `never-ran` releases the item. Calling a body directly would check the
 * return value and nothing the return value is for.
 *
 * Nothing leaves the system. `PassPorts` is a fake — no process, no worktree, no
 * agent, no GitHub, no store — which is what puts this file in `unit/` and has
 * the `build` point run it ([0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md)
 * §1).
 */
import type { RunOutcome, Runtime } from '@lingtai/agent'
import type { Envelope, PayloadOf, ToAppend } from '@lingtai/domain'
import { StepMap, type QueueSettings, type StepAction } from '@lingtai/recipe'
import type { Worktree } from '@lingtai/repo'
import { describe, expect, it } from 'vitest'

import { BUILT_IN, BUILT_IN_FOR, judgeDeclaredAt } from '../src/judge.ts'
import {
  END_UNRESOLVED,
  bodiesFor,
  type Brief,
  type Claimed,
  type Judged,
  type Judging,
  type PassPorts,
  type Worked,
} from '../src/pass-steps.ts'
import { NEEDS_INPUT, claimStep, outcomeOf, runPass, type PassOptions, type PassOver } from '../src/pass.ts'

// --------------------------------------------------------------- fixtures ----

const BASE = '0000000000000000000000000000000000000000'
const CUT_AT = '1111111111111111111111111111111111111111'
const COMMITTED = '2222222222222222222222222222222222222222'

const context: ActionContext = { runId: 'pass-1', onSha: BASE, cwd: '/nowhere', env: {} }

const ITEM: Claimed = {
  ticketId: 'ticket-lingtai-259',
  ticket: { ref: '259', title: 'T4a', body: 'six bodies, filling a contract that already runs' },
  kind: 'feature',
}

/**
 * The four values a `queue:` action carries, as `conduct.ts`'s `defaultsAt`
 * builds them off `queueOf(recipe)` where a recipe declares nothing (`#269`).
 *
 * All four, because a block is all four: the schema requires them, and `queueOf`
 * writes `take: both` where the machine file names nobody.
 */
const QUEUE: QueueSettings = {
  kinds: ['bug', 'feature'],
  exclude: ['agent:hold'],
  backoff: '1h',
  assignee: { take: 'both' },
}

const TREE: Worktree = {
  path: '/nowhere/worktrees/lingtai/run-1',
  branch: 'agent/259',
  baseSha: CUT_AT,
  plantedAt: '/nowhere/worktrees/lingtai/run-1/.env',
  remoteHead: null,
}

const CLOSE_ON_LANDED: StepAction = { name: 'close the ticket', close: true, when: 'landed' }
const HOLD_ON_BLOCKED: StepAction = { name: 'hold it', labels: ['agent:hold'], when: 'blocked' }

const MERGED = '3333333333333333333333333333333333333333'

const PASSED: ActionResult = { verdict: 'passed', evidence: 'green', findings: [] }
const RED: ActionResult = { verdict: 'failed', evidence: 'pnpm install exited 1', findings: [] }

/**
 * A finding with a `failureScenario`, which is the whole of what makes it worth an
 * agent: *something the fixer could not have authored* (0038 §2).
 */
const BLOCKER: ActionFinding = {
  file: 'packages/conductor/src/pass.ts',
  line: 1201,
  claim: 'the router is asked before the build',
  failureScenario: 'a red build pays for a review of a diff that does not compile',
  severity: 'blocker',
}

/** What a reviewer that says the diff stops here looks like — findings, and `failed`. */
const REVIEW_REFUSED: ActionResult = {
  verdict: 'failed',
  evidence: 'blocker packages/conductor/src/pass.ts:1201 — the router is asked before the build',
  findings: [BLOCKER],
}

/**
 * **An answer that really does defeat `parseFindings`** (`#279`) — a `major` with a
 * failure scenario in it, and no closing brace.
 *
 * `#269` attempt 3's shape, shortened: that answer was 4,629 characters of four
 * findings and ended `}]`, with `stop_reason: end_turn`, so nothing truncated it —
 * the model believed it had finished. The whole of it is a fixture in the package
 * the parser lives in (`packages/actions/test/fixtures/review-269-attempt-3.ts`);
 * what is needed here is only that the real parser refuses it, so that the route
 * below is reached through `createAgentAction` and not through a flag set by hand.
 */
const AN_ANSWER_NOBODY_CAN_READ =
  '{"findings":[{"file":"packages/recipe/src/recipe.ts","line":1413,"severity":"major",' +
  '"claim":"`whyThatPair` gained no `claim` branch","failureScenario":"an operator writes a ' +
  '`run:` at `claim` and is told to move it to `prepared`, which is false where it is printed"}]'

/**
 * **A real cold reviewer over a fake runtime**, for `createMergeAction`'s reason:
 * what these tests are about is the seam, and a `canned` result cannot reach the
 * one in question — `unreadable` is `parseFindings`'s answer, and a test that set
 * it by hand would assert the router and say nothing about how the flag gets there.
 * That gap is the bug (`#279`).
 */
const coldReviewerSaying = (text: string | null): Action =>
  createAgentAction(
    { name: 'cold reviewer', prompt: '' },
    {
      runtime: {
        capabilities: {
          id: 'claude-code',
          hooks: [],
          canFailClosed: true,
          canRewriteToolCall: false,
          providesTier: 'guarded',
          enforces: ['turns', 'wall'],
        },
        // `#269` attempt 3's receipt: `success · 61 turns · $8.97 · exit 0`. It is
        // what makes the loss expensive rather than merely wrong.
        run: async () => ({
          exitCode: 0,
          turns: 61,
          durationMs: 802_000,
          costUsd: 8.97,
          text,
          failure: null,
          sessionId: 's',
        }),
      },
      issue: async () => ({ ref: '269', title: 'T5d', body: 'the queue is a plugin at `claim`' }),
      diff: async () => 'diff --git a/x b/x\n+1',
      settingsPath: '/nowhere/settings.json',
      limits: { turns: 80, wallMs: 3_600_000, diffBytes: 400_000 },
    },
  )

const canned = (name: string, result: ActionResult): Action => ({
  name,
  kind: 'run',
  yields: 'verdict',
  run: async () => result,
})

/**
 * A declared `admit:` action that stands in for a real cut — the real
 * `worktree:` plugin reports where the tree was cut, and the action's own
 * context is where the tree was cut from, so this echoes `ctx.onSha` back as
 * the head rather than inventing one (`#469`, `work-action.ts:13-16`).
 */
const cutAt = (name: string): Action => ({
  name,
  kind: 'run',
  yields: 'worktree',
  run: async (ctx) => ({ ...PASSED, head: ctx.onSha }),
})

/**
 * A declared `implement:` action that stands in for a real commit — a real
 * commit is a new sha, so this one is fixed rather than echoing the context
 * back, unlike `cutAt` (`#469`).
 */
const committedSomething = (name: string, head = COMMITTED): Action => ({
  name,
  kind: 'run',
  yields: 'commit',
  run: async () => ({ ...PASSED, head }),
})

/** A recipe with only the ten steps on it, resolved by the real schema. */
const recipeWith = (steps: Record<string, unknown> = {}): PassOptions['recipe'] => ({
  steps: StepMap.parse(steps),
})

/** What the fake ports were asked, so a test can read the brief a step built. */
interface Asks {
  /**
   * What each `queue:` action was asked to select over — the four values, which
   * is the whole of what the take is handed since `#269`.
   *
   * Beside the ports rather than on them, for `cut`'s reason: `claim`'s work is a
   * plugin's now, so what a test reads back is the action's argument and not a
   * port call.
   */
  take: QueueSettings[]
  /**
   * What each `worktree:` action was asked to cut — its `base` and `submodules`,
   * which is the whole of what the cut is handed since `#268`.
   *
   * Beside the ports rather than on them: `admit`'s work is a plugin's now, so
   * what a test reads back is the action's argument and not a port call.
   */
  cut: { base: string; submodules: boolean }[]
  /**
   * Every prompt a drafting agent was handed, which is the whole of what a
   * design dispatch looks like since `#265`.
   *
   * Beside the ports rather than on them, for `cut`'s and `land`'s reason:
   * `design`'s work is an `agent:` action's now, so what a test reads back is
   * what the runtime was asked to run and not a port call.
   */
  draft: string[]
  dispatch: Brief[]
  /** Every brief a judge was handed, which is what *spends an agent* looks like. */
  judge: Judging[]
  /**
   * What each `merge:` action was asked to land — its `strategy` and the `onSha`
   * it was reached on, which is the whole of what the lane is handed since
   * `#270`.
   *
   * Beside the ports rather than on them, for `cut`'s reason: `merge`'s work is a
   * plugin's now, so what a test reads back is the action's argument and not a
   * port call.
   */
  land: { strategy: MergeStrategy; onSha: string }[]
  read: string[]
  record: { ticketId: string; at: number; plan: readonly ToAppend[] }[]
}

interface Answers {
  /** What the take answers. `ITEM`, taken, by default. */
  take?: TakeAnswer | (() => TakeAnswer)
  /** What the cut answers. Cut at `CUT_AT`, by default. */
  cut?: CutAnswer
  /**
   * What the drafting runtime answers, where a test declares an `agent:` at
   * `design`. A document and nothing else, by default.
   */
  draft?: Partial<RunOutcome>
  dispatch?: Worked | ((brief: Brief) => Worked)
  /** Nothing declared, by default: the built-ins and the person are what answer. */
  judge?: Judged | ((on: Judging) => Judged)
  /** What the lane answers. Merged at `MERGED`, by default. */
  land?: LandAnswer | (() => LandAnswer)
  /** The stream `end` reads. Empty is an item with nothing resolved on it. */
  stream?: readonly Envelope[]
  /** Thrown by `readEnd`, so `end`'s own failure can be reached. */
  readThrows?: Error
  recordThrows?: Error
}

function portsAnswering(answers: Answers = {}): {
  ports: PassPorts
  judge: NonNullable<PassOptions['judge']>
  asked: Asks
  taking: QueueActionDeps
  working: WorkActionDeps
} {
  const asked: Asks = {
    take: [],
    cut: [],
    draft: [],
    dispatch: [],
    judge: [],
    land: [],
    read: [],
    record: [],
  }
  const of = <T, A>(given: T | ((arg: A) => T) | undefined, fallback: T, arg: A): T =>
    given === undefined ? fallback : typeof given === 'function' ? (given as (a: A) => T)(arg) : given

  /**
   * **What `take` leaves behind, held where `conduct.ts` holds it** (`#269`).
   *
   * The take is an action's, so the item and its stream are the *caller's* fact
   * and the ports only read them — which is why the reset that begins a pass is
   * in the take below rather than in `claim`'s body: the action runs before the
   * body, and a reset written there would wipe what it had just taken.
   */
  let took: Claimed | null = null
  let onStream: string | null = null

  /**
   * The take, as the `queue:` action runs it — **and the reset is the first thing
   * in it**, for the reason `conduct.ts` puts it there: the three ways it can
   * decline set no item, and it was exactly those that would let `end` resolve
   * onto the item the pass before had landed.
   */
  const taking: QueueActionDeps = {
    take: async (spec) => {
      asked.take.push(spec)
      took = null
      onStream = null
      const answer = of<TakeAnswer, undefined>(
        answers.take,
        { taken: { ticketId: ITEM.ticketId, kind: ITEM.kind } },
        undefined,
      )
      if ('taken' in answer) {
        took = { ...ITEM, ticketId: answer.taken.ticketId, kind: answer.taken.kind }
        onStream = answer.taken.ticketId
      } else if ('mayHold' in answer) {
        // The one decline that leaves a stream behind: `end` still resolves
        // against it, because an item this run may be holding is one somebody has
        // to be told about.
        onStream = answer.mayHold.ticketId
      }
      return answer
    },
  }

  /**
   * **The dispatch, as the `agent:` action at `implement` runs it** (`#266`).
   *
   * Beside the ports rather than on them, for `cut`'s and `draft`'s reason: the
   * one agent is a plugin's now, so what a test reads back is what the action was
   * handed and not a port call. The brief is assembled here because it is
   * assembled in `conduct.ts` — the ticket off the item the take left, the design
   * and the *why again* off the context `runStep` filled — so the assertions below
   * are about the same object the conductor builds.
   */
  const working: WorkActionDeps = {
    work: async (_spec, context) => {
      const brief: Brief = {
        ticket: (took ?? ITEM).ticket,
        design: context.design ?? NO_DESIGN,
        again: context.again ?? null,
        context,
      }
      asked.dispatch.push(brief)
      return of(answers.dispatch, { committed: COMMITTED }, brief)
    },
  }

  // `#462`: the judge port moved off `PassPorts` onto `PassOptions.judge` —
  // `proposed`'s own body never asks one any more, `runPass`'s loop does.
  const judge: NonNullable<PassOptions['judge']> = async (on) => {
    asked.judge.push(on)
    return of(answers.judge, { noJudge: true }, on)
  }

  const ports: PassPorts = {
    onStream: () => onStream,
    readEnd: async (ticketId) => {
      asked.read.push(ticketId)
      if (answers.readThrows) throw answers.readThrows
      return answers.stream ?? []
    },
    recordEnd: async (ticketId, at, plan) => {
      asked.record.push({ ticketId, at, plan })
      if (answers.recordThrows) throw answers.recordThrows
    },
  }
  return { ports, judge, asked, taking, working }
}

/**
 * One run of the whole pass, with whatever the recipe declares and the ports
 * say.
 *
 * **`claim` runs first and separately** (0120 §6, `#463`): `claimStep` is
 * called before `runPass`, over the same options, exactly as `conduct.ts`
 * now calls it. The default answer always takes the item, so every one of
 * this file's other tests sees the walk `runPass` itself runs — `admit`
 * through `end` — and nothing about `claim`'s own three declines, which
 * `describe('claim runs the \`queue:\` plugin, and cannot refuse', …)` below
 * tests directly against `claimStep`.
 */
async function pass(
  options: {
    steps?: Record<string, unknown>
    answers?: Answers
    actions?: Record<string, readonly Action[]>
    ceilings?: PassOptions['ceilings']
    from?: PassOptions['from']
  } = {},
): Promise<{ result: PassOver; asked: Asks; ports: PassPorts }> {
  const { ports, judge, asked, taking, working } = portsAnswering(options.answers)
  /**
   * **`claim`'s, `admit`'s and `merge`'s defaults, as `conduct.ts`'s `defaultsAt`
   * supplies them** (0065 §3).
   *
   * All three bodies are empty — `admit`'s since `#268`, `merge`'s since `#270`
   * and `claim`'s since `#269` — so a pass whose recipe declares nothing there
   * takes nothing, cuts nothing and lands nothing unless the caller substitutes,
   * and *the caller substitutes* is the decision rather than a detail of the
   * conductor. Mirrored here rather than imported, because importing `conduct.ts`
   * would bring a GitHub client and a store into a file whose whole claim is that
   * nothing leaves the system.
   */
  const claiming = (): Action => createQueueAction({ name: 'take the ticket', ...QUEUE }, taking)
  const cutting = (): Action =>
    createWorktreeAction(
      { name: 'cut the branch', base: 'main', submodules: false },
      {
        cut: async (spec) => {
          asked.cut.push(spec)
          return options.answers?.cut ?? { head: CUT_AT, where: TREE.path }
        },
      },
    )
  /**
   * **The `agent:` a recipe declares at `design`** (`#265`) — the drafting
   * action, over a runtime that runs no process.
   *
   * Not supplied by `defaultsAt`: `design` has no default row, because the port
   * this replaced dispatched nothing and *behaves exactly as today* is what an
   * unconfigured step has to keep doing. So a test that wants a design declares
   * one, which is what a recipe does.
   */
  const drafting = (): Action =>
    createDraftAction(
      { name: 'draft the design', prompt: '' },
      {
        runtime: {
          capabilities: {
            id: 'claude-code',
            hooks: [],
            canFailClosed: true,
            canRewriteToolCall: false,
            providesTier: 'guarded',
            enforces: ['turns', 'wall'],
          },
          run: async (request: { prompt: string }) => {
            asked.draft.push(request.prompt)
            return {
              exitCode: 0,
              turns: 3,
              durationMs: 1,
              costUsd: null,
              failure: null,
              text: '',
              sessionId: 's-1',
              ...options.answers?.draft,
            }
          },
        } as unknown as Runtime,
        issue: async () => ({ ...ITEM.ticket }),
        // Never asked for at this step, and that is the point of the action
        // being its own: the reviewer would have returned `passed` on it.
        diff: async () => '',
        settingsPath: '/nowhere/settings.json',
        limits: { turns: 8, wallMs: 1_000, diffBytes: 1_000 },
      },
    )
  /**
   * **`implement`'s default, as `conduct.ts`'s `defaultsAt` supplies it**
   * (`#266`).
   *
   * Unlike `design`'s, this one is a default and not a declaration: the port it
   * replaced dispatched on every pass, so a recipe that says nothing at
   * `implement` still buys the one agent — which is what *behaves exactly as it
   * does today* means for the step that writes the code.
   */
  const writing = (): Action => createWorkAction({ name: 'write the change', prompt: '' }, working)
  const landing = (): Action =>
    createMergeAction(
      { name: 'land the branch', strategy: 'merge-commit' },
      {
        land: async (spec) => {
          asked.land.push(spec)
          const answer = options.answers?.land
          if (answer === undefined) return { merged: MERGED }
          return typeof answer === 'function' ? answer() : answer
        },
      },
    )
  const passOptions: PassOptions = {
    recipe: recipeWith(options.steps),
    context,
    emit: () => {},
    bodies: bodiesFor(ports),
    ceilings: options.ceilings,
    ...(options.from === undefined ? {} : { from: options.from }),
    judge,
    actionsAt: (step, actions) => {
      if (options.actions?.[step] !== undefined) return options.actions[step]
      // The one declared cell this file builds for real rather than canning: a
      // `design:` is the step's whole behaviour since `#265`, and a canned pass
      // would assert the body it replaced rather than the plugin that replaced it.
      if (step === 'design' && actions.length > 0) return [drafting()]
      // A declared `worktree:` or `agent:` at these two steps is a cut or a
      // commit, not a bare verdict — `headOf` reads the head off them, so a
      // plain `canned` here would make a declared, passing action misread as
      // `changedNothing` (`#467`, `#469`).
      if (step === 'admit' && actions.length > 0) return actions.map((a) => cutAt(a.name))
      if (step === 'implement' && actions.length > 0) return actions.map((a) => committedSomething(a.name))
      if (actions.length > 0) return actions.map((a) => canned(a.name, PASSED))
      if (step === 'claim') return [claiming()]
      if (step === 'admit') return [cutting()]
      if (step === 'implement') return [writing()]
      return step === 'merge' ? [landing()] : []
    },
  }
  await claimStep(passOptions)
  const result = await runPass(passOptions)
  return { result, asked, ports }
}

/** Every visit, as `<step>:<ending>`, which is the shape of the walk. */
const walk = (result: PassOver): string[] => result.steps.map((visit) => `${visit.step}:${visit.ending.ending}`)

const endRow = (plan: readonly ToAppend[]): PayloadOf<'EndActionsResolved'> =>
  plan[0]?.data as PayloadOf<'EndActionsResolved'>

// ------------------------------------------------------------------ claim ----

describe('claim runs the `queue:` plugin, and cannot refuse', () => {
  it('takes the item, and every step after it is about that item', async () => {
    const { result, asked } = await pass()

    expect(walk(result)).toEqual([
      'admit:passed',
      'prepared:passed',
      'design:passed',
      'implement:passed',
      'build:passed',
      'review:passed',
      'proposed:passed',
      'merge:passed',
      'end:passed',
    ])
    expect(asked.take).toEqual([QUEUE])
    expect(asked.cut).toEqual([{ base: 'main', submodules: false }])
    expect(asked.dispatch[0]?.ticket).toEqual(ITEM.ticket)
    // `end` resolves onto the stream `claim` named, and nowhere else.
    expect(asked.read).toEqual([ITEM.ticketId])
  })

  /**
   * The two declines that leave nothing behind. Neither is a refusal — 0058 §2,
   * *there is no item to hold and no diff to fix* — so neither buys a fix round
   * and neither reaches the router: `claim` is not in `ARRIVE_AT_THE_ROUTER`.
   *
   * **Through `claimStep`, not `pass()`** (`#463`): `claim` runs before
   * `runPass` now, so a decline is `claimStep`'s own answer and `runPass`
   * never starts — `conduct.ts`'s early return on `ending !== 'passed'` is
   * what makes that true in production, and this is the same call one layer
   * down, with no walk to run after it.
   */
  it.each([
    { answer: { passedOver: 'excluded-label' } as TakeAnswer, because: 'passed-over' },
    { answer: { notClaimed: 'held by local:41' } as TakeAnswer, because: 'not-claimed' },
  ])('declines the claim when the item was not taken ($because)', async ({ answer, because }) => {
    const { ports, asked, taking } = portsAnswering({ take: answer })
    const claiming = createQueueAction({ name: 'take the ticket', ...QUEUE }, taking)

    const claimed = await claimStep({
      recipe: recipeWith(),
      context,
      emit: () => {},
      bodies: bodiesFor(ports),
      actionsAt: (step) => (step === 'claim' ? [claiming] : []),
    })

    // The action's own `because`, travelling — `endingOf` reads it off the result
    // and `at` is the action that said it, where the body used to answer `null`.
    expect(claimed.ending).toEqual({
      ending: 'did-not-finish',
      because,
      at: 'take the ticket',
      detail: expect.any(String),
    })
    // Nothing was cut, nothing was dispatched — `claim` is the whole of this
    // walk, and there is no item for anything after it to be about.
    expect(asked.cut).toEqual([])
    expect(asked.dispatch).toEqual([])
    expect(asked.read).toEqual([])
  })

  /**
   * The third decline, and the one with a stream behind it: the claim's append
   * may have committed. `conduct.ts`'s own `onStream` (the closure `take`
   * writes, not `PassPorts.onStream`) is what tells its `release` that this
   * run may hold something to give back — `end` does **not** resolve for it
   * any more (`#463`: `end` runs only inside `runPass`, and `runPass` never
   * starts on a decline), which costs nothing observable, since
   * `release` only ever appended `endPlan` when `endedAs === 'failed'` and a
   * claim's own stop was never that outcome.
   */
  it('names the item when the claim may have committed, and leaves nothing for `runPass` to resolve', async () => {
    const { ports, asked, taking } = portsAnswering({
      take: { mayHold: { ticketId: 'ticket-lingtai-259', detail: 'connection reset' } },
    })
    const claiming = createQueueAction({ name: 'take the ticket', ...QUEUE }, taking)

    const claimed = await claimStep({
      recipe: recipeWith(),
      context,
      emit: () => {},
      bodies: bodiesFor(ports),
      actionsAt: (step) => (step === 'claim' ? [claiming] : []),
    })

    expect(claimed.ending).toMatchObject({ ending: 'did-not-finish', because: 'claim-unconfirmed' })
    const detail = 'detail' in claimed.ending ? claimed.ending.detail : ''
    expect(detail).toContain('ticket-lingtai-259')
    // `PassPorts.onStream()` names it too — the one decline that leaves a
    // stream behind, which is what lets a caller tell this run may be
    // holding something rather than nothing at all.
    expect(ports.onStream()).toBe('ticket-lingtai-259')
    expect(asked.read).toEqual([])
  })

  /**
   * One closure, two passes. `claim` is where a pass begins, so the item and its
   * stream are cleared by the take that makes them — a second pass that took
   * nothing must not resolve `end` onto the item the first one landed.
   *
   * **The reset is in the take and not in the body, since `#269`**, because the
   * action runs before the body: a `claim: async () => { took = null; … }` would
   * clear what the action had just taken, which is the one way this migration
   * could have been silently wrong.
   */
  it("forgets the previous pass's item when the next claim takes nothing", async () => {
    let first = true
    const { ports, asked, taking } = portsAnswering({
      take: () => {
        const answer: TakeAnswer = first
          ? { taken: { ticketId: ITEM.ticketId, kind: ITEM.kind } }
          : { passedOver: 'no kind label' }
        first = false
        return answer
      },
    })
    const bodies = bodiesFor(ports)
    const claiming = createQueueAction({ name: 'take the ticket', ...QUEUE }, taking)
    const passOptions: PassOptions = {
      recipe: recipeWith({ end: [CLOSE_ON_LANDED] }),
      context,
      emit: () => {},
      bodies,
      actionsAt: (step, actions) => (step === 'claim' ? [claiming] : actions.map((a) => canned(a.name, PASSED))),
    }
    // Mirrors `conduct.ts`: `runPass` runs only once `claimStep` answers `passed`.
    const run = async () => {
      const claimed = await claimStep(passOptions)
      return claimed.ending.ending === 'passed' ? await runPass(passOptions) : null
    }

    await run()
    const second = await run()

    // The second claim took nothing, so there is no walk to run and no
    // second `end` to resolve onto the item the first one landed.
    expect(second).toBeNull()
    expect(ports.onStream()).toBeNull()
    expect(asked.read).toEqual([ITEM.ticketId])
    expect(asked.record).toHaveLength(1)
  })
})

// ------------------------------------------------------------------ admit ----

describe('admit runs the `worktree:` plugin, and that is where the head comes from', () => {
  it('advances `onSha` to the base it cut, so every later visit is judged there', async () => {
    const judged: { step: string; onSha: string }[] = []
    const watching = (step: string): Action => ({
      name: step,
      kind: 'run',
      yields: 'verdict',
      run: async (ctx) => {
        judged.push({ step, onSha: ctx.onSha })
        return PASSED
      },
    })
    const { result, asked } = await pass({
      steps: { prepared: [{ name: 'install', run: 'true' }] },
      actions: { prepared: [watching('prepared')] },
    })

    expect(result.steps[0]?.ending).toEqual({ ending: 'passed', head: CUT_AT })
    // The pipeline at `prepared` and the agent at `implement` see the same head,
    // and it is the one the tree was cut at rather than the caller's base.
    expect(judged).toEqual([{ step: 'prepared', onSha: CUT_AT }])
    expect(asked.dispatch[0]?.context.onSha).toBe(CUT_AT)
  })

  /**
   * **A declared `worktree:` is what runs, and `admit` runs nothing else**
   * (`#268`).
   *
   * This is the half of `#268`'s first major finding that had to be closed: a
   * `worktree:` at `admit` used to resolve, be recorded in `StepsResolved` as
   * planned, and produce no verdict — so the item landed with a point the log
   * said was configured and never ran, which is the mark reserved for Lingtai's
   * own bug (0016 §4, and 0065 §5). It cannot arise now because the step runs
   * what is declared there: the action produces `StepStarted` and a verdict like
   * any other, and the `head` on the ending is the proof it did the work rather
   * than merely being listed.
   */
  it("cuts from what the recipe declares, and the head is the action's", async () => {
    const asked: { base: string; submodules: boolean }[] = []
    const declared = createWorktreeAction(
      { name: 'cut the branch', base: '1.0', submodules: true },
      {
        cut: async (spec) => {
          asked.push(spec)
          return { head: CUT_AT, where: TREE.path }
        },
      },
    )
    const { result } = await pass({
      steps: { admit: [{ name: 'cut the branch', worktree: { base: '1.0', submodules: true } }] },
      actions: { admit: [declared] },
    })

    expect(asked).toEqual([{ base: '1.0', submodules: true }])
    expect(result.steps[0]).toMatchObject({
      step: 'admit',
      ending: { ending: 'passed', head: CUT_AT },
      results: [{ action: 'cut the branch', verdict: 'passed' }],
    })
  })

  it('stops the pass when the tree could not be cut, and buys nothing', async () => {
    const { result, asked } = await pass({ answers: { cut: { notCut: 'no such base ref' } } })

    expect(walk(result)).toEqual(['admit:did-not-finish', 'proposed:routed', 'end:passed'])
    // The action's name rather than `null`, which is the one thing that changed
    // when the work left the body: `endingOf` names what did not finish.
    expect(result.stopped?.ending).toMatchObject({
      ending: 'did-not-finish',
      because: 'did-not-finish',
      at: 'cut the branch',
      detail: expect.stringContaining('no such base ref'),
    })
    // It does reach the router (`#472`'s `Propose{SetupRefused}`), but `admit`
    // is not born at or after `implement`, so `offerFor` never offers
    // `fix-lines` — only `restart` and `hand-to-person` are, and with no
    // judge declared no round is bought. And no head, so `onSha` is still
    // the base the caller handed in — nothing was cut.
    expect(result.routes).toHaveLength(1)
    expect(result.routes[0]).toMatchObject({ from: 'admit', chose: 'waiting', to: 'waiting' })
    expect(result.stopped?.ending).not.toHaveProperty('head')
    expect(asked.draft).toEqual([])
  })

  /**
   * **A question from the plugin holds the item, through the same
   * `SetupRefused` route any other `NotDone` takes** (`#268`, routed since
   * `#472`).
   *
   * `CutAnswer.asked` is the same affordance `Asked` was — 0058 §3b's edge out of
   * `admit` for a step that stopped and asked — and a plugin asks with the one
   * verdict the pipeline has for it: `needs-approval`, which `endingOf` reads as
   * `held` and `actionOf` reads as the `worktree` yield's own `NotDone` — there
   * is no `Asked` for a `worktree`. So `nextOf` answers it `Propose{SetupRefused}`
   * like any other `NotDone`, and it does visit `proposed`'s router; `admit` is
   * not born at or after `implement`, so no round is bought and nothing but
   * `hand-to-person` is ever chosen with no judge declared.
   */
  it('holds the item when the cut asks a question', async () => {
    const { result } = await pass({ answers: { cut: { asked: 'which base — main or 1.0?' } } })

    expect(walk(result)).toEqual(['admit:held', 'proposed:routed', 'end:passed'])
    expect(result.stopped).toEqual({
      step: 'admit',
      ending: { ending: 'held', at: 'cut the branch', question: 'which base — main or 1.0?' },
    })
    expect(result.routes).toHaveLength(1)
    expect(result.routes[0]).toMatchObject({ from: 'admit', chose: 'waiting', to: 'waiting' })
  })
})

// --------------------------------------------------------------- prepared ----

describe('prepared refuses, and the refusal reports like any other', () => {
  /**
   * **Since `#472` it does route, and still rests the same.** `endingOf`
   * still reads a `failed` verdict at a refusing step as a refusal —
   * `result.stopped` names the install exactly as it always did — and
   * `nextOf` now answers `prepared`'s own refusal `Propose{SetupRefused}`,
   * so it visits `proposed`'s router: no agent has run, so `fix-lines` is
   * never on offer (`offerFor`'s `bornAtOrAfterImplement`), and with no
   * judge declared the pass rests with a person exactly as it did before
   * this ticket — `result.end` is `WaitOnPerson{ProposedEscalated{SetupRefused}}`
   * now, not the direct `SetupRefused`, and the equality `#471` pinned is
   * what keeps the wait the same either way.
   */
  it('carries a failed install to a person, naming the install and not the router', async () => {
    const { result } = await pass({
      steps: { prepared: [{ name: 'install', run: 'pnpm install --frozen-lockfile' }] },
      actions: { prepared: [canned('install', RED)] },
    })

    expect(walk(result)).toEqual(['admit:passed', 'prepared:refused', 'proposed:routed', 'end:passed'])
    expect(result.stopped).toEqual({
      step: 'prepared',
      ending: {
        ending: 'refused',
        because: 'action-refused',
        at: 'install',
        detail: 'pnpm install exited 1',
      },
    })
    expect(result.routes).toHaveLength(1)
    expect(result.routes[0]).toMatchObject({ from: 'prepared', chose: 'waiting', to: 'waiting' })
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', proposal: { _tag: 'SetupRefused', from: 'prepared' } },
    })
    expect(outcomeOf(result.end)).toBe('blocked')
  })

  /**
   * 0061 §3's worked example, from the other side: a failed install refuses
   * before any agent has run, so there is no diff and no error in one to fix.
   * **Since `#472` the refusal does reach the router**, but the destination
   * set `implement` would have been missing from is never built with
   * `implement` in it: `bornAtOrAfterImplement('prepared')` is false, so the
   * offer is `restart`/`hand-to-person` alone — the claim this test's own
   * name makes is still true, by *offering* rather than by never asking.
   */
  it('never offers the judge `implement` for a `prepared` refusal, by never offering it', async () => {
    const { result, asked } = await pass({
      steps: { prepared: [{ name: 'install', run: 'false' }] },
      actions: { prepared: [canned('install', RED)] },
      ceilings: { rounds: 3, restarts: 1, restartsSpent: 0 },
    })

    expect(asked.judge[0]?.offering).not.toContain('implement')
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', proposal: { _tag: 'SetupRefused', from: 'prepared' } },
    })
  })

  /**
   * **A declared `judge:` is asked, and its answer is taken** — the half of
   * routing a `human:`/`no-judge-declared` test cannot show. `restart` is
   * offered beside `hand-to-person` (`hasCriterion` off the install's own
   * evidence), so a judge choosing it spends the restart rather than reaching
   * a person, exactly as it would for any other of the seven.
   */
  it('restarts a `prepared` refusal when a judge is declared for it', async () => {
    const { result, asked } = await pass({
      steps: { prepared: [{ name: 'install', run: 'false' }] },
      actions: { prepared: [canned('install', RED)] },
      answers: { judge: { next: 'claim', named: 'claude-code', why: 'fresh worktree' } },
      ceilings: { rounds: 3, restarts: 1, restartsSpent: 0 },
    })

    expect(asked.judge[0]?.when).toBe('setup-refused')
    expect(result.end).toMatchObject({ _tag: 'Requeued', cause: { _tag: 'Restart' } })
  })

  it('passes on a green install, and adds nothing of its own', async () => {
    const { result } = await pass({
      steps: { prepared: [{ name: 'install', run: 'true' }] },
    })

    expect(result.steps[1]?.ending).toEqual({ ending: 'passed' })
    // The body added no head, no reason and no findings — the visit is its
    // plugins' and nothing else.
    expect(result.steps[1]?.results.map((r) => r.verdict)).toEqual(['passed'])
  })
})

// ----------------------------------------------------------------- design ----

describe('design runs the `agent:` plugin, and nothing is an answer', () => {
  /** A recipe with a drafting agent at `design`, which is the whole of the step. */
  const DECLARED: Record<string, readonly StepAction[]> = {
    design: [{ name: 'draft the design', agent: 'claude-code', prompt: '' } as StepAction],
  }

  /**
   * **The ticket's *watch out*, and it is now a claim about the default rather
   * than about a port** (`#265`).
   *
   * `defaultsAt` has no row for `design`, so a recipe that says nothing there
   * runs nothing — which is what `ports.draft` answering `{ document: "" }` did,
   * without the port. The step still appears in the walk, `implement` is briefed
   * with `""` and works from the issue's own text, and no agent is paid.
   */
  it('runs nothing where the recipe declares nothing, and briefs `implement` from the issue', async () => {
    const { result, asked } = await pass()

    expect(result.steps[2]).toEqual({
      step: 'design',
      ending: { ending: 'passed' },
      results: [],
      outcome: { step: 'design', round: 0, actions: [] },
    })
    expect(asked.draft).toEqual([])
    expect(asked.dispatch[0]?.design).toEqual({ document: '' })
    expect(asked.dispatch[0]?.ticket.body).toBe(ITEM.ticket.body)
    expect(result.stopped).toBeNull()
    expect(outcomeOf(result.end)).toBe('landed')
  })

  /**
   * An empty document is a **pass** — not a skip and not a failure — and it is
   * the agent's answer rather than the absence of one: the action ran, the
   * runtime said nothing, and `implement` is briefed identically to the case
   * above. There is no conditional step.
   */
  it('passes on an empty document, and `implement` is still briefed from the issue', async () => {
    const { result, asked } = await pass({ steps: DECLARED, answers: { draft: { text: '' } } })

    expect(result.steps[2]?.ending).toEqual({ ending: 'passed', design: { document: '' } })
    expect(asked.draft).toHaveLength(1)
    // The ticket is in the prompt, and the rule that makes the empty answer real.
    expect(asked.draft[0]).toContain(ITEM.ticket.body)
    expect(asked.draft[0]).toContain('Answering with nothing is a real answer')
    expect(asked.dispatch[0]?.design).toEqual({ document: '' })
    expect(outcomeOf(result.end)).toBe('landed')
  })

  it('hands a document it did write to the agent at `implement`', async () => {
    const { asked } = await pass({
      steps: DECLARED,
      answers: { draft: { text: '## The shape\n\nSix bodies.' } },
    })

    expect(asked.dispatch[0]?.design).toEqual({ document: '## The shape\n\nSix bodies.' })
    // And no locator, because nothing kept it anywhere: the `agent:` at `design`
    // writes no file, so the third of `TheDesign`'s facts is absent (`#297`).
    expect(asked.dispatch[0]?.design.locator).toBeUndefined()
  })

  /**
   * 0061 §3 puts `agent:` at `design` as well as at `implement`, so a design
   * agent meets the account's wall identically — and the answer has to be the
   * same one: `never-ran`, which releases the item rather than holding it for a
   * person. It does not reach the router, because paying an agent to ask what to
   * do about a quota is the one route that cannot work.
   */
  it('stands the conductor down when its agent never started', async () => {
    const { result } = await pass({
      steps: DECLARED,
      answers: {
        draft: { turns: 1, failure: { kind: 'never-started', detail: 'session limit' } },
      },
    })

    expect(walk(result)).toEqual(['admit:passed', 'prepared:passed', 'design:never-ran', 'end:passed'])
    expect(result.stopped?.ending).toEqual({
      ending: 'never-ran',
      // The action's name rather than the runtime's, which is what changed when
      // the work left the body: `endingOf` names what did not run.
      at: 'draft the design',
      detail: 'session limit',
    })
    expect(result.routes).toEqual([])
    expect(outcomeOf(result.end)).toBe('failed')
  })

  /**
   * 0057 §2 at the step that now reaches it through its plugin. **And this is
   * the case the ticket said to be careful about**: a design that was asked for
   * and did not happen must not read as a pass, so the step ends and the pass
   * stops rather than `implement` being briefed with `""` as though the answer
   * had been *this needs none*.
   */
  it('stops the pass when its agent left no receipt', async () => {
    const { result, asked } = await pass({
      steps: DECLARED,
      answers: { draft: { failure: { kind: 'crash', detail: 'the runtime exited 1' } } },
    })

    expect(walk(result)).toEqual(['admit:passed', 'prepared:passed', 'design:did-not-finish', 'end:passed'])
    expect(result.stopped?.ending).toMatchObject({
      ending: 'did-not-finish',
      because: 'did-not-finish',
      at: 'draft the design',
      detail: expect.stringContaining('the runtime exited 1'),
    })
    // Not `needs-input`, so there is nothing for a judge to route — and nothing
    // was implemented off a design that was never written.
    expect(result.routes).toEqual([])
    expect(asked.dispatch).toEqual([])
    expect(outcomeOf(result.end)).toBe('blocked')
  })
})

// -------------------------------------------------------------- implement ----

describe('implement dispatches the one agent, and reports what it committed', () => {
  /**
   * Declared at `proposed` rather than at `build`, and since 2026-09-27 either
   * would resolve — `runPlugin` serves both. The point is the head either way:
   * whatever runs after `implement` is judged against what `implement`
   * committed, and which step declares it is the caller's seam and not this
   * claim.
   */
  it('moves the head to the commit, and what runs after it is judged there', async () => {
    const judged: string[] = []
    const { result } = await pass({
      steps: { proposed: [{ name: 'test', run: 'pnpm test' }] },
      actions: {
        proposed: [
          {
            name: 'test',
            kind: 'run',
            yields: 'verdict',
            run: async (ctx) => {
              judged.push(ctx.onSha)
              return PASSED
            },
          },
        ],
      },
    })

    expect(result.steps[3]?.ending).toEqual({ ending: 'passed', head: COMMITTED })
    expect(judged).toEqual([COMMITTED])
  })

  it.each([
    {
      what: 'asked',
      answer: { asked: 'the ticket names two files and neither exists' } as Worked,
      // Its own ending since `#296`, and no `because`: *it asked* was a value of
      // that field and is the discriminant now, which is what `routed: true`
      // below no longer depends on a string comparison for.
      ending: { ending: 'asked' },
      routed: true,
    },
    {
      what: 'left no receipt',
      answer: { stopped: 'the turn budget was spent' } as Worked,
      ending: { ending: 'did-not-finish', because: 'did-not-finish' },
      routed: true,
    },
    {
      what: 'never started',
      answer: { neverStarted: { agent: 'claude-code', detail: 'signed out' } } as Worked,
      ending: { ending: 'never-ran' },
      routed: false,
    },
  ])('reports an agent that $what', async ({ answer, ending, routed }) => {
    const { result } = await pass({ answers: { dispatch: answer } })

    expect(result.stopped?.step).toBe('implement')
    expect(result.stopped?.ending).toMatchObject(ending)
    expect(result.routes.length).toBe(routed ? 1 : 0)
    // `end` runs on all three, which is the whole of 0058 §3.
    expect(result.steps.at(-1)?.step).toBe('end')
  })

  /**
   * **The body dispatches nothing, and this is what says so** (`#266`).
   *
   * `runStep` runs a step's declared actions *before* the body and skips the body
   * only when they did not pass, so a body that still dispatched would be **two
   * agents on one brief** the moment a recipe declared an `agent:` at
   * `implement` — the declared one pays for the work, the pipeline passes, and
   * the body pays for a second on the same ticket, spending a round bought for a
   * fix. Nothing refuses it and nothing warns.
   *
   * So the assertion is the empty list with *no* action at the step at all: the
   * step still passes, because the body's whole answer is `passed`, and nothing
   * was dispatched, because there is nothing left in it to dispatch. A body that
   * regained the call would dispatch here and go red.
   */
  it('dispatches nothing of its own, so a declared agent is the only one paid', async () => {
    const { asked, result } = await pass({ actions: { implement: [] } })

    expect(asked.dispatch).toEqual([])
    expect(result.steps.find((visit) => visit.step === 'implement')?.ending).toEqual({
      ending: 'passed',
    })
    // And the pass carries on to the end rather than stopping for the missing
    // receipt: `implement`'s head is the action's, so a step with no action
    // leaves `onSha` where `admit` put it.
    expect(outcomeOf(result.end)).toBe('landed')
  })

  it('is handed the round it is in and the findings it was bought on', async () => {
    const { asked } = await pass()

    expect(asked.dispatch[0]?.context.round).toBe(0)
    expect(asked.dispatch[0]?.context.recheck).toEqual([])
    expect(asked.dispatch[0]?.again).toBeNull()
  })

  /**
   * The other half of a question, and the reason `SentBack` exists: the judge may
   * answer a `needs-input` with *that step again, stating your assumption*, which
   * spends a round and buys another agent run. So the second brief must differ
   * from the first, and the only thing that can make it differ is what the judge
   * said — a byte-identical brief buys the same question back and burns every
   * round arriving at the answer the first one did.
   *
   * The judge answers `implement` for this ticket's own reason, since `#462`
   * moved the routing off `proposed`'s body and into `runPass`'s loop: a
   * `judge:` for `needs-input` is what sends *that step again, stating your
   * assumption* now, not a body override.
   */
  it('is told why it is being run again, and what it asked the first time', async () => {
    let asks = true
    const { ports, asked, taking, working } = portsAnswering({
      dispatch: () => {
        const answer: Worked = asks ? { asked: 'which of the two files?' } : { committed: COMMITTED }
        asks = false
        return answer
      },
    })
    const claiming = createQueueAction({ name: 'take the ticket', ...QUEUE }, taking)
    const result = await runPass({
      recipe: recipeWith(),
      context,
      emit: () => {},
      bodies: bodiesFor(ports),
      judge: async (on) =>
        on.when === 'needs-input'
          ? { next: 'implement', named: 'test', why: 'state your assumption and carry on' }
          : { noJudge: true },
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
      // `claim`'s default, because the body takes nothing since `#269` and a pass
      // that claimed no item cannot brief an agent.
      actionsAt: (step, actions) =>
        step === 'claim'
          ? [claiming]
          : step === 'implement'
            ? [createWorkAction({ name: 'write the change', prompt: '' }, working)]
            : step === 'merge'
              ? [
                  createMergeAction(
                    { name: 'land the branch', strategy: 'merge-commit' },
                    { land: async () => ({ merged: MERGED }) },
                  ),
                ]
              : actions.map((a) => canned(a.name, PASSED)),
    })

    expect(walk(result)).toEqual([
      'admit:passed',
      'prepared:passed',
      'design:passed',
      'implement:asked',
      'proposed:routed',
      'implement:passed',
      'build:passed',
      'review:passed',
      'proposed:passed',
      'merge:passed',
      'end:passed',
    ])
    expect(asked.dispatch[1]?.again).toEqual({
      why: 'state your assumption and carry on',
      asked: 'which of the two files?',
      // The question is the whole of what this round was bought on, and `asked`
      // is where it is: `printed` would be the same words twice.
      printed: null,
    })
    expect(asked.dispatch[1]?.context.round).toBe(1)
    expect(outcomeOf(result.end)).toBe('landed')
  })
})

/**
 * **`implement` may also carry a `run:` after the agent, wrapped in the git
 * port `createKeptRunAction`** (`#390`) — real actions rather than canned
 * ones, so `headFrom`'s *last head wins* rule and the fix round's re-dispatch
 * of both actions are exercised through the pipeline and not asserted against
 * a wrapper called by hand.
 */
describe('implement may also carry a run: after the agent, since #390', () => {
  const RUN_HEAD = '4444444444444444444444444444444444444444'
  const RUN_HEAD_2 = '5555555555555555555555555555555555555555'
  const AGENT_HEAD_2 = '6666666666666666666666666666666666666666'

  const fakeInner: Action = { name: 'format', kind: 'run', yields: 'verdict', run: async () => PASSED }

  it("commits over the agent's own head when the run: finds something to commit", async () => {
    const agent = createWorkAction(
      { name: 'write the change', prompt: '' },
      { work: async () => ({ committed: COMMITTED }) },
    )
    const kept = createKeptRunAction('format', fakeInner, {
      clean: async () => ({ ok: true }),
      keep: async () => ({ committed: RUN_HEAD }),
    })
    const { result } = await pass({ actions: { implement: [agent, kept] } })

    expect(result.steps.find((v) => v.step === 'implement')?.ending).toEqual({ ending: 'passed', head: RUN_HEAD })
    expect(outcomeOf(result.end)).toBe('landed')
  })

  it("the agent's own head stands when the run: finds nothing to commit", async () => {
    const agent = createWorkAction(
      { name: 'write the change', prompt: '' },
      { work: async () => ({ committed: COMMITTED }) },
    )
    const kept = createKeptRunAction('format', fakeInner, {
      clean: async () => ({ ok: true }),
      keep: async () => ({ nothing: true }),
    })
    const { result } = await pass({ actions: { implement: [agent, kept] } })

    expect(result.steps.find((v) => v.step === 'implement')?.ending).toEqual({ ending: 'passed', head: COMMITTED })
    expect(outcomeOf(result.end)).toBe('landed')
  })

  /**
   * **The route back to `implement` carries both actions, and the second
   * `build` is judged against the second run's commit** — `#390`'s Done when
   * items 2 and 3. Modelled on "sends a red build back to `implement`" above,
   * with a `run:` written after the agent.
   */
  it('runs the agent and the run: again on a fix round, and the next build sees the second commit', async () => {
    let red = true
    let runCalls = 0
    let agentCalls = 0
    const runHeads = [RUN_HEAD, RUN_HEAD_2]
    const agentHeads = [COMMITTED, AGENT_HEAD_2]
    const buildSaw: string[] = []

    const agent = createWorkAction(
      { name: 'write the change', prompt: '' },
      { work: async () => ({ committed: agentHeads[agentCalls++] ?? AGENT_HEAD_2 }) },
    )
    const kept = createKeptRunAction('format', fakeInner, {
      clean: async () => ({ ok: true }),
      keep: async () => ({ committed: runHeads[runCalls++] ?? RUN_HEAD_2 }),
    })

    const { result } = await pass({
      actions: {
        implement: [agent, kept],
        build: [
          {
            name: 'typecheck',
            kind: 'run',
            yields: 'verdict',
            run: async (ctx) => {
              buildSaw.push(ctx.onSha)
              const answer = red ? RED : PASSED
              red = false
              return answer
            },
          },
        ],
      },
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
    })

    expect(walk(result).slice(4)).toEqual([
      'build:refused',
      'proposed:routed',
      'implement:passed',
      'build:passed',
      'review:passed',
      'proposed:passed',
      'merge:passed',
      'end:passed',
    ])
    // Both actions ran a second time — `actionsAt` is resolved fresh on the
    // fix round's visit, and every declared action at a step runs.
    expect(agentCalls).toBe(2)
    expect(runCalls).toBe(2)
    expect(result.steps.filter((v) => v.step === 'implement').map((v) => v.ending)).toEqual([
      { ending: 'passed', head: RUN_HEAD },
      { ending: 'passed', head: RUN_HEAD_2 },
    ])
    // The build that follows each round is judged against that round's `run:`
    // commit, not the agent's own and not the other round's.
    expect(buildSaw).toEqual([RUN_HEAD, RUN_HEAD_2])
    expect(outcomeOf(result.end)).toBe('landed')
  })
})

// ------------------------------------------------------------------ build ----

describe('build is its own step, and a red one skips review', () => {
  /**
   * The behaviour change with the cheapest argument behind it. `build` goes first
   * **not because it is quick** — median 313s against review's 149s — but because
   * it spends no tokens where a review spends an agent: the refusal reaches
   * `proposed` and `review` is never visited at all.
   */
  it('refuses, and `review` is never reached', async () => {
    const { result, asked } = await pass({ actions: { build: [canned('typecheck', RED)] } })

    expect(walk(result)).toEqual([
      'admit:passed',
      'prepared:passed',
      'design:passed',
      'implement:passed',
      'build:refused',
      'proposed:routed',
      'end:passed',
    ])
    expect(result.steps.some((visit) => visit.step === 'review')).toBe(false)
    // And the lane was never asked to merge a diff that does not compile.
    expect(asked.land).toEqual([])
  })

  /** Its work is its plugins', which is `prepared`'s argument at the next step along. */
  it('passes on a green build, and adds nothing of its own', async () => {
    const { result } = await pass({ actions: { build: [canned('typecheck', PASSED)] } })

    const built = result.steps.find((visit) => visit.step === 'build')
    expect(built?.ending).toEqual({ ending: 'passed' })
    expect(built?.results.map((r) => r.verdict)).toEqual(['passed'])
  })
})

// ----------------------------------------------------------------- review ----

describe('review returns findings and judges nothing', () => {
  /**
   * 0058 §3 — *a reviewer returns findings with a severity and no verdict* — and
   * the measurement behind it: **10% of `review`'s refusals in fourteen days
   * carried no findings at all**, 24 of them
   * ([012](../../../doc/experiments/012-where-the-turns-go.md) §4). The step
   * passes carrying what the reviewer said, and the judgement is made where
   * there is a round to buy with it.
   */
  it('passes carrying the findings, and the judge is asked about them', async () => {
    const { result, asked } = await pass({
      actions: { review: [canned('cold reviewer', REVIEW_REFUSED)] },
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
    })

    const reviewed = result.steps.find((visit) => visit.step === 'review')
    expect(reviewed?.ending).toEqual({ ending: 'passed' })
    // Nothing is dropped: the reviewer's own verdict is on the visit, and it is
    // what says there is a `findings` direction to judge at all.
    expect(reviewed?.results.map((r) => r.verdict)).toEqual(['failed'])
    // `offering` is `offerFor`'s own order (`implement` before `waiting`, the
    // design's own pinned order for a brief) and `evidence` is empty: a
    // `ReviewFindings` proposal carries no raw evidence string of its own,
    // only the findings (`#462`).
    expect(asked.judge).toEqual([
      {
        when: 'findings',
        offering: ['implement', 'waiting'],
        findings: [BLOCKER],
        evidence: '',
      },
    ])
  })

  /** A reviewer that refused nothing lets the change through, and `merge` runs. */
  it('lets the change through when the reviewer refused nothing', async () => {
    const minor: ActionFinding = { ...BLOCKER, severity: 'minor' }
    const { result, asked } = await pass({
      actions: {
        review: [canned('cold reviewer', { verdict: 'passed', evidence: 'read it', findings: [minor] })],
      },
    })

    expect(walk(result).slice(-4)).toEqual(['review:passed', 'proposed:passed', 'merge:passed', 'end:passed'])
    // A finding at or below the bar is the `backlog:` plugin's business and never
    // a reason to hold a change back, so no judge was asked and nothing was paid.
    expect(asked.judge).toEqual([])
    expect(asked.land).toHaveLength(1)
    expect(outcomeOf(result.end)).toBe('landed')
  })
})

// --------------------------------------------------------------- proposed ----

describe('proposed is the only step that routes, and one judge answers each when', () => {
  /** A `build` and a `review` declared together, since most of these need both. */
  const checked = (build: ActionResult, review: ActionResult) => ({
    actions: { build: [canned('typecheck', build)], review: [canned('cold reviewer', review)] },
  })

  /**
   * **`conduct.ts`'s own `ports.judge`, line for line** (`#274`, `#277`).
   *
   * The live port looks the entry up, hands a built-in back as a *name* the body
   * applies, and dispatches a runtime — so the cases below that hand this to
   * `answers.judge` are about the recipe rather than about a fake: what is
   * declared at `proposed:` is what the pass gets. A `Judged` written out by hand
   * would assert the body and say nothing about the lines that make a declared
   * judge reachable.
   *
   * `agent` stands in for `askTheAgent`, which is the one thing a unit test may
   * not have: dispatching one spawns a process. What is mirrored is everything
   * around it — the lookup, the branch, and that a runtime's answer arrives as a
   * `next` the body then holds to the offer.
   */
  const theRecipesJudge =
    (steps: Record<string, unknown>, agent: (named: string, on: Judging) => Judged = notAsked) =>
    (on: Judging): Judged => {
      const declared = judgeDeclaredAt(recipeWith(steps).steps.proposed, on.when)
      if (declared === null) return { noJudge: true }
      return 'built' in declared ? declared : agent(declared.named, on)
    }

  /** No dispatch was arranged, which is a person — as it is when one fails live. */
  const notAsked = (named: string): Judged => ({
    next: 'waiting',
    named,
    why: `the "${named}" judge was not asked`,
  })

  /** A `judge:` entry, as a recipe writes one. */
  const declaring = (when: string, name: string, judge = 'same-worktree') => ({
    proposed: [{ name, judge, when }],
  })

  /**
   * The mechanical direction, and the whole of what keeps `proposed` from buying
   * a model to answer a question a `switch` answers: `red` and `verify-failed` were
   * seen sixty times between them in fourteen days and not one was a judgement.
   * Nothing was declared, so the built-in answered — and no judge was paid.
   */
  it('sends a red build back to `implement` without paying for a judgement', async () => {
    let red = true
    const { result, asked } = await pass({
      actions: {
        build: [
          {
            name: 'typecheck',
            kind: 'run',
            yields: 'verdict',
            run: async () => {
              const answer = red ? RED : PASSED
              red = false
              return answer
            },
          },
        ],
      },
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
    })

    expect(walk(result).slice(4)).toEqual([
      'build:refused',
      'proposed:routed',
      'implement:passed',
      'build:passed',
      'review:passed',
      'proposed:passed',
      'merge:passed',
      'end:passed',
    ])
    expect(result.routes).toMatchObject([
      // It got what it wanted and no ceiling was reached, which is what `chose`
      // and `to` agreeing says (`#271`).
      {
        from: 'build',
        chose: 'implement',
        to: 'implement',
        why: expect.stringContaining('same-worktree'),
        ceiling: null,
      },
    ])
    expect(asked.judge.map((on) => on.when)).toEqual(['red'])
    // **And the agent that was sent back was shown the three errors.** A `run:`
    // action raises no findings, so `context.recheck` is empty on this edge and
    // `asked` is null — the visit before the router was `build` and not
    // `implement` — which leaves `printed` as the only thing on the brief that
    // says what to fix. Without it the round is ~31 turns and ~$3.40 spent on an
    // agent told nothing but that something failed.
    expect(asked.dispatch[1]?.again).toEqual({
      why: expect.stringContaining('same-worktree'),
      asked: null,
      printed: { step: 'build', detail: RED.evidence },
    })
    expect(asked.dispatch[1]?.context.recheck).toEqual([])
    expect(outcomeOf(result.end)).toBe('landed')
  })

  /**
   * **A red build at `build:` reaches the router and buys the round the recipe's
   * own judge asked for** (`#274`) — the thing `#267` and `#263` each spent a
   * ticket proving was broken, at $14.19 between them with nothing landed.
   *
   * Two halves, and both had to be true. The refusal has to *travel*: `build` is
   * in `ARRIVE_AT_THE_ROUTER` and `proposed` is not, so the same commands
   * declared at `proposed:` — where this repository's recipe had them until
   * `a417908` — set `stoppedAt` and broke the loop before any judge was asked.
   * And there has to be a judge to ask, which is the cell this ticket opened:
   * the route below is `judgeDeclaredAt`'s answer over a real `proposed:` list,
   * through the one line `conduct.ts` holds.
   *
   * The destination is the same one the default gives for a `red`, and that is
   * the point rather than a weakness: the first version of these entries a person
   * can *edit* changes no behaviour. What it changes is whose sentence is on the
   * card — the recipe's line, by name.
   */
  it('buys a round for a red build from the judge the recipe declared', async () => {
    const steps = declaring('red', "a red build is the agent's to fix, where it already is")
    let red = true
    const { result, asked } = await pass({
      steps,
      answers: { judge: theRecipesJudge(steps) },
      actions: {
        build: [
          {
            name: 'typecheck',
            kind: 'run',
            yields: 'verdict',
            run: async () => {
              const answer = red ? RED : PASSED
              red = false
              return answer
            },
          },
        ],
      },
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
    })

    expect(walk(result).slice(4)).toEqual([
      'build:refused',
      'proposed:routed',
      'implement:passed',
      'build:passed',
      'review:passed',
      'proposed:passed',
      'merge:passed',
      'end:passed',
    ])
    expect(asked.judge.map((on) => on.when)).toEqual(['red'])
    expect(result.routes).toMatchObject([
      {
        from: 'build',
        chose: 'implement',
        to: 'implement',
        // The recipe's line, named — not the built-in's name, which is what a
        // person would have to grep the source for to find the entry to edit.
        why: expect.stringContaining('the "a red build is the agent\'s to fix, where it already is" judge'),
        ceiling: null,
      },
    ])
    // And it says what it declares rather than calling a `red` mechanical: the
    // same rule applied because a person wrote it down, not because nothing did.
    expect(result.routes[0]?.why).toContain('the recipe declares `judge: same-worktree`')
    expect(result.routes[0]?.why).not.toContain('is mechanical')
    // The agent that bought the round was shown what failed, which is the whole
    // of what the round is for.
    expect(asked.dispatch[1]?.again?.printed).toEqual({ step: 'build', detail: RED.evidence })
    expect(outcomeOf(result.end)).toBe('landed')
  })

  /**
   * **And the direction that was costing the money**: `findings` has no built-in,
   * so an undeclared one parks at `waiting` with every round unspent — `#267` and
   * `#263`, both fixed by a person. Declared, the same arrival buys the round.
   *
   * Both halves are asserted in one case on purpose: *absent is not empty* (0064
   * §5) is the claim, and it is only a claim if the two recipes are run against
   * the same refusal. `rounds: 1` and one review that refuses, twice over.
   */
  it("buys a round for a reviewer's findings where the recipe declares one, and holds where it does not", async () => {
    const steps = declaring('findings', 'the lines, until the rounds are spent')
    const spend = {
      ...checked(PASSED, REVIEW_REFUSED),
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 } as PassOptions['ceilings'],
    }

    const declared = await pass({ ...spend, steps, answers: { judge: theRecipesJudge(steps) } })
    // `review`'s findings arrive on the way through, so the router is `proposed`
    // itself and the round goes back to `implement`.
    expect(declared.asked.judge.map((on) => on.when)).toEqual(['findings'])
    expect(declared.result.routes[0]).toMatchObject({ from: 'proposed', to: 'implement' })
    expect(declared.asked.dispatch).toHaveLength(2)
    // The findings are what the round was bought on, and what the agent is
    // briefed with — an empty `recheck` here would be a round spent on nothing.
    expect(declared.asked.dispatch[1]?.context.recheck).toEqual([BLOCKER])
    // The second refusal has no round left and nothing else on offer but a
    // person, so no judge is asked a second time either (the ticket's own
    // rule: a judge is paid, and one that cannot help is not asked) — a
    // declared judge is bounded by the ceiling, never above it (0064 §7).
    expect(declared.result.end._tag).toBe('WaitOnPerson')
    expect(declared.result.routes[1]?.why).toContain('`rounds` is spent')

    const nothing = await pass({ ...spend, steps: { proposed: [] }, answers: {} })
    expect(nothing.result.routes[0]?.to).toBe('waiting')
    // Asked (`implement` is still on offer with `rounds` unspent), answers
    // `noJudge`, and `findings` has no built-in either — `NotAsked`, and the
    // sentence is the other `notAskedWhy` has, not the ceiling one: more than
    // a person was on offer, and nothing declared for this direction is what
    // held it back (`#462`'s own fix round, finding 1).
    expect(nothing.result.routes[0]?.why).toContain('no `judge:` is declared for a "findings"')
    expect(nothing.asked.dispatch).toHaveLength(1)
  })

  /**
   * **A runtime judge is a dispatch, and what it buys is the round the ceilings
   * already paid for** (`#277`).
   *
   * `judge: claude-code` at `findings` — the direction 0061 §3 measured at 231
   * refusals and calls the one judgement worth an agent — reaches the pass as a
   * `next` rather than as a name, because `judgeDeclaredAt` answers a runtime as
   * a runtime and the port is what asks it. The agent here answers *the lines*,
   * so the round goes back to `implement`.
   *
   * **And it stops at `rounds`, not one past it.** With `implement` off the
   * offer the second time, nothing but a person is left on it — and the
   * ticket's own rule (`#462`) is that a judge is paid, so one that cannot
   * help is not asked a second time either, declared or not. `rounds: 1` and
   * two refusals is the smallest arrangement where the difference between
   * *spends a round* and *spends rounds* is visible.
   */
  it('dispatches a runtime judge the recipe declares, and spends one round of `rounds`', async () => {
    const steps = declaring('findings', 'the lines or the approach', 'claude-code')
    const seen: Judging[] = []
    const theLines = (named: string, on: Judging): Judged => {
      seen.push(on)
      return { next: 'implement', named, why: 'the seam is right and two of its lines are wrong' }
    }

    const { result, asked } = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      steps,
      answers: { judge: theRecipesJudge(steps, theLines) },
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
    })

    // Asked once, and never handed a count — the brief is the direction, the
    // words and the set (`JudgeBrief`).
    expect(seen.map((on) => on.when)).toEqual(['findings'])
    expect(Object.keys(seen[0]!).sort()).toEqual(['evidence', 'findings', 'offering', 'when'])
    // The round it asked for, bought once, on the findings it read.
    expect(result.routes[0]).toMatchObject({ from: 'proposed', chose: 'implement', to: 'implement' })
    expect(result.routes[0]?.why).toContain('two of its lines are wrong')
    expect(asked.dispatch).toHaveLength(2)
    expect(asked.dispatch[1]?.context.recheck).toEqual([BLOCKER])
    // The second refusal offers nothing but a person — `rounds` is spent and
    // `implement` is off the set — so no judge is asked, declared or not, and
    // `chose` is `waiting` rather than naming the destination a judge never
    // got to choose.
    expect(result.routes[1]).toMatchObject({ chose: 'waiting', to: 'waiting', ceiling: null })
    expect(result.routes[1]?.why).toContain('`rounds` is spent')
    expect(result.end._tag).toBe('WaitOnPerson')
  })

  /**
   * **An agent judge that answers nothing reaches a person**, and the dispatch is
   * where that is decided (`#277`).
   *
   * A run that never started, one that did not finish, and an answer that will
   * not read as a destination are one case to the pass: none of them judged
   * anything, so `askTheAgent` answers `waiting` with the runtime's own words —
   * the same rule `agent-action.ts` applies to a reviewer whose answer will not
   * parse. **What it must not do is go round again**: an agent that could not
   * answer once costs the same the second time and terminates no sooner, so the
   * pass rests and the round is unspent.
   */
  it('holds for a person where the runtime judge answered nothing, and buys no round', async () => {
    const steps = declaring('findings', 'the lines or the approach', 'claude-code')
    const silent = (named: string): Judged => ({
      next: 'waiting',
      named,
      why: `the "${named}" judge did not answer (timeout): 15m — so the pass is held for a person`,
    })

    const { result, asked } = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      steps,
      answers: { judge: theRecipesJudge(steps, silent) },
      // Three rounds to spend, and not one of them is spent on an answer nobody got.
      ceilings: { rounds: 3, restarts: 0, restartsSpent: 0 },
    })

    expect(result.routes[0]).toMatchObject({ to: 'waiting', ceiling: null })
    expect(result.routes[0]?.why).toContain('did not answer (timeout)')
    expect(asked.dispatch).toHaveLength(1)
    expect(result.end._tag).toBe('WaitOnPerson')
    expect(outcomeOf(result.end)).toBe('blocked')
  })

  /**
   * **And an agent judge is held to the offer exactly as any other is** — the
   * refusal names the recipe's own entry, so what a person does about it is one
   * line rather than a grep (0061 §8, `#271`).
   *
   * The loop this closes is the expensive one: a judge that could answer
   * `implement` past a spent `rounds` would buy ~31 turns and ~$3.40 a round for
   * ever with nothing reporting a fault. It costs one pass and stops, and the
   * card says which ceiling refused it — a number somebody can raise.
   */
  it("refuses a runtime judge's answer the offer did not contain, naming the recipe's entry", async () => {
    const steps = declaring('findings', 'the lines or the approach', 'claude-code')
    const greedy = (named: string): Judged => ({ next: 'implement', named, why: 'one more go' })

    const { result } = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      steps,
      answers: { judge: theRecipesJudge(steps, greedy) },
      // `restarts` left to spend keeps a second candidate on offer (`claim`,
      // off `restart`) so the declared judge is genuinely asked rather than
      // skipped outright — `rounds` spent is what takes `implement` off it.
      ceilings: { rounds: 0, restarts: 1, restartsSpent: 0 },
    })

    expect(result.routes[0]).toMatchObject({ chose: 'implement', to: 'waiting' })
    expect(result.routes[0]?.why).toContain('the judge chose `fix-lines`, and `rounds` is spent')
    expect(result.end._tag).toBe('WaitOnPerson')
  })

  /**
   * **The one move a judge may not make for a mechanical refusal**, and the
   * reason `claim` is not in the set it was handed: 0039 §2, kept in code and
   * never in the recipe. A red build leaves the work still there and its remedy
   * is to fix it where it stands, so releasing the item throws a branch away for
   * a typecheck error. The judge asks anyway and is refused by name.
   */
  it('refuses a judge that answers `claim` for a mechanical refusal', async () => {
    const { result, asked } = await pass({
      actions: { build: [canned('typecheck', RED)] },
      answers: { judge: { next: 'claim', named: 'claude-code', why: 'start over' } },
      // A restart to spend, and it is still on no offer: the direction is `red`.
      ceilings: { rounds: 1, restarts: 3, restartsSpent: 0 },
    })

    expect(asked.judge[0]?.offering).toEqual(['implement', 'waiting'])
    expect(result.routes[0]?.to).toBe('waiting')
    expect(result.routes[0]?.why).toContain('the judge named "claim", which was not offered')
    expect(result.end._tag).toBe('WaitOnPerson')
    // The item is held for a person, never released.
    expect(outcomeOf(result.end)).toBe('blocked')
  })

  /**
   * **The set depends on how far the pass got, not only on what is left to
   * spend** (0061 §3, and the ticket's own *watch out*). A failed install refuses
   * before any agent has run, so there is no diff and no error in one to fix —
   * and since `#472` a judge is asked anyway, because `offerFor` always offers
   * at least `restart` beside `hand-to-person`. What stays true is the stronger
   * claim: `implement` is never on the set `bornAtOrAfterImplement('prepared')`
   * builds, so a judge cannot choose it, by never being offered it.
   *
   * **And `claim` is on neither**, though the item has a restart to spend: both
   * are mechanical directions, and 0039 §2's rule is that a restart needs a
   * judgement. No number a project writes down should make a failed install buy
   * a fresh worktree, and no judge should be able to either.
   */
  it('offers a judge only the steps the pass reached', async () => {
    const spare = { rounds: 3, restarts: 1, restartsSpent: 0 }
    const early = await pass({
      steps: { prepared: [{ name: 'install', run: 'x' }] },
      actions: { prepared: [canned('install', RED)] },
      ceilings: spare,
    })
    const late = await pass({ ...checked(RED, PASSED), ceilings: spare })

    expect(early.asked.judge[0]?.offering).not.toContain('implement')
    expect(early.result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', proposal: { _tag: 'SetupRefused', from: 'prepared' } },
    })
    expect(late.asked.judge[0]?.offering).toEqual(['implement', 'waiting'])
    // And a judge is never told what it is answering for, nor what is left to
    // spend: `Judging` carries the direction, the words and the set, and no
    // ceiling and no count (`JudgeBrief`).
    expect(Object.keys(late.asked.judge[0] ?? {}).sort()).toEqual(['evidence', 'findings', 'offering', 'when'])
  })

  /**
   * The direction 0061 §3 measured at 231 refusals and calls *the one judgement
   * worth an agent*. Here it answers `claim` — *the approach, not the lines* —
   * which requeues: the item is released and a higher-priority ticket opened in
   * the meantime goes first (0040).
   */
  it("takes a declared judge's answer for the findings direction, and a `claim` requeues", async () => {
    const { result, asked } = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      answers: {
        judge: { next: 'claim', named: 'claude-code', why: 'the approach is wrong, not the lines' },
      },
      ceilings: { rounds: 1, restarts: 1, restartsSpent: 0 },
    })

    expect(asked.judge[0]?.when).toBe('findings')
    expect(result.routes).toMatchObject([
      {
        from: 'proposed',
        chose: 'claim',
        to: 'claim',
        why: 'the approach is wrong, not the lines',
        ceiling: null,
      },
    ])
    expect(result.end).toMatchObject({ _tag: 'Requeued', cause: { _tag: 'Restart' } })
    // Nothing refused, so nothing is named as having stopped it — and a requeue
    // releases the item, which is `failed` at `end`.
    expect(result.stopped).toBeNull()
    expect(outcomeOf(result.end)).toBe('failed')
    expect(asked.land).toEqual([])
  })

  /**
   * **An arrival no judge can answer still reaches a person**, which is the floor
   * `#253` set and the one thing replacing its router had to keep. 0061 §3's yaml
   * names `ask-or-assume` for `needs-input` and nothing implements it, so a
   * question reaches somebody rather than a name the schema would accept and no
   * code answers.
   */
  it('holds a direction no judge answers for a person', async () => {
    const { result, asked } = await pass({
      answers: { dispatch: { asked: 'the ticket names two files and neither exists' } },
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
    })

    expect(asked.judge.map((on) => on.when)).toEqual([NEEDS_INPUT])
    expect(result.routes[0]?.to).toBe('waiting')
    // Asked (two candidates are on offer), answered `noJudge`, and there is no
    // built-in for `needs-input` either — the `NotAsked` sentence for *that*,
    // naming what `judge:` would have to say rather than what a ceiling
    // already excluded (nothing did): `#462`'s own fix round, finding 1.
    expect(result.routes[0]?.why).toBe(
      'no `judge:` is declared for a "needs-input" and there is no built-in that answers one, so ' +
        'the pass is held for a person rather than the workflow choosing from `implement`, ' +
        '`waiting` on its own (0061 §3)',
    )
    expect(result.end._tag).toBe('WaitOnPerson')
    // The person is shown the step that asked, not the router that sent it.
    expect(result.stopped?.step).toBe('implement')
  })

  /**
   * 0061 §8 once more — *a step refuses a destination it did not offer* — and the
   * fallback is the one destination that cannot loop. An overruled judge is not
   * one to ask for a second opinion, so the answer is a person with the refusal
   * on the card rather than the next cheapest step.
   */
  it('refuses a destination it did not offer, and names the judge', async () => {
    const { result } = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      answers: { judge: { next: 'implement', named: 'claude-code', why: 'have another go' } },
      // `restarts` left to spend keeps a second candidate on offer (`claim`,
      // off `restart`) so the judge is genuinely asked rather than skipped —
      // `rounds` spent is what takes `implement` off it.
      ceilings: { rounds: 0, restarts: 1, restartsSpent: 0 },
    })

    expect(result.routes[0]?.to).toBe('waiting')
    expect(result.routes[0]?.chose).toBe('implement')
    expect(result.routes[0]?.why).toContain('the judge chose `fix-lines`, and `rounds` is spent')
    expect(result.end._tag).toBe('WaitOnPerson')
  })

  /**
   * `decideFix`'s first rule and the one that makes the loop safe to have (0038
   * §2): the bar is not *has findings*, it is *carries something the fixer could
   * not have authored*. This is the 24 refusals a year that carried nothing — and
   * no judge is asked about them, because paying a model to discover there is
   * nothing to fix is paying twice.
   */
  it('spends nothing on a refusal carrying nothing an agent could be held to', async () => {
    const anOpinion: ActionFinding = { ...BLOCKER, failureScenario: '  ' }
    const { result, asked } = await pass({
      ...checked(PASSED, { verdict: 'failed', evidence: '', findings: [anOpinion] }),
      ceilings: { rounds: 3, restarts: 3, restartsSpent: 0 },
    })

    expect(asked.judge).toEqual([])
    expect(result.routes[0]).toMatchObject({ to: 'waiting' })
    expect(result.routes[0]?.why).toContain('nothing holds an agent to it')
    expect(result.end._tag).toBe('WaitOnPerson')
  })

  /**
   * **And an answer nobody could read is not one of those 24** (`#279`).
   *
   * `#269`'s third review answered a `major` with a failure scenario and three
   * minors, stopped one closing brace short of valid JSON, and arrived here as
   * `findings: []` — the same shape a reviewer with nothing to say produces. So the
   * pass parked as *carries nothing an agent could be held to*, which is correct
   * about what it was handed and wrong about what happened, and three other parks
   * that night said something else entirely: nobody comparing them would have seen
   * that one was a dropped answer rather than a thin review.
   *
   * **`nextOf` still reads `review`'s own `AnswerUnreadable` verdict
   * directly (0120 §2's variant table), but since `#472` answers
   * `Propose{AnswerUnreadable}` rather than carrying it forward as a pending
   * flag** — `review` always ends `passed` (`endingOf`), so `routeProposal`
   * builds the routing visit itself (`#462`) without ever calling `proposed`'s
   * own declared `human:`/`watch:` action: the raw answer is non-empty, so
   * `implement` is on offer alongside `restart` and `waiting`, and a judge is
   * asked — but none is declared, so `implement` is still not bought, now
   * because nobody chose it rather than because it was never offered.
   */
  it('reports an answer it could not read as unreadable, and not as an opinion', async () => {
    const { result, asked } = await pass({
      actions: {
        build: [canned('typecheck', PASSED)],
        review: [coldReviewerSaying(AN_ANSWER_NOBODY_CAN_READ)],
      },
      ceilings: { rounds: 3, restarts: 3, restartsSpent: 0 },
    })

    expect(asked.judge).toEqual([expect.objectContaining({ when: 'answer-unreadable' })])
    expect(asked.judge[0]?.offering).toContain('implement')
    expect(result.steps.some((visit) => visit.step === 'proposed')).toBe(true)
    expect(result.routes[0]).toMatchObject({ from: 'proposed', to: 'waiting', ceiling: null })
    expect(result.routes[0]?.why).toContain('no `judge:` is declared for a "answer-unreadable"')
    expect(result.routes[0]?.why).not.toContain('nothing an agent could be held to')
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', proposal: { _tag: 'AnswerUnreadable', from: 'review' } },
    })
    expect(asked.land).toEqual([])
  })

  /**
   * **And the same is true of the lane's own agent** (`#279`), and since
   * `#472` for the same reason as `review`'s: `nextOf` still reads an
   * `AnswerUnreadable` verdict at `merge` directly (0120 §2's variant table
   * allows it at `design`, `review`, `proposed` and `merge` alike), but now
   * answers `Propose` rather than `WaitOnPerson`, so it routes exactly as
   * `review`'s does — including the one that used to misname this *not a
   * direction any `judge:` answers* on the way through — which was true
   * about the arrival and wrong about the cause (a dropped judgement is a
   * thing to re-run; a reason no judge answers is a thing to go and look
   * at).
   *
   * `agentPlugin.at` carries `merge`, so a recipe may declare a re-verify there.
   * When its answer does not parse, `createAgentAction` returns
   * `{verdict: "failed", unreadable: true}` and sets no `because`.
   *
   * The reviewer that found this had its own findings dropped by the bug it was
   * reviewing the fix for, which is why this test arrived by hand.
   */
  it("reports the lane's unreadable answer as unreadable, not as a reason nobody answers", async () => {
    const { result, asked } = await pass({
      actions: {
        build: [canned('typecheck', PASSED)],
        review: [coldReviewerSaying('{"findings":[]}')],
        merge: [coldReviewerSaying(AN_ANSWER_NOBODY_CAN_READ)],
      },
      ceilings: { rounds: 3, restarts: 3, restartsSpent: 0 },
    })

    expect(asked.judge).toEqual([expect.objectContaining({ when: 'answer-unreadable' })])
    // `proposed`'s own way-through visit still happens on the spine between
    // `review` and `merge`, and now a second, routing visit is recorded once
    // `merge`'s own `AnswerUnreadable` reaches `routeProposal`.
    expect(result.steps.filter((visit) => visit.step === 'proposed')).toHaveLength(2)
    expect(result.routes).toEqual([expect.objectContaining({ from: 'merge', to: 'waiting', ceiling: null })])
    expect(result.routes[0]?.why).toContain('no `judge:` is declared for a "answer-unreadable"')
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', proposal: { _tag: 'AnswerUnreadable', from: 'merge' } },
    })
    expect(outcomeOf(result.end)).not.toBe('landed')
  })

  /**
   * **And `#262` does not re-open**, which is the other half of the pair: the same
   * reviewer, the same route through `proposed`, an answer that *parsed* and was
   * empty — and the change lands. A fix that read *could not read it* and *read it,
   * it was empty* as one thing would hold this one for a person too.
   */
  it('lands a clean review whose answer parsed and said nothing', async () => {
    const { result, asked } = await pass({
      actions: {
        build: [canned('typecheck', PASSED)],
        review: [coldReviewerSaying('{"findings":[]}')],
      },
      ceilings: { rounds: 3, restarts: 3, restartsSpent: 0 },
    })

    expect(result.routes).toEqual([])
    expect(asked.judge).toEqual([])
    expect(asked.land).toHaveLength(1)
    expect(outcomeOf(result.end)).toBe('landed')
  })

  /**
   * **The whole of `#293`: the reviewer says which kind of refusal it is, and no
   * pass behaves differently.**
   *
   * `#223` wants `lines` to buy a fix round and `approach` to buy a restart, and
   * the number that decides whether that branch is worth having does not exist —
   * five review refusals on 2026-09-27/28 all looked like `lines` by eye, which
   * is not a standard this repository designs from. So the classification is
   * recorded and nothing reads it, and *nothing reads it* is a claim that has to
   * be asserted rather than assumed: `decideFix`, `BUILT_IN_FOR` and the judge's
   * brief are untouched, and this is what would go red if one of them started
   * reading the word.
   *
   * Four answers over one refusal — neither word, each word, and a word that is
   * neither — and the four passes compared whole: the same walk, the same routes,
   * the same rounds dispatched, the same question put to the judge, the same
   * ending. The classification is asserted separately, on the visit, because a
   * comparison of four identical passes would also pass if the field were being
   * dropped on the floor.
   *
   * Through `coldReviewerSaying` and not a canned result, for `#279`'s reason: the
   * word arrives through the real parser or the test asserts a field it set itself.
   */
  it('records what a refusal was about and routes, spends and ends identically either way', async () => {
    const steps = declaring('findings', 'the lines, until the rounds are spent')
    const said: string[] = []
    const passes: unknown[] = []

    for (const [answered, recorded] of [
      [null, undefined],
      ['lines', 'lines'],
      ['approach', 'approach'],
      // Neither word is not a word: a reviewer that has not been updated, and the
      // third state that must never read as `lines`.
      ['the approach', undefined],
    ] as const) {
      const answer = JSON.stringify(
        answered === null ? { findings: [BLOCKER] } : { about: answered, findings: [BLOCKER] },
      )
      const { result, asked } = await pass({
        steps,
        answers: { judge: theRecipesJudge(steps) },
        actions: {
          build: [canned('typecheck', PASSED)],
          review: [coldReviewerSaying(answer)],
        },
        ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
      })

      // Both reviews — the one that bought the round and the one after it — and
      // the reviewer's own word, off the visit the pass carries.
      expect(
        result.steps
          .filter((visit) => visit.step === 'review')
          .flatMap((visit) => visit.results.map((each) => each.about)),
      ).toEqual([recorded, recorded])

      said.push(String(answered))
      passes.push({
        walk: walk(result),
        routes: result.routes,
        end: result.end,
        outcome: outcomeOf(result.end),
        dispatched: asked.dispatch.length,
        judged: asked.judge.map((on) => on.when),
      })
    }

    // The pass that is compared is a real one: a round bought on the findings, a
    // second refusal with nothing left to spend, and a person at the end of it.
    // The second refusal offers nothing but a person (`rounds` is spent), so
    // the judge is asked only once (`#462`'s own rule).
    expect(passes[0]).toMatchObject({
      end: { _tag: 'WaitOnPerson' },
      dispatched: 2,
      judged: ['findings'],
    })
    expect((passes[0] as { routes: unknown[] }).routes[0]).toMatchObject({
      from: 'proposed',
      to: 'implement',
    })
    for (const [index, each] of passes.slice(1).entries()) {
      expect(each, `the pass differed when the reviewer said ${said[index + 1]}`).toEqual(passes[0])
    }
  })

  /**
   * The mechanical answer is written in this file's vocabulary because
   * `judge.ts`'s `Destination` has three values and cannot say `build`; this is
   * what makes a divergence between the two a failing test rather than a
   * surprise. It is deleted the day T5 makes them one.
   */
  it("answers a mechanical direction exactly as `judge.ts`'s built-in does", async () => {
    const named = BUILT_IN_FOR.red
    expect(named).not.toBeNull()

    for (const rounds of [0, 1]) {
      const { result } = await pass({
        actions: { build: [canned('typecheck', RED)] },
        ceilings: { rounds, restarts: 0, restartsSpent: 0 },
      })
      const theirs = BUILT_IN[named ?? 'same-worktree']({
        when: 'red',
        evidence: RED.evidence,
        findings: [],
        offer: rounds > 0 ? ['implement', 'human'] : ['human'],
      })

      expect(result.routes[0]?.to).toBe(theirs === 'human' ? 'waiting' : theirs)
    }
  })

  /**
   * **What was chosen, what happened, and which ceiling is the difference between
   * them** (`#271`; 0064 §7's pair, and the fields `PassRouted` carries).
   *
   * Both rows below end at `waiting`, and for a different reason each: the
   * first has nothing but a person on offer, so no judge is asked and `chose`
   * says so by naming the same thing `to` does; the second has a round to
   * spend, so a judge is genuinely asked, answers `claim`, and `chose` names
   * what it chose even though the restart it wanted was already spent. The
   * route is why a pass took the path it took, and until `#271` it was written
   * to a file that is deleted on the ending where the change lands.
   */
  it('records what the decision wanted, and which ceiling refused it', async () => {
    const spent = await pass({
      actions: { build: [canned('typecheck', RED)] },
      // Nothing but a person is on offer with no round to buy `implement`
      // with, so no judge is asked at all (the ticket's own rule, `#462`) —
      // `chose` is `waiting` rather than naming the built-in's own choice.
      ceilings: { rounds: 0, restarts: 0, restartsSpent: 0 },
    })

    expect(spent.result.routes).toMatchObject([
      {
        from: 'build',
        chose: 'waiting',
        to: 'waiting',
        why: expect.stringContaining('`fix-lines` — `rounds` is spent'),
        ceiling: null,
      },
    ])

    const overruled = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      answers: { judge: { next: 'claim', named: 'claude-code', why: 'the approach is wrong' } },
      // A round to spend, so `claim` is the one destination off the set — and the
      // ceiling that took it off is the item's and not this pass's.
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
    })

    // `chose` still names the destination the judge picked (`claim`, off
    // `restart`'s own mapping); `why` is the generic excluded-candidate
    // sentence rather than the judge's own words — `routedVisit` builds a
    // `CandidateUnavailable` row off the structured decision, never off
    // `reply.why`, so it reads the same whether a judge chose it or a built-in
    // would have.
    expect(overruled.result.routes).toMatchObject([
      {
        from: 'proposed',
        chose: 'claim',
        to: 'waiting',
        why: 'the judge chose `restart`, and `restarts` is spent',
        ceiling: 'restarts',
      },
    ])
  })

  /**
   * **And the words a person reads name the ceiling too** (0064 §7, `#267`).
   *
   * `ceiling` on the route is for whoever reads the log back; the sentence is
   * what is on the card, and until the offer had two sets it could say only
   * *that is not one of the steps it was offered* — true of a spent `rounds`
   * and of a step no number would have bought alike. Both rows below end at
   * `waiting`, and the next move a person has differs: the first is a line in
   * `~/.lingtai/<project>/recipe.yml`, and the second is not.
   */
  it('names the ceiling in the words, where a number is what refused the choice', async () => {
    const spent = await pass({
      actions: { build: [canned('typecheck', RED)] },
      ceilings: { rounds: 0, restarts: 0, restartsSpent: 0 },
    })

    expect(spent.result.routes[0]?.why).toContain('`fix-lines` — `rounds` is spent')

    // The item's ceiling rather than this pass's, and through the other door: a
    // declared judge answering outside the set it was handed.
    const overruled = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      answers: { judge: { next: 'claim', named: 'claude-code', why: 'the approach is wrong' } },
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
    })

    expect(overruled.result.routes[0]?.why).toContain('the judge chose `restart`, and `restarts` is spent')

    // **A destination no number would have offered used to be named here too,
    // read off `prepared`'s own refusal and a built-in that answered anyway**
    // (`#271`'s rule: naming a step the arrival could not have taken invites
    // the reader to ask for it). Since `#467` that example no longer exists:
    // `prepared`'s refusal never reaches a router, so no built-in ever gets
    // the chance to name `implement` for it — `ceilingFor('implement',
    // early)` is `null` for the same reason, proved directly in
    // `pass.test.ts`'s "keeps what the pass reached apart from what it can
    // pay for" rather than through a real pass here.
  })
})

// ------------------------------------------------------------------ merge ----

describe('merge reports a reason and a detail, and decides nothing', () => {
  it('lands, and is handed the head the steps gave their verdicts about', async () => {
    const { result, asked } = await pass()

    // Two facts and no more: the strategy the block declares, and the commit the
    // steps gave their verdicts about — no base, because the base is one value
    // that flows and `land` already has it (0061 §4), and no worktree, which
    // `#268` took off when the cut became a plugin's.
    expect(asked.land).toEqual([{ strategy: 'merge-commit', onSha: COMMITTED }])
    expect(result.steps.find((visit) => visit.step === 'merge')?.ending).toEqual({ ending: 'passed' })
    expect(outcomeOf(result.end)).toBe('landed')
  })

  /**
   * **The body is nothing beyond its plugins, and `merge: []` is what that costs
   * being explicit about** (0065 §2–3, `#270`).
   *
   * A recipe that declares nothing there is the case above: the caller substitutes
   * `defaultsAt`'s lane and the change lands. A caller that substitutes *nothing*
   * is this one, and the step passes having landed nothing — which is the
   * substitution rule doing what it says rather than a hole, and is why
   * `conduct.ts` asks `landedAt()` before it writes `TicketLanded`.
   */
  it('lands nothing where nothing at all runs at the step', async () => {
    const { result, asked } = await pass({ actions: { merge: [] } })

    expect(asked.land).toEqual([])
    expect(result.steps.find((visit) => visit.step === 'merge')?.ending).toEqual({ ending: 'passed' })
  })

  /**
   * Over the whole log the lane has refused 32 times — **26 `verify-failed`, 6
   * `conflict`** — and the common failure is that somebody else's work landed and
   * the diff stopped being true. The step reports the lane's own words and the
   * judge at `proposed` decides what they cost: a `verify-failed` is mechanical, so
   * the built-in sends it back to `implement` with the new base.
   */
  it("reports the lane's `reason` and `detail`, and the judge decides", async () => {
    let refuses = true
    const { result, asked } = await pass({
      answers: {
        land: () => {
          const answer: LandAnswer = refuses
            ? { notMerged: { reason: 'verify-failed', detail: 'pnpm test failed on the new base' } }
            : { merged: MERGED }
          refuses = false
          return answer
        },
      },
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
    })

    /**
     * **The reason survived becoming an action's, which is the whole of `#270`.**
     *
     * The pipeline knows only that *something the recipe declared refused* and
     * `endingOf` spells that `action-refused`; a `merge:` action puts the lane's
     * own word on `ActionResult.because` and `becauseFrom` carries it here, so the
     * direction is still `verify-failed` and the round is still bought. `at` is
     * the action's name now rather than `null`, which is 0058 §3c's *what refused*
     * gaining an answer it did not have.
     */
    expect(result.steps.find((visit) => visit.step === 'merge')?.ending).toEqual({
      ending: 'refused',
      because: 'verify-failed',
      at: 'land the branch',
      detail: 'pnpm test failed on the new base',
    })
    expect(asked.judge[0]).toMatchObject({
      when: 'verify-failed',
      evidence: 'pnpm test failed on the new base',
    })
    expect(result.routes).toMatchObject([{ from: 'merge', to: 'implement' }])
    expect(outcomeOf(result.end)).toBe('landed')
  })

  /**
   * **No candidate ever sends `merge` back to `build`** (`@lingtai/domain`'s
   * `offerFor`, `routing.ts:102-104`): a `MergeConflict`'s `fix-lines` is a
   * `FixRound{to: 'implement'}` by the type it is built from, never `'build'`
   * — `conflict` has no built-in either, and resolving one is still the
   * fixer's job, just without a lane back through `build` and `review`. A
   * judge that answers `build` anyway names a destination `fix-lines` never
   * maps to, so it is refused the same way any unoffered destination is: the
   * pass rests for a person rather than routing anywhere.
   */
  it('refuses a judge that answers `build` for a conflict, which no candidate ever offers', async () => {
    const { result } = await pass({
      answers: {
        land: () => ({ notMerged: { reason: 'conflict', detail: 'both changed doc/design/the-pipeline.md' } }),
        judge: { next: 'build', named: 'claude-code', why: 'the text resolves; the intent is one file' },
      },
      ceilings: { rounds: 1, restarts: 0, restartsSpent: 0 },
    })

    expect(walk(result).slice(7)).toEqual(['merge:refused', 'proposed:routed', 'end:passed'])
    expect(result.routes).toMatchObject([
      {
        from: 'merge',
        chose: 'build',
        to: 'waiting',
        why: 'the judge named "build", which was not offered',
        ceiling: null,
      },
    ])
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', because: { _tag: 'UnknownCandidate' } },
    })
    expect(outcomeOf(result.end)).not.toBe('landed')
  })

  /**
   * **The lane's other five reasons share one `_tag`** (`MergeRefused`, 0120
   * §2), and since `#472` that is one of the seven that routes: a judge is
   * asked, because the detail is non-empty and offers `fix-lines`/`restart`
   * beside `hand-to-person`. With none declared, the router's own
   * `notAskedWhy` sentence is what lands on the card — naming `merge-refused`,
   * the direction, rather than `pending-migration`, the specific reason — and
   * the pass still rests for a person exactly as it did before this ticket.
   */
  it('holds a lane reason no judge answers for a person', async () => {
    const { result, asked } = await pass({
      answers: { land: { notMerged: { reason: 'pending-migration', detail: '1 migration file' } } },
      ceilings: { rounds: 3, restarts: 3, restartsSpent: 0 },
    })

    expect(asked.judge).toEqual([expect.objectContaining({ when: 'merge-refused' })])
    expect(result.routes[0]).toMatchObject({ from: 'merge', to: 'waiting' })
    expect(result.routes[0]?.why).toContain('no `judge:` is declared for a "merge-refused"')
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', proposal: { _tag: 'MergeRefused', reason: 'pending-migration' } },
    })
    expect(result.stopped?.step).toBe('merge')
    expect(outcomeOf(result.end)).toBe('blocked')
  })
})

// ------------------------------------------------- every reason is reported ----

/**
 * 0058 §3c's third thing, read across the whole file: **which step** the loop
 * stamps, **what refused** is on the ending, and **a reason** is what this
 * asserts. A route that forgets leaves a person reading *waiting on you* with no
 * way to learn why without opening a run log.
 *
 * `never-ran` is the one ending with no `because`, and that is its own argument:
 * it is the wall about the *account* rather than about the diff, told apart by a
 * field rather than by a sentence (0031 §1). **`held` is the other**, and it is
 * the same argument: the recipe asked a person, so the question is on the ending
 * and there is nothing to report a reason *about*. A question at `admit` is one
 * of those since `#268` — it is the `worktree:` plugin's `needs-approval` — so
 * what the row below asserts for it is the question rather than a `because`.
 *
 * **And `asked` is the third, since `#296`**, for `held`'s reason and not for
 * `never-ran`'s: what a step that stopped to ask owes a reader is the question,
 * which is on `detail`, and a `because` that could only ever spell *it asked* is
 * the free-form field that ending was split out of. So `a question at
 * \`implement\`` moved down to the row that asserts the question.
 */
describe('every step that does not simply pass reports a reason', () => {
  it.each([
    { what: 'a tree that was not cut', answers: { cut: { notCut: 'no such base ref' } } as Answers },
    { what: 'an agent with no receipt', answers: { dispatch: { stopped: 'the budget went' } } as Answers },
    {
      what: 'a merge the lane refused',
      answers: { land: { notMerged: { reason: 'conflict', detail: 'both changed one file' } } } as Answers,
    },
  ])('names a reason for $what', async ({ answers }) => {
    const { result } = await pass({ answers })

    const reported = result.steps
      .map((visit) => visit.ending)
      .filter((ending) => ending.ending === 'refused' || ending.ending === 'did-not-finish')

    expect(reported.length).toBeGreaterThan(0)
    for (const ending of reported) expect(ending.because).not.toBe('')
  })

  /** And the three that report a question instead, which is the same obligation. */
  it('names the question where a step held instead of reporting', async () => {
    const { result } = await pass({ answers: { cut: { asked: 'which base?' } } })

    const held = result.steps.map((visit) => visit.ending).filter((e) => e.ending === 'held')
    expect(held).toEqual([{ ending: 'held', at: 'cut the branch', question: 'which base?' }])
    expect(outcomeOf(result.end)).toBe('blocked')
  })

  /**
   * **And `asked`, whose question is on `detail` and whose `because` does not
   * exist** (`#296`).
   *
   * The obligation is the same one and it is discharged by a different field. What
   * this pins is that splitting the ending did not lose the words: the question
   * the agent asked is on the ending a person and a judge both read, and no token
   * stands in for it.
   */
  it('names the question where a step asked, and reports no reason beside it', async () => {
    const { result } = await pass({ answers: { dispatch: { asked: 'which file?' } } })

    const asked = result.steps.map((visit) => visit.ending).filter((e) => e.ending === 'asked')
    expect(asked).toEqual([{ ending: 'asked', at: 'write the change', detail: 'which file?' }])
    // The field the split removed, and the assertion that it is gone rather than
    // empty: `"because" in ending` is what `reasonOf` reads.
    for (const ending of asked) expect('because' in ending).toBe(false)
  })
})

// -------------------------------------------------------------------- end ----

describe('end runs on every ending and cannot refuse', () => {
  /**
   * The three outcomes a pass can produce, and `end` resolving the declared list
   * against each. `closed` is the fourth and no pass produces it: it is a person
   * deciding the ticket is over, and `close.ts` resolves `end` for it.
   */
  it.each([
    { outcome: 'landed', answers: {} as Answers, actions: [{ name: 'close the ticket', close: true }] },
    {
      outcome: 'blocked',
      answers: { dispatch: { asked: 'which base?' } } as Answers,
      actions: [{ name: 'hold it', labels: ['agent:hold'] }],
    },
    {
      outcome: 'failed',
      answers: {
        dispatch: { neverStarted: { agent: 'claude-code', detail: 'quota' } },
      } as Answers,
      actions: [],
    },
  ])('resolves the cells `when: $outcome` matches', async ({ outcome, answers, actions }) => {
    const { result, asked } = await pass({
      steps: { end: [CLOSE_ON_LANDED, HOLD_ON_BLOCKED] },
      answers,
    })

    expect(outcomeOf(result.end)).toBe(outcome)
    expect(result.steps.at(-1)).toEqual({ step: 'end', ending: { ending: 'passed' }, results: [] })
    expect(endRow(asked.record[0]?.plan ?? [])).toEqual({ outcome, actions })
  })

  it('records the resolution at the version the read gave', async () => {
    const stream = [
      {
        seq: 1n,
        streamId: ITEM.ticketId,
        version: 1,
        type: 'TicketClaimed',
        schemaVer: 1,
        data: {},
        actor: 'conductor',
        causation: null,
        at: new Date(),
      } satisfies Envelope,
    ]
    const { asked } = await pass({ steps: { end: [CLOSE_ON_LANDED] }, answers: { stream } })

    expect(asked.record[0]?.at).toBe(1)
    expect(asked.record[0]?.ticketId).toBe(ITEM.ticketId)
  })

  it('appends nothing when the recipe declares nothing at the step', async () => {
    const { result, asked } = await pass()

    expect(result.steps.at(-1)?.ending).toEqual({ ending: 'passed' })
    expect(asked.read).toEqual([ITEM.ticketId])
    expect(asked.record).toEqual([])
  })

  /**
   * The point resolves once per outcome, and the item's own stream is where that
   * is checked — `resolveEndActions`, called rather than reimplemented. An item
   * that was blocked, came back and then landed resolves twice for two different
   * outcomes; this one has already landed.
   */
  it('appends nothing a second time for an outcome the stream already carries', async () => {
    const already: Envelope = {
      seq: 2n,
      streamId: ITEM.ticketId,
      version: 2,
      type: 'EndActionsResolved',
      schemaVer: 1,
      data: { outcome: 'landed', actions: [] },
      actor: 'conductor',
      causation: null,
      at: new Date(),
    }
    const { asked } = await pass({ steps: { end: [CLOSE_ON_LANDED] }, answers: { stream: [already] } })

    expect(asked.record).toEqual([])
  })

  /**
   * **The effects never decide whether the ending happened.** The nine steps
   * before `end` passed, so the outcome is `landed` and stays `landed`: `end` is
   * never what stopped a pass, so a resolution that could not be recorded is
   * reported on `end`'s own entry in `steps` and nowhere else.
   */
  it.each([
    { act: 'read', answers: { readThrows: new Error('connection reset') } as Answers },
    {
      act: 'record',
      answers: { recordThrows: new Error('version 1 is taken') } as Answers,
    },
  ])('reports a $act that threw without changing the outcome', async ({ act, answers }) => {
    const { result } = await pass({ steps: { end: [CLOSE_ON_LANDED] }, answers })

    const ending = result.steps.at(-1)?.ending
    expect(ending).toMatchObject({ ending: 'did-not-finish', because: END_UNRESOLVED, at: null })
    expect(ending && 'detail' in ending ? ending.detail : '').toContain(`\`${act}\` threw`)
    // The landing stands, and the pass reports it as one.
    expect(result.stopped).toBeNull()
    expect(outcomeOf(result.end)).toBe('landed')
  })

  /**
   * `EndActionsResolved` lives on the work item's stream, and a pass that took no
   * item has none. So the step passes, and it does so without asking the port for
   * a stream nobody can name.
   */
  it('resolves nothing when the pass is about no item', async () => {
    const { result, asked } = await pass({
      steps: { end: [CLOSE_ON_LANDED, HOLD_ON_BLOCKED] },
      answers: { take: { notClaimed: 'lost-race' } },
    })

    expect(result.steps.at(-1)).toEqual({ step: 'end', ending: { ending: 'passed' }, results: [] })
    expect(asked.read).toEqual([])
    expect(asked.record).toEqual([])
  })
})

// ------------------------------------------- a confirmed conflict (#558) ----

describe('a conflict a person confirmed continues through the steps', () => {
  const confirmed = {
    why: 'A person confirmed the intended behavior of every conflicting hunk.',
    asked: null,
    printed: { step: 'merge' as const, detail: 'src/fix.ts' },
  }
  const from = {
    step: 'implement' as const,
    waive: [],
    roundsSpent: 2,
    roundLimit: 2,
    grant: confirmed,
    findings: [],
  }

  it('walks implement, build and review before the merge lane, and hands the brief to the first visit', async () => {
    const { result, asked } = await pass({ from, ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 } })

    const steps = walk(result)
    expect(steps.slice(steps.indexOf('implement:passed'))).toEqual([
      'implement:passed',
      'build:passed',
      'review:passed',
      'proposed:passed',
      'merge:passed',
      'end:passed',
    ])
    expect(asked.dispatch[0]?.again).toEqual(confirmed)
  })

  it('ends a second conflict at a new wait, with no fix round on offer', async () => {
    const { result, asked } = await pass({
      from,
      answers: { land: () => ({ notMerged: { reason: 'conflict', detail: 'src/fix.ts again' } }) },
      ceilings: { rounds: 9, restarts: 3, restartsSpent: 0 },
    })

    expect(result.routes).toMatchObject([{ from: 'merge', to: 'waiting' }])
    expect(result.routes.some((route) => route.to === 'implement')).toBe(false)
    expect(asked.dispatch).toHaveLength(1)
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', proposal: { _tag: 'MergeConflict' } },
    })
  })
})
