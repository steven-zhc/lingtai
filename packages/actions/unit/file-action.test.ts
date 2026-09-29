/**
 * The file action — **the first destination**, and what is asserted here is the
 * two halves 0066 buys: the document reaches a path, and the path comes back as
 * the locator while `evidence` goes back to being a sentence.
 *
 * The keep is a fake throughout, which is 0060 §1 rather than convenience: a
 * real one writes to the filesystem and shells out to `git`, so a test that used
 * one would be an integration test and this file is about what the action
 * *decides*. What the conductor's own keep does with the same three fields is
 * `conduct.ts`'s `keep`.
 */
import { describe, expect, it } from "vitest";
import { createFileAction, type KeptAnswer } from "../src/file-action.ts";
import {
  NO_DESIGN,
  runActionPipeline,
  type Action,
  type ActionContext,
  type ActionResult,
  type TheDesign,
} from "../src/action.ts";
import { actionsFromRecipe } from "../src/from-recipe.ts";

const DOCUMENT = "## The shape\n\nSix bodies, one per step, and the seam is `StepWork`.";

const context = (design?: TheDesign): ActionContext => ({
  runId: "run-abc",
  onSha: "a".repeat(40),
  cwd: "/tmp/wt",
  env: {},
  ...(design === undefined ? {} : { design }),
});

/** A keep that records what it was asked and answers what the test wants. */
function keeping(answer: KeptAnswer = { at: "doc/design/x.md" }) {
  const seen: { path: string; document: string; commit: boolean }[] = [];
  return {
    seen,
    keep: async (spec: { path: string; document: string; commit: boolean }) => {
      seen.push(spec);
      return answer;
    },
  };
}

