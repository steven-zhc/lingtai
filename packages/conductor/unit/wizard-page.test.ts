/**
 * The wizard's page as a value (#164): the collapse, the one default that
 * flips, the limits sentence, and an edit that changes one field.
 *
 * Pure: the page runs this in the browser, and a test that needed a database or
 * a client to reach it would be testing something the page does not do.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Recipe, baseOf, editRecipe, excludeOf, kindsOf, resolveRecipe, runPlugin, servesStep } from "@lingtai/recipe";
import { passCeiling } from "../src/filter.ts";
import {
  type WizardState,
  CHECKING_STEPS,
  COMMAND_STEPS,
  applyDraft,
  changesFrom,
  fastLine,
  finishRefusals,
  limitsSentence,
  mergeArgument,
  mergeConsequence,
  onboardState,
  onboardingWritten,
  openDecision,
  settledDecisions,
  updateState,
  wholeSteps,
  wizardReducer,
} from "../src/wizard-page.ts";

// What `proposeRecipe` makes of a repository with `typecheck` and `test` at its root.
const scanned = (proposed: object[] = [{ name: "build", run: "pnpm typecheck && pnpm test", timeout: "20m", env: [] }]) =>
  Recipe.parse({
    version: 2,
    repo: { base: "develop" },
    source: { kinds: ["bug", "feature"], exclude: ["agent:hold", "epic"] },
    env: { required: [], plantAt: ".env.local" },
    steps: { proposed, end: [{ name: "close the ticket", when: "landed", close: true }] },
    runtime: { agent: "claude-code" },
  });

const SCRIPTS = [
  { dir: "", name: "test", run: "pnpm test", guessed: true },
  { dir: "", name: "dev", run: "pnpm dev", guessed: false },
  { dir: "", name: "typecheck", run: "pnpm typecheck", guessed: true },
];

const fresh = (recipe = scanned()): WizardState =>
  onboardState({ slug: "acme/shop", recipe, scripts: SCRIPTS, labels: ["bug", "feature", "question"] });

const play = (state: WizardState, ...moves: Parameters<typeof wizardReducer>[1][]) => moves.reduce(wizardReducer, state);

describe("the collapse", () => {
  it("shows one open question at a time, and an answered one collapses to a settled line", () => {
    const start = fresh();
    expect(openDecision(start)).toBe("steps.merge");
    expect(settledDecisions(start)).toEqual([]);

    const merged = play(start, { type: "settle", decision: "steps.merge" });
    expect(openDecision(merged)).toBe("runtime.limits");
    expect(settledDecisions(merged)).toEqual(["steps.merge"]);

    const done = play(merged, { type: "settle", decision: "runtime.limits" });
    expect(openDecision(done)).toBeNull();
    expect(settledDecisions(done)).toEqual(["steps.merge", "runtime.limits"]);
  });

  it("re-opening a settled decision keeps its answer, and settling it again collapses it", () => {
    const answered = play(
      fresh(),
      { type: "set", draft: { personApproves: true } },
      { type: "settle", decision: "steps.merge" },
      { type: "settle", decision: "runtime.limits" },
    );
    const reopened = play(answered, { type: "reopen", decision: "steps.merge" });

    expect(openDecision(reopened)).toBe("steps.merge");
    expect(settledDecisions(reopened)).toEqual(["runtime.limits"]);
    expect(reopened.draft.personApproves).toBe(true);
    expect(finishRefusals(reopened)).toContain("steps.merge is open — settle it first.");

    const again = play(reopened, { type: "settle", decision: "steps.merge" });
    expect(openDecision(again)).toBeNull();
    expect(again.draft.personApproves).toBe(true);
  });

  it("does not reopen a decision nobody has answered", () => {
    const start = fresh();
    expect(play(start, { type: "reopen", decision: "runtime.limits" })).toBe(start);
  });
});

describe("source.kinds", () => {
  it("refuses to untick the last kind", () => {
    const one = play(fresh(), { type: "kind", label: "feature" });
    expect(one.draft.kinds).toEqual(["bug"]);
    expect(play(one, { type: "kind", label: "bug" }).draft.kinds).toEqual(["bug"]);
  });

  it("widens by a kind the recipe does not list, in update and in onboarding", async () => {
    const { recipe } = await resolveRecipe(
      async () =>
        "version: 2\nrepo:\n  base: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env\nruntime:\n  agent: claude-code\n",
      "main",
    );
    // The file checks nothing, so the merge question is asked; answered as the file has it.
    const update = play(
      updateState({ slug: "acme/shop", recipe }),
      { type: "set", draft: { personApproves: false } },
      { type: "kind", label: "feature" },
    );
    expect(update.kindOptions).toEqual(["bug", "feature"]);
    expect(update.draft.kinds).toEqual(["bug", "feature"]);
    expect(changesFrom(recipe, applyDraft(recipe, update))).toEqual([
      { path: ["source", "kinds"], value: ["bug", "feature"] },
    ]);

    const onboard = play(fresh(), { type: "kind", label: "chore" });
    expect(onboard.kindOptions).toContain("chore");
    expect(onboard.draft.kinds).toEqual(["bug", "feature", "chore"]);
  });

  it("adding a kind that is already ticked keeps it", () => {
    expect(play(fresh(), { type: "kind", label: "bug", add: true }).draft.kinds).toEqual(["bug", "feature"]);
    expect(play(fresh(), { type: "exclude", label: "agent:hold", add: true }).draft.exclude).toEqual([
      "agent:hold",
      "epic",
    ]);
  });

  it("cannot reach the end empty, however the state arrived", () => {
    const empty = fresh();
    empty.draft.kinds = [];
    const settled = play(empty, { type: "settle", decision: "steps.merge" }, { type: "settle", decision: "runtime.limits" });
    expect(finishRefusals(settled)).toEqual([
      "source.kinds is empty — no issue would ever be work. Tick at least one kind.",
    ]);
  });
});

describe("the one default that flips", () => {
  it("defaults to nobody approving when the scan found checks, and says nothing", () => {
    const state = fresh();
    expect(state.draft.personApproves).toBe(false);
    expect(mergeArgument(state)).toBeNull();
  });

  it("defaults to a person approving when the scan found no checks, and says why", () => {
    const state = fresh(scanned([]));
    expect(state.noChecksFound).toBe(true);
    expect(state.draft.personApproves).toBe(true);
    expect(mergeArgument(state)).toBe(
      "Nothing checks a diff before it merges. Every ticket goes from an agent straight into `develop`. " +
        "So the default here is that a person approves.",
    );
    // **`proposed:` and not `merge:` since `#270`**, and the whole list, because
    // the row and the decision write the same key: no check was found, so the
    // approval is all of it.
    expect(applyDraft(scanned([]), state).steps.proposed).toEqual([{ name: "approve", human: "Merge this?" }]);
    expect(applyDraft(scanned([]), state).steps.merge).toEqual([]);
  });

  it("argues from what is ticked, not from what the scan found", () => {
    const nested = fresh(scanned([]));
    expect(nested.draft.checks.some((c) => c.ticked)).toBe(false);
    expect(mergeArgument(play(nested, { type: "check", id: "pnpm test" }))).toBeNull();

    const found = fresh();
    const none = play(found, { type: "check", id: "pnpm typecheck" }, { type: "check", id: "pnpm test" });
    expect(mergeArgument(none)).toContain("Nothing checks a diff before it merges.");
  });

  it("flips the default to a person approving when the last tick goes, while the question is open", () => {
    const none = play(fresh(), { type: "check", id: "pnpm typecheck" }, { type: "check", id: "pnpm test" });
    expect(none.draft.personApproves).toBe(true);
    expect(openDecision(none)).toBe("steps.merge");
  });

  it("opens a settled merge answer again when the last tick goes, and will not finish until it is answered", () => {
    const settled = play(fresh(), { type: "settle", decision: "steps.merge" }, { type: "settle", decision: "runtime.limits" });
    expect(settled.draft.personApproves).toBe(false);

    const none = play(settled, { type: "check", id: "pnpm typecheck" }, { type: "check", id: "pnpm test" });
    expect(openDecision(none)).toBe("steps.merge");
    expect(none.draft.personApproves).toBe(true);
    expect(mergeArgument(none)).toContain("So the default here is that a person approves.");
    expect(finishRefusals(none)).toContain("Does a person approve the merge? is not answered yet.");

    const answered = play(none, { type: "settle", decision: "steps.merge" });
    expect(finishRefusals(answered)).toEqual([]);
    // The ticks are gone, so `proposed:` is the approval and nothing else.
    expect(applyDraft(scanned(), answered).steps.proposed).toEqual([{ name: "approve", human: "Merge this?" }]);
  });

  it("leaves a limits question a person opened open when the last tick goes, and asks the merge question after it", () => {
    const settled = play(fresh(), { type: "settle", decision: "steps.merge" }, { type: "settle", decision: "runtime.limits" });
    const limits = play(settled, { type: "reopen", decision: "runtime.limits" });

    const none = play(limits, { type: "check", id: "pnpm typecheck" }, { type: "check", id: "pnpm test" });
    expect(none.reopened).toBe("runtime.limits");
    expect(openDecision(none)).toBe("runtime.limits");
    expect(finishRefusals(none)).toContain("Does a person approve the merge? is not answered yet.");

    const next = play(none, { type: "settle", decision: "runtime.limits" });
    expect(openDecision(next)).toBe("steps.merge");
    expect(mergeArgument(next)).toContain("So the default here is that a person approves.");
    expect(next.draft.personApproves).toBe(true);
  });

  it("asks the merge question of a recipe on the base branch that checks nothing and has nobody approving", async () => {
    const { recipe } = await resolveRecipe(
      async () =>
        "version: 2\nrepo:\n  base: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env\n" +
        "steps:\n  proposed: []\n  merge: []\nruntime:\n  agent: claude-code\n",
      "main",
    );
    const state = updateState({ slug: "acme/shop", recipe });

    expect(openDecision(state)).toBe("steps.merge");
    expect(state.draft.personApproves).toBe(true);
    expect(mergeArgument(state)).toContain("So the default here is that a person approves.");
    expect(finishRefusals(state)).toEqual(["Does a person approve the merge? is not answered yet."]);

    const kept = play(state, { type: "set", draft: { personApproves: false } }, { type: "settle", decision: "steps.merge" });
    expect(finishRefusals(kept)).toEqual([]);
    expect(changesFrom(recipe, applyDraft(recipe, kept))).toEqual([]);
  });

  it("writes the consequence out whichever way it is answered", () => {
    const none = fresh(scanned([]));
    expect(mergeConsequence({ ...none.draft, personApproves: false })).toBe(
      "Nothing checks a diff before it merges. Every ticket goes from an agent straight into `develop`.",
    );
    expect(mergeConsequence(fresh().draft)).toContain("nobody reads it first");
  });
});

describe("limits", () => {
  it("is passCeiling's sentence, recomputed as a dial moves", () => {
    const state = play(fresh(), { type: "limit", key: "restarts", value: 1 }, { type: "limit", key: "wall", value: "1h" });
    const said = limitsSentence(state.draft.limits);
    expect(said).toEqual({
      ok: true,
      sentence: passCeiling({ turns: 300, wall: "1h", wallMs: 3_600_000, rounds: 2, restarts: 1 }),
    });
    expect(said.ok && said.sentence).toContain("at most 2 passes, 6 agent runs and 6h");
  });

  it("names a dial that does not make a sentence, and will not finish on it", () => {
    const state = play(
      fresh(),
      { type: "limit", key: "wall", value: "two hours" },
      { type: "settle", decision: "steps.merge" },
      { type: "settle", decision: "runtime.limits" },
    );
    expect(limitsSentence(state.draft.limits).ok).toBe(false);
    expect(finishRefusals(state)[0]).toMatch(/^runtime\.limits: "two hours" is not a duration/);
  });

  it("says no money", () => {
    const said = limitsSentence(fresh().draft.limits);
    expect(said.ok && said.sentence).not.toMatch(/\$|USD|cost/);
  });
});

describe("the fast lane", () => {
  it("lists every script found, ticks the guesses in the order the gate runs them, and builds that gate", () => {
    const state = fresh();
    expect(state.draft.checks.map((c) => [c.label, c.ticked])).toEqual([
      ["pnpm typecheck", true],
      ["pnpm test", true],
      ["pnpm dev", false],
    ]);
    expect(fastLine(state.draft, "steps.proposed")).toBe("pnpm typecheck && pnpm test   (1 more found, not ticked)");
    expect(applyDraft(scanned(), state).steps.proposed).toEqual(scanned().steps.proposed);

    const unticked = play(state, { type: "check", id: "pnpm test" });
    expect(applyDraft(scanned(), unticked).steps.proposed).toEqual([
      { name: "build", run: "pnpm typecheck", timeout: "20m", env: [] },
    ]);
  });

  it("a recipe the page built parses", () => {
    const state = play(fresh(), { type: "exclude", label: "question" }, { type: "set", draft: { closeOnLand: false } });
    const recipe = Recipe.parse(applyDraft(scanned(), state));
    expect(recipe.source.exclude).toEqual(["agent:hold", "epic", "question"]);
    expect(recipe.steps.end).toEqual([]);
  });
});

describe("a check the scan did not find", () => {
  it("is added by its command when nothing was found, and becomes the gate", () => {
    const state = onboardState({ slug: "acme/tool", recipe: scanned([]), scripts: [], labels: [] });
    const added = play(state, { type: "add-check", run: "cargo test" });

    expect(added.draft.checks).toEqual([{ id: "cargo test", label: "cargo test", ticked: true }]);
    expect(mergeArgument(added)).toBeNull();
    // The check, and then the hold the merge question defaults to when nothing was
    // found — two of the page's answers in one key since `#270`, in that order,
    // because a person asked before the build has run is asked about nothing.
    expect(applyDraft(scanned([]), added).steps.proposed).toEqual([
      { name: "build", run: "cargo test", timeout: "20m", env: [] },
      { name: "approve", human: "Merge this?" },
    ]);
    expect(play(added, { type: "add-check", run: "cargo test" }).draft.checks).toHaveLength(1);
  });

  it("is added to a recipe that already has its gates, and changes only steps.proposed", async () => {
    const { recipe } = await resolveRecipe(
      async () =>
        "version: 2\nrepo:\n  base: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env\nruntime:\n  agent: claude-code\n",
      "main",
    );
    const state = play(
      updateState({ slug: "acme/tool", recipe }),
      { type: "set", draft: { personApproves: false } },
      { type: "add-check", run: "make test" },
    );
    const after = Recipe.parse(applyDraft(recipe, state));

    expect(after.steps.proposed).toEqual([{ name: "check", run: "make test", timeout: "20m", env: [] }]);
    expect(changesFrom(recipe, after).map((c) => c.path.join("."))).toEqual(["steps.proposed"]);
  });
});

/**
 * **The checks row is one row and three keys**, since `runPlugin` took `build`
 * and `agentPlugin` took `review` on 2026-09-27 (`#263`).
 *
 * Widening the read alone is the bug this file is here to hold shut, and it is
 * worse than the one it fixes: the page would read a build declared at
 * `build:`, write every ticked check to `proposed:`, and move it back — with no
 * refusal, no diff to read, and the machine's recipe quietly undone by whoever
 * next pressed Save on an unrelated row. So the read and the write are asserted
 * together at every step, and a check's `step` is what carries it home.
 */
