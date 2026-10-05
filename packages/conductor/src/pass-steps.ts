/**
 * **The ten bodies**, against the contract [`pass.ts`](pass.ts) already fixed —
 * `claim`, `admit`, `prepared`, `design`, `implement` and `end` from T4a
 * (`#259`), and `build`, `review`, `proposed` and `merge` from T4b (`#254`).
 *
 * **Still wired to nothing** (`#254`, `#259`, and `#253` before them). `runPass`
 * takes the ten bodies as a seam and defaults to `NOT_BUILT_YET`; this file is
 * what a caller hands it instead, and no caller does yet. T5 is the ticket that
 * wires it, and `pass.test.ts`'s *nothing in the conductor imports it* is the test
 * that fails the day anything but the pass's own two files does.
 *
 * **Five of the ten are nothing beyond their plugins** — `prepared`, `build`,
 * `review`, `admit` (`#268`) and `merge` (`#270`) — and that is the shape of them
 * rather than an unfinished body: their work is a `run:` carrying commands, an
 * `agent:` reading the diff, a `worktree:` cutting the branch and a `merge:`
 * landing it, the loop has run each by the time the body is called, and the step's
 * part is the outcome rules. `endingOf` is where `review`'s is, because a
 * reviewer's `failed` verdict arrives before any body could see it — and it is
 * also where `merge`'s reason is carried, because the lane's own word is on the
 * action's result rather than on anything a body could still say.
 *
 * ## What a body is, and why most of them are not empty
 *
 * [0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md) §2b
 * divides this file from the one beside it in one sentence — *the core is the
 * sequence and the outcome rules; everything that acts is a plugin.* The loop
 * owns the sequence. **A body owns the outcome rules for one step**: it asks for
 * the step's own work and says which of the seven endings that answer is, in the
 * vocabulary 0057 and 0058 §3c fix — and *which ending* is the whole of what a
 * caller downstream acts on, because a refusal buys a fix round and a
 * `did-not-finish` buys none of it.
 *
 * So the bodies here are thin on purpose and the thinness is the point: every
 * line of them is a mapping from *what happened* to *what that costs*. Nothing
 * in them spawns a process, reads GitHub, cuts a worktree or pays an agent —
 * `PassPorts` does, and it is handed in. That is why this file's tests are in
 * `unit/` and the `build` point runs them
 * ([0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1).
 *
 * **Why a port and not a plugin, at the three that are still ports.** 0061 §3
 * puts `queue:` at `claim`, `worktree:` at `admit` and `agent:` at `design` and
 * `implement`, and those four plugin names exist — `PLUGINS` in
 * `@lingtai/recipe` carries them. **`worktree:` is wired and the other three are
 * not**: `worktreePlugin.at` carries `admit` since `#268`, so that step's body
 * is empty and `ports.cut` is gone, while no plugin's `at` carries `claim`,
 * `design` or `implement` and `whyNoKindAt` refuses every kind at those three by
 * name, saying where the code is called from instead. **Naming a thing is not
 * wiring it**, and until a plugin claims the step, the step's own work is its
 * body's. A port is what keeps that honest: the body still cannot act, so the
 * day a plugin claims it the body loses the call and keeps the rule — which is
 * what `admit` losing it looked like.
 *
 * **`ports.land` is what that looks like once it has happened** (`#270`), and
 * `ports.judge` is the other half of the same fact. Neither was a stand-in for a
 * plugin that would exist; each was the seam that plugin is reached *through*.
 * `mergePlugin.at` carries `merge` now, so the lane is a `merge:` action's dep
 * (`MergeActionDeps.land`, handed over in `conduct.ts`'s `stepDeps`) and the port
 * is gone from this file with the body that called it. `judge:` went the same way
 * (`#274`) and kept its port, because a judge answers *which step is next* rather
 * than producing a verdict: `judgePlugin.at` carries `proposed`, and what a caller
 * hands `ports.judge` is `judgeDeclaredAt(recipe.steps.proposed, when)`. The port
 * did not change shape for it, which was the claim.
 *
 * **Why plain promises rather than [0026](../../../doc/decisions-archive/0026-the-conversion-past-the-seam.md)'s
 * `Effect`.** `ports.ts`'s two are Effect-shaped because `conduct.ts` is, and
 * the conversion is at the boundary the *caller* stands on. `runPass` is plain,
 * its `actionsAt` and `emit` seams are plain, and a second calling convention
 * inside one file would be a thing to learn for no gain. The caller that builds
 * a live `PassPorts` from `Repo` and `AgentHost` runs the conversion there, once,
 * where it already has a runtime.
 *
 * ## What travels between the steps, and how
 *
 * One fact is made at one step and needed at a later one, and `StepWork` does
 * not carry it:
 *
 * ```
 * the design      design → implement          a document and where it was kept
 * ```
 *
 * It is held by `bodiesFor`, cleared at `claim` so one closure may conduct one
 * pass after another, rather than on the ports, which stay stateless and
 * therefore fakeable one method at a time.
 *
 * **It was three, and two have left the same way.** `admit` cut the worktree in a
 * body, so the path was a fact this file had to hold and hand on; since
 * `worktreePlugin` declares `admit` (0065 §4) the cut is an action's, and the only
 * closure that can have the path is the one whose dep made it — `conduct.ts`'s
 * `cutTree`. `claim` took the item in a body until `queuePlugin` declared `claim`
 * (`#269`), and the item moved for the same reason to the same place: `ports.item`
 * and `ports.onStream` are that closure's, **read** here rather than assigned, and
 * the reset that begins a pass is in the take itself, which runs before the body
 * and not after it. So `Brief` does not carry a worktree: an implementation is
 * handed a ticket, a design and why it is being run again, and it already knows
 * where it works.
 *
 * **What the loop already carries is read off `StepWork` and never kept here**,
 * and there are three of those. The head: a step that moved the tree says so on
 * its ending (`LeftTheTreeAt`) and `runPass` carries it to every visit after, which
 * is why `admit` and `implement` return one and nothing here reads `onSha` back.
 * The route back: which visit sent the pass to this step and why is in
 * `reached`, so `SentBack` is computed from the visit list rather than remembered
 * — a body that remembered it would have to know how many rounds ago it was.
 * **And `review`'s findings**, which is the one a fourth closure variable would be
 * most tempting for: they are its plugins' verdicts, they are on
 * `StepReached.results`, and `proposed` reads them off the visit list one step
 * later (`reviewRefused`). A copy here would be a second source of truth for the
 * sentence the pass is already holding in memory.
 *
 * **What does not travel is the worktree's path into `ActionContext.cwd`.** The
 * pass rebuilds three fields of the context per visit — `onSha`, `round`,
 * `recheck` — and `cwd` is the caller's throughout (`PassOptions.context`). So a
 * declared `run:` at `prepared` or `build` runs where the *caller* said, and
 * `admit` cutting a worktree does not move it. That is T5's to close, and it is
 * named here rather than worked around: a body cannot write the context, and
 * inventing a fourth moving field is a change to the skeleton this ticket is
 * filling in.
 *
 * ## What the pass does not write
 *
 * **The item's ending.** `outcomeOf` says which of the four it is and
 * `PassResult` reports it, and appending `WorkItemLanded`, `WorkItemBlocked` or
 * `WorkItemReleased` belongs to whoever holds the claim — `conduct.ts` today,
 * T5's caller after it. `end` here resolves the declared effects against that
 * outcome and records the resolution, which is 0058 §3's *runs on every ending*
 * and the whole of what the ticket asks for; the effects never decide whether
 * the ending happened, and neither does this file's failure to resolve them.
 */
import type { ActionContext, ActionFinding, TheDesign } from '@lingtai/actions'
import type { Envelope, ToAppend } from '@lingtai/domain'
import type { BuiltInJudge, JudgeWhen } from '@lingtai/recipe'
// Type-only, and the shape is imported rather than redeclared for the reason
// `ports.ts` gives: a worktree's path and base sha are data, and a second
// definition of them is a drift nobody would notice.

import { resolveEndActions } from './end-step.ts'
import { BUILT_IN_FOR } from './judge.ts'
import {
  NEEDS_INPUT,
  NOT_BUILT_YET,
  type SentBack,
  ceilingFor,
  type Destination,
  type Offer,
  type StepBodies,
  type StepDidNotFinish,
  type StepNeverRan,
  type StepPassed,
  type StepReached,
  type StepRouted,
} from './pass.ts'

