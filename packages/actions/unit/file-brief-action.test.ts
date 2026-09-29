/**
 * The file-brief action — **the other end of the first destination**, and the
 * first thing anywhere that reads a locator (`#301`, 0066 §4, 0069 §4).
 *
 * Three claims are asserted here and the third is the one the ticket is about:
 * the document reaches the agent from the *path* rather than from the copy the
 * pass was carrying; a locator this destination does not understand ends the
 * step by T3's rules with a sentence naming the destination it expected; and the
 * two halves work together — one `design` list and one `implement` list, run
 * through the real pipeline, with the keep and the read over one in-memory tree.
 *
 * The read is a fake throughout, which is 0060 §1 rather than convenience: a
 * real one touches the filesystem, so a test that used one would be an
 * integration test and this file is about what the action *decides*. What the
 * conductor's own read does with the one field is `conduct.ts`'s `read`.
 */
import { describe, expect, it } from "vitest";
import { createFileAction, type KeptAnswer } from "../src/file-action.ts";
import { createFileBriefAction, type ReadAnswer } from "../src/file-brief-action.ts";
import {
  NO_DESIGN,
  runActionPipeline,
  type Action,
  type ActionContext,
  type TheDesign,
} from "../src/action.ts";
import { actionsFromRecipe } from "../src/from-recipe.ts";

const DOCUMENT = "## The shape\n\nSix bodies, one per step, and the seam is `StepWork`.";
/** What the file on the branch says, where the test wants the two to differ. */
const ON_THE_BRANCH = "## The shape\n\nAs kept, and edited since.";

const context = (design?: TheDesign): ActionContext => ({
  runId: "run-abc",
  onSha: "a".repeat(40),
  cwd: "/tmp/wt",
  env: {},
  ...(design === undefined ? {} : { design }),
});

/** A read that records what it was asked and answers what the test wants. */
function reading(answer: ReadAnswer = { document: ON_THE_BRANCH }) {
  const seen: { path: string }[] = [];
  return {
    seen,
    read: async (spec: { path: string }) => {
      seen.push(spec);
      return answer;
    },
  };
}

