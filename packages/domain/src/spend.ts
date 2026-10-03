/**
 * What a paid call consumed, as the runtime reported it — never as money.
 *
 * [0110](../../../doc/decisions/0110-tokens-on-the-event-money-at-display.md) §3:
 * five token counts, accumulated across turns and never summed into one number,
 * plus the model and mode a rate is looked up by. Every field is optional and
 * none defaults to zero — absent means *this runtime did not say*, and a
 * `.default(0)` here would report unknown cost as free (#198).
 *
 * `Usage` is an array because one call can bill more than one model — Claude
 * Code's `modelUsage` is already keyed by model id — and an entry's tokens can
 * only be priced against the rate of the model that earned them. Entries merge
 * by `(model, mode)`; a differently-keyed entry is a different line in the
 * bill, not a second count of the same one.
 */
import { z } from "zod";

export const TokenCounts = z.object({
  /** Fresh input, billed at the full input rate. */
  fresh: z.number().optional(),
  /** Served from cache, billed at the cache-read rate. */
  cacheRead: z.number().optional(),
  /** Written to cache, billed at the cache-write rate. */
  cacheWrite: z.number().optional(),
  /** Output, billed at the output rate. */
  output: z.number().optional(),
  /** Reasoning output, billed at the output rate — reported by Codex alone. */
  reasoning: z.number().optional(),
});
export type TokenCounts = z.infer<typeof TokenCounts>;

export const UsageEntry = z.object({
  /** The runtime's own model id. Absent where the runtime never names one. */
  model: z.string().optional(),
  /** A premium speed at the same model id (0073 §2). Absent where none applies. */
  mode: z.string().optional(),
  tokens: TokenCounts,
});
export type UsageEntry = z.infer<typeof UsageEntry>;

export const Usage = z.array(UsageEntry);
export type Usage = z.infer<typeof Usage>;

const TOKEN_FIELDS = ["fresh", "cacheRead", "cacheWrite", "output", "reasoning"] as const;

/**
 * Two counts from the same call, added field by field.
 *
 * The leniency `costUsd` already has (`discuss.ts`'s `spend`): absent plus
 * absent is absent, and present plus absent is the present value alone. A
 * field present in neither operand must stay absent rather than become the `0`
 * that reports unknown cost as free.
 */
export function mergeTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  const merged: TokenCounts = {};
  for (const field of TOKEN_FIELDS) {
    const x = a[field];
    const y = b[field];
    if (x === undefined && y === undefined) continue;
    merged[field] = (x ?? 0) + (y ?? 0);
  }
  return merged;
}

function keyOf(entry: UsageEntry): string {
  return `${entry.model ?? ""}\u0000${entry.mode ?? ""}`;
}

/**
 * Every combination this project adds usage through: Codex's fold per
 * `turn.completed`, a discussion's rounds, and a conversation's whole spend.
 * One hand-written sum outside this function is where a `?? 0` creeps in and
 * turns an absence into a free lunch.
 */
export function addUsage(a: Usage, b: Usage): Usage {
  const byKey = new Map<string, UsageEntry>();
  for (const entry of a) byKey.set(keyOf(entry), entry);
  for (const entry of b) {
    const key = keyOf(entry);
    const existing = byKey.get(key);
    byKey.set(
      key,
      existing === undefined ? entry : { ...existing, tokens: mergeTokenCounts(existing.tokens, entry.tokens) },
    );
  }
  return [...byKey.values()];
}
