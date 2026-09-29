/**
 * The accessors, and the claim that nothing reaches past them.
 *
 * The first half is ordinary — they return what the recipe holds. **The second
 * half is the one that earns the file**: it walks every `src/` in the workspace
 * and fails on a reader that still reaches into one of the seven settings
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §4 and
 * [0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md) §3 move.
 *
 * **It was three, and three is what `#231` found wrong with it.** The guard
 * named `runtime.limits`, `repo.base` and `source.kinds`, which are the three
 * that had an accessor — so it read as *nothing reaches past the accessors*
 * while `repo.submodules`, `source.exclude` and `source.backoff` were read by
 * hand in nine files and the same ADR moves all six. A guard sized to the
 * accessors that exist rather than to the settings that move is a guard that
 * goes green as the diff it exists to prevent is being written.
 *
 * **And `recipe.` was the required receiver**, so `parsed.data.repo.base` in
 * `wizard.ts` walked past it — a reader of the same setting off a recipe that
 * had not been given that name yet. The rule below asks only that the path be
 * *read off something*: an identifier character, a dot, then the setting. That
 * is what tells a reader from the many places these six are named as text — a
 * provenance key, a wizard field id, a refusal naming the key to fix — without
 * having to decide what is a string, which the multi-line templates in
 * `fix.ts`, `lingtai.ts` and `wall-limit.ts` make a losing game.
 *
 * **What it still cannot see is a destructured read**, and `planOf` in
 * `queued.ts` is the shape: `runtime.limits.turns` off a parameter. That one is
 * not a reader of the recipe — it is a pure function over a shape, and its
 * caller is the reader — but a genuine `const { source } = recipe` would slip
 * past, so this is a guard against the mistake rather than a proof.
 *
 * Without it the accessors are a suggestion. With it,
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §4's move —
 * every setting onto the step that owns it — is a change to `settings.ts` and
 * to nothing else, which is the whole reason they exist. A reader added later
 * that skips them would put the sixty-file diff back without anybody deciding
 * to.
 *
 * Reading this repository's own source as a fixture is what
 * `conductor/unit/step-matrix.test.ts` and `domain/unit/retired-names.test.ts`
 * already do, and this follows them.
 */
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Recipe } from "../src/recipe.ts";
import {
  assigneeOf,
  backoffOf,
  baseOf,
  baseWrittenAt,
  boundsBesides,
  ceilingOf,
  excludeOf,
  kindsOf,
  limitsFor,
  submodulesOf,
} from "../src/settings.ts";

const WRITTEN = {
  version: 2,
  repo: { base: "develop", submodules: true },
  source: { kinds: ["bug", "tech-debt"], exclude: ["agent:hold"], backoff: "45m" },
  env: { plantAt: ".env.local" },
  runtime: {},
};
const RECIPE: Recipe = Recipe.parse(WRITTEN);

