/**
 * **The mechanism, not only the outcome** (#162). Parsing a recipe to an object
 * and stringifying it back produces a file that parses, re-reads to the same
 * recipe, and has lost every comment — which a test on a comment-free fixture
 * would pass. So this asserts how `editRecipe` gets there: through
 * `parseDocument`, and never through `stringify` or a rendering of the document
 * it read.
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("yaml", async (importOriginal) => {
  const real = await importOriginal<typeof import("yaml")>();
  return { ...real, stringify: vi.fn(real.stringify), parseDocument: vi.fn(real.parseDocument) };
});

const yaml = await import("yaml");
const { editRecipe } = await import("../src/index.ts");

const OWN = readFileSync(new URL("../../../.lingtai/config.yaml", import.meta.url), "utf8");

describe("editRecipe's mechanism", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads through parseDocument, never calls stringify, and never renders the document it read", () => {
    const parseDocument = vi.mocked(yaml.parseDocument);
    const stringify = vi.mocked(yaml.stringify);
    parseDocument.mockClear();
    stringify.mockClear();
    const toString = vi.spyOn(yaml.Document.prototype, "toString");
    const mapToString = vi.spyOn(yaml.YAMLMap.prototype, "toString");

    const out = editRecipe(OWN, [
      { path: ["runtime", "limits", "turns"], value: 200 },
      { path: ["gates", "merge"], value: [{ name: "approve", human: "Merge?" }] },
    ]);

    expect(parseDocument).toHaveBeenCalledWith(OWN);
    expect(stringify).not.toHaveBeenCalled();
    const read = parseDocument.mock.results.map((r) => r.value as unknown);
    const rendered = toString.mock.contexts.filter((doc) => read.includes(doc));
    expect(rendered, "a document parsed from the file was re-rendered whole").toEqual([]);

    // Nor any document built some other way: a fragment is one value, never the whole recipe.
    const whole = [yaml.parse(OWN), yaml.parse(out)];
    const renderings = [...toString.mock.results, ...mapToString.mock.results].map((r) => r.value as string);
    const recipes = renderings.filter((text) => {
      // A nested collection's own rendering is a piece of text that need not parse by itself.
      const again = yaml.parseDocument(text);
      return again.errors.length === 0 && whole.some((w) => isDeepStrictEqual(again.toJS(), w));
    });
    expect(recipes, "the whole recipe was rendered from a document").toEqual([]);
  });
});
