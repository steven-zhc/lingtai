/**
 * The pass, read against the decision rather than against a diff.
 *
 * `pass.ts` is wired to nothing (`#253`), so this file is the whole of what says
 * it works — which is the arrangement the ticket asked for: *a reviewer reads it
 * against the ADR, which is the one reading a cold reviewer is good at.* So each
 * `describe` below is a sentence from
 * [0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md) or
 * [0061](../../../doc/decisions-archive/0061-the-recipe-is-the-pipeline.md), and each
 * `it` is the half of it a test can check.
 *
 * Nothing here leaves the system: the two seams `runPass` takes — the ten bodies
 * and how a declared list becomes runnable actions — are both replaced, so no
 * process is spawned, no agent is paid and no person is asked. That is why this
 * is in `unit/` and why the `build` point runs it (0060 §1).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Action, ActionContext, ActionEvent, ActionFinding, ActionResult } from '@lingtai/actions'
import { STEPS, type Step } from '@lingtai/domain'
import { StepMap, type StepAction } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import type { TerminalOutcome } from '../src/end-step.ts'
import {
  NEEDS_INPUT,
  NOT_BUILT_YET,
  NO_DESIGN,
  PASS,
  REFUSING_STEPS,
  outcomeOf,
  runPass,
  type PassOptions,
  type StepBodies,
  type StepBody,
  type StepEnding,
  type StepReached,
  type StepWork,
} from '../src/pass.ts'

// --------------------------------------------------------------- fixtures ----

const context: ActionContext = { runId: 'run-1', onSha: 'abc1234def', cwd: '/nowhere', env: {} }

const PASSED: ActionResult = { verdict: 'passed', evidence: 'green', findings: [] }

/** An action that needs nothing and answers what it was told to answer. */
const canned = (name: string, result: ActionResult): Action => ({
  name,
  kind: 'run',
  yields: 'verdict',
  run: async () => result,
})

/** A fixed sha standing in for a real agent's commit (`#469`). */
const COMMITTED = 'c0ffee0'

/**
 * An `implement`/kept-run action that stands in for a committing agent or a
 * `run:` beside it — `headOf` (`action.ts:333`) only sees a head on a
 * `commit`-yielding action, so a fake meant to represent a real commit must
 * carry both (`#469`). `head: null` is a kept-run that found nothing to
 * commit, same as a real one (`commitResultOf`'s `outcome.head ?? null`).
 */
const committedSomething = (name: string, head: string | null = COMMITTED): Action => ({
  name,
  kind: 'agent',
  yields: 'commit',
  run: async () => ({ ...PASSED, evidence: 'committed', ...(head === null ? {} : { head }) }),
})

/**
 * An `admit` action that stands in for the real cut — the real worktree
 * action reports where the tree was cut, which is the base it was handed
 * (`work-action.ts:13-16`), so this echoes the context's `onSha` rather than
 * inventing one (`#469`).
 */
const cutAt = (name: string): Action => ({
  name,
  kind: 'worktree',
  yields: 'worktree',
  run: async (ctx) => ({ ...PASSED, head: ctx.onSha }),
})

/**
 * A `design` action that stands in for the drafting agent — `yields: 'design'`
 * is what `headOf` keys off, and the real agent never sets a head unless the
 * destination is `file:` (`#469`).
 */
const drafted = (name: string, result: ActionResult): Action => ({
  name,
  kind: 'agent',
  yields: 'design',
  run: async () => result,
})

/** A recipe with only the ten steps on it, resolved by the real schema. */
const recipeWith = (steps: Record<string, unknown>): PassOptions['recipe'] => ({
  steps: StepMap.parse(steps),
})

/** What a body was handed, which is the contract this file fixes. */
interface Handed {
  step: Step
  actions: readonly string[]
  outcome: TerminalOutcome | null
  reached: readonly StepReached[]
  /** This visit's — the head it is judged against, the round, and the recheck. */
  context: ActionContext
}

/**
 * The ten bodies, each recording the work it was handed and then passing —
 * plus whichever of them a test wants to answer differently.
 *
 * **Every one of them, `proposed` included, simply passes by default** since
 * `#462`: routing is `runPass`'s own loop now (`routeProposal`, through
 * `proposed-route.ts`), off `nextOf`'s `Propose` rather than off this body's
 * answer, so `proposed`'s body is only ever called on the spine visit — on
 * the way through, or after a route has already landed the walk back on a
 * step. A test that wants a particular destination chosen declares a
 * `judge:` on `PassOptions` instead of overriding this body.
 *
 * `seen` is what makes *a configured step is never skipped* checkable: it is
 * appended to once per visit, in order.
 */
function watching(overrides: Partial<Record<Step, StepBody<Step>>> = {}) {
  const seen: Handed[] = []
  const bodies = Object.fromEntries(
    STEPS.map((step) => [
      step,
      async (work: StepWork<Step>): Promise<StepEnding> => {
        seen.push({
          step: work.step,
          actions: work.actions.map((a) => a.name),
          outcome: work.outcome,
          reached: work.reached,
          context: work.context,
        })
        const override = overrides[step]
        if (override) return await override(work)
        return { ending: 'passed' }
      },
    ]),
  ) as unknown as StepBodies
  return { bodies, seen }
}

/**
 * A `merge:` action that stands in for the lane itself — `kind`/`yields:
 * 'merge'`, same as `createMergeAction` would build. `nextOf` reads a
 * `merge` visit's deciding action by its `yields` alone (`#467`,
 * `pass-next.ts:84-99`), and throws *merge cleared without an Integrated
 * action* for anything declared at `merge` that answers `canned`'s generic
 * `verdict` shape instead — a check before the lane is realistically
 * `canned`, but the lane answering `PASSED` here is what a real `merge:`
 * strategy succeeding looks like.
 */
const lands = (name: string): Action => ({
  name,
  kind: 'merge',
  yields: 'merge',
  run: async () => PASSED,
})

/**
 * A declared action this file did not fake itself, built the way a real one
 * would answer — a bare `canned(..., PASSED)` would carry no head at `admit`
 * or `implement`, which `headOf` (`action.ts:333`) would misread as the tree
 * never having moved (`#469`), and a bare `canned` at `merge` would misread as
 * `nextOf`'s own impossible case where the recipe actually names the lane
 * (`#467`).
 */
function defaultFor(step: Step, action: StepAction): Action {
  if (step === 'admit') return cutAt(action.name)
  if (step === 'implement') return committedSomething(action.name)
  if (step === 'merge' && 'merge' in action) return lands(action.name)
  return canned(action.name, PASSED)
}

/**
 * What a recipe that declares nothing at `admit` or `implement` still gets in
 * real life — `conduct.ts`'s `defaultsAt` buys the cut and the commit on
 * every pass, same names as `createWorktreeAction` and `createWorkAction`
 * default to, so a `canned`/empty step here would misread as `changedNothing`
 * where a real pass never would (`#469`).
 */
function undeclaredDefault(step: Step): Action[] {
  if (step === 'admit') return [cutAt('cut the branch')]
  if (step === 'implement') return [committedSomething('write the change')]
  return []
}

/** Every action the loop handed the pipeline, by visit. */
function watchingActions(at: Record<string, readonly Action[]> = {}) {
  const ran: { step: Step; actions: readonly string[] }[] = []
  const actionsAt: PassOptions['actionsAt'] = (step, actions) => {
    const built = at[step] ?? (actions.length > 0 ? actions.map((a) => defaultFor(step, a)) : undeclaredDefault(step))
    ran.push({ step, actions: built.map((a) => a.name) })
    return built
  }
  return { actionsAt, ran }
}

/** What one action was judged against, which is the half `Handed` cannot see. */
interface Judged {
  step: Step
  onSha: string
  round: number | undefined
  recheck: readonly ActionFinding[]
}

/**
 * One action at every step, recording the context it was run with.
 *
 * `runActionPipeline` hands the context to `Action.run`, so this is the only
 * place a test can read back what the loop actually judged each visit against —
 * and `answering` is told which visit it is at, so a lap can be red and the next
 * green.
 */
function judging(answering: (step: Step, lap: number) => ActionResult = () => PASSED) {
  const judged: Judged[] = []
  const laps = new Map<Step, number>()
  const actionsAt: PassOptions['actionsAt'] = (step) => [
    {
      name: 'check',
      // `implement`'s own check is a commit-yielding one, same as a real
      // agent or kept-run there — `headOf` only reads a head off that yield
      // (`#469`), and `answering` is what puts one on the result. `merge`'s is
      // the lane's own yield since `#467`: `nextOf` throws on a `merge` whose
      // deciding action is not `yields: 'merge'` (`pass-next.ts:111-113`), so
      // a generic `verdict` check here would misreport every lap that reaches
      // `merge` as a crash rather than a landing.
      kind: step === 'implement' ? 'agent' : step === 'merge' ? 'merge' : 'run',
      yields: step === 'implement' ? 'commit' : step === 'merge' ? 'merge' : 'verdict',
      run: async (seenWith) => {
        const lap = laps.get(step) ?? 0
        laps.set(step, lap + 1)
        judged.push({
          step,
          onSha: seenWith.onSha,
          round: seenWith.round,
          recheck: seenWith.recheck ?? [],
        })
        return answering(step, lap)
      },
    },
  ]
  return { actionsAt, judged }
}

const events: () => { emit: PassOptions['emit']; seen: ActionEvent[] } = () => {
  const seen: ActionEvent[] = []
  return { emit: (event) => void seen.push(event), seen }
}

/** One refusing action, at the one refusing step that takes a `run:` today. */
const installFails = (evidence = 'pnpm install exited 1') => ({
  recipe: recipeWith({ prepared: [{ name: 'install', run: 'pnpm install' }] }),
  at: { prepared: [canned('install', { verdict: 'failed', evidence, findings: [] })] },
})

/**
 * An `implement` body that reports 0058 §3c's question rather than passing.
 *
 * `ending: "asked"` and no `because` since `#296`: the value the workflow branched
 * on is the discriminant now, so a body that spelled the token wrongly does not
 * compile where it used to route to nowhere.
 */
const asked =
  (detail: string): StepBody<Step> =>
  async () => ({
    ending: 'asked',
    at: null,
    detail,
  })

// -------------------------------------------------------------- the shape ----