describe("a check lives at the step it was declared at", () => {
  const REVIEWER = { name: "review", agent: "claude-code", prompt: "read the diff" };
  const BUILD = { name: "build", run: "pnpm typecheck && pnpm test", timeout: "20m", env: [] };

  const moved = (steps: object) =>
    Recipe.parse({
      version: 2,
      repo: { base: "main" },
      source: { kinds: ["bug"] },
      env: { required: [], plantAt: ".env.local" },
      steps: { build: [], review: [], proposed: [], ...steps },
      runtime: { agent: "claude-code" },
    });

  /**
   * `COMMAND_STEPS` is written out in `wizard-page.ts` because that file is
   * bundled for the browser and may not import the plugin set. This is what
   * holds it to the plugin instead of to a memory: a step `runPlugin` opens or
   * closes fails here rather than in a save that throws in front of an
   * operator.
   */
  it("offers a typed-in command only the steps `run:` actually serves", () => {
    expect(COMMAND_STEPS).toEqual(CHECKING_STEPS.filter((step) => servesStep(runPlugin, step)));
    expect(COMMAND_STEPS).not.toContain("review");
  });

  it("reads a build at `build:` and a reviewer at `review:`, and writes both back where they were", () => {
    const recipe = moved({ build: [BUILD], review: [REVIEWER] });
    const state = updateState({ slug: "acme/tool", recipe });

    expect(state.draft.checks.map((c) => [c.step, c.label])).toEqual([
      ["build", "build — pnpm typecheck && pnpm test"],
      ["review", "review"],
    ]);
    // The read: a recipe that checks at two steps and declares nothing at
    // `proposed:` is not a recipe that checks nothing.
    expect(state.noChecksFound).toBe(false);
    expect(mergeArgument(state)).toBeNull();
    expect(mergeConsequence(state.draft)).not.toContain("Nothing checks a diff");
    // And the write: a save that changes no row changes no key.
    expect(changesFrom(recipe, applyDraft(recipe, state))).toEqual([]);
  });

  it("unticking the build at `build:` empties that key and leaves `review:` alone", () => {
    const recipe = moved({ build: [BUILD], review: [REVIEWER] });
    const state = updateState({ slug: "acme/tool", recipe });
    const after = Recipe.parse(applyDraft(recipe, play(state, { type: "check", id: state.draft.checks[0]!.id })));

    expect(changesFrom(recipe, after).map((c) => c.path.join("."))).toEqual(["steps.build"]);
    expect(after.steps.build).toEqual([]);
    expect(after.steps.review).toEqual(recipe.steps.review);
  });

  /**
   * **The save the first widening would have thrown on.** A managed repository
   * that has followed the new docs for its reviewer and left the preset's build
   * where it was gives `checks[0]` at `review`, and sending a typed-in command
   * there is refused by the schema — *the "check" action is a "run" at the
   * "review" step*. `editExisting` parses at `finish.ts:114`, so that refusal
   * is a `finishWizard` catch and a raw Zod dump, and the check cannot be added
   * at all. `homeStep` can only answer a step `run:` serves.
   */
  it("puts a typed-in command at `proposed:` when that is where the commands are, never at `review:`", () => {
    const recipe = moved({ review: [REVIEWER], proposed: [BUILD] });
    const state = play(updateState({ slug: "acme/tool", recipe }), { type: "add-check", run: "pnpm lint" });
    const after = Recipe.parse(applyDraft(recipe, state));

    expect(after.steps.proposed).toEqual([BUILD, { name: "check", run: "pnpm lint", timeout: "20m", env: [] }]);
    expect(after.steps.review).toEqual(recipe.steps.review);
    expect(after.steps.build).toEqual([]);
  });

  it("puts a typed-in command beside the build once the build has moved to `build:`", () => {
    const recipe = moved({ build: [BUILD], review: [REVIEWER] });
    const state = play(updateState({ slug: "acme/tool", recipe }), { type: "add-check", run: "pnpm lint" });
    const after = Recipe.parse(applyDraft(recipe, state));

    expect(after.steps.build).toEqual([BUILD, { name: "check", run: "pnpm lint", timeout: "20m", env: [] }]);
    expect(after.steps.proposed).toEqual([]);
  });

  /**
   * A recipe that has not moved is written exactly as it was — which is what
   * makes this a widening rather than a change of behaviour, and is the
   * *behaves exactly as it does today* half of `#263`.
   */
  it("still answers `proposed` for a recipe that declares nothing at a checking step", () => {
    const recipe = moved({});
    const state = play(updateState({ slug: "acme/tool", recipe }), { type: "add-check", run: "make test" });
    const after = Recipe.parse(applyDraft(recipe, state));

    expect(updateState({ slug: "acme/tool", recipe }).noChecksFound).toBe(true);
    // The typed-in check at `proposed:`, and the approval after it: a file that
    // checked nothing opens the merge question with *a person approves* chosen, and
    // this state has not answered it otherwise.
    expect(after.steps.proposed).toEqual([
      { name: "check", run: "make test", timeout: "20m", env: [] },
      { name: "approve", human: "Merge this?" },
    ]);
    expect(after.steps.build).toEqual([]);
  });
});

