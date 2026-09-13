/**
 * `@lingtai/extension` depends on nothing, and that is checked rather than
 * promised.
 *
 * It is what Telegram and the desktop notifier render with, and `#125`'s last
 * Done-when is that Telegram imports nothing a third party's extension could
 * not. The day this file imports `@lingtai/domain` for a type, that stops being
 * true for both of them at once, and nothing else would notice.
 *
 * The specifiers are read by TypeScript's own pre-processor rather than a
 * pattern, because a pattern for `import … from "x"` does not see `import "x"`,
 * `await import("x")` or `require("x")` — each of which loads the monorepo just
 * as well. An `import(name)` nobody can read the name of is refused outright.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

/** Every module `text` loads, in any of the forms that load one. */
function specifiersIn(text: string): string[] {
  const found = ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
  if (/\b(?:import|require)\s*\(\s*(?!["'])/.test(text)) found.push("<a computed import>");
  return found;
}

async function specifiersUnder(dir: string): Promise<string[]> {
  const specifiers: string[] = [];
  for (const file of await readdir(dir, { recursive: true })) {
    if (!/\.[cm]?[jt]s$/.test(file)) continue;
    specifiers.push(...specifiersIn(await readFile(join(dir, file), "utf8")));
  }
  return specifiers;
}

describe("what @lingtai/extension imports", () => {
  it("is node's own modules and nothing else", async () => {
    const specifiers = await specifiersUnder(SRC);

    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith("node:") && !s.startsWith("./"))).toEqual([]);
  });

  it("is read in every form that loads a module, not only `import … from`", () => {
    const text = [
      'import "@lingtai/domain/register";',
      'const store = await import("@lingtai/event-store");',
      'export * from "@lingtai/actions";',
      'const pg = require("pg");',
      "const late = await import(name);",
    ].join("\n");

    expect(specifiersIn(text)).toEqual([
      "@lingtai/domain/register",
      "@lingtai/event-store",
      "@lingtai/actions",
      "pg",
      "<a computed import>",
    ]);
  });

  it("declares no dependency", async () => {
    const pkg = JSON.parse(await readFile(join(SRC, "..", "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg["dependencies"]).toBeUndefined();
  });
});