describe("the accessors", () => {
  it("read what the recipe holds today", () => {
    expect(baseOf(RECIPE)).toBe("develop");
    expect(kindsOf(RECIPE)).toEqual(["bug", "tech-debt"]);
    // By identity, and that is the cheap proof of *a recipe nobody edited
    // resolves to the same values*: nothing at `implement` narrows, so the
    // ceiling object itself comes back rather than a copy of its fields.
    expect(limitsFor(RECIPE, "implement")).toBe(RECIPE.runtime.limits);
  });

  /**
   * The three the guard below used to have no accessor for. One per setting
   * 0061 §4 moves, so that the move stays a change to `settings.ts`.
   */
  it("read the other three the same ADR moves", () => {
    expect(submodulesOf(RECIPE)).toBe(true);
    expect(excludeOf(RECIPE)).toEqual(["agent:hold"]);
    expect(backoffOf(RECIPE)).toBe("45m");
  });

  /**
   * **The seventh, and the one whose v1 name is not `source:`'s** (`#244`,
   * 0063 §3). `assignee` is `queue:`'s fourth field and a person writes it in
   * the machine file under `runtime:`, so where it is read from and where it
   * is going are two different keys — which is exactly what the accessor is
   * for. Absent is returned absent: *nothing was written* and *both* are the
   * same behaviour and not the same reading.
   */
  it("reads the `assignee` 0063 §3 adds to that list", () => {
    expect(assigneeOf(RECIPE)).toBeUndefined();

    const mine = Recipe.parse({
      ...WRITTEN,
      runtime: { assignee: { login: "steven-zhc", take: "mine" } },
    });
    expect(assigneeOf(mine)).toEqual({ login: "steven-zhc", take: "mine" });
  });

  /**
   * **The two that have actually moved, read at both of their spellings**
   * (`#268`, 0065).
   *
   * `worktree:`'s fields at `admit` are where 0061 §4 puts the base and the
   * submodules, and `repo:` is the same setting's v1 name — so these two are the
   * first accessors that answer a *step* rather than a block, and they are the
   * proof that the move is a change to `settings.ts` and to nothing else. Every
   * reader downstream — the cut, the merge lane, `lingtai doctor`, `lingtai add`,
   * the board, the wizard — asks the accessor, so there is nowhere for the two
   * spellings to disagree.
   */
  it("read the base and the submodules off `admit` where the recipe declares them", () => {
    const declared = Recipe.parse({
      ...WRITTEN,
      steps: { admit: [{ name: "cut the branch", worktree: { base: "1.0", submodules: false } }] },
    });

    expect(baseOf(declared)).toBe("1.0");
    // `repo.submodules` is `true` in `WRITTEN`, and the declaration is what runs:
    // a step that says is not overridden by the block it replaces.
    expect(submodulesOf(declared)).toBe(false);
    // And the `repo:` block is still there, untouched — one setting, two
    // spellings, and the accessor is the only thing that knows.
    expect(declared.repo).toEqual({ base: "develop", submodules: true });
  });

  /**
   * **A `worktree:` that does not name `submodules` never reaches an accessor**
   * (`#268`).
   *
   * The plugin requires it, so there is no third answer between *the step said*
   * and *`repo:` said*. It used to default to `false`, which made the smallest
   * legal block override `repo.submodules: true` in silence — and the symptom was
   * every test that imports a submodule failing, at `build`, reading as the agent
   * breaking the tests.
   */
  it("refuses a `worktree:` that leaves `submodules` out, rather than defaulting it", () => {
    const silent = Recipe.safeParse({
      ...WRITTEN,
      steps: { admit: [{ name: "cut the branch", worktree: { base: "1.0" } }] },
    });
    expect(silent.success).toBe(false);
    expect(JSON.stringify(silent.error?.issues)).toContain("submodules");
  });

  /**
   * **And the three readings that print the key name get the one the file uses**
   * (`#268`).
   *
   * `baseDivergence`'s refusal, `lingtai doctor`'s base row and `lingtai add`'s
   * disagreement all end with *fix this key* — so a message naming `repo.base` at
   * a recipe that declares `worktree:` at `admit` sends a person to a line the
   * conductor does not read, which is the reader-drift this file's guard is about
   * arriving through a sentence instead.
   */
  it("names the key the recipe actually wrote the base at", () => {
    expect(baseWrittenAt(RECIPE)).toBe("repo.base");
    expect(
      baseWrittenAt(
        Recipe.parse({
          ...WRITTEN,
          steps: {
            admit: [{ name: "cut the branch", worktree: { base: "1.0", submodules: false } }],
          },
        }),
      ),
    ).toContain("worktree.base");
  });

  /** One cut per step, so *the first* and *the only* are the same entry. */
  it("refuses a second `worktree:` at `admit` by name", () => {
    const twice = Recipe.safeParse({
      ...WRITTEN,
      steps: {
        admit: [
          { name: "cut the branch", worktree: { base: "main", submodules: false } },
          { name: "cut from release", worktree: { base: "release", submodules: false } },
        ],
      },
    });
    expect(twice.success).toBe(false);
    const said = JSON.stringify(twice.error?.issues);
    expect(said).toContain("cut from release");
    expect(said).toContain("already cuts a worktree");
  });

  /**
   * **The lane is the last action at `merge`, and the refusal says why rather than
   * where** (0065 §8, `#270`).
   *
   * The second rule in this file about an action's *neighbours*, and it exists for
   * a failure the ordering makes silent: every declared action at a step runs and
   * the step's ending is the pipeline's, so a check written after the lane runs on
   * a change already on the base branch. `endingOf` then reports `merge` refused
   * while the merge stood — no `WorkItemLanded`, `end`'s `when: landed` effects
   * never fired, and the item back in the queue with its diff on `main`.
   *
   * Both rows are the one clause: a second `merge:` is refused by *being after the
   * first* rather than by a count of its own, because two lanes is the second one
   * running over the first one's merge.
   */
  it.each([
    { what: "a check after the lane", after: { name: "smoke", run: "pnpm smoke" } },
    { what: "a second lane", after: { name: "land it again", merge: { strategy: "merge-commit" } } },
  ])("refuses $what at `merge` by name", ({ after }) => {
    const late = Recipe.safeParse({
      ...WRITTEN,
      steps: { merge: [{ name: "land the branch", merge: { strategy: "merge-commit" } }, after] },
    });
    expect(late.success).toBe(false);
    const said = JSON.stringify(late.error?.issues);
    expect(said).toContain(after.name);
    expect(said).toContain("lands the branch at entry 0");
    expect(said).toContain("the lane is the last action a step carries");
    expect(said).toContain("a change already on the base branch");

    // And the same two entries the other way round resolve: a check before the
    // lane is where a reader would write it, and is what the rule asks for.
    expect(
      Recipe.safeParse({
        ...WRITTEN,
        steps: { merge: [{ name: "smoke", run: "pnpm smoke" }, { name: "land the branch", merge: { strategy: "merge-commit" } }] },
      }).success,
    ).toBe(true);
  });

  /**
   * **A written `merge:` with no lane is refused, and the empty one is not**
   * (`#270`).
   *
   * The costly direction of the rule above, and the one that was missing while
   * that one landed: the refusal there is about what comes *after* the lane, so
   * a list with no lane at all walked straight through it. Every declared action
   * at a step runs and the step's ending is the pipeline's, so a `merge:` of
   * green checks reports `merge` **passed** having landed nothing — and then no
   * landing follows either, because the `WorkItemLanded` append is guarded on
   * the lane's own commit: no event, no `endPlan`, and the pass falls through to
   * the failed tail, which releases the ticket so the next pass buys a fresh
   * agent for a diff that is still on the branch. Nothing red, nothing held, a
   * bill every time.
   *
   * `merge: []` is the case that must survive it, because it is what this
   * repository runs on — and it survives as *a step nobody wrote* rather than as
   * *a step that does nothing*: 0065 §6 decides the second and that part is not
   * built, so the seam still reads `[]` as the omitted key and the default lane
   * merges (`conduct-a-whole-pass.test.ts`'s *lands onto main with `merge: []`*).
   * A rule that could not tell *nothing declared* from *checks and no lane*
   * would refuse every recipe here — and a refusal that offered `merge: []` as
   * the way to land nothing would send a person to a list that merges.
   */
  it("refuses a `merge:` that checks and never lands, and keeps `merge: []`", () => {
    const never = Recipe.safeParse({
      ...WRITTEN,
      steps: { merge: [{ name: "smoke", run: "pnpm smoke" }] },
    });
    expect(never.success).toBe(false);
    const said = JSON.stringify(never.error?.issues);
    expect(said).toContain("none of them is the lane");
    expect(said).toContain("pass having landed nothing");
    expect(said).toContain("buys a second agent for the same diff");
    // Before the money: the refusal is the recipe's, not a worktree's.
    expect(said).toContain("before any money");
    // And it does not send them to `merge: []`, which takes the default lane.
    expect(said).toContain("the default lane runs and the branch merges");
    expect(said).toContain("declare a `human:` action at `proposed:`");

    // The empty list is a different statement and still resolves.
    expect(Recipe.safeParse({ ...WRITTEN, steps: { merge: [] } }).success).toBe(true);
    // And so does a step that says nothing at all.
    expect(Recipe.safeParse({ ...WRITTEN, steps: {} }).success).toBe(true);
  });

  /**
   * **The test this replaces was called *answer the same for every step, because
   * the settings have not moved yet***, and its body was
   * `expect(limitsFor(RECIPE, "build")).toEqual(limitsFor(RECIPE, "implement"))`.
   * 0070 §5 moved them; this is its opposite, and it is the unit-level proof of
   * the whole feature (`#314`).
   *
   * Three claims in one recipe, because they are three ways the same reading
   * goes wrong:
   *
   * - a step that narrows answers its own figure, and `build` — which dispatches
   *   nothing — still answers the ceiling;
   * - the narrowing is **field by field**: `turns: 4` without a `wall` keeps the
   *   pass's wall, so a step cannot silently lose a bound by naming one;
   * - `rounds` and `restarts` are untouched, because they count calls and are the
   *   pass's (0040).
   */
  it("answer a step's own bound where a dispatch there narrowed it", () => {
    const narrowed = Recipe.parse({
      ...WRITTEN,
      steps: {
        implement: [{ name: "write it", agent: "claude-code", prompt: "go", limits: { turns: 4 } }],
      },
    });
    expect(limitsFor(narrowed, "implement").turns).toBe(4);
    expect(limitsFor(narrowed, "implement").wall).toBe(ceilingOf(narrowed).wall);
    expect(limitsFor(narrowed, "implement").rounds).toBe(ceilingOf(narrowed).rounds);
    expect(limitsFor(narrowed, "build")).toBe(ceilingOf(narrowed));
  });

  /**
   * **A step's upper bound and never one dispatch's own.**
   *
   * `StepMap` refuses a second `worktree:` or `queue:` at a step and refuses no
   * second `agent:`, so a `review` holding a narrowed entry beside an undeclared
   * one may still spend the ceiling — and a reading that answered `4` there
   * would under-report what a pass can cost, which is the one direction this
   * number must never be wrong in.
   */
  it("answer the maximum where a step holds two dispatches", () => {
    const both = Recipe.parse({
      ...WRITTEN,
      steps: {
        review: [
          { name: "cheap", agent: "claude-code", prompt: "a", limits: { turns: 4 } },
          { name: "whatever the ceiling allows", agent: "claude-code", prompt: "b" },
        ],
      },
    });
    expect(limitsFor(both, "review")).toBe(ceilingOf(both));
  });

  /**
   * **`ceilingOf` is `runtime.limits` and `limitsFor` is not, and `pnpm
   * typecheck` cannot tell them apart** — both return the same type, and four
   * callers write the value they get back into the machine file. This is the
   * assertion that stands in for the compiler (`#314`).
   */
  it("keep the ceiling and a step's bound as two questions", () => {
    expect(ceilingOf(RECIPE)).toBe(RECIPE.runtime.limits);
    const narrowed = Recipe.parse({
      ...WRITTEN,
      steps: {
        implement: [{ name: "write it", agent: "claude-code", prompt: "go", limits: { turns: 4 } }],
      },
    });
    expect(ceilingOf(narrowed).turns).toBe(RECIPE.runtime.limits.turns);
    expect(limitsFor(narrowed, "implement").turns).not.toBe(ceilingOf(narrowed).turns);
  });

  /**
   * What `passCeiling`'s sentence names, and **only steps that dispatch**.
   *
   * `limitsFor` truthfully answers the ceiling for a step with no `agent:` and
   * no runtime `judge:` — nothing there spends anything — so a list built off
   * that alone would print `admit 1h/150 turns` beside a narrowed `implement`,
   * which is a bound on a step that buys no agent at all.
   */
  it("name the dispatching steps whose bound is not the one already printed", () => {
    const mixed = Recipe.parse({
      ...WRITTEN,
      steps: {
        implement: [{ name: "write it", agent: "claude-code", prompt: "go" }],
        review: [{ name: "cold", agent: "claude-code", prompt: "read", limits: { turns: 4 } }],
      },
    });
    expect(boundsBesides(mixed, "implement")).toEqual([
      { step: "review", turns: 4, wall: ceilingOf(mixed).wall },
    ]);
    // A recipe that narrows nothing names nothing, which is what keeps today's
    // sentence character for character (0070 §8).
    expect(boundsBesides(RECIPE, "implement")).toEqual([]);
  });

  it("do not invent a default — a resolved recipe has every value", () => {
    expect(limitsFor(RECIPE, "implement").turns).toBeGreaterThan(0);
    expect(kindsOf(RECIPE).length).toBeGreaterThan(0);
  });
});

