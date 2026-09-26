/**
 * The process action and the pipeline, against real processes.
 *
 * Nothing is mocked: an action is a command and an exit code, so a test that stubs
 * the command is testing nothing. The properties that matter are `onSha` on
 * every verdict, a timeout that is distinguishable from a refusal, evidence a
 * person could act on, and a pipeline that stops the moment something says no.
 *
 * **In `integration/`, because *against real processes* is the literal claim.**
 * `createProcessAction` reaches `spawn(run, {shell: true})` through
 * `src/process-action.ts` and `src/command.ts`, and an OS process is outside the
 * system ([0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1).
 * Nothing in this file names `node:child_process`, which is how it was read as
 * unit at first: the spawn is three modules down the barrel, and #225's own
 * note that the split was decided *by running each one, not by reading
 * imports* is the sentence that was lost with the config it stood in.
 *
 * What it would have cost is measurable rather than theoretical: *distinguishes
 * a timeout from a refusal* asks a forked shell to be scheduled and to flush
 * `starting` to a pipe inside 300ms of wall clock. On a loaded machine — the
 * ~0.5s spawn 0060 measured at 66s beside `apps/release`'s builds — the shell
 * is killed before it writes, and `build` goes red on a diff that never came
 * near `packages/actions`.
 */
import { describe, expect, it } from "vitest";
import type { RunRequest, Runtime } from "@lingtai/agent";
import {
  ActionUnavailableError,
  type ActionEvent,
  type ProcessActionSpec,
  createProcessAction,
  actionsFromRecipe,
  runActionPipeline,
  tail,
} from "../src/index.ts";

const context = {
  runId: "run-01JX",
  onSha: "sha-a",
  cwd: process.cwd(),
  // The **agent's**, which since 0037 §1 is not what a `run:` action is given.
  // Every assertion below about a command's environment is about `env` on the
  // spec, and this being different from it is the point.
  env: { PATH: process.env["PATH"] ?? "", AGENT_ONLY: "the agent's" },
};

/** What a process action needs to find `echo` and `sleep`, and nothing else. */
const runnable = { PATH: process.env["PATH"] ?? "" };

/** An action whose declared environment is only what a shell needs. */
const processAction = (spec: Omit<ProcessActionSpec, "env">) =>
  createProcessAction({ ...spec, env: runnable });