// -------------------------------------------------- what a pass is about ----

/** The issue, as an agent is briefed on it. `#` and the body, and nothing else. */
export interface Ticket {
  /** The issue number, as a string — `discover.ts`'s `ref`. */
  readonly ref: string
  readonly title: string
  readonly body: string
}

/**
 * The item `claim`'s `queue:` action took, and the three things every step after
 * it needs.
 *
 * `conduct.ts` holds it — the closure whose `take` dep made it — and the pass
 * reads it back through `PassPorts.item` (`#269`).
 */
export interface Claimed {
  /** `wi-<project>-<issue>` — `workItemStream`, and where `end` appends. */
  readonly workItemId: string
  readonly ticket: Ticket
  /** Which kind the recipe matched it as, which is what ordered the queue. */
  readonly kind: string
}

/**
 * **A step stopped and asked** — 0058 §3c's `needs-input`, and the one report
 * with anywhere to go (`StepAsked`, its own ending since `#296`).
 *
 * One shape rather than a case written twice, because exactly two *bodies* can
 * produce it — `design` and `implement`
 * ([0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md) §3b's
 * second drawing) — and the judge at `proposed` answers both the same way:
 * `waiting` with the question, or that step again with *state your assumption*.
 *
 * **`admit` was the third and is a plugin's now** (`#268`). The edge is not gone
 * and the shape is not this one: `CutAnswer` in `@lingtai/actions` keeps its own
 * `asked` branch for the same reason this one was written — a port cannot report
 * what its type cannot say — and what it costs has changed with the move. A
 * question from a plugin is the pipeline's `needs-approval`, so `endingOf` reads
 * it as `held` and it stops for a person directly, rather than arriving at the
 * judge as `needs-input`. Nothing produces it at `admit` today either way.
 */
export interface Asked {
  /** What the step wants answered, in words a person reads (0043). */
  readonly asked: string
}

/**
 * **The judge's other answer, as it reaches the step it was written for.**
 *
 * `Asked` above says the judge at `proposed` may answer a question with `waiting`
 * *or that step again with* state your assumption. The second of those spends a
 * round — `onOffer` puts the asking step back on the offer, and `runPass` walks
 * into it again — and a round costs an agent run. So the step must be run
 * *differently* the second time, and the only thing that can make it different is
 * what the judge said: `context.recheck` is empty on this edge, because a
 * question raised no findings, and `context.onSha` is unchanged, because nothing
 * was committed. A second byte-identical brief buys the same question back and
 * burns every round in `ceilings.rounds` arriving at the answer the first one did.
 *
 * **And the same holds for the round a mechanical refusal buys**, which is where
 * the money is: a red `build` routed back to `implement` committed nothing and
 * raised no findings either — a `run:` action returns `findings: []`
 * (`process-action.ts`) — so `context.recheck` is empty too, and the compiler's
 * three errors exist nowhere on this object unless `printed` carries them. The
 * loop this replaces put them in the prompt by name (`fix.ts`, *## What
 * `${action}` printed*), and an agent sent back without them is ~31 turns and
 * ~$3.40 spent on being told only that something failed.
 *
 * Read off `StepWork.reached` rather than held in the closure, because it is the
 * *loop's* fact and not a step's: which visit routed here, with what it said and
 * why, is in the visit list the pass hands every body.
 *
 * **It moved to `@lingtai/actions` in `#266`, and is re-exported here.** The
 * step it is written for is a plugin now — `createWorkAction` reads it off
 * `ActionContext.again` — so it has to be a name that package can see, and
 * `pass.ts` is where the fold that computes it lives (`sentBackTo`).
 */
export type { SentBack }

/**
 * **The step started and left no receipt** — 0057 §2, and the pass stops.
 *
 * A crash, a spent turn budget, an agent that ran and committed nothing. There
 * is no question in it for anybody to answer and nothing for a judge to route,
 * which is the whole of what separates it from `Asked` — and since `#296` that
 * separation is two endings rather than two values of one `because`.
 */
export interface Stopped {
  readonly stopped: string
}

/**
 * **The agent never started** — 0031 §1's `never-started`, and the wall that is
 * about the *account* rather than about the diff: a quota, a signed-out runtime,
 * `You've hit your session limit`. Zero turns and zero cost.
 *
 * One shape shared by the two steps that dispatch an agent, for the reason
 * `Asked` is shared by the three that can ask: **a port cannot report what its
 * type cannot say**, and leaving it off one of them makes the difference
 * disappear at exactly that step. 0061 §3's table puts `agent:` at `design` as
 * well as at `implement`, so a design agent meets this wall identically — and
 * without this case the port's only truthful answer there was `Stopped`, which
 * the body maps to `did-not-finish`: the item is held for a person, nothing
 * signals the account-wide condition, and the next queue pass claims the next
 * ticket and walks into the same wall. That is 0031's own incident — eighty
 * events and six claims in ninety-two seconds — and it is the silence this
 * file's `Asked` calls worse than an unused case.
 *
 * What it costs instead is 0031 §3: the conductor stands down and the item is
 * **released**, because every queued item would meet this identically. The pass
 * reports `never-ran`, `outcomeOf` reads `failed`, and the claim goes back.
 *
 * `agent` is which runtime refused, because 0041 §3 asks for it by name.
 */
export interface NeverStarted {
  readonly neverStarted: { readonly agent: string; readonly detail: string }
}

// ----------------------------------------------------------- the ports ----

/** What the one agent at `implement` did in that worktree. */
export type Worked =
  /** The commit it left the worktree at — the whole of what moves `onSha`. */
  { readonly committed: string } | Asked | NeverStarted | Stopped

/** What an agent at `design` or `implement` is handed. */
export interface Brief {
  readonly ticket: Ticket
  /**
   * The design — the document, and where whatever kept it says it is.
   *
   * **`implement` works from the issue when the document is empty, and there is
   * no conditional step** (0058 §3): the sequence stays fixed and the judgement
   * sits in the one thing that could make it. A typo fix costs no design.
   *
   * **A `TheDesign` and not a `string`, since `#297`**, which is the ticket that
   * decided what crosses this boundary: *both* — the document, which is what the
   * built-in dispatch renders into the prompt, and the locator, which it does
   * not read and a destination-aware plugin might. Never optional: `NO_DESIGN`
   * is what a pass with no `design:` is handed, so a caller cannot forget the
   * empty case into an absent one.
   */
  readonly design: TheDesign
  /**
   * **Why this step is being run a second time**, or `null` on the way through.
   *
   * The whole of what makes a re-run brief different from the first one when the
   * round was bought on a question or on what a step printed: see `SentBack`. An
   * implementation hands it to the agent beside the ticket — *you asked this, and
   * the judge said that*, or *`build` printed this* — and a port that ignores it
   * dispatches the brief that produced the failure.
   */
  readonly again: SentBack | null
  /**
   * This visit's — the head it is working from, the round it is in, and the
   * findings that round was bought on (0038 §2), which an agent on a fix round is
   * asked about by name.
   */
  readonly context: ActionContext
}

/**
 * **What a judge is asked, and it is everything except the numbers.**
 *
 * `JudgeBrief` in [`judge.ts`](judge.ts) is the same object for the same reason,
 * and the reason is the safety property rather than tidiness: a judge that could
 * see `rounds` could answer *back to `implement`* for ever at ~$3.40 a round and
 * nothing would report a fault. So there is no ceiling and no count here — the
 * workflow has already counted, and `offering` is what is left of the arithmetic.
 *
 * **A judge answers *which of these*, never *what is legal*.** `offering` is
 * `Offer.affordable` — `onOffer`'s, computed from how far the pass got as well as
 * from what is left to spend (0061 §3): `prepared`'s refusal happens before any
 * agent has run, so `implement` is not in it there and a judge that knows nothing
 * about `prepared` still cannot choose wrongly.
 *
 * **One list and not the `Offer`'s two**, and that is the safety property again
 * (0064 §7). The reachable half is the workflow's arithmetic *about money*: a
 * judge handed both could read off exactly which destinations the ceilings took
 * away, which is the one thing `JudgeBrief` exists to keep out of its hands. What
 * the two sets are for is the sentence a **person** then reads — `becauseSpent`
 * below — and the body holds them for that.
 */
export interface Judging {
  /** The direction — the reason the step that did not pass gave. */
  readonly when: JudgeWhen
  /** The destinations on offer. Never empty: `waiting` is always one of them. */
  readonly offering: readonly Destination[]
  /** The reviewer's findings, verbatim — the whole of the `findings` direction. */
  readonly findings: readonly ActionFinding[]
  /** What the step printed when it did not pass; the question, for `needs-input`. */
  readonly evidence: string
}