describe("reading the design back off the locator", () => {
  /**
   * **The whole of what this key buys, in one assertion.** The action is handed
   * a locator, resolves it the way its own destination understands, and answers
   * with what came back — so the entry after it is briefed with the bytes on the
   * branch rather than with the copy `design` handed forward.
   */
  it("reads the path the locator names and answers with what it read", async () => {
    const read = reading();
    const result = await createFileBriefAction({ name: "read the design back" }, read).run(
      context({ document: DOCUMENT, locator: "doc/design/x.md" }),
    );

    expect(read.seen).toEqual([{ path: "doc/design/x.md" }]);
    expect(result.verdict).toBe("passed");
    expect(result.document).toBe(ON_THE_BRANCH);
    // The locator is the one it was handed: this action kept nothing, so it has
    // no new place to report (0069 §5 — the pair travels off one result).
    expect(result.locator).toBe("doc/design/x.md");
  });

  /**
   * **`evidence` is a sentence and not the document**, which is 0066 §3's own
   * rule applied at the other end: an event is written once and replayed on
   * every rebuild, and what a person wants off this card is *the agent was
   * briefed with this much, from there*.
   */
  it("says the size and the path, and never the document", async () => {
    const said = (
      await createFileBriefAction({ name: "read it back" }, reading({ document: DOCUMENT })).run(
        context({ document: "", locator: "doc/design/x.md" }),
      )
    ).evidence;

    expect(said).toBe("read a 67 B design back from `doc/design/x.md`");
    expect(said).not.toContain("Six bodies");
  });

  /**
   * **The half 0069 §4 hands to this plugin.** The pass's copy and the kept one
   * can disagree — a destination that reformatted what it kept, a file edited
   * between the two steps — and *nothing here will tell it*. This action prefers
   * what it read, because declaring it is how a recipe says the file on the
   * branch is the design.
   */
  it("prefers what it read over the copy the pass was carrying", async () => {
    const result = await createFileBriefAction({ name: "read it back" }, reading()).run(
      context({ document: DOCUMENT, locator: "doc/design/x.md" }),
    );

    expect(result.document).toBe(ON_THE_BRANCH);
    expect(result.document).not.toBe(DOCUMENT);
  });

  /**
   * **A locator this destination does not understand fails by T3's rules**, and
   * the sentence says which destination it expected — the Done-when this ticket
   * turns on.
   *
   * `did-not-finish` and never `failed`: `implement` is not one of
   * `REFUSING_STEPS` (0058 §3b), so nothing has been judged and there is nothing
   * a fix round would fix. That is the second of the three rows a destination
   * fails by, and the pass stops for a person.
   *
   * **And it does not fall back to the document.** 0069 §3's *the plugin
   * ignores it and works from `document`* is about a plugin that does not read
   * locators; one declared to read one and passing anyway would be a line in the
   * recipe that bought nothing and said so nowhere (`#61`).
   */
  it.each([
    ["https://confluence.example/pages/123", "a page URL"],
    ["/etc/passwd", "an absolute path"],
    ["~/notes/x.md", "a home directory"],
    ["../../elsewhere/x.md", "a path out of the tree"],
  ])("does not finish on %s, naming the destination it expected", async (locator) => {
    const read = reading();
    const result = await createFileBriefAction({ name: "read it back" }, read).run(
      context({ document: DOCUMENT, locator }),
    );

    expect(result.verdict).toBe("did-not-finish");
    expect(result.evidence).toContain(locator);
    expect(result.evidence).toContain("a `file:` at `design` kept");
    expect(result.evidence).toContain("that destination's own plugin at `implement`");
    expect(result.findings).toEqual([]);
    // Nothing was read, and nothing was handed on — so no later action is
    // briefed with a document this one could not stand behind.
    expect(read.seen).toEqual([]);
    expect(result.document).toBeUndefined();
  });

  /**
   * **A read that failed is `did-not-finish` too, with the read's own words.**
   * The one thing that separates *the design was not kept* from *the design was
   * not read* is the sentence, so it is the filesystem's rather than this
   * action's (0043).
   */
  it("does not finish where the read could not open it", async () => {
    const result = await createFileBriefAction(
      { name: "read it back" },
      reading({ notRead: "ENOENT: no such file or directory" }),
    ).run(context({ document: DOCUMENT, locator: "doc/design/x.md" }));

    expect(result.verdict).toBe("did-not-finish");
    expect(result.evidence).toContain("ENOENT");
    expect(result.evidence).toContain("doc/design/x.md");
  });

  /**
   * **Nothing kept is not a failure, and it changes no fact.** No locator is
   * *no destination was declared at `design`* or *the drafter answered that this
   * change needs none* — one brief to `implement` either way (0058 §3), and the
   * agent gets what it would have got before this key existed.
   */
  it("passes and changes nothing where no destination kept a document", async () => {
    const read = reading();
    const result = await createFileBriefAction({ name: "read it back" }, read).run(
      context(NO_DESIGN),
    );

    expect(read.seen).toEqual([]);
    expect(result.verdict).toBe("passed");
    expect(result.document).toBeUndefined();
    expect(result.locator).toBeUndefined();
    expect(result.evidence).toContain("nothing to read back");
  });

  /**
   * **And a context nothing filled in did not finish**, which is a different
   * fact from the one above: *nobody handed this a design* and *the design step
   * kept nothing* are two things, and folding them would make a `file-brief:`
   * built by hand look like a step that had nothing to do.
   */
  it("does not finish where nothing handed it a design", async () => {
    const result = await createFileBriefAction({ name: "read it back" }, reading()).run(context());

    expect(result.verdict).toBe("did-not-finish");
    expect(result.evidence).toContain("nothing handed");
  });
});

describe("the recipe's own block, built", () => {
  /**
   * **The block `doc/plugins/file-brief.md` shows, built through
   * `actionsFromRecipe`**, so what is asserted is the seam as well: there is no
   * field to read off the action, and the read comes off `deps.fileBrief`.
   */
  it("builds a `file-brief:` with the read from the deps, and reads no field off it", async () => {
    const read = reading();
    const [action, ...rest] = actionsFromRecipe(
      "implement",
      [{ name: "read the design back", "file-brief": true }, { name: "write it", agent: "claude-code", prompt: "" }],
      { fileBrief: read, work: { work: async () => ({ committed: "b".repeat(40) }) } },
    );

    expect(rest).toHaveLength(1);
    expect(action!.kind).toBe("file-brief");
    await action!.run(context({ document: DOCUMENT, locator: "doc/design/x.md" }));
    expect(read.seen).toEqual([{ path: "doc/design/x.md" }]);
  });

  /**
   * **And absent, it is refused by name rather than briefing nothing quietly.**
   * At `implement` an action that passed having read nothing is the agent
   * dispatched on the brief this key was declared to replace, with a card saying
   * it was replaced.
   */
  it("refuses a `file-brief:` by name when no read was supplied", () => {
    expect(() =>
      actionsFromRecipe("implement", [{ name: "read it back", "file-brief": true }], {}),
    ).toThrow(/no read was supplied/);
  });
});

/**
 * **T4 and T5 over one tree** — the pair working end to end, which is the
 * Done-when that no unit of either half can satisfy on its own.
 *
 * Two pipelines, because that is what a pass runs: a `design` list whose drafter
 * makes the document and whose `file:` keeps it, and an `implement` list whose
 * `file-brief:` reads it back and whose agent is dispatched with what it read.
 * The tree between them is a `Map`, so the only thing being asserted is that the
 * *locator* is what carries the document across — not the copy `designFrom`
 * hands forward, which is why the agent's brief is checked against bytes only
 * the keep ever saw.
 */
