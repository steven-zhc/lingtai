/**
 * What a second attempt is told, and what a first one still is not.
 *
 * `#82`'s criteria are one test each. The one that would be easiest to break
 * silently is the last pair — a first attempt must stay byte-identical, and the
 * context must stay bounded — because both fail by producing *more* prompt
 * rather than by throwing.
 *
 * Unit, under `--project unit`: deciding what an attempt is told is a
 * fold over envelopes, and a decision that needed a database would be the wrong
 * shape.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVIDENCE_BYTES, tail } from "@lingtai/actions";
import {
  type Envelope,
  type EventType,
  type PayloadOf,
  SCHEMA_VER,
  parsePayload,
} from "@lingtai/domain";
import {
  attemptBrief,
  attemptOutcome,
  clamp,
  priorAttempts,
  promptVersionFor,
  type PromptBudget,
} from "../src/attempts.ts";

/**
 * The recipe's defaults (`runtime.budget`, 0029), spelled out here.
 *
 * Written rather than imported from `@lingtai/recipe`: these tests are about
 * the *shape* of the bound — that the brief does not grow with the number of
 * attempts — and importing the schema's number would make them re-assert the
 * schema instead. That the defaults are these values is the schema's own test.
 */
const BUDGET: PromptBudget = { evidence: 2_000, attempts: 5, findings: 5 };

let seq = 1n;

/** One stream's envelopes, versioned in call order. Payloads go through zod. */
function stream(streamId: string) {
  let version = 0;
  return function event<T extends EventType>(type: T, data: PayloadOf<T>): Envelope {
    version += 1;
    return {
      seq: seq++,
      streamId,
      version,
      type,
      schemaVer: SCHEMA_VER[type],
      data: parsePayload(type, data),
      actor: "conductor",
      causation: null,
      at: new Date("2026-09-08T12:00:00.000Z"),
    };
  };
}

const claim = (runId: string): PayloadOf<"WorkItemClaimed"> => ({
  runId,
  worker: "conductor",
  title: "A retry is a blind retry",
  kind: "bug",
});

const gate = (action: string, onSha = "sha-1") => ({
  gate: "proposed" as const,
  action,
  runId: "run-2",
  onSha,
});

describe("priorAttempts", () => {
  it("finds nothing on a work item nobody has claimed", () => {
    const e = stream("wi-lingtai-82");
    const events = [
      e("WorkItemDiscovered", {
        project: "lingtai",
        source: "github-issue",
        externalRef: "82",
        title: "A retry is a blind retry",
        kind: "bug",
        labels: ["bug"],
      }),
    ];

    expect(priorAttempts(events)).toEqual([]);
  });

  /**
   * The ticket's first criterion, at the level of the fold: how many attempts
   * there were and what ended each. `WorkItemClaimed` ×N is what `attempts: N`
   * on a card counts, so it is what this counts.
   */
  it("pairs each claim with the reason its release gives", () => {
    const e = stream("wi-lingtai-59");
    const attempts = priorAttempts([
      e("WorkItemClaimed", claim("run-1")),
      e("WorkItemReleased", { runId: "run-1", reason: "prepare failed at prepared:install" }),
      e("WorkItemClaimed", claim("run-2")),
      e("WorkItemReleased", {
        runId: "run-2",
        reason: "the run was killed by an operator timeout before it produced anything",
      }),
    ]);

    expect(attempts.map((a) => [a.n, a.runId, a.ended])).toEqual([
      [1, "run-1", "prepare failed at prepared:install"],
      [2, "run-2", "the run was killed by an operator timeout before it produced anything"],
    ]);
  });

  /** A second claim by one run is not a second attempt, any more than a second run. */
  it("counts a re-claim by the same run once", () => {
    const e = stream("wi-lingtai-59");
    expect(
      priorAttempts([e("WorkItemClaimed", claim("run-1")), e("WorkItemClaimed", claim("run-1"))]),
    ).toHaveLength(1);
  });

  /** An attempt that ended by asking a person ended, and the question is why. */
  it("reads a block as an ending, with its question", () => {
    const e = stream("wi-lingtai-59");
    const [attempt] = priorAttempts([
      e("WorkItemClaimed", claim("run-1")),
      e("WorkItemBlocked", {
        question: "conflict: agent/59 does not merge into main",
        needsFrom: "human",
        runId: "run-1",
        needs: null,
        diagnosis: null,
      }),
    ]);

    expect(attempt?.ended).toBe("blocked, asking: conflict: agent/59 does not merge into main");
  });

  /**
   * The ticket's second criterion for a merge failure: the integration refusal
   * itself, not the category the release reason summarises it into.
   */
  it("carries the integrator's refusal verbatim when one bought a repair", () => {
    const e = stream("wi-lingtai-59");
    const [attempt] = priorAttempts([
      e("WorkItemClaimed", claim("run-1")),
      e("RepairRequested", {
        runId: "run-1",
        reason: "conflict",
        detail: "agent/59 does not merge into main:\napps/web/src/app/page.tsx",
        fingerprint: "aaaaaaaaaaaa",
        attempt: 1,
      }),
      e("WorkItemReleased", { runId: "run-1", reason: "repairing conflict (attempt 1)" }),
    ]);

    expect(attempt?.refusal).toEqual({
      reason: "conflict",
      detail: "agent/59 does not merge into main:\napps/web/src/app/page.tsx",
    });
  });
});

