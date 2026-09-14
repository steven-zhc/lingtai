/**
 * A gate's evidence is plain text (#156, 0043).
 *
 * The fixture is real: vitest 4.1.11 failing on an error with a `cause`, run
 * as `pnpm vitest run` into a pipe — which is how a `run:` gate runs it, and
 * why it arrives coloured at all (`pnpm` sets `FORCE_COLOR`). Only the absolute
 * path of the worktree it ran in was replaced. A synthetic string with one
 * escape in it would pass a regex that misses the ones vitest actually writes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plain } from "../src/command.ts";
import { type GateEvent, createProcessGate, runGatePipeline, tail } from "../src/index.ts";

const fixture = join(import.meta.dirname, "fixtures", "vitest-caused-by.ansi.txt");
const coloured = readFileSync(fixture, "utf8");
const sentence = "Caused by: Error: Connection terminated unexpectedly";
const ESC = "\x1b";

describe("vitest's own output", () => {
  it("is what the ticket saw: the sentence is broken up by escapes", () => {
    // Pins the fixture, so the assertions below are about something.
    expect(coloured).toContain(ESC);
    expect(coloured).not.toContain(sentence);
  });

  it("reads as sentences once plain, with every escape gone", () => {
    const text = plain(coloured);

    expect(text).not.toContain(ESC);
    // The leftovers of a half-matched sequence, which is what a page shows.
    expect(text).not.toMatch(/\[\d+m/);
    expect(text).toContain(sentence);
    expect(text).toContain("FAIL  test/connection.test.ts > connects");
  });

  it("spends the evidence budget on words rather than colour codes", () => {
    const bytes = plain(coloured).trimEnd().length;
    // The budget that holds all of the plain text held only part of the
    // coloured one before, and the sentence was in the part it dropped.
    expect(coloured.trimEnd().length).toBeGreaterThan(bytes);
    expect(tail(coloured, 60, bytes)).toBe(plain(coloured).trimEnd());
    expect(tail(coloured, 60, bytes)).toContain(sentence);
  });
});

describe("the stored evidence", () => {
  /**
   * `GateFailed.data.evidence` is the record: the card renders it and
   * `attempts.ts` quotes it into the fix prompt under `budget.evidence`. So
   * the claim is pinned at the event, through a real process, not at `tail`.
   */
  it("carries no escape from a failing command into GateFailed", async () => {
    const events: GateEvent[] = [];
    await runGatePipeline({
      point: "proposed",
      gates: [
        createProcessGate({
          name: "build",
          run: `cat '${fixture}'; exit 1`,
          env: { PATH: process.env["PATH"] ?? "" },
        }),
      ],
      context: { runId: "run-01JX", onSha: "sha-a", cwd: process.cwd(), env: {} },
      emit: (e) => void events.push(e),
    });

    const failed = events.find((e) => e.type === "GateFailed");
    if (failed?.type !== "GateFailed") throw new Error("the gate did not fail");
    expect(failed.data.evidence).not.toContain(ESC);
    expect(failed.data.evidence).toContain(sentence);
  });
});
