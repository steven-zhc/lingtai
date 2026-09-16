/**
 * The wizard's page, as markup (#164).
 *
 * The moves are asserted in `packages/conductor/pure/wizard-page.test.ts`. What
 * is here is what only the render can get wrong: a settled decision drawn as
 * one line that still says `change`, one open question and not two, the flipped
 * default's sentence on the page, `passCeiling`'s sentence under the dials, and
 * no dollar figure anywhere.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { passCeiling } from "@lingtai/conductor/filter";
import { type WizardState, onboardState, updateState, wizardReducer } from "@lingtai/conductor/wizard-page";
import { PRESETS, Recipe, resolveRecipe } from "@lingtai/recipe";
import { editExisting } from "../src/app/setup/wizard/finish.ts";
import { WizardScreen } from "../src/app/setup/wizard/wizard.tsx";

const recipe = (proposed: object[]) =>
  Recipe.parse({
    version: 1,
    repo: { base: "develop" },
    source: { kinds: ["bug"], exclude: ["agent:hold"] },
    env: { required: ["STRIPE_KEY"], plantAt: ".env.local" },
    gates: { proposed, end: [{ name: "close the ticket", when: "landed", close: true }] },
    runtime: { agent: "claude-code" },
  });

const CHECKED = recipe([{ name: "build", run: "pnpm test", timeout: "20m", env: [] }]);
const UNCHECKED = recipe([]);

const start = (r: Recipe) =>
  onboardState({
    slug: "acme/shop",
    recipe: r,
    scripts: r.gates.proposed.length === 0 ? [] : [{ dir: "", name: "test", run: "pnpm test", guessed: true }],
    labels: ["bug", "question"],
  });

const html = (state: WizardState, r: Recipe) =>
  renderToStaticMarkup(<WizardScreen loaded={{ state: "ready", initial: state, recipe: r, existing: null }} />);

const count = (out: string, needle: string) => out.split(needle).length - 1;

describe("two speeds", () => {
  it("draws every fast row filled in, each with change, and one open question", () => {
    const out = html(start(CHECKED), CHECKED);

    expect(count(out, 'class="wz-row"')).toBe(8);
    expect(count(out, ">change</button>")).toBe(8);
    expect(out).toContain("pnpm test");
    expect(out).toContain("STRIPE_KEY");
    expect(count(out, 'class="wz-question"')).toBe(1);
    expect(out).toContain("Does a person approve the merge?");
    expect(out).not.toContain('<p class="wz-ask">How far may one ticket go');
  });

  it("collapses an answered decision to one line that still says change, and opens the next", () => {
    const state = wizardReducer(start(CHECKED), { type: "settle", decision: "gates.merge" });
    const out = html(state, CHECKED);

    expect(out).toContain('class="wz-row wz-settled"');
    expect(out).toContain("nobody approves");
    expect(count(out, ">change</button>")).toBe(9);
    expect(count(out, 'class="wz-question"')).toBe(1);
    expect(out).not.toContain('<p class="wz-ask">Does a person approve');
    expect(out).toContain('<p class="wz-ask">How far may one ticket go');
  });

  it("re-opens a settled decision with its answer still chosen", () => {
    let state = start(CHECKED);
    for (const move of [
      { type: "set", draft: { personApproves: true } },
      { type: "settle", decision: "gates.merge" },
      { type: "settle", decision: "runtime.limits" },
      { type: "reopen", decision: "gates.merge" },
    ] as const) {
      state = wizardReducer(state, move);
    }
    const out = html(state, CHECKED);

    expect(out).toContain("Does a person approve the merge?");
    expect(out).toMatch(/<input type="radio" name="merge" checked=""[^>]*\/> Yes — a person approves/);
    expect(out).toContain("keep this answer");
  });
});

describe("limits", () => {
  it("shows passCeiling's own sentence under the four dials", () => {
    const state = wizardReducer(start(CHECKED), { type: "settle", decision: "gates.merge" });
    const out = html(state, CHECKED);

    for (const dial of ["turns", "wall", "rounds", "restarts"]) expect(out).toContain(`<span>${dial}</span>`);
    const sentence = passCeiling({ turns: 300, wall: "2h", wallMs: 7_200_000, rounds: 2, restarts: 0 });
    expect(out).toContain(sentence.replace(/'/g, "&#x27;"));
  });
});

describe("the one default that flips", () => {
  it("argues for a person approving when nothing was found to check, and says why", () => {
    const out = html(start(UNCHECKED), UNCHECKED);

    expect(out).toContain('class="wz-argues"');
    expect(out).toContain("Nothing checks a diff before it merges. Every ticket goes from an agent straight into");
    expect(out).toContain("So the default here is that a person approves.");
    expect(out).toMatch(/<input type="radio" name="merge" checked=""[^>]*\/> Yes — a person approves/);
  });

  it("does not argue when the scan found checks", () => {
    expect(html(start(CHECKED), CHECKED)).not.toContain("wz-argues");
  });

  it("argues once every check the scan found is unticked", () => {
    const state = wizardReducer(start(CHECKED), { type: "check", id: "pnpm test" });
    expect(html(state, CHECKED)).toContain('class="wz-argues"');
  });
});

describe("the work row", () => {
  it("can be widened by a kind nobody has listed", () => {
    const out = html({ ...start(CHECKED), editing: "source.kinds" }, CHECKED);
    expect(out).toContain('placeholder="another kind"');
  });
});

describe("a recipe on the base branch that does not parse", () => {
  it("says the file is the fault, and does not send the person to another repository", () => {
    const out = renderToStaticMarkup(
      <WizardScreen
        loaded={{ state: "invalid", slug: "acme/shop", why: ".lingtai/config.yaml on main is not valid: prepare: retired" }}
      />,
    );
    expect(out).toContain("acme/shop was read, and its recipe was not");
    expect(out).toContain("prepare: retired");
    expect(out).not.toContain("Pick another");
  });
});

describe("an edit to a recipe that extends a preset", () => {
  const FILE =
    "version: 1\nextends: pnpm-workspace\n\nrepo:\n  base: main\n\nsource:\n  kinds: [bug]\n\nenv:\n  plantAt: .env\n\nruntime:\n  agent: claude-code\n";

  it("keeps every gate the preset supplied when one gate point changes", async () => {
    const { recipe } = await resolveRecipe(async () => FILE, "main");
    expect(recipe.gates.end).toEqual([]);
    const state = wizardReducer(updateState({ slug: "acme/shop", recipe }), {
      type: "set",
      draft: { closeOnLand: true },
    });

    const finished = await editExisting(FILE, state);
    if (!finished.ok) throw new Error(finished.refusals.join("; "));
    expect(finished.changed).toEqual(["gates"]);

    const edited = (await resolveRecipe(async () => finished.file, "main")).recipe.gates;
    const preset = PRESETS["pnpm-workspace"]!.gates!;
    expect(edited.prepared).toEqual(preset.prepared);
    expect(edited.proposed).toEqual(preset.proposed);
    expect(edited.end).toEqual([{ name: "close the ticket", when: "landed", close: true }]);
  });

  it("still changes one line when nothing it changes is inherited", async () => {
    const { recipe } = await resolveRecipe(async () => FILE, "main");
    const state = wizardReducer(updateState({ slug: "acme/shop", recipe }), { type: "limit", key: "turns", value: 7 });

    const finished = await editExisting(FILE, state);
    if (!finished.ok) throw new Error(finished.refusals.join("; "));
    expect(finished.changed).toEqual(["runtime.limits.turns"]);
    expect((await resolveRecipe(async () => finished.file, "main")).recipe.gates).toEqual(recipe.gates);
  });
});

describe("the end", () => {
  it("names what is unanswered rather than offering the button", () => {
    const out = html(start(CHECKED), CHECKED);
    expect(out).toContain("Does a person approve the merge? is not answered yet.");
    expect(out).not.toContain("Show the recipe");
  });

  it("offers the button once every decision is settled", () => {
    let state = start(CHECKED);
    state = wizardReducer(state, { type: "settle", decision: "gates.merge" });
    state = wizardReducer(state, { type: "settle", decision: "runtime.limits" });
    expect(html(state, CHECKED)).toContain("Show the recipe");
  });
});

describe("money", () => {
  it("appears nowhere on the page, in any state", () => {
    let state = start(UNCHECKED);
    const pages = [html(state, UNCHECKED)];
    state = wizardReducer(state, { type: "settle", decision: "gates.merge" });
    pages.push(html(state, UNCHECKED));
    state = wizardReducer(state, { type: "settle", decision: "runtime.limits" });
    pages.push(html({ ...state, editing: "gates.proposed" }, UNCHECKED));

    for (const out of pages) expect(out).not.toMatch(/\$\s?\d|USD|dollar/i);
  });
});