describe("the two halves of one destination, end to end", () => {
  /** A worktree as a map, and the keep and the read over it. */
  function tree() {
    const files = new Map<string, string>();
    return {
      files,
      keep: async (spec: { path: string; document: string }): Promise<KeptAnswer> => {
        files.set(spec.path, `${spec.document}\n`);
        return { at: spec.path, head: "b".repeat(40) };
      },
      read: async (spec: { path: string }): Promise<ReadAnswer> => {
        const document = files.get(spec.path);
        return document === undefined ? { notRead: `ENOENT: ${spec.path}` } : { document };
      },
      // The keep's other dep since `#310` — the paths in this file carry no
      // `{{issue}}`, so what it answers never reaches one; it is here because a
      // `file:` cannot be built without a ticket to expand from.
      issue: async () => ({ ref: "301" }),
    };
  }

  const drafter = (document: string): Action => ({
    name: "shape it",
    kind: "agent",
    run: async () => ({ verdict: "passed", evidence: "drafted", findings: [], document }),
  });

  /** The implementer, recording the design it was dispatched with. */
  function implementer(briefs: (TheDesign | undefined)[]): Action {
    return {
      name: "write the change",
      kind: "agent",
      run: async (given) => {
        briefs.push(given.design);
        return { verdict: "passed", evidence: "committed", findings: [], head: "c".repeat(40) };
      },
    };
  }

  it("keeps the design at `design` and briefs `implement` with what it reads back", async () => {
    const worktree = tree();
    const briefs: (TheDesign | undefined)[] = [];

    const kept = await runActionPipeline({
      step: "design",
      actions: [
        drafter(DOCUMENT),
        createFileAction({ name: "keep the design", path: "doc/design/x.md" }, worktree),
      ],
      context: context(NO_DESIGN),
      emit: () => {},
    });
    expect(kept.ok).toBe(true);

    // What `designOn` carries to `implement`: the last entry's document and the
    // locator off that same result (0069 §5).
    const last = kept.results.at(-1)!;
    const crossed: TheDesign = { document: last.document!, locator: last.locator! };
    expect(crossed.locator).toBe("doc/design/x.md");

    // **The tree is edited between the steps**, which is the only way to tell
    // the two paths apart: if the brief still said `DOCUMENT` the locator would
    // have carried nothing and the pass would be working from its own copy.
    worktree.files.set("doc/design/x.md", ON_THE_BRANCH);

    const written = await runActionPipeline({
      step: "implement",
      actions: [
        createFileBriefAction({ name: "read the design back" }, worktree),
        implementer(briefs),
      ],
      context: context(crossed),
      emit: () => {},
    });

    expect(written.ok).toBe(true);
    expect(briefs).toEqual([{ document: ON_THE_BRANCH, locator: "doc/design/x.md" }]);
  });

  /**
   * **And the pass stops where the file is not there**, which is the failure
   * this pairing can actually have: the keep said it wrote one and the worktree
   * says otherwise. `did-not-finish`, so the implementer after it never runs —
   * an agent briefed with a design nobody could read is the money 0066 §2 is
   * about, spent on the job this key exists to make smaller.
   */
  it("stops before the agent where the kept file is gone", async () => {
    const worktree = tree();
    const briefs: (TheDesign | undefined)[] = [];

    const written = await runActionPipeline({
      step: "implement",
      actions: [
        createFileBriefAction({ name: "read the design back" }, worktree),
        implementer(briefs),
      ],
      context: context({ document: DOCUMENT, locator: "doc/design/x.md" }),
      emit: () => {},
    });

    expect(written.ok).toBe(false);
    expect(written.didNotFinishAt?.action).toBe("read the design back");
    expect(briefs).toEqual([]);
    expect(written.skipped).toEqual(["write the change"]);
  });

  /**
   * **Two destinations and one read**, which is the arrangement
   * `doc/plugins/file-brief.md`'s third example shows: the locator that crosses
   * is the last one, because that is the result the document came off (0069 §5),
   * so the read is the one that entry named.
   */
  it("reads the last locator, where the step kept the document twice", async () => {
    const worktree = tree();
    const kept = await runActionPipeline({
      step: "design",
      actions: [
        drafter(DOCUMENT),
        createFileAction({ name: "the note in the repository", path: "doc/design/notes.md" }, worktree),
        createFileAction({ name: "and one beside the ticket", path: "doc/design/301.md" }, worktree),
      ],
      context: context(NO_DESIGN),
      emit: () => {},
    });

    const last = kept.results.at(-1)!;
    worktree.files.set("doc/design/301.md", ON_THE_BRANCH);

    const read = await createFileBriefAction({ name: "read the design back" }, worktree).run(
      context({ document: last.document!, locator: last.locator! }),
    );

    expect(read.locator).toBe("doc/design/301.md");
    expect(read.document).toBe(ON_THE_BRANCH);
  });
});
