/**
 * Where a setting lives — the one place that knows, so that moving one is a
 * change to this file and not to sixty.
 *
 * **These accessors read today's shape and exist for tomorrow's.**
 * [0061](../../../doc/decisions-archive/0061-the-recipe-is-the-pipeline.md) §4 puts
 * every setting on the step that owns it: what a pass may spend belongs to
 * `implement`, the branch belongs to `worktree:`, which kinds are taken belongs
 * to `queue:`. What has moved is *who asks* — a caller says
 * `limitsFor(recipe, "implement")` rather than reaching into
 * `recipe.runtime.limits`, and the day a value moves, every one of those callers
 * is already asking the right question.
 *
 * **`limitsFor`'s `step` argument was the bet, and `#314` collected it.** It read
 * `void step;` for eight tickets, on the argument that a function which took no
 * step would have to grow one later — the sixty-file change this file exists to
 * avoid. [0070](../../../doc/decisions-archive/0070-a-dispatch-is-one-shape-and-the-ceiling-is-stated-once.md)
 * §5 put a `limits:` on a dispatch, the argument started being read, and the
 * eleven callers that were already passing the step they were *at* needed no
 * edit. What did need one is the four that meant **the ceiling** rather than the
 * step — `ceilingOf` is that question, and it is a second accessor because
 * `pnpm typecheck` cannot tell two readings of one type apart.
 *
 * Nothing here is a default or a fallback. A recipe is resolved before it
 * reaches any of these, so every value is present and an absent one is a bug in
 * the schema rather than something to paper over here.
 *
 * **`branchOf` and `submodulesOf` are the first two to have actually moved, and
 * they are still one question each** (`#268`, 0065). `branchOf` reads
 * `branch.personal` in team mode and `branch.main` in solo; the v1 spellings
 * of the base (`repo.base`, `worktree.base`) are refused by name
 * before the parse (`oldSpellingsIn`) and never reach it. `submodulesOf`
 * reads `worktree:` at `admit` first and `repo:` second, a **spelling** rather
 * than a fallback. Every reader asks the accessor, so the merge lane lands on
 * what the tree was cut from, and there is no place for the two to disagree.
 *
 * **There is one accessor per setting 0061 §4 moves, and the set is closed by
 * that list rather than by what a caller happened to need.** It was three for a
 * while — `limitsFor`, `branchOf`, `kindsOf` — and the other three settings in
 * the same five-line table were read by hand in nine files: `repo.submodules`
 * at `conduct.ts` and the wizard, `source.exclude` at `discover.ts`, the
 * filter, the wizard and the board, `source.backoff` at four more. A half-set
 * is worse than none, because the guard below reads as *nothing reaches past
 * the accessors* while three of the six settings have nothing to reach past.
 * `#231` is what found it: the move is a change to this file only if every
 * setting it moves has a home here first.
 *
 * **It is seven now, because 0063 §3 added one to that list rather than to
 * this file.** `assignee` is a field of `queue:` and not a plugin beside it, so
 * it is a setting that moves onto a step exactly as the other six are, and
 * `assigneeOf` is here for the same reason `kindsOf` is.
 *
 * **And four more have actually moved, on `branchOf`'s terms** (`#269`).
 * `kindsOf`, `excludeOf`, `backoffOf` and `assigneeOf` read a `queue:` declared
 * at `claim` first and `source:`/`runtime:` second, which is the same **spelling**
 * distinction `cutAt` draws and not a fallback: both are present on a resolved
 * recipe, and which one a file wrote is exactly the knowledge this file exists to
 * hold alone. So a recipe that declares its queue at the step gets the filter, the
 * wizard, the board, `lingtai add` and the pass reading the same four values —
 * which is the failure `#231` found, arriving through a half-moved setting rather
 * than through a reader.
 */
import { STEPS, type Step } from '@lingtai/domain'

import { maxTurns, parseDuration, type TurnLimit } from './duration.ts'
import { isBuiltInJudge } from './judges.ts'
import { DiscussAgent, type QueueSettings, type Recipe, type StepAction, type TicketSource } from './recipe.ts'

