/**
 * Writing a recipe down without losing its reasons (#162). The test that is the
 * ticket is the first one: this repository's own recipe, one field changed, and
 * `git diff` shows that line and nothing else.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseDocument, isMap, isScalar, type Node, type YAMLMap } from "yaml";
import { CommentWouldBeLostError, Recipe, editRecipe, emitRecipe, type RecipeChange } from "../src/index.ts";

const OWN = readFileSync(new URL("../../../.lingtai/config.yaml", import.meta.url), "utf8");
type Step = Record<string, unknown>;
const own = parse(OWN) as { source: { exclude: string[] }; steps: { proposed: Step[]; prepared: Step[] } };
const LABELS = own.source.exclude;
const [BUILD, REVIEW] = own.steps.proposed as [Step, Step];

/** What `git diff` says moved between two versions of a file: its `-` and `+` lines. */
function gitDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "lingtai-recipe-"));
  writeFileSync(join(dir, "a.yaml"), before);
  writeFileSync(join(dir, "b.yaml"), after);
  let text = "";
  try {
    execFileSync("git", ["diff", "--no-index", "--no-color", "-U0", "a.yaml", "b.yaml"], { cwd: dir, encoding: "utf8" });
  } catch (error) {
    // `git diff --no-index` exits 1 when the files differ.
    text = (error as { stdout: string }).stdout;
  }
  const lines = text.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
  return {
    removed: lines.filter((l) => l.startsWith("-")).map((l) => l.slice(1)),
    added: lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1)),
  };
}

