/**
 * Writing a recipe down without losing its reasons (#162). The test that is the
 * ticket is the first one: this repository's own recipe, one field changed, and
 * nothing else in the file moves.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, parseDocument, isMap, isScalar, type Node, type YAMLMap } from "yaml";
import { Recipe, editRecipe, emitRecipe, type RecipeChange } from "../src/index.ts";

const OWN = readFileSync(new URL("../../../.lingtai/config.yaml", import.meta.url), "utf8");

/** The lines of `after` that are not in `before`, and the ones that went — a line diff by common prefix and suffix. */
function changed(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) };
}

function commentCount(text: string): number {
  return text.split("\n").filter((l) => /^\s*#/.test(l)).length;
}

describe("editRecipe, on this repository's own recipe", () => {
  it("changes nothing when nothing is changed, byte for byte", () => {
    expect(editRecipe(OWN, [])).toBe(OWN);
    expect(editRecipe(OWN, [{ path: ["runtime", "limits", "turns"], value: 150 }])).toBe(OWN);
  });

  const cases: { name: string; change: RecipeChange; removed: string[]; added: string[] }[] = [
    {
      name: "a number under a comment",
      change: { path: ["runtime", "limits", "turns"], value: 200 },
      removed: ["    turns: 150"],
      added: ["    turns: 200"],
    },
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
      change: {
        path: ["source", "exclude"],
        value: ["blocked", "in-progress", "agent:hold", "agent:blocked", "agent:review", "agent:wip", "epic", "wontfix"],
      },
      removed: [],
      added: ["    - wontfix"],
    },
    {
      name: "a block list with comments between its items, one label removed",
      change: {
        path: ["source", "exclude"],
        value: ["blocked", "in-progress", "agent:hold", "agent:blocked", "agent:review", "epic"],
      },
      removed: ["    - agent:wip"],
      added: [],
    },
    {
      name: "the merge point, from nothing to a person",
      change: { path: ["gates", "merge"], value: [{ name: "approve", human: "Does this merge?" }] },
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
    const diff = changed(OWN, out);
    expect(diff.removed).toEqual(removed);
    expect(diff.added).toEqual(added);
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
    const before = OWN.split("\n");
    const after = out.split("\n");
    expect(after).toHaveLength(before.length);
    const moved = before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]));
    expect(moved).toEqual([
      ["  base: main", "  base: develop"],
      ["    rounds: 3", "    rounds: 2"],
      ["    restarts: 1", "    restarts: 0"],
    ]);
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
    const before = annotated.split("\n");
    const after = out.split("\n");
    expect(after).toHaveLength(before.length);
    const moved = before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]));
    expect(moved).toEqual([
      ["  kinds: [bug, tech-debt, feature] # order is priority", "  kinds: [feature, bug] # order is priority"],
      ["  backoff: 1h # what one failure waits", "  backoff: 30m # what one failure waits"],
    ]);
    expect(out).toContain("\n  # the line after\n");
    expect(out).toContain("\n  # also the line after\n");
  });

  it("keeps a comment on a block field being replaced, above and inside it", () => {
    const annotated = OWN.replace("  merge: []\n", "  # holds nothing\n  merge: [] # nobody holds it\n  # after merge\n");
    const out = editRecipe(annotated, [{ path: ["gates", "merge"], value: [{ name: "a person", human: "Merge?" }] }]);
    expect(out).toContain("  # holds nothing\n  merge:\n    - name: a person\n      human: Merge? # nobody holds it\n  # after merge\n");
  });

  it("refuses an edit that would not be a recipe, rather than writing it", () => {
    expect(() => editRecipe(OWN, [{ path: ["source", "kinds"], value: [] }])).toThrow();
    expect(() => editRecipe(OWN, [{ path: ["gates", "merg"], value: [] }])).toThrow();
  });

  it("removes a field, and leaves the comment above it for a person to read", () => {
    const out = editRecipe(OWN, [{ path: ["source", "backoff"], value: undefined }]);
    expect(changed(OWN, out)).toEqual({ removed: ["  backoff: 1h"], added: [] });
  });
});

describe("emitRecipe", () => {
  const said = {
    "source.kinds": "order is priority",
    "gates.merge": "nobody holds it",
    "runtime.limits": "what one ticket may spend before it comes back to you",
    "gates.proposed":
      "every script found, with the guesses ticked — an unticked one is listed rather than dropped, so a person can see what does not run before it merges",
  };

  const recipe = Recipe.parse({
    version: 1,
    repo: { base: "develop" },
    source: { kinds: ["bug", "feature"], exclude: ["agent:hold"] },
    env: { required: ["DATABASE_URL"], plantAt: ".env.local" },
    gates: {
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
    const own = Recipe.parse(parse(OWN));
    expect(Recipe.parse(parse(emitRecipe(own)))).toEqual(own);
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
    const out = editRecipe(text, [{ path: ["gates", "merge"], value: [{ name: "approve", human: "Merge?" }] }]);
    expect(commentCount(out)).toBe(commentCount(text));
    expect(out).toContain("  # nobody holds it\n  merge:\n");
  });

  it("refuses a sentence about a block the recipe does not have", () => {
    expect(() => emitRecipe(recipe, { "gates.merg": "nobody holds it" })).toThrow(/gates\.merg/);
  });
});
