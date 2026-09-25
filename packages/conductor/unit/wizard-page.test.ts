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
import { Recipe, editRecipe, resolveRecipe } from "@lingtai/recipe";
import { passCeiling } from "../src/filter.ts";
import {
  type WizardState,
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
    expect(applyDraft(scanned([]), state).steps.merge).toEqual([{ name: "approve", human: "Merge this?" }]);
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
    expect(applyDraft(scanned(), answered).steps.merge).toEqual([{ name: "approve", human: "Merge this?" }]);
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
    expect(applyDraft(scanned([]), added).steps.proposed).toEqual([
      { name: "build", run: "cargo test", timeout: "20m", env: [] },
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

describe("wholeGates", () => {
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
  const said = onboardingWritten("acme/shop", "/home/me/.lingtai/shop/recipe.yml");

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
