/**
 * The command runner, against real processes.
 *
 * Nothing is mocked, for `gate.test.ts`'s reason: a command is a process and an
 * exit code, and a test that stubs the process is testing nothing. Here the
 * properties under test are 0037 §4's two new channels — JSON in on stdin, a
 * richer answer out through `LINGTAI_RESULT` — and, ahead of both of them, the
 * constraint that shapes them: **a command that ignores stdin and writes no
 * file behaves exactly as it does today.** Most of what follows is pinning
 * that, because it is what would break silently.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type CommandOutcome, runCommand, startCommand } from "../src/index.ts";

const env = { PATH: process.env["PATH"] ?? "" };
let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "lingtai-command-"));
});

const run = (options: Partial<Parameters<typeof runCommand>[0]> & { run: string }) =>
  runCommand({ timeoutMs: 10_000, cwd, env, ...options });

const elapsedAside = (evidence: string) => evidence.replace(/\d+\.\d+s/, "<elapsed>");

describe("a payload on stdin", () => {
  it("reaches the command as JSON, and the stream is closed", async () => {
    const outcome = await run({
      run: "cat > payload.json",
      payload: { runId: "run-01JX", ticket: { number: 122 } },
    });

    // `cat` returning at all is half the assertion: a stdin that stayed open
    // would hang here until the timeout.
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(await readFile(join(cwd, "payload.json"), "utf8"))).toEqual({
      runId: "run-01JX",
      ticket: { number: 122 },
    });
  });

  /**
   * The reason it is stdin and not the environment. A real `RunPrompted` in
   * this log carried `bytes: 4555`, and this is an order of magnitude past both
   * that and the pipe's own buffer.
   */
  it("carries a payload far larger than an environment would hold", async () => {
    const payload = { prompt: "x".repeat(100_000) };
    const outcome = await run({ run: "cat > payload.json", payload });

    expect(outcome.ok).toBe(true);
    expect(JSON.parse(await readFile(join(cwd, "payload.json"), "utf8"))).toEqual(payload);
  });

  /**
   * The constraint the whole ticket is shaped by: every `run:` in every recipe
   * today ignores stdin, and must go on producing exactly what it does now. A
   * command that exits without draining the pipe leaves us writing to a closed
   * one, and that EPIPE is not a failure of the command.
   */
  it("does not change the outcome of a command that never reads it", async () => {
    const script = "echo 'src/a.ts(12,3): error TS2345'; echo boom >&2; exit 2";
    const ignoring = await run({ run: script });
    const fed = await run({ run: script, payload: { prompt: "y".repeat(100_000) } });

    expect(fed.ok).toBe(ignoring.ok);
    expect(fed.exitCode).toBe(ignoring.exitCode);
    expect(fed.timedOut).toBe(ignoring.timedOut);
    // Every word of the evidence but how long it took, which is the one part
    // two runs of the same script are not obliged to agree on.
    expect(elapsedAside(fed.evidence)).toBe(elapsedAside(ignoring.evidence));
    expect(fed.evidence).toContain("error TS2345");
    expect(fed.evidence).toContain("boom");
  });

  it("leaves stdin at /dev/null when there is no payload, so a reader gets EOF", async () => {
    // Not a hang and not an error: the same empty read `run:` gets today.
    const outcome = await run({ run: "cat > read.txt" });

    expect(outcome.ok).toBe(true);
    expect(await readFile(join(cwd, "read.txt"), "utf8")).toBe("");
  });
});

