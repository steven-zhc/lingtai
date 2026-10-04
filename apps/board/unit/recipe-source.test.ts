/**
 * `underHome` shortens a `where` for the source column (#218). Since `#371` a
 * narrowed limit's `where` carries a second absolute path mid-sentence, and
 * both occurrences of the home prefix must come back shortened, or the row
 * reads as a path this machine's owner never writes that way.
 */
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { PROVENANCE_ARROW } from "@lingtai/recipe";
import { sourceOf, underHome, type Reading } from "../src/lib/recipe.ts";

describe("underHome", () => {
  const home = homedir();

  it("shortens a leading path", () => {
    expect(underHome(`${home}/.lingtai/config.yml`)).toBe("~/.lingtai/config.yml");
  });

  it("shortens a path embedded later in the string too, as a narrowing's where does (#371)", () => {
    const where =
      `${home}/.lingtai/config.yml (projects.lingtai), narrowing ` + `${home}/.lingtai/lingtai/recipe.yml's 300`;
    expect(underHome(where)).toBe(
      "~/.lingtai/config.yml (projects.lingtai), narrowing ~/.lingtai/lingtai/recipe.yml's 300",
    );
  });

  it("leaves a source that is not a path alone", () => {
    expect(underHome("default")).toBe("default");
    expect(underHome("detected — the only runtime signed in")).toBe("detected — the only runtime signed in");
  });
});

describe("sourceOf, a row with a narrowed limit", () => {
  it("shortens both paths in a narrowing entry rather than leaving the second one absolute", () => {
    const home = homedir();
    const row: Reading = { name: "a pass", says: "", keys: ["runtime.limits.turns", "runtime.limits.wall"] };
    const provenance = {
      "runtime.limits.turns": `150${PROVENANCE_ARROW}${home}/.lingtai/config.yml (projects.lingtai), narrowing ${home}/.lingtai/lingtai/recipe.yml's 300`,
      "runtime.limits.wall": `2h${PROVENANCE_ARROW}default`,
    };
    expect(sourceOf(row, provenance)).not.toContain(`${home}/`);
  });
});