export type { TicketSource } from './recipe.ts'

/**
 * What one call this step makes may spend, **as a dispatch's own `limits:`**, or
 * null where it declares none and the ceiling is what bounds it (0070 §5).
 *
 * `agent:` always dispatches; `judge:` dispatches when it names a runtime and
 * never when it names a built-in, which is a synchronous function the router
 * applies. Exactly `agentRefusal`'s test, and the schema's: the three places that
 * ask *is this a paid call* have to agree, or a step's bound is read off an
 * action that never runs.
 */
function dispatchedBy(action: StepAction): { turns?: number; wall?: string } | null | undefined {
  if ('agent' in action) return action.limits ?? null
  if ('judge' in action && !isBuiltInJudge(action.judge)) return action.limits ?? null
  return undefined
}

/**
 * **Whether a dispatch that runs on `runtime` promises a turn count of its own**
 * (`#547`).
 *
 * `lingtai doctor` reads the ceiling, and with `turns: unbounded` the ceiling
 * promises nothing — but a step's `limits: { turns: 50 }` still does, and on a
 * runtime that cannot hold turns it would read green while promising 50 that
 * nothing stops. A dispatch is an `agent:` action, or a `judge:` naming a
 * runtime; both are matched by the runtime they name, and a step that names a
 * *different* runtime is that runtime's check.
 */
export function declaresTurnsOn(recipe: Recipe, runtime: string): boolean {
  return STEPS.some((step) =>
    recipe.steps[step].some((action) => {
      const runs = 'agent' in action ? action.agent : 'judge' in action ? action.judge : undefined
      return runs === runtime && dispatchedBy(action)?.turns !== undefined
    }),
  )
}

/**
 * **What one agent run at `step` may spend — the step's upper bound, and never
 * one dispatch's own** (`#314`, 0070 §5).
 *
 * The `step` argument was `void step;` until this ticket, and the comment above
 * this file said so: *a function that took no step would have to grow one later*.
 * It grew one. A dispatch's `limits:` may narrow `runtime.limits` and may not
 * widen it — refused when the recipe resolves — so what a step may spend is the
 * **maximum** over its dispatches, and the ceiling where it has none.
 *
 * **There are two questions here and only one of them is this one.** A step may
 * hold several dispatches — `StepMap` refuses a second `worktree:` or `queue:`
 * at a step and refuses no second `agent:` — so:
 *
 * - *what may this **call** spend* is the action's own `limits:`, read at the
 *   seam that builds the dispatch, falling back to `ceilingOf`. Never this.
 * - *what may this **step** spend at most* is this, and it is what
 *   `attemptCeiling`'s sentence is made of.
 *
 * Conflating them under-reports: a `review` holding a narrowed dispatch beside
 * an undeclared one may spend the ceiling, because the undeclared one may.
 *
 * **A caller that writes `runtime.limits` wants `ceilingOf` and not this.** The
 * wizard saves the recipe's ceiling (`#375`), and narrowing that to whatever
 * `implement` asked for would lower it permanently on the next save.
 * `pnpm typecheck` cannot tell the two apart — both return the same type — so
 * the question is in the name.
 *
 * **The ceiling object itself comes back where nothing narrows**, by identity, so
 * *a recipe nobody edited resolves to the same values* is cheap to assert
 * (0070 §8).
 */
export function limitsFor(recipe: Recipe, step: Step): Recipe['runtime']['limits']['run'] {
  const ceiling = recipe.runtime.limits.run
  const ceilingWallMs = parseDuration(ceiling.wall)
  let turns: TurnLimit = 0
  let wall = ceiling.wall
  let wallMs = 0
  let dispatches = 0
  for (const action of recipe.steps[step]) {
    const own = dispatchedBy(action)
    if (own === undefined) continue
    dispatches += 1
    turns = maxTurns(turns, own?.turns ?? ceiling.turns)
    const ms = own?.wall === undefined ? ceilingWallMs : parseDuration(own.wall)
    if (ms > wallMs) {
      wallMs = ms
      wall = own?.wall ?? ceiling.wall
    }
  }
  if (dispatches === 0) return ceiling
  if (turns === ceiling.turns && wallMs === ceilingWallMs) return ceiling
  return { ...ceiling, turns, wall }
}

