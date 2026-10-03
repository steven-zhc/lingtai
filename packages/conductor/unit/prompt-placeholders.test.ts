/**
 * `doc/reference.md`'s *prompt placeholder* table, held against `renderPrompt`.
 *
 * The same shape as `packages/recipe/unit/plugin-pages.test.ts`: the document is
 * what the code is judged against. A seventh `replaceAll` in `renderPrompt` with no
 * row, or a row that names a placeholder nothing expands, is a red test rather
 * than a page that is confidently wrong.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderPrompt } from "../src/prompt.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** The first column of the table under `## prompt placeholder`. */
async function documented(): Promise<string[]> {
  const body = await readFile(`${root}doc/reference.md`, "utf8");
  const section = body.split(/^## /m).find((part) => part.startsWith("prompt placeholder"));
  if (section === undefined) throw new Error("doc/reference.md has no `## prompt placeholder` section");
  return [...section.matchAll(/^\| `(\{\{[a-z]+\}\})` \|/gm)].map((m) => m[1]!);
}

describe("the prompt placeholders", () => {
  it("are the ones renderPrompt substitutes, and every one expands", async () => {
    const names = await documented();
    const source = await readFile(`${root}packages/conductor/src/prompt.ts`, "utf8");
    const substituted = [...source.matchAll(/\.replaceAll\("(\{\{[a-z]+\}\})"/g)].map((m) => m[1]!);
    expect(names.sort()).toEqual(substituted.sort());

    for (const name of names) {
      const out = renderPrompt(
        name,
        { number: 7, title: "a title", body: "a body" },
        ["a check"],
        "a failure",
        "a design",
      );
      expect(out, `${name} reaches the model unexpanded`).not.toContain(name);
    }
  });
});