/**
 * One arrival as the body has it, before the offer is put beside it.
 *
 * `Judging` minus the set rather than a second declaration of the three fields:
 * the body computes `offering` from the `Offer` it was handed, so a call site
 * that passed its own would be a set the answer was not held to.
 */
type Arrival = Omit<Judging, 'offering'> & {
  /**
   * **That the step's answer could not be read at all**, which is not a thin
   * judgement and must not read as one (`#279`).
   *
   * `ActionResult.unreadable` one layer down, and it stops here: a judge is never
   * handed it, because an arrival carrying it is answered before any judge is
   * asked. So it is on `Arrival` and not on `Judging` — the brief is the three
   * fields and the set, and what keeps it that way is the key-set assertion at
   * the end of `pass-steps.test.ts`'s *offers a judge only the steps the pass
   * reached*: `Object.keys` of the brief is exactly `evidence`, `findings`,
   * `offering`, `when`. A field added to `Judging` fails there by name, which is
   * the whole reason that assertion is a key set rather than a spot check.
   */
  readonly unreadable: boolean
}

/**
 * What the recipe's `judge:` for that direction answered, or that it declared
 * none.
 *
 * **Four answers, and they are kinds of decider rather than outcomes.** `built`
 * is a judge the recipe declared and the pass applies — a name, spending nothing
 * (`#274`); `next` is a judge that *chose*, which is an agent `conduct.ts`
 * dispatched and paid for (`#277`, which is when `JudgeName` gained the runtimes
 * and this stopped being a cell nothing filled); `neverStarted` is that agent
 * meeting an account-wide wall, which is the conductor's to answer and not this
 * item's (0031 §3); `noJudge` is the recipe saying nothing for this direction.
 *
 * **`noJudge` is not a failure and is the ordinary answer for four of the five.**
 * `BUILT_IN_FOR` is what the body falls back to — the mechanical directions are
 * answered there, synchronously, spending nothing — and where that is `null` too,
 * the pass reaches a person. So a direction nobody configured costs no agent and
 * is never silently let past.
 */
export type Judged =
  | {
      /** Which of the offered steps is next. Held to `offering` by the body. */
      readonly next: Destination
      /** The name a recipe wrote, so a refusal can say which entry to fix. */
      readonly named: string
      /** The judge's own words, which is what `waiting` displays (0043). */
      readonly why: string
    }
  | {
      /**
       * **A built-in the recipe declared for this direction** — one of the two
       * things `judgeDeclaredAt` answers, the other being a runtime (`#274`,
       * `#277`).
       *
       * A name and not a destination, because the rule that name stands for is
       * the pass's: `MECHANICALLY` is `BUILT_IN`'s in this file's vocabulary, it
       * is what the mechanical fallback already applies, and it is where `chose`
       * and the spent ceiling are recorded (`#271`). A port that answered
       * `next` for a built-in would be a second copy of that rule with the
       * card's own distinction missing from it.
       */
      readonly built: BuiltInJudge
      /** The entry's `name:`, so the sentence says which line of the recipe chose. */
      readonly named: string
    }
  /**
   * **The judge's dispatch met something account-wide, so the conductor stops
   * and this item does not back off** (0031 §3).
   *
   * The same arm `Worked` carries and the same shape `stoodDown` reads, because
   * the judge is the *third* depth the one wall is met at — after the step's own
   * agent and after the agent a refusal bought. A quota is about the account and
   * never about the diff (0031 §1), so a judge that never started has judged
   * nothing, exactly as a reviewer that never started has reviewed nothing
   * (`agent-action.ts`).
   *
   * **Not `next: "waiting"`**, which is what this was: a hold makes an
   * account-wide condition into one item's outcome, needs a person where a pause
   * lifts by itself at the reset (0031 §5), and leaves the conductor free to take
   * the next ticket into the same wall — `80` events in `92` seconds is what 0031
   * §3 was written about.
   */
  | { readonly neverStarted: { readonly agent: string; readonly detail: string } }
  | { readonly noJudge: true }

/**
 * A step's own work, as the pass asks for it — for the **four** steps that have
 * any, in seven methods: `end` is the one step with three, because the stream it
 * resolves onto, reading it and appending to it are separate calls for the reason
 * its own rows give.
 *
 * **Six steps are not here, and that is the shape of them rather than an
 * omission.** Each is entirely its plugins' (0061 §3) — a `run:` carrying the
 * install at `prepared` and the checks at `build`, an `agent:` reading the diff
 * at `review`, a `worktree:` cutting the branch at `admit` (`#268`), a `queue:`
 * taking the ticket at `claim` (`#269`) and a `merge:` landing it at `merge`
 * (`#270`) — so the loop has run them by the time any body is called, and a port
 * beside them would be the reimplementation the rule below exists to prevent.
 * **It was three, and the three that left were ports here**: `ports.cut`,
 * `ports.take` and `ports.land` went with the bodies that called them, in the
 * diffs that opened their keys.
 *
 * **`item` and `onStream` are what `take` left behind, and they are not it.**
 * They *ask* rather than *do*: the take is an action's, and these two read the
 * fact it made off the closure whose dep made it (`conduct.ts`). That is why they
 * are synchronous and touch nothing — there is no call to make, the pass's own
 * `claim` step has already made it, and a `Promise` here would suggest otherwise.
 *
 * Stateless by construction: everything one step makes and another needs is held
 * by `bodiesFor`, so a test fakes one method without arranging the rest and a
 * live implementation is a wrapper over code that already exists — which is the
 * `#226` rule T2 is held to as well, *a plugin should wrap, not reimplement*.
 */
export interface PassPorts {
  /**
   * `end` — **the stream `claim`'s `queue:` action left the pass on**, or null
   * where the pass is about no item.
   *
   * Beside `item` rather than read off it, because the two are not the same
   * question: a claim that *may* have committed gives the pass a stream and no
   * ticket, and `end` needs only the first of those. It is also the one of the
   * two that must be answerable when the step's own action did **not** pass —
   * `end` runs on every ending, the body of a step whose plugins refused never
   * runs, and an item this run may be holding is one somebody has to be told
   * about.
   */
  onStream(): string | null
  /**
   * `proposed` — **which of the offered steps the recipe's `judge:` for this
   * direction answers**, or that it declared none.
   *
   * 0061 §3 in one sentence, and the two halves of it are on either side of this
   * call: *`judge:` decides which step is next. The workflow decides which steps
   * it may choose from.* The set is already computed — it is on `Judging.offering`
   * — and the body holds the answer to it, so a judge that answers outside the set
   * is refused by name rather than obeyed (0061 §8).
   *
   * **It is a port and not an action, and since `#274` that is the distinction
   * rather than a stand-in.** `judgePlugin.at` carries `proposed`, so a recipe
   * declares its judges there — and `actionsFromRecipe` still builds none, because
   * a judge produces no verdict and is asked once per arrival rather than once per
   * entry. What a live implementation does with the declared list is
   * `judgeDeclaredAt` (`judge.ts`): take the entry whose `when:` matches, and
   * answer with the built-in it names.
   *
   * **`worktree:` and `merge:` are what a wired row looks like when its plugin
   * produces a verdict**, and they are the contrast rather than siblings: each
   * key opened, each entry left `CALLED_DIRECTLY`, `ports.cut` and `ports.land`
   * went, and each body emptied — in one diff, because 0065 §7's *two things must
   * not both run* is what a half-migrated step costs, and at `merge` it is the
   * branch landed twice (`#268`, `#270`). This row stayed through its own
   * opening because what it answers is not a verdict: nothing in
   * `runActionPipeline` could carry *which step is next*.
   *
   * **Answering costs money for one of the five and must not for the other four.**
   * A live implementation returns `noJudge` for a direction the recipe declared
   * nothing for, and the body falls back to `BUILT_IN_FOR` — so `red` and
   * `verify-failed` are mechanical by default and no agent is paid to reach a
   * conclusion a `switch` reaches. What a recipe *did* declare is asked, whichever
   * direction it is, because a declared judge nothing calls is `#61` again.
   */
  judge(on: Judging): Promise<Judged>
  /**
   * `end` — the work item's own stream.
   *
   * Read rather than handed in, and read at `end` rather than at `claim`, because
   * `resolveEndActions` asks it two questions that are only answerable this late:
   * has this item already resolved `end` **for this outcome**, and what version
   * does the append expect. The step is also the last thing a pass does, so a
   * stream read at the claim would be nine steps stale.
   */
  readEnd(workItemId: string): Promise<readonly Envelope[]>
  /**
   * `end` — **what the step resolved, on the item's own stream, at the version
   * the read gave.**
   *
   * **Batching is the caller's because the *ending* is the caller's** — the pass
   * says which outcome was reached and does not append it (see this file's
   * opening) — so a port here that took a store and a terminal event would be the
   * pass writing an item's ending on the way past. What that leaves the caller is
   * not a free choice: `resolveEndActions`'s own doc is *one transaction, so the
   * outcome and its resolution cannot come apart*, and `end` runs **before** the
   * caller writes `WorkItemLanded` or `WorkItemBlocked`. So a live implementation
   * holds this plan and appends it beside the event that makes its outcome true;
   * one that appended here instead would put the resolution on the stream first,
   * and a dropped connection on the next append leaves it there alone — an
   * `EndActionsResolved{landed}` over a commit that is on the base branch with no
   * landing recorded, which the once-per-outcome rule then makes permanent
   * (`conduct.ts`'s `endPlan`).
   *
   * Where the ending is an append the caller does not own — a release, which
   * `releaseWorkItem` reads and versions for itself — the two cannot be one
   * transaction and the *order* carries the rule instead: the outcome first, the
   * resolution after it. That is what `appendEndActions` is for, it being this
   * module's entry point *for the one caller that cannot batch*.
   *
   * It is handed a plan rather than an outcome, and that is the wiring the ticket
   * asks for rather than a rewrite: what `when:` matches and what has already
   * been resolved are `resolveEndActions`'s, called by the body against the
   * events this port just returned. **The two rules that live in that call are
   * the two a port would get wrong.** It filters by `when:`, which is the whole
   * safety of `refs:` (`#240`) — a `when: landed` that met a block resolves to
   * nothing, and for an item that did not land those refs are the only surviving
   * account of what was tried. And it resolves once per outcome, so an item that
   * was blocked, came back and then landed resolves twice for two different
   * outcomes and never twice for one.
   *
   * Carrying the list out is `tell.ts`'s and is deliberately not here: resolving
   * is a fact and belongs on the log, and doing is I/O that must not be able to
   * undo it.
   */
  recordEnd(workItemId: string, at: number, plan: readonly ToAppend[]): Promise<void>
}