describe('the ten steps are the vocabulary, and here they are data', () => {
  it('is ten, in the order the pass reaches them', () => {
    expect(PASS.map((s) => s.step)).toEqual([...STEPS])
    expect(PASS).toHaveLength(10)
  })

  /**
   * 0058 §2: the workflow fixes which steps may refuse, and a plugin may not
   * change it. The list and the rows are derived from one another here, so the
   * failure where they disagree cannot happen.
   */
  it('lets exactly prepared, build, proposed and merge refuse', () => {
    expect(PASS.filter((s) => s.refuses).map((s) => s.step)).toEqual(['prepared', 'build', 'proposed', 'merge'])
    expect([...REFUSING_STEPS]).toEqual(['prepared', 'build', 'proposed', 'merge'])
  })

  /** 0058 §3: `proposed` is the only step that routes. */
  it('lets proposed alone route', () => {
    expect(PASS.filter((s) => s.routes).map((s) => s.step)).toEqual(['proposed'])
  })

  /** `end`'s three kinds run for effect and never reach the `Action` interface. */
  it('says end alone runs effects rather than verdicts', () => {
    expect(PASS.filter((s) => s.plugins === 'effects').map((s) => s.step)).toEqual(['end'])
    expect(PASS.find((s) => s.step === 'end')?.refuses).toBe(false)
  })
})

// ------------------------------------------------------- an empty step ----

describe('the file may omit a step; the resolved recipe may not', () => {
  /** 0061 §5, and `StepMap`'s defaults are the mechanism that ADR names. */
  it('resolves a recipe that says nothing to ten empty steps', () => {
    const steps = StepMap.parse({})
    expect(Object.keys(steps).sort()).toEqual([...STEPS].sort())
    expect(Object.values(steps)).toEqual(STEPS.map(() => []))
  })

  it('carries on through every one of them, and reports all ten', async () => {
    const { bodies, seen } = watching()
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toBeNull()
    expect(result.rested).toBeNull()
    expect(result.routes).toEqual([])
    expect(result.steps.map((s) => s.step)).toEqual([...STEPS])
    expect(result.steps.every((s) => s.ending.ending === 'passed')).toBe(true)
    // Nine times out of ten the loop meets `[]`, and an empty step is a pass.
    expect(seen.map((s) => s.step)).toEqual([...STEPS])
  })
})

describe('a step that was configured is never skipped', () => {
  /**
   * `#61`'s failure, which is what the ticket's *watch out* is about: four of
   * `end`'s six cells were declarable, drawn, and silently dropped by a
   * `continue`. There is no `continue` past a step in `pass.ts`, and this is
   * what fails if one arrives.
   */
  it('hands every declared action to the step it was declared at', async () => {
    const recipe = recipeWith({
      prepared: [{ name: 'install', run: 'pnpm install' }],
      proposed: [{ name: 'build', run: 'pnpm test' }],
      // The lane, because a written `merge:` must carry one (`#270`) — and
      // it is what a real one looks like: the checks, then the thing that lands.
      merge: [
        { name: 'verify', run: 'pnpm typecheck' },
        { name: 'land it', merge: { strategy: 'merge-commit' } },
      ],
      end: [{ name: 'close it', close: true }],
    })
    const { bodies, seen } = watching()
    const { actionsAt, ran } = watchingActions()
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toBeNull()
    // The nine steps whose plugins are verdicts, each with what it declared —
    // except `admit` and `implement`: this recipe declares nothing at either,
    // so each gets the fixture's own stand-in for `defaultsAt`'s cut and
    // commit rather than an empty step (`#469`).
    expect(ran).toEqual([
      { step: 'claim', actions: [] },
      { step: 'admit', actions: ['cut the branch'] },
      { step: 'prepared', actions: ['install'] },
      { step: 'design', actions: [] },
      { step: 'implement', actions: ['write the change'] },
      { step: 'build', actions: [] },
      { step: 'review', actions: [] },
      { step: 'proposed', actions: ['build'] },
      { step: 'merge', actions: ['verify', 'land it'] },
    ])
    // And `end`'s effects reach `end`'s body, which is the only thing that can
    // carry them out — the loop does not run them as actions.
    expect(seen.at(-1)).toMatchObject({ step: 'end', actions: ['close it'] })
  })

  /**
   * And the action is *run*, not merely built. `runActionPipeline` is what runs
   * it — the loop calls it and does not reimplement it — so the proof is the
   * action's own `run` having been entered, and the three events the pipeline
   * emits for it arriving on the caller's `emit` untouched.
   */
  it('runs the declared action rather than only building it', async () => {
    const recipe = recipeWith({ prepared: [{ name: 'install', run: 'pnpm install' }] })
    const { bodies } = watching()
    let entered = 0
    const { actionsAt } = watchingActions({
      // `admit` and `implement` emptied out too: nothing is declared at
      // either, so each would otherwise get the fixture's stand-in for
      // `defaultsAt`'s default action (`#469`) — this test isolates
      // `install`'s own three.
      admit: [],
      implement: [],
      prepared: [
        {
          name: 'install',
          kind: 'run',
          yields: 'verdict',
          run: async () => {
            entered += 1
            return PASSED
          },
        },
      ],
    })
    const { emit, seen } = events()

    await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(entered).toBe(1)
    // Requested, started, passed — the pipeline's three, and nothing from the
    // seven other steps whose lists were empty.
    expect(seen).toHaveLength(3)
  })
})

// ------------------------------------------------------------- a refusal ----

describe('four steps may refuse, and the other six may not', () => {
  it('is the type rather than a comment', () => {
    // @ts-expect-error `claim` is not one of the four (0058 §2), so `refused` is
    // subtracted from what its body may hand back. If this stops being an error,
    // `EndingAt` has stopped saying the thing the type exists to say.
    const cannotRefuse: StepBody<'claim'> = async () => ({
      ending: 'refused',
      because: 'action-refused',
      at: null,
      detail: 'nope',
    })
    // And one of the four compiles with no cast at all.
    const mayRefuse: StepBody<'prepared'> = async () => ({
      ending: 'refused',
      because: 'action-refused',
      at: 'install',
      detail: 'pnpm install exited 1',
    })

    expect(cannotRefuse).toBeTypeOf('function')
    expect(mayRefuse).toBeTypeOf('function')
  })

  /** 0058 §3: and the same type says only `proposed` may route. */
  it('says only proposed may route, in the type too', () => {
    // @ts-expect-error `routed` is `proposed`'s alone, because `waiting` has
    // exactly one way in and it is the router's to choose.
    const cannotRoute: StepBody<'merge'> = async () => ({
      ending: 'routed',
      to: 'implement',
      why: 'the base moved',
    })
    const mayRoute: StepBody<'proposed'> = async () => ({
      ending: 'routed',
      to: 'implement',
      why: 'the base moved',
    })

    expect(cannotRoute).toBeTypeOf('function')
    expect(mayRoute).toBeTypeOf('function')
  })

  /**
   * The runtime half, because a body read out of `StepBodies[Step]` has been
   * widened to the union and the compiler has stopped looking. It is not
   * downgraded to a refusal anybody acts on: a refusal buys a fix round, holds
   * the item and may reach a person, and none of that may be spent on one
   * nothing meant.
   *
   * The assertion throws, and the loop reports the throw as the step's ending
   * rather than letting it out — because an exception escaping `runPass` takes
   * `end` with it, and an item whose pass vanished carries no terminal outcome
   * at all. The words are on `detail`, where a person reads them.
   */
  it("reports a body's refusal at a step that may not refuse, and still reaches end", async () => {
    const { bodies, seen } = watching({
      claim: async () => ({ ending: 'refused', because: 'action-refused', at: null, detail: 'nope' }) as never,
    })
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toMatchObject({
      step: 'claim',
      ending: {
        ending: 'did-not-finish',
        because: 'threw',
        detail: expect.stringContaining(
          'the `claim` step refused, and only prepared, build, proposed, merge may refuse',
        ),
      },
    })
    // No fix round bought — and `end` reached, with an outcome for the item.
    expect(seen.at(-1)?.step).toBe('end')
    expect(outcomeOf(result)).toBe('blocked')
  })

  /** And the same for a body that tries to route from somewhere else. */
  it("reports a body's route at a step that may not route", async () => {
    const { bodies } = watching({
      merge: async () => ({ ending: 'routed', to: 'implement', why: 'the base moved' }) as never,
    })
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toMatchObject({
      step: 'merge',
      ending: {
        ending: 'did-not-finish',
        because: 'threw',
        detail: expect.stringContaining(
          'the `merge` step routed the pass to `implement`, and no body may route any more',
        ),
      },
    })
  })

  /**
   * 0058 §2 from the plugin's side, and the case that makes the check above a
   * body's alone. `actionsAt` is the caller's seam and the pass does no kind
   * check of its own — which is why this test hands one in at `implement` though
   * no plugin declares itself there.
   *
   * A plugin saying no at a step the workflow does not let refuse is an ordinary
   * verdict and not a programming error. Reported as `did-not-finish`, which buys
   * no fix round (0057) and is not routed, because a step that may not refuse has
   * not refused.
   *
   * **`yields: 'commit'`, not `'verdict'`** (`#467`): 0120 §1's legality table
   * has no `verdict`-yielding action at `implement` at all — `nextOf` throws
   * `a verdict refusal cannot happen at implement` rather than silently
   * misreading one — so a realistic stand-in for *something declared at
   * `implement` refuses* is a failing commit-yielding one instead, same kind
   * `committedSomething` answers with when it succeeds.
   */
  it("reads a plugin's failed verdict at one of the five as did-not-finish", async () => {
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      implement: [
        {
          name: 'a check of its own',
          kind: 'agent',
          yields: 'commit',
          run: async () => ({ verdict: 'failed', evidence: 'no diff', findings: [] }),
        },
      ],
    })
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toEqual({
      step: 'implement',
      ending: {
        ending: 'did-not-finish',
        because: 'action-refused',
        at: 'a check of its own',
        detail: 'no diff',
      },
    })
    // Everything the action said is kept: the router's whole job is reading it.
    expect(result.steps.find((s) => s.step === 'implement')?.results).toHaveLength(1)
    // And no round was bought for it, which is what `did-not-finish` costs.
    expect(result.routes).toEqual([])
  })

  /**
   * **And `review` is the sixth, which does not report it at all** — 0058 §3, *a
   * reviewer returns findings with a severity and no verdict*, and `#254`'s *review
   * returns findings and judges nothing*. A cold reviewer finding a blocker returns
   * `failed` exactly as it does at `proposed` today; the **step** passes carrying
   * the findings, and the judgement is made one step later, where there is a round
   * to buy with it.
   *
   * Nothing is dropped and nothing is quiet: the action's own verdict is still on
   * `results`, and it is what a `proposed` reads to know there is a `findings`
   * direction to judge at all.
   */
  it('reads the same verdict at `review` as findings and not a verdict', async () => {
    const finding: ActionFinding = {
      file: 'packages/conductor/src/pass.ts',
      line: 1,
      claim: 'a blocker',
      failureScenario: 'it does the wrong thing',
      severity: 'blocker',
    }
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      review: [canned('cold reviewer', { verdict: 'failed', evidence: 'a blocker in pass.ts', findings: [finding] })],
    })
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    const reviewed = result.steps.find((s) => s.step === 'review')
    expect(reviewed?.ending).toEqual({ ending: 'passed' })
    expect(reviewed?.results).toEqual([
      { action: 'cold reviewer', verdict: 'failed', evidence: 'a blocker in pass.ts', findings: [finding] },
    ])
    // Nothing refused, so nothing stopped the pass. `review`'s own `StepFailed`
    // reaches `nextOf` as a `Propose{ReviewFindings}` right there (0120 §2),
    // and the router finds no judge for `findings` (no declared one, no
    // built-in) — `NotAsked`, rested at `waiting` with `stoppedAt` still null.
    // `merge` is never reached: the route is taken the moment `review`
    // reports, not after a walk through every later step.
    expect(result.stoppedAt).toBeNull()
    expect(result.rested).toBe('waiting')
    expect(result.steps.map((s) => s.step)).toEqual(STEPS.filter((s) => s !== 'merge'))
  })

  /** And at one of the four the same verdict is a refusal, with all it buys. */
  it('reads the same verdict at one of the four as a refusal', async () => {
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      build: [canned('cold reviewer', { verdict: 'failed', evidence: 'a blocker in pass.ts', findings: [] })],
    })
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt?.ending).toEqual({
      ending: 'refused',
      because: 'action-refused',
      at: 'cold reviewer',
      detail: 'a blocker in pass.ts',
    })
  })

  /** 0058 §3c: which step, what refused, and a machine-readable reason. */
  it('reports the step, what refused and a reason', async () => {
    const { recipe, at } = installFails()
    const { bodies, seen } = watching()
    const { actionsAt } = watchingActions(at)
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toEqual({
      step: 'prepared',
      ending: {
        ending: 'refused',
        because: 'action-refused',
        at: 'install',
        detail: 'pnpm install exited 1',
      },
    })
    // The step's own body never ran: its plugins ended the step. **Nor does
    // `proposed`'s** (`#467`) — `nextOf` answers `prepared`'s own refusal
    // `WaitOnPerson{SetupRefused}` directly, so the walk goes straight to
    // `end` rather than taking a second visit to a router that cannot be the
    // step's own setup breaking (0120 §2's variant table).
    expect(seen.map((s) => s.step)).toEqual(['claim', 'admit', 'end'])
  })

  /**
   * **`prepared`'s own refusal goes straight to a person, without routing**
   * (`#467`, 0120 §2's variant table) — the one of 0058 §3b's seven this
   * ticket takes off the drawing. No agent has run, so there is no diff and
   * no judge could choose *the lines* over *the approach* about one; `onOffer`
   * already said so by leaving `implement` off `prepared`'s own offer
   * (`AFTER_AN_AGENT`), and this is that same fact read off `nextOf` instead.
   */
  it('sends a refusal at prepared straight to a person, with no second visit to proposed', async () => {
    const { recipe, at } = installFails()
    const { bodies, seen } = watching()
    const { actionsAt } = watchingActions(at)
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(result.steps.map((s) => s.step)).not.toContain('proposed')
    expect(result.routes).toEqual([])
    expect(result.rested).toBeNull()
    expect(result.waitOn).toMatchObject({ _tag: 'SetupRefused', step: 'prepared' })
    expect(seen.some((s) => s.step === 'proposed')).toBe(false)
  })
})

