/**
 * `lingtai backlog`'s refusals (`#137`) — the ones that stand between a
 * terminal and a batch decision nobody read.
 */
import type { BacklogEntry } from "@lingtai/projector";
import { describe, expect, it } from "vitest";
import { backlogCommand, describeEntry, split } from "../src/backlog.ts";

const ENTRY: BacklogEntry = {
  key: "0123456789ab",
  project: "lingtai",
  issue: "49",
  taskId: "wi-lingtai-49",
  runId: "run-1",
  step: "proposed",
  action: "review",
  onSha: "a".repeat(40),
  file: "apps/cli/src/doctor.ts",
  line: 1204,
  severity: "minor",
  claim: "the detail names three issues and nothing else",
  failureScenario: "a reader has to open GitHub before the line means anything",
  raisedSeq: "9",
  raisedAt: new Date(0),
  status: "open",
  decidedBy: null,
  decidedAt: null,
  kind: null,
  proposedRef: null,
  proposedUrl: null,
  reason: null,
};

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

  // #258: the ticket a finding was raised against arrives with enough to
  // recognise it, and never as a number a reader has to go and look up.
  it("names the ticket a finding was raised against, and says so in words when the board has no title", () => {
    const withTitle = describeEntry(ENTRY, "the end point runs on every outcome")[0]!;
    expect(withTitle).toContain("#49 the end point runs on every outcome");

    const without = describeEntry(ENTRY)[0]!;
    expect(without).toContain("raised while working #49");
    // Never the bare number standing on its own, which is what the line was.
    expect(without).not.toMatch(/ {2}#49 {2}/);
  });
});