/**
 * **`runtime.limits` itself — the ceiling, said once** (`#314`, 0070 §5).
 *
 * `limitsFor`'s opposite and the reason it can be a maximum: what a step may
 * spend is a reduction from this, and this is what a machine file stores and a
 * dial edits. Every reader that means *the bound the recipe states at the top*
 * asks for it by that name, so the two questions are told apart by the call and
 * not by a comment beside it.
 *
 * An accessor rather than an inlined `recipe.runtime.limits`, for the reason
 * every accessor in this file is one: `unit/settings.test.ts`'s *nothing reaches
 * past them* greps the workspace for exactly that expression, and the day the
 * ceiling moves it moves here.
 */
export function ceilingOf(recipe: Recipe): Recipe['runtime']['limits'] {
  return recipe.runtime.limits
}

/**
 * How many passes of this project may run at once (0122 §1): the recipe's
 * `runtime.concurrency`, and 2 where it says nothing.
 */
export function concurrencyOf(recipe: Recipe): number {
  return recipe.runtime.concurrency ?? 2
}

/** A step that dispatches, and what it may spend — `boundsBesides`' rows. */
export interface StepBound {
  step: Step
  turns: TurnLimit
  wall: string
}

/**
 * **Every dispatching step whose bound is not the one a sentence already names**
 * (`#314`, 0070 §9).
 *
 * `attemptCeiling` prints one figure and multiplies it by the rounds, because the
 * rounds are `implement`'s. With per-step bounds that figure stops being the
 * whole truth, and the fix is not a longer computation but a shorter list: the
 * steps that disagree with it, named. A recipe that narrows nothing returns `[]`
 * and the sentence is the one it has always printed, character for character.
 *
 * **Only steps that actually dispatch.** `limitsFor` answers the ceiling for a
 * step with no `agent:` and no runtime `judge:` — truthfully, since nothing there
 * spends anything — and listing `admit 1h/150 turns` beside a narrowed
 * `implement` would be a bound on a step that buys no agent at all.
 */
export function boundsBesides(recipe: Recipe, named: Step): readonly StepBound[] {
  const figure = limitsFor(recipe, named)
  const rows: StepBound[] = []
  for (const step of STEPS) {
    if (step === named) continue
    if (!recipe.steps[step].some((action) => dispatchedBy(action) !== undefined)) continue
    const own = limitsFor(recipe, step)
    if (own.turns === figure.turns && parseDuration(own.wall) === parseDuration(figure.wall)) continue
    rows.push({ step, turns: own.turns, wall: own.wall })
  }
  return rows
}

/**
 * **Every step that dispatches, named rather than bounded** (`#348`).
 *
 * `boundsBesides` answers *which steps cost something different from
 * `implement`*, and drops a step whose bound happens to equal `implement`'s —
 * which is the common case for a reviewer left on the default ceiling. A
 * caller that means *is anything beyond `implement` paying for a run at all*,
 * regardless of what it costs, asks this instead and filters out `implement`
 * itself.
 *
 * Built on `dispatchedBy`, so a step counts as dispatching on exactly the
 * terms `limitsFor` already does: an `agent:` always, and a `judge:` only
 * where it names a runtime rather than a built-in.
 */
export function dispatchingSteps(recipe: Recipe): readonly Step[] {
  return STEPS.filter((step) => recipe.steps[step].some((action) => dispatchedBy(action) !== undefined))
}

/**
 * The `worktree:` this recipe declares at `admit`, or null where it declares
 * none and `repo:` is what says it.
 *
 * `find` and not a reduction over several, because a step cuts one worktree or
 * none: `StepMap` refuses a second `worktree:` at a step by name when the recipe
 * resolves, so *the first one* and *the only one* are the same entry here.
 */