describe('a refusal reports what the action that refused said', () => {
  /**
   * The reason a step is what stopped and an action is what refused: nothing
   * makes an action's *name* unique within a step. `actionsAt` (`recipe.ts:1093`)
   * validates the plugin and the kind, and no refinement in `recipe.ts` or
   * `resolve.ts` asks for distinct names, so a lookup by name returns whichever
   * was declared first — and *refused at `check` — tests green* is a refusal
   * reporting the passing check's evidence.
   */
  it('reads the evidence by verdict rather than by the first action of that name', async () => {
    const recipe = recipeWith({
      proposed: [
        { name: 'check', run: 'pnpm test' },
        { name: 'check', run: 'pnpm typecheck' },
      ],
    })
    // The schema takes both, which is the premise the rest of this rests on.
    expect(recipe.steps.proposed).toHaveLength(2)

    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      proposed: [
        canned('check', { verdict: 'passed', evidence: 'tests green', findings: [] }),
        canned('check', { verdict: 'failed', evidence: 'typecheck: 3 errors', findings: [] }),
      ],
    })
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(result.stoppedAt?.ending).toEqual({
      ending: 'refused',
      because: 'action-refused',
      at: 'check',
      detail: 'typecheck: 3 errors',
    })
  })

  /**
   * The same lookup and the same trap, and this one is worse: a person is being
   * asked, and the question is the whole of what they are answering.
   */
  it('asks the question the held action asked, under a duplicated name', async () => {
    // `proposed:` and not `merge:`: a hold is `proposed`'s since `#270` — 0058 §3b
    // gives `merge` three ways out and only `proposed` may send one to a person.
    const recipe = recipeWith({
      proposed: [
        { name: 'sign off', run: 'pnpm test' },
        { name: 'sign off', human: 'ship it?' },
      ],
    })
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      proposed: [
        canned('sign off', { verdict: 'passed', evidence: 'tests green', findings: [] }),
        canned('sign off', { verdict: 'needs-approval', evidence: 'ship it?', findings: [] }),
      ],
    })
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(result.stoppedAt?.ending).toEqual({ ending: 'held', at: 'sign off', question: 'ship it?' })
  })
})

// ---------------------------------------------------------- to the router ----

