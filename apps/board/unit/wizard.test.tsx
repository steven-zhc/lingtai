/**
 * The wizard's page, as markup (#164).
 *
 * The moves are asserted in `packages/conductor/unit/wizard-page.test.ts`. What
 * is here is what only the render can get wrong: a settled decision drawn as
 * one line that still says `change`, one open question and not two, the flipped
 * default's sentence on the page, `passCeiling`'s sentence under the dials, and
 * no dollar figure anywhere.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { passCeiling } from "@lingtai/conductor/filter";
import { type WizardState, onboardState, updateState, wizardReducer } from "@lingtai/conductor/wizard-page";
import { PRESETS, Recipe, machinePath, recipePath, resolveLocalRecipe, resolveRecipe } from "@lingtai/recipe";
import { editExisting } from "../src/app/setup/wizard/finish.ts";
import { WizardScreen } from "../src/app/setup/wizard/wizard.tsx";

const recipe = (proposed: object[]) =>
  Recipe.parse({
    version: 2,
    repo: { base: "develop" },
    source: { kinds: ["bug"], exclude: ["agent:hold"] },
    env: { required: ["STRIPE_KEY"], plantAt: ".env.local" },
    steps: { proposed, end: [{ name: "close the ticket", when: "landed", close: true }] },
    runtime: { agent: "claude-code" },
  });

const CHECKED = recipe([{ name: "build", run: "pnpm test", timeout: "20m", env: [] }]);
const UNCHECKED = recipe([]);

const start = (r: Recipe) =>
  onboardState({
    slug: "acme/shop",
    recipe: r,
    scripts: r.steps.proposed.length === 0 ? [] : [{ dir: "", name: "test", run: "pnpm test", guessed: true }],
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
    const state = wizardReducer(start(CHECKED), { type: "settle", decision: "steps.merge" });
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
      { type: "settle", decision: "steps.merge" },
      { type: "settle", decision: "runtime.limits" },
      { type: "reopen", decision: "steps.merge" },
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
    const state = wizardReducer(start(CHECKED), { type: "settle", decision: "steps.merge" });
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

  it("argues once every check the scan found is unticked, with the default it argues for chosen", () => {
    const state = wizardReducer(start(CHECKED), { type: "check", id: "pnpm test" });
    const out = html(state, CHECKED);
    expect(out).toContain('class="wz-argues"');
    expect(out).toMatch(/<input type="radio" name="merge" checked=""[^>]*\/> Yes — a person approves/);
  });

  it("opens a merge answer already given when the checks are unticked afterwards, and offers no recipe", () => {
    let state = wizardReducer(start(CHECKED), { type: "settle", decision: "steps.merge" });
    state = wizardReducer(state, { type: "settle", decision: "runtime.limits" });
    state = wizardReducer(state, { type: "check", id: "pnpm test" });
    const out = html(state, CHECKED);

    expect(out).toContain('class="wz-argues"');
    expect(out).toContain("Does a person approve the merge?");
    expect(out).not.toContain("Write the recipe on this machine");
  });
});

describe("a recipe on the base branch that checks nothing and has nobody approving", () => {
  it("opens the merge question with the argument and its default chosen, and offers no change", async () => {
    const { recipe: r } = await resolveRecipe(
      async () =>
        "version: 2\nrepo:\n  base: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env\n" +
        "steps:\n  proposed: []\n  merge: []\nruntime:\n  agent: claude-code\n",
      "main",
    );
    const out = renderToStaticMarkup(
      <WizardScreen loaded={{ state: "ready", initial: updateState({ slug: "acme/shop", recipe: r }), recipe: r, existing: "" }} />,
    );

    expect(out).not.toContain("nobody approves");
    expect(out).toContain('class="wz-argues"');
    expect(out).toMatch(/<input type="radio" name="merge" checked=""[^>]*\/> Yes — a person approves/);
    expect(out).not.toContain("Show the change");
  });
});

describe("the checks row", () => {
  it("takes a command when the scan found none", () => {
    const out = html({ ...start(UNCHECKED), editing: "steps.proposed" }, UNCHECKED);
    expect(out).toContain("No scripts were found.");
    expect(out).toContain('placeholder="another command, e.g. make test"');
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
  // The machine's recipe, which carries no `runtime.agent` (#180). It may now
  // carry its own `runtime.limits` — the ceiling is the recipe's since `#371`.
  const FILE =
    "version: 2\nextends: pnpm-workspace\n\nrepo:\n  base: main\n\nsource:\n  kinds: [bug]\n\nenv:\n  plantAt: .env\n";
  const HOME = "/home/me/.lingtai";
  const on = (current: Recipe, machine: string | null = null) => ({ project: "shop", current, machine, home: HOME });

  it("keeps every gate the preset supplied when one gate point changes", async () => {
    const { recipe } = await resolveRecipe(async () => FILE, "main");
    expect(recipe.steps.end).toEqual([]);
    const state = wizardReducer(updateState({ slug: "acme/shop", recipe }), {
      type: "set",
      draft: { closeOnLand: true },
    });

    const finished = await editExisting(FILE, state, on(recipe));
    if (!finished.ok) throw new Error(finished.refusals.join("; "));
    expect(finished.changed).toEqual(["steps"]);
    expect(finished.machine).toBeNull();

    const edited = (await resolveRecipe(async () => finished.file, "main")).recipe.steps;
    const preset = PRESETS["pnpm-workspace"]!.steps!;
    expect(edited.prepared).toEqual(preset.prepared);
    expect(edited.proposed).toEqual(preset.proposed);
    expect(edited.end).toEqual([{ name: "close the ticket", when: "landed", close: true }]);
  });

  it("still changes one line when nothing it changes is inherited — written whole, since `#371`", async () => {
    const { recipe } = await resolveRecipe(async () => FILE, "main");
    const state = wizardReducer(updateState({ slug: "acme/shop", recipe }), { type: "limit", key: "turns", value: 7 });

    const finished = await editExisting(FILE, state, on(recipe));
    if (!finished.ok) throw new Error(finished.refusals.join("; "));
    // The whole ceiling, not the one key that moved (`wholeLimits`) — and
    // nothing for the machine file, since nothing on it needs to change.
    expect(finished.changed).toEqual(["runtime.limits"]);
    expect(finished.machine).toBeNull();
    expect((await resolveRecipe(async () => finished.file, "main")).recipe.steps).toEqual(recipe.steps);
  });

  /**
   * **The ceiling is the recipe's own since `#371`.** A limit changed on the
   * page is written into the recipe file, whole — every key, not only the one
   * that moved — and the machine file is left alone when it has nothing of
   * its own to say and nothing stale to migrate.
   */
  it("writes a limit change into the recipe file, and leaves an unrelated machine file alone", async () => {
    const { recipe } = await resolveRecipe(async () => FILE, "main");
    const machineBefore = "# mine\nprojects:\n  shop:\n    runtime:\n      agent: claude-code\n";
    const state = wizardReducer(updateState({ slug: "acme/shop", recipe }), { type: "limit", key: "turns", value: 7 });

    const finished = await editExisting(FILE, state, on(recipe, machineBefore));
    if (!finished.ok) throw new Error(finished.refusals.join("; "));
    expect(finished.path).toBe(recipePath("shop", HOME));
    expect(finished.file).toMatch(/runtime:\n\s*limits:/);
    expect(finished.file).not.toMatch(/^\s*agent:/m);
    // Nothing on this machine needed to change: the agent still agrees and
    // there is no legacy `projects.shop.runtime.limits` to migrate away.
    expect(finished.machine).toBeNull();

    const resolved = await resolveLocalRecipe("shop", {
      home: HOME,
      signedIn: async () => [],
      read: async (path) =>
        path === recipePath("shop", HOME) ? finished.file : path === machinePath(HOME) ? machineBefore : null,
    });
    expect(resolved.recipe.runtime.limits.turns).toBe(7);
    expect(resolved.recipe.steps).toEqual(recipe.steps);
  });

  /**
   * **The window attempt 1 reproduced, closed.** Both live machines today
   * state this project's ceiling under `projects.<p>.runtime.limits` with a
   * recipe silent about it — the dials seed from that fallback — and a save
   * that moves a dial in either direction must write, never refuse, and must
   * migrate the stale block out from under it.
   */
  it("migrates the machine's old per-project ceiling on the first save, in either direction", async () => {
    const machineBefore =
      "projects:\n  shop:\n    runtime:\n      agent: claude-code\n      limits: { turns: 150, wall: 1h, rounds: 3, restarts: 0 }\n";
    const seeded = await resolveLocalRecipe("shop", {
      home: HOME,
      signedIn: async () => [],
      read: async (path) => (path === recipePath("shop", HOME) ? FILE : path === machinePath(HOME) ? machineBefore : null),
    });

    for (const [key, value] of [
      ["turns", 90] as const,
      ["turns", 280] as const,
      ["rounds", 2] as const,
      ["rounds", 4] as const,
    ]) {
      // `current` is the same resolve that seeded `state` — as `at.current`
      // is in production, both from one `currentRecipe()` call at page load.
      const state = wizardReducer(updateState({ slug: "acme/shop", recipe: seeded.recipe }), { type: "limit", key, value });
      const finished = await editExisting(FILE, state, { project: "shop", current: seeded.recipe, machine: machineBefore, home: HOME });
      if (!finished.ok) throw new Error(`${key}=${value}: ${finished.refusals.join("; ")}`);
      expect(finished.file).toContain(`${key}: ${value}`);
      // The legacy block is present every iteration, so the migration must
      // run every iteration — never left to chance by a vacuous guard (#371).
      expect(finished.machine).not.toBeNull();
      expect(finished.machine).not.toContain("limits");

      const resolved = await resolveLocalRecipe("shop", {
        home: HOME,
        signedIn: async () => [],
        read: async (path) =>
          path === recipePath("shop", HOME) ? finished.file : path === machinePath(HOME) ? (finished.machine ?? machineBefore) : null,
      });
      expect(resolved.recipe.runtime.limits[key]).toBe(value);
    }
  });

  /**
   * **finish.ts:110-115's other claim, which the loop above never exercises:
   * a save nobody touched a dial on still migrates the legacy block.** Every
   * iteration above moves one, so this is the only test where none does.
   */
  it("migrates the legacy block on a save that moves no dial", async () => {
    const machineBefore =
      "projects:\n  shop:\n    runtime:\n      agent: claude-code\n      limits: { turns: 150, wall: 1h, rounds: 3, restarts: 0 }\n";
    const seeded = await resolveLocalRecipe("shop", {
      home: HOME,
      signedIn: async () => [],
      read: async (path) => (path === recipePath("shop", HOME) ? FILE : path === machinePath(HOME) ? machineBefore : null),
    });
    const state = updateState({ slug: "acme/shop", recipe: seeded.recipe });

    const finished = await editExisting(FILE, state, { project: "shop", current: seeded.recipe, machine: machineBefore, home: HOME });
    if (!finished.ok) throw new Error(finished.refusals.join("; "));
    expect(finished.machine).not.toBeNull();
    expect(finished.machine).not.toContain("limits");
    expect(finished.file).toContain("turns: 150");

    const resolved = await resolveLocalRecipe("shop", {
      home: HOME,
      signedIn: async () => [],
      read: async (path) =>
        path === recipePath("shop", HOME) ? finished.file : path === machinePath(HOME) ? (finished.machine ?? machineBefore) : null,
    });
    expect(resolved.recipe.runtime.limits).toEqual({ turns: 150, wall: "1h", rounds: 3, restarts: 0 });
  });

  /**
   * **A machine-wide narrowing cap must never become the recipe's own stated
   * ceiling.** The dials are seeded from the narrowed resolve, so a save that
   * touches no limit dial — only the kinds row here — must not write the
   * narrowed numbers back as what the recipe states: raising the cap
   * afterwards would then have nothing to raise.
   */
  it("does not bake a machine-wide narrowing cap into the recipe on an untouched dial", async () => {
    const machineBefore = "runtime:\n  agent: claude-code\n  limits:\n    turns: 100\n    rounds: 1\n";
    const seeded = await resolveLocalRecipe("shop", {
      home: HOME,
      signedIn: async () => [],
      read: async (path) => (path === recipePath("shop", HOME) ? FILE : path === machinePath(HOME) ? machineBefore : null),
    });
    expect(seeded.recipe.runtime.limits).toEqual({ turns: 100, wall: "2h", rounds: 1, restarts: 0 });

    const state = wizardReducer(updateState({ slug: "acme/shop", recipe: seeded.recipe }), {
      type: "kind",
      label: "feature",
      add: true,
    });

    const finished = await editExisting(FILE, state, { project: "shop", current: seeded.recipe, machine: machineBefore, home: HOME });
    if (!finished.ok) throw new Error(finished.refusals.join("; "));
    expect(finished.changed).not.toContain("runtime.limits");
    expect(finished.file).not.toContain("turns: 100");

    const raised = "runtime:\n  agent: claude-code\n  limits:\n    turns: 500\n    rounds: 1\n";
    const resolved = await resolveLocalRecipe("shop", {
      home: HOME,
      signedIn: async () => [],
      read: async (path) => (path === recipePath("shop", HOME) ? finished.file : path === machinePath(HOME) ? raised : null),
    });
    expect(resolved.recipe.runtime.limits.turns).toBe(300);
  });

  /**
   * **`#371`'s finding 1.** `usd` is not a page dial (`Limits` has no such
   * field), so the four-key "undo the narrowing" logic never reaches it — a
   * machine-wide `usd` cap used to ride along inside `ceilingOf(drafted)` and
   * get baked into `after`, which `changesFrom` can never see (`PATHS` has no
   * `usd` path) and which the read-back `describes` check then refuses on,
   * for a save that never touched a dial at all.
   */
  it("saves under a machine-wide usd cap when no dial moved, and never states usd", async () => {
    const machineBefore = "runtime:\n  agent: claude-code\n  limits:\n    usd: 5\n";
    const seeded = await resolveLocalRecipe("shop", {
      home: HOME,
      signedIn: async () => [],
      read: async (path) => (path === recipePath("shop", HOME) ? FILE : path === machinePath(HOME) ? machineBefore : null),
    });

    const state = wizardReducer(updateState({ slug: "acme/shop", recipe: seeded.recipe }), {
      type: "kind",
      label: "feature",
      add: true,
    });

    const finished = await editExisting(FILE, state, { project: "shop", current: seeded.recipe, machine: machineBefore, home: HOME });
    if (!finished.ok) throw new Error(finished.refusals.join("; "));
    expect(finished.file).not.toContain("usd");
  });

  /**
   * **`#371`'s finding 2, on `usd` rather than a dial key.** A dial moving
   * must not bake the machine-wide `usd` cap into the recipe either — raising
   * the cap afterwards must still have something to raise.
   */
  it("never bakes a machine-wide usd cap into the recipe, even when a dial moves", async () => {
    const machineBefore = "runtime:\n  agent: claude-code\n  limits:\n    usd: 5\n";
    const seeded = await resolveLocalRecipe("shop", {
      home: HOME,
      signedIn: async () => [],
      read: async (path) => (path === recipePath("shop", HOME) ? FILE : path === machinePath(HOME) ? machineBefore : null),
    });

    const state = wizardReducer(updateState({ slug: "acme/shop", recipe: seeded.recipe }), {
      type: "limit",
      key: "turns",
      value: 90,
    });
    const finished = await editExisting(FILE, state, { project: "shop", current: seeded.recipe, machine: machineBefore, home: HOME });
    if (!finished.ok) throw new Error(finished.refusals.join("; "));
    expect(finished.file).toContain("turns: 90");
    expect(finished.file).not.toContain("usd");

    const raised = "runtime:\n  agent: claude-code\n  limits:\n    usd: 50\n";
    const resolved = await resolveLocalRecipe("shop", {
      home: HOME,
      signedIn: async () => [],
      read: async (path) => (path === recipePath("shop", HOME) ? finished.file : path === machinePath(HOME) ? raised : null),
    });
    expect(resolved.recipe.runtime.limits.usd).toBe(50);
  });

  /**
   * **`#371`'s finding 4.** `wholeLimits` rewrites every key's value but
   * `emit.ts`'s `replace` keeps the key's own `commentBefore` untouched, so
   * the sentence above `limits:` used to go on naming the numbers a past save
   * left behind. A save that moves a dial must carry a comment about *this*
   * save's numbers.
   */
  it("refreshes the comment above runtime.limits to the numbers the save now writes", async () => {
    const fileWithStaleComment =
      "version: 2\nextends: pnpm-workspace\n\nrepo:\n  base: main\n\nsource:\n  kinds: [bug]\n\nenv:\n  plantAt: .env\n\n" +
      "runtime:\n" +
      "  # A pass: up to 3 agent runs — the work, then 2 round(s) back to the agent\n" +
      "  # carrying what refused it. 2h and 300 turns each, so at most 6h. A pass\n" +
      "  # whose rounds are spent goes to you (runtime.limits.restarts: 0).\n" +
      "  limits:\n    turns: 300\n    wall: 2h\n    rounds: 2\n    restarts: 0\n";
    const { recipe } = await resolveRecipe(async () => fileWithStaleComment, "main");
    const state = wizardReducer(updateState({ slug: "acme/shop", recipe }), { type: "limit", key: "turns", value: 90 });

    const finished = await editExisting(fileWithStaleComment, state, on(recipe));
    if (!finished.ok) throw new Error(finished.refusals.join("; "));
    const comment = finished.file.match(/runtime:\n((?:\s*#.*\n)*)\s*limits:/)?.[1] ?? "";
    expect(comment).not.toContain("300");
    expect(comment).toContain("90");
  });
});

describe("the end", () => {
  it("names what is unanswered rather than offering the button", () => {
    const out = html(start(CHECKED), CHECKED);
    expect(out).toContain("Does a person approve the merge? is not answered yet.");
    expect(out).not.toContain("Write the recipe on this machine");
  });

  it("offers the button once every decision is settled", () => {
    let state = start(CHECKED);
    state = wizardReducer(state, { type: "settle", decision: "steps.merge" });
    state = wizardReducer(state, { type: "settle", decision: "runtime.limits" });
    expect(html(state, CHECKED)).toContain("Write the recipe on this machine");
  });
});

describe("money", () => {
  it("appears nowhere on the page, in any state", () => {
    let state = start(UNCHECKED);
    const pages = [html(state, UNCHECKED)];
    state = wizardReducer(state, { type: "settle", decision: "steps.merge" });
    pages.push(html(state, UNCHECKED));
    state = wizardReducer(state, { type: "settle", decision: "runtime.limits" });
    pages.push(html({ ...state, editing: "steps.proposed" }, UNCHECKED));

    for (const out of pages) expect(out).not.toMatch(/\$\s?\d|USD|dollar/i);
  });
});