/**
 * **The base row, when the recipe has moved it onto `admit`** (`#268`).
 *
 * `baseOf` reads a `worktree:` at `admit` before it reads `repo.base`, so a page
 * that wrote only `repo:` would report the base as changed, write it, pass its
 * own read-back guard — the drafted recipe it hashes against has the same stale
 * declaration — and answer *a diff lands in `release` when the checks pass*,
 * while the next pass went on cutting from `main`. The edit was written,
 * acknowledged and never applied, and nothing refused: `baseDivergence` cannot
 * see it either, because the base it compares against *is* `baseOf`'s.
 */
describe("the base, at whichever of its two spellings the file uses", () => {
  const declaring = (base: string, submodules = false) =>
    Recipe.parse({
      version: 2,
      repo: { base: "main" },
      source: { kinds: ["bug"] },
      env: { plantAt: ".env" },
      steps: { admit: [{ name: "cut the branch", worktree: { base, submodules } }] },
      runtime: { agent: "claude-code" },
    });

  it("writes the declaration when there is one, and says which path changed", () => {
    const recipe = declaring("main");
    // The file checks nothing, so the merge question is asked; answered as the
    // file has it — nobody approving — which keeps `steps.proposed` off the change
    // list. (`steps.merge` is not on `PATHS` at all since `#270`.)
    const state = play(
      updateState({ slug: "acme/shop", recipe }),
      { type: "set", draft: { personApproves: false } },
      { type: "set", draft: { base: "release" } },
    );

    const after = Recipe.parse(applyDraft(recipe, state));
    expect(baseOf(after)).toBe("release");
    expect(after.steps.admit).toEqual([
      { name: "cut the branch", worktree: { base: "release", submodules: false } },
    ]);
    // Both spellings are on the change list, because both moved: the file keeps
    // the one it had and the other is written beside it rather than invented.
    expect(changesFrom(recipe, after).map((change) => change.path.join("."))).toEqual([
      "repo.base",
      "steps.admit",
    ]);
  });

  it("reads the declaration back into the draft, submodules included", () => {
    const state = updateState({ slug: "acme/shop", recipe: declaring("release", true) });
    expect(state.draft.base).toBe("release");
    expect(state.draft.submodules).toBe(true);
  });

  it("leaves `admit` alone where the recipe declares nothing there", () => {
    const recipe = scanned();
    const state = play(updateState({ slug: "acme/shop", recipe }), {
      type: "set",
      draft: { base: "release" },
    });

    const after = Recipe.parse(applyDraft(recipe, state));
    expect(after.steps.admit).toEqual([]);
    expect(baseOf(after)).toBe("release");
    expect(changesFrom(recipe, after).map((change) => change.path.join("."))).toEqual([
      "repo.base",
    ]);
  });
});