describe('every step that does not pass arrives at proposed', () => {
  /**
   * 0058 §3b's second drawing, and the property it exists for: **`proposed` is
   * the only step that routes, so every loop passes through the workflow check
   * and no loop is unbounded.** A pass that breaks straight to `end` on a
   * refusal cannot buy a fix round at all, and leaves a `proposed` body written
   * later as a router nothing can call.
   */
  it('takes a refusal to the router, carrying its reason', async () => {
    // `build`, not `prepared`: a red build is still one of the seven
    // `nextOf` answers `Propose` for (`#467`) — `prepared`'s own refusal is
    // the one of the seven this ticket takes off the drawing, proved in its
    // own test above rather than here.
    const recipe = recipeWith({ build: [{ name: 'tests', run: 'pnpm test' }] })
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      build: [canned('tests', { verdict: 'failed', evidence: '3 failing', findings: [] })],
    })
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    // What happened arrived intact (0058 §3c) — the step, what refused, and
    // why — read off `steps` itself, since routing no longer calls
    // `proposed`'s own body to see it (`#462`).
    const build = result.steps.find((s) => s.step === 'build')
    expect(build?.ending).toMatchObject({
      ending: 'refused',
      because: 'action-refused',
      at: 'tests',
      detail: '3 failing',
    })
    expect(build?.results).toEqual([{ action: 'tests', verdict: 'failed', evidence: '3 failing', findings: [] }])
    // `proposed` is visited for the routing, and the visit is in `steps`.
    expect(result.steps.map((s) => s.step)).toEqual([
      'claim',
      'admit',
      'prepared',
      'design',
      'implement',
      'build',
      'proposed',
      'end',
    ])
    // No round to spend (the default ceilings are `NOTHING_SPARE`), so
    // nothing but a person was ever on offer — and no ceiling stood between
    // the route taken and the one candidate the offer excluded (`RouteTaken`,
    // `#271`).
    expect(result.routes).toEqual([
      {
        from: 'build',
        chose: 'waiting',
        to: 'waiting',
        why: 'nothing but a person was on offer (`fix-lines` — `rounds` is spent)',
        ceiling: null,
      },
    ])
  })

  /** And `needs-input` arrives too, which is the half that is not a refusal. */
  it('takes a needs-input to the router without buying a round', async () => {
    const { bodies } = watching({
      implement: asked('which of the two `base` values did you mean?'),
    })
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
    })

    // 0058 §3c: *that step again with "state your assumption"*, or a person —
    // and with no judge built for `needs-input` (`BUILT_IN_FOR`), nothing but
    // the person was ever asked, though the round was there to spend.
    expect(result.routes).toEqual([
      { from: 'implement', chose: 'waiting', to: 'waiting', why: 'nothing but a person was on offer', ceiling: null },
    ])
    expect(result.stoppedAt).toMatchObject({
      step: 'implement',
      ending: { ending: 'asked' },
    })
    expect(result.rested).toBe('waiting')
  })

  /**
   * **And the other half of that sentence, at `design`** — *or that step again
   * with "state your assumption"* (0058 §3c, `#294`).
   *
   * The line above proves the arrival and the person; this proves the round, and
   * it is the half that is worth nothing without the last assertion. A judge that
   * answers `design` buys an agent, and an agent dispatched with no memory of
   * asking reads the same ticket, finds the same gap and asks the same thing: one
   * round spent and a person at the end of it anyway. So the question travels —
   * `sentBackTo` folds it off this pass's own visits and the pipeline puts it on
   * the context, where `createDraftAction` reads it into the prompt.
   *
   * The asking is an **action** rather than a body, because that is where it comes
   * from: `design`'s body is `{ ending: "passed" }` and always was, and the token
   * is its plugin's.
   */
  it('sends a design question back to `design`, and tells it what it asked', async () => {
    const question = 'the ticket asks for two incompatible things and does not say which wins'
    /** What each `design` dispatch was told about why it is running. */
    const told: (ActionContext['again'] | undefined)[] = []
    let lap = 0
    const actionsAt: PassOptions['actionsAt'] = (step, actions) =>
      step !== 'design'
        ? actions.length > 0
          ? actions.map((a) => defaultFor(step, a))
          : undeclaredDefault(step)
        : [
            {
              name: 'draft',
              kind: 'agent',
              yields: 'design',
              run: async (seenWith) => {
                told.push(seenWith.again)
                lap += 1
                return lap === 1
                  ? {
                      verdict: 'did-not-finish',
                      because: NEEDS_INPUT,
                      evidence: question,
                      findings: [],
                    }
                  : {
                      verdict: 'passed',
                      evidence: 'designed on the first reading',
                      findings: [],
                      document: 'assume the first reading',
                    }
              },
            },
          ]
    const { bodies } = watching()
    const { emit } = events()

    const result = await runPass({
      recipe: recipeWith({ design: [{ name: 'draft', agent: 'claude-code', prompt: 'shape' }] }),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
      judge: async () => ({ next: 'design', named: 'test', why: 'because a test said so' }),
    })

    // The route 0058 §3c names, and the step that asked is the step it went to:
    // nobody but `design` knows the question, so nothing else was on offer.
    expect(result.routes).toEqual([
      { from: 'design', chose: 'design', to: 'design', why: 'because a test said so', ceiling: null },
    ])
    // Null on the way through, and the question on the way back — which is the
    // assertion the round is worth something because of.
    expect(told[0]).toBeNull()
    expect(told[1]).toMatchObject({ asked: question, why: 'because a test said so', printed: null })
    // And the second draft is what `implement` works from, so the round produced
    // the document the first visit could not.
    expect(result.stoppedAt).toBeNull()
    expect(result.steps.filter((visit) => visit.step === 'design').at(-1)?.ending).toMatchObject({
      ending: 'passed',
      design: { document: 'assume the first reading' },
    })
  })

  // ------------------------------------------ what crosses design → implement ----

  /**
   * **`#297`, and the decision is *both*** — the document and the locator
   * (0066 §3, and `TheDesign` in `@lingtai/actions` is where the paragraph is).
   *
   * These four are the contract and not the plumbing: no plugin writes a
   * locator yet, so what is asserted here is what the *first* one will meet.
   * The actions are hand-built for exactly that reason — a canned
   * `ActionResult` is the only thing in the tree that can return one today.
   */
  describe("what design's ending carries to implement", () => {
    /**
     * `proposed` passes rather than routing to a person, so the walk is the
     * ordinary one and `implement` is genuinely reached. The default body in
     * `watching` sends every pass to `waiting`, which is right for the router's
     * own tests and says nothing here.
     */
    const THROUGH: StepBody<Step> = async () => ({ ending: 'passed' })

    /** A recipe with a drafting agent at `design`, and one more to keep beside it. */
    const declaring = (names: readonly string[]) =>
      recipeWith({
        design: names.map((name) => ({ name, agent: 'claude-code', prompt: 'shape' })),
      })

    /**
     * Runs a pass whose `design` returns `results` and whose `implement` records
     * the design it was handed — which is the only place this is observable,
     * because `ActionContext` is where `runStep` puts it.
     */
    async function handedToImplement(results: readonly ActionResult[]) {
      const seen: (ActionContext['design'] | undefined)[] = []
      const { bodies } = watching({ proposed: THROUGH })
      const { actionsAt } = watchingActions({
        design: results.map((result, i) => drafted(`draft ${i}`, result)),
        implement: [
          {
            name: 'write it',
            kind: 'agent',
            yields: 'commit',
            run: async (context) => {
              seen.push(context.design)
              return { ...PASSED, head: COMMITTED }
            },
          },
        ],
      })
      const { emit } = events()
      const result = await runPass({
        recipe: declaring(results.map((_, i) => `draft ${i}`)),
        context,
        emit,
        bodies,
        actionsAt,
      })
      return { result, handed: seen[0] }
    }

    /**
     * **Both travel, and this is the whole of the ticket's first question.**
     *
     * The document because 0066 §2 depends on it — a cheaper `implement` is only
     * possible if the job is smaller, and the document is what makes it smaller
     * — and the locator beside it because §3 buys one and a fact dropped one step
     * before the only step that could use it is a fact worth nothing.
     */
    it('hands implement the document and the locator', async () => {
      const { result, handed } = await handedToImplement([
        {
          verdict: 'passed',
          evidence: 'wrote a 2.4 kB design to `doc/design/x.md`',
          findings: [],
          document: '## The shape\n\nSix bodies.',
          locator: 'doc/design/x.md',
        },
      ])

      expect(handed).toEqual({ document: '## The shape\n\nSix bodies.', locator: 'doc/design/x.md' })
      expect(outcomeOf(result)).toBe('landed')
    })

    /**
     * **The three facts stay three** (`WroteTheDesign`). Absent is *nothing at
     * this step drafted*, `{ document: "" }` is *the agent answered that this
     * change needs none*, and a locator beside a document is *and here is where
     * it was kept*. The key carries the first distinction and the value the
     * second, which is the rule `ActionResult.document` already had.
     */
    it('keeps drafted-nothing, drafted-empty and drafted-and-kept apart', async () => {
      const ending = async (results: readonly ActionResult[]) =>
        (await handedToImplement(results)).result.steps.find((visit) => visit.step === 'design')?.ending

      // Nothing declared runs nothing, and the ending says so by saying nothing.
      expect(await ending([])).toEqual({ ending: 'passed' })
      expect(await ending([{ verdict: 'passed', evidence: 'none needed', findings: [], document: '' }])).toEqual({
        ending: 'passed',
        design: { document: '' },
      })
      expect(
        await ending([
          { verdict: 'passed', evidence: 'kept it', findings: [], document: 'x', locator: 'doc/design/x.md' },
        ]),
      ).toEqual({ ending: 'passed', design: { document: 'x', locator: 'doc/design/x.md' } })
    })

    /**
     * **A locator is read off the result its document came from, and off no
     * other one.** One action makes both (0066 §3), so a pass that paired the
     * last locator anybody said with the last document anybody wrote would be
     * pointing `implement` at a copy of something else — and it would be this
     * file deciding which document a location belongs to, which is `pass.ts`
     * understanding locators one step before 0066 §4 says it must not.
     */
    it('ignores a locator from an action that wrote no document', async () => {
      const { handed } = await handedToImplement([
        { verdict: 'passed', evidence: 'drafted', findings: [], document: 'the shape', locator: 'doc/design/x.md' },
        { verdict: 'passed', evidence: 'filed a copy', findings: [], locator: 'https://confluence/…/99' },
      ])

      expect(handed).toEqual({ document: 'the shape', locator: 'doc/design/x.md' })
    })

    /**
     * **The ticket's *watch out*, and the answer is that it is not a failure.**
     *
     * A `confluence:` locator and an `implement` that can only read files: the
     * plugin does not recognise the string, works from `document` — which is
     * there either way — and the pass lands. So the two halves are independent
     * by construction, there is nothing for a recipe to pair, and nothing to
     * refuse at resolve time. That is what carrying *both* buys, and the price
     * is on `TheDesign`: two copies of one document and nothing that notices
     * when they differ.
     */
    it('lands when implement cannot read the locator, because it reads the document', async () => {
      const read: string[] = []
      const { bodies } = watching({ proposed: THROUGH })
      const { actionsAt } = watchingActions({
        design: [
          drafted('draft', {
            verdict: 'passed',
            evidence: 'wrote it to the wiki',
            findings: [],
            document: '## The shape',
            locator: 'https://confluence.example/pages/99',
          }),
        ],
        implement: [
          {
            name: 'write it',
            kind: 'agent',
            yields: 'commit',
            run: async (seenWith) => {
              // A file-reading plugin: it knows repository paths and nothing else.
              const locator = seenWith.design?.locator ?? ''
              read.push(locator.startsWith('http') ? (seenWith.design?.document ?? '') : `read ${locator}`)
              return { ...PASSED, head: COMMITTED }
            },
          },
        ],
      })
      const { emit } = events()

      const result = await runPass({
        recipe: declaring(['draft']),
        context,
        emit,
        bodies,
        actionsAt,
      })

      expect(read).toEqual(['## The shape'])
      expect(result.stoppedAt).toBeNull()
      expect(outcomeOf(result)).toBe('landed')
    })

    /**
     * **And nothing behaves differently for a recipe that declares no `design:`**
     * (0065 §4), which is the property the whole of `#297` had to keep: the step
     * runs nothing, its ending carries no key, and `implement` is handed
     * `NO_DESIGN` — one brief with the agent that answered *this change needs
     * none*, because the ticket is what it works from either way (0058 §3).
     */
    it('hands implement NO_DESIGN where no design is declared', async () => {
      const seen: (ActionContext['design'] | undefined)[] = []
      const { bodies } = watching({ proposed: THROUGH })
      const { actionsAt } = watchingActions({
        implement: [
          {
            name: 'write it',
            kind: 'agent',
            yields: 'commit',
            run: async (seenWith) => {
              seen.push(seenWith.design)
              return { ...PASSED, head: COMMITTED }
            },
          },
        ],
      })
      const { emit } = events()

      const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

      expect(seen[0]).toEqual(NO_DESIGN)
      expect(seen[0]?.locator).toBeUndefined()
      expect(result.steps.find((visit) => visit.step === 'design')?.ending).toEqual({ ending: 'passed' })
      expect(outcomeOf(result)).toBe('landed')
    })
  })

  /**
   * Its plugins are not re-run on the way back. They are verdicts about a diff
   * and the step that arrived did not pass, so there is no new diff to inspect —
   * and a declared `human:` approval must not reach a person once per round.
   */
  it("runs the router without re-running proposed's own inspection", async () => {
    // `build`, not `prepared`: a red build still arrives at `proposed`
    // (`#467`), and this test is about what that arrival does *not* re-run.
    const recipe = recipeWith({
      build: [{ name: 'tests', run: 'pnpm test' }],
      proposed: [{ name: 'sign off', human: 'ship it?' }],
    })
    const { bodies } = watching()
    const { actionsAt, ran } = watchingActions({
      build: [canned('tests', { verdict: 'failed', evidence: '3 failing', findings: [] })],
      proposed: [canned('sign off', { verdict: 'needs-approval', evidence: 'ship it?', findings: [] })],
    })
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    // `build` refused before the spine ever reached `proposed`'s own
    // inspection, so the declared `human:` action was never built and nobody
    // was asked twice.
    expect(ran.map((r) => r.step)).toEqual(['claim', 'admit', 'prepared', 'design', 'implement', 'build'])
    expect(result.steps.find((s) => s.step === 'proposed')?.results).toEqual([])
    expect(result.rested).toBe('waiting')
  })

  /**
   * **A `review` whose answer could not be read still visits `proposed`'s own
   * inspection, and a declared `human:` there still runs** (`#467`) — unlike
   * `build`'s refusal above, which routes straight out of `routeProposal`
   * without ever calling `proposed`'s own plugins or body (`#462`). `review`
   * always ends `passed` (`endingOf`), so the walk reaches `proposed` the
   * ordinary way, as a spine visit, which is the one condition under which
   * `runStep` runs a step's own declared plugins at all. Skipping that visit
   * would leave the declared gate silently unbuilt and the pass reporting
   * `passed` where a person should be asked.
   */
  it("still runs proposed's own declared human: when review's own answer could not be read", async () => {
    const recipe = recipeWith({
      review: [{ name: 'cold review', agent: 'claude-code', prompt: '' }],
      proposed: [{ name: 'sign off', human: 'ship it?' }],
    })
    const { bodies } = watching()
    const { actionsAt, ran } = watchingActions({
      review: [canned('cold review', { verdict: 'failed', evidence: 'garbled', findings: [], unreadable: true })],
      // `yields: 'signoff'`, not `canned`'s `'verdict'` — a real `human:`
      // action (`createHumanAction`) is what this stands in for, and
      // `nextOf` reads a `needs-approval` verdict differently by yield
      // (`SignoffRequired` vs. `CheckRefused`, `adapters.ts:215-220`).
      proposed: [
        {
          name: 'sign off',
          kind: 'human',
          yields: 'signoff',
          run: async () => ({ verdict: 'needs-approval', evidence: 'ship it?', findings: [] }),
        },
      ],
    })
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(ran.some((r) => r.step === 'proposed')).toBe(true)
    expect(result.steps.find((s) => s.step === 'proposed')?.results).toEqual([
      { action: 'sign off', verdict: 'needs-approval', evidence: 'ship it?', findings: [] },
    ])
    expect(result.waitOn).toMatchObject({ _tag: 'SignoffRequired' })
    expect(result.rested).toBeNull()
  })

  /**
   * And the three that are not on the drawing go nowhere. `proposed` is the
   * router, so a visit that did not pass there has nothing above it to appeal
   * to; `waiting` is where it rests and `stoppedAt` names it.
   */
  it("does not route proposed's own refusal", async () => {
    const recipe = recipeWith({ proposed: [{ name: 'tamper', run: 'true' }] })
    const { bodies, seen } = watching()
    const { actionsAt } = watchingActions({
      proposed: [canned('tamper', { verdict: 'failed', evidence: 'a watched path moved', findings: [] })],
    })
    const { emit } = events()

    const result = await runPass({
      recipe,
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 3, restarts: 3, restartsSpent: 0 },
    })

    expect(result.stoppedAt).toMatchObject({ step: 'proposed', ending: { ending: 'refused' } })
    expect(result.routes).toEqual([])
    // One visit to `proposed`, not two: nothing sent its own refusal to itself.
    expect(result.steps.filter((s) => s.step === 'proposed')).toHaveLength(1)
    expect(seen.at(-1)?.step).toBe('end')
  })

  /**
   * `never-ran` and `held` do not arrive either, and the endings say why. A
   * quota is about the account rather than the diff, and the only judge worth an
   * agent is itself an agent (0061 §3) — so paying to ask *what shall we do
   * about the quota* is the one route that cannot work. A declared `human:` is
   * the recipe having already decided a person is next.
   */
  it('does not route a never-ran or a question already put to a person', async () => {
    for (const [verdict, ending] of [
      ['never-ran', 'never-ran'],
      ['needs-approval', 'held'],
    ] as const) {
      // The lane so the recipe resolves (`#270`); what runs is `watchingActions`'s,
      // and this list is only asked to be a legal one.
      const recipe = recipeWith({
        merge: [
          { name: 'check', run: 'true' },
          { name: 'land it', merge: { strategy: 'merge-commit' } },
        ],
      })
      const { bodies } = watching()
      const { actionsAt } = watchingActions({
        merge: [canned('check', { verdict, evidence: '…', findings: [] })],
      })
      const { emit } = events()

      const result = await runPass({
        recipe,
        context,
        emit,
        bodies,
        actionsAt,
        ceilings: { rounds: 3, restarts: 3, restartsSpent: 0 },
      })

      expect(result.stoppedAt).toMatchObject({ step: 'merge', ending: { ending } })
      expect(result.routes).toEqual([])
    }
  })

  /** A crash is not a question, so 0057 §2's *the pass stops* is the rule. */
  it('does not route a step that threw', async () => {
    const { bodies } = watching({
      implement: async () => {
        throw new Error('the agent runtime raised: ECONNRESET')
      },
    })
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 3, restarts: 3, restartsSpent: 0 },
    })

    expect(result.stoppedAt).toMatchObject({
      step: 'implement',
      ending: { ending: 'did-not-finish', because: 'threw' },
    })
    expect(result.routes).toEqual([])
  })
})

