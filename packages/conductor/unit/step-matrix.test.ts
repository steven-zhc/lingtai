/**
 * **A hundred and twenty cells, and each one runs or refuses by name.** There
 * is no third answer, and for a year ten of them gave it: an action at `admit`, or
 * anything but an effect at `end`, was accepted by the schema, resolved into
 * `StepsResolved`, printed by `lingtai add`, drawn on the board, and never
 * called (`#61`). **`admit` is a step that runs one kind since `#268`** —
 * `worktreePlugin` declares it, so a `worktree:` there is resolved *and* called,
 * and the other eleven kinds at that step refuse in `admit`'s own terms.
 *
 * **There is no matrix any more, and the cells are still there** (`#261`).
 * `KINDS_AT` was a hand-written table of which of the twelve plugins each of
 * the ten steps runs; since
 * [0064](../../../doc/decisions/0064-a-plugin-declares-the-steps-it-implements.md)
 * §4 a plugin declares the steps it serves and that declaration is what makes
 * it legal there. The cells are the product of two closed sets rather than a
 * constant, this file walks them exactly as it did, and what it asserts is
 * unchanged: a cell runs, or the recipe does not resolve and the refusal names
 * the action, its kind, the step and why. **The guard `#61` bought survives;
 * only its source moved.**
 *
 * What went with the table is the copy of it in `doc/reference.md` and the
 * case here that compared the two — a document cannot drift from a constant
 * that does not exist, and a plugin is one file to add rather than three
 * places to keep in step.
 *
 * **It was thirty until the vocabulary went from five names to ten** (0058 §3),
 * sixty until the closed set grew `worktree:` and `merge:` (`#235`), eighty
 * until it grew `queue:` and `assignee:` (`#236`), a hundred until it grew
 * `judge:` (`#238`) and a hundred and twenty until it grew `backlog:` (`#237`)
 * — a hundred and ten again when 0063 §3 made `assignee` a field of
 * `queue:` rather than a plugin beside it (`#244`), and a hundred and twenty
 * once more with `refs:` (`#240`). **A column that goes is
 * the same event as a column that arrives**: the cells it had have to stop
 * existing rather than stop being walked.
 * Eighteen of the hundred and twenty cells run and **a hundred and two
 * refuse**; **none of those is a step no plugin implements any more** — `#266`
 * gave `implement` an `agent:` and emptied that class — and ten are the one
 * plugin that serves no step. The two classes no longer overlap, because there
 * is nothing left in the first for a `backlog:` cell to be in twice.
 *
 * **The ledger, and each number is the count *before* the opening beside it.**
 * Twelve until 2026-09-27, when `runPlugin` took `build` and `agentPlugin` took
 * `review` (`a417908`) — two cells in one commit, so fourteen; fourteen until
 * `worktreePlugin` took `admit` (`#268`); fifteen until `judgePlugin` took
 * `proposed` (`#274`); sixteen until `mergePlugin` took `merge` (`#270`) — **the
 * first opening that left fewer cells running than it found**, because it gave
 * `merge` a lane and took `watch:` and `human:` away from it, net minus one, so
 * fifteen. Fifteen until `queuePlugin` took `claim` (`#269`) — **the entry this
 * chain was missing, which is how it read *fifteen now* under an assertion of
 * sixteen for four days** — and sixteen until `agentPlugin` took `design`
 * (`#265`), the first of the two *new* keys 0065 §4 asks for and the only
 * opening whose step keeps its old behaviour, because its default is nothing;
 * and seventeen until `agentPlugin` also took `implement` (`#266`) — **the
 * opening that empties the *no plugin implements this step* class**, since it
 * was the last step in it: **eighteen now**. Every other entry moves a cell from refusing to
 * running and can take a whole step or a whole plugin out of a column that
 * refused everything. **The counts are asserted** — *the arithmetic of the two
 * closed sets is what the paragraph above says* is a case a few rows down, so a
 * key opened or closed anywhere goes red here rather than leaving a stale numeral
 * in a docblock. It is the one thing in this file that used to be able to go
 * quietly stale, and it did, twice.
 *
 * **`refs:` is the first column that is not a name for code that already
 * ran**, and it arrives serving a step rather than serving none: the other five new
 * plugins were 0061 §3's names for the pass's own calls, and four of those five
 * have since been wired to the step whose code they named — `worktree:` (`#268`),
 * `judge:` (`#274`), `merge:` (`#270`) and `queue:` (`#269`) — leaving `backlog:`
 * alone in refusing everywhere, while this one runs at `end` on the day it lands. The rule is the same either
 * way — a plugin says where it runs — and it is worth reading here
 * because every precedent in this file is the other case.
 *
 * That is the property this file is here to hold, and it holds it down both
 * axes: **naming a thing is not wiring it.** The steps 0058 named and the
 * pipeline has not yet constructed must refuse every kind until it has, and the
 * plugins that are names for code the conductor calls itself must be refused at
 * every step until the recipe is what tells it to. A `backlog:` block a recipe
 * could write and nothing would run is `#61` with a new spelling — and a
 * `design:` one was the other example until `#265`, which opened the key and
 * emptied the body together. **A `worktree:` one was the example here for four columns'
 * worth of tickets and is now the counter-example**: `#268` opened the key and
 * emptied `admit`'s body in one diff, which is the shape a wiring has to take —
 * both halves, or the step runs its plugins *and* its own copy of the work.
 *
 * **And the other direction is not an exception to it** (`#274`). `judge:` is
 * accepted at `proposed` now, so the rule it is held to is the one every accepted
 * cell is held to — *something reads it* — and the reader is not the pipeline:
 * `judgeDeclaredAt` is, as `resolveEndActions` is `end`'s. `runsAt` below asks
 * each cell's own consumer for exactly that reason.
 *
 * This walks every step × kind pair and asserts one of exactly two things:
 *
 * - **runs** — the thing that consumes that point builds a gate for it, with
 *   the dependencies that point's own call site supplies; or
 * - **refuses** — the recipe does not resolve, and the refusal names the
 *   action, its kind, the point and why.
 *
 * **And since `#306` the *why* is asserted to be about the point it was asked
 * about.** For a year this file promised that and checked only that a refusal
 * happened: the action, the kind and the step are read out of the opening clause,
 * which is built from the step that was asked about and so cannot be wrong about
 * it, while the reason behind it went unread. Five times in two days a step gained
 * a plugin, `whyThatPair` gained no branch for it, and every other kind at that
 * step was refused with **`prepared`'s** paragraph — green here each time, and
 * caught by the cold reviewer each time. The cell now asserts that **no other step
 * answers it with the same sentence**, which is what *about this step* means
 * mechanically; `ANSWERED_BY_THE_KIND` is the short list of refusals that are
 * about a plugin instead, and it is held to a property of its own rather than
 * trusted.
 */
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type Finding, SEVERITIES, STEPS, type Severity, type Step } from "@lingtai/domain";
import {
  type ActionKind,
  type StepAction,
  StepMap,
  PLUGINS,
  servesStep,
  whyNoKindAt,
} from "@lingtai/recipe";
import {
  type AgentActionDeps,
  ActionUnavailableError,
  type ActionDeps,
  actionsFromRecipe,
  verdictFor,
} from "@lingtai/actions";
import { resolveEndActions } from "../src/end-step.ts";
import { BUILT_IN_FOR, judgeDeclaredAt } from "../src/judge.ts";
import { NOT_BUILT_YET } from "../src/pass.ts";
import { decideBacklog } from "../src/backlog.ts";

