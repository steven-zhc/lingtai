/**
 * The file action — **the first destination**, and what is asserted here is the
 * two halves 0066 buys: the document reaches a path, and the path comes back as
 * the locator while **this action's** `evidence` is a sentence. What the log
 * still carries from the drafter beside it is the last case in this file.
 *
 * The keep is a fake throughout, which is 0060 §1 rather than convenience: a
 * real one writes to the filesystem and shells out to `git`, so a test that used
 * one would be an integration test and this file is about what the action
 * *decides*. What the conductor's own keep does with the same three fields is
 * `conduct.ts`'s `keep`.
 */
import type { Runtime } from "@lingtai/agent";
import { describe, expect, it } from "vitest";
import { createFileAction, type KeptAnswer } from "../src/file-action.ts";
import { createDraftAction } from "../src/agent-action.ts";
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

/**
 * A keep that records what it was asked and answers what the test wants, with
 * the ticket beside it — `{{issue}}` in the path is expanded from `ref` before
 * anything is kept (`#310`), so the two are one fake and a case can move either.
 */
function keeping(answer: KeptAnswer = { at: "doc/design/x.md" }, ref = "310") {
  const seen: { path: string; document: string }[] = [];
  return {
    seen,
    keep: async (spec: { path: string; document: string }) => {
      seen.push(spec);
      return answer;
    },
    issue: async () => ({ ref }),
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
      { name: "keep the design", path: "doc/design/x.md" },
      kept,
    ).run(context({ document: DOCUMENT }));

    expect(kept.seen).toEqual([{ path: "doc/design/x.md", document: DOCUMENT }]);
    expect(result.verdict).toBe("passed");
    expect(result.document).toBe(DOCUMENT);
    expect(result.locator).toBe("doc/design/x.md");
  });

  /**
   * **This action's `evidence` is a sentence and not the document**, which is
   * half of what 0066 §1 costs: an event is written once and read on every
   * replay of the log. Half, and not the whole — the drafter's own event still
   * carries the document, clipped since §8, which the last case in this file
   * pins so that the page and the header cannot drift back into claiming it.
   *
   * The size and the path, in the words §3's own example uses, and *committed to
   * the branch* — which is the fact a person reads the card for, because it is
   * the only reason the locator will still resolve after the pass.
   */
  it("says the size and the path, and never the document", async () => {
    const said = (
      await createFileAction({ name: "keep it", path: "doc/design/x.md" }, keeping()).run(
        context({ document: DOCUMENT }),
      )
    ).evidence;

    expect(said).toBe("wrote a 67 B design to `doc/design/x.md`, committed to the branch");
    expect(said).not.toContain("Six bodies");
  });

  /**
   * **A commit moves the tree, and the action is what says so.** `head` is
   * `LeftTheTreeAt`'s one seam (`pass.ts`), so a keep that committed reports the
   * commit and `onSha` advances onto the note — otherwise every verdict after
   * `design` would be about a commit that is not the one the steps are reading.
   */
  it("carries the keep's head, and reports none where the keep gave none", async () => {
    const committed = await createFileAction(
      { name: "keep it", path: "doc/design/x.md" },
      keeping({ at: "doc/design/x.md", head: "b".repeat(40) }),
    ).run(context({ document: DOCUMENT }));
    expect(committed.head).toBe("b".repeat(40));

    const loose = await createFileAction(
      { name: "keep it", path: "doc/design/x.md" },
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
      { name: "keep it", path: "doc/design/x.md" },
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
      { name: "keep it", path: "doc/design/x.md" },
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
      { name: "keep it", path: "doc/design/x.md" },
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
        watching("and one beside the ticket", { document: DOCUMENT, locator: "doc/design/300.md" }),
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
   * **The block `doc/plugins/file.md` shows, built through `actionsFromRecipe`**,
   * so what is asserted is the seam as well: the path is read off the action and
   * the keep comes off `deps.file`. One field beside `name`, which is the shape
   * the decision left — the commit is not the recipe's to answer.
   */
  it("reads `file:` off the action, with the keep from the deps", async () => {
    const kept = keeping({ at: "doc/design/300-a-destination.md" });
    const [action, ...rest] = actionsFromRecipe(
      "design",
      [{ name: "keep the note", file: "doc/design/300-a-destination.md" }],
      { file: kept },
    );

    expect(rest).toEqual([]);
    expect(action!.kind).toBe("file");
    await action!.run(context({ document: DOCUMENT }));
    expect(kept.seen).toEqual([
      { path: "doc/design/300-a-destination.md", document: DOCUMENT },
    ]);
  });

  /**
   * **And absent, it is refused by name rather than keeping nothing quietly.** At
   * `design` a destination that passed having written nothing would put a locator
   * on the card pointing at a file that never existed.
   *
   * **This is not a check a person gets before the money** (`#300`'s review).
   * `actionsFromRecipe` has one production call site, `conduct.ts`'s, and
   * `lingtai doctor` resolves the recipe without ever constructing an action — so
   * a keep that went missing surfaces mid-pass, after the claim, the clone and
   * the drafting agent have all been paid for. What makes that tolerable is not
   * that it is the only late refusal — since `#310` the test below is another,
   * and an expansion that escapes is refused after the same money — but that
   * **this one is the caller's defect rather than the operator's**: a `file:`
   * built with no keep is a wiring mistake in `conduct.ts`, which nothing an
   * operator writes can cause and nothing an operator reads can fix. That is
   * why it is a throw and not a verdict, where the escaping expansion is a
   * `did-not-finish` with a sentence on the card.
   */
  it("refuses a `file:` by name when no keep was supplied", () => {
    expect(() =>
      actionsFromRecipe("design", [{ name: "keep it", file: "doc/design/x.md" }], {}),
    ).toThrow(/no keep was supplied/);
  });

  /**
   * **`{{issue}}` in the path becomes the ticket's ref, and the locator is the
   * expanded path** (`#310`) — the whole of what this ticket is for.
   *
   * The `evidence` assertion is the actual subject. A fixed path keeps **one**
   * document, the newest, under a name the log handed to every pass: the
   * sentence on ticket A's `StepPassed` still reads *wrote a 67 B design to
   * `doc/design/this-change.md`* a year later, and what is at that path by then
   * is ticket B's design, with nothing anywhere saying so. Worse than a dead
   * link, because a dead link is obviously dead. So what the sentence has to
   * carry is the expanded path and never the template.
   *
   * Through `actionsFromRecipe`, so the seam is asserted too: the path comes off
   * the recipe as written and the ticket comes off `deps.file`.
   */
  it("expands `{{issue}}` into the path it keeps at, and into the locator", async () => {
    const kept = keeping({ at: "doc/design/300.md" }, "300");
    const [action] = actionsFromRecipe(
      "design",
      [{ name: "keep the note", file: "doc/design/{{issue}}.md" }],
      { file: kept },
    );

    const result = await action!.run(context({ document: DOCUMENT }));
    expect(kept.seen).toEqual([{ path: "doc/design/300.md", document: DOCUMENT }]);
    expect(result.locator).toBe("doc/design/300.md");
    expect(result.evidence).toBe(
      "wrote a 67 B design to `doc/design/300.md`, committed to the branch",
    );
    expect(result.evidence).not.toContain("{{issue}}");
  });

  /**
   * **And an expansion that leaves the worktree is refused before anything is
   * written**, which is the ticket's `Watch out`: `whyThePathEscapes` runs on the
   * written string when the recipe resolves, so a ref carrying `..` would walk
   * out of the tree past a check that had already said yes.
   *
   * `did-not-finish` and not `refused` — `design` is not one of `REFUSING_STEPS`
   * (0058 §3) and this action writes rather than judges — and **the keep was
   * never called**, which is the half that matters: a refusal after the write is
   * a refusal about a file already on disk.
   *
   * Unreachable through the conductor today, because `options.issue` is a number
   * and `took.ticket.ref` is `String(issue.number)`. It is a guard for 0036's
   * named evolution to `{{ref}}`, and a store whose refs read `PROJ-123`.
   */
  it("reports an expansion that escapes, and keeps nothing", async () => {
    const kept = keeping({ at: "doc/design/x.md" }, "../../etc/passwd");
    const [action] = actionsFromRecipe(
      "design",
      [{ name: "keep the note", file: "doc/design/{{issue}}.md" }],
      { file: kept },
    );

    const result = await action!.run(context({ document: DOCUMENT }));
    expect(result.verdict).toBe("did-not-finish");
    expect(result.evidence).toContain('".." segment');
    expect(result.evidence).toContain("doc/design/{{issue}}.md");
    expect(kept.seen, "the keep was called with a path that escapes").toEqual([]);
  });
});

/**
 * **What the log carries after a step that kept, and it is not only the
 * sentence** (`#300`, the fix round).
 *
 * `file-action.ts`'s header and `doc/plugins/file.md` both say that declaring a
 * destination does **not** close 0066 §1, and a claim about the log is worth
 * what can be read off it. One `design` step, the drafter and the destination,
 * and the two `StepPassed` events they append: the destination's is §3's
 * sentence, and the drafter's still carries the document — bounded since §8
 * (`command.ts`), and there whether or not a `file:` was declared beside it.
 *
 * **A real `createDraftAction` and not a stub**, because a stub would assert
 * that the pipeline copies an evidence the test handed it and would say nothing
 * about what the drafter writes. The day that changes, this case is what goes
 * red — and the two documents above it are what it is protecting.
 */
describe("what the drafter's own event still carries", () => {
  const runtime = (text: string): Runtime => ({
    capabilities: {
      id: "claude-code",
      hooks: [],
      canFailClosed: true,
      canRewriteToolCall: false,
      providesTier: "guarded",
      enforces: ["turns", "wall"],
    },
    run: async () => ({
      exitCode: 0,
      turns: 7,
      durationMs: 1234,
      costUsd: 0.42,
      text,
      failure: null,
      sessionId: "s",
    }),
  });

  const drafter = (text: string): Action =>
    createDraftAction(
      { name: "shape it", prompt: "" },
      {
        runtime: runtime(text),
        issue: async () => ({ ref: "300", title: "a destination", body: "keep the design" }),
        diff: async () => "",
        settingsPath: "/tmp/settings.json",
        limits: { turns: 40, wallMs: 60_000, diffBytes: 400_000 },
      },
    );

  it("carries the document, while the destination's event carries the sentence", async () => {
    const passed: { action: string; evidence: string }[] = [];
    await runActionPipeline({
      step: "design",
      actions: [
        drafter(DOCUMENT),
        createFileAction({ name: "keep it", path: "doc/design/x.md" }, keeping()),
      ],
      context: context(NO_DESIGN),
      emit: (event) => {
        if (event.type === "StepPassed") {
          passed.push({ action: event.data.action, evidence: event.data.evidence });
        }
      },
    });

    expect(passed.map((each) => each.action)).toEqual(["shape it", "keep it"]);
    // The half this key buys: the size and the path, and no document.
    expect(passed[1]!.evidence).toBe("wrote a 67 B design to `doc/design/x.md`, committed to the branch");
    expect(passed[1]!.evidence).not.toContain("Six bodies");
    // And the half it does not: the document is on the log anyway, from the
    // action before it — so 0066 §1's third row is bounded (§8) and not gone,
    // and closing it is a change to `createDraftAction`.
    expect(passed[0]!.evidence).toContain("Six bodies");
  });
});
