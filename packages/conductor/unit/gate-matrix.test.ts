/**
 * **Sixty cells, and each one runs or refuses by name.** There is no third
 * answer, and for a year ten of them gave it: an action at `admit`, or anything
 * but an effect at `end`, was accepted by the schema, resolved into
 * `GatesResolved`, printed by `lingtai add`, drawn on the board, and never
 * called (`#61`).
 *
 * **It was thirty until the vocabulary went from five names to ten** (0058 §3).
 * Six of the ten steps have no call site, so thirty-six of the sixty cells are
 * refusals, and that is the property this file is here to hold: naming a step
 * is not building it, and the five steps 0058 named and the pipeline has not
 * yet constructed must refuse every kind until it has. A `design:` block a
 * recipe could write and nothing would run is `#61` with a new spelling.
 *
 * This walks every step × kind pair and asserts one of exactly two things:
 *
 * - **runs** — the thing that consumes that point builds a gate for it, with
 *   the dependencies that point's own call site supplies; or
 * - **refuses** — the recipe does not resolve, and the refusal names the
 *   action, its kind, the point and why.
 *
 * It is the thing that keeps `doc/reference.md`'s matrix true: the last
 * hand-maintained copy of it was wrong about `merge` within three weeks of
 * being written, which is why the last test here reads the document and
 * compares it to `KINDS_AT` rather than trusting it.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { STEPS, type Step } from "@lingtai/domain";
import {
  type ActionKind,
  type GateAction,
  GateMap,
  whyNoKindAt,
} from "@lingtai/recipe";
import {
  type AgentGateDeps,
  GateActionUnavailableError,
  type GateDeps,
  gatesFromRecipe,
} from "@lingtai/actions";
import { resolveEndActions } from "../src/end-point.ts";

/** The six kinds, one action each, exactly as a resolved recipe would hold them. */
const ACTION: Record<ActionKind, GateAction> = {
  run: { name: "build", run: "pnpm verify", timeout: "15m", env: [] },
  agent: { name: "review", agent: "read the diff" },
  watch: { name: "tamper", watch: ["**/gates.yml"], then: "fail" },
  human: { name: "approve", human: "merge this?" },
  close: { name: "close the ticket", close: true, when: "landed" },
  labels: { name: "label it", labels: ["shipped"], when: "any" },
};
const KINDS = Object.keys(ACTION) as ActionKind[];

/**
 * What each gating point hands `gatesFromRecipe`, which is the other half of
 * what it can run: `prepared` gets an environment resolver and nothing else,
 * because there is no diff there for a reviewer to read or globs to match.
 *
 * Pinned against `run-once.ts` itself below, so this cannot drift from the
 * call sites it is describing without a red test.
 */
const EVERY_DEP: GateDeps = {
  env: () => ({}),
  // Built, never run — building is the whole of what this file asserts.
  agent: {} as unknown as AgentGateDeps,
  watch: { changedFiles: async () => [] },
};
const DEPS: Record<"prepared" | "proposed" | "merge", GateDeps> = {
  prepared: { env: () => ({}) },
  proposed: EVERY_DEP,
  merge: EVERY_DEP,
};

/**
 * The steps something actually constructs a pipeline for.
 *
 * Read off `run-once.ts` and `end-point.ts` by the last test in this describe,
 * so this is not a list somebody keeps: a fourth `gatesFromRecipe` call site is
 * a red test rather than a silently-widened matrix.
 */
const HAS_A_CALL_SITE = ["prepared", "proposed", "merge", "end"] as const;

/** Does the code that consumes this step actually dispatch this action? */
function runsAt(point: Step, kind: ActionKind): boolean {
  if (!(HAS_A_CALL_SITE as readonly string[]).includes(point)) {
    // Nothing constructs a pipeline at `claim`, `admit`, `design`, `implement`,
    // `build` or `review`: no call site, nothing to ask. Five of those six are
    // named by 0058 §3 and built by its next ticket; `admit` has been in the
    // closed set since 0016 with nothing behind it.
    return false;
  }
  // A throw is a refusal and not a run, which is the answer this asks for; the
  // refusals themselves are asserted by name below.
  try {
    if (point === "end") {
      const resolved = resolveEndActions([], [ACTION[kind]], "landed");
      const named = (resolved[0]?.data as { actions: { name: string }[] } | undefined)?.actions ?? [];
      return named.some((a) => a.name === ACTION[kind].name);
    }
    return gatesFromRecipe(point, [ACTION[kind]], DEPS[point as keyof typeof DEPS]).some(
      (gate) => gate.name === ACTION[kind].name,
    );
  } catch {
    return false;
  }
}

/** Does a recipe naming this action at this point resolve? */
function accepted(point: Step, kind: ActionKind): string | null {
  const parsed = GateMap.safeParse({ [point]: [ACTION[kind]] });
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "refused with no message");
}