/**
 * **The kinds row, when the recipe has moved it onto `claim`** (`#269`) — the
 * base row's sibling one setting down, and the failure is the same one.
 *
 * `kindsOf` and `excludeOf` read a `queue:` at `claim` before they read
 * `source:`, so the page *shows* the block's lists; a page that then wrote only
 * `source:` would report the untick as an edit, write it, hash it, pass its own
 * read-back guard — the drafted recipe it compares against carries the same
 * stale declaration — and go on taking the kind that was removed, with the page
 * showing it back on the next render.
 */
describe("the kinds, at whichever of their two spellings the file uses", () => {
  const declaring = (queue: Record<string, unknown>) =>
    Recipe.parse({
      version: 2,
      repo: { base: "main" },
      source: { kinds: ["bug"], exclude: ["agent:hold"] },
      env: { plantAt: ".env" },
      steps: { claim: [{ name: "take the ticket", queue }] },
      runtime: { agent: "claude-code" },
    });

  const WHOLE = {
    kinds: ["bug", "tech-debt", "documentation"],
    exclude: ["agent:hold"],
    backoff: "45m",
    assignee: { take: "mine", login: "steven-zhc" },
  };

  it("writes the declaration when there is one, and leaves its other two fields", () => {
    const recipe = declaring(WHOLE);
    const state = play(
      updateState({ slug: "acme/shop", recipe }),
      { type: "set", draft: { personApproves: false } },
      // The untick this whole describe is about: a person taking `documentation`
      // off the row on a machine whose recipe declares its queue at the step.
      { type: "kind", label: "documentation" },
      { type: "exclude", label: "wontfix", add: true },
    );

    const after = Recipe.parse(applyDraft(recipe, state));
    expect(kindsOf(after)).toEqual(["bug", "tech-debt"]);
    expect(excludeOf(after)).toEqual(["agent:hold", "wontfix"]);
    // The block's other two fields are nobody's row here, so they are left as
    // the file wrote them rather than replaced by this page's idea of them.
    expect(after.steps.claim).toEqual([
      {
        name: "take the ticket",
        queue: { ...WHOLE, kinds: ["bug", "tech-debt"], exclude: ["agent:hold", "wontfix"] },
      },
    ]);
    // Both spellings are on the change list, because both moved.
    expect(changesFrom(recipe, after).map((change) => change.path.join("."))).toEqual([
      "source.kinds",
      "source.exclude",
      "steps.claim",
    ]);
  });

  it("reads the declaration back into the draft", () => {
    const state = updateState({ slug: "acme/shop", recipe: declaring(WHOLE) });
    expect(state.draft.kinds).toEqual(["bug", "tech-debt", "documentation"]);
    expect(state.draft.exclude).toEqual(["agent:hold"]);
    // Off the block and not off `source:`, which this fixture disagrees with on
    // purpose — that disagreement is what a half-written page would have shown.
    expect(declaring(WHOLE).source.kinds).toEqual(["bug"]);
  });

  it("leaves `claim` alone where the recipe declares nothing there", () => {
    const recipe = scanned();
    const state = play(updateState({ slug: "acme/shop", recipe }), {
      type: "kind",
      label: "feature",
    });

    const after = Recipe.parse(applyDraft(recipe, state));
    expect(after.steps.claim).toEqual([]);
    expect(kindsOf(after)).toEqual(["bug"]);
    expect(changesFrom(recipe, after).map((change) => change.path.join("."))).toContain(
      "source.kinds",
    );
    expect(changesFrom(recipe, after).map((change) => change.path.join("."))).not.toContain(
      "steps.claim",
    );
  });
});