function cutAt(recipe: Recipe): { submodules: boolean } | null {
  const declared = recipe.steps.admit.find((action) => 'worktree' in action)
  return declared === undefined ? null : declared.worktree
}

/** Which way this recipe lands (0130 §1): `solo` unless it writes `mode: team`. */
export function modeOf(recipe: Recipe): 'solo' | 'team' {
  return recipe.mode ?? 'solo'
}

/**
 * What `pr.ci` resolves to, and where each value came from (0130 §5). **The one
 * reader**: the recipe carries no defaults for these keys (they would move the
 * hash), so absent means `detect`, every check (`'all'`) and 60 minutes. A
 * `jenkins` provider is refused when a recipe resolves, so reaching here with
 * one means the recipe was parsed and never resolved.
 */
export function ciOf(recipe: Recipe): {
  provider: 'github-actions' | 'none' | 'detect'
  required: readonly string[] | 'all'
  timeoutMs: number
  from: { provider: 'recipe' | 'default'; required: 'recipe' | 'default'; timeout: 'recipe' | 'default' }
} {
  const ci = recipe.pr?.ci
  if (ci?.provider === 'jenkins')
    throw new Error('pr.ci.provider: jenkins reached ciOf from a recipe that was never resolved')
  return {
    provider: ci?.provider ?? 'detect',
    required: ci?.required ?? 'all',
    timeoutMs: ci?.timeout === undefined ? 3_600_000 : parseDuration(ci.timeout),
    from: {
      provider: ci?.provider === undefined ? 'default' : 'recipe',
      required: ci?.required === undefined ? 'default' : 'recipe',
      timeout: ci?.timeout === undefined ? 'default' : 'recipe',
    },
  }
}

/**
 * What one run of the `pr:` agent may spend, resolved (#1318, 0131 §5): `callFor`'s twin for the summary. **The agent is
 * `pr.agent`, else `runtime.agent` where that is one a run with no tools can be held to (`DiscussAgent`); null where it
 * is not**, and there is then no summary run — never a runtime that was not asked for. No `usd`: `Pr` carries none.
 */
export function callForPr(recipe: Recipe): {
  agent: DiscussAgent | null
  model?: string
  prompt?: string
  turns: number
  wallMs: number
} {
  const pr = recipe.pr
  const stand = DiscussAgent.safeParse(pr?.agent ?? recipe.runtime.agent)
  return {
    agent: stand.success ? stand.data : null,
    ...(pr?.model === undefined ? {} : { model: pr.model }),
    ...(pr?.prompt === undefined ? {} : { prompt: pr.prompt }),
    turns: pr?.limits.turns ?? 20,
    wallMs: parseDuration(pr?.limits.wall ?? '5m'),
  }
}

/**
 * The branch a pass cuts from and lands on: `branch.personal` in team mode and
 * `branch.main` in solo (0104 §5, 0130 §2). **The one reader**; the old
 * spellings (`repo.base`, `worktree.base`) are refused by name
 * before the parse (`oldSpellingsIn`) and never reach the `Recipe` type.
 */
export function branchOf(recipe: Recipe): string {
  return modeOf(recipe) === 'team' ? (recipe.branch.personal ?? recipe.branch.main) : recipe.branch.main
}

/** The key `branchOf` reads, for a message that names the line to edit. */
export function branchKeyOf(recipe: Recipe): 'branch.main' | 'branch.personal' {
  return modeOf(recipe) === 'team' ? 'branch.personal' : 'branch.main'
}

/**
 * Whether the worktree a pass is cut into gets the submodules.
 *
 * `branchOf`'s sibling: a caller that asks for one usually asks for the other in the
 * next line (`conduct.ts`'s `repo.provision` call is exactly that pair).
 *
 * **A declared `worktree:` must name it** — `worktreePlugin`'s schema has no
 * default for `submodules`, so there is no third answer between *the step said*
 * and *`repo:` said*. A block that named only its base would otherwise take
 * `false` from a schema while `repo.submodules: true` sat two blocks up unread,
 * and the symptom of that is every test that imports a submodule failing in a
 * way that reads as the agent's fault.
 */