function commentCount(text: string): number {
  return text.split("\n").filter((l) => /^\s*#/.test(l)).length;
}

describe("editRecipe, on this repository's own recipe", () => {
  it("round-trips it with one field changed, and git diff shows only that line", () => {
    const out = editRecipe(OWN, [{ path: ["runtime", "limits", "turns"], value: 200 }]);
    expect(gitDiff(OWN, out)).toEqual({ removed: ["    turns: 150"], added: ["    turns: 200"] });
    expect(Recipe.parse(parse(out)).runtime.limits.turns).toBe(200);
  });

  it("changes nothing when nothing is changed, byte for byte", () => {
    expect(editRecipe(OWN, [])).toBe(OWN);
    expect(editRecipe(OWN, [{ path: ["runtime", "limits", "turns"], value: 150 }])).toBe(OWN);
    expect(editRecipe(OWN, [{ path: ["source", "exclude"], value: LABELS }])).toBe(OWN);
  });

  const cases: { name: string; change: RecipeChange; removed: string[]; added: string[] }[] = [
    {
      name: "a duration with a paragraph above it",
      change: { path: ["source", "backoff"], value: "2h" },
      removed: ["  backoff: 1h"],
      added: ["  backoff: 2h"],
    },
    {
      name: "a flow list, reordered",
      change: { path: ["source", "kinds"], value: ["bug", "feature", "tech-debt"] },
      removed: ["  kinds: [bug, tech-debt, feature]"],
      added: ["  kinds: [bug, feature, tech-debt]"],
    },
    {
      name: "a block list with comments between its items, one label added",
      change: { path: ["source", "exclude"], value: [...LABELS, "wontfix"] },
      removed: [],
      added: ["    - wontfix"],
    },
    {
      name: "a block list with comments between its items, an uncommented label removed",
      change: { path: ["source", "exclude"], value: LABELS.filter((l) => l !== "agent:wip") },
      removed: ["    - agent:wip"],
      added: [],
    },
    {
      name: "a label renamed where it stands, by its path",
      change: { path: ["source", "exclude", LABELS.indexOf("epic")], value: "epic2" },
      removed: ["    - epic"],
      added: ["    - epic2"],
    },
    {
      name: "a gate renamed where it stands, by its path",
      change: { path: ["steps", "proposed", 0, "name"], value: "tests" },
      removed: ["    - name: build"],
      added: ["    - name: tests"],
    },
    {
      name: "the merge point, from nothing to a person",
      change: { path: ["steps", "merge"], value: [{ name: "approve", human: "Does this merge?" }] },
      removed: ["  merge: []"],
      added: ["  merge:", "    - name: approve", "      human: Does this merge?"],
    },
    {
      name: "a key the file does not have yet",
      change: { path: ["runtime", "tier"], value: "guarded" },
      removed: [],
      added: ["  tier: guarded"],
    },
  ];

  it.each(cases)("$name: only the changed lines move", ({ change, removed, added }) => {
    const out = editRecipe(OWN, [change]);
    expect(gitDiff(OWN, out)).toEqual({ removed, added });
    expect(commentCount(out)).toBe(commentCount(OWN));
    const doc = parseDocument(OWN);
    doc.setIn(change.path, change.value);
    expect(Recipe.parse(parse(out))).toEqual(Recipe.parse(doc.toJS()));
  });

  it("makes several changes at once and moves only their lines", () => {
    const out = editRecipe(OWN, [
      { path: ["runtime", "limits", "rounds"], value: 2 },
      { path: ["runtime", "limits", "restarts"], value: 0 },
      { path: ["repo", "base"], value: "develop" },
    ]);
    expect(gitDiff(OWN, out)).toEqual({
      removed: ["  base: main", "    rounds: 3", "    restarts: 1"],
      added: ["  base: develop", "    rounds: 2", "    restarts: 0"],
    });
  });

  it("keeps a comment on the very field being changed, and the one on the line after it", () => {
    const annotated = OWN.replace(
      "  kinds: [bug, tech-debt, feature]\n",
      "  kinds: [bug, tech-debt, feature] # order is priority\n  # the line after\n",
    ).replace("  backoff: 1h\n", "  backoff: 1h # what one failure waits\n  # also the line after\n");
    expect(annotated).not.toBe(OWN);

    const out = editRecipe(annotated, [
      { path: ["source", "kinds"], value: ["feature", "bug"] },
      { path: ["source", "backoff"], value: "30m" },
    ]);
    expect(gitDiff(annotated, out)).toEqual({
      removed: ["  kinds: [bug, tech-debt, feature] # order is priority", "  backoff: 1h # what one failure waits"],
      added: ["  kinds: [feature, bug] # order is priority", "  backoff: 30m # what one failure waits"],
    });
  });

  it("keeps the comments above, beside and after a flow list that becomes a block", () => {
    const annotated = OWN.replace("  merge: []\n", "  # holds nothing\n  merge: [] # nobody holds it\n  # after merge\n");
    const out = editRecipe(annotated, [{ path: ["steps", "merge"], value: [{ name: "a person", human: "Merge?" }] }]);
    // The comment that was beside `[]` is on a line of its own now, and still under `merge:`.
    expect(commentCount(out)).toBe(commentCount(annotated) + 1);
    expect(out).toContain(
      "  # holds nothing\n  merge:\n    # nobody holds it\n    - name: a person\n      human: Merge?\n  # after merge\n",
    );
  });

  /** Each item's text with the comment lines directly above it, in file order. */
  function chunks(text: string, path: string[]): string[] {
    const seq = parseDocument(text).getIn(path, true) as { items: Node[] };
    return seq.items.map((item) => {
      const lines = text.slice(0, text.lastIndexOf("\n", item.range![0] - 1) + 1).split("\n").slice(0, -1);
      const above: string[] = [];
      while (lines.length > 0 && /^\s*#/.test(lines[lines.length - 1]!)) above.unshift(lines.pop()!);
      const end = text.indexOf("\n", item.range![1] - 1);
      return [...above, text.slice(text.lastIndexOf("\n", item.range![0] - 1) + 1, end)].join("\n").trimEnd();
    });
  }

  it("moves a reordered gate with the comments above and inside it", () => {
    const before = chunks(OWN, ["steps", "proposed"]);
    const out = editRecipe(OWN, [{ path: ["steps", "proposed"], value: [REVIEW, BUILD] }]);
    expect(chunks(out, ["steps", "proposed"])).toEqual([before[1], before[0]]);
    expect(commentCount(out)).toBe(commentCount(OWN));
  });

  it("moves a rotated label with the comment above it", () => {
    const before = chunks(OWN, ["source", "exclude"]);
    const rotated = [LABELS[LABELS.length - 1]!, ...LABELS.slice(0, -1)];
    const out = editRecipe(OWN, [{ path: ["source", "exclude"], value: rotated }]);
    expect(chunks(out, ["source", "exclude"])).toEqual([before[before.length - 1], ...before.slice(0, -1)]);
    expect(commentCount(out)).toBe(commentCount(OWN));
  });

  it("rewrites a block-scalar prompt in place, deeper than its key", () => {
    const multi = editRecipe(OWN, [{ path: ["steps", "proposed", 1, "prompt"], value: "line one\nline two\n" }]);
    expect(multi).toContain("      prompt: |\n        line one\n        line two\n");
    expect(commentCount(multi)).toBe(commentCount(OWN));
  });

  it("removes a label named by its path together with the comment that explains it", () => {
    const out = editRecipe(OWN, [{ path: ["source", "exclude", LABELS.indexOf("epic")], value: undefined }]);
    const { removed, added } = gitDiff(OWN, out);
    expect(added).toEqual([]);
    expect(removed[0]).toBe("    # An epic is a table of contents, not work. `#126` was claimed on");
    expect(removed[removed.length - 1]).toBe("    - epic");
    expect(removed.slice(0, -1).every((l) => /^\s*#/.test(l))).toBe(true);
  });

  it("removes a field named by its path together with the comment that explains it", () => {
    const out = editRecipe(OWN, [{ path: ["source", "backoff"], value: undefined }]);
    expect(out).not.toContain("How long a failed attempt keeps its own ticket out of the queue");
    expect(gitDiff(OWN, out).removed.filter((l) => l !== "" && !/^\s*#/.test(l))).toEqual(["  backoff: 1h"]);
  });

  // `yaml` reads both of these comments onto the list beside them, not the line below.
  it("removes a first gate with the paragraph between `proposed:` and it", () => {
    const out = editRecipe(OWN, [{ path: ["steps", "proposed", 0], value: undefined }]);
    const { removed, added } = gitDiff(OWN, out);
    expect(added).toEqual([]);
    expect(removed[0]).toBe("    # `env: []` is written out rather than left to the default, for the reason");
    expect(removed).toContain("    - name: build");
    expect(out).toContain("  proposed:\n    # The cold reviewer, on from 2026-09-09.");
  });

  it("removes `merge` with the paragraph above it, which yaml reads as the end of the list before", () => {
    const out = editRecipe(OWN, [{ path: ["steps", "merge"], value: undefined }]);
    const { removed, added } = gitDiff(OWN, out);
    expect(added).toEqual([]);
    expect(removed.filter((l) => !/^\s*(#.*)?$/.test(l))).toEqual(["  merge: []"]);
    expect(removed).toContain("  # Nothing holds here any more, and this is the moment the previous version of");
    expect(out).toContain("    # this on: there, a watched path is rare and a hold means something.\n\n  end:\n");
  });

  it("moves a gate to the end with the paragraph that was between `proposed:` and it", () => {
    const out = editRecipe(OWN, [{ path: ["steps", "proposed"], value: [REVIEW, BUILD] }]);
    expect(out).toContain("  proposed:\n    # The cold reviewer, on from 2026-09-09.");
    expect(out).toMatch(/# extension may not name one of Lingtai's own\.\n    - name: build\n/);
  });

  it("keeps a file's CRLF line endings, on a changed line and on a new one", () => {
    const crlf = OWN.replace(/\n/g, "\r\n");
    for (const change of [
      { path: ["runtime", "limits", "turns"], value: 200 },
      { path: ["runtime", "tier"], value: "guarded" },
    ]) {
      expect(editRecipe(crlf, [change])).toBe(editRecipe(OWN, [change]).replace(/\n/g, "\r\n"));
    }
  });

  it("adds a key to the last block of a file with no final newline, and adds none", () => {
    const change = { path: ["runtime", "tier"], value: "guarded" };
    const nonl = OWN.replace(/\n$/, "");
    expect(editRecipe(nonl, [change])).toBe(editRecipe(OWN, [change]).replace(/\n$/, ""));
    const both = OWN.replace(/\n/g, "\r\n").replace(/\r\n$/, "");
    expect(editRecipe(both, [change])).toBe(editRecipe(OWN, [change]).replace(/\n/g, "\r\n").replace(/\r\n$/, ""));
  });

  // `proposed` holds the commented-out `tamper` block, and the rendering drops
  // a blank line inside it — so the removed region cannot be put onto the file.
  it("names the change and what to do when a changed line has no line in the file to land on", () => {
    const remove = () => editRecipe(OWN, [{ path: ["steps", "proposed"], value: undefined }]);
    expect(remove).toThrow(/^the change to steps\.proposed could not be carried onto the file exactly/);
    expect(remove).toThrow(/try again, or make this change by hand$/);
  });

  it("refuses an edit that would not be a recipe, rather than writing it", () => {
    expect(() => editRecipe(OWN, [{ path: ["source", "kinds"], value: [] }])).toThrow();
    expect(() => editRecipe(OWN, [{ path: ["steps", "merg"], value: [] }])).toThrow();
  });
});

/**
 * A whole list given as a value never pairs an old item with a new one by
 * position or by a name. These are the three ways attempt 1 of #162 handed one
 * item's explanation to another, or dropped it, and reported success.
 */
describe("editRecipe never guesses which item a comment belongs to", () => {
  it("refuses a label renamed in the same list that drops another, rather than moving the epic's reason onto agent:wip", () => {
    const value = ["blocked", "in-progress", "agent:hold", "agent:blocked", "agent:review", "epic2"];
    const edit = () => editRecipe(OWN, [{ path: ["source", "exclude"], value }]);
    expect(edit).toThrow(CommentWouldBeLostError);
    expect(edit).toThrow(/source\.exclude\.6 carries a comment \("An epic is a table of contents/);
  });

  it("does that edit when the rename is said by path, and the epic's reason stays with epic2", () => {
    const out = editRecipe(OWN, [
      { path: ["source", "exclude", LABELS.indexOf("epic")], value: "epic2" },
      { path: ["source", "exclude"], value: ["blocked", "in-progress", "agent:hold", "agent:blocked", "agent:review", "epic2"] },
    ]);
    expect(gitDiff(OWN, out)).toEqual({ removed: ["    - agent:wip", "    - epic"], added: ["    - epic2"] });
    expect(out).toMatch(/same one `recipe\.ts:172` makes[^\n]*\n[^\n]*\n    - epic2\n/);
  });

  it("refuses a different gate in place of a commented one, rather than letting it inherit the reviewer's comments", () => {
    const lint = { name: "lint", run: "pnpm lint", timeout: "5m", env: [] };
    expect(() => editRecipe(OWN, [{ path: ["steps", "proposed"], value: [BUILD, lint] }])).toThrow(
      /steps\.proposed\.1 carries a comment/,
    );
    const byIndex = () => editRecipe(OWN, [{ path: ["steps", "proposed", 1], value: lint }]);
    expect(byIndex).toThrow(CommentWouldBeLostError);
    expect(byIndex).toThrow(/steps\.proposed\.1 carries a comment \("The cold reviewer/);
    expect(byIndex).not.toThrow(/by their own paths/);

    // The same swap made field by field is the same different gate.
    const byFields = () =>
      editRecipe(OWN, [
        { path: ["steps", "proposed", 1, "name"], value: "lint" },
        { path: ["steps", "proposed", 1, "agent"], value: undefined },
        { path: ["steps", "proposed", 1, "run"], value: "pnpm lint" },
      ]);
    expect(byFields).toThrow(CommentWouldBeLostError);
    expect(byFields).toThrow(/steps\.proposed\.1 carries a comment \("The cold reviewer/);
    // Keeping the name does not make a run gate the reviewer.
    expect(() =>
      editRecipe(OWN, [
        { path: ["steps", "proposed", 1, "agent"], value: undefined },
        { path: ["steps", "proposed", 1, "run"], value: "pnpm lint" },
      ]),
    ).toThrow(CommentWouldBeLostError);

    // What the refusal says to do: the reviewer goes with its paragraph, and lint arrives bare.
    const out = editRecipe(OWN, [
      { path: ["steps", "proposed", 1], value: undefined },
      { path: ["steps", "proposed", 1], value: lint },
    ]);
    expect(out).not.toContain("The cold reviewer");
    expect(out).toMatch(/      env: \[\]\n    - name: lint\n      run: pnpm lint\n/);
  });

  it("puts a different gate in place of an uncommented one bare, and the comment above the list stays where it was", () => {
    const setup = { name: "setup", run: "pnpm install", timeout: "10m", env: [] };
    const out = editRecipe(OWN, [{ path: ["steps", "prepared"], value: [setup] }]);
    expect(commentCount(out)).toBe(commentCount(OWN));
    expect(out).toContain("  # are what the `proposed` gate runs.\n  prepared:\n    - name: setup\n      run: pnpm install\n");
  });

  it("refuses a gate renamed and moved in one list, and does it when the rename is said by path first", () => {
    const renamed = { ...BUILD, name: "tests" };
    expect(() => editRecipe(OWN, [{ path: ["steps", "proposed"], value: [REVIEW, renamed] }])).toThrow(
      /steps\.proposed\.0 carries a comment \("`env: \[\]` is written out/,
    );

    const before = chunks(OWN);
    const out = editRecipe(OWN, [
      { path: ["steps", "proposed", 0, "name"], value: "tests" },
      { path: ["steps", "proposed"], value: [REVIEW, renamed] },
    ]);
    expect(commentCount(out)).toBe(commentCount(OWN));
    expect(chunks(out)).toEqual([before[1], before[0]!.replace("- name: build", "- name: tests")]);
  });

  it("refuses a commented gate changed inside a whole list, and does it by path", () => {
    expect(() => editRecipe(OWN, [{ path: ["steps", "proposed"], value: [{ ...BUILD, timeout: "30m" }, REVIEW] }])).toThrow(
      CommentWouldBeLostError,
    );
    const out = editRecipe(OWN, [{ path: ["steps", "proposed", 0, "timeout"], value: "30m" }]);
    expect(gitDiff(OWN, out)).toEqual({ removed: ["      timeout: 20m"], added: ["      timeout: 30m"] });
  });

  // The reviewer gate above has two fields, so swapping it is also swapping
  // everything it had. `build` has four, and two of them can be set anew while
  // `timeout` and `env` still match — which says nothing about whether the
  // paragraph above it is still true.
  it("refuses a gate swapped field by field even when the fields it did not name still match", () => {
    const byFields = () =>
      editRecipe(OWN, [
        { path: ["steps", "proposed", 0, "name"], value: "lint" },
        { path: ["steps", "proposed", 0, "run"], value: "pnpm lint" },
      ]);
    expect(byFields).toThrow(CommentWouldBeLostError);
    expect(byFields).toThrow(/steps\.proposed\.0 carries a comment \("`env: \[\]` is written out/);
    // The claim the refusal makes good on: the same swap set whole is refused too.
    expect(() =>
      editRecipe(OWN, [{ path: ["steps", "proposed", 0], value: { ...BUILD, name: "lint", run: "pnpm lint" } }]),
    ).toThrow(CommentWouldBeLostError);

    // One field is still a rename or a new timeout, and goes through.
    for (const change of [
      { path: ["steps", "proposed", 0, "name"], value: "lint" },
      { path: ["steps", "proposed", 0, "run"], value: "pnpm lint" },
      { path: ["steps", "proposed", 0, "env"], value: ["CI"] },
    ]) {
      expect(() => editRecipe(OWN, [change]), JSON.stringify(change.path)).not.toThrow();
    }
  });

  it("refuses a commented key dropped from a whole mapping, and removes it by path", () => {
    const source = parse(OWN).source as Record<string, unknown>;
    const { backoff: _, ...rest } = source;
    expect(() => editRecipe(OWN, [{ path: ["source"], value: rest }])).toThrow(/source\.backoff carries a comment/);
  });

  function chunks(text: string): string[] {
    const seq = parseDocument(text).getIn(["steps", "proposed"], true) as { items: Node[] };
    return seq.items.map((item) => {
      const lines = text.slice(0, text.lastIndexOf("\n", item.range![0] - 1) + 1).split("\n").slice(0, -1);
      const above: string[] = [];
      while (lines.length > 0 && /^\s*#/.test(lines[lines.length - 1]!)) above.unshift(lines.pop()!);
      const end = text.indexOf("\n", item.range![1] - 1);
      return [...above, text.slice(text.lastIndexOf("\n", item.range![0] - 1) + 1, end)].join("\n").trimEnd();
    });
  }
});

describe("emitRecipe", () => {
  const said = {
    "source.kinds": "order is priority",
    "steps.merge": "nobody holds it",
    "runtime.limits": "what one ticket may spend before it comes back to you",
    "steps.proposed":
      "every script found, with the guesses ticked — an unticked one is listed rather than dropped, so a person can see what does not run before it merges",
  };

  const recipe = Recipe.parse({
    version: 2,
    repo: { base: "develop" },
    source: { kinds: ["bug", "feature"], exclude: ["agent:hold"] },
    env: { required: ["DATABASE_URL"], plantAt: ".env.local" },
    steps: {
      proposed: [{ name: "build", run: "pnpm typecheck && pnpm test", timeout: "20m" }],
      end: [{ name: "close the ticket", when: "landed", close: true }],
    },
    runtime: { agent: "claude-code", limits: { turns: 150, wall: "1h", rounds: 3, restarts: 1 } },
  });

  it("passes Recipe.parse, and re-reading it gives back what went in", () => {
    const text = emitRecipe(recipe, said);
    expect(Recipe.parse(parse(text))).toEqual(recipe);
  });

  it("re-reads this repository's own recipe exactly, multi-line prompt and all", () => {
    const recipe = Recipe.parse(parse(OWN));
    expect(Recipe.parse(parse(emitRecipe(recipe)))).toEqual(recipe);
  });

  it("carries the wizard's own sentence above every block it asked about", () => {
    const text = emitRecipe(recipe, said);
    const doc = parseDocument(text);
    for (const [dotted, sentence] of Object.entries(said)) {
      const path = dotted.split(".");
      const parent = doc.getIn(path.slice(0, -1), true) ?? doc.contents;
      expect(isMap(parent), dotted).toBe(true);
      const map = parent as YAMLMap;
      const pair = map.items.find((p) => isScalar(p.key) && p.key.value === path[path.length - 1]);
      // A comment above a map's first key is read back onto the map itself.
      const comment = (pair!.key as Node).commentBefore ?? (map.items[0] === pair ? map.commentBefore : "") ?? "";
      expect(comment.replace(/\s+/g, " ").trim(), dotted).toBe(sentence);
    }
    expect(text).toContain("  # order is priority\n  kinds:");
    expect(text).toContain("  # nobody holds it\n  merge: []");
  });

  it("an edit to what it emitted keeps every sentence", () => {
    const text = emitRecipe(recipe, said);
    const out = editRecipe(text, [{ path: ["steps", "merge"], value: [{ name: "approve", human: "Merge?" }] }]);
    expect(commentCount(out)).toBe(commentCount(text));
    expect(out).toContain("  # nobody holds it\n  merge:\n");
  });

  it("refuses a sentence about a block the recipe does not have", () => {
    expect(() => emitRecipe(recipe, { "steps.merg": "nobody holds it" })).toThrow(/steps\.merg/);
  });
});