/** Every `src/` in the workspace, as paths. */
async function sources(dir: URL): Promise<URL[]> {
  const out: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const at = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) out.push(...(await sources(at)));
    else if (/\.tsx?$/.test(entry.name)) out.push(at);
  }
  return out;
}

/**
 * The seven settings 0061 §4 moves, as the dotted path a reader of one writes.
 *
 * Read off the ADR's own five-line table and not off `settings.ts`: the point
 * of the guard is to fail while an accessor is *missing*, which it cannot do if
 * the list it walks is the list of accessors that exist.
 *
 * **`runtime.assignee` is the seventh, and it arrived from a different ADR**
 * (`#244`, [0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md)
 * §3): `assignee` is a field of `queue:` rather than a plugin beside it, which
 * makes it a setting that moves onto a step exactly as the other six do. It
 * was read by hand in three files — `discover.ts`, the filter's reading and the
 * board's — and none of them was visible to this list, which is `1a7267f`'s
 * lesson arriving a second time: **the list is the ADRs' and not
 * `settings.ts`'s**, so a setting one ADR moves and another names is on it
 * either way.
 *
 * The leading `\w\.` is what makes it a *read*: `recipe.source.kinds` and
 * `parsed.data.repo.base` match, and the same words after a backtick, a quote
 * or a space — which is every mention of them in prose and in a refusal — do
 * not.
 */
