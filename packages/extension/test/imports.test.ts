/**
 * `@lingtai/extension` depends on nothing, and that is checked rather than
 * promised.
 *
 * It is what Telegram and the desktop notifier render with, and `#125`'s last
 * Done-when is that Telegram imports nothing a third party's extension could
 * not. The day this file imports `@lingtai/domain` for a type, that stops being
 * true for both of them at once, and nothing else would notice.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

describe("what @lingtai/extension imports", () => {
  it("is node's own modules and nothing else", async () => {
    const specifiers: string[] = [];
    for (const file of await readdir(SRC)) {
      const text = await readFile(join(SRC, file), "utf8");
      for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/gm)) specifiers.push(m[1]!);
    }

    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith("node:") && !s.startsWith("./"))).toEqual([]);
  });

  it("declares no dependency", async () => {
    const pkg = JSON.parse(await readFile(join(SRC, "..", "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg["dependencies"]).toBeUndefined();
  });
});