describe("wholeSteps", () => {
  it("makes every change under gates one change to the block, and leaves the rest", () => {
    const after = scanned();
    const changes = [
      { path: ["steps", "end"], value: [] },
      { path: ["runtime", "limits", "turns"], value: 200 },
    ];
    expect(wholeSteps(changes, after)).toEqual([
      { path: ["runtime", "limits", "turns"], value: 200 },
      { path: ["steps"], value: after.steps },
    ]);
    expect(wholeSteps([changes[1]!], after)).toEqual([changes[1]]);
  });
});

describe("an existing recipe", () => {
  const file = readFileSync(new URL("../../../.lingtai/config.yaml", import.meta.url), "utf8");

  it("loads into the fast lane, with its decisions settled", async () => {
    const { recipe } = await resolveRecipe(async () => file, "main");
    const state = updateState({ slug: "steven-zhc/lingtai", recipe });

    expect(state.draft.kinds).toEqual(["bug", "tech-debt", "feature"]);
    expect(state.draft.limits).toMatchObject({ turns: 150, wall: "1h" });
    expect(openDecision(state)).toBeNull();
    expect(changesFrom(recipe, applyDraft(recipe, state))).toEqual([]);
  });

  it("editing one field changes one field, and one line of the file", async () => {
    const { recipe } = await resolveRecipe(async () => file, "main");
    const state = play(updateState({ slug: "steven-zhc/lingtai", recipe }), { type: "limit", key: "turns", value: 200 });

    const changes = changesFrom(recipe, applyDraft(recipe, state));
    expect(changes).toEqual([{ path: ["runtime", "limits", "turns"], value: 200 }]);

    const edited = editRecipe(file, changes);
    const before = file.split("\n");
    const after = edited.split("\n");
    expect(after).toHaveLength(before.length);
    const moved = before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]));
    expect(moved).toEqual([["    turns: 150", "    turns: 200"]]);
  });

  it("unticking a check removes that gate and nothing else", async () => {
    const { recipe } = await resolveRecipe(async () => file, "main");
    const state = updateState({ slug: "steven-zhc/lingtai", recipe });
    expect(state.draft.checks.every((c) => c.ticked)).toBe(true);
    const first = state.draft.checks[0]!;
    const after = applyDraft(recipe, play(state, { type: "check", id: first.id }));

    expect(changesFrom(recipe, after).map((c) => c.path.join("."))).toEqual(["steps.proposed"]);
    expect(after.steps.proposed).toEqual(recipe.steps.proposed.slice(1));
  });
});