export function submodulesOf(recipe: Recipe): boolean {
  return cutAt(recipe)?.submodules ?? recipe.repo?.submodules ?? false
}

/**
 * The `queue:` this recipe declares at `claim`, or null where it declares none
 * and `source:`/`runtime:` are what say it (`#269`).
 *
 * `cutAt`'s sibling and written for its reason: `find` and not a reduction over
 * several, because a step takes one ticket or none — `StepMap` refuses a second
 * `queue:` at a step by name when the recipe resolves, so *the first one* and
 * *the only one* are the same entry here.
 */
function takeAt(recipe: Recipe): QueueSettings | null {
  const declared = recipe.steps.claim.find((action) => 'queue' in action)
  return declared === undefined ? null : declared.queue
}

/**
 * The kinds the queue takes, **in priority order** — the order is the
 * meaning, so this returns the list rather than a set.
 */
export function kindsOf(recipe: Recipe): Recipe['source']['kinds'] {
  return takeAt(recipe)?.kinds ?? recipe.source.kinds
}

/**
 * The labels that keep the agent off a ticket.
 *
 * A list and not a set, for the reason `kindsOf` is one: what the recipe wrote
 * is what the wizard offers back and what a refusal names, and the one caller
 * that wants matching — `considerIssue` — lowercases into a `Set` of its own,
 * because the match is case-insensitive and that is the *matcher's* rule rather
 * than this list's.
 */
export function excludeOf(recipe: Recipe): Recipe['source']['exclude'] {
  return takeAt(recipe)?.exclude ?? recipe.source.exclude
}

/**
 * How long a failed attempt keeps its own ticket out of the queue — **as it was
 * written**, so a reading can print `1h` rather than `3600000`.
 *
 * `parseDuration` stays at the call sites that want milliseconds. Returning the
 * number here would make the two readers that show it to a person reconstruct
 * the string, and 0028's whole point is that the value is the repository's own
 * and is read back by whoever set it.
 */
export function backoffOf(recipe: Recipe): Recipe['source']['backoff'] {
  return takeAt(recipe)?.backoff ?? recipe.source.backoff
}

/**
 * Where this project's tickets live — `github` where a recipe writes
 * nothing, `db` where it names it.
 *
 * **Not one of `queue:`'s four, and `takeAt` plays no part here** (#381):
 * this is where tickets live, not which of them the queue takes, so a
 * `queue:` block declared at `claim` cannot narrow or override it. The
 * default lives here and not on the schema field, for `backoffOf`'s reason:
 * a recipe that writes nothing hashes exactly as it did before this setting
 * existed.
 *
 * The board reads it directly (#384) — `apps/board/src/lib/task.ts` calls
 * this function, not `ticketsFor`, to decide whether to ask GitHub at all,
 * and for `db` returns without ever fetching a body. `ticketsFor`
 * (`@lingtai/conductor/ticket-store`, `#382`) is what the pass, the queue
 * and the daemon's convergence take their tickets from instead of a
 * `GitHubClient` directly — and, since #383, so does `lingtai backlog
 * accept` (`apps/cli/src/backlog.ts`'s `projectClient`).
 *
 * **A `db` project with no GitHub App still refuses at `backlog accept`.**
 * `projectClient` builds a `GitHubClient` with `githubClientFor` before it
 * ever asks `ticketsFor` where tickets live, and `backlog.ts`'s own check
 * refuses by name first — so this setting decides where tickets are read
 * and written, not whether the App is required to get there.
 */
export function ticketSourceOf(recipe: Recipe): TicketSource {
  return recipe.source.tickets ?? 'github'
}

