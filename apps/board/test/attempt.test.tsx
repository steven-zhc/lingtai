/**
 * The attempt that is still going opens itself, and its log opens with it.
 *
 * `#110` built the run log and the board's stream; the page hid it. `RunLog`
 * was rendered closed for every attempt for a reason that is right — a page
 * with six attempts would otherwise follow six files nobody asked to see — and
 * the result was that **a run producing output right now was two disclosures
 * deep and nothing on the page said it was there** (#132).
 *
 * So the assertions are the two halves of that: the running attempt is open and
 * reading, and every finished one is closed and reads nothing, which is the
 * original reason intact.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Envelope } from "@lingtai/domain";
import { foldRun, type Claim } from "../src/lib/task.ts";
import { Attempt } from "../src/app/task/[id]/page.tsx";

let seq = 0n;

function e(streamId: string, type: string, data: unknown): Envelope {
  seq += 1n;
  return {
    seq,
    streamId,
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor: "conductor",
    causation: null,
    at: new Date("2026-09-10T07:46:00Z"),
  };
}

const RUN = "run-33333333-0000-0000-0000-000000000000";
const SHA = "c".repeat(40);
const claim = (): Claim => ({ runId: RUN, at: "2026-09-10T07:40:00.000Z", repair: false, released: null });

/** Started and nothing since: `outcomeOf`'s `running`. */
const running = () => foldRun(claim(), 2, [e(RUN, "RunStarted", { baseSha: SHA })]);

/** Started and finished: the ordinary attempt, and the one that stays shut. */
const finished = () =>
  foldRun(claim(), 2, [
    e(RUN, "RunStarted", { baseSha: SHA }),
    e(RUN, "RunFinished", { turns: 12, durationMs: 60_000, costUsd: 1, exitCode: 0 }),
  ]);

const render = (run: ReturnType<typeof running>) =>
  renderToStaticMarkup(<Attempt run={run} alone={false} project="lingtai" deciding={false} />);

describe("the attempt in flight", () => {
  it("is open, and its log is open and following", () => {
    const html = render(running());
    expect(html).toContain('id="attempt-2"');
    // Both disclosures: the attempt, and the log inside it. The `details` for
    // the log carries `open` because `RunLog` was told this run is live.
    expect(html).toContain('<details class="attempt" id="attempt-2" open=""');
    expect(html).toContain('<details class="alog" open=""');
  });

  it("leaves every finished attempt closed, and reading nothing", () => {
    const html = render(finished());
    expect(html).not.toContain('<details class="attempt" id="attempt-2" open=""');
    expect(html).not.toContain('<details class="alog" open=""');
    // The summary says so in as many words: no connection has been opened.
    expect(html).toContain("not reading");
  });
});