/**
 * The last screen once the button has written (#182). It says what it wrote and
 * where — this machine — and ends without a pull request and nothing to merge.
 *
 * **And without "install the App".** `finishWizard` builds its client on the
 * App's installation on the repository and refuses without one, so this screen
 * only exists where the App is installed; telling the operator to install it
 * would send them after a step already done. What is left is `Recheck`.
 */
describe("the last screen, written", () => {
  const withLimits = "runtime:\n  limits:\n    turns: 90\nsteps:\n  proposed: []\n";
  const said = onboardingWritten("acme/shop", "/home/me/.lingtai/shop/recipe.yml", withLimits);

  it("names the files it wrote on this machine", () => {
    expect(said).toContain("/home/me/.lingtai/shop/recipe.yml");
    expect(said).toContain("projects.shop.runtime in ~/.lingtai/config.yml");
    expect(said).toContain("Nothing was written to acme/shop");
  });

  it("ends at Recheck, and asks for no install, no pull request and nothing to merge", () => {
    expect(said).toContain("press Recheck");
    expect(said).toContain("permissions on acme/shop");
    expect(said).not.toMatch(/install|pull request|merge/i);
  });

  it("says the recipe has its own limits in it, when the file written has a limits block", () => {
    expect(said).toContain("with its own limits in it");
  });

  /** `#371`: a dial nobody moved means `emitRecipe` wrote no limits block at all. */
  it("says nothing about limits when the file written has none", () => {
    const noLimits = onboardingWritten("acme/shop", "/home/me/.lingtai/shop/recipe.yml", "steps:\n  proposed: []\n");
    expect(noLimits).not.toContain("limits");
  });
});

