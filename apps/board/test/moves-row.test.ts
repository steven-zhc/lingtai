/**
 * Opening the reason form changes the size of nothing beside it (#155).
 *
 * Approve over a refusal swaps its button for a label, a field and two more
 * buttons, 75px tall. In a flex row that does not say `align-items`, every
 * sibling stretches to that height, and on the home-board card *Back to the
 * queue* became a bordered panel — the largest thing in the row, and the move
 * not being made. #152 had written `flex-start` on the task page's `.smoves`
 * and not on the card's `.btnrow`: one instance fixed, and not the class.
 *
 * There is no browser in the gate, so this is asserted where it can break: the
 * stylesheet's rule, and which rule each row that holds `<Decide>` wears.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The stylesheet without its prose, so a comment is never taken for a rule. */
const css = read("../src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration block whose selector list names `selector` exactly. */
const blocks = (selector: string) =>
  css
    .split("}")
    .map((piece) => piece.split("{"))
    .filter((parts) => parts.length > 1)
    .filter((parts) =>
      parts[parts.length - 2]!
        .split(",")
        .map((s) => s.trim().replace(/\s+/g, " "))
        .includes(selector),
    )
    .map((parts) => parts[parts.length - 1]!);

/** The class list of the element that directly wraps the first `<Decide`. */
const rowAround = (source: string) => {
  const at = source.indexOf("<Decide");
  expect(at).toBeGreaterThan(-1);
  const before = source.slice(0, at);
  const open = before.lastIndexOf('className="');
  return before.slice(open + 'className="'.length, before.indexOf('"', open + 'className="'.length)).split(" ");
};

describe("a row of moves", () => {
  it("keeps each sibling its own height when one of them grows", () => {
    const row = blocks(".btnrow").join(";");
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/align-items:\s*flex-start/);
  });

  it("is ruled once: the task page's row is a .btnrow that adds only spacing", () => {
    // `.smoves` re-declaring the layout is how the two drifted apart.
    for (const block of blocks(".smoves")) {
      expect(block).not.toMatch(/display|align-items|flex-wrap/);
    }
    expect(rowAround(read("../src/app/page.tsx"))).toContain("btnrow");
    expect(rowAround(read("../src/app/standing.tsx"))).toEqual(expect.arrayContaining(["btnrow", "smoves"]));
  });
});

describe("the reason field", () => {
  it("takes a width of its own, wide enough for the placeholder it ships with", () => {
    const placeholder = /placeholder="([^"]+)"/.exec(read("../src/app/decide.tsx"))![1]!;
    const input = blocks(".reason input").join(";");
    const width = /(?:^|[;\s])width:\s*(\d+)ch/.exec(input);
    // In `ch`, so the check is against the text rather than a guess at pixels.
    expect(width).not.toBeNull();
    expect(Number(width![1])).toBeGreaterThanOrEqual(placeholder.length);
  });
});
