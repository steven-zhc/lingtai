/**
 * **The `design:` block this repository intends to declare, resolved** (`#302`,
 * T6 of `#295`).
 *
 * `#302`'s *Watch out* is the whole reason this file exists: a recipe change on a
 * live queue that the schema refuses costs one claim, one worktree and one paid
 * agent, and then a person answering a refusal a schema line could have printed
 * (0066 §6, as corrected by `#299`). The block a person is told to paste is
 * therefore not prose here — it is read out of
 * `doc/experiments/015-does-a-design-make-the-implementing-run-smaller.md`,
 * spliced into this repository's own recipe and put through the real
 * `resolveSource`.
 *
 * **The document is the block and this is not a copy of it**, which is
 * `tamper-watch.test.ts`'s arrangement for the same reason: there is nowhere else
 * for the block to be taken out of, so an edit to the document is an edit to what
 * this test judges and there is no second copy to drift from.
 *
 * What it cannot assert is that the *machine's* file resolves — that file is
 * outside every worktree (0046 §3) and carries `build:` and `review:` blocks the
 * repository's copy does not. What it does assert is the block itself, in a valid
 * recipe: the fields, their order, and the plugin's own `at`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RECIPE_PATH, resolveSource } from "@lingtai/recipe";

const root = new URL("../../../", import.meta.url);
const EXPERIMENT = "doc/experiments/015-does-a-design-make-the-implementing-run-smaller.md";

/**
 * The block as the experiment publishes it — sliced from `  design:` so the
 * commented heading above it in the document is not spliced into YAML, and
 * indented to sit directly under `steps:`.
 */
function documented(): string {
  const md = readFileSync(new URL(EXPERIMENT, root), "utf8");
  const fence = md.match(/```yaml\n([\s\S]*?)```/);
  if (fence === null) throw new Error(`${EXPERIMENT} has no yaml block — the block has no home`);
  const at = fence[1]!.indexOf("  design:");
  if (at === -1) throw new Error(`${EXPERIMENT}'s first yaml block does not declare \`design:\``);
  return fence[1]!.slice(at);
}

/** The documented block, in this repository's own recipe, resolved by the real schema. */
function resolved() {
  const live = readFileSync(new URL(RECIPE_PATH, root), "utf8");
  const spliced = live.replace(/^steps:\n/m, `steps:\n${documented()}`);
  if (spliced === live) throw new Error(`${RECIPE_PATH} has no \`steps:\` to splice into`);
  return resolveSource(spliced, "main", EXPERIMENT).recipe;
}

describe("the `design:` block 015 publishes", () => {
  /**
   * **It resolves**, which is the claim the live queue would otherwise test. A
   * plugin declared at a step it does not serve, a field it does not understand,
   * a path that leaves the worktree — all of them are refused when the recipe
   * resolves, and all of them fail here instead.
   */
  it("resolves in this repository's own recipe", () => {
    expect(resolved().steps.design).toHaveLength(2);
  });

  /**
   * **The drafter first and the keep second, because that order is the
   * contract.** `file:` keeps what an earlier entry at the same step made, so one
   * written first would pass having written no file and returned no locator —
   * refused by `filePlugin`, and the reason the document's block cannot be
   * reordered by somebody tidying it.
   */
  it("drafts before it keeps, and names the runtime the conductor runs", () => {
    const [drafter, keep] = resolved().steps.design;
    expect(drafter).toMatchObject({ agent: "claude-code" });
    expect("file" in drafter!).toBe(false);
    expect(keep).toMatchObject({ file: expect.stringContaining("doc/design/") });
  });

  /**
   * **`prompt:` carries the project's half and not the step's.** What is written
   * in the recipe arrives as a trailing `## Also for this project` section of
   * `buildDesignPrompt`, so a block that restated *answering with nothing is a
   * real answer* or *do not edit the worktree* would pay for the built-in twice
   * in one context window. Pinned as *it says something, and it does not say the
   * built-in's sentences*.
   */
  it("gives the drafter a project prompt that does not restate the built-in", () => {
    const [drafter] = resolved().steps.design;
    const prompt = (drafter as { prompt?: string }).prompt ?? "";
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("file.ts:line");
    expect(prompt).not.toContain("Reply with the document and nothing else");
    expect(prompt).not.toContain("Do not change it");
  });

  /**
   * **`implement` stays undeclared**, which is §1 of the document: the document
   * and the locator both cross the boundary (0069 §2), so `file-brief:` buys only
   * reading the note back off the branch — and declaring it would force an
   * explicit `agent:` at `implement` beside it, since a `file-brief:` written last
   * in a step's list is refused. A second thing to get wrong in the change whose
   * purpose is one number.
   */
  it("declares nothing at `implement`, so the measurement has one moving part", () => {
    expect(resolved().steps.implement).toEqual([]);
  });
});
