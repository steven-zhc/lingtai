/**
 * An action's evidence is plain text (#156, 0043).
 *
 * The fixture is real: vitest 4.1.11 failing on an error with a `cause`, run
 * as `pnpm vitest run` into a pipe — which is how a `run:` action runs it, and
 * why it arrives coloured at all (`pnpm` sets `FORCE_COLOR`). Only the absolute
 * path of the worktree it ran in was replaced. A synthetic string with one
 * escape in it would pass a regex that misses the ones vitest actually writes.
 *
 * **In `integration/`**: the last assertion drives the fixture through a real
 * `createProcessAction`, so the stripping is pinned at the `GateFailed` event and
 * not at `tail` — which is the whole of what 0043 claims. That spawns a shell,
 * and an OS process is outside the system
 * ([0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1). Nothing
 * here names `node:child_process`; the spawn is three modules down the barrel,
 * which is how the file was read as unit at first (#225).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plain } from "../src/command.ts";
import { type ActionEvent, createProcessAction, runActionPipeline, tail } from "../src/index.ts";

const fixture = join(import.meta.dirname, "..", "test", "fixtures", "vitest-caused-by.ansi.txt");
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

describe("escapes vitest does not write", () => {
  it("never takes the text after an OSC with no terminator", () => {
    // A hyperlink cut off by a kill on timeout, or by a chunk boundary.
    const text = plain("link \x1b]8;;http://x\nFAIL: Caused by: Error boom\nmore");
    expect(text).not.toContain(ESC);
    expect(text).toContain("FAIL: Caused by: Error boom\nmore");
    expect(plain("link \x1b]8;;http://x")).toBe("link 8;;http://x");
  });

  it("ends an OSC at C1 ST, as a code point or as the byte decoded as UTF-8", () => {
    expect(plain("\x1b]0;title\x9cFAIL Caused by: boom\n")).toBe("FAIL Caused by: boom\n");
    const decoded = Buffer.from([0x1b, 0x5d, 0x30, 0x3b, 0x74, 0x9c, 0x46]).toString();
    expect(plain(decoded)).toBe("F");
    expect(plain("\x1b]8;;file:///x\x1b\\a\x1b]8;;\x07b")).toBe("ab");
  });

  it("takes the escapes that are not two bytes of CSI or OSC", () => {
    expect(plain("a\x1b(B\x1b[mb")).toBe("ab"); // tput sgr0
    expect(plain("x\x1b7progress\x1b8y")).toBe("xprogressy");
    expect(plain("\x1b=\x1b>\x1bc\x1bMz")).toBe("z");
  });
});

describe("the stored evidence", () => {
  /**
   * `GateFailed.data.evidence` is the record: the card renders it and
   * `attempts.ts` quotes it into the fix prompt under `budget.evidence`. So
   * the claim is pinned at the event, through a real process, not at `tail`.
   */
  it("carries no escape from a failing command into GateFailed", async () => {
    const events: ActionEvent[] = [];
    await runActionPipeline({
      step: "proposed",
      actions: [
        createProcessAction({
          name: "build",
          run: `cat '${fixture}'; exit 1`,
          env: { PATH: process.env["PATH"] ?? "" },
        }),
      ],
      context: { runId: "run-01JX", onSha: "sha-a", cwd: process.cwd(), env: {} },
      emit: (e) => void events.push(e),
    });

    const failed = events.find((e) => e.type === "GateFailed");
    if (failed?.type !== "GateFailed") throw new Error("the action did not fail");
    expect(failed.data.evidence).not.toContain(ESC);
    expect(failed.data.evidence).toContain(sentence);
  });
});