/**
 * **This module is reached from a `"use client"` component, so a value import
 * of `@lingtai/recipe` puts `node:fs` in a browser chunk.**
 *
 * `apps/board/src/app/setup/wizard/wizard.tsx` imports `DECISIONS`, `play` and
 * the rest from here. The package's barrel re-exports `local.ts`, which reads
 * files; Turbopack then fails the whole page with *the chunking context does
 * not support external modules (request: node:fs)* — a build error, invisible
 * to `tsc` and to every test in this project, and the one that took
 * `/setup/wizard/page` down once already.
 *
 * `import type` is fine: it is erased. The narrow subpaths —
 * `@lingtai/recipe/duration`, `@lingtai/recipe/settings` — are the way in, and
 * a new accessor that needs one gets a subpath rather than a barrel import.
 */
describe("what this module may import", () => {
  it("takes no value import from the recipe barrel, because a client component reaches it", async () => {
    const src = await readFile(new URL("../src/wizard-page.ts", import.meta.url), "utf8");
    const barrel = src
      .split("\n")
      .filter((line) => /from "@lingtai\/recipe";\s*$/.test(line) && !line.startsWith("import type"));

    expect(
      barrel,
      "use @lingtai/recipe/<subpath> — the barrel re-exports local.ts, and node:fs " +
        "in this graph fails the wizard page's build",
    ).toEqual([]);
  });
});