describe('proposed routes on the way through as well as on the way back', () => {
  /**
   * **`review` refuses with its findings, and the step still ends `passed`**
   * (0120 §2, 0058 §3) — the findings ride on `review`'s `results`, and what
   * routes on them is `nextOf`'s own `Propose{ReviewFindings}`, read by
   * `proposed` on the way through rather than by a second visit to `review`.
   * The judge is the one place a `findings` direction is worth an agent
   * (0061 §3), so it is declared here rather than left to a built-in — there
   * is none for `findings` (`BUILT_IN_FOR`).
   */
  it('sends a change back to implement on the findings of a review that refused', async () => {
    const finding: ActionFinding = {
      file: 'packages/conductor/src/pass.ts',
      line: 1,
      claim: 'a blocker',
      failureScenario: 'it does the wrong thing',
      severity: 'major',
    }
    const { bodies } = watching()
    let reviews = 0
    const actionsAt: PassOptions['actionsAt'] = (step) =>
      step === 'review'
        ? [
            canned('cold reviewer', {
              verdict: reviews === 0 ? 'failed' : 'passed',
              evidence: 'read the diff',
              findings: reviews++ === 0 ? [finding] : [],
            }),
          ]
        : step === 'implement'
          ? [committedSomething('write the change')]
          : []
    const { emit } = events()

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
      judge: async () => ({ next: 'implement', named: 'test', why: 'the lines, not the approach' }),
    })

    // The step ends `passed` both times — a review that refuses still does
    // (0058 §3) — and the pass still bought a round on the first one's
    // findings and then landed.
    expect(result.steps.filter((s) => s.step === 'review').map((s) => s.ending.ending)).toEqual(['passed', 'passed'])
    expect(result.routes).toEqual([
      {
        from: 'proposed',
        chose: 'implement',
        to: 'implement',
        why: 'the lines, not the approach',
        ceiling: null,
      },
    ])
    expect(result.stoppedAt).toBeNull()
    expect(result.rested).toBeNull()
    expect(outcomeOf(result)).toBe('landed')
    expect(result.steps.map((s) => s.step)).toEqual([
      'claim',
      'admit',
      'prepared',
      'design',
      'implement',
      'build',
      'review',
      'proposed',
      // the round it bought on the findings
      'implement',
      'build',
      'review',
      'proposed',
      'merge',
      'end',
    ])
  })

  /** The default body lets it past, which is today's behaviour with no judge. */
  it('lets a change past on the way through when no judge is built', async () => {
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, actionsAt })

    expect(result.routes).toEqual([])
    expect(result.steps.map((s) => s.step)).toEqual([...STEPS])
  })
})

describe('a route back into the spine resumes there, and the loop is bounded', () => {
  /** 0058 §3b: back to `implement`, in the same worktree, and on through. */
  it('walks the spine again from where the judge sent it', async () => {
    let refusals = 0
    // Injected through `actionsAt` rather than declared in the recipe, because
    // what this exercises is the caller's seam: `runPass` is handed a list and
    // must run it, whoever built it. A recipe *may* declare a `run:` at `build`
    // since `a417908`, and the contract here is the same either way.
    const recipe = recipeWith({})
    const { bodies } = watching()
    const actionsAt: PassOptions['actionsAt'] = (step) =>
      step === 'build'
        ? [
            canned(
              'tests',
              // Red the first time, green the second: one round buys the fix.
              refusals++ === 0 ? { verdict: 'failed', evidence: '3 failing', findings: [] } : PASSED,
            ),
          ]
        : step === 'implement'
          ? [committedSomething('write the change')]
          : []
    const { emit } = events()

    const result = await runPass({
      recipe,
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
    })

    expect(result.stoppedAt).toBeNull()
    expect(result.rested).toBeNull()
    // No judge declared, so the mechanical built-in answers `red` (`BUILT_IN_FOR`).
    expect(result.routes).toEqual([
      {
        from: 'build',
        chose: 'implement',
        to: 'implement',
        why: 'the "same-worktree" judge: a "red" is mechanical — the work is still there and the remedy is to fix it where it stands',
        ceiling: null,
      },
    ])
    expect(result.steps.map((s) => s.step)).toEqual([
      'claim',
      'admit',
      'prepared',
      'design',
      'implement',
      'build',
      // the refusal's route
      'proposed',
      // the round
      'implement',
      'build',
      'review',
      'proposed',
      'merge',
      'end',
    ])
  })

  /**
   * **The bound is structural rather than a guard.** A judge that always says
   * `implement` spends every round and is then offered nothing but a person, so
   * the walk is at most `rounds + 1` laps long — which is the whole reason 0061
   * §3 puts the counting in the workflow and the choosing in the plugin: *a
   * misconfiguration that fails is cheap; one that loops never errors, it only
   * spends.*
   */
  it('stops buying rounds once the ceiling is spent', async () => {
    // Injected through `actionsAt` rather than declared in the recipe, because
    // what this exercises is the caller's seam: `runPass` is handed a list and
    // must run it, whoever built it. A recipe *may* declare a `run:` at `build`
    // since `a417908`, and the contract here is the same either way.
    const recipe = recipeWith({})
    // No judge declared — the mechanical built-in for `red` always wants
    // `implement`, and would loop for ever if the ceiling did not stop it.
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      build: [canned('tests', { verdict: 'failed', evidence: '3 failing', findings: [] })],
    })
    const { emit } = events()

    const result = await runPass({
      recipe,
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
    })

    expect(result.routes.map((r) => r.to)).toEqual(['implement', 'implement', 'waiting'])
    expect(result.steps.filter((s) => s.step === 'build')).toHaveLength(3)
    expect(result.rested).toBe('waiting')
    // The refusal a person is handed is the build's, not the router's.
    expect(result.stoppedAt).toMatchObject({ step: 'build', ending: { ending: 'refused' } })
    expect(outcomeOf(result)).toBe('blocked')
  })

  /**
   * **Empty `BuildRed` is `NoCriterion`, the same as an opinion-only
   * `ReviewEmpty`** (0120 §3's appendix) — `offerFor`'s `round` for a
   * `BuildRed` reads `proposal.output.trim() !== ''`, so a refusal that
   * printed nothing buys no round and asks no judge, declared or not. Proved
   * here rather than through `once()`: only `run:` serves `build` and it
   * spawns a process (#461's design, row 3), which is the filesystem and so
   * is integration (0060 §1).
   */
  it('asks no judge for an empty `BuildRed`, which has no criterion to pay for', async () => {
    const recipe = recipeWith({})
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      build: [canned('tests', { verdict: 'failed', evidence: '', findings: [] })],
    })
    const { emit } = events()
    let dispatched = 0

    const result = await runPass({
      recipe,
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
      judge: async () => {
        dispatched += 1
        return { noJudge: true }
      },
    })

    expect(dispatched).toBe(0)
    expect(result.routes[0]).toMatchObject({ chose: 'waiting', to: 'waiting', ceiling: null })
    expect(result.rested).toBe('waiting')
  })

  /**
   * **A restart is a requeue and it ends the pass** (0058 §3b): the item is
   * released, and the queue's next pass orders by kind and then by number as it
   * always does — so the next ticket taken may not be this one. Which is why the
   * loop does not walk back to `claim` itself.
   */
  it('ends the pass when the judge chooses a restart', async () => {
    // Born at `review`, because that is the one direction a restart is ever
    // offered for: *the approach is wrong*, which only `findings` can say
    // (0039 §2) — `offerFor` offers `restart` for `ReviewFindings` alone.
    const finding: ActionFinding = {
      file: 'packages/conductor/src/pass.ts',
      line: 1,
      claim: 'a blocker',
      failureScenario: 'it does the wrong thing',
      severity: 'major',
    }
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      review: [canned('cold reviewer', { verdict: 'failed', evidence: 'a blocker', findings: [finding] })],
    })
    const { emit } = events()

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 1, restartsSpent: 0 },
      judge: async () => ({ next: 'claim', named: 'test', why: 'because a test said so' }),
    })

    expect(result.rested).toBe('requeued')
    expect(result.routes).toEqual([
      { from: 'proposed', chose: 'claim', to: 'claim', why: 'because a test said so', ceiling: null },
    ])
    expect(result.steps.filter((s) => s.step === 'claim')).toHaveLength(1)
    // Released rather than held: `failed` is *put the item back in the queue*.
    expect(outcomeOf(result)).toBe('failed')
    expect(result.steps.at(-1)?.step).toBe('end')
  })

  // A restart being on no offer when the item has none left is `offerFor`'s
  // own claim, proved directly against it in `domain/unit/routing.test.ts` —
  // there is no longer a `runPass` scenario this duplicates rather than
  // restates.
})