describe("keeping the document the step made", () => {
  /**
   * **The whole of 0066 §3 in one assertion.** The action is handed a document
   * on the context, hands it to the keep, and answers with *both* — the document,
   * because `implement` works from it (0069 §2), and the path, which is the
   * locator the log carries instead of the document.
   */
  it("writes what it was handed and returns the path as the locator", async () => {
    const kept = keeping();
    const result = await createFileAction(
      { name: "keep the design", path: "doc/design/x.md", commit: true },
      kept,
    ).run(context({ document: DOCUMENT }));

    expect(kept.seen).toEqual([{ path: "doc/design/x.md", document: DOCUMENT, commit: true }]);
    expect(result.verdict).toBe("passed");
    expect(result.document).toBe(DOCUMENT);
    expect(result.locator).toBe("doc/design/x.md");
  });

  /**
   * **`evidence` is a sentence and not the document**, which is the cost 0066 §1
   * is about: the whole document used to ride `StepPassed.evidence` uncapped, and
   * an event is read on every replay of the log and written once.
   *
   * The size and the path, in the words §3's own example uses, and the commit
   * said out loud — because *the note is in the change* and *the note is gone with
   * the worktree* are the two different things this action can have done.
   */
  it("says the size, the path and whether it was committed, and never the document", async () => {
    const said = async (commit: boolean) =>
      (
        await createFileAction({ name: "keep it", path: "doc/design/x.md", commit }, keeping()).run(
          context({ document: DOCUMENT }),
        )
      ).evidence;

    expect(await said(true)).toBe(
      "wrote a 67 B design to `doc/design/x.md`, committed to the branch",
    );
    expect(await said(false)).toContain("lives as long as the worktree");
    for (const commit of [true, false]) {
      expect(await said(commit)).not.toContain("Six bodies");
    }
  });

  /**
   * **A commit moves the tree, and the action is what says so.** `head` is
   * `LeftTheTreeAt`'s one seam (`pass.ts`), so a keep that committed reports the
   * commit and `onSha` advances onto the note — otherwise every verdict after
   * `design` would be about a commit that is not the one the steps are reading.
   */
  it("carries the keep's head where it committed, and reports none where it did not", async () => {
    const committed = await createFileAction(
      { name: "keep it", path: "doc/design/x.md", commit: true },
      keeping({ at: "doc/design/x.md", head: "b".repeat(40) }),
    ).run(context({ document: DOCUMENT }));
    expect(committed.head).toBe("b".repeat(40));

    const loose = await createFileAction(
      { name: "keep it", path: "doc/design/x.md", commit: false },
      keeping({ at: "doc/design/x.md" }),
    ).run(context({ document: DOCUMENT }));
    // Absent, and not an explicit `undefined`: `headFrom` reads it with
    // `!== undefined`, so an invented key would advance `onSha` to nothing.
    expect("head" in loose).toBe(false);
  });

  /**
   * **Nothing to keep is an answer, and it keeps nothing** (0058 §3: *or nothing,
   * which is an answer*). `NO_DESIGN` is what the drafter returns when it judged
   * that this change needs no design, and a file written for it would be an empty
   * file in the diff under a locator pointing at nothing anybody wants.
   *
   * Silent rather than reporting: no `document` and no `locator` on the result, so
   * `designFrom` reads the drafter's own answer and the destination changes no
   * fact (0069 §5).
   */
  it("keeps nothing where the drafter answered that none was needed", async () => {
    const kept = keeping();
    const result = await createFileAction(
      { name: "keep it", path: "doc/design/x.md", commit: true },
      kept,
    ).run(context(NO_DESIGN));

    expect(kept.seen).toEqual([]);
    expect(result.verdict).toBe("passed");
    expect(result.document).toBeUndefined();
    expect(result.locator).toBeUndefined();
    expect(result.evidence).toContain("nothing to keep");
  });

  /**
   * **A destination that was handed no design at all did not finish**, and it is
   * a different fact from the one above: *nobody drafted* and *the drafter
   * answered none was needed* are two things, and folding them would make a
   * `file:` with nothing before it look like a step that had nothing to do.
   *
   * The recipe cannot reach this — `actionsAt` refuses a `file:` at entry 0 — so
   * what it is about is a context somebody built in code.
   */
  it("does not finish where nothing handed it a design", async () => {
    const result = await createFileAction(
      { name: "keep it", path: "doc/design/x.md", commit: true },
      keeping(),
    ).run(context());

    expect(result.verdict).toBe("did-not-finish");
    expect(result.evidence).toContain("nothing handed");
  });

  /**
   * **A write that failed is `did-not-finish` and never `failed`.** `design` is
   * not one of `REFUSING_STEPS` (0058 §3), so there is no judgement here to
   * refuse with: nothing about the change has been weighed, so no fix round is
   * bought and the pass stops for a person — 0066 §7's second row.
   */
  it("does not finish where the keep could not write, rather than refusing", async () => {
    const result = await createFileAction(
      { name: "keep it", path: "doc/design/x.md", commit: true },
      keeping({ notKept: "EACCES: permission denied" }),
    ).run(context({ document: DOCUMENT }));

    expect(result.verdict).toBe("did-not-finish");
    expect(result.evidence).toContain("EACCES");
    expect(result.evidence).toContain("doc/design/x.md");
    expect(result.findings).toEqual([]);
  });
});

/**
 * **The one thing the plugin could not exist without**, and it is in the pipeline
 * rather than in the action: a destination keeps what an *earlier entry at the
 * same step* made, and until `#300` nothing carried that across.
 *
 * `runStep` fills `ActionContext.design` in from the last `design` **visit**
 * (`designOn`), which is the right answer at `implement` and is `NO_DESIGN` at
 * `design` itself — where the step is still producing one. So a `file:` handed
 * only that would have written an empty file every pass, which is the whole of
 * 0066 §5 unbuildable.
 */
