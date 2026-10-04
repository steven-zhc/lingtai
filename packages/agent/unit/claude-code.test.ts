/**
 * The pure half of the Claude Code adapter: `usageFromModelUsage` (#316).
 *
 * Everything that spawns a process is in `integration/claude-code.test.ts`,
 * which `pnpm test` does not run (see `unit/codex.test.ts`'s header for why).
 * This function needs no process: it reads the `modelUsage` object a real
 * receipt already carries and turns it into the shared shape (0110 §3).
 */
import { describe, expect, it } from "vitest";
import { createClaudeCodeRuntime, usageFromModelUsage } from "../src/claude-code.ts";

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

/**
 * `--max-budget-usd`, through `invocation()` — the argv `run` would spawn,
 * without spawning it (`#370`). Mirrors `--max-turns`, which is always there.
 */
describe("argsFor's --max-budget-usd", () => {
  const invocable = {
    runId: "run-1",
    cwd: "/tmp/tree",
    settingsPath: "/state/runs/run-1/settings.json",
    env: {},
    limits: { turns: 150, wallMs: 3_600_000 },
  };

  it("is absent where the recipe declared no dollar ceiling", () => {
    const { args } = createClaudeCodeRuntime().invocation!(invocable);
    expect(args).not.toContain("--max-budget-usd");
    expect(args).toContain("--max-turns");
  });

  it("carries the figure where the recipe declared one", () => {
    const { args } = createClaudeCodeRuntime().invocation!({
      ...invocable,
      limits: { ...invocable.limits, usd: 12 },
    });
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("12");
  });
});