// ------------------------------------------- the head, the round, the findings ----

describe('a visit is judged against the head the walk has reached', () => {
  /**
   * **`onSha` is *the commit this verdict is about, and the only thing that
   * makes it stale*** (`ActionContext`), and `stepsOn()`
   * (`packages/domain/src/run.ts`) shows a step only where its `onSha` is the
   * item's head. So a pass that judged the base while the agent's commit was the
   * head would pay for `build`, `review` and `proposed` and show none of them —
   * a card with no build and no review, beside a `PassResult` saying all ten
   * steps passed.
   *
   * The loop runs no git and the caller cannot know the value either, because
   * the commit is made in the middle of the walk. So the step that moved the
   * tree says so on its ending, and every visit after it is judged against it.
   */
  it('judges the steps after a commit against the commit, and the ones before against the base', async () => {
    const { bodies, seen } = watching()
    // T4b's `implement`: the agent ran, and this is the head it committed.
    const { actionsAt, judged } = judging((step) => (step === 'implement' ? { ...PASSED, head: 'b2b2b2b' } : PASSED))
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toBeNull()
    expect(judged.map((j) => [j.step, j.onSha])).toEqual([
      // Before the agent, including `implement`'s own plugins: the base is what
      // they are about, because nothing has been written yet.
      ['claim', 'abc1234def'],
      ['admit', 'abc1234def'],
      ['prepared', 'abc1234def'],
      ['design', 'abc1234def'],
      ['implement', 'abc1234def'],
      // And after it, the head the agent left — which is what the board reads.
      ['build', 'b2b2b2b'],
      ['review', 'b2b2b2b'],
      ['proposed', 'b2b2b2b'],
      ['merge', 'b2b2b2b'],
    ])
    // The bodies are handed the same context their plugins were run with.
    expect(seen.find((s) => s.step === 'build')?.context.onSha).toBe('b2b2b2b')
    expect(seen.find((s) => s.step === 'design')?.context.onSha).toBe('abc1234def')
  })

  /** A step that moved nothing says nothing, which is eight of the ten. */
  it('leaves the head alone when no step says it moved the tree', async () => {
    const { bodies } = watching()
    const { actionsAt, judged } = judging()
    const { emit } = events()

    await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(judged.every((j) => j.onSha === 'abc1234def')).toBe(true)
  })

  /**
   * And a fix round is the case the whole thing is for: the second agent commits
   * too, so the second `build` and the second `review` are about that commit and
   * not about the one the first round was refused for.
   */
  it('advances the head again on a fix round', async () => {
    const heads = ['b2b2b2b', 'c3c3c3c']
    let commits = 0
    const { bodies } = watching()
    const { actionsAt, judged } = judging((step, lap) => {
      if (step === 'build' && lap === 0) return { verdict: 'failed', evidence: '3 failing', findings: [] }
      if (step === 'implement') return { ...PASSED, head: heads[commits++] ?? '' }
      return PASSED
    })
    const { emit } = events()

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
    })

    expect(result.stoppedAt).toBeNull()
    expect(judged.filter((j) => j.step === 'build').map((j) => j.onSha)).toEqual(['b2b2b2b', 'c3c3c3c'])
    expect(judged.filter((j) => j.step === 'review').map((j) => j.onSha)).toEqual(['c3c3c3c'])
  })

  /**
   * **`headFrom`'s own rule, since `#390`** (`pass.ts:1840`): *the last action
   * result that has a head wins*, which is what lets `implement: [agent, run]`
   * carry two head-producing kinds without a uniqueness rule anywhere else.
   * Nothing before this exercised the function with more than one head-bearing
   * result at a step.
   */
  it("takes the last head among a step's own actions, not the first", async () => {
    const { bodies, seen } = watching()
    const { actionsAt } = watchingActions({
      implement: [committedSomething('write the change', 'b2b2b2b'), committedSomething('format', 'c3c3c3c')],
    })
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toBeNull()
    expect(result.steps.find((s) => s.step === 'implement')?.ending).toEqual({ ending: 'passed', head: 'c3c3c3c' })
    expect(seen.find((s) => s.step === 'build')?.context.onSha).toBe('c3c3c3c')
  })

  /** And the mirror: a `run:` written *before* the agent answers nothing, so the agent's head stands. */
  it('keeps the only head when a later action in the step answers none', async () => {
    const { bodies, seen } = watching()
    const { actionsAt } = watchingActions({
      implement: [committedSomething('write the change', 'b2b2b2b'), committedSomething('format', null)],
    })
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toBeNull()
    expect(result.steps.find((s) => s.step === 'implement')?.ending).toEqual({ ending: 'passed', head: 'b2b2b2b' })
    expect(seen.find((s) => s.step === 'build')?.context.onSha).toBe('b2b2b2b')
  })

  /**
   * `pass.ts:1622-1627`'s own rule: *a body that reports a head of its own
   * wins*. Nothing else here conflicts the two, since `#469` made every
   * `implement` action carry its own head — this is the one test where the
   * action and the body disagree, so the spread order at `pass.ts:1717`
   * stays load-bearing rather than coincidentally unreachable.
   */
  it("lets a body's own head win over what its own actions left", async () => {
    const { bodies } = watching({ implement: async () => ({ ending: 'passed', head: 'bodyreported' }) })
    const { actionsAt } = watchingActions({ implement: [committedSomething('write the change', 'actionreported')] })
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toBeNull()
    expect(result.steps.find((s) => s.step === 'implement')?.ending).toEqual({
      ending: 'passed',
      head: 'bodyreported',
    })
  })
})

describe('a visit is judged in the round the pass is in', () => {
  /**
   * `round` is *which fix round this pipeline is judging — 0 before any fix was
   * bought* (`ActionContext`), and it is the workflow's own count rather than
   * anything a plugin or a caller supplies: the pass is the thing that buys the
   * rounds. A frozen 0 files the second round's actions under the first, so a
   * slow re-review reads as the one that already finished.
   */
  it('counts the rounds it bought, and every lap is judged in its own', async () => {
    const { bodies } = watching()
    const { actionsAt, judged } = judging((step, lap) => {
      if (step === 'build' && lap === 0) return { verdict: 'failed', evidence: '3 failing', findings: [] }
      // Realistic rather than headless — a real `implement` always commits,
      // and this test is about rounds and not about the head (`#469`).
      if (step === 'implement') return { ...PASSED, head: COMMITTED }
      return PASSED
    })
    const { emit } = events()

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
    })

    expect(result.routes).toEqual([
      {
        from: 'build',
        chose: 'implement',
        to: 'implement',
        why: 'the "same-worktree" judge: a "red" is mechanical — the work is still there and the remedy is to fix it where it stands',
        ceiling: null,
      },
    ])
    expect(judged.map((j) => [j.step, j.round])).toEqual([
      ['claim', 0],
      ['admit', 0],
      ['prepared', 0],
      ['design', 0],
      ['implement', 0],
      ['build', 0],
      // the round the refusal bought
      ['implement', 1],
      ['build', 1],
      ['review', 1],
      ['proposed', 1],
      ['merge', 1],
    ])
  })
})

describe('the round a pass buys is bought on something', () => {
  const finding: ActionFinding = {
    file: 'packages/conductor/src/pass.ts',
    line: 1,
    claim: 'the reviewer is never told what it refused last time',
    failureScenario: 'the fix round re-reviews from scratch and the criterion is lost',
    severity: 'major',
  }

  /**
   * 0038 §2, and the acceptance contract this pass exists to keep: **the
   * findings a previous version of this diff was refused for, and that an agent
   * has since been asked to make stop happening.** Each `failureScenario` was
   * written before anybody knew what the fix would be, which is what makes it a
   * criterion the fixer could not author — and a reviewer that is never handed
   * them silently stops applying it.
   *
   * The lap's findings rather than a refusal's, because a route is chosen on
   * both of `proposed`'s visits: here the review **refused** carrying a
   * finding (the step itself still ends `passed`, 0058 §3), and the judge
   * `nextOf`'s own `Propose{ReviewFindings}` reaches bought the round on it,
   * which is the case 0061 §3 calls the one judgement worth an agent.
   */
  it("hands the next round's plugins the findings this one was bought on", async () => {
    const { bodies } = watching()
    const { actionsAt, judged } = judging((step, lap) => {
      if (step === 'review' && lap === 0) return { verdict: 'failed', evidence: 'read the diff', findings: [finding] }
      // Realistic rather than headless — a real `implement` always commits,
      // and this test is about findings and not about the head (`#469`).
      if (step === 'implement') return { ...PASSED, head: COMMITTED }
      return PASSED
    })
    const { emit } = events()

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
      judge: async () => ({ next: 'implement', named: 'test', why: 'the lines, not the approach' }),
    })

    expect(result.stoppedAt).toBeNull()
    // The first review was asked about nothing; the second is asked about the
    // scenario the first wrote, by name.
    expect(judged.filter((j) => j.step === 'review').map((j) => j.recheck)).toEqual([[], [finding]])
    // Nothing in the first lap was, because nothing had been refused yet.
    expect(judged.filter((j) => j.round === 0).every((j) => j.recheck.length === 0)).toBe(true)
    // And the agent being asked to fix it is judged with it too.
    expect(judged.find((j) => j.step === 'implement' && j.round === 1)?.recheck).toEqual([finding])
  })

  /**
   * And a refusal's findings are the same story from the other side — a `build`
   * that refused carrying what it found, and the round it bought asked about it.
   */
  it("carries a refusing action's findings into the round it bought", async () => {
    const { bodies } = watching()
    const { actionsAt, judged } = judging((step, lap) => {
      if (step === 'build' && lap === 0) return { verdict: 'failed', evidence: '3 failing', findings: [finding] }
      // Realistic rather than headless — a real `implement` always commits,
      // and this test is about findings and not about the head (`#469`).
      if (step === 'implement') return { ...PASSED, head: COMMITTED }
      return PASSED
    })
    const { emit } = events()

    await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
    })

    expect(judged.filter((j) => j.step === 'build').map((j) => j.recheck)).toEqual([[], [finding]])
  })
})