/**
 * The closed set's kinds, one action each, exactly as a resolved recipe would
 * hold them — **and two of them are actions no resolved recipe can hold**,
 * because `queue:` and
 * `backlog:` are refused at all ten steps. That is the point of writing them: the cell has to be
 * *refused by name* rather than *unrepresentable*, and an action the schema
 * never sees is a column this file would walk with nothing in it.
 *
 * **`judge:` is legal at exactly one of the ten since `#274`**, and its action is
 * written with the name the schema takes: `same-worktree`, the one built-in. It
 * said `claude-code` while every cell was refused, which cost nothing then and
 * would now walk this column with a value `JudgeName` refuses — the cell would
 * read as *refused by name* and never test the one that runs.
 */
const ACTION: Record<ActionKind, StepAction> = {
  run: { name: "build", run: "pnpm verify", timeout: "15m", env: [] },
  agent: { name: "review", agent: "claude-code", prompt: "read the diff" },
  watch: { name: "tamper", watch: ["**/steps.yml"], then: "fail" },
  human: { name: "approve", human: "merge this?" },
  close: { name: "close the ticket", close: true, when: "landed" },
  labels: { name: "label it", labels: ["shipped"], when: "any" },
  refs: { name: "delete the arms", refs: true, branch: false, when: "landed" },
  worktree: { name: "cut the branch", worktree: { base: "main", submodules: false } },
  merge: { name: "land the branch", merge: { strategy: "merge-commit" } },
  queue: {
    name: "what this machine works on",
    queue: {
      kinds: ["bug", "feature"],
      exclude: ["agent:hold"],
      backoff: "1h",
      // `assignee:` was a twelfth column until 0063 §3 made it this plugin's
      // fourth field (`#244`), so the cell it had is gone and what it decides
      // is walked here instead.
      assignee: { login: "steven-zhc", take: "mine" },
    },
  },
  judge: { name: "the lines or the approach", judge: "same-worktree", when: "findings" },
  backlog: { name: "the minors", backlog: "minor" },
};

/** One finding of a given severity, with a scenario, so only the severity varies. */
function finding(severity: Severity): Finding {
  return {
    file: "src/a.ts",
    line: 1,
    claim: "the name is wrong",
    failureScenario: "a reader looks for it under the other name and does not find it",
    severity,
  };
}
/**
 * **The columns are the closed set's, in the closed set's order** (`#228`).
 *
 * Read off `PLUGINS` rather than off the object above, so the matrix, this
 * file's every case and `doc/reference.md`'s table all widen together the day a
 * seventh plugin lands — 0059 §5's *the document cannot drift from the code
 * without a red test*, now that the code has one list of plugins to drift from.
 * A plugin added with no row here has no `ACTION` either, and the case below
 * says so by name rather than the matrix quietly walking six of seven.
 */
const KINDS = PLUGINS.map((plugin) => plugin.key);

/**
 * What a step hands `actionsFromRecipe`, which is the other half of what it can
 * run — **and since `#256` it is one object at all ten steps.**
 *
 * `conduct.ts`'s `actionsAt` is a single `(step, actions)` seam, which is the
 * shape `PassOptions.actionsAt` asks for, so there is no per-step deps table in
 * the conductor for this to be a copy of any more. What keeps a step from
 * building a kind it must not is `whyNoKindAt`, asked by `actionsFromRecipe`
 * itself and by the schema — the two doors the matrix below is about. `DEPS`
 * survives only for the three steps the by-name refusal cases enumerate.
 */
const EVERY_DEP: ActionDeps = {
  env: () => ({}),
  // Built, never run — building is the whole of what this file asserts.
  agent: {} as unknown as AgentActionDeps,
  watch: { changedFiles: async () => [] },
  worktree: { cut: async () => ({ head: "0".repeat(40), where: "/nowhere" }) },
  merge: { land: async () => ({ merged: "0".repeat(40) }) },
  queue: { take: async () => ({ taken: { workItemId: "wi-nowhere-1", kind: "bug" } }) },
  work: { work: async () => ({ committed: "0".repeat(40) }) },
};
const DEPS: Record<"prepared" | "proposed" | "merge", ActionDeps> = {
  prepared: { env: () => ({}) },
  proposed: EVERY_DEP,
  merge: EVERY_DEP,
};

/**
 * Does the code that consumes this step actually dispatch this action?
 *
 * **There is no longer a set of steps that have a call site**, and that is the
 * whole of what `#256` changed here. `HAS_A_CALL_SITE` was `["prepared",
 * "proposed", "merge", "end"]` — the four points the old engine built a pipeline
 * at — and every cell at the other six was false because nothing asked. The pass
 * asks at all ten: `runPass` calls `options.actionsAt(step, actions)` for every
 * step whose plugins are verdicts, and `end` by its resolver.
 *
 * So the class of drift that list guarded — *the matrix goes on refusing a step
 * the code has started running*, `#61` inverted — is closed by construction
 * rather than by a list somebody keeps, and `whyNoKindAt` is the single answer
 * at both doors. What is left to check is that there is still exactly **one**
 * call site, which is *the conductor builds every step's list through one seam*
 * below.
 */
function runsAt(step: Step, kind: ActionKind): boolean {
  // A throw is a refusal and not a run, which is the answer this asks for; the
  // refusals themselves are asserted by name below.
  try {
    if (step === "end") {
      const resolved = resolveEndActions([], [ACTION[kind]], "landed");
      const named = (resolved[0]?.data as { actions: { name: string }[] } | undefined)?.actions ?? [];
      return named.some((a) => a.name === ACTION[kind].name);
    }
    /**
     * **`judge:`'s consumer is the router, and asking the pipeline for it would
     * read as a silent drop** (`#274`).
     *
     * `actionsFromRecipe` builds no action for a judge — it produces no verdict
     * and is asked once per arrival rather than once per entry — so the question
     * *does anything read this cell* has to be put to `judgeDeclaredAt`, exactly
     * as `end`'s is put to `resolveEndActions` above. Asked at every step, and
     * false at nine of them because the line below throws there first: the cell
     * has to be refused *and* unread away from `proposed`.
     */
    if (kind === "judge") {
      actionsFromRecipe(step, [ACTION[kind]], EVERY_DEP);
      const read = judgeDeclaredAt([ACTION[kind] as StepAction], "findings");
      return read?.named === ACTION[kind].name;
    }
    return actionsFromRecipe(step, [ACTION[kind]], EVERY_DEP).some(
      (step) => step.name === ACTION[kind].name,
    );
  } catch {
    return false;
  }
}

/**
 * Does a recipe naming this action at this point resolve?
 *
 * **The probe carries the lane wherever the step lands** (`#270`). Two rules in
 * `actionsAt` are about an action's *neighbours* rather than about the pair this
 * matrix asks about: nothing may be written after the lane, and a step that
 * lands may not be written without one. A lone `run:` at `merge` trips the
 * second and would read here as *the `merge` step refuses a `run:`*, which is
 * false — a check before the lane is exactly where a check at `merge` goes. So
 * the probe is put in the smallest list that satisfies the list-level rules, and
 * what comes back is the cell's own answer.
 */
function accepted(step: Step, kind: ActionKind): string | null {
  const lands = whyNoKindAt(step, "merge") === null;
  const written =
    !lands || kind === "merge" ? [ACTION[kind]] : [ACTION[kind], ACTION.merge];
  const parsed = StepMap.safeParse({ [step]: written });
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "refused with no message");
}

/**
 * The refusal with its opening clause taken off, which is where the *reason*
 * starts.
 *
 * The opening names the action, the kind and the step — `kindRefusedAt`'s half,
 * plus *`agent:` does not implement `build` — it serves …* — and none of it can
 * be wrong about the step, because all of it is built from the step that was
 * asked about. So a case that reads the opening learns nothing about whether
 * the reason behind it is the right one, which is the whole of `#306`: the five
 * openings below each shipped a true opening over another step's reason.
 *
 * Split at the first `": "`, as the `judge:` case has done since `#274`. No
 * kind's name, no plugin's serves list and no step's name contains one — the
 * colons in the message before this point are all inside backticks, `` `agent:`
 * ``.
 */