describe("LINGTAI_RESULT", () => {
  it("names a path the command can write, and valid JSON there is read", async () => {
    const resultPath = join(cwd, "result.json");
    const outcome = await run({
      run: `printf '{"verdict":"request-approval","who":"release"}' > "$LINGTAI_RESULT"`,
      resultPath,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ verdict: "request-approval", who: "release" });
  });

  it("is absent from the environment when the caller named no path", async () => {
    // A command must not inherit a meaning from a run it was not part of.
    const outcome = await run({ run: 'echo "[${LINGTAI_RESULT-unset}]"; exit 1' });

    expect(outcome.evidence).toContain("[unset]");
  });

  it("says nothing when the command writes nothing, which is every `run:` today", async () => {
    const outcome = await run({ run: "echo built", resultPath: join(cwd, "result.json") });

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBeUndefined();
    expect(outcome.evidence).toContain("exited 0");
    expect(outcome.evidence).not.toContain("LINGTAI_RESULT");
  });

  /**
   * Garbage is a bug in an extension, and the two halves of the answer are
   * separable: the exit code still decides, and the parse failure is evidence
   * rather than silence. A broken writer must not turn a passing command into a
   * failing one.
   */
  it("falls back to the exit code on garbage, with the parse failure as evidence", async () => {
    const resultPath = join(cwd, "result.json");
    const outcome = await run({ run: `echo 'not json' > "$LINGTAI_RESULT"`, resultPath });

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toBeUndefined();
    expect(outcome.evidence).toContain("LINGTAI_RESULT");
    expect(outcome.evidence).toContain("is not JSON");
  });

  it("does not let a result file rescue a non-zero exit", async () => {
    const resultPath = join(cwd, "result.json");
    await writeFile(resultPath, '{"verdict":"passed"}');
    const outcome = await run({ run: "echo nope >&2; exit 1", resultPath });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result).toEqual({ verdict: "passed" });
    // stdout is still evidence, unchanged.
    expect(outcome.evidence).toContain("nope");
  });
});

describe("a command the core does not wait for", () => {
  const started = (options: Parameters<typeof startCommand>[0]) => {
    let report: (outcome: CommandOutcome) => void;
    const outcome = new Promise<CommandOutcome>((resolve) => (report = resolve));
    startCommand(options, (o) => report(o));
    return outcome;
  };

  it("returns before the command does", async () => {
    const marker = join(cwd, "late.txt");
    const outcome = started({
      run: `sleep 0.3; touch "${marker}"`,
      timeoutMs: 10_000,
      cwd,
      env,
    });

    // The call has already returned — the file the command will write does not
    // exist yet. That is the whole difference from `runCommand`.
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    expect((await outcome).ok).toBe(true);
  });

  /**
   * 0037 §6: an ignored failure and a bounded one are different guarantees, and
   * only the second keeps the loop moving. Not waiting does not mean not
   * looking: nothing reads a subscriber's exit code, so this callback is the
   * only place a `PluginFailed` about it could come from.
   */
  it("still enforces the timeout, and reports it", async () => {
    const outcome = await started({
      run: "sleep 30",
      timeoutMs: 150,
      timeoutLabel: "150ms",
      cwd,
      env,
    });

    expect(outcome.timedOut).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.evidence).toContain("timed out after 150ms");
  });

  it("reports a non-zero exit rather than swallowing it", async () => {
    const outcome = await started({ run: "echo bad >&2; exit 3", timeoutMs: 10_000, cwd, env });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.evidence).toContain("bad");
  });

  /**
   * The outcome arrives in a `close` handler and in a timer, so a `report` that
   * throws throws into neither caller's `try` — it is an uncaught exception in
   * whichever process started the command, and for a subscriber that is the one
   * that follows the log. Held here rather than trusted to every caller, which
   * is the call `work-loop.ts`'s `deliver` already makes for the in-process
   * subscribers.
   *
   * The assertion is that this file finishes: an escaped throw or rejection
   * fails the run as an unhandled error, whichever line it is reported against.
   */
  it("holds a report that throws, and one that rejects", async () => {
    // Each callback says it was reached *before* it fails, so awaiting these
    // two proves the failing line ran rather than hoping it had time to.
    const called = (fail: () => Promise<void>) =>
      new Promise<void>((reached) => {
        startCommand({ run: "exit 1", timeoutMs: 10_000, cwd, env }, () => {
          reached();
          return fail();
        });
      });

    await called(() => {
      throw new Error("the subscriber's own bug");
    });
    await called(() => Promise.reject(new Error("PluginFailed could not be appended")));

    // Both failures are already spent by here; the run finishing is the claim.
    expect((await run({ run: "exit 0" })).ok).toBe(true);
  });
});
