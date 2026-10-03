/**
 * `doc/rate-card.md`, read rather than duplicated — the pattern
 * `packages/actions/unit/tamper-watch.test.ts` set for a document that is the
 * canonical copy of something code also needs to agree with.
 *
 * Three things, and each is a defect this ticket exists to make impossible:
 *
 * 1. **The card calibrates against a real bill.** Claude Code reports its own
 *    `costUsd`, so `tokens × rate` that disagrees with it is the rate card
 *    gone stale, caught by arithmetic rather than by somebody remembering
 *    (0073 §6, 0110 §6).
 * 2. **An unpriced model is not silently skipped.** A `modelUsage` key with no
 *    row must fail by name, never fall through as zero.
 * 3. **Nothing in the projector reads this file.** 0110 §5: a reducer that
 *    priced tokens would disagree with `lingtai projection rebuild` the day a
 *    price changed.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRateCard, priceTokens, rateFor, type RateRow } from "../test/rate-card.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function rows(): Promise<RateRow[]> {
  return parseRateCard(await readFile(`${root}doc/rate-card.md`, "utf8"));
}

describe("doc/rate-card.md", () => {
  it("parses every dated row, including the one this file appended", async () => {
    const parsed = await rows();
    expect(parsed.length).toBeGreaterThanOrEqual(6);
    expect(parsed).toContainEqual({
      from: "2026-10-03",
      model: "claude-sonnet-5",
      mode: "cache-1h",
      input: 2.0,
      output: 10.0,
      cacheRead: 0.2,
      cacheWrite: 4.0,
    });
  });

  /**
   * **Two real receipts, captured once rather than computed.** A fixture whose
   * dollars were derived from the rate card would check nothing — see this
   * file's module docblock and 0110 §6's warning about a stale card reporting
   * a confident wrong number.
   *
   * Captured 2026-10-03 with `claude -p "reply ok" --model claude-sonnet-5
   * --output-format json` (claude-code 2.1.285), run twice. The first receipt
   * wrote to the cache and billed at the one-hour-TTL rate; the second reused
   * that cache (`cacheCreationInputTokens: 0`) and is a pure cache-read turn,
   * which carries no cache-write tokens and so calibrates only the ordinary
   * input/output/cache-read columns — see `doc/rate-card.md`'s note on the
   * 2026-10-03 row for the arithmetic that tells the two regimes apart.
   */
  const CAPTURED_AT = new Date("2026-10-03T00:00:00.000Z");
  const CACHE_WRITE_RECEIPT = {
    // The call that first created the cache — billed at the one-hour rate.
    tokens: { fresh: 2, output: 19, cacheRead: 24352, cacheWrite: 39338 },
    costUsd: 0.1624164,
  };
  const CACHE_READ_RECEIPT = {
    // The call right after it: a pure cache-read turn, on the ordinary cache.
    tokens: { fresh: 2, output: 13, cacheRead: 63690, cacheWrite: 0 },
    costUsd: 0.012872,
  };

  it("prices the cache-read receipt within 1% against the ordinary mode", async () => {
    const row = rateFor(await rows(), "claude-sonnet-5", "", CAPTURED_AT);
    expect(row).toBeDefined();

    const priced = priceTokens(CACHE_READ_RECEIPT.tokens, row!);
    expect(priced).toBeCloseTo(CACHE_READ_RECEIPT.costUsd, 2);
    expect(Math.abs(priced - CACHE_READ_RECEIPT.costUsd) / CACHE_READ_RECEIPT.costUsd).toBeLessThan(0.01);
  });

  it("prices the cache-write receipt within 1% against the cache-1h mode, not the ordinary one", async () => {
    const theRows = await rows();
    const hourly = rateFor(theRows, "claude-sonnet-5", "cache-1h", CAPTURED_AT);
    expect(hourly).toBeDefined();

    const priced = priceTokens(CACHE_WRITE_RECEIPT.tokens, hourly!);
    expect(priced).toBeCloseTo(CACHE_WRITE_RECEIPT.costUsd, 2);
    expect(Math.abs(priced - CACHE_WRITE_RECEIPT.costUsd) / CACHE_WRITE_RECEIPT.costUsd).toBeLessThan(0.01);
  });

  /**
   * **The blocker this file almost became: the discovery must not shadow the
   * ordinary rate.** `rateFor(rows, "claude-sonnet-5", "", at)` for any `at`
   * on or after 2026-10-03 must still answer the 2026-06-24 row — the
   * `cache-1h` row has its own mode and is never the latest match for an
   * ordinary, empty-mode lookup. An ordinary call shaped like the cache-write
   * receipt above is really billed $0.1034094 (2.50/MTok cache write), and
   * that is what an ordinary lookup must still price it at, not the
   * $0.1624164 the one-hour regime actually paid.
   */
  it("never lets the cache-1h discovery answer an ordinary lookup", async () => {
    const theRows = await rows();
    const ordinary = rateFor(theRows, "claude-sonnet-5", "", CAPTURED_AT);
    expect(ordinary).toEqual(theRows.find((r) => r.model === "claude-sonnet-5" && r.from === "2026-06-24"));

    const ordinaryPriced = priceTokens(CACHE_WRITE_RECEIPT.tokens, ordinary!);
    expect(ordinaryPriced).toBeCloseTo(0.1034094, 6);
  });

  /**
   * **This is the check working, not a hole in it.** Before the 2026-10-03 row
   * was appended, this same comparison against the 2026-06-24 row priced
   * $0.1034094 against an actual $0.1624164 — 36% short of what was really
   * billed, all of it the cache-write column. Widening the tolerance to make
   * that pass would be the exact failure 0073 §6 warns against: a stale card
   * reporting a confident wrong number.
   */
  it("would have failed against the stale 2026-06-24 row", async () => {
    const stale = (await rows()).find((r) => r.model === "claude-sonnet-5" && r.from === "2026-06-24")!;
    const priced = priceTokens(CACHE_WRITE_RECEIPT.tokens, stale);
    expect(Math.abs(priced - CACHE_WRITE_RECEIPT.costUsd) / CACHE_WRITE_RECEIPT.costUsd).toBeGreaterThan(0.3);
  });

  /**
   * A model the card has never priced — not a stale row, an absent one.
   *
   * Captured the same session as the two above, `--model` omitted so
   * claude-code picked its own default: `modelUsage` came back keyed
   * `claude-opus-5-5`, not `claude-opus-5`. `doc/rate-card.md` has rows for
   * `claude-opus-5` only, so this is a real receipt for a model this file has
   * never seen — exactly the case 0073 §6 chose absent for.
   */
  it("answers undefined for a model with no row, rather than falling back to one", async () => {
    const row = rateFor(await rows(), "claude-opus-5-5", "", CAPTURED_AT);
    expect(row).toBeUndefined();
  });

  /**
   * The projector is a fold; a fold may not read this file (0110 §5). Reading
   * every file's source, not grepping the package, so a mention inside a
   * comment is caught the same as an import.
   */
  it("is never read by the projector — task-view.ts included", async () => {
    const { readdir } = await import("node:fs/promises");
    const dir = `${root}packages/projector/src`;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("task-view.ts");

    for (const file of files) {
      const text = await readFile(`${dir}/${file}`, "utf8");
      expect(text, file).not.toMatch(/rate-card/);
      expect(text, file).not.toMatch(/from\s+["'][^"']*\/test\//);
    }
  });
});