describe("the process action", () => {
  it("passes on exit 0 and says what ran", async () => {
    const action = processAction({ name: "build", run: "exit 0" });
    const result = await action.run(context);

    expect(result.verdict).toBe("passed");
    expect(result.evidence).toContain("exit 0");
  });

  /**
   * The board's promise is that a card is workable without leaving it. "The
   * build failed" with no output is a link to somewhere else wearing a disguise.
   */
  it("fails on a non-zero exit and carries the log tail", async () => {
    const action = processAction({
      name: "build",
      run: "echo 'src/a.ts(12,3): error TS2345'; echo 'Found 1 error.'; exit 2",
    });
    const result = await action.run(context);

    expect(result.verdict).toBe("failed");
    expect(result.evidence).toContain("exited 2");
    expect(result.evidence).toContain("error TS2345");
    expect(result.evidence).toContain("Found 1 error.");
  });

  it("captures stderr as well as stdout, because compilers use both", async () => {
    const action = processAction({ name: "build", run: "echo boom >&2; exit 1" });
    expect((await action.run(context)).evidence).toContain("boom");
  });

  /**
   * An action that ran out of time and an action that ran and refused are different
   * problems with different fixes. The old loop's could hang to the two-hour
   * wall clock and then report nothing at all.
   */
  it("distinguishes a timeout from a refusal", async () => {
    const action = processAction({ name: "build", run: "echo starting; sleep 5", timeout: "300ms" });
    const result = await action.run(context);

    expect(result.verdict).toBe("failed");
    expect(result.evidence).toContain("timed out after 300ms");
    // And what it managed to print before being killed is still evidence.
    expect(result.evidence).toContain("starting");
    expect(result.evidence).not.toContain("exited");
  });

  it("fails rather than throwing when the command cannot run at all", async () => {
    const action = processAction({ name: "build", run: "this-command-does-not-exist" });
    const result = await action.run(context);
    expect(result.verdict).toBe("failed");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("runs in the worktree it was given", async () => {
    const action = processAction({ name: "where", run: "pwd; exit 1" });
    const result = await action.run({ ...context, cwd: "/tmp" });
    expect(result.evidence).toContain("/tmp");
  });

  it("refuses a timeout that is not a duration rather than defaulting to zero", () => {
    // An action that silently got a 0ms timeout would fail every run for a reason
    // nobody could see.
    expect(() => processAction({ name: "x", run: "true", timeout: "soon" })).toThrow(/duration/);
  });
});

describe("tail", () => {
  it("keeps the end, which is where the error is", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const kept = tail(text, 10);
    expect(kept).toContain("line 499");
    expect(kept).not.toContain("line 100");
  });

  it("keeps the start as well when it does not all fit, which is where tsc's error is (#171)", () => {
    const text = ["tsc: first error", ...Array.from({ length: 500 }, (_, i) => `line ${i}`)].join("\n");
    const kept = tail(text, 10, 400);
    expect(kept).toContain("tsc: first error");
    expect(kept).toContain("line 499");
    expect(kept).not.toContain("line 100");
    expect(kept).toMatch(/…\d+ characters elided here/);
    expect(kept.length).toBeLessThanOrEqual(400 + 100 + 80);
  });

  it("keeps an output whole and unmarked when its start and its last lines meet", () => {
    for (const length of [61, 80, 120]) {
      const text = Array.from({ length }, (_, i) => `line ${i}`).join("\n");
      expect(tail(text)).toBe(text);
    }
  });

  it("keeps the last lines it kept before it kept a start, which is where vitest's first FAIL is", () => {
    const diff = (name: string) => [
      ` FAIL  packages/event-store/test/store.test.ts > ${name}`,
      ...Array.from({ length: 26 }, (_, i) => `-   "field${i}": "${"x".repeat(100)}",`),
    ];
    const text = [
      ...Array.from({ length: 200 }, (_, i) => ` ✓ packages/conductor/test/run-once-${i}.test.ts (48 tests) 12034ms`),
      ...diff("appends"),
      ...diff("reads back"),
      " Test Files  1 failed | 200 passed (201)",
      "      Tests  2 failed | 2400 passed (2402)",
      "   Duration  370.12s",
      " ELIFECYCLE  Test failed. See above for more details.",
      "ELIFECYCLE  Command failed with exit code 1.",
    ].join("\n");
    const last = text.split("\n").slice(-60).join("\n");
    expect(last.length).toBeGreaterThan(6_000);
    expect(last).toContain("> appends");

    const kept = tail(text);
    expect(kept).toContain(last);
    expect(kept).toContain(" ✓ packages/conductor/test/run-once-0.test.ts");
    expect(kept.length).toBeLessThanOrEqual(8_000 * 1.25 + 80);
  });

  it("caps bytes as well as lines, because one line can be a megabyte", () => {
    expect(tail("x".repeat(50_000), 10, 100).length).toBeLessThanOrEqual(101);
  });
});

describe("the pipeline", () => {
  function collector() {
    const events: ActionEvent[] = [];
    return { events, emit: (e: ActionEvent) => void events.push(e) };
  }

  /**
   * An action with no agent writes its start and its end to the run's log and
   * nothing between (#153): a four-minute build is no longer four dark minutes,
   * and nothing pretends there is an agent to follow.
   */
  it("writes each action's start and end to the run's log, tagged with the step", async () => {
    const lines: [string, string][] = [];
    const log = { note: (label: string, detail = "") => void lines.push([label, detail]) };
    await runActionPipeline({
      step: "proposed",
      actions: [processAction({ name: "build", run: "echo compiling; exit 0" })],
      context: { ...context, onSha: "abcdef0123", round: 2, log },
      emit: () => {},
    });

    expect(lines).toEqual([
      ["proposed:build", "started · run on abcdef0 · round 2"],
      ["proposed:build", expect.stringMatching(/^passed · after \d+s · round 2$/)],
    ]);
  });

  it("puts onSha on every verdict", async () => {
    const { events, emit } = collector();
    await runActionPipeline({
      step: "proposed",
      actions: [processAction({ name: "build", run: "exit 0" })],
      context,
      emit,
    });

    // A verdict is about a diff, not about a ticket. Bind it to the commit and a
    // force-push invalidates the approval instead of inheriting it.
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(["GateRequested", "GateStarted", "GatePassed"]);
    for (const e of events) expect(e.data.onSha).toBe("sha-a");
  });

  it("runs in recipe order", async () => {
    const { events, emit } = collector();
    await runActionPipeline({
      step: "proposed",
      actions: [
        processAction({ name: "build", run: "exit 0" }),
        processAction({ name: "lint", run: "exit 0" }),
      ],
      context,
      emit,
    });

    // `gate` is the step and `action` is what ran there — two fields, because
    // "the build failed" and "something at the `proposed` step failed" are different
    // questions and one name could not answer both.
    const started = events.filter((e) => e.type === "GateStarted");
    expect(started.map((e) => e.data.action)).toEqual(["build", "lint"]);
    expect(started.map((e) => e.data.gate)).toEqual(["proposed", "proposed"]);
  });

  /**
   * Stopping is deliberate. Running the rest costs money for verdicts about a
   * diff that is not going anywhere, and three green badges beside one red
   * invites the reading that it is three-quarters fine.
   */
  it("stops at the first failure and names what it skipped", async () => {
    const { events, emit } = collector();
    const result = await runActionPipeline({
      step: "proposed",
      actions: [
        processAction({ name: "build", run: "exit 0" }),
        processAction({ name: "lint", run: "echo nope; exit 1" }),
        processAction({ name: "test", run: "exit 0" }),
      ],
      context,
      emit,
    });

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe("lint");
    expect(result.skipped).toEqual(["test"]);
    expect(events.map((e) => e.data.gate)).not.toContain("test");
    expect(events.at(-1)?.type).toBe("GateFailed");
  });

  /**
   * **An action that never ran stops the pipeline and refuses nothing** (`#133`).
   *
   * Stopping looks like the line above and means something else. The actions
   * after this one would ask the same account the same question and meet the
   * same wall, so continuing is pointless — but nothing here judged the diff,
   * so no verdict may be appended about it. `GateNeverRan` is what is on the
   * log instead, and `neverRanAt` is how `endingOf` in
   * `packages/conductor/src/pass.ts` tells this ending from a refusal without
   * reading a sentence.
   */
  it("appends no verdict for an action whose agent never started, and stops", async () => {
    const { events, emit } = collector();
    const said = "You've hit your session limit \u00b7 resets 2pm (America/Chicago)";
    const result = await runActionPipeline({
      step: "proposed",
      actions: [
        processAction({ name: "build", run: "exit 0" }),
        {
          name: "review",
          kind: "agent" as const,
          run: async () => ({ verdict: "never-ran" as const, evidence: said, findings: [] }),
        },
        processAction({ name: "test", run: "exit 0" }),
      ],
      context,
      emit,
    });

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBeNull();
    expect(result.heldAt).toBeNull();
    expect(result.neverRanAt).toEqual({ action: "review", detail: said });
    expect(result.skipped).toEqual(["test"]);

    const types = events.map((e) => e.type);
    expect(types).toContain("GateNeverRan");
    expect(types).not.toContain("GateFailed");
    // And the build's own verdict is untouched: one action did judge the diff.
    expect(types.filter((t) => t === "GatePassed")).toHaveLength(1);
    expect(events.at(-1)?.data).toMatchObject({ gate: "proposed", action: "review", onSha: "sha-a" });
  });

  /**
   * **Once is a person's, and it still refuses nothing** (0057 §1–3).
   *
   * The pipeline stops the way `never-ran` stops it and for a nearer reason —
   * this action is not going to produce a verdict this pass — but no verdict
   * event may be appended about a diff nothing judged. `didNotFinishAt` is how
   * `endingOf` in `packages/conductor/src/pass.ts` tells this ending from a
   * refusal without reading a sentence,
   * which is the whole of the defect: the difference used to live only inside
   * `evidence`, and `decideFix` bought a round off it.
   *
   * **And the action is run once, which is `#234`.** 0057 §4 ran it a second
   * time under the same session id `sessionIdFor` computes from
   * `<runId>:<step>:<action>:<sha>`, so every retry this machine took was
   * refused in zero seconds with `Session ID … is already in use` and reached no
   * reviewer. One run, one event, and nothing on that event claiming an attempt
   * number — the fields went with the retry.
   */
  it("appends one verdictless event for an action that did not finish, and stops", async () => {
    const { events, emit } = collector();
    const said = "the reviewer did not finish (crash): Error: Session ID 0f1e is already in use.";
    let attempts = 0;
    const result = await runActionPipeline({
      step: "proposed",
      actions: [
        processAction({ name: "build", run: "exit 0" }),
        {
          name: "review",
          kind: "agent" as const,
          run: async () => {
            attempts += 1;
            return { verdict: "did-not-finish" as const, evidence: said, findings: [] };
          },
        },
        processAction({ name: "test", run: "exit 0" }),
      ],
      context,
      emit,
    });

    // Once. A retry recomputes the session id the first attempt opened, so it
    // never ran a reviewer — `#234` deleted it rather than leaving the log
    // saying the action did not finish twice when it was tried once.
    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBeNull();
    expect(result.heldAt).toBeNull();
    // And not 0041's ending either: a crash is local, and reading this as an
    // account-wide wall would stand the whole conductor down for it (§3).
    expect(result.neverRanAt).toBeNull();
    expect(result.didNotFinishAt).toEqual({ action: "review", detail: said });
    expect(result.skipped).toEqual(["test"]);

    const types = events.map((e) => e.type);
    expect(types).not.toContain("GateFailed");
    expect(types).not.toContain("GateNeverRan");
    // The build's own verdict stands: one action did judge the diff.
    expect(types.filter((t) => t === "GatePassed")).toHaveLength(1);

    // One event for one run of the action, and one start for it: a second of
    // either would be the retry back, or a board drawing an attempt nobody made.
    const didNot = events.filter((e) => e.type === "GateDidNotFinish");
    expect(didNot.map((e) => e.data)).toEqual([
      { gate: "proposed", action: "review", runId: context.runId, onSha: "sha-a", detail: said },
    ]);
    expect(didNot[0]!.data).not.toHaveProperty("attempt");
    expect(didNot[0]!.data).not.toHaveProperty("retrying");
    expect(
      events.filter((e) => e.type === "GateStarted" && e.data.action === "review"),
    ).toHaveLength(1);
  });

  it("turns an action that throws into a failure rather than an escaped exception", async () => {
    const { emit } = collector();
    const result = await runActionPipeline({
      step: "proposed",
      actions: [
        {
          name: "broken",
          kind: "run" as const,
          run: () => Promise.reject(new Error("the action itself is broken")),
        },
      ],
      context,
      emit,
    });

    // A run must never end with no verdict.
    expect(result.ok).toBe(false);
    expect(result.results[0]!.evidence).toContain("the action itself is broken");
  });

  it("emits nothing at all for an empty pipeline", async () => {
    const { events, emit } = collector();
    const result = await runActionPipeline({ step: "proposed", actions: [], context, emit });
    expect(result.ok).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("actionsFromRecipe", () => {
  it("builds the process actions", () => {
    const actions = actionsFromRecipe(
      "proposed",
      [{ name: "build", run: "pnpm verify", timeout: "15m", env: [] }],
      { env: () => runnable },
    );
    expect(actions.map((g) => g.name)).toEqual(["build"]);
  });

  /**
   * The declared names reach the resolver, and nothing else does — 0037 §1.
   *
   * Asserted on the *call* rather than only on the child, because this is the
   * half that decides: a factory that passed the step's environment through
   * would look identical from the outside until somebody read the process list.
   */
  it("asks the resolver for exactly what the action declared", () => {
    const asked: (readonly string[])[] = [];
    actionsFromRecipe(
      "proposed",
      [
        { name: "telegram", run: "npx @lingtai/telegram", timeout: "30s", env: ["TELEGRAM_TOKEN"] },
        { name: "build", run: "pnpm verify", timeout: "15m", env: [] },
      ],
      {
        env: (declared) => {
          asked.push(declared);
          return runnable;
        },
      },
    );
    expect(asked).toEqual([["TELEGRAM_TOKEN"], []]);
  });

  /**
   * A pipeline that silently skipped the `human` action because nothing implements
   * it would produce a green board for a change nobody approved.
   */
  it("builds every kind the schema allows", () => {
    // All four exist now. The factory has an exhaustiveness check against the
    // schema union, so a fifth kind is a type error rather than an action that
    // falls through and silently does nothing.
    expect(actionsFromRecipe("proposed", [{ name: "approval", human: "Merge?" }])).toHaveLength(1);
    expect(
      actionsFromRecipe("proposed", [{ name: "tamper", watch: ["**/x"], then: "fail" }], {
        watch: { changedFiles: async () => [] },
      }),
    ).toHaveLength(1);
  });

  /**
   * **All three of the `agent:` plugin's fields cross this seam** (`#245`).
   *
   * `prompt:` is what the reviewer is told and `model:` is what it costs, and
   * both of them being on the action is not the same as either of them reaching
   * the spawn — a factory that built the action from `{name}` alone would resolve,
   * hash and render exactly as this one does, and review at the default price
   * with a prompt the recipe never wrote. So this asserts on `RunRequest`, past
   * every layer that could have dropped one: the action, the spec, the request.
   *
   * `agent:` itself does not travel, and that is the third fact rather than a
   * gap: one conductor dispatches one runtime, `deps.agent.runtime` is it, and
   * a step naming the other is refused before the claim by `agentRefusal`.
   */
  it("carries an agent action's prompt and model as far as the reviewer's spawn", async () => {
    const seen: RunRequest[] = [];
    const runtime: Runtime = {
      capabilities: {
        id: "claude-code",
        hooks: [],
        canFailClosed: true,
        canRewriteToolCall: false,
        providesTier: "guarded",
        enforces: ["turns", "wall"],
      },
      async run(request) {
        seen.push(request);
        return {
          exitCode: 0,
          turns: 1,
          durationMs: 1,
          costUsd: 0,
          text: '{"findings":[]}',
          failure: null,
          sessionId: "s",
        };
      },
    };
    const agent = {
      runtime,
      issue: async () => ({ ref: "245", title: "t", body: "b" }),
      diff: async () => "diff --git a/x b/x\n+1",
      settingsPath: "/tmp/s.json",
      limits: { turns: 40, wallMs: 1000, diffBytes: 400_000 },
    };

    const [action] = actionsFromRecipe(
      "proposed",
      [{ name: "review", agent: "claude-code", model: "claude-haiku-4-5", prompt: "look for races" }],
      { agent },
    );
    await action?.run(context);

    expect(seen[0]?.model).toBe("claude-haiku-4-5");
    expect(seen[0]?.prompt).toContain("look for races");
    // And never the runtime's name where the prose belongs.
    expect(seen[0]?.prompt).not.toContain("## Also for this project\n\nclaude-code");

    // No `model:` on the action sends no `model` key, so the runtime's own
    // default is what runs — the one thing this seam must not invent.
    const [bare] = actionsFromRecipe(
      "proposed",
      [{ name: "review", agent: "claude-code", prompt: "look for races" }],
      { agent },
    );
    await bare?.run(context);
    expect("model" in (seen[1] ?? {})).toBe(false);
  });

  it("refuses an action whose dependencies are missing, rather than skipping it", () => {
    // `agent` is implemented, but it needs a runtime, a ticket and a diff, and
    // callers that only want to know whether a recipe *parses* do not have
    // them. Absent deps refuse for the same reason an unbuilt kind does: an action
    // that is silently not run is worse than a run that will not start.
    expect(() => actionsFromRecipe("proposed", [{ name: "review", agent: "claude-code", prompt: "p" }])).toThrow(
      ActionUnavailableError,
    );
    expect(() => actionsFromRecipe("proposed", [{ name: "review", agent: "claude-code", prompt: "p" }])).toThrow(
      /no reviewer was supplied/,
    );
    expect(() =>
      actionsFromRecipe("proposed", [{ name: "tamper", watch: ["**/x"], then: "fail" }]),
    ).toThrow(/no file list was supplied/);
    // A `run:` action's whole environment is now a dependency like the other
    // two. Without a resolver it would have no `PATH` either, so the failure
    // would read as a broken build rather than as an action built wrong.
    expect(() =>
      actionsFromRecipe("proposed", [{ name: "build", run: "pnpm verify", timeout: "15m", env: [] }]),
    ).toThrow(/no environment resolver was supplied/);
  });
});

/**
 * The property 0037 §1 is about, asserted against a real process.
 *
 * *"A Telegram bot token must reach the Telegram extension and nothing else."*
 * The two halves are one test on purpose: a command that reads its own declared
 * variable and cannot read the one beside it is the whole of the guarantee, and
 * either half alone passes for the wrong reason — an environment that is empty
 * proves nothing, and one that is full proves nothing either.
 */
describe("an extension's process", () => {
  const printBoth = 'echo "declared=[${TELEGRAM_TOKEN-}] other=[${LINGTAI_DATABASE_URL-}]"; exit 1';

  it("reads what it declared and cannot read what it did not", async () => {
    const action = createProcessAction({
      name: "telegram",
      run: printBoth,
      env: { ...runnable, TELEGRAM_TOKEN: "bot-token" },
    });

    const result = await action.run({
      ...context,
      // The conductor's own environment, in the context, holding the one name
      // 0037 §1 names. The child must not see it.
      env: { ...context.env, LINGTAI_DATABASE_URL: "postgres://the-log" },
    });

    expect(result.evidence).toContain("declared=[bot-token]");
    expect(result.evidence).toContain("other=[]");
  });

  /** Nothing declared is nothing given — not the environment of whoever ran it. */
  it("gets nothing when it declared nothing", async () => {
    process.env["LINGTAI_EXTENSION_PROBE"] = "the daemon's";
    try {
      const action = createProcessAction({
        name: "bare",
        run: 'echo "probe=[${LINGTAI_EXTENSION_PROBE-}]"; exit 1',
        env: runnable,
      });
      expect((await action.run(context)).evidence).toContain("probe=[]");
    } finally {
      delete process.env["LINGTAI_EXTENSION_PROBE"];
    }
  });
});