describe("every step × kind cell runs or refuses", () => {
  const cells = STEPS.flatMap((point) => KINDS.map((kind) => [point, kind] as const));

  it.each(cells)("%s × %s", (point, kind) => {
    const refusal = accepted(point, kind);
    if (refusal === null) {
      // Accepted, so it must run. This is the half `#58` and `#61` are about:
      // a recipe the log says was resolved, and a point that never called it.
      expect(whyNoKindAt(point, kind)).toBeNull();
      expect(runsAt(point, kind), `${point} accepts a ${kind} action and nothing runs it`).toBe(
        true,
      );
      return;
    }
    // Refused, so it must refuse by name — the action, its kind, the point, and
    // a reason about the point rather than about a missing dependency.
    expect(refusal).toContain(`"${ACTION[kind].name}"`);
    expect(refusal).toContain(`"${kind}"`);
    expect(refusal).toContain(`"${point}"`);
    expect(whyNoKindAt(point, kind)).not.toBeNull();
    expect(runsAt(point, kind)).toBe(false);
  });

  /**
   * The same refusal one level down, for a caller that builds actions in code
   * rather than reading a recipe — `lingtai doctor`, a test, a future plugin
   * host. 0015's first extension power is a gate action at a point, and it has
   * to answer the same at both doors.
   */
  it.each(
    (["prepared", "proposed", "merge"] as const).flatMap((point) =>
      KINDS.filter((kind) => whyNoKindAt(point, kind) !== null).map(
        (kind) => [point, kind] as const,
      ),
    ),
  )("gatesFromRecipe refuses %s × %s by name", (point, kind) => {
    expect(() => gatesFromRecipe(point, [ACTION[kind]], DEPS[point])).toThrow(
      GateActionUnavailableError,
    );
    expect(() => gatesFromRecipe(point, [ACTION[kind]], DEPS[point])).toThrow(
      new RegExp(`"${kind}" at the "${point}" point`),
    );
  });

  /**
   * **`prepared`'s three refusals are about the point, not about the caller.**
   *
   * The reason is worth pinning rather than just the refusal: `agent:` and
   * `watch:` used to say "no reviewer was supplied", which is a fact about the
   * dependencies `run-once.ts` happens to pass and reads as something that
   * could be fixed by passing them. It cannot: nothing has been committed yet.
   * `human:` is the one that cost a review round — a hold there is turned into
   * a release (`run-once.ts`, section 7), so the person is asked a question
   * that re-asks itself every pass and can never be answered.
   */
  it("says why `prepared` is narrower than `proposed`", () => {
    expect(whyNoKindAt("prepared", "agent")).toMatch(/nothing has been committed/);
    expect(whyNoKindAt("prepared", "watch")).toMatch(/nothing has been committed/);
    expect(whyNoKindAt("prepared", "human")).toMatch(/released back to the queue/);
    expect(whyNoKindAt("prepared", "run")).toBeNull();
  });

  /**
   * The deps in this file are a copy of what `run-once.ts` passes, and a copy
   * is a thing to keep correct. Read rather than reasoned about: narrowing
   * `proposed`'s deps would leave the schema accepting an `agent:` action that
   * refused mid-pass and released the item, which is the failure this whole
   * file exists to make impossible.
   */
  it("is the deps run-once passes at each point", async () => {
    const src = await readFile(new URL("../src/run-once.ts", import.meta.url), "utf8");
    expect(src).toMatch(/gatesFromRecipe\(\s*"prepared",\s*recipe\.gates\.prepared,\s*\{\s*env:/);
    expect(src).toMatch(/gatesFromRecipe\(\s*"proposed",\s*recipe\.gates\.proposed,\s*gateDeps\s*\)/);
    expect(src).toMatch(/gatesFromRecipe\(\s*"merge",\s*recipe\.gates\.merge,\s*gateDeps\s*\)/);
    // And nowhere else: a fourth call site is a point this file does not know
    // about, judging with deps it has not been told.
    expect(src.match(/gatesFromRecipe\(/g)?.length).toBe(3);
  });
});

/**
 * `doc/reference.md` carries the matrix, and this is what keeps it true.
 *
 * Checked rather than generated because the document is prose around the table
 * and the reasons matter as much as the ticks — but the ticks themselves are
 * `KINDS_AT`'s, cell for cell, and a document that disagrees is the document
 * that is wrong.
 */
describe("doc/reference.md's matrix", () => {
  const RUNS = "✅";
  const REFUSES = "✋";

  it("says what the code does, cell for cell", async () => {
    const doc = await readFile(new URL("../../../doc/reference.md", import.meta.url), "utf8");
    const rows = new Map<string, string[]>();
    let header: string[] | null = null;
    for (const line of doc.split("\n")) {
      const cells = line.trim().startsWith("|")
        ? line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
        : null;
      if (cells === null) continue;
      if (cells.length === 7 && cells.slice(1).join(" ") === KINDS.map((k) => `\`${k}:\``).join(" ")) {
        header = cells;
        continue;
      }
      if (header === null) continue;
      const point = cells[0]?.replace(/[`*]/g, "");
      if (cells.length === 7 && STEPS.includes(point as Step)) {
        rows.set(point!, cells.slice(1));
      }
    }

    expect(header, "no point × kind table in doc/reference.md").not.toBeNull();
    expect([...rows.keys()]).toEqual([...STEPS]);
    for (const point of STEPS) {
      const drawn = rows.get(point)!;
      KINDS.forEach((kind, i) => {
        const runs = whyNoKindAt(point, kind) === null;
        expect(drawn[i]?.replace(/[`*]/g, ""), `${point} × ${kind} in doc/reference.md`).toBe(
          runs ? RUNS : REFUSES,
        );
      });
    }
  });
});
