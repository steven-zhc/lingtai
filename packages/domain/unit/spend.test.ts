/**
 * The shared spend shape (#316, 0110 §3): five disjoint token counts, merged by
 * `(model, mode)`, with the leniency `costUsd` already has — absent plus
 * absent is absent, present plus absent is the present value, and nothing here
 * ever turns an absence into a zero.
 */
import { describe, expect, it } from "vitest";
import { addUsage, mergeTokenCounts } from "../src/spend.ts";

describe("mergeTokenCounts", () => {
  it("sums a field present in both", () => {
    expect(mergeTokenCounts({ fresh: 10 }, { fresh: 5 })).toEqual({ fresh: 15 });
  });

  it("keeps a field present in only one operand, rather than zeroing the other side in", () => {
    expect(mergeTokenCounts({ fresh: 10 }, {})).toEqual({ fresh: 10 });
    expect(mergeTokenCounts({}, { output: 3 })).toEqual({ output: 3 });
  });

  it("leaves a field absent in both operands absent in the result", () => {
    expect(mergeTokenCounts({}, {})).toEqual({});
    expect(mergeTokenCounts({ fresh: 1 }, { output: 2 })).toEqual({ fresh: 1, output: 2 });
  });
});

describe("addUsage", () => {
  it("merges two entries with the same (model, mode) rather than keeping both", () => {
    const a = [{ model: "claude-sonnet-5", tokens: { fresh: 10 } }];
    const b = [{ model: "claude-sonnet-5", tokens: { fresh: 5, output: 2 } }];
    expect(addUsage(a, b)).toEqual([{ model: "claude-sonnet-5", tokens: { fresh: 15, output: 2 } }]);
  });

  it("keeps a differently-keyed entry as a second line rather than folding it in", () => {
    const a = [{ model: "claude-sonnet-5", tokens: { fresh: 10 } }];
    const b = [{ model: "claude-opus-5", tokens: { fresh: 1 } }];
    expect(addUsage(a, b)).toHaveLength(2);
  });

  it("treats mode as part of the key — the same model id at two speeds is two entries", () => {
    const a = [{ model: "claude-opus-5", mode: "fast", tokens: { fresh: 10 } }];
    const b = [{ model: "claude-opus-5", tokens: { fresh: 1 } }];
    const merged = addUsage(a, b);
    expect(merged).toHaveLength(2);
    expect(merged).toContainEqual({ model: "claude-opus-5", mode: "fast", tokens: { fresh: 10 } });
    expect(merged).toContainEqual({ model: "claude-opus-5", tokens: { fresh: 1 } });
  });

  it("is the identity on an empty side", () => {
    const usage = [{ model: "claude-sonnet-5", tokens: { fresh: 10 } }];
    expect(addUsage([], usage)).toEqual(usage);
    expect(addUsage(usage, [])).toEqual(usage);
  });
});
