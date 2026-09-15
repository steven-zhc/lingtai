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
    expect(out).toContain("  # holds nothing\n  merge: # nobody holds it\n    - name: a person\n      human: Merge?\n  # after merge\n");
  });

  /** Each item's text with the comment lines directly above it, in file order. */
  function chunks(text: string, path: string[]): string[] {
    const seq = parseDocument(text).getIn(path, true) as { items: Node[] };
    return seq.items.map((item) => {
      const lines = text.slice(0, text.lastIndexOf("\n", item.range![0] - 1) + 1).split("\n").slice(0, -1);
      const above: string[] = [];
      while (lines.length > 0 && /^\s*#/.test(lines[lines.length - 1]!)) above.unshift(lines.pop()!);
      const end = text.indexOf("\n", item.range![1] - 1);
      return [...above, text.slice(text.lastIndexOf("\n", item.range![0] - 1) + 1, end)].join("\n");
    });
  }

  it("moves a reordered gate with its comments, rather than rewriting each position in place", () => {
    const before = chunks(OWN, ["gates", "proposed"]);
    const own = parse(OWN) as { gates: { proposed: unknown[] } };
    const out = editRecipe(OWN, [{ path: ["gates", "proposed"], value: [own.gates.proposed[1], own.gates.proposed[0]] }]);
    expect(chunks(out, ["gates", "proposed"])).toEqual([before[1], before[0]]);
    expect(commentCount(out)).toBe(commentCount(OWN));
    expect(out.indexOf("It is second deliberately")).toBeLessThan(out.indexOf("- name: review"));
    expect(out.indexOf("**Both halves, written out.**")).toBeGreaterThan(out.indexOf("- name: build"));
  });

  it("moves reordered gates that also changed with their comments, rather than rewriting each position", () => {
    const own = parse(OWN) as { gates: { proposed: Record<string, unknown>[] } };
    const [build, review] = own.gates.proposed;
    const out = editRecipe(OWN, [
      { path: ["gates", "proposed"], value: [{ ...review, timeout: "5m" }, { ...build, timeout: "30m" }] },
    ]);
    expect(commentCount(out)).toBe(commentCount(OWN));
    expect(out.indexOf("It is second deliberately")).toBeLessThan(out.indexOf("- name: review"));
    expect(out.indexOf("- name: review")).toBeLessThan(out.indexOf("Nothing, and the suite still runs"));
    expect(out.indexOf("Nothing, and the suite still runs")).toBeLessThan(out.indexOf("- name: build"));
    expect(out.indexOf("**Both halves, written out.**")).toBeGreaterThan(out.indexOf("- name: build"));
    expect(out).toMatch(/    - name: build\n      # \*\*Both halves[^]*?      run: [^\n]*\n      timeout: 30m\n/);
    expect((parse(out) as typeof own).gates.proposed.map((g) => [g["name"], g["timeout"]])).toEqual([
      ["review", "5m"],
      ["build", "30m"],
    ]);
  });

  it("moves a changed gate past an unchanged one with the comments above and inside it", () => {
    const own = parse(OWN) as { gates: { proposed: Record<string, unknown>[] } };
    const [build, review] = own.gates.proposed;
    const out = editRecipe(OWN, [{ path: ["gates", "proposed"], value: [review, { ...build, timeout: "30m" }] }]);
    expect(commentCount(out)).toBe(commentCount(OWN));
    expect(out.indexOf("- name: review")).toBeLessThan(out.indexOf("Nothing, and the suite still runs"));
    expect(out).toMatch(/# extension may not name one of Lingtai's own\.\n    - name: build\n      # \*\*Both halves/);
    expect(out).toContain("      timeout: 30m\n");
  });

  it("renames a label as a removal and an addition, never the old label's comment over the new one", () => {
    const labels = (parse(OWN) as { source: { exclude: string[] } }).source.exclude;
    const out = editRecipe(OWN, [{ path: ["source", "exclude"], value: labels.map((l) => (l === "epic" ? "epic2" : l)) }]);
    expect(out).not.toMatch(/# An epic is a table of contents[^]*?- epic2/);
    expect(out).toContain("    - agent:wip\n    - epic2\n");
  });

  it("moves a rotated label with the comment above it", () => {
    const before = chunks(OWN, ["source", "exclude"]);
    const labels = (parse(OWN) as { source: { exclude: string[] } }).source.exclude;
    const rotated = [labels[labels.length - 1]!, ...labels.slice(0, -1)];
    const out = editRecipe(OWN, [{ path: ["source", "exclude"], value: rotated }]);
    expect(chunks(out, ["source", "exclude"])).toEqual([before[before.length - 1], ...before.slice(0, -1)]);
    expect(commentCount(out)).toBe(commentCount(OWN));
    expect(out).toMatch(/# An epic is a table of contents[^]*?\n {4}- epic\n {4}- blocked\n/);
  });

  it("removes a label together with the comment that explains it", () => {
    const out = editRecipe(OWN, [
      {
        path: ["source", "exclude"],
        value: ["blocked", "in-progress", "agent:hold", "agent:blocked", "agent:review", "agent:wip"],
      },
    ]);
    const diff = changed(OWN, out);
    expect(diff.added).toEqual([]);
    expect(diff.removed[0]).toBe("    # An epic is a table of contents, not work. `#126` was claimed on");
    expect(diff.removed[diff.removed.length - 1]).toBe("    - epic");
    expect(diff.removed.slice(0, -1).every((l) => /^\s*#/.test(l))).toBe(true);
  });

  it("rewrites a block-scalar prompt in place, deeper than its key", () => {
    const multi = editRecipe(OWN, [{ path: ["gates", "proposed", 1, "agent"], value: "line one\nline two\n" }]);
    expect(multi).toContain("    - name: review\n      agent: |\n        line one\n        line two\n");
    expect((parse(multi) as { gates: { proposed: { agent: string }[] } }).gates.proposed[1]!.agent).toBe("line one\nline two\n");
    const single = editRecipe(OWN, [{ path: ["gates", "proposed", 1, "agent"], value: "one line" }]);
    expect((parse(single) as { gates: { proposed: { agent: string }[] } }).gates.proposed[1]!.agent).toBe("one line");
    expect(commentCount(single)).toBe(commentCount(OWN));
  });

  it("refuses an edit that would not be a recipe, rather than writing it", () => {
    expect(() => editRecipe(OWN, [{ path: ["source", "kinds"], value: [] }])).toThrow();
    expect(() => editRecipe(OWN, [{ path: ["gates", "merg"], value: [] }])).toThrow();
  });

  it("removes a field together with the comment that explains it, as a list item goes", () => {
    const out = editRecipe(OWN, [{ path: ["source", "backoff"], value: undefined }]);
    const diff = changed(OWN, out);
    expect(diff.added).toEqual([]);
    expect(diff.removed.filter((l) => l !== "" && !/^\s*#/.test(l))).toEqual(["  backoff: 1h"]);
    expect(commentCount(OWN) - commentCount(out)).toBe(8);
    expect(out).not.toContain("How long a failed attempt keeps its own ticket out of the queue");
    expect(out).toContain("    - epic\n\nenv:\n");
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