describe("attemptOutcome", () => {
  it("reports what the run committed and what the gate said about it", () => {
    const e = stream("run-2");
    const outcome = attemptOutcome([
      e("RunProducedDiff", {
        branch: "agent/59",
        headSha: "1a2b3c4d5e6f",
        files: 4,
        insertions: 120,
        deletions: 3,
      }),
      e("GateStarted", gate("build")),
      e("GateFailed", {
        ...gate("build"),
        evidence: "tsc: apps/board/src/lib/board.ts(12,5): error TS2322",
        findings: [],
      }),
      e("RunFinished", { exitCode: 0, turns: 31, durationMs: 900_000, costUsd: 1.11 }),
    ], BUDGET);

    expect(outcome.produced).toEqual({
      branch: "agent/59",
      headSha: "1a2b3c4d5e6f",
      files: 4,
      insertions: 120,
      deletions: 3,
    });
    expect(outcome.evidence?.what).toBe("proposed:build");
    expect(outcome.evidence?.text).toContain("error TS2322");
    expect(outcome.receipt).toEqual({ turns: 31, costUsd: 1.11 });
  });

  /** A review gate's findings are the evidence; its output alone is a summary. */
  it("lists a review gate's findings under its output", () => {
    const e = stream("run-2");
    const outcome = attemptOutcome([
      e("GateFailed", {
        ...gate("review"),
        evidence: "1 blocker",
        findings: [
          {
            file: "packages/conductor/src/queue.ts",
            line: 44,
            claim: "the backoff is never applied",
            failureScenario: "a failing item is retaken on the next pass",
            severity: "blocker",
          },
        ],
      }),
    ], BUDGET);

    expect(outcome.evidence?.text).toContain("packages/conductor/src/queue.ts:44");
    expect(outcome.evidence?.text).toContain("the backoff is never applied");
  });

  /** The run's own ending, when no gate ever refused. */
  it("falls back to the run's failure", () => {
    const e = stream("run-1");
    const outcome = attemptOutcome([
      e("RunFailed", {
        kind: "timeout",
        detail: "the run was killed by an operator timeout before it produced anything",
      }),
    ], BUDGET);

    expect(outcome.produced).toBeNull();
    expect(outcome.evidence?.what).toBe("the run itself (timeout)");
    expect(outcome.evidence?.text).toContain("operator timeout");
  });

  /**
   * The ticket's "which point it died at": a `GateStarted` with no matching
   * verdict. There is no output to quote, and the fact is the finding — a fold
   * that only knows verdicts cannot say this, which is why this reads the
   * envelopes rather than `reduceRun`.
   */
  it("names the point a run died inside", () => {
    const e = stream("run-1");
    const outcome = attemptOutcome([e("GateStarted", gate("install"))], BUDGET);

    expect(outcome.evidence?.what).toBe("proposed:install");
    expect(outcome.evidence?.text).toContain("never returned a verdict");
  });

  it("says nothing about a gate that passed", () => {
    const e = stream("run-1");
    const outcome = attemptOutcome([
      e("GateStarted", gate("install")),
      e("GatePassed", { ...gate("install"), evidence: "ok", findings: [] }),
    ], BUDGET);

    expect(outcome.evidence).toBeNull();
  });
});