describe("the step's own list hands a document forward", () => {
  const drafting = (result: Partial<ActionResult> & { verdict: ActionResult["verdict"] }): Action => ({
    name: "shape it",
    kind: "agent",
    run: async () => ({ evidence: "drafted", findings: [], ...result }),
  });

  /** Runs a two-entry `design` list and reports what the second was handed. */
  async function handedToTheSecond(first: Action, second: Action) {
    await runActionPipeline({
      step: "design",
      actions: [first, second],
      context: context(NO_DESIGN),
      emit: () => {},
    });
  }

  /**
   * **The drafter's document, and the locator off the same result.** Read exactly
   * as `designFrom` reads the results, so the value a later action is handed is
   * the one the step will end with.
   */
  it("hands a destination what the drafter made", async () => {
    const seen: (TheDesign | undefined)[] = [];
    await handedToTheSecond(
      drafting({ verdict: "passed", document: DOCUMENT }),
      { name: "keep it", kind: "file", run: async (given) => { seen.push(given.design); return { verdict: "passed", evidence: "kept", findings: [] }; } },
    );

    expect(seen).toEqual([{ document: DOCUMENT }]);
  });

  /**
   * **And it is the last document, with its own locator.** Two destinations are a
   * legal list (0066 §5 — a plugin per destination, not a field with a list), and
   * the second is handed what the first answered: the same document, now with the
   * first's path beside it. Pairing a locator with somebody else's document is
   * what 0069 §5 refuses, and it would start here if the pair were carried apart.
   */
  it("advances the pair together, so a second destination sees the first's locator", async () => {
    const seen: (TheDesign | undefined)[] = [];
    const watching = (name: string, answer: Partial<ActionResult>): Action => ({
      name,
      kind: "file",
      run: async (given) => {
        seen.push(given.design);
        return { verdict: "passed", evidence: "kept", findings: [], ...answer };
      },
    });
    await runActionPipeline({
      step: "design",
      actions: [
        drafting({ verdict: "passed", document: DOCUMENT }),
        watching("the note", { document: DOCUMENT, locator: "doc/design/notes.md" }),
        watching("and a copy", { document: DOCUMENT, locator: ".lingtai-design.md" }),
      ],
      context: context(NO_DESIGN),
      emit: () => {},
    });

    expect(seen).toEqual([
      { document: DOCUMENT },
      { document: DOCUMENT, locator: "doc/design/notes.md" },
    ]);
  });

  /**
   * **A result that carried no document changes nothing**, which is what keeps
   * this from being a second source of truth for the design: a `run:` or a `watch:`
   * beside the drafter leaves what the step has made alone, and an action reporting
   * a locator with no document is silent here exactly as it is in `designFrom`.
   */
  it("leaves the design alone where an action reported none", async () => {
    const seen: (TheDesign | undefined)[] = [];
    await handedToTheSecond(
      drafting({ verdict: "passed", evidence: "checked something" }),
      { name: "keep it", kind: "file", run: async (given) => { seen.push(given.design); return { verdict: "passed", evidence: "kept", findings: [] }; } },
    );

    expect(seen).toEqual([NO_DESIGN]);
  });
});

describe("the recipe's own block, built", () => {
  /**
   * **The uncommitted brief, which is the example `doc/plugins/file.md` shows.**
   *
   * `commit: false` is a real answer and not a lesser one: `build` and `review`
   * read the working tree, so a one-ticket brief is readable by both gates and is
   * in nobody's diff — and it is gone with the worktree, which is the half the
   * page says out loud so that nobody reaches for it to *keep* anything.
   *
   * Through `actionsFromRecipe`, so what is asserted is the seam as well: the
   * field is read off the action and the keep comes off `deps.file`.
   */
  it("reads `file:` and `commit:` off the action, with the keep from the deps", async () => {
    const kept = keeping({ at: ".lingtai-design.md" });
    const [action, ...rest] = actionsFromRecipe(
      "design",
      [{ name: "keep it for this pass", file: ".lingtai-design.md", commit: false }],
      { file: kept },
    );

    expect(rest).toEqual([]);
    expect(action!.kind).toBe("file");
    await action!.run(context({ document: DOCUMENT }));
    expect(kept.seen).toEqual([
      { path: ".lingtai-design.md", document: DOCUMENT, commit: false },
    ]);
  });

  /**
   * **And absent, it is refused by name rather than keeping nothing quietly.** A
   * `lingtai doctor` builds actions to check that a recipe *can* be built and has
   * no machine to write on; at `design` a destination that passed having written
   * nothing would put a locator on the card pointing at a file that never existed.
   */
  it("refuses a `file:` by name when no keep was supplied", () => {
    expect(() =>
      actionsFromRecipe("design", [{ name: "keep it", file: "doc/design/x.md", commit: true }], {}),
    ).toThrow(/no keep was supplied/);
  });
});