describe('a body can read what the steps before it said', () => {
  /**
   * 0058 §3c gives `proposed` the one job of routing, and what it routes on is
   * `build`'s verdict and `review`'s findings — neither of which is a
   * `StepEnding`, since a review that found a blocker and one that found
   * nothing both end `passed`. `emit` is write-only, so `reached` is the only
   * way the router sees them without reading the log back.
   *
   * The producer here is `prepared`, and it stays `prepared` now that `build`
   * and `review` are open too (`a417908`): what is being checked is the
   * contract, and it did not change when those two `at`
   * keys open.
   */
  it('hands a later step the verdicts and findings of the earlier ones', async () => {
    const finding: ActionFinding = {
      file: 'packages/conductor/src/pass.ts',
      line: 257,
      claim: 'the router has nothing to route on',
      failureScenario: '`proposed` is asked to decide and is handed no verdict',
      severity: 'major',
    }
    const recipe = recipeWith({ prepared: [{ name: 'install', run: 'pnpm install' }] })
    let atProposed: readonly StepReached[] = []
    const { bodies } = watching({
      proposed: async (work) => {
        atProposed = work.reached
        return { ending: 'passed' }
      },
    })
    const { actionsAt } = watchingActions({
      // A finding on a pass, because a minor does not stop the run (#135) — and
      // it is exactly the case a router must be able to see.
      prepared: [canned('install', { verdict: 'passed', evidence: '1200 packages', findings: [finding] })],
    })
    const { emit } = events()

    await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(atProposed.map((s) => s.step)).toEqual([
      'claim',
      'admit',
      'prepared',
      'design',
      'implement',
      'build',
      'review',
    ])
    expect(atProposed.find((s) => s.step === 'prepared')?.results).toEqual([
      { action: 'install', verdict: 'passed', evidence: '1200 packages', findings: [finding] },
    ])
    // And a step whose list was empty said nothing, rather than being absent.
    expect(atProposed.find((s) => s.step === 'design')?.results).toEqual([])
  })

  /** The refusing case, which is the one the router most needs to see. */
  it("carries the refusing step's verdicts through to end", async () => {
    const { recipe, at } = installFails('exited 1')
    const { bodies, seen } = watching()
    const { actionsAt } = watchingActions(at)
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(result.steps.find((s) => s.step === 'prepared')?.results).toEqual([
      { action: 'install', verdict: 'failed', evidence: 'exited 1', findings: [] },
    ])
    // `end` sees the step that stopped the pass, not the two before it only —
    // and no `proposed` in between it and `end` (`#467`): `prepared`'s own
    // refusal answers `WaitOnPerson{SetupRefused}` directly.
    expect(seen.at(-1)?.reached.map((s) => s.step)).toEqual(['claim', 'admit', 'prepared'])
  })
})

describe('a step that did not finish is not a step that refused', () => {
  /**
   * 0057: a refusal buys a fix round, holds the item and reaches a person, and
   * this buys none of it — so the two may not arrive in one field for a caller
   * to tell apart by reading a sentence (0031 §1).
   */
  it('keeps did-not-finish apart from a refusal', async () => {
    const recipe = recipeWith({ proposed: [{ name: 'review', run: 'true' }] })
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      proposed: [canned('review', { verdict: 'did-not-finish', evidence: 'the turn budget ran out', findings: [] })],
    })
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(result.stoppedAt?.ending).toEqual({
      ending: 'did-not-finish',
      // Deliberately not `needs-input`: nobody was asked anything, so there is
      // nothing for the router to route.
      because: 'did-not-finish',
      at: 'review',
      detail: 'the turn budget ran out',
    })
  })

  /** And `never-ran` apart from both: that one stands the conductor down. */
  it('keeps never-ran apart from did-not-finish', async () => {
    const recipe = recipeWith({ proposed: [{ name: 'review', run: 'true' }] })
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      proposed: [
        canned('review', { verdict: 'never-ran', evidence: 'usage limit reached · resets 9pm', findings: [] }),
      ],
    })
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(result.stoppedAt?.ending).toEqual({
      ending: 'never-ran',
      at: 'review',
      detail: 'usage limit reached · resets 9pm',
    })
  })

  /** A person being asked is a third thing again, and it is not a failure. */
  it('keeps a question for a person apart from a refusal', async () => {
    const recipe = recipeWith({ proposed: [{ name: 'sign off', human: 'ship it?' }] })
    const { bodies } = watching()
    const { actionsAt } = watchingActions({
      proposed: [canned('sign off', { verdict: 'needs-approval', evidence: 'ship it?', findings: [] })],
    })
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(result.stoppedAt?.ending).toEqual({ ending: 'held', at: 'sign off', question: 'ship it?' })
  })
})

// ----------------------------------------------------------------- `end` ----

describe('end runs on every ending and cannot refuse', () => {
  it('runs after a step that refused', async () => {
    const { recipe, at } = installFails('exited 1')
    const { bodies, seen } = watching()
    const { actionsAt } = watchingActions(at)
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, bodies, actionsAt })

    expect(seen.at(-1)?.step).toBe('end')
    expect(result.steps.at(-1)?.step).toBe('end')
  })

  it('runs after a step that did not finish, and after one held for a person', async () => {
    for (const verdict of ['did-not-finish', 'needs-approval'] as const) {
      const recipe = recipeWith({ proposed: [{ name: 'review', run: 'true' }] })
      const { bodies, seen } = watching()
      const { actionsAt } = watchingActions({
        proposed: [canned('review', { verdict, evidence: '…', findings: [] })],
      })
      const { emit } = events()

      const result = await runPass({ recipe, context, emit, bodies, actionsAt })

      expect(seen.at(-1)?.step).toBe('end')
      expect(result.steps.map((s) => s.step).filter((s) => s === 'end')).toEqual(['end'])
    }
  })

  /**
   * A body that throws rather than returning: T4b's `implement` when the agent
   * runtime raises, `merge`'s when `git push` throws. Nothing else in the pass
   * catches it, so without the loop's own guard the promise rejects with
   * `steps` and `stoppedAt` discarded and `end` never reached — no resolved
   * effects, no terminal outcome, and an item waiting on a run that vanished.
   * `action.ts` guards the same hole one layer down and says why.
   */
  it("runs after a body that threw, and the throw is the step's ending", async () => {
    const { bodies, seen } = watching({
      implement: async () => {
        throw new Error('the agent runtime raised: ECONNRESET')
      },
    })
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toEqual({
      step: 'implement',
      ending: {
        ending: 'did-not-finish',
        because: 'threw',
        at: null,
        detail: 'the `implement` step threw: the agent runtime raised: ECONNRESET',
      },
    })
    expect(result.steps.map((s) => s.step)).toEqual(['claim', 'admit', 'prepared', 'design', 'implement', 'end'])
    expect(seen.at(-1)).toMatchObject({ step: 'end', outcome: 'blocked' })
  })

  /** And a list that could not even be built is the same ending, not a crash. */
  it('runs after an actionsAt that threw', async () => {
    const { bodies, seen } = watching()
    const actionsAt: PassOptions['actionsAt'] = (step) => {
      if (step === 'prepared') throw new Error('no plugin named `instal`')
      return []
    }
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(result.stoppedAt).toMatchObject({
      step: 'prepared',
      ending: { ending: 'did-not-finish', because: 'threw' },
    })
    expect(seen.at(-1)?.step).toBe('end')
  })

  /**
   * The one case the loop already reached it. Running it twice would carry out
   * a recipe's effects twice, which is what `resolveEndActions`'s per-outcome
   * dedupe exists to stop one layer down — and it should not need to.
   */
  it('runs once when end itself is the step that did not pass', async () => {
    const { bodies, seen } = watching({
      end: async () => ({
        ending: 'did-not-finish',
        because: NEEDS_INPUT,
        at: null,
        detail: 'who owns this?',
      }),
    })
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(seen.filter((s) => s.step === 'end')).toHaveLength(1)
    expect(result.steps.filter((s) => s.step === 'end')).toHaveLength(1)
    // And it is not taken to the router: `end` runs after the decision.
    expect(result.routes).toEqual([])
  })

  /**
   * **And it is not what stopped the pass.** `end` is reached after a walk that
   * got through — so the merge landed, and its body was handed `landed` and has
   * already resolved its `when: landed` effects, closing the issue and labelling
   * the item. Naming `end` on `stoppedAt` would leave one pass with two readings
   * that disagree: `outcomeOf` would say `blocked`, and a T5 caller appending
   * from it — the mapping this file exports for exactly that — would write
   * `WorkItemBlocked` for an item whose `main` moved, and sit it on *Waiting on
   * you*.
   *
   * How `end` went is not lost; it is `end`'s own entry in `steps`.
   */
  it('does not report itself as where the pass stopped', async () => {
    const { bodies, seen } = watching({
      end: async () => ({ ending: 'did-not-finish', because: 'threw', at: null, detail: 'tell.ts: 404' }),
    })
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    // What the body was told and what a caller reads back are one answer.
    expect(seen.at(-1)).toMatchObject({ step: 'end', outcome: 'landed' })
    expect(result.stoppedAt).toBeNull()
    expect(outcomeOf(result)).toBe('landed')
    expect(result.steps.at(-1)).toMatchObject({
      step: 'end',
      ending: { ending: 'did-not-finish', because: 'threw', detail: 'tell.ts: 404' },
    })
  })
})

