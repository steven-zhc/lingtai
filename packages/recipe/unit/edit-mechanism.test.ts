/**
 * **The mechanism, not only the outcome** (#162). Parsing a recipe to an object
 * and stringifying it back produces a file that parses, re-reads to the same
 * recipe, and has lost every comment — which a test on a comment-free fixture
 * would pass. So this asserts how `editRecipe` gets there: through
 * `parseDocument`, never through `stringify`, and with the person's own bytes
 * as the text it returns rather than any rendering of the document.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("yaml", async (importOriginal) => {
  const real = await importOriginal<typeof import("yaml")>();
  return { ...real, stringify: vi.fn(real.stringify), parseDocument: vi.fn(real.parseDocument) };
});

const yaml = await import("yaml");
const { editRecipe } = await import("../src/index.ts");

const OWN = readFileSync(new URL("../../../.lingtai/config.yaml", import.meta.url), "utf8");

describe("editRecipe's mechanism", () => {
  beforeEach(() => {
    vi.mocked(yaml.parseDocument).mockClear();
    vi.mocked(yaml.stringify).mockClear();
  });

  it("reads the file through parseDocument, never calls stringify, and never returns a rendering", () => {
    const toString = vi.spyOn(yaml.Document.prototype, "toString");
    const out = editRecipe(OWN, [
      { path: ["runtime", "limits", "turns"], value: 200 },
      { path: ["steps", "merge"], value: [{ name: "approve", human: "Merge?" }] },
      { path: ["source", "exclude"], value: ["blocked"].concat((yaml.parse(OWN) as { source: { exclude: string[] } }).source.exclude.slice(1)) },
    ]);
    expect(yaml.parseDocument).toHaveBeenCalledWith(OWN);
    expect(yaml.stringify).not.toHaveBeenCalled();
    // A document may be rendered to find what changed; what is written is never one.
    expect(toString.mock.results.map((r) => r.value)).not.toContain(out);
    toString.mockRestore();
  });

  it("returns the person's bytes, not a rendering: formatting no renderer would produce survives an edit elsewhere", () => {
    // Every line here is something `toString()` rewrites: the spacing after a
    // colon, quotes nobody needed, a comment at its own indent, two blank lines,
    // and a flow list with padding.
    const quirky = [
      "version:   2",
      "",
      "",
      "repo:",
      "    base: 'main'   # four spaces, quoted",
      "source:",
      "      # a comment indented past its key",
      "  kinds: [ bug,   feature ]",
      "env: { plantAt:   .env.local }",
      "steps: {}",
      "runtime:",
      "  agent: \"claude-code\"",
      "  limits:",
      "    turns: 150",
      "",
    ].join("\n");
    expect(yaml.parseDocument(quirky).toString()).not.toBe(quirky);

    const out = editRecipe(quirky, [{ path: ["runtime", "limits", "turns"], value: 90 }]);
    expect(out).toBe(quirky.replace("    turns: 150", "    turns: 90"));
    expect(yaml.stringify).not.toHaveBeenCalled();
  });
});
