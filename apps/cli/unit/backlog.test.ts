/**
 * `lingtai backlog`'s refusals (`#137`) — the ones that stand between a
 * terminal and a batch decision nobody read.
 */
import { describe, expect, it } from "vitest";
import { backlogCommand, split } from "../src/backlog.ts";

async function said(args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await backlogCommand(args, (l) => lines.push(l));
  return { code, out: lines.join("\n") };
}

describe("lingtai backlog", () => {
  it("decides one key at a time, and refuses a list", async () => {
    const r = await said(["accept", "lingtai", "aaaaaaaaaaaa", "bbbbbbbbbbbb", "--kind", "bug"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("one key at a time");
  });

  it("reads an unquoted reason as one reason, not as a list of keys", () => {
    const { positional, flags } = split(["lingtai", "0123456789ab", "--reason", "style", "only"]);
    expect(positional).toEqual(["lingtai", "0123456789ab"]);
    expect(flags["reason"]).toBe("style only");
    // And a second key before the flag is still a list.
    expect(split(["lingtai", "a", "b", "--reason", "x"]).positional).toEqual(["lingtai", "a", "b"]);
  });

  it("refuses a decline with no reason", async () => {
    const r = await said(["decline", "lingtai", "aaaaaaaaaaaa", "--reason"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--reason");
  });
});
