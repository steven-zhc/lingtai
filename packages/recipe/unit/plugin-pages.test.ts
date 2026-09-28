/**
 * `doc/plugins/` against the closed set — the list of twelve is **derived and
 * never typed**.
 *
 * A hand-kept count of steps or plugins has been wrong three times in two days
 * (`rail.tsx` twice in one night, both caught by a reviewer) for one reason:
 * nothing derived it. So the parent page's table is judged here against
 * `PLUGINS` itself — every plugin has a row, every row names a plugin, and a
 * row's steps are that plugin's own `at` keys in their own order. A thirteenth
 * plugin is then a red test rather than something somebody has to remember, and
 * so is a plugin whose `at` gained a step.
 *
 * **Beside the closed set rather than beside the site**, for the reason
 * `packages/actions/unit/tamper-watch.test.ts` reads `doc/tamper-watch.md`: the
 * document is what the code is judged against, and the judgement belongs where
 * the code is. What the *site* does with these files — that the section
 * publishes them, that the template is not published — is
 * `apps/site/unit/docs.test.ts`'s, one level up.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGINS } from "../src/recipe.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const pluginDoc = `${root}doc/plugins/`;

/** One row of the parent page's table, as the three cells that carry a claim. */
interface Row {
  /** The plugin the row is about, off the first cell — linked or bare. */
  key: string;
  /** Whether the first cell links to a page of its own. */
  linked: boolean;
  /** The step names the second cell carries, in the order it carries them. */
  steps: string[];
  /** The third cell, which only has to be there. */
  says: string;
}

/**
 * The table under `## The twelve`, parsed rather than counted.
 *
 * Only that section: the page has other tables' worth of prose around it, and a
 * parser that swept the whole file would judge whatever the next edit adds.
 */
async function rowsOnTheParentPage(): Promise<Row[]> {
  const body = await readFile(`${pluginDoc}index.md`, "utf8");
  const section = body.split(/^## /m).find((part) => part.startsWith("The twelve"));
  if (section === undefined) throw new Error("doc/plugins/index.md has no `## The twelve` section");

  const rows: Row[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const [first = "", serves = "", says = ""] = cells;
    if (first === "key" || /^-+$/.test(first)) continue;
    const linked = /^\[`([^`]+)`\]\(/.exec(first);
    const bare = /^`([^`]+)`$/.exec(first);
    const key = linked?.[1] ?? bare?.[1];
    if (key === undefined) throw new Error(`a row's first cell names no plugin: ${line}`);
    rows.push({
      key,
      linked: linked !== null,
      steps: [...serves.matchAll(/`([^`]+)`/g)].map((m) => m[1]!),
      says,
    });
  }
  return rows;
}

/** Every page under `doc/plugins/` that is a page — `_`-prefixed is a shape. */
async function pagesUnderPlugins(): Promise<string[]> {
  const names = await readdir(pluginDoc);
  return names.filter((n) => n.endsWith(".md") && !n.startsWith("_")).sort();
}

describe("the parent page lists the closed set", () => {
  it("gives every plugin a row, and every row a plugin", async () => {
    const rows = await rowsOnTheParentPage();
    expect(rows.map((row) => row.key).sort()).toEqual(PLUGINS.map((p) => p.key).sort());
    expect(rows).toHaveLength(PLUGINS.length);
  });

  it("names each plugin's own `at` steps, and nothing else", async () => {
    const rows = new Map((await rowsOnTheParentPage()).map((row) => [row.key, row]));
    for (const plugin of PLUGINS) {
      const row = rows.get(plugin.key);
      expect(row, `\`${plugin.key}:\` has no row on doc/plugins/index.md`).toBeDefined();
      // `serves` is `Object.keys(at)`, which is the order the plugin declares
      // them in — pipeline order for every one of the twelve. Order and all:
      // a reader uses the column to see *when* in a pass the key is reached.
      expect(row!.steps, `the steps listed for \`${plugin.key}:\``).toEqual([...plugin.serves]);
    }
  });

  it("says what a plugin serving no step serves, rather than leaving the cell blank", async () => {
    // `backlog:` is the row that earns the table — in the closed set, with a
    // field, and an `at` of `{}`. A page that could not say *this one serves no
    // step yet* would quietly omit it, which is the failure `unpublished()` in
    // `apps/site/src/lib/docs.ts` exists to prevent one level up.
    const row = (await rowsOnTheParentPage()).find((each) => each.key === "backlog");
    expect(row?.steps).toEqual([]);
    expect(row?.says, "the backlog row says nothing about what it is for").not.toBe("");
  });

  it("gives every row a line of what the key is for", async () => {
    for (const row of await rowsOnTheParentPage()) {
      expect(row.says, `\`${row.key}:\` has an empty third cell`).not.toBe("");
    }
  });
});

describe("a page per plugin, once one is written", () => {
  it("has no page for something that is not a plugin", async () => {
    const keys = new Set<string>(PLUGINS.map((p) => p.key));
    const orphans = (await pagesUnderPlugins())
      .filter((name) => name !== "index.md")
      .filter((name) => !keys.has(name.replace(/\.md$/, "")));
    expect(orphans, "a page under doc/plugins/ that names no plugin").toEqual([]);
  });

  it("is linked from the row it belongs to, so the two cannot drift", async () => {
    const written = new Set(await pagesUnderPlugins());
    for (const row of await rowsOnTheParentPage()) {
      const has = written.has(`${row.key}.md`);
      expect(row.linked, `\`${row.key}:\`: page ${has ? "exists" : "does not exist"}`).toBe(has);
    }
  });

  it("follows the template's sections, in the template's order", async () => {
    // The shape is read off `_template.md` rather than written here, for the
    // reason the whole file exists: a list of sections kept beside the template
    // is a second copy of it. Twelve pages, one shape.
    const shape = sectionsOf(await readFile(`${pluginDoc}_template.md`, "utf8"));
    expect(shape.length, "the template has lost its sections").toBeGreaterThan(3);
    for (const name of (await pagesUnderPlugins()).filter((n) => n !== "index.md")) {
      const sections = sectionsOf(await readFile(pluginDoc + name, "utf8"));
      expect(sections, `doc/plugins/${name} does not follow the template`).toEqual(shape);
    }
  });
});

/** A document's `##` headings, in order — which is the whole of "the shape". */
function sectionsOf(body: string): string[] {
  return [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
}
