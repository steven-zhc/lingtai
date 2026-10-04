/**
 * The pure half of the Claude Code adapter: `usageFromModelUsage` (#316) and
 * `claudeClose` (#369).
 *
 * Everything that spawns a process is in `integration/claude-code.test.ts`,
 * which `pnpm test` does not run (see `unit/codex.test.ts`'s header for why).
 * Neither function needs a process: `usageFromModelUsage` reads the
 * `modelUsage` object a real receipt already carries, and `claudeClose` is
 * the close handler's decision, pulled out so a unit test can reach it.
 */
import { describe, expect, it } from "vitest";
import { claudeClose, usageFromModelUsage } from "../src/claude-code.ts";

describe("usageFromModelUsage", () => {
  it("is absent where the receipt carried no modelUsage at all", () => {
    // Never `[]` — an empty bill is a different fact from *this runtime did
    // not say*, and the difference is the whole of #198.
    expect(usageFromModelUsage(undefined)).toBeUndefined();
  });

  /**
   * A real receipt — `claude -p "reply ok" --model claude-sonnet-5
   * --output-format json` (claude-code 2.1.285, captured 2026-10-03; see
   * `doc/rate-card.md`'s note on its 2026-10-03 row for the full line).
   * Claude Code reports no reasoning count of its own, so `reasoning` is
   * never set here.
   */
  it("reads one entry per model, keyed by the receipt's own model id", () => {
    const usage = usageFromModelUsage({
      "claude-sonnet-5": {
        inputTokens: 2,
        outputTokens: 19,
        cacheReadInputTokens: 24352,
        cacheCreationInputTokens: 39338,
      },
    });
    expect(usage).toEqual([
      {
        model: "claude-sonnet-5",
        tokens: { fresh: 2, output: 19, cacheRead: 24352, cacheWrite: 39338 },
      },
    ]);
  });

  /**
   * **One entry per model billed, not one entry for the model the recipe
   * asked for.** A call that billed a second, smaller model would otherwise
   * have that model's tokens priced at the first model's rate.
   */
  it("keeps two billed models as two entries rather than folding them together", () => {
    const usage = usageFromModelUsage({
      "claude-opus-5-5": { inputTokens: 2, outputTokens: 4 },
      "claude-haiku-4-5": { inputTokens: 100, outputTokens: 1 },
    });
    expect(usage).toHaveLength(2);
    expect(usage).toContainEqual({ model: "claude-opus-5-5", tokens: { fresh: 2, output: 4 } });
    expect(usage).toContainEqual({ model: "claude-haiku-4-5", tokens: { fresh: 100, output: 1 } });
  });

  it("leaves a field absent rather than zero where the entry never reported it", () => {
    const usage = usageFromModelUsage({ "claude-sonnet-5": { inputTokens: 2 } });
    expect(usage).toEqual([{ model: "claude-sonnet-5", tokens: { fresh: 2 } }]);
  });

  /**
   * **A model key whose entry carries none of the four recognised fields is
   * dropped, not recorded as a present, all-zero bill.** `ClaudeModelUsage`'s
   * fields are all optional and hand-written, so a renamed or re-nested
   * receipt shape must not silently turn into `{model, tokens: {}}` — the
   * exact inversion `codexUsage`'s `hasTokens` guard refuses on the other
   * adapter.
   */
  it("drops a model entry whose tokens recognised none of the four fields", () => {
    expect(usageFromModelUsage({ "claude-sonnet-5": {} })).toBeUndefined();
  });

  it("keeps a recognised entry and drops an unrecognised one from the same receipt", () => {
    const usage = usageFromModelUsage({
      "claude-sonnet-5": { inputTokens: 2 },
      "claude-haiku-4-5": {},
    });
    expect(usage).toEqual([{ model: "claude-sonnet-5", tokens: { fresh: 2 } }]);
  });
});

describe("claudeClose", () => {
  const closed = (over: Partial<{ exitCode: number | null; stderr: string; stdout: string }> = {}) => ({
    exitCode: 0,
    stderr: "",
    stdout: "",
    ...over,
  });

  it("answers null — no failure — on a clean result", () => {
    const parsed = { is_error: false, num_turns: 3, total_cost_usd: 0.1 };
    expect(claudeClose(parsed, closed({ exitCode: 0 }), { turns: 150 })).toBeNull();
  });

  it("is out-of-turns on error_max_turns, carrying the recipe's bound and the cost", () => {
    const parsed = { subtype: "error_max_turns", is_error: true, num_turns: 300, total_cost_usd: 12.9 };
    const result = claudeClose(parsed, closed({ exitCode: 1 }), { turns: 150 });

    expect(result?.kind).toBe("out-of-turns");
    expect(result?.detail).toContain("300 turns");
    expect(result?.detail).toContain("150");
    expect(result?.detail).toContain("$12.90");
  });

  /**
   * **The one new case** (`#369`). Measured on the shipped bundle:
   * `error_max_structured_output_retries` used to fall through to
   * `neverStarted`'s three facts and land as `crash` — right by accident,
   * since `#89` moved `error_max_turns` off that same path for being the
   * wrong word rather than a wrong verdict. This is the runtime answering
   * `--json-schema` the way `error_max_turns` answers `--max-turns`.
   */
  it("is no-structured-answer on error_max_structured_output_retries, not crash", () => {
    const parsed = {
      subtype: "error_max_structured_output_retries",
      is_error: true,
      num_turns: 3,
      total_cost_usd: 0.08,
    };
    const result = claudeClose(parsed, closed({ exitCode: 1 }), { turns: 40 });

    expect(result?.kind).toBe("no-structured-answer");
    expect(result?.detail).toContain("3 turns");
    expect(result?.detail).toContain("$0.08");
  });

  it("is still crash for an ordinary error subtype, and never-started for the zero-turn one", () => {
    const ordinary = claudeClose(
      { subtype: "error_during_execution", is_error: true, num_turns: 12, total_cost_usd: 0.41 },
      closed({ exitCode: 1 }),
      { turns: 40 },
    );
    expect(ordinary?.kind).toBe("crash");

    const quota = claudeClose(
      { subtype: "error_during_execution", is_error: true, num_turns: 0, total_cost_usd: 0 },
      closed({ exitCode: 1 }),
      { turns: 40 },
    );
    expect(quota?.kind).toBe("never-started");
  });

  it("is crash with no receipt at all, quoting whatever the process said", () => {
    const result = claudeClose(null, closed({ exitCode: 1, stderr: "claude: command not found" }), {
      turns: 40,
    });

    expect(result?.kind).toBe("crash");
    expect(result?.detail).toContain("command not found");
  });
});