/**
 * The repository's own `origin` — where a mirror fetches from and the merge
 * lane pushes to — or null where the recipe names none and `worktree.ts:102`'s
 * GitHub default applies.
 *
 * **Not one of `queue:`'s four, and `takeAt` plays no part here**, for
 * `ticketSourceOf`'s reason: this is a property of the repository, not of one
 * cut, so nothing moves it onto `admit` the way `submodulesOf`
 * moves. `cutAt` is not asked.
 */
export function remoteOf(recipe: Recipe): string | null {
  return recipe.repo?.remote ?? null
}

/**
 * Whose tickets this project takes — **`queue:`'s fourth field**. At the top
 * level it is `source.assignee`, beside the other three (#1356); `runtime.assignee`
 * is an old spelling that `oldSpellingsIn` refuses and `lingtai doctor --fix`
 * rewrites. It was the machine file's before `#373` (0063 §4) moved it into the recipe. `#244` is the
 * ticket that found the readers — `assigneeSkip`'s caller in `discover.ts`,
 * `describeFilter` and the board's reading — each reaching in by hand, which
 * is why they now ask here instead.
 *
 * Absent is `all`, and it is returned absent rather than filled in: what an
 * absent rule means belongs to `assigneeSkip` and to `describeAssignee`, which
 * say it in their own words, and 0046 §2's *a wrong login shows itself* wants
 * the reading to be able to say *nothing was written* rather than *both*.
 *
 * **A declared `queue:` must name it**, so the `??` below is a spelling and not
 * a fallback, exactly as `submodulesOf`'s is: there is no third answer between
 * *the step said* and *`source:` said*, and a block that named only its
 * kinds cannot silently hand this machine somebody else's tickets (`#269`).
 */
export function assigneeOf(recipe: Recipe): Recipe['source']['assignee'] {
  return takeAt(recipe)?.assignee ?? recipe.source.assignee
}

/**
 * **All four at once** — what `claim`'s `queue:` action carries, and what the
 * code that picks a ticket is handed (`#269`).
 *
 * The four accessors above are still the one place each setting's spelling is
 * known; this is them read together, because `considerIssue` and `runnableNow`
 * in `packages/conductor/src/discover.ts` apply all four in one pass over one
 * GitHub response (0063 §3: *they answer one question*). A caller that has only
 * a recipe asks this; a caller that is running a declared action already has the
 * block and must **not** ask, so that the ticket a pass takes is the one the
 * reading of the recipe says it took.
 *
 * **`assignee` is the one value this fills in, because the block requires it and
 * `source.assignee` is absent from some recipes.** `EVERYONE` is what an
 * absent rule has always meant at the one place that reads it — `assigneeSkip`'s
 * `rule?.take ?? "all"` — so writing it here selects identically and says out
 * loud what a pasted `queue:` must then write. The *reading* of an absent rule is
 * still `assigneeOf`'s, which returns it absent: *nothing was written* and
 * *everyone* are one filter and two sentences, and only the filter is here.
 */
export function queueOf(recipe: Recipe): QueueSettings {
  return {
    kinds: kindsOf(recipe),
    exclude: excludeOf(recipe),
    backoff: backoffOf(recipe),
    assignee: assigneeOf(recipe) ?? EVERYONE,
  }
}

/**
 * What a pass selects *on*, beyond `queue:`'s four values (#1310): the mode and where tickets
 * live. Filled by `selectionOf` at every caller of `runnableNow`, so the conductor, `lingtai run`,
 * `lingtai status` and the board answer one question one way.
 *
 * **Not part of `queue:`**: a declared `queue:` action hands its own block, and a field there would
 * be a recipe key a person could write.
 */
export interface Selection {
  readonly mode: 'solo' | 'team'
  readonly tickets: TicketSource
}

export function selectionOf(recipe: Recipe): Selection {
  return { mode: modeOf(recipe), tickets: ticketSourceOf(recipe) }
}

/**
 * What an unwritten `source.assignee` selects — **every issue, whoever it is
 * assigned to**, which is how the queue behaved before it read an assignee at
 * all (`assigneeSkip`).
 */
const EVERYONE = { take: 'all' } as const