/**
 * **`end` did not get its resolution onto the stream** — and the pass reached
 * its ending anyway.
 *
 * A token rather than a sentence, because a caller acts on it: this is the one
 * way the last step can fail, and what it means is *the outcome stands and the
 * declared effects have not been recorded*. It is a `did-not-finish`, so it buys
 * no fix round and reaches no judge, and `PassResult.stoppedAt` is never `end` —
 * a `close:` that could not be resolved does not turn a landing into a block.
 *
 * Which of the step's three acts threw is on `detail`, for a person; nothing
 * branches on it, because the item's own stream says what was resolved and what
 * was not, and a repair reads that rather than a token.
 */
export const END_UNRESOLVED = 'end-unresolved'

// --------------------------------------------------------- what refused ----

/**
 * **Which of the five directions an arrival at `proposed` is**, or null where it
 * is none of them.
 *
 * `when:` is *the reason the last step gave* (`JudgeWhen`), and the reason is read
 * off **which step arrived** rather than off the ending's `because`: the pipeline
 * knows only that *something the recipe declared refused* and says
 * `action-refused` at every step alike, on purpose — writing `verify-failed` there
 * would put a retired word back on a list that may only shrink (`endingOf`). So
 * the direction is the pass's to name, and it is named where the pass knows it:
 *
 * ```
 * needs-input   a step that stopped and asked, at any of the three that can
 * red           a command said no — `build`'s checks, and `prepared`'s install,
 *               which is the same kind of evidence one step earlier
 * conflict      the merge lane's own word
 * verify-failed   the merge lane's other one: the base moved and the re-verify
 *               went red
 * findings      **not here.** `review` refuses nothing, so it never arrives —
 *               its findings are judged on `proposed`'s own way through
 * ```
 *
 * **Null is the lane's other five reasons** — `dirty-base`, `unpushed-base`,
 * `pending-migration`, `no-commits`, `push-rejected` — and `JudgeWhen`'s own doc
 * is why they are not directions: they stop the lane before the diff is what is
 * in doubt, and *offering a judge a direction nothing can arrive by is the same
 * mistake as offering it a step nothing can run.* A person is next, which is
 * where they go today.
 */
function directionOf(arriving: StepReached): JudgeWhen | null {
  const ending = arriving.ending
  // The one report with anywhere to go, and its own ending since `#296`: this is
  // the last place `NEEDS_INPUT` is written down in the conductor, and it is a
  // name in the recipe's `when:` vocabulary rather than a branch on a string.
  if (ending.ending === 'asked') return NEEDS_INPUT
  if (ending.ending !== 'refused') return null
  if (arriving.step !== 'merge') return 'red'
  if (ending.because === 'conflict') return 'conflict'
  return ending.because === 'verify-failed' ? 'verify-failed' : null
}

/**
 * **The mechanical answers, and the whole of what keeps `proposed` from buying a
 * model to answer a question a `switch` answers.**
 *
 * The rule is `BUILT_IN["same-worktree"]`'s in [`judge.ts`](judge.ts) and the
 * argument is there: `red` and `verify-failed` were seen sixty times between them
 * in fourteen days and not one of them was a judgement. A build that went red
 * says *this line is wrong* by construction; a merge whose re-verify went red on
 * the new base says *the base moved and the result is wrong*; in both the work is
 * still there (0039 §2) and the remedy is to fix it where it stands. **And it
 * falls to a person rather than reaching for `claim`** — when `implement` is not
 * on offer the rounds are spent or no agent has run, and neither is answered by
 * starting over.
 *
 * **It is that function's rule written again rather than that function called,
 * and the reason is the two files' `Destination`s.** `judge.ts`'s has three
 * values and calls a person `human`; the pass's is `Step | "waiting"`, because the
 * loop offers `build` from `merge` and the asking step back to itself, neither of
 * which the three can say. Reconciling them is T5's, which deletes the caller
 * `judge.ts` was written for; until then `pass-steps.test.ts`'s *the mechanical
 * answer is `judge.ts`'s, cell for cell* is what makes a divergence a failing
 * test rather than a surprise.
 *
 * A **total** record over `BuiltInJudge`, so a name added to `BUILT_IN_JUDGES`
 * with no answer here does not compile — the same argument `BUILT_IN` makes.
 *
 * **What it wants and what it settles for, rather than one function of the
 * offer** (`#271`). The two were the same line and the difference was lost in
 * it: a route to `waiting` because the rounds are spent read exactly like a route
 * to `waiting` somebody chose, and `RouteTaken.chose` is what a person is owed
 * there. So the cell says the answer it would give with everything on offer, and
 * the caller is what consults the offer.
 */
const MECHANICALLY: Record<BuiltInJudge, { readonly wants: Destination; readonly orElse: Destination }> = {
  'same-worktree': { wants: 'implement', orElse: 'waiting' },
}

/**
 * Whether the arrival carries something an agent could be held to.
 *
 * `stepsOnOffer`'s first rule and `decideFix`'s before it (0038 §2, 0039 §2): the
 * bar is not *has findings*, it is *carries something the fixer could not have
 * authored* — a `failureScenario` a reviewer wrote before anybody knew what the
 * fix would be, or a command's own output and *run it again; green is green*.
 * **A refusal with neither buys nothing at either extent**, so no judge is asked
 * and no round is offered: asking an agent to address an opinion is the unbounded
 * rewriting 0038 §2 is about.
 *
 * It is `review`'s own measurement that makes this the rule rather than a
 * precaution: **10% of its refusals in fourteen days carried no findings at
 * all** — 24 of them ([012](../../../doc/experiments/012-where-the-turns-go.md)
 * §4). Under the old pass each bought a fix round with nothing in it.
 *
 * The shape is decided by `when` rather than inferred from what arrived, which is
 * `carriesACriterion`'s reason there: a `findings` arrival that came back with
 * none is an absent criterion rather than a command with no output, which is the
 * more useful of the two truths.
 *
 * **It is only asked of an arrival that could be read**, and that is not a detail
 * of the caller (`#279`). *No finding with a failure scenario* is a claim about
 * what the reviewer said, and an answer that did not parse supports no claim about
 * what the reviewer said at all — so `judged` answers `Arrival.unreadable` first
 * and this function never sees one. Moving that test in here would put two
 * different facts behind one `false`, which is the shape the bug had.
 */