function reasonAt(step: Step, kind: ActionKind): string | null {
  const why = whyNoKindAt(step, kind);
  return why === null ? null : why.slice(why.indexOf(": ") + 2);
}

/**
 * **The kinds whose refusal is answered before `whyThatPair` reaches the step
 * branches, and which therefore say nothing about the step they were asked
 * about** (`#306`).
 *
 * This is the exemption the cell below needs, and it is a short list of real
 * rules rather than a loophole:
 *
 * - `judge:`, `merge:`, `worktree:` and `queue:` — **their output is one step's
 *   own work**, so the reason is about the *plugin* and is the same sentence at
 *   every step that refuses it (`ONLY_PROPOSED_ROUTES`, `ONLY_THE_LANE_LANDS`,
 *   `ONLY_ADMIT_CUTS`, `ONLY_CLAIM_TAKES`). No step branch could say it: *what
 *   `build` asks of an action* is not why a cut belongs at `admit`.
 * - `close:`, `labels:` and `refs:` — the effect-only rule, which is about
 *   **what a kind is**: an effect is not a verdict, and only `end` carries
 *   effects out.
 * - `backlog:` — refused at all ten because nothing reads it, which
 *   `whyNoKindAt` answers before `whyThatPair` is reached at all.
 *
 * **The exemption is not the loophole the fall-through went through**, and the
 * case *answers a kind-wide refusal with one sentence everywhere* below is what
 * keeps that true: a kind listed here has to give the **same** reason at every
 * step it is refused at, so a kind added to this list to quiet a red cell goes
 * red in that case instead. And a kind taken *off* the list by a future opening
 * is checked by the cell again, which is the direction that costs nothing.
 *
 * `ONLY_PROPOSED_ASKS_A_PERSON` needs no entry: a hold or a glob at `merge` is
 * refused about the pair, but the sentence it is refused with names `merge` and
 * is given at no other step, so it passes the cell's own assertion.
 */
const ANSWERED_BY_THE_KIND: readonly ActionKind[] = [
  "judge",
  "merge",
  "worktree",
  "queue",
  "close",
  "labels",
  "refs",
  "backlog",
];

/**
 * **The three paragraphs `prepared` owns**, read off `prepared` rather than
 * copied out of `recipe.ts`.
 *
 * They are `whyThatPair`'s fall-through, so they are what a step with no branch
 * of its own is answered with — *nothing has been committed at `prepared`* and
 * *a hold at `prepared` cannot be answered*. Five openings in two days printed
 * one of them at a step the operator never wrote.
 *
 * The cell below asserts no other step gives the same reason as `prepared`, and
 * it needs this list as well, for the kinds `prepared` **accepts**: a `run:` at a
 * newly opened step would fall through to the hold paragraph, and since
 * `prepared` runs a `run:` there would be no `prepared` cell to collide with.
 */
const PREPARED_OWNS = (["agent", "watch", "human"] as const).map((kind) => reasonAt("prepared", kind));

