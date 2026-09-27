/**
 * **The one place the wizard argues, and the one thing `#263` made it argue
 * about wrongly.**
 *
 * `nothingReadsIt` is the last screen's sentence: *an agent writes code,
 * nothing checks it, it lands in the base branch, nobody read it.* It read
 * `steps.proposed` and `steps.merge` and nothing else, which was every step
 * that could judge a diff until `run:` opened at `build` — and the recipe
 * `#263` asks an operator to paste puts `pnpm typecheck && pnpm test` at
 * `build:` and leaves `proposed: []`. Two keys read, and a project with a
 * build gate on every pass is told nothing checks it, with the remedy offered
 * being *declare a check at `proposed`* — undoing the move.
 *
 * So the assertion is one per judging step rather than one about the pair.
 * Pure: a recipe value in, a sentence or null out.
 *
 * Its integration half — the wizard with a real client and a real file — stays
 * in `integration/wizard.test.ts`; nothing here reaches a dependency, and the
 * guard is the part worth having in the fast suite.
 */
import { describe, expect, it } from "vitest";
import { Recipe } from "@lingtai/recipe";
import { nothingReadsIt } from "../src/wizard.ts";

const CHECK = { name: "build", run: "pnpm typecheck && pnpm test", timeout: "20m", env: [] };

/** A recipe with exactly the steps given, and `develop` as the base. */
const withSteps = (steps: Record<string, object[]>) =>
  Recipe.parse({
    version: 2,
    repo: { base: "develop" },
    source: { kinds: ["bug", "feature"], exclude: ["agent:hold"] },
    env: { required: [], plantAt: ".env.local" },
    steps,
    runtime: { agent: "claude-code" },
  });

describe("nothingReadsIt", () => {
  it("says nothing reads it when no step does", () => {
    expect(nothingReadsIt(withSteps({}))).toContain("straight into `develop`");
  });

  /**
   * **`build` is the row this test exists for.** It is the placement `#263`
   * prescribes, and before the guard was widened this case returned the
   * warning with a full gate running.
   */
  it("is silent when the check is at `build`, which is where `#263` puts it", () => {
    const moved = withSteps({ build: [CHECK], proposed: [], merge: [] });
    expect(moved.steps.build).toHaveLength(1);
    expect(moved.steps.proposed).toHaveLength(0);
    expect(nothingReadsIt(moved)).toBeNull();
  });

  it("is silent when the check is at `proposed`, as every recipe had it", () => {
    expect(nothingReadsIt(withSteps({ proposed: [CHECK] }))).toBeNull();
  });

  it("is silent when a person approves at `merge`", () => {
    expect(nothingReadsIt(withSteps({ merge: [{ name: "approve", human: "ship it?" }] }))).toBeNull();
  });

  /**
   * `prepared` is the step deliberately left out: it runs before `implement`,
   * so whatever it checks is not what the agent wrote. A recipe that installs
   * dependencies there and checks nothing after is exactly the case the
   * sentence is for.
   */
  it("still argues when the only action runs before the agent does", () => {
    const before = withSteps({ prepared: [{ name: "install", run: "pnpm install", timeout: "20m", env: [] }] });
    expect(before.steps.prepared).toHaveLength(1);
    expect(nothingReadsIt(before)).toContain("straight into `develop`");
  });
});