function carriesACriterion(on: Arrival): boolean {
  return on.when === 'findings'
    ? on.findings.some((finding) => finding.failureScenario.trim() !== '')
    : on.evidence.trim() !== ''
}

/**
 * **What `review` came back with, where the reviewer said it stops the change** —
 * or null, where nothing did.
 *
 * Read off the visit rather than off an ending, because `review`'s ending says
 * nothing: a reviewer's `failed` verdict is its findings and not a verdict about
 * the step, so `endingOf` reports the step as `passed` and leaves the verdict on
 * `results` where it belongs. That is the whole of *`review` returns findings and
 * judges nothing*, and this is the reader it leaves them for.
 *
 * The last `review` visit and not the first: a pass that took a round has two, and
 * what the way-through `proposed` is judging is the review that has just run. A
 * pass that never reached `review` — a red `build` routed straight here — has no
 * visit at all and is not this function's case: it arrives with a direction.
 *
 * Findings from the passing results are carried too, and deliberately: a reviewer
 * that refused on a blocker and also filed two minors has said three things about
 * one diff, and the agent that is sent back should be told all three.
 */
function reviewRefused(reached: readonly StepReached[]): Omit<Arrival, 'when'> | null {
  const reviewed = reached.findLast((visit) => visit.step === 'review')
  if (reviewed === undefined) return null
  // By verdict rather than by position, which is `evidenceFrom`'s reason: the
  // pipeline stops at the first action that did not pass, so the one that refused
  // is the only result with that verdict and is also the last.
  const refused = reviewed.results.filter((result) => result.verdict === 'failed').at(-1)
  if (refused === undefined) return null
  return {
    findings: reviewed.results.flatMap((result) => result.findings),
    evidence: refused.evidence,
    // **The reviewer's own answer, and the difference `findings: []` cannot
    // carry** (`#279`): the action that refused says whether its answer parsed,
    // and it is read off the same result the evidence is, so *what refused* and
    // *whether it could be read* cannot come from two different reviewers.
    unreadable: refused.unreadable === true,
  }
}

/**
 * What the step that did not pass said, as the judge is shown it — and one thing
 * it is not shown: `unreadable` is answered before any judge is asked (`#279`).
 */
function whatArrived(arriving: StepReached): Omit<Arrival, 'when'> {
  const ending = arriving.ending
  return {
    findings: arriving.results.flatMap((result) => result.findings),
    // Every arriving ending has one — `StepRefused` and `StepAsked` are the only
    // two the loop routes — and it is the words a person reads beside the
    // judge's (0043).
    evidence: 'detail' in ending ? ending.detail : '',
    // `reviewRefused`'s rule at the other door: by verdict, off the action that
    // stopped the pipeline. Only an `agent:` action has an answer to parse, and
    // `agentPlugin.at` puts one at `merge` as well as at `review`, so the routing
    // arrivals are asked the same question the way through is (`#279`).
    unreadable: arriving.results.filter((result) => result.verdict === 'failed').at(-1)?.unreadable === true,
  }
}

/** The reason the arriving step gave, for a sentence about it. */
function reasonOf(arriving: StepReached): string {
  const ending = arriving.ending
  return 'because' in ending ? ending.because : ending.ending
}

/**
 * `waiting`, which `onOffer` offers on every arrival, so this can never be
 * refused.
 *
 * `chose` is the destination somebody asked for and did not get, on the one path
 * that has one — a judge answering outside its offer. Every other caller wanted
 * a person and says nothing, which `take` reads as *it went where it wanted*.
 */
function toAPerson(why: string, chose?: Destination): StepRouted {
  return chose === undefined
    ? { ending: 'routed', to: 'waiting', why }
    : { ending: 'routed', to: 'waiting', why, chose }
}

/** The offered steps, for a sentence a person or a judge reads. */
function listing(offering: readonly Destination[]): string {
  return offering.map((step) => `"${step}"`).join(', ')
}

/**
 * **Why the destination a decision wanted was not one it could have — and only
 * where a number would have bought it** (0064 §7).
 *
 * `offering` used to be one set, so a destination missing from it read the same
 * whichever reason it was missing for, and the words on the card could say only
 * *that is not one of the steps it was offered*. With `Offer`'s two sets the
 * difference is readable, and it is the difference between two next moves: a
 * `rounds` or a `restarts` that is spent is a line in
 * `~/.lingtai/<project>/recipe.yml` somebody can raise, and a step the arrival
 * never reached is not.
 *
 * **Empty for the second, deliberately, and that is `#271`'s rule kept.** The
 * words are what the router quotes back to a person, and naming a step no number
 * would have offered invites the reader to ask for it — `implement` from a
 * `prepared` refusal, where no agent has run and none will until the install
 * works. `RouteTaken.chose` records what was wanted there; the sentence does not.
 */
function becauseSpent(wanted: Destination, offer: Offer): string {
  const ceiling = ceilingFor(wanted, offer)
  return ceiling === null ? '' : ` — it wanted \`${wanted}\`, and \`${ceiling}\` is spent`
}

/**
 * The ten bodies, all of them written.
 *
 * It is still spread over `NOT_BUILT_YET`, and that is not a leftover: the spread
 * is what makes *every* row of `StepBodies` present by construction, so a step
 * added to the vocabulary arrives here as a pass rather than as a type error
 * somebody answers under time pressure.
 *
 * A pass run with these ports walks the whole spine, and every refusal on it
 * reaches `proposed`, where a judge is asked and a person is the floor.
 *
 * One closure conducts one pass at a time: the one fact below is the pass's, and
 * `claim` clears it. The item and its stream are `conduct.ts`'s since `#269`,
 * cleared by the take that makes them — which is the only place a reset can be,
 * now that the work runs *before* the body rather than in it.
 */