describe("every step × kind cell runs or refuses", () => {
  const cells = STEPS.flatMap((step) => KINDS.map((kind) => [step, kind] as const));

  /**
   * **The size of the matrix is the closed set's, and it is read rather than
   * remembered.** A plugin added to `PLUGINS` with no action above walks in as
   * a column with nothing to try, and every cell of it would pass by being
   * `undefined` — which is the silent half `#61` is about, arriving through the
   * test rather than through the schema.
   */
  it("has one column per plugin and one action for each", () => {
    expect(Object.keys(ACTION)).toEqual([...KINDS]);
    expect(cells).toHaveLength(STEPS.length * PLUGINS.length);
    for (const kind of KINDS) {
      expect(ACTION[kind], `no action for the "${kind}" plugin`).toBeDefined();
    }
  });

  it.each(cells)("%s × %s", (step, kind) => {
    const refusal = accepted(step, kind);
    if (refusal === null) {
      // Accepted, so it must run. This is the half `#58` and `#61` are about:
      // a recipe the log says was resolved, and a point that never called it.
      expect(whyNoKindAt(step, kind)).toBeNull();
      expect(runsAt(step, kind), `${step} accepts a ${kind} action and nothing runs it`).toBe(
        true,
      );
      return;
    }
    // Refused, so it must refuse by name — the action, its kind, the point, and
    // a reason about the point rather than about a missing dependency.
    expect(refusal).toContain(`"${ACTION[kind].name}"`);
    expect(refusal).toContain(`"${kind}"`);
    expect(refusal).toContain(`"${step}"`);
    expect(whyNoKindAt(step, kind)).not.toBeNull();
    expect(runsAt(step, kind)).toBe(false);
    /**
     * **And the reason is about the step it was asked about** (`#306`).
     *
     * The three assertions above are satisfied by the opening clause alone —
     * *the "review" action is a "agent" at the "build" step, and `agent:` does
     * not implement `build`* — which is built out of the step that was asked
     * about and so cannot be wrong about it. Behind that clause, five times in
     * two days, sat `prepared`'s paragraph: a step gained a plugin, the other
     * kinds at it stopped taking the *no plugin implements this step* branch,
     * `whyThatPair` had no branch for the new step, and every one of them was
     * refused with *nothing has been committed at `prepared`*. Green here each
     * time; caught by the cold reviewer each time.
     *
     * So: **no other step answers this cell with the same sentence.** A step
     * with a branch of its own gives a reason no other step gives; a step
     * falling through gives `prepared`'s, and the failure names which step it
     * borrowed from. `PREPARED_OWNS` closes the one hole that leaves — a kind
     * `prepared` accepts has no `prepared` cell to collide with.
     */
    if (ANSWERED_BY_THE_KIND.includes(kind)) return;
    const mine = reasonAt(step, kind);
    const borrowed = STEPS.filter((other) => other !== step && reasonAt(other, kind) === mine);
    expect(
      borrowed,
      `the "${step}" × "${kind}" refusal answers with the reason ${borrowed.join(", ")} gives`,
    ).toEqual([]);
    if (step !== "prepared") {
      expect(
        PREPARED_OWNS,
        `the "${step}" × "${kind}" refusal answers with one of \`prepared\`'s three paragraphs`,
      ).not.toContain(mine);
    }
  });

  /**
   * The same refusal one level down, for a caller that builds actions in code
   * rather than reading a recipe — `lingtai doctor`, a test, a future plugin
   * host. 0015's first extension power is a gate action at a point, and it has
   * to answer the same at both doors.
   */
  it.each(
    (["prepared", "proposed", "merge"] as const).flatMap((step) =>
      KINDS.filter((kind) => whyNoKindAt(step, kind) !== null).map(
        (kind) => [step, kind] as const,
      ),
    ),
  )("actionsFromRecipe refuses %s × %s by name", (step, kind) => {
    expect(() => actionsFromRecipe(step, [ACTION[kind]], DEPS[step])).toThrow(
      ActionUnavailableError,
    );
    expect(() => actionsFromRecipe(step, [ACTION[kind]], DEPS[step])).toThrow(
      new RegExp(`"${kind}" at the "${step}" step`),
    );
  });

  /**
   * **And the fourth door, which is the one `runsAt` cannot watch.** `end`'s
   * consumer is `resolveEndActions` rather than `actionsFromRecipe`, and for it
   * a throw and a silent drop are the same answer — `runsAt` returns false for
   * both, so the cell above passes either way. Every refused kind has to
   * *throw* here, and that is the assertion the row above cannot make.
   *
   * It is not hypothetical. `judge:` is the first plugin outside the two
   * effects to declare a `when:` field (`#238`), and while the guard read
   * `"when" in a` a judge action built in code went past it into the match on
   * the outcome, where `findings` equals neither the outcome nor `any`: `end`
   * resolved, wrote an empty list, and the log said nothing had been declared.
   * That is `#61` for one kind. The guard asks for the three keys the plugins
   * declared `at: { end }` name instead, so a plugin spelling `when:` is
   * refused rather than dropped.
   */
  it.each(KINDS.filter((kind) => whyNoKindAt("end", kind) !== null))(
    "resolveEndActions refuses end × %s by name, rather than dropping it",
    (kind) => {
      expect(() => resolveEndActions([], [ACTION[kind]], "landed")).toThrow(
        new RegExp(`"${kind}" at the "end" step`),
      );
      expect(() => resolveEndActions([], [ACTION[kind]], "landed")).toThrow(
        new RegExp(`"${ACTION[kind].name}"`),
      );
    },
  );

  /**
   * And the keys that guard reads are the plugins' own, not a second list
   * beside them: a plugin that declared itself `at: { end }` and whose key
   * `end-step.ts` does not test would be accepted by the schema and thrown out
   * by the point.
   *
   * **Read off `at` rather than off a constant since `#261`.** It was
   * `KINDS_AT.end`, which said the same thing from a table; 0064 §4 makes the
   * plugin say it, and this walks the closed set asking each one.
   */
  it("refuses at `end` exactly the kinds no plugin declares itself at `end` for", () => {
    const atEnd = PLUGINS.filter((plugin) => servesStep(plugin, "end")).map((plugin) => plugin.key);
    expect(atEnd).toEqual(["close", "labels", "refs"]);
    for (const kind of KINDS) {
      const resolve = () => resolveEndActions([], [ACTION[kind]], "landed");
      if (atEnd.includes(kind)) {
        expect(resolve, kind).not.toThrow();
      } else {
        expect(resolve, kind).toThrow();
      }
    }
  });

  /**
   * **`prepared`'s three refusals are about the point, not about the caller.**
   *
   * The reason is worth pinning rather than just the refusal: `agent:` and
   * `watch:` used to say "no reviewer was supplied", which is a fact about the
   * dependencies `conduct.ts` happens to pass and reads as something that
   * could be fixed by passing them. It cannot: nothing has been committed yet.
   * `human:` is the one that cost a review round — a hold there is turned into
   * a release, which is what `whyNoKindAt` says back, so the person is asked a question
   * that re-asks itself every pass and can never be answered.
   */
  it("says why `prepared` is narrower than `proposed`", () => {
    expect(whyNoKindAt("prepared", "agent")).toMatch(/nothing has been committed/);
    expect(whyNoKindAt("prepared", "watch")).toMatch(/nothing has been committed/);
    expect(whyNoKindAt("prepared", "human")).toMatch(/released back to the queue/);
    expect(whyNoKindAt("prepared", "run")).toBeNull();
  });

  /**
   * **And why `design` is narrower than `proposed`, which is the newest step to
   * need its own sentence** (`#265`).
   *
   * `agentPlugin.at.design` is what put it here, and the trap is the one every
   * opening in this file has sprung: before the key, all twelve kinds at `design`
   * took the *no plugin implements this step* branch; after it, the other eleven
   * fall through `whyThatPair` to the three paragraphs written for `prepared` —
   * which say *nothing has been committed at `prepared`* about a step the
   * operator did not write. True of `design` and printed under the wrong name is
   * still the failure `a417908` and `#270` each shipped once.
   *
   * **The `agent:` sentence is the one worth pinning**, because at every other
   * step that runs one it reviews and here it drafts: an operator who writes a
   * `run:` at `design` is told the step produces a document and that a command
   * that checks the diff is `build`'s, which is the part they can act on.
   */
  it("says why `design` takes only the agent that drafts, and not `prepared`'s reason", () => {
    for (const kind of ["run", "watch", "human"] as const) {
      const why = whyNoKindAt("design", kind);
      expect(why, `${kind} is no longer refused at design`).not.toBeNull();
      expect(why).toContain(`\`${kind}:\` does not implement \`design\``);
      expect(why).toContain("`design` produces a document before any code");
      expect(why).toContain("at this step it drafts rather than reviews");
      // Not the sentences about a step this operator never wrote.
      expect(why).not.toContain("no plugin implements `design`");
      expect(why).not.toContain("at `prepared`");
    }
    // The one that runs there — and it is the same key that reviews elsewhere.
    expect(whyNoKindAt("design", "agent")).toBeNull();
    expect(whyNoKindAt("review", "agent")).toBeNull();
  });

  /**
   * **And why `merge` is narrower than `proposed` too, which is a subtraction and
   * the only one in this file** (`#270`).
   *
   * `humanPlugin.at` and `watchPlugin.at` carried `merge` from before 0058; that
   * ADR §3b gives the step three ways out and the third is *anything else →
   * `proposed`, and only `proposed` may send it to a person*. Both lost the key
   * with the ticket that gave `mergePlugin` one, because the two facts are one:
   * the landing is an action in `merge`'s own list now, so a hold declared beside
   * it would be asked about a merge the same list had already made.
   *
   * **The sentence is pinned rather than the null**, for the reason the row above
   * is. Without `ONLY_PROPOSED_ASKS_A_PERSON` these two cells fall through
   * `whyThatPair`'s step branches to its last paragraph — *a hold at `prepared`
   * cannot be answered* — which is true where it is written and false at the step
   * it would be printed for. That is exactly what opening `build` and `review`
   * walked into, and `not.toMatch` is the half of this case that catches it.
   */
  it("says why `merge` may not ask a person, and does not answer with `prepared`'s reason", () => {
    for (const kind of ["human", "watch"] as const) {
      const why = whyNoKindAt("merge", kind);
      expect(why, `${kind} is no longer refused at merge`).not.toBeNull();
      expect(why).toContain(`\`${kind}:\` does not implement \`merge\``);
      expect(why).toContain("only `proposed` may send it to a person");
      expect(why).toContain("`proposed:`, and that is the step to write this at");
      // Not the sentence about a step this operator never wrote.
      expect(why).not.toMatch(/at `prepared`/);
    }
    // The two that still run there, and the lane itself.
    expect(whyNoKindAt("merge", "run")).toBeNull();
    expect(whyNoKindAt("merge", "agent")).toBeNull();
    expect(whyNoKindAt("merge", "merge")).toBeNull();
  });

  /**
   * **And why `claim` is not `prepared` either, which is the same trap sprung by
   * the last key to open** (`#269`).
   *
   * While `queuePlugin`'s `at` was `{}`, `pluginsAt("claim")` was empty and every
   * kind written there took the *no plugin implements this step* branch. The key
   * removes that branch at this step, so all eleven other kinds fall through
   * `whyThatPair`'s step branches to the three paragraphs at the bottom — which
   * are `prepared`'s, and say *nothing has been committed* and *the run is
   * released back to the queue* about a step where the run has not claimed
   * anything yet. A refusal naming a step the operator never wrote, for a reason
   * that is false where it is printed, is worse than no reason at all: that is
   * what opening `build` and `review` walked into, and `#270` after them.
   *
   * So the branch lands in the same diff as the key, and this is what says so.
   * The remedy is the one `admit`'s carries — a question asked before anything is
   * spent is `lingtai ask`, which holds the item in the queue — because at `claim`
   * nothing has been spent at all.
   */
  it("says why `claim` is not `prepared`, and does not answer with `prepared`'s reason", () => {
    for (const kind of ["run", "agent", "watch", "human"] as const) {
      const why = whyNoKindAt("claim", kind);
      expect(why, `${kind} is no longer refused at claim`).not.toBeNull();
      expect(why).toContain(`\`${kind}:\` does not implement \`claim\``);
      // In `claim`'s own terms: the one plugin it carries, and the remedy.
      expect(why).toContain("`queue:`, which is the key `queuePlugin` declares there");
      expect(why).toContain("`lingtai ask`");
      // Not the two sentences about a step this operator never wrote.
      expect(why).not.toContain("nothing has been committed at `prepared`");
      expect(why).not.toContain("a hold at `prepared` cannot be answered");
    }
    // The one that runs there.
    expect(whyNoKindAt("claim", "queue")).toBeNull();
  });

  /**
   * **The sixth and seventh of the same class, found by asserting it rather than
   * by reading the diff** (`#306`).
   *
   * `#268`, `#269`, `#270`, `#265` and `#266` each opened a step and shipped
   * `prepared`'s paragraph at it, and each was caught by the cold reviewer. The
   * cell walk above now asserts that no other step answers a cell with the same
   * sentence — and the first thing it said was that a `worktree:` at `proposed`
   * or at `merge`, and a `queue:` at either, were being refused with *a hold at
   * `prepared` cannot be answered*: a sentence about a **hold**, for a plugin
   * that is not one, naming a step the operator never wrote.
   *
   * **Why those four hid where the five did not.** `proposed` and `merge` have no
   * branch in `whyThatPair` and never needed one — every kind either of them
   * refuses was answered by kind already, until `#270` took `watch:` and `human:`
   * off `merge` and left these two behind. And the *keyword* check could not see
   * it: `prepared`'s hold paragraph ends by offering `proposed` as the remedy, so
   * the refusal printed at `proposed` contained ``` `proposed` ``` and read as
   * though it were about the step it was asked about.
   *
   * So both join the four kinds that answer for themselves, which is the rule
   * they were always under: **their output is one step's own work** — a cut, a
   * take — and no step branch can say why that is meaningless somewhere else.
   */
  it("says what a cut and a take are for, rather than answering with `prepared`'s hold", () => {
    for (const step of ["prepared", "proposed", "merge"] as const) {
      const cut = whyNoKindAt(step, "worktree");
      expect(cut, `worktree is no longer refused at ${step}`).not.toBeNull();
      expect(cut, step).toContain("`worktree:` is what `admit` does");
      expect(cut, step).toContain("createWorktreeAction");
      const take = whyNoKindAt(step, "queue");
      expect(take, `queue is no longer refused at ${step}`).not.toBeNull();
      expect(take, step).toContain("`queue:` is what `claim` does");
      expect(take, step).toContain("createQueueAction");
      // The paragraph both of them were given until `#306`.
      for (const why of [cut, take]) {
        expect(why, step).not.toContain("a hold at `prepared` cannot be answered");
      }
    }
    // The steps each of them does run at, so the refusals above are about the
    // pair and not about a key that was lost.
    expect(whyNoKindAt("admit", "worktree")).toBeNull();
    expect(whyNoKindAt("claim", "queue")).toBeNull();
    // And the refusal a `worktree:` gets must not send its author to the code the
    // pass calls itself (`#268`) — `provisionWorktree` would read as *your
    // declaration is not what runs*, and at `admit` it is.
    expect(whyNoKindAt("proposed", "worktree")).not.toContain("packages/repo/src/worktree.ts");
  });

  /**
   * **The exemption the cell walk needs, held to a property rather than trusted**
   * (`#306`).
   *
   * `ANSWERED_BY_THE_KIND` is a list, and a list is what failed five times. What
   * keeps it from becoming the next fall-through's hiding place is that a kind on
   * it has to *earn* the entry: its refusal is a fact about the plugin, so it is
   * **one sentence at every step that refuses it**. A kind added here to quiet a
   * red cell would be one whose reason varies by step, and this case goes red
   * instead of the cell going quiet.
   *
   * `end` is excluded and that is the rule rather than an exception: it answers
   * every kind it refuses with its own sentence — *these three effects and no
   * others* — which is the more useful half where a plugin is an effect's
   * neighbour, and it is asserted below by being the same sentence a `run:` gets
   * there.
   */
  it("answers a kind-wide refusal with one sentence everywhere, and `end` with its own", () => {
    for (const kind of ANSWERED_BY_THE_KIND) {
      const refused = STEPS.filter((step) => step !== "end" && whyNoKindAt(step, kind) !== null);
      expect(refused.length, `\`${kind}:\` is refused at no step but \`end\``).toBeGreaterThan(1);
      const reasons = [...new Set(refused.map((step) => reasonAt(step, kind)))];
      expect(
        reasons,
        `\`${kind}:\` is exempt from the cell's assertion and yet answers ${reasons.length} ways`,
      ).toHaveLength(1);
    }
    // The four whose output is one step's own work take `end`'s sentence at
    // `end`, which is the one step that answers before the kind is looked at.
    for (const kind of ["worktree", "merge", "queue", "judge"] as const) {
      expect(reasonAt("end", kind), kind).toBe(reasonAt("end", "run"));
    }
    // And the three effects are the kinds `end` accepts, so they are refused at
    // nine steps with the effect-only rule and at none with a step's own words.
    for (const kind of ["close", "labels", "refs"] as const) {
      expect(whyNoKindAt("end", kind), kind).toBeNull();
    }
  });

  /**
   * **The refusal a plugin author gets, and it names the step they should have
   * written** (`#261`).
   *
   * Under the table this sentence could not be written: a cell was refused
   * because a row did not list a column, and nothing anywhere knew where that
   * column *did* belong. Under `at` the plugin carries the answer, so *close:
   * does not implement `proposed`* arrives with *it serves `end`* beside it —
   * which is the difference between a refusal and homework.
   *
   * `doc/writing-a-plugin.md` promises this wording to whoever reads it before
   * writing one, and the three effects are the only plugins in the closed set
   * that are legal somewhere and refused somewhere else.
   */
  it("names where a plugin does serve, when it is declared at a step it does not", () => {
    for (const kind of ["close", "labels", "refs"] as const) {
      const why = whyNoKindAt("proposed", kind);
      expect(why, `${kind} is no longer refused at proposed`).not.toBeNull();
      expect(why).toContain(`\`${kind}:\` does not implement \`proposed\``);
      expect(why).toContain("it serves `end`");
      // And the whole sentence, as a recipe's reader meets it: the action, the
      // kind and the step are `kindRefusedAt`'s, the rest is the plugin's.
      expect(accepted("proposed", kind)).toContain(`"${ACTION[kind].name}"`);
      expect(accepted("proposed", kind)).toContain("it serves `end`");
    }
  });

  /**
   * **And a step nobody implements says that, rather than *this step takes
   * nothing*** (0064 §4, `#261`).
   *
   * The two were one empty row in `KINDS_AT` — *no plugin's output is read
   * here* and *nobody has built this yet* — and
   * [#231](https://github.com/steven-zhc/lingtai/issues/231) died of the
   * ambiguity: it put configuration on steps whose rows were empty for a
   * reason that had nothing to do with what it was asking for. An `at` can
   * only say the first, so the second is now a sentence of its own, and it
   * carried `WHERE_INSTEAD`'s half — the only part an operator could act on —
   * until `#266` emptied both the class and the table.
   */
  it("says a step no plugin implements, and where that work happens today", () => {
    const unimplemented = STEPS.filter((step) =>
      PLUGINS.every((plugin) => !servesStep(plugin, step)),
    );
    // **Empty since `#266`, and that is the assertion** (0065 §1). `implement`
    // was the last name on this list; `agentPlugin` serves it now, so every one
    // of the ten steps has a plugin and the branch below has no subject left.
    // A step arriving back here would mean a key was lost, and the walk above
    // would go red with it.
    expect(unimplemented).toEqual([]);
    // The branch itself is still reachable code and is asserted by the sentence
    // it would print: `whyNoKindAt` answers about the *pair* at every step now,
    // and *no plugin implements* appears nowhere.
    for (const step of STEPS) {
      expect(whyNoKindAt(step, "run") ?? "", step).not.toContain("no plugin implements");
    }
    // **Both were opened on 2026-09-27 and their refusals went with them.** A
    // `run:` at `build` and an `agent:` at `review` are what the recipe declares
    // there now, so there is no sentence left to send a reader to `proposed` —
    // `null` is the assertion, and a refusal coming back here again would mean a
    // key was lost.
    expect(whyNoKindAt("build", "run")).toBeNull();
    expect(whyNoKindAt("review", "agent")).toBeNull();
    // **And `admit` left the same list on the same terms** (`#268`): the step has
    // a plugin now, so the refusal for every *other* kind there is about the pair
    // rather than about a step nobody built — and it keeps the remedy that branch
    // carried, which is the only part an operator can act on.
    expect(whyNoKindAt("admit", "worktree")).toBeNull();
    // **And `merge` is the third step to leave it, on the same terms** (`#270`):
    // the lane is a `merge:` action, so the refusal for every other kind there is
    // about the pair rather than about a step nobody built.
    expect(whyNoKindAt("merge", "merge")).toBeNull();
    // **And `claim` is the fourth and the last of 0061 §3's five names** (`#269`):
    // the take is a `queue:` action, so the refusal for every other kind there is
    // about the pair rather than about a step nobody built.
    expect(whyNoKindAt("claim", "queue")).toBeNull();
    // **And `design` is the fifth, and the first that is not a name 0061 §3 gave
    // code the pass already ran** (`#265`): `agentPlugin` declares the step, so
    // the refusal for every other kind there is about the pair.
    //
    // **And `implement` is the sixth and the last** (`#266`): the same plugin,
    // the same key, and the list is empty behind it.
    expect(whyNoKindAt("design", "agent")).toBeNull();
    expect(whyNoKindAt("implement", "agent")).toBeNull();
    expect(whyNoKindAt("admit", "run")).toContain("`lingtai ask`");
    expect(whyNoKindAt("admit", "run")).not.toContain("no plugin implements `admit`");
    expect(whyNoKindAt("admit", "run")).not.toContain("nothing has been committed at `prepared`");
  });

  /**
   * **The arithmetic the header argues from, asserted rather than remembered.**
   *
   * Every count in this file's opening is a product of the two closed sets, and
   * twice now a key opened somewhere and left a numeral behind: `a417908` moved
   * two cells and six places went on saying five or six, and `#268` moves a third.
   * A docblock cannot go red, so the numbers live here and the prose quotes them.
   */
  it("runs eighteen of the hundred and twenty cells and refuses a hundred and two", () => {
    const cellsThatRun = STEPS.flatMap((step) =>
      PLUGINS.filter((plugin) => servesStep(plugin, step)),
    );
    expect(STEPS.length * PLUGINS.length).toBe(120);
    expect(cellsThatRun).toHaveLength(18);
    expect(STEPS.length * PLUGINS.length - cellsThatRun.length).toBe(102);

    // The two classes the header decomposes the refusals into, and their overlap.
    const stepsNobodyImplements = STEPS.filter((step) =>
      PLUGINS.every((plugin) => !servesStep(plugin, step)),
    );
    const pluginsServingNothing = PLUGINS.filter((plugin) => plugin.serves.length === 0);
    // **The first class is empty since `#266`**, and the second is the whole of
    // what refuses by column now. The overlap went with it: a `backlog:` at
    // `implement` was the one cell in both, and it is in one.
    expect(stepsNobodyImplements).toHaveLength(0);
    expect(pluginsServingNothing.map((plugin) => plugin.key)).toEqual(["backlog"]);
    expect(stepsNobodyImplements.length * PLUGINS.length).toBe(0);
    expect(pluginsServingNothing.length * STEPS.length).toBe(10);
    expect(stepsNobodyImplements.length * pluginsServingNothing.length).toBe(0);
  });

  /**
   * **What the two steps that opened say to a kind they still refuse**, pinned
   * as sentences rather than as keywords.
   *
   * This is the case the `build` half of `#263` was refused for twice. Opening
   * `runPlugin.at.build` took `agent:`, `watch:` and `human:` at `build` out of
   * the *no plugin implements this step* branch and dropped them into
   * `whyThatPair`, whose three remaining branches were all written for
   * `prepared` — so the refusal for an `agent:` at `build` read *nothing has
   * been committed at `prepared`*, which names a step the operator did not
   * write and is false where it is printed: at `build` the agent has committed.
   * `review` gained the mirror of it, sending a `run:` there to a sentence
   * about a hold that cannot be answered.
   *
   * **The generic walk above cannot catch this**, and that is why the case
   * exists. Its cells assert the refusal *contains* the action, the kind and
   * the step, and all six of these satisfy that on the opening clause —
   * ``` `agent:` does not implement `build` ``` — with any reason at all behind
   * it. So the reason is asserted here, and the two remedies are asserted with
   * it, because *where do I write this instead* is the only part an operator
   * can act on.
   */
  it("says why `build` and `review` are narrower than `proposed`, and where each kind goes", () => {
    for (const kind of ["agent", "watch", "human"] as const) {
      const why = whyNoKindAt("build", kind);
      expect(why, `${kind} is no longer refused at build`).not.toBeNull();
      expect(why).toContain("`build` is the independent build of what was written");
      // The three sentences `prepared` owns, and `build` must not borrow.
      expect(why).not.toContain("nothing has been committed");
      expect(why).not.toContain("released back to the queue");
      expect(why).not.toContain("`lingtai ask`");
    }
    // And it says where each of them goes instead: a cold read is `review`'s,
    // a glob and a hold are `proposed`'s.
    expect(whyNoKindAt("build", "agent")).toContain("a cold read of the diff is `review`");
    expect(whyNoKindAt("build", "watch")).toContain("questions about a change already built, which is `proposed`");

    for (const kind of ["run", "watch", "human"] as const) {
      const why = whyNoKindAt("review", kind);
      expect(why, `${kind} is no longer refused at review`).not.toBeNull();
      expect(why).toContain("`review` returns findings and judges nothing");
      expect(why).toContain("`agent:` is the only plugin that answers with findings");
      expect(why).not.toContain("nothing has been committed");
      expect(why).not.toContain("released back to the queue");
    }
    // The remedy, which is the half of `#263` that moved: a command that
    // decides whether a diff stands has a step of its own now.
    expect(whyNoKindAt("review", "run")).toContain("a `run:` at `build`");
  });

  /**
   * **A step has one body and three steps have several plugins**, which is why
   * `at`'s *value* cannot be that body
   * ([the-plugin-body.md](../../../doc/design/the-plugin-body.md) §5, `#267`).
   *
   * `StepBodies` is keyed by step and `runStep` calls `bodies[spec.step]` once a
   * visit — a step whose body were absent would have to mean *pass* (0016 §4).
   * The plugins at a step are a list. So `at[step]` holds something that is
   * called once per *entry* for the four runnable kinds, and something called
   * once per *visit* for a plugin that would supply the step's own answer, and
   * those are different functions under one key.
   *
   * Asserted here rather than left in the document because the counts are what
   * the document's §5 argues from, and a plugin added or a key opened moves them:
   * T5d puts `run` at `build` and `agent` at `review`, and this row is where a
   * reader learns the argument still holds.
   *
   * **`#274` is the case §5 wrote about, arrived.** It predicted *`#267` would
   * make `proposed` five*, and the five are below — four whose function is an
   * *action's*, called once per declared entry by `runActionPipeline`, and
   * `judge:`, whose answer is the step's own, read once per arrival. So the
   * counts moved and the argument did not: `at`'s value still cannot be
   * `StepBody<S>`, and `notBuiltYet` is still what every key carries.
   */
  it("gives a step one body and several plugins, which is what `at`'s value cannot be one of", () => {
    const serving = new Map(
      STEPS.map((step) => [step, PLUGINS.filter((plugin) => servesStep(plugin, step)).map((p) => p.key)]),
    );

    expect([...serving].filter(([, keys]) => keys.length > 1).map(([step]) => step)).toEqual([
      "proposed",
      "merge",
      "end",
    ]);
    expect(serving.get("proposed")).toEqual(["run", "agent", "watch", "human", "judge"]);
    // **`merge` is not `proposed` with a fifth entry, and `#270` is where the two
    // stopped being the same list.** It carries three: two checks, and the lane the
    // step's own work reduced to. `watch:` and `human:` were here until that ticket
    // and are `proposed`'s alone now — 0058 §3b gives `merge` three ways out and
    // only `proposed` may send one to a person, and since the landing is an action
    // in this list a hold declared beside it would be asked about a merge already
    // made. So this row is the one place the two closed sets record a *subtraction*.
    expect(serving.get("merge")).toEqual(["run", "agent", "merge"]);
    expect(serving.get("end")).toEqual(["close", "labels", "refs"]);
    // And exactly one body per step, which is the other half of the sentence.
    expect(Object.keys(NOT_BUILT_YET).sort()).toEqual([...STEPS].sort());
  });

  /**
   * **`claim` runs `queue:` and refuses a second one, which is the reduction 0061
   * §2 promised there settled the other way** (`#236`, `#269`).
   *
   * That paragraph gave the ordering to the workflow and the *reduction* to the
   * step, and said `claim`'s was *the first plugin that yields a work item wins*.
   * Nothing read `queue:` then, so the promise lived in the refusal. What `claim`
   * runs now is `runActionPipeline`, which stops at the first action that did
   * **not** pass — so two entries are *both must agree*, never *first wins*, and a
   * list whose order reads as a priority it does not have is `#61`'s shape through
   * a duplicate. `StepMap` refuses the second by name instead.
   *
   * Pinned here rather than left as prose because the refusal is the only place a
   * person meets the rule, and the one it replaced promised the opposite.
   */
  it("runs a `queue:` at `claim`, and refuses a second one by name", () => {
    expect(whyNoKindAt("claim", "queue")).toBeNull();
    expect(runsAt("claim", "queue")).toBe(true);

    const twice = StepMap.safeParse({
      claim: [ACTION.queue, { ...ACTION.queue, name: "and again" }],
    });
    expect(twice.success).toBe(false);
    const why = twice.error?.issues.map((issue) => issue.message).join("\n") ?? "";
    expect(why).toContain('"and again"');
    expect(why).toContain("already takes a ticket at entry 0");
    expect(why).toContain("a step takes one or none");
    // The pipeline's rule said out loud, because it is what makes the order
    // meaningless rather than merely redundant.
    expect(why).toContain("stops at the first action that did not pass");

    // And one is accepted, so the refusal is about the duplicate and not the kind.
    expect(StepMap.safeParse({ claim: [ACTION.queue] }).success).toBe(true);
  });

  /**
   * **`judge:` is declarable at `proposed` and nowhere else, and the refusal at
   * the other nine carries the rule that costs money if it is got wrong**
   * (`#238`, `#274`).
   *
   * It was the same sentence at all ten while the plugin served nothing. Now the
   * cell at `proposed` is **null** — the whole of what `#274` opens — and the
   * other nine are a sentence about the *pair*: the router is `proposed`, a
   * refusal at this step travels there (`ARRIVE_AT_THE_ROUTER`), and a judge here
   * would be a second router at a step still deciding its own ending.
   *
   * The reduction rides along with it, because that is where somebody who wrote
   * one at the wrong step reads it: one entry per direction, matched against the
   * reason the last step gave, rather than every entry having to pass. And the
   * clause worth pinning is the other one — **the workflow counts and the judge
   * chooses** (0061 §3): a judge that could carry its own `rounds` could answer
   * *back to `implement`* for ever and nothing would report a fault.
   */
  it("declares `judge:` at `proposed`, and says at the other nine why it is not theirs", () => {
    // The one cell this ticket opened: accepted, and something reads it.
    expect(whyNoKindAt("proposed", "judge")).toBeNull();
    expect(runsAt("proposed", "judge")).toBe(true);

    const why = whyNoKindAt("merge", "judge");
    expect(why, "`judge:` is no longer refused at merge").not.toBeNull();
    expect(why).toContain("`judge:` does not implement `merge`");
    expect(why).toContain("it serves `proposed`");
    expect(why).toContain("only step that routes");
    expect(why).toContain("ARRIVE_AT_THE_ROUTER");
    expect(why).toContain("the workflow counts, the judge chooses");
    expect(why).toContain("one judge per direction");
    expect(why).toContain("refused by name");
    expect(why).toContain("not only on what is left to spend");
    // The reason is a fact about the pair and not about the step, so every step
    // some plugin serves gives the same one — under an opening clause that names
    // the step the operator actually wrote.
    const reason = why!.slice(why!.indexOf(": ") + 2);
    for (const step of [
      "admit",
      "prepared",
      "design",
      "implement",
      "build",
      "review",
      "merge",
    ] as const) {
      expect(whyNoKindAt(step, "judge"), step).toBe(
        `\`judge:\` does not implement \`${step}\` — it serves \`proposed\`: ${reason}`,
      );
    }
    // `end`'s own sentence names `judge:`'s `when:` in order to say what picks
    // the three effects out, and that is the more useful half there.
    expect(whyNoKindAt("end", "judge")).toContain("what picks");
    // **And the *no plugin implements this step* branch has no subject left**
    // (`#266`). It was three until `#269` gave `claim` a `queue:`, two until
    // `#265` gave `design` an `agent:`, one until this one gave `implement` the
    // same key — so `implement` joins the list above and answers about the pair
    // like every other step.
  });

  /**
   * **And the plugin beside it that decides nothing about where the pass goes**
   * (`#237`).
   *
   * `judge:` and `backlog:` will both be written under `proposed`, and a reader
   * who has just read the judge's refusal will carry *this decides the next
   * step* across. It does not: **a step may hold plugins that route and plugins
   * that only act**, and this one is an effect like `end`'s two. The clause
   * that earns the assertion is the money one read the other way round — at or
   * below the bar a finding **buys no round**, because a finding that did not
   * refuse is not a refusal and nothing downstream is ever asked about it.
   *
   * Nearly half of everything a reviewer says arrives there (012 §4), so a
   * recipe that raised the bar believing it bought a round per finding would be
   * sizing its spend off the wrong half of the output.
   */
  it("says how `proposed` will file at or below the bar, and that it routes nothing", () => {
    const why = whyNoKindAt("proposed", "backlog");
    expect(why, "`backlog:` is no longer refused at proposed").not.toBeNull();
    expect(why).toContain("buys no");
    expect(why).toContain("routes nothing");
    expect(why).toContain("plugins that route and plugins that only act");
    // Where the bar is decided today, and where it is a function a recipe will
    // hand a value to — both file references, so they go red if either moves.
    expect(why).toContain("packages/projector/src/backlog.ts");
    expect(why).toContain("packages/conductor/src/backlog.ts");
    // **And the half a reader of the fold alone would miss.** The bar is one
    // comparison written in two packages: the fold decides what is *filed*, and
    // `verdictFor` decides what *refuses*. An implementer who follows this
    // refusal, replaces the fold's literal and stops leaves `verdictFor`
    // returning `failed` for a major — `StepFailed`, no filing, a fix round
    // bought — under a recipe that reads as honoured. The refusal has to name
    // it, so this asserts it does.
    expect(why).toContain("verdictFor");
    expect(why).toContain("packages/actions/src/agent-action.ts");
    // And the dedup nobody has to build: the refusal says why a second round
    // does not file a second entry, which is the Done-when this ticket asserts
    // against today's behaviour rather than adding machinery for.
    expect(why).toContain("packages/domain/src/backlog.ts");
    // A fact about the plugin, so it is the same sentence at all ten steps.
    for (const step of STEPS) expect(whyNoKindAt(step, "backlog")).toBe(why);
  });

  /**
   * **The two halves of *a severity is an outcome*, asserted where the matrix
   * can see them** (`#237`).
   *
   * `decideBacklog` is the bar as a function, and the property the plugin
   * exists to make configurable is that the two answers are one fact: what is
   * filed is exactly what did not refuse, and `buysARound` is false when
   * nothing did.
   *
   * **Parameterised over the whole ladder, and that is a weaker claim than it
   * reads as.** Every bar in `SEVERITIES` is tried and each finding gets its
   * rung from `indexOf`, so a fourth severity added to the enum holds here *by
   * construction* — this file stays green and says nothing about whether the
   * rest of the code met it. What says that is the ladder's consumers, walked
   * against `SEVERITIES` in `packages/actions/unit/agent-action.test.ts` and
   * `packages/conductor/unit/fix.test.ts`. This test asserts the bar; those
   * assert that there is one ladder to put a bar on.
   */
  it("files at or below the bar, and nothing filed buys a round", () => {
    for (const bar of SEVERITIES) {
      const all = SEVERITIES.map(finding);
      const { filed, refuses, buysARound } = decideBacklog(all, bar);
      expect([...filed, ...refuses].length, bar).toBe(all.length);
      expect(filed.every((f) => SEVERITIES.indexOf(f.severity) >= SEVERITIES.indexOf(bar)), bar).toBe(true);
      expect(buysARound, bar).toBe(refuses.length > 0);
      // The whole of *buys no round*: nothing at or below the bar refuses, so
      // a run whose findings are all filed has no refusal to buy one with.
      expect(decideBacklog(filed, bar).buysARound, bar).toBe(false);
    }
    // And the default is today's fold: a `minor` is filed, a `major` is not.
    expect(decideBacklog([finding("minor")]).buysARound).toBe(false);
    expect(decideBacklog([finding("major")]).buysARound).toBe(true);
  });

  /**
   * **And the same bar, read off the half that actually refuses** (`#237`).
   *
   * `decideBacklog`'s default and `verdictFor` in
   * `packages/actions/src/agent-action.ts` are one comparison written twice, in
   * two packages that cannot see each other — so the only thing keeping them
   * the same rule is this assertion. It is what makes *both halves take the
   * recipe's value or neither does* checkable rather than a sentence in a
   * refusal: move one bar and this goes red naming the severity that now
   * disagrees.
   */
  it("agrees, severity by severity, with the half of the bar that refuses", () => {
    for (const severity of SEVERITIES) {
      const one = [finding(severity)];
      expect(decideBacklog(one).buysARound, severity).toBe(verdictFor(one) === "failed");
    }
    expect(verdictFor([])).toBe("passed");
    expect(decideBacklog([]).buysARound).toBe(false);
  });

  /**
   * **The conductor builds every step's list through one seam**, and a second
   * `actionsFromRecipe` call site anywhere under `packages/conductor/src` is a
   * red test here.
   *
   * This is what `is the deps run-once passes at each step` and `is read off the
   * conductor's own source` became when `#256` deleted the file they read.
   * Between them they pinned four literal call sites and the per-step deps each
   * was handed; there is one call site now, it names its step with a *variable*,
   * and it hands the same deps everywhere — `conduct.ts`'s `actionsAt`, which is
   * the seam `PassOptions.actionsAt` asks for.
   *
   * What that buys is the thing the old pair could only approximate: the code
   * runs whatever the schema accepts, at every step, so the plugins' own `at`
   * and `whyNoKindAt` are the only answer and nothing can go on refusing a step
   * the code has started running. What it costs is that *one* has to stay true,
   * because a second call site is a second table of what each step may build —
   * and that is exactly what this asserts.
   *
   * Recursive over `src/`, because "the module the call site is in today" is
   * exactly the assumption this exists to stop being made — and **over the code
   * rather than over the bytes**: `pass.ts`'s own doc comment names
   * `actionsFromRecipe("end", …)` to say the `end` step is not one, and a count
   * that read comments would read that sentence as a second call site.
   */
  it("builds every step's list through one `actionsFromRecipe` call, and it takes the step as a variable", async () => {
    const src = new URL("../src/", import.meta.url);
    const files = (await readdir(src, { recursive: true })).filter((f) => f.endsWith(".ts"));
    let calls = 0;
    let literals = 0;
    let end = false;

    /** The file with every comment taken out, so a sentence is not a call. */
    const code = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const file of files) {
      const text = code(await readFile(new URL(file, src), "utf8"));
      calls += text.match(/actionsFromRecipe\(/g)?.length ?? 0;
      literals += [...text.matchAll(/actionsFromRecipe\(\s*"([a-z]+)"/g)].length;
      if (/export function resolveEndActions\b/.test(text)) end = true;
    }

    expect(calls, "the conductor has more than one `actionsFromRecipe` call site").toBe(1);
    // Zero literals is the seam: a call site that named a step would be a step
    // built differently from the other nine.
    expect(literals, "an `actionsFromRecipe` call site names its step literally").toBe(0);
    // And `end`'s consumer, which is its resolver and never a pipeline.
    expect(end, "`end` has no `resolveEndActions` to carry its effects out").toBe(true);
  });

  /** And the call is the pass's seam, handed to `runPass` rather than called directly. */
  it("hands that call to the pass as `actionsAt`", async () => {
    const wiring = await readFile(new URL("../src/conduct.ts", import.meta.url), "utf8");
    expect(wiring).toMatch(/const actionsAt = \(step: Step, actions: readonly StepAction\[\]\)/);
    expect(wiring).toMatch(/actionsFromRecipe\(step, actions, stepDeps\)/);
    expect(wiring).toMatch(/runPass\(\{[\s\S]*actionsAt,/);
  });
});

/**
 * **`doc/reference.md` no longer carries a copy of the matrix, and that is
 * `#261`.**
 *
 * It used to, and this file's last case read the document and compared its
 * hundred and twenty ticks to `KINDS_AT` cell for cell — because the
 * hand-kept copy in `#61`'s own body was wrong about `merge` within three
 * weeks of being written. 0064 §4 removes the thing being copied: a plugin's
 * `at` is the only statement of where it is legal, there is no constant beside
 * the schema for a document to disagree with, and adding a plugin edits one
 * file. What is left here is the *other* table in that document, whose column
 * nothing else walks.
 */
describe("doc/reference.md", () => {
  /**
   * **The other table, whose `Needs` column is what a person budgets from.**
   *
   * The kind table is read before the matrix and before the prose, and it said
   * a judge wants an agent *for four of the five directions* while
   * `BUILT_IN_FOR` and the prose two hundred lines lower said two of the five
   * are answered by `same-worktree` and spend nothing. Somebody sizing what
   * judges cost reads the first of those and writes an entry too many, which
   * is a cell nothing walked — the matrix test above reads the ticks and never
   * this column.
   *
   * Derived rather than compared to a literal: the numeral comes from counting
   * the directions with no built-in, so the day a third one gets one the
   * document is red rather than quietly a direction out.
   */
  it("says how many directions a judge needs an agent for", async () => {
    const doc = await readFile(new URL("../../../doc/reference.md", import.meta.url), "utf8");
    const NUMERAL = ["none", "one", "two", "three", "four", "five"] as const;
    const spendsAnAgent = Object.values(BUILT_IN_FOR).filter((built) => built === null).length;
    expect(
      doc,
      "doc/reference.md's `judge:` row disagrees with BUILT_IN_FOR about what a judge costs",
    ).toContain(`for ${NUMERAL[spendsAnAgent]} of the five directions an agent`);
  });
});
