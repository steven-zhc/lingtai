/**
 * **`doc/reference.md` is the published vocabulary, and a copy nothing checks
 * is not worth having.**
 *
 * `gate-matrix.test.ts` already holds that line for the point × kind table, and
 * for the reason `#61` gave: the copy in that ticket's own body was wrong about
 * `merge` within three weeks of being written. Two more sections of the same
 * file name symbols and count them, and until `#227` nothing read either — so
 * the reference went on defining the model as *five points, closed forever* and
 * citing `GatePoint` and `GATE_POINTS` after both had been deleted, and went on
 * saying nine types walk 0018's rename after eight of them had stopped. Both
 * are the same defect at different ranges: a reader who runs `rg` on the name
 * the document gives them gets nothing, and the two honest conclusions
 * available to them — *the code drifted* and *this build is missing an
 * upcaster* — are both wrong.
 *
 * Read from the document rather than asserted here, so the failure names the
 * line to change.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { STEPS, UPCASTERS } from "../src/index.ts";

const reference = () => readFile(new URL("../../../doc/reference.md", import.meta.url), "utf8");

/** The lines under one `## heading`, up to the next one. */
function section(doc: string, startsWith: string): { heading: string; lines: string[] } {
  const lines = doc.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`## ${startsWith}`));
  expect(at, `no "## ${startsWith}…" heading in doc/reference.md`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return { heading: lines[at]!, lines: end === -1 ? rest : rest.slice(0, end) };
}

/** A markdown table's rows, each as its cells with the backticks taken off. */
function rows(lines: readonly string[]): string[][] {
  return lines
    .filter((l) => l.trim().startsWith("|"))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/[`*]/g, "")))
    .filter((cells) => cells[0] !== "" && !/^-+$/.test(cells[0] ?? ""));
}

describe("doc/reference.md's step vocabulary", () => {
  it("names every step, in pass order, and cites the symbols that exist", async () => {
    const { heading, lines } = section(await reference(), "step —");

    // The count is in the heading, where a reader meets it first.
    expect(heading).toContain(`— ${STEPS.length},`);
    // And the source line, which is the one a reader greps for.
    const source = lines.find((l) => l.startsWith("Source:"));
    expect(source, "no Source: line under the step heading").toBeDefined();
    expect(source).toContain("`Step`");
    expect(source).toContain("`STEPS`");

    // The first column of the first table under the heading.
    const table = rows(lines).filter((cells) => cells.length === 3);
    expect(table[0]).toEqual(["Step", "When", "May refuse?"]);
    expect(table.slice(1).map((cells) => cells[0])).toEqual([...STEPS]);
  });
});

describe("doc/reference.md's upcaster table", () => {
  /**
   * The registry as `(type, from)` pairs — `from` because that is what the key
   * is, and a gap in it is what `upcast.test.ts`'s chain invariant catches. The
   * table draws the same pair as `1 → 2`.
   */
  const registry = Object.entries(UPCASTERS).flatMap(([type, chain]) =>
    Object.keys(chain ?? {}).map((from) => `${type} ${from}`),
  );

  it("counts the chains and the steps the registry actually holds", async () => {
    const { heading } = section(await reference(), "upcaster —");
    const chains = Object.keys(UPCASTERS).length;

    expect(heading).toBe(`## upcaster — ${chains} chains, ${registry.length} steps`);
  });

  it("draws one row per step, and no row for a step nothing can walk", async () => {
    const { lines } = section(await reference(), "upcaster —");
    const table = rows(lines).filter((cells) => cells.length === 3);

    expect(table[0]).toEqual(["Type", "Step", "What changed, and why the honest reading is the one given"]);
    const drawn = table.slice(1).map(([type, step]) => `${type} ${step!.split("→")[0]!.trim()}`);
    expect(drawn).toEqual(registry);
  });
});