export function bodiesFor(ports: PassPorts): StepBodies {
  /**
   * 0031 §3, at whichever of the two steps dispatched the agent.
   *
   * Shared rather than written twice, because the whole value of the case is
   * that `design` and `implement` answer the same wall the same way: a body that
   * spelled it out at one of them is a body that can be changed at one of them.
   */
  const stoodDown = (wall: NeverStarted['neverStarted']): StepNeverRan => ({
    ending: 'never-ran',
    at: wall.agent,
    detail: wall.detail,
  })

  /**
   * **One arrival at `proposed`, answered** — and the only place a round is bought.
   *
   * Five answers in order, and the order is what makes the cheap ones cheap:
   *
   * 0. **nothing was read** — `Arrival.unreadable`, and a person. Asked before
   *    everything else because it is what makes the next answer honest: an answer
   *    nobody could parse arrives as `findings: []`, which is also what a reviewer
   *    with nothing to say writes, and for four days the two were one sentence
   *    (`#279`). It buys no round either;
   * 1. **nothing to hold an agent to** — `carriesACriterion`, and a person. Asked
   *    before any judge, because a refusal with no criterion buys nothing at either
   *    extent and paying a model to discover that is paying twice;
   * 2. **what the recipe declared** for this direction, whichever it is. A judge a
   *    person wrote down and nothing calls is `#61` arriving through the one door
   *    this repository has decided it will not leave open;
   * 3. **the mechanical answer**, where it declared none — `BUILT_IN_FOR`, which is
   *    `same-worktree` for `red` and `verify-failed` and nothing for the other three.
   *    So the sixty refusals a year that are not judgements cost no agent;
   * 4. **a person**, for a direction with neither. `needs-input` is that today:
   *    0061 §3's yaml names `ask-or-assume` and nothing implements it, so a
   *    question reaches somebody rather than a name the schema would accept and no
   *    code answers.
   *
   * And a judge held to the set: **an answer outside `offering` is refused by
   * name**, and the fallback is the one destination that cannot loop. An overruled
   * judge is not one to ask for a second opinion, so the answer is not the next
   * cheapest step — it is a person, with the refusal on the card (`askJudge`).
   */
  /**
   * `StepNeverRan` is in the return type because the judge is an agent since
   * `#277`: the one arrival that dispatches one can meet the account-wide wall
   * every other dispatch can, and 0031 §3's answer to it is not a route.
   */
  const judged = async (arrival: Arrival, offer: Offer, about: string): Promise<StepRouted | StepNeverRan> => {
    /**
     * **Nothing was read, which is not the same as nothing being said** (`#279`).
     *
     * Asked before `carriesACriterion` because it is the reason that function
     * would otherwise be wrong: an answer nobody could parse reaches it as
     * `findings: []`, and the only sentence it has for that is *the reviewer held
     * no opinion worth a round*. `#269`'s third review answered a `major` with a
     * failure scenario and three minors, ended one closing brace short of valid
     * JSON, and parked the pass under that sentence — 61 turns and $8.97, no round
     * bought, and four findings that then existed only in a run log which is
     * deleted when the item lands.
     *
     * **It goes to the same place and for a different reason.** An answer nobody
     * can read is not a criterion either, so it buys no round (0038 §2) and no
     * judge is paid to look at it. What is different is what the card and the log
     * then say, which is the whole of what was lost: *the machinery dropped it* is
     * a thing to re-run, and *the reviewer had nothing* is a thing to merge.
     */
    if (arrival.unreadable) {
      return toAPerson(
        `${about} could not be read at all — the answer did not parse as findings, so nothing ` +
          'structured came out of it however much the reviewer said. That is the machinery ' +
          'losing a judgement rather than a reviewer declining to make one, and it buys no ' +
          'round either: an answer nobody can read is not a criterion (0038 §2). The answer ' +
          "itself is on the step's own `StepFailed`, clipped, and whole in that attempt's " +
          'agent transcript; the pass is held for a person, who can read both',
      )
    }
    if (!carriesACriterion(arrival)) {
      return toAPerson(
        `${about} carries nothing an agent could be held to — ` +
          `${arrival.when === 'findings' ? 'no finding with a failure scenario' : 'no output'} — so ` +
          'no round is worth buying and the pass is held for a person (0038 §2)',
      )
    }
    // The affordable half and never the `Offer` — a judge answers *which of
    // these*, and what the ceilings took away is not its business (`Judging`).
    //
    // `unreadable` is dropped rather than spread: it is the pass's own fact about
    // whether there was an answer, it has already been answered above, and a
    // judge's brief is the three fields and the set and nothing else.
    const { unreadable: _read, ...judging } = arrival
    const on: Judging = { ...judging, offering: offer.affordable }
    const answer = await ports.judge(on)
    // Before the answer is read as one, because a judge that never started did
    // not answer: 0031 §3, at the third depth the same wall is met at.
    if ('neverStarted' in answer) return stoodDown(answer.neverStarted)
    if ('next' in answer) {
      if (!on.offering.includes(answer.next)) {
        return toAPerson(
          `the "${answer.named}" judge answered "${answer.next}" for ${about}, and that is not one ` +
            `of the steps it was offered — ${listing(on.offering)}` +
            // Which half it failed, where that is a number rather than the shape
            // of the arrival: a `restarts` a person can raise reads differently
            // from a `claim` that was never on a mechanical direction's offer.
            `${becauseSpent(answer.next, offer)}. A judge chooses which of the ` +
            "offered steps is next; which steps are on offer is the workflow's, and it counts the " +
            'rounds and restarts spent to work them out (0061 §3). The pass is held for a person, ' +
            'because a judge that answered outside the set is not one to ask a second time',
          // The judge's answer is on the log as what was chosen, and `to` says a
          // person got it instead: an overruled judge and a judge that asked for a
          // person are not the same thing to read back.
          answer.next,
        )
      }
      return { ending: 'routed', to: answer.next, why: answer.why }
    }

    /**
     * **A built-in, and the two ways one is reached are one branch** (`#274`).
     *
     * The recipe declared it for this direction — `judgeDeclaredAt`, through
     * `ports.judge` — or it declared nothing and `BUILT_IN_FOR` is the mechanical
     * default. Those differ in *which directions they answer* and in nothing else:
     * a declared `same-worktree` for a `findings` is the same rule applied to an
     * arrival the default leaves for a person, so the rule is applied once, here,
     * where `chose` and the spent ceiling are recorded (`#271`).
     */
    const declared = 'built' in answer ? answer : null
    const built = declared?.built ?? BUILT_IN_FOR[on.when]
    if (built === null) {
      return toAPerson(
        `no \`judge:\` is declared for a "${on.when}" and there is no built-in that answers one, ` +
          `so ${about} is held for a person rather than the workflow choosing from ` +
          `${listing(on.offering)} on its own (0061 §3)`,
      )
    }
    const mechanical = MECHANICALLY[built]
    const afforded = on.offering.includes(mechanical.wants)
    const next = afforded ? mechanical.wants : mechanical.orElse
    return {
      ending: 'routed',
      to: next,
      // What it would have answered with everything on offer, so that a
      // `waiting` the rounds bought and a `waiting` somebody chose are two
      // different rows on the log (`RouteTaken.chose`).
      //
      // **It is in the sentence only where a ceiling is what refused it**, and
      // `becauseSpent` is that distinction (0064 §7). A step no number would
      // have offered stays out of the words, which is `#271`'s rule —
      // naming one invites the reader to ask for it (`pass-steps.test.ts`'s
      // *offers the judge a person and a restart, and never `implement`*) —
      // while a spent `rounds` is a line somebody can raise and so is said.
      chose: mechanical.wants,
      why:
        // Whose choice it was, in the words a person reads on the card: a line of
        // the recipe, named, or the default that spends nothing where the recipe
        // said nothing. *Mechanical* is the argument for the default and is not
        // said over a declaration — a recipe may declare one for `findings`,
        // which is the direction 0061 §3 calls the judgement.
        (declared === null
          ? `the "${built}" judge on ${about}: a "${on.when}" is mechanical — the work is still ` +
            'there and the remedy is to fix it where it stands'
          : `the "${declared.named}" judge on ${about}: the recipe declares ` +
            `\`judge: ${built}\` for a "${on.when}"`) +
        ` — and of ${listing(on.offering)} it ` +
        `chose \`${next}\`${afforded ? '' : becauseSpent(mechanical.wants, offer)}`,
    }
  }

  return {
    ...NOT_BUILT_YET,

    /**
     * Pick the ticket — **and this is the fifth of the ten whose body is nothing
     * beyond its plugins** (`#269`).
     *
     * It took the item here until `queuePlugin` declared `claim`
     * ([0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md) §2). What
     * takes it now is a `queue:` action — the one a recipe declares there, or the
     * one `conduct.ts`'s `defaultsAt` supplies where a recipe declares nothing —
     * and the loop has run it by the time this is called, so a second take written
     * here would be the reimplementation 0061 §3 exists to prevent. At `claim` it
     * would be worse than a duplicate: a second `claimWorkItem` at an expected
     * version the first one moved is a lost race against this same run.
     *
     * **It cannot refuse, and that is the pipeline's rule rather than this body's**
     * (0058 §2). A refusal buys a fix round, holds the work item and reaches a
     * person, and a `claim` that took nothing is holding nothing — so the answers
     * are *took it* and three ways of *did not*, the three arrive as `failed`
     * verdicts at a step `REFUSING_STEPS` does not carry, and `endingOf` reports
     * each as a `did-not-finish` carrying the action's own `because`. None of them
     * reaches the router either (`ARRIVE_AT_THE_ROUTER`).
     *
     * **It is still where a pass begins, and there is nothing left here to
     * reset.** It cleared the item, its stream and the design before asking,
     * because the three ways a take can decline set no item and it was exactly
     * those that would let `end` resolve onto the item the pass before had
     * landed. The action runs *before* this body, so a reset written here would
     * wipe what the action had just taken: the item and its stream are cleared by
     * the take itself (`conduct.ts`), and the design stopped being a variable to
     * clear in `#265` — it is read off `design`'s own visit, and a pass that has
     * not reached that step has no visit to read.
     */
    claim: async (): Promise<StepPassed> => ({ ending: 'passed' }),

    /**
     * Start work on it — **and this is the fourth of the ten whose body is
     * nothing beyond its plugins** (`#268`).
     *
     * It cut the worktree here until `worktreePlugin` declared `admit`
     * ([0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md) §4). What
     * cuts it now is a `worktree:` action — the one a recipe declares there, or
     * the one `conduct.ts`'s `defaultsAt` supplies where a recipe declares
     * nothing — and the loop has run it by the time this is called, so a second
     * cut written here would be the reimplementation 0061 §3 exists to prevent.
     * That is `prepared`'s row, at the step that makes the tree `prepared`
     * installs into.
     *
     * **The `head` still comes out of this step and now comes out of the
     * action.** `onSha` is *the commit this verdict is about*, `stepsOn()` shows a
     * verdict only where it equals the item's head, and a pass that judged the
     * wrong one has paid for every verdict and can show none of them — so the one
     * thing that knows where the tree was left says so, and `endingOf` carries it
     * onto this step's ending (`ActionResult.head`, `LeftTheTreeAt`).
     *
     * **It still cannot refuse, and that is the pipeline's rule rather than this
     * body's.** A clone that did not finish is not a judgement about the change —
     * nothing has been written yet — so the action answers `did-not-finish` and
     * 0057's class is what reaches the pass: no fix round, and the pass stops
     * rather than buying a round to fix a repository. `admit` is not one of
     * `REFUSING_STEPS`, so a `failed` verdict here could not become a refusal
     * either.
     */
    admit: async (): Promise<StepPassed> => ({ ending: 'passed' }),

    /**
     * The tree is ready to be worked in — **and this is the one of the six whose
     * work is entirely declarable today, so its body is nothing beyond its
     * plugins.**
     *
     * `prepared`'s plugin is `run:` carrying the command (0061 §3), and
     * `prepared` is the one of these six a plugin declares itself at —
     * `runPlugin`'s `at` in `recipe.ts`: this repository's own recipe file declares one command
     * there and nothing else — `pnpm install --frozen-lockfile`, with a `10m`
     * timeout (`.lingtai/config.yaml:113`). The loop has already run that
     * list by the time this is called, and `endingOf` has already read a `failed`
     * verdict at a refusing step as a **refusal** — so there is nothing left for
     * the body to do, and a second install written here would be the
     * reimplementation 0061 §3 exists to prevent.
     *
     * **That is why it is the step that proves the refusal path, and why the
     * proof is a test rather than a line of code.** `prepared` is the first step
     * in the pass that may refuse, a failed install is the cheapest refusal there
     * is — *refuse before money is spent* — and the refusal has to travel: to
     * `proposed`, carrying its reason, answered there, with the person shown the
     * install that failed rather than the router that sent it to them. Every one
     * of those joins is the skeleton's, and `pass-steps.test.ts`'s *a failed
     * install refuses, and the refusal reports like any other* is what says they
     * carry something real rather than a fixture.
     *
     * The day something at `prepared` is not declarable — a check the recipe has
     * no key for — this body gets a port and an ending, and the type already
     * permits the refusal: `prepared` is one of `REFUSING_STEPS`.
     */
    prepared: async (): Promise<StepPassed> => ({ ending: 'passed' }),

    /**
     * A document, before any code — **or nothing, which is an answer** (0058 §3)
     * — **and this is the sixth of the ten whose body is nothing beyond its
     * plugins** (`#265`).
     *
     * It called `ports.draft` here until `agentPlugin` declared `design`
     * ([0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md) §4). What
     * writes one now is an `agent:` action — `createDraftAction`, which the
     * recipe declares at this step — and the loop has run it by the time this is
     * called, so a second dispatch written here would be the reimplementation
     * 0061 §3 exists to prevent and would be two agents on one brief.
     *
     * **The default here is nothing, and that is this step's whole difference
     * from the other four migrations.** `conduct.ts`'s `defaultsAt` has no row
     * for `design`: the port it replaced answered `{ document: "" }` and
     * dispatched nothing, so *behaves exactly as today* means an unconfigured
     * `design` runs no action and passes, and `implement` is briefed with `""`
     * and works from the issue. A drafting agent registered as the default would
     * buy one on every pass of every project that never asked for one, which is
     * 0065 §7's footgun rather than its decision.
     *
     * **An empty document is still `passed` and still not a skip**, and it is the
     * action that says so: the step ran, it decided this change needs no design,
     * and `WroteTheDesign` carries `""` as a document rather than as an absence.
     * A conditional step would have put that judgement in the workflow, where
     * nothing knows enough to make it.
     *
     * It cannot refuse — a design is not a judgement about a diff, there being no
     * diff yet — and the three ways it does not pass are the action's now, which
     * is what 0065 §7's *one diff* buys: a runtime that never started stands the
     * conductor down on the same wall `implement` meets (`never-ran`, released,
     * 0031 §3), one that started and left no receipt stands the pass down (0057
     * §2), and `endingOf` reports each in the step's own terms without this body
     * being reached at all.
     */
    design: async (): Promise<StepPassed> => ({ ending: 'passed' }),

    /**
     * One agent, in that worktree — **and this is the last of the ten whose body
     * had work left in it** (`#266`, 0065 §1).
     *
     * It called `ports.dispatch` here until `agentPlugin` declared `implement`
     * ([0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md) §1). What
     * writes the change now is an `agent:` action — `createWorkAction`, wrapping
     * the dispatch `conduct.ts` hands it — and the loop has run it by the time
     * this is called, so a dispatch written here would be **two agents on one
     * brief**: the declared one pays for the work, the pipeline passes, and this
     * would pay for a second on the same ticket, spending a round bought for a
     * fix. That is why the key and the empty body are one diff and not two.
     *
     * **The `head` still comes out of this step and now comes out of the
     * action**, which is the whole of what must survive the move: `onSha` is *the
     * commit this verdict is about*, everything after `implement` is judged
     * against it, and a round judged against the wrong head is a round spent on a
     * diff nobody wrote. `admit`'s row says the same sentence one step earlier,
     * and `runStep`'s `leftTheTreeAt` is the field that carries both.
     *
     * **The default is the old behaviour and not nothing** — unlike `design`,
     * whose port dispatched nothing. `conduct.ts`'s `defaultsAt` has a row here
     * that reads `runtime.agent`, so a recipe that declares nothing at
     * `implement` buys exactly the agent it bought before, on the same brief.
     *
     * The four ways it goes are the action's now: a commit, a **question** that
     * buys a decision at `proposed` (0058 §3c), a run that **left no receipt**
     * and stands the pass down (0057 §2), and one that **never started** and
     * stands the *conductor* down, because what it met is about the account
     * rather than the diff (0031 §3). `endingOf` reports each in the step's own
     * terms without this body being reached at all.
     *
     * It cannot refuse, and that is 0058 §3b's rectangle: arriving at the router
     * and refusing are different things, and only one of them is charged for.
     */
    implement: async (): Promise<StepPassed> => ({ ending: 'passed' }),

    /**
     * **Its own step, and a red one skips `review`.**
     *
     * The skip is the loop's rather than this body's: `build` is one of
     * `REFUSING_STEPS`, so `endingOf` reads a `failed` verdict here as a
     * **refusal**, and the loop takes a refusal to `proposed`. `review` is never
     * reached, and no agent is paid to read a diff that does not compile.
     *
     * **It goes before `review` and not because it is quick** — median 313s
     * against review's 149s. It goes first because it spends no tokens where a
     * review spends an agent.
     *
     * Its work is entirely its plugins', which is `prepared`'s argument again: the
     * build is `run:` carrying the commands (0061 §3), the loop has run them by
     * the time this is called, and a second build written here would be the
     * reimplementation 0061 §3 exists to prevent.
     *
     * **`runPlugin` declares itself at `build` since 2026-09-27** (`a417908`), and
     * this body did not have to change for it — which was the claim. A step whose
     * work is entirely its plugins' needs an `at` key and nothing else: `runPass`
     * resolves `actionsAt(step, actions)` at all ten and runs them through
     * `runActionPipeline` before any body, and returns the pipeline's ending
     * without reaching the body when it did not pass.
     */
    build: async (): Promise<StepPassed> => ({ ending: 'passed' }),

    /**
     * Reads the diff, returns findings — **and judges nothing** (0058 §3).
     *
     * The findings are its plugins': an `agent:` reviewer returns them with a
     * severity, the pipeline carries them on `StepReached.results`, and
     * `reviewRefused` is what reads them one step later. So the body is nothing
     * beyond them, exactly as `build`'s and `prepared`'s are.
     *
     * **Where *no verdict of its own* is enforced is `endingOf`**, and it has to
     * be: a reviewer that finds a blocker returns `failed`, and a body is never
     * called after its own plugins did not pass. `review` is not one of
     * `REFUSING_STEPS`, so that verdict is the reviewer's findings rather than a
     * verdict about the step, the step passes carrying them, and the judgement is
     * made at `proposed` — where there is a round to buy with it.
     *
     * **Why it stopped judging**: 10% of its refusals in fourteen days carried no
     * findings at all — 24 of them
     * ([012](../../../doc/experiments/012-where-the-turns-go.md) §4). A step that
     * refuses without saying what is wrong is a step whose judgement is worth
     * nothing to the round it buys, and `carriesACriterion` is where that is now
     * answered instead.
     */
    review: async (): Promise<StepPassed> => ({ ending: 'passed' }),

    /**
     * **The only step that routes** (0058 §3), and the one that spends what a
     * round costs.
     *
     * Its two jobs are told apart by `arriving`, which is the whole of what
     * `StepWork` carries it for:
     *
     * - **`null` — the way through.** `build` and `review` have passed, and what is
     *   left to judge is what the reviewer said: `findings`, the direction 0061 §3
     *   measured at 231 refusals and calls *the one judgement worth an agent*. A
     *   reviewer that refused nothing lets the change through to `merge`, which is
     *   a recorded decision saying so rather than an absence (0058 §3b);
     * - **a visit — a routing arrival.** The step that did not pass, carrying its
     *   reason intact (0058 §3c), and `directionOf` is which of the five that is.
     *
     * **Every arrival is answered, and five things can answer it, in this order.**
     * An answer nobody could read is a person, before anything else is asked
     * (`#279`); a refusal carrying nothing an agent could be held to is a person,
     * whatever is declared; a direction no judge is written for is a person; what
     * the recipe declared for the direction is asked; and where it declared
     * nothing, the mechanical answer is given without paying for one. **A judge that answers
     * outside `offering` is refused by name and the pass is held for a person**,
     * which is 0061 §8 again and the asymmetry `judge.ts` opens with — *a
     * misconfiguration that fails is cheap; one that loops is not.*
     *
     * So the floor `#253` set holds: **an arrival no judge can answer still reaches
     * a person**, as it did when no judge existed at all.
     */
    // `StepNeverRan` since `#277`: the judge this step may dispatch meets the
    // same account-wide wall every other agent does, and 0031 §3's answer is
    // the conductor's rather than a route. `goesToTheRouter` already refuses
    // it, so it ends the pass here and nothing loops.
    proposed: async ({ arriving, offering, reached }): Promise<StepPassed | StepRouted | StepNeverRan> => {
      if (arriving === null) {
        const said = reviewRefused(reached)
        // Nothing the reviewer said stops this. The findings at or below the bar
        // are on `review`'s own visit and are the `backlog:` plugin's business,
        // not a reason to hold a change back.
        if (said === null) return { ending: 'passed' }
        return await judged({ when: 'findings', ...said }, offering, "`review`'s findings")
      }
      const when = directionOf(arriving)
      if (when === null) {
        const arrived = whatArrived(arriving)
        /**
         * **An unreadable answer here is the machinery's, and this branch is how
         * it would have been missed** (`#279`).
         *
         * `judged` answers `unreadable` first, and this path does not reach
         * `judged`: an `agent:` at `merge` — legal, `agentPlugin.at` carries the
         * step — whose answer does not parse gives `verdict: "failed"` with no
         * `because`, so `endingOf` reports `action-refused`, `directionOf` has no
         * direction for that, and the sentence below would have called a dropped
         * judgement *not a direction any `judge:` answers*. True, and about the
         * wrong thing: the lane's re-verify said something and nobody could read
         * it. Same destination, and the sentence is what was lost.
         */
        if (arrived.unreadable) {
          return toAPerson(
            `the \`${arriving.step}\` step's answer could not be read at all — it did not parse ` +
              'as findings, so nothing structured came out of it however much the action said. ' +
              'That is the machinery losing a judgement rather than a step declining to make ' +
              "one, and it buys no round either (0038 §2). The answer is on that step's own " +
              "`StepFailed`, clipped, and whole in the attempt's agent transcript; the pass is " +
              'held for a person, who can read both',
          )
        }
        return toAPerson(
          `the \`${arriving.step}\` step reported "${reasonOf(arriving)}", which is not a ` +
            'direction any `judge:` answers — it stops the lane before the diff is what is in ' +
            'doubt — so the pass is held for a person rather than buying a round for it',
        )
      }
      return await judged(
        { when, ...whatArrived(arriving) },
        offering,
        `the \`${arriving.step}\` step's ${arriving.ending.ending}`,
      )
    },

    /**
     * **Reports a `reason` and a `detail`, decides nothing — and this is the
     * fifth of the ten whose body is nothing beyond its plugins** (`#270`).
     *
     * It called `ports.land` here until `mergePlugin` declared `merge`
     * ([0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md) §2). What
     * lands now is a `merge:` action — the one a recipe declares there, or the one
     * `conduct.ts`'s `defaultsAt` supplies where a recipe declares nothing — and
     * the loop has run it by the time this is called, so a second `integrate`
     * written here would be the branch landed twice that 0065 §7 is about.
     *
     * **The reason still travels, and now it travels on the action.** Over the
     * whole log the lane has refused 32 times, **26 `verify-failed` and 6
     * `conflict`**: the common failure is that somebody else's work landed and the
     * diff stopped being true, which is a fact about the world rather than a
     * verdict about the change. So `createMergeAction` puts the lane's own word on
     * `ActionResult.because`, `endingOf` carries it onto this step's ending rather
     * than writing `action-refused` over it (`becauseFrom`), and `directionOf`
     * reads it one step later — `proposed` is where a `conflict` is weighed and
     * where a `verify-failed` buys the mechanical round.
     *
     * **It is one of `REFUSING_STEPS` all the same**, and the refusal is what pays
     * for the edge back: `onOffer` offers `build` from here, so an agent that
     * resolves a conflict writes code *after* the review passed and goes through
     * both again. That is what buys *every path into `end` has been through
     * `build` and `review`*.
     *
     * It reports no `head`. A merge commit is on the base branch and the worktree
     * did not move, and `LeftTheTreeAt` is a fact about the tree.
     */
    merge: async (): Promise<StepPassed> => ({ ending: 'passed' }),

    /**
     * Runs on every ending and cannot refuse — **and the effects never decide
     * whether the ending happened.**
     *
     * That rule is `end-step.ts`'s reason for existing and it survives the move.
     * The outcome is the loop's: `outcomeOf` computes it from where the pass came
     * to rest, before this is called. This body reads it and resolves the
     * declared list against it; it does not compute it, it cannot change it, and
     * `PassResult.stoppedAt` is never `end` — so a `close:` that could not be
     * resolved after a merge landed does not turn a landing into a block.
     *
     * **`resolveEndActions` is called rather than reimplemented**, which is the
     * wiring this ticket asks for. What it knows — which cells `when:` matches,
     * and that a point resolves once per outcome — is named on
     * `PassPorts.recordEnd`, where the seam is.
     *
     * **A pass with no stream behind it resolves nothing.** `EndActionsResolved`
     * lives on the work item's stream, and a `claim` that took no item leaves
     * none to append to; a `claim` that may have taken one leaves a stream and no
     * ticket, and that is enough for this step (`TakeAnswer`'s `mayHold`, and
     * `PassPorts.onStream` is why it is asked rather than remembered). What the
     * body must not do either way is throw, because the ending it is running for
     * has already happened.
     *
     * An empty plan is not an append. Both of the ways it can be empty are
     * already decisions the log holds: nothing declared, which `StepsResolved`
     * records, and this outcome already resolved, which the item's own
     * `EndActionsResolved` records.
     */
    end: async ({ actions, outcome }): Promise<StepPassed | StepDidNotFinish> => {
      const workItemId = ports.onStream()
      if (workItemId === null) return { ending: 'passed' }
      // Which of the step's three acts did not finish, for the person reading
      // `detail`. The plan is empty until `resolveEndActions` has answered, so a
      // `read` that threw cannot be mistaken for a recorded nothing.
      let act = 'read'
      try {
        const events = await ports.readEnd(workItemId)
        act = 'resolve'
        const plan = resolveEndActions(events, actions, outcome)
        if (plan.length === 0) return { ending: 'passed' }
        act = 'record'
        await ports.recordEnd(workItemId, events.length, plan)
        return { ending: 'passed' }
      } catch (error) {
        return {
          ending: 'did-not-finish',
          because: END_UNRESOLVED,
          // No action asked it: the step's own work did — the same reason
          // `asking` and `noReceipt` above are `null` here.
          at: null,
          detail:
            `${workItemId} reached \`${outcome}\` and its \`end\` effects were not resolved — ` +
            `\`${act}\` threw: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
