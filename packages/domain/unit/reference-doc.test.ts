/**
 * **`doc/reference.md` is the published vocabulary, and a copy nothing checks
 * is not worth having.**
 *
 * `gate-matrix.test.ts` already holds that line for the point × kind table, and
 * for the reason `#61` gave: the copy in that ticket's own body was wrong about
 * `merge` within three weeks of being written. Four more sections of the same
 * file name symbols and count them, and until `#227` nothing read any of them
 * — so the reference went on defining the model as *five points, closed forever* and
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
import { SCHEMA_VER, STEPS, UPCASTERS, type EventType } from "../src/index.ts";

const reference = () => readFile(new URL("../../../doc/reference.md", import.meta.url), "utf8");

/**
 * The lines under one heading, up to the next one at that level or above.
 *
 * `level` because two of the claims below live under a `###` — the rule about
 * what a surface may omit is a subsection of `issue change`, and a reader
 * checking 0016 §4 opens it by name rather than by its parent.
 */
function section(doc: string, startsWith: string, level = "## "): { heading: string; lines: string[] } {
  const lines = doc.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${level}${startsWith}`));
  expect(at, `no "${level}${startsWith}…" heading in doc/reference.md`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(at + 1);
  // The next heading at this level or above it, which is where this one ends.
  const sameOrAbove = new RegExp(`^#{1,${level.trim().length}} `);
  const end = rest.findIndex((l) => sameOrAbove.test(l));
  return { heading: lines[at]!, lines: end === -1 ? rest : rest.slice(0, end) };
}

/**
 * The count words this document writes, so a sentence can be read as a number.
 *
 * A count with no word here fails loudly rather than silently passing, which is
 * the point: the day `STEPS` is a length nobody has written a word for, these
 * sections are sentences nobody has rewritten either.
 */
const WORD: Record<number, string> = { 5: "five", 10: "ten" };

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

  /**
   * **The version a reader is about to key a new upcaster against.**
   *
   * A chain's last row says where it ends, and `SCHEMA_VER` says the same
   * thing; a document that disagrees sends somebody to key a step at a number
   * that is already taken — which replaces the function there rather than
   * following it, and leaves the chain unbroken while every stored payload
   * loses what that step filled in.
   */
  it("ends each chain at the version SCHEMA_VER says it does", async () => {
    const { lines } = section(await reference(), "upcaster —");
    const table = rows(lines).filter((cells) => cells.length === 3);

    const endsAt = new Map<string, number>();
    for (const [type, step] of table.slice(1)) {
      const to = Number(step!.split("→")[1]!.trim());
      endsAt.set(type!, Math.max(endsAt.get(type!) ?? 0, to));
    }

    expect(endsAt.size).toBeGreaterThan(0);
    for (const [type, last] of endsAt) {
      expect(last, `${type}: the table's last step against SCHEMA_VER`).toBe(
        SCHEMA_VER[type as EventType],
      );
    }
  });

  /**
   * And the other half of the same claim: the types the section says went
   * *back* to 1 are at 1. `GatePassed` is the trap — its `gatePointRenamed`
   * step went with the other seven and its `findings` step did not, so it is
   * the one gate type this line may not name.
   */
  it("names only types that really are at version 1 again", async () => {
    const { lines } = section(await reference(), "upcaster —");
    const at = lines.findIndex((l) => l.startsWith("At version 1 again:"));
    expect(at, 'no "At version 1 again:" line under the upcaster heading').toBeGreaterThanOrEqual(0);

    // The whole paragraph, because the list wraps at the column everything
    // else in this file wraps at.
    const rest = lines.slice(at);
    const blank = rest.findIndex((l) => l.trim() === "");
    const paragraph = (blank === -1 ? rest : rest.slice(0, blank)).join(" ");

    const named = [...paragraph.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const type of named) {
      expect(SCHEMA_VER[type as EventType], `${type}, as that line says`).toBe(1);
      expect(UPCASTERS[type as EventType], `${type} has a chain and cannot be at 1`).toBeUndefined();
    }
  });
});

/**
 * **The two sections that say what a run was given and what a surface may leave
 * out**, which are the two a reader opens to check 0016 §4 and neither of which
 * anything read until now. Both went on saying *five* through `#227`: one would
 * have had a second producer of `GatesResolved` emit a payload the schema
 * refuses, and the other told a reader that nothing is ever omitted from the
 * bar — on which reading, making a configured step `skipped` drops it silently,
 * which is the one failure that block exists to prevent.
 */
describe("doc/reference.md on the count, and on what may be left out", () => {
  it("states the count `GatesResolved` asserts, where the event is defined", async () => {
    const { lines } = section(await reference(), "what the log says");
    // One string with the wrapping taken out, so a sentence that spans two
    // lines in the file is one sentence here.
    const text = lines.join(" ").replace(/\s+/g, " ");

    expect(text).toContain(`all ${WORD[STEPS.length]} steps`);
    // The schema's own assertion, so a producer reading this writes the array
    // the parser accepts rather than the one the prose used to describe.
    expect(text).toContain(`.length(${STEPS.length})`);
  });

  it("states what the fold returns and the one thing the bar may drop", async () => {
    const { lines } = section(await reference(), "where `skipped` is rendered", "### ");
    const text = lines.join(" ").replace(/\s+/g, " ");

    expect(text).toContain(`all ${WORD[STEPS.length]} steps`);
    // By the name of the tuple `Segs` filters against, and by the state — the
    // two halves of the condition, which is what a reader has to have before
    // changing what `stateOf` returns.
    expect(text).toContain("`GATE_STEPS`");
    expect(text).toMatch(/not `skipped`/);
  });
});