const MOVING =
  /\w\.(runtime\.(limits|assignee)|repo\.(base|submodules)|source\.(kinds|exclude|backoff))\b/;

describe("nothing reaches past them", () => {
  it("has no reader of a moving setting outside settings.ts", async () => {
    const root = new URL("../../../", import.meta.url);
    const roots = [new URL("packages/", root), new URL("apps/", root)];
    const reaching: string[] = [];

    for (const at of roots) {
      for (const file of await sources(at)) {
        const path = file.pathname.slice(root.pathname.length);
        // `settings.ts` is the one place that may, and a `src/` path is the
        // only thing this is about: a test may build a recipe by hand.
        //
        // **`recipe.ts` is the second, since `#314`, and it is the declaration
        // rather than a reader.** 0070 §5's narrowing rule is a statement about
        // two sibling keys — a dispatch's `limits:` may not widen
        // `runtime.limits` — and only the schema that declares both can make
        // it. An accessor cannot serve it either: `limitsFor` *applies* the
        // narrowing, so asking it here would be asking the answer about itself.
        // When the setting moves onto `implement`, this file moves with it in
        // the same diff, which is what the guard is for.
        if (
          !path.includes("/src/") ||
          path.endsWith("recipe/src/settings.ts") ||
          path.endsWith("recipe/src/recipe.ts")
        )
          continue;
        const text = await readFile(file, "utf8");
        for (const line of text.split("\n")) {
          // A doc comment naming the old shape is prose, not a reader.
          if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
          if (MOVING.test(line)) reaching.push(`${path}: ${line.trim()}`);
        }
      }
    }

    expect(
      reaching,
      "use the accessors in recipe/src/settings.ts — 0061 §4 and 0063 §3 move all seven of these onto their " +
        "steps, " +
        "and a reader that reaches past the accessor is a file that ticket has to edit",
    ).toEqual([]);
  });
});