describe('end is told which of the four endings it is running for', () => {
  /**
   * `end` is the one step whose declared effects are filtered by `when:`, and
   * `resolveEndActions(events, end, outcome)` takes that outcome as its third
   * argument. A body handed no value for it can only run every declared cell on
   * every ending — `agent:hold` on an item that landed — or run none of them,
   * which is `#61`'s declared-drawn-never-fired failure.
   *
   * The mapping itself is the conductor's, not this file's invention: every
   * stop that asks a person resolves `blocked` and the merge resolves `landed`
   * (`conduct.ts`'s own three endings), and the wall releases the claim without
   * asking anybody (0031 §3).
   */
  const endSaw = async (steps: Record<string, unknown>, at: Record<string, readonly Action[]> = {}) => {
    const { bodies, seen } = watching()
    const { actionsAt } = watchingActions(at)
    const { emit } = events()
    await runPass({ recipe: recipeWith(steps), context, emit, bodies, actionsAt })
    return seen.filter((s) => s.step === 'end').at(-1)?.outcome
  }

  const stopping = (verdict: ActionResult['verdict']) => ({
    proposed: [canned('check', { verdict, evidence: '…', findings: [] })],
  })
  const oneAtProposed = { proposed: [{ name: 'check', run: 'true' }] }

  it('says landed when every step passed', async () => {
    expect(await endSaw({})).toBe('landed')
  })

  it('says blocked when a step refused, held for a person, or did not finish', async () => {
    for (const verdict of ['failed', 'needs-approval', 'did-not-finish'] as const) {
      expect(await endSaw(oneAtProposed, stopping(verdict))).toBe('blocked')
    }
  })

  /** The one verdict that asks nobody: the claim is released and the item requeues. */
  it('says failed when the agent never started', async () => {
    expect(await endSaw(oneAtProposed, stopping('never-ran'))).toBe('failed')
  })

  it('tells the other nine nothing, because the outcome is not decided yet', async () => {
    const { bodies, seen } = watching()
    const { actionsAt } = watchingActions()
    const { emit } = events()

    await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })

    expect(seen.filter((s) => s.outcome !== null).map((s) => s.step)).toEqual(['end'])
  })

  /** And the rule on its own, since it is the pass's and not a body's (0058 §2b). */
  it("is outcomeOf, and closed is nobody's pass to reach", () => {
    expect(outcomeOf({ stoppedAt: null, rested: null })).toBe('landed')
    expect(
      outcomeOf({
        stoppedAt: { step: 'merge', ending: { ending: 'held', at: 'sign off', question: '?' } },
        rested: null,
      }),
    ).toBe('blocked')
    expect(
      outcomeOf({
        stoppedAt: { step: 'prepared', ending: { ending: 'never-ran', at: 'install', detail: '…' } },
        rested: null,
      }),
    ).toBe('failed')
    // A requeue releases the item too, for the opposite reason (0040).
    expect(
      outcomeOf({
        stoppedAt: { step: 'build', ending: { ending: 'refused', because: 'red', at: 'tests', detail: '…' } },
        rested: 'requeued',
      }),
    ).toBe('failed')
  })
})

describe('the ten bodies are empty, and the two that are not silent', () => {
  it('passes every step a recipe left empty', async () => {
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({ recipe: recipeWith({}), context, emit, actionsAt })

    expect(result.stoppedAt).toBeNull()
    expect(result.steps.map((s) => s.step)).toEqual([...STEPS])
  })

  /**
   * **A pass with no rounds to spend sends every refusal to a person**, which
   * is the correct answer while `rounds` can buy nothing and is what the
   * default `Ceilings` (`NOTHING_SPARE`) therefore gives. It is not the
   * straight break to `end` that leaves a `proposed` written later as a
   * router nothing can call: the refusal reaches `offerFor`, nothing but a
   * person is on offer, and `routes` records that it rested there.
   */
  it('sends a refusal to a person, through the router, with no round to spend', async () => {
    // `build`, not `prepared` (`#467`): a red build still arrives at
    // `proposed`, which is the one thing this test needs from its example.
    const recipe = recipeWith({ build: [{ name: 'tests', run: 'pnpm test' }] })
    const { actionsAt } = watchingActions({
      build: [canned('tests', { verdict: 'failed', evidence: '3 failing', findings: [] })],
    })
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, actionsAt })

    expect(result.steps.map((s) => s.step)).toEqual([
      'claim',
      'admit',
      'prepared',
      'design',
      'implement',
      'build',
      'proposed',
      'end',
    ])
    expect(result.routes).toMatchObject([{ from: 'build', to: 'waiting' }])
    expect(result.routes[0]?.why).toContain('nothing but a person was on offer')
    expect(result.rested).toBe('waiting')
    expect(outcomeOf(result)).toBe('blocked')
  })

  /**
   * *Configured and did not run* must not look like *empty* (0016 §4). `end`'s
   * effects are resolved by `resolveEndActions` and carried out by `tell.ts`,
   * and this pass wires neither — so a declared `close:` is a loud error rather
   * than a green step, which is the `#61` failure this file opens by naming.
   */
  it('refuses to pass an end step whose effects it cannot carry out', async () => {
    const recipe = recipeWith({ end: [{ name: 'close it', close: true }] })
    const { actionsAt } = watchingActions()
    const { emit } = events()

    const result = await runPass({ recipe, context, emit, actionsAt })

    // Reported as the step's ending rather than thrown out of the pass, which
    // is the same rule one turn on: a pass that vanished must not look like
    // one that never started. The words are all still there.
    expect(result.steps.at(-1)).toMatchObject({
      step: 'end',
      ending: {
        ending: 'did-not-finish',
        because: 'threw',
        detail: expect.stringContaining(
          'the `end` step has 1 effect(s) declared — "close it" — and this pass has no body',
        ),
      },
    })
    // And it names the call the body will make, third argument filled in: the
    // outcome is what a body needs to decide whether `close it` fires at all.
    expect(result.steps.at(-1)?.ending).toMatchObject({
      detail: expect.stringContaining('resolveEndActions(events, end, "landed")'),
    })
  })

  it('is the same ten bodies the loop uses by default', () => {
    expect(Object.keys(NOT_BUILT_YET).sort()).toEqual([...STEPS].sort())
  })
})

// ---------------------------------------------------------- one caller ----

describe('the pass has one caller, and it is `conduct.ts`', () => {
  /**
   * **This test was *nothing in the conductor imports it*, and `#256` is the
   * commit that wires it** — so the rule is inverted rather than deleted.
   *
   * What it guarded was the blast radius while the pass was unreachable. What it
   * guards now is the thing that replaced that: the pass has **one** caller, and
   * a second one would be a second engine. The old engine is gone, and the way
   * that stays true is that this fails the day another source file reaches for
   * `runPass`.
   *
   * **`pass-steps.ts` is still allowed to import `pass.ts`**, because it is
   * filling in that file's own contract — and nothing but `conduct.ts` may import
   * either. The pattern is `one-store.test.ts`'s: a rule nobody keeps by reading
   * a comment is a failing test.
   *
   * **An `import type` is not a caller** (`#277`). The rule is about the engine —
   * a second file that can call `runPass`, or build the bodies, or reach a port —
   * and a type is none of those: it is erased before anything runs.
   * `judge-agent.ts` builds the prompt a runtime judge is given and reads its
   * answer, so it wants to say *a `Destination`* and *a `Judging`* in its own
   * signatures, and saying them a second time in its own file is the divergence
   * this rule exists to prevent rather than an instance of it. So the match is on
   * a **value** import, which is every import that is not `import type` — and
   * `import { type Ceilings, runPass }` is one, because that file can call.
   *
   * **And on a value `export … from`, which is how it can happen without an
   * `import` at all.** Narrowing to the `import` token let
   * `export { runPass } from "./pass.ts"` through, and a re-export is worse than
   * a caller: `index.ts` re-exports eighteen modules, so one line there makes the
   * engine public API of `@lingtai/conductor` and every package that depends on it
   * a possible second caller — the exact thing this guards, arriving through the
   * one shape the pattern had stopped reading. `export type { … } from` is erased
   * like `import type` and is allowed for the same reason.
   */
  it.each([
    { module: 'pass.ts', allowed: ['pass-steps.ts', 'conduct.ts'] },
    // `hold-of.ts` calls `directionOf` (#452) — reading the same direction the
    // router already computed, never a second routing decision, so this is
    // not the second engine the rule above is against. `pass.ts` is allowed
    // since `#462`: `whatArrived` and the `Judging`/`Judged` types are what
    // the shell builds a judge's brief from, off the visit a body reported —
    // reading the arrival, never deciding a second route.
    { module: 'pass-steps.ts', allowed: ['conduct.ts', 'hold-of.ts', 'pass.ts'] },
  ])('$module is imported only by $allowed', ({ module, allowed }) => {
    const src = fileURLToPath(new URL('../src', import.meta.url))
    // The span is kept inside one statement by refusing to cross the next
    // `import` or `export` token, and **not** by stopping at a `;`: a statement
    // ends at a semicolon or at a newline, and reading only the first made this
    // guard report `judge-agent.ts` as an offender the moment the formatter
    // dropped semicolons (`#367`). Without any bound the lazy span starts at
    // some earlier value import and runs on to this specifier, and every file
    // with any import at all is an offender — which is what the bound is for.
    const reaches = new RegExp(
      `(?:import|export)(?!\\s+type\\b)(?:(?!\\bimport\\b|\\bexport\\b)[\\s\\S])*?["']\\./${module.replace('.', '\\.')}["']`,
    )

    const offenders = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && f !== module && !allowed.includes(f))
      .filter((f) => reaches.test(readFileSync(join(src, f), 'utf8')))
      .sort()

    expect(offenders).toEqual([])

    // The pattern itself, because the scan above is green whenever no file
    // happens to be an offender — which is also true of a pattern that matches
    // nothing. These six say which shapes it reads.
    const spec = `"./${module}"`
    for (const reaching of [
      `import { runPass } from ${spec};`,
      `import { type Ceilings, runPass } from ${spec};`,
      `export { runPass } from ${spec};`,
      `export * from ${spec};`,
    ]) {
      expect(reaches.test(reaching), `should be an offender: ${reaching}`).toBe(true)
    }
    for (const erased of [`import type { Judging } from ${spec};`, `export type { Judged } from ${spec};`]) {
      expect(reaches.test(erased), `should be allowed: ${erased}`).toBe(false)
    }
  })

  /** And the caller is there, which is the other half of *one*. */
  it('is imported by `conduct.ts`', () => {
    const src = fileURLToPath(new URL('../src/conduct.ts', import.meta.url))
    const wiring = readFileSync(src, 'utf8')
    expect(wiring).toMatch(/from ["']\.\/pass\.ts["']/)
    expect(wiring).toMatch(/from ["']\.\/pass-steps\.ts["']/)
    expect(wiring).toContain('runPass({')
  })
})