describe("attemptBrief", () => {
  const item = stream("wi-lingtai-59");
  const history = [
    item("WorkItemClaimed", claim("run-1")),
    item("WorkItemReleased", { runId: "run-1", reason: "prepare failed at prepared:install" }),
    item("WorkItemClaimed", claim("run-2")),
    item("WorkItemReleased", { runId: "run-2", reason: "gates refused the diff" }),
  ];

  const filled = () => {
    const attempts = priorAttempts(history);
    const run = stream("run-2");
    attempts[attempts.length - 1]!.outcome = attemptOutcome([
      run("RunProducedDiff", {
        branch: "agent/59",
        headSha: "1a2b3c4d5e6f",
        files: 4,
        insertions: 120,
        deletions: 3,
      }),
      run("GateFailed", {
        ...gate("build"),
        evidence: "tsc: apps/board/src/lib/board.ts(12,5): error TS2322",
        findings: [],
      }),
      run("RunFinished", { exitCode: 0, turns: 31, durationMs: 900_000, costUsd: 1.11 }),
    ], BUDGET);
    return attempts;
  };

  /**
   * **Attempt 1 is unchanged.** A first attempt has no history, so it must not
   * carry an empty "previous attempts" section — an empty block renders a
   * template byte-identically to the one this feature never touched, and
   * `promptVersionFor` then leaves the version alone as well.
   */
  it("is empty for a first attempt", () => {
    expect(attemptBrief([], BUDGET)).toBe("");
    expect(promptVersionFor("ticket@1932", "")).toBe("ticket@1932");
  });

  /** How many there were, and what ended each. */
  it("states the count and every ending", () => {
    const brief = attemptBrief(filled(), BUDGET);

    expect(brief).toContain("attempted 2 times already");
    expect(brief).toContain("This is attempt 3");
    expect(brief).toContain("prepare failed at prepared:install");
    expect(brief).toContain("gates refused the diff");
  });

  /** The failing evidence, not just a category. */
  it("quotes what refused the last attempt", () => {
    expect(attemptBrief(filled(), BUDGET)).toContain(
      "tsc: apps/board/src/lib/board.ts(12,5): error TS2322",
    );
  });

  /** What the previous attempt produced, so building on it is an option. */
  it("says what the last attempt committed and where it is", () => {
    const brief = attemptBrief(filled(), BUDGET);

    expect(brief).toContain("4 file(s), +120 −3");
    expect(brief).toContain("git fetch origin agent/59");
    expect(brief).toContain("1a2b3c4");
  });

  it("says so plainly when the last attempt committed nothing", () => {
    const attempts = priorAttempts(history);
    const run = stream("run-2");
    attempts[attempts.length - 1]!.outcome = attemptOutcome([
      run("RunFailed", { kind: "timeout", detail: "killed by an operator timeout" }),
    ], BUDGET);

    const brief = attemptBrief(attempts, BUDGET);
    expect(brief).toContain("It committed no change");
    expect(brief).not.toContain("git fetch origin");
  });

  /**
   * Not knowing and knowing there was nothing are different facts, and only one
   * of them is true when the run's stream was never read. Saying "it committed
   * no change" there would be an invention in a prompt.
   */
  it("claims nothing about a run whose stream nobody read", () => {
    const brief = attemptBrief(priorAttempts(history), BUDGET);

    expect(brief).toContain("gates refused the diff");
    expect(brief).not.toContain("### What attempt 2 produced");
    expect(brief).not.toContain("It committed no change");
  });

  /**
   * **The context is bounded**, and both bounds are here: a fifth attempt names
   * at most `budget.attempts` earlier ones and quotes exactly one run's output,
   * clamped to `budget.evidence`. Nothing in the shape of this brief grows with
   * the number of attempts except one table row.
   */
  it("keeps a long history and a long gate log bounded", () => {
    const many = stream("wi-lingtai-59");
    const events = Array.from({ length: 8 }, (_, i) => [
      many("WorkItemClaimed", claim(`run-${i + 1}`)),
      many("WorkItemReleased", { runId: `run-${i + 1}`, reason: `attempt ${i + 1} failed` }),
    ]).flat();

    const attempts = priorAttempts(events);
    const run = stream("run-8");
    attempts[attempts.length - 1]!.outcome = attemptOutcome([
      run("GateFailed", { ...gate("build"), evidence: "x".repeat(10_000), findings: [] }),
    ], BUDGET);

    const brief = attemptBrief(attempts, BUDGET);
    const rows = brief.split("\n").filter((l) => l.startsWith("| ") && l.includes("`run-"));

    expect(rows).toHaveLength(BUDGET.attempts);
    expect(brief).toContain("3 earlier attempt(s), omitted");
    expect(brief).toContain(`…elided ${10_000 - BUDGET.evidence} of 10000 characters here`);
    expect(brief.length).toBeLessThan(BUDGET.evidence + 3_000);
    // The one that would break the bound: an earlier run's output, pasted too.
    expect(brief).not.toContain("attempt 1 failed");
  });

  /**
   * **#171.** A vitest run prints every passing file before the first `FAIL`, so
   * the head of a failed build is the part that says nothing went wrong. A fix
   * round on #169 was shown 2000 characters of `✓` and committed nothing.
   *
   * The fixture is the build's evidence as `runCommand` stores it — the exit
   * line, then `tail()` of the output — with two failing tests, a diff of an
   * ordinary event payload each, and `pnpm`'s `ELIFECYCLE` after the summary, so
   * the first ` FAIL ` sits well over 1000 characters from the end. Quoted at
   * this repository's own `runtime.budget.evidence`, it names the test and the
   * assertion; quoted at the default's two ends, it does not, and that is the
   * reason the recipe does not use the default.
   */
  it("quotes a vitest-shaped failure at this recipe's budget with its FAIL still in it", () => {
    const passes = Array.from(
      { length: 200 },
      (_, i) => ` ✓ packages/conductor/test/run-once-${i}.test.ts > the merge lane > holds at a human action (48 tests | 3 skipped) 12034ms`,
    );
    const failed = (name: string) => [
      ` FAIL  packages/event-store/test/store.test.ts > ${name}`,
      "AssertionError: expected { type: 'WorkItemClaimed', …(3) } to deeply equal { type: 'WorkItemClaimed', …(3) }",
      "",
      "- Expected",
      "+ Received",
      "",
      "  {",
      ...Array.from({ length: 5 }, (_, i) => `-   "field${i}": "wi-lingtai-169/run-42ae0c78-1c72-480b-9b1e-be4bd6b0a819/expected-${i}",\n+   "field${i}": "wi-lingtai-169/run-42ae0c78-1c72-480b-9b1e-be4bd6b0a819/received-${i}",`),
      "  }",
      "",
      ` ❯ packages/event-store/test/store.test.ts:88:21`,
      "",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯",
    ];
    const output = [
      ...passes,
      ...failed("appends"),
      ...failed("reads back"),
      " Test Files  1 failed | 200 passed (201)",
      "      Tests  2 failed | 2400 passed (2402)",
      "   Start at  23:06:11",
      "   Duration  370.12s",
      " ELIFECYCLE  Test failed. See above for more details.",
      "ELIFECYCLE  Command failed with exit code 1.",
    ].join("\n");
    const evidence = `pnpm typecheck && pnpm test && pnpm test:db exited 1 after 370.1s\n\n${tail(output)}`;
    expect(evidence.length - evidence.indexOf(" FAIL  ")).toBeGreaterThan(1_000);
    expect(tail(output)).toContain(" FAIL  packages/event-store/test/store.test.ts > appends");

    const own = readFileSync(new URL("../../../.lingtai/config.yaml", import.meta.url), "utf8");
    const recipe = Number(/^  budget:\n    evidence: (\d+)$/m.exec(own)?.[1]);
    expect(recipe).toBeGreaterThanOrEqual(EVIDENCE_BYTES);

    const briefAt = (evidenceBudget: number) => {
      const budget = { ...BUDGET, evidence: evidenceBudget };
      const run = stream("run-1");
      const attempts = priorAttempts([
        stream("wi-lingtai-169")("WorkItemClaimed", claim("run-1")),
        stream("wi-lingtai-169")("WorkItemReleased", { runId: "run-1", reason: "gates refused the diff" }),
      ]);
      attempts[0]!.outcome = attemptOutcome(
        [run("GateFailed", { ...gate("build"), evidence, findings: [] })],
        budget,
      );
      return attemptBrief(attempts, budget);
    };

    const brief = briefAt(recipe);
    expect(brief).toContain("FAIL  packages/event-store/test/store.test.ts > appends");
    expect(brief).toContain("AssertionError: expected { type: 'WorkItemClaimed'");
    expect(brief).toContain("exited 1 after 370.1s");
    expect(brief).not.toContain("…elided");

    const atDefault = briefAt(BUDGET.evidence);
    expect(atDefault).not.toContain("FAIL  packages/event-store/test/store.test.ts > appends");
    expect(atDefault).toContain(`…elided ${evidence.length - BUDGET.evidence} of ${evidence.length} characters here`);
  });

  /**
   * The other runner: `tsc` prints its errors first, and a tail-only capture
   * loses them before `clamp` is ever reached. The fixture is this repository's
   * own `pnpm typecheck` failing — its preamble verbatim, 31 lines of `pnpm -r`
   * before the first error — with 200 more errors after it, and it goes through
   * `tail()` as `runCommand` stores it, not straight into `clamp`.
   */
  it("quotes a tsc-shaped failure past the capture with its first error still in it", () => {
    const output = [
      "$ pnpm -r --if-present typecheck",
      "Scope: 18 of 19 workspace projects",
      "packages/domain typecheck$ tsc --noEmit",
      "packages/extension typecheck$ tsc --noEmit",
      "packages/env typecheck$ tsc --noEmit",
      "packages/hook typecheck$ tsc --noEmit",
      "packages/hook typecheck: Done",
      "packages/telegram typecheck$ tsc --noEmit",
      "packages/extension typecheck: Done",
      "packages/env typecheck: Done",
      "packages/domain typecheck: Done",
      "packages/telegram typecheck: Done",
      "packages/event-store typecheck$ tsc --noEmit",
      "packages/agent-env typecheck$ tsc --noEmit",
      "packages/github typecheck$ tsc --noEmit",
      "packages/recipe typecheck$ tsc --noEmit",
      "packages/agent-env typecheck: Done",
      "packages/github typecheck: Done",
      "packages/recipe typecheck: Done",
      "packages/event-store typecheck: Done",
      "packages/agent typecheck$ tsc --noEmit",
      "packages/repo typecheck$ tsc --noEmit",
      "packages/projector typecheck$ tsc --noEmit",
      "packages/projector typecheck: Done",
      "packages/agent typecheck: Done",
      "packages/repo typecheck: Done",
      "apps/site typecheck$ tsc --noEmit",
      "packages/actions typecheck$ tsc --noEmit",
      "packages/actions typecheck: Done",
      "apps/site typecheck: Done",
      "packages/conductor typecheck$ tsc --noEmit",
      "packages/conductor typecheck: src/attempts.ts(393,10): error TS2322: Type 'number' is not assignable to type 'string'.",
      ...Array.from(
        { length: 200 },
        (_, i) => `packages/conductor typecheck: src/generated-${i}.ts(1,1): error TS6133: 'unused' is declared but its value is never read.`,
      ),
      "packages/conductor typecheck: Found 201 errors in 201 files.",
      "packages/conductor typecheck: Failed",
      "[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @lingtai/conductor@0.0.0 typecheck: `tsc --noEmit`",
      "Exit status 2",
      "[ELIFECYCLE] Command failed with exit code 2.",
    ].join("\n");
    const evidence = `pnpm typecheck && pnpm test && pnpm test:db exited 2 after 41.2s\n\n${tail(output)}`;
    expect(output.split("\n").slice(-60).join("\n")).not.toContain("TS2322");
    expect(evidence).toContain("error TS2322: Type 'number' is not assignable");
    expect(evidence).toContain("Found 201 errors in 201 files.");
    expect(evidence.length).toBeLessThanOrEqual(EVIDENCE_BYTES * 1.25 + 200);

    const own = readFileSync(new URL("../../../.lingtai/config.yaml", import.meta.url), "utf8");
    const recipe = Number(/^  budget:\n    evidence: (\d+)$/m.exec(own)?.[1]);
    const quoted = clamp(evidence, recipe);

    expect(quoted).toContain("error TS2322: Type 'number' is not assignable");
    expect(quoted).toContain("Found 201 errors in 201 files.");
    expect(quoted).toContain("exited 2 after 41.2s");
  });

  /** What fits is quoted whole, and says nothing about truncation it did not do. */
  it("leaves an output within the budget whole and unmarked", () => {
    const short = "pnpm typecheck exited 2 after 9s\n\nsrc/x.ts(1,1): error TS2304";
    expect(clamp(short, BUDGET.evidence)).toBe(short);
    expect(clamp("x".repeat(BUDGET.evidence), BUDGET.evidence)).not.toContain("elided");
  });

  /** The bound is still a bound: the two ends together are the budget, not twice it. */
  it("keeps exactly the budget's worth of characters across the two ends", () => {
    const text = `${"a".repeat(5_000)}${"b".repeat(5_000)}`;
    const quoted = clamp(text, 101);
    const [head, marker, tail] = quoted.split("\n");

    expect(head).toBe("a".repeat(51));
    expect(tail).toBe("b".repeat(50));
    expect(marker).toBe("…elided 9899 of 10000 characters here; the start and the end are shown…");
  });

  /** A reason with a newline in it must not break the table it sits in. */
  it("keeps a multi-line release reason on one row", () => {
    const e = stream("wi-lingtai-59");
    const brief = attemptBrief(
      priorAttempts([
        e("WorkItemClaimed", claim("run-1")),
        e("WorkItemReleased", { runId: "run-1", reason: "conflict:\napps/page.tsx\napps/x.tsx" }),
      ]),
     BUDGET);

    expect(brief).toContain("| 1 | `run-1` | conflict: apps/page.tsx apps/x.tsx |");
  });
});

describe("promptVersionFor", () => {
  /**
   * The criterion that made the defect invisible. Both attempts at `#59`
   * recorded `promptVersion: "ticket@1911"`, so the log could not say that the
   * second one had been told anything the first had not — and it had not.
   */
  it("distinguishes two attempts told different things", () => {
    const first = promptVersionFor("ticket@1932", "");
    const second = promptVersionFor("ticket@1932", "the build refused");
    const third = promptVersionFor("ticket@1932", "the review refused");

    expect(first).toBe("ticket@1932");
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    expect(second).toMatch(/^ticket@1932\+failure@[0-9a-f]{12}$/);
  });

  /** The same context twice is the same version — it is a fingerprint, not a counter. */
  it("is stable for the same context", () => {
    expect(promptVersionFor("ticket@1932", "the build refused")).toBe(
      promptVersionFor("ticket@1932", "the build refused"),
    );
  });
});
