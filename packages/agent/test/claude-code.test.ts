/**
 * The adapter, against a stand-in `claude` rather than the real one.
 *
 * A real Claude Code run costs money and takes minutes, and none of the
 * properties under test are about the model: they are about what the adapter
 * does with a process that exits cleanly, exits badly, never exits, or is not
 * there at all. Each of those is a script here.
 *
 * The one thing a stand-in cannot check is that `claude` accepts these flags.
 * They were read off `claude --help` on 2026-09-09 — `-p`, `--output-format
 * stream-json`, `--verbose`, `--settings`, `--session-id`, `--model` — and the
 * first supervised run is what actually proves them. The pairing is checked:
 * 2.1.263 refuses `--print` with `--output-format=stream-json` and no
 * `--verbose`, and says so on stderr rather than starting.
 *
 * **The stream fixtures below are shapes, not inventions.** Every field in
 * `RECEIPT` and every line in `stream()` was read off a real
 * `--output-format stream-json --verbose` run on 2026-09-09, with the session
 * ids and the usage numbers replaced. That matters here more than usual:
 * `#109`'s whole risk is that the accounting reads a line the real binary does
 * not print, or fails to read one it does.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  CodexNotImplementedError,
  PROMPT_ELIDED,
  RUN_LIMITS,
  TRACE_LINE_CHARS,
  capabilitiesFor,
  createClaudeCodeRuntime,
  createCodexRuntime,
  meetsTier,
  missingForTier,
  neverStarted,
  openRunLog,
  parseResult,
  sessionIdFor,
  traceOf,
  turnCounter,
  type RunTrace,
} from "../src/index.ts";

let root: string;

/** A script standing in for `claude`, so the adapter meets a real process. */
async function fakeClaude(body: string): Promise<string> {
  const path = join(root, `claude-${crypto.randomUUID().slice(0, 8)}.sh`);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/**
 * The last line of a stream: the object that says `type: "result"`.
 *
 * The same object `--output-format json` printed on its own, which is what
 * makes the accounting comparable across the change.
 */
const RECEIPT = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 4_210_000,
  duration_api_ms: 4_101_233,
  num_turns: 63,
  result: "the point runs on every outcome, not just an inline merge",
  session_id: sessionIdFor("run-01JX"),
  total_cost_usd: 5.42,
  usage: { input_tokens: 10, output_tokens: 4_212 },
  permission_denials: [],
  terminal_reason: "completed",
  uuid: "f0e4abbc-18b5-4a48-87e7-86a24b4fb6fe",
};

/** What the agent said, and everything the runtime says around it. */
const stream = (receipt: Record<string, unknown> | null = RECEIPT) => [
  { type: "system", subtype: "hook_started", hook_name: "SessionStart:startup", hook_event: "SessionStart" },
  { type: "system", subtype: "init", cwd: "/tmp", model: "claude-opus-5", tools: ["Read", "Edit", "Bash"] },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "the close handler is what produces the accounting", signature: "Ep8DCrIBCBEY" }],
    },
  },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Reading the adapter first." }] } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "packages/agent/src/claude-code.ts" } }],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "…four hundred lines of the adapter…" }],
    },
  },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1_788_994_800 } },
  ...(receipt ? [receipt] : []),
];

/** A `claude` that prints those lines, one per line, and exits. */
async function fakeStream(lines: readonly unknown[], exit = 0, trailer = ""): Promise<string> {
  return fakeClaude(
    ["cat <<'JSON'", ...lines.map((l) => JSON.stringify(l)), "JSON", ...(trailer ? [trailer] : []), `exit ${exit}`].join(
      "\n",
    ),
  );
}

/** A log that remembers, so a test can read what a run wrote to one. */
function recordingTrace(): RunTrace & { lines: string[] } {
  const lines: string[] = [];
  return { lines, note: (label, detail = "") => void lines.push(`${label}\t${detail}`) };
}

const request = (over: Partial<Parameters<ReturnType<typeof createClaudeCodeRuntime>["run"]>[0]> = {}) => ({
  runId: "run-01JX",
  cwd: root,
  prompt: "fix the thing",
  settingsPath: join(root, "settings.json"),
  env: { PATH: process.env["PATH"] ?? "" },
  limits: { turns: 300, wallMs: 30_000 },
  ...over,
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lingtai-runtime-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("capabilities", () => {
  it("declares the intersection plus Claude Code's extras", () => {
    expect(CLAUDE_CODE_CAPABILITIES.hooks).toEqual(
      expect.arrayContaining(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]),
    );
    // Bonus signal: better when present, never required.
    expect(CLAUDE_CODE_CAPABILITIES.hooks).toContain("PreCompact");
    // Codex has only the five, which is why the contract is the intersection.
    expect(CODEX_CAPABILITIES.hooks).toHaveLength(5);
    expect(CODEX_CAPABILITIES.hooks).not.toContain("PreCompact");
  });

  /**
   * A project's safety level must not depend on which agent happens to be
   * running today. Claude Code cannot provide `sandboxed` on its own, and the
   * scheduler has to be able to say so *before* dispatching.
   */
  it("says which runtime can carry which tier, and what is missing", () => {
    expect(meetsTier(CLAUDE_CODE_CAPABILITIES, "guarded")).toBe(true);
    expect(meetsTier(CLAUDE_CODE_CAPABILITIES, "sandboxed")).toBe(false);
    expect(meetsTier(CODEX_CAPABILITIES, "sandboxed")).toBe(true);

    // Named, so DispatchRefused carries a reason rather than a refusal.
    expect(missingForTier(CLAUDE_CODE_CAPABILITIES, "sandboxed")).toEqual(["filesystem-sandbox"]);
    expect(missingForTier(CLAUDE_CODE_CAPABILITIES, "guarded")).toEqual([]);
  });

  /**
   * `#89`: a limit is only declared where the adapter says it applies it.
   *
   * Asserted against `RUN_LIMITS` rather than against a written-out pair, so a
   * third limit added to the recipe and forgotten here is a red test rather
   * than a bound nobody notices is missing — which is the bug, one field along.
   */
  it("says which declared limits it actually applies", () => {
    expect([...CLAUDE_CODE_CAPABILITIES.enforces].sort()).toEqual([...RUN_LIMITS].sort());
    // A stub applies nothing, and claiming otherwise would be the bug written
    // down deliberately.
    expect(CODEX_CAPABILITIES.enforces).toEqual([]);
    expect(capabilitiesFor("claude-code")).toBe(CLAUDE_CODE_CAPABILITIES);
    expect(capabilitiesFor("codex")).toBe(CODEX_CAPABILITIES);
  });
});

/**
 * `#89` — the bound that was declared, carried and never applied.
 *
 * `.lingtai/config.yaml` said `turns: 150`; `#84` ran 172 and cost $26.53, and
 * nothing refused, warned or noticed. The value reached `RunRequest.limits` and
 * the adapter read the other field of the same struct three lines away.
 *
 * There is no flag to delegate this to: **2.1.267 has no `--max-turns`**
 * (`claude --help`, 2026-09-10, which offers `--max-budget-usd` and nothing
 * about turns), so the adapter counts. The counting rule is the thing under
 * test, because a rule that over-counts kills a healthy run.
 */
describe("the turn limit", () => {
  /** One assistant response, however many stream events it arrives as. */
  const assistant = (id: string | null, block: Record<string, unknown>, parent: string | null = null) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { role: "assistant", id, content: [block] },
  });

  /**
   * The rule, against the shapes a real run prints.
   *
   * Measured on 2026-09-10: a run whose stream carried five `assistant` events
   * under four `message.id`s reported `num_turns: 4`. Counting events would
   * have said five — and a bound that fires a turn early is a run killed for
   * nothing.
   */
  it("counts an assistant response once, however many events it arrives as", () => {
    const count = turnCounter();
    const lines = [
      { type: "system", subtype: "init" },
      // One response, two blocks, two events — the pair that makes counting
      // events wrong.
      assistant("msg_A", { type: "text", text: "Reading the adapter first." }),
      assistant("msg_A", { type: "tool_use", id: "toolu_1", name: "Read", input: {} }),
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] } },
      assistant("msg_B", { type: "tool_use", id: "toolu_2", name: "Bash", input: {} }),
      // A subagent's traffic rides the same stream and is accounted for
      // separately in the receipt's `subagent_stats`. Not this loop's turns.
      assistant("msg_C", { type: "text", text: "from inside a Task" }, "toolu_2"),
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
      assistant("msg_D", { type: "text", text: "done" }),
    ];

    expect(lines.map((l) => count(JSON.stringify(l)))).toEqual([0, 1, 1, 1, 2, 2, 2, 3]);
  });

  it("is unmoved by a line that is not JSON, or not an event", () => {
    const count = turnCounter();
    expect(count("npm warn Unknown env config")).toBe(0);
    expect(count('{"type":"assistant","message":{"content":[{"type":"tex')).toBe(0);
    expect(count("")).toBe(0);
  });

  /**
   * The stop, the way the wall limit stops one: an outcome the conductor
   * appends, not a silent truncation. `RunFailed` is what `runOnce` writes from
   * this, so a bound that produced no failure would be `#84` again.
   */
  it("stops a run that reaches the declared turns, and says which bound it was", async () => {
    const binary = await fakeStream(
      [
        { type: "system", subtype: "init" },
        assistant("msg_1", { type: "text", text: "one" }),
        assistant("msg_2", { type: "text", text: "two" }),
        assistant("msg_3", { type: "text", text: "three" }),
        assistant("msg_4", { type: "text", text: "four" }),
      ],
      0,
      // Still running when the bound is reached, so what ends this run is the
      // limit and not the process finishing.
      "sleep 30",
    );
    const outcome = await createClaudeCodeRuntime({ binary }).run(
      request({ limits: { turns: 3, wallMs: 20_000 } }),
    );

    expect(outcome.failure?.kind).toBe("out-of-turns");
    // Distinguishable from a wall timeout and from a clean finish, which is
    // half the ticket: "it ran out of turns" and "it ran out of time" are
    // different findings about a ticket.
    expect(outcome.failure?.kind).not.toBe("timeout");
    // On the bound rather than past it. `#84`'s 172-against-150 is the number
    // this assertion exists to make impossible.
    expect(outcome.turns).toBe(3);
    expect(outcome.failure?.detail).toContain("3 turns");
    expect(outcome.failure?.detail).toContain("allows 3");
    expect(outcome.exitCode).toBeNull();
  });

  /**
   * The false positive that would cost more than the bug.
   *
   * Two events, one `message.id`, one turn — a limit of two must not fire. If
   * it does, every run in the system is killed on its first tool call.
   */
  it("does not stop a run whose events outnumber its turns", async () => {
    const binary = await fakeStream(
      [
        assistant("msg_1", { type: "text", text: "thinking about it" }),
        assistant("msg_1", { type: "tool_use", id: "toolu_1", name: "Read", input: {} }),
      ],
      0,
      "sleep 30",
    );
    const outcome = await createClaudeCodeRuntime({ binary }).run(
      request({ limits: { turns: 2, wallMs: 500 } }),
    );

    // The wall, therefore — the run was never over its turn budget.
    expect(outcome.failure?.kind).toBe("timeout");
  });
});

describe("sessionIdFor", () => {
  /**
   * design.md assumed the session id would be learned from `SessionStart` and
   * stored. `claude --session-id` takes one, so it is derived instead — there is
   * nothing to store and nothing to lose.
   */
  it("is stable for a run id and different between runs", () => {
    expect(sessionIdFor("run-a")).toBe(sessionIdFor("run-a"));
    expect(sessionIdFor("run-a")).not.toBe(sessionIdFor("run-b"));
  });

  it("is a valid UUID, because --session-id requires one", () => {
    expect(sessionIdFor("run-a")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("run", () => {
  /**
   * A lone object, which is what `--output-format json` printed before `#109`
   * and what a stand-in still prints. It has no `type`, and is a receipt on
   * that account — nothing in a stream is typeless, so accepting one cannot be
   * what misreads a stream.
   */
  it("reads the receipt out of a lone object", async () => {
    const binary = await fakeClaude(
      `echo '{"is_error":false,"num_turns":63,"duration_ms":4210000,"total_cost_usd":5.42}'`,
    );
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());

    expect(outcome.failure).toBeNull();
    expect(outcome.turns).toBe(63);
    expect(outcome.costUsd).toBe(5.42);
    expect(outcome.durationMs).toBe(4_210_000);
    expect(outcome.sessionId).toBe(sessionIdFor("run-01JX"));
  });

  it("passes the flags that make the run attributable and governed", async () => {
    // The arguments are what wire the hook, the session and the model. A test
    // that only checks the exit code would not notice one going missing.
    const binary = await fakeClaude(`printf '%s\\n' "$@" > "${join(root, "args.txt")}"; echo '{}'`);
    await createClaudeCodeRuntime({ binary }).run(request({ model: "claude-opus-5" }));

    const args = (await import("node:fs/promises")).readFile;
    const written = await args(join(root, "args.txt"), "utf8");
    expect(written).toContain("-p");
    expect(written).toContain("--output-format");
    expect(written).toContain("--settings");
    expect(written).toContain(sessionIdFor("run-01JX"));
    expect(written).toContain("claude-opus-5");

    // The pair, together or not at all: 2.1.263 refuses `--print` with
    // `--output-format=stream-json` and no `--verbose`, so a run that lost the
    // second flag would not be a quieter stream, it would not start.
    expect(written).toContain("stream-json");
    expect(written).toContain("--verbose");
    // Considered and declined: it says every sentence twice, once in deltas
    // and once whole, and the run log is what pays for it.
    expect(written).not.toContain("--include-partial-messages");
  });

  /**
   * What the log records about the invocation is what was invoked.
   *
   * `RunStarted` carries the argv now (#88), asked of the adapter before the
   * spawn. The failure that would make that worthless is the two drifting — a
   * flag added to `run` and not to the recorded list — so this asserts them
   * against each other rather than against a copy of the flags.
   */
  it("describes the invocation as the same list it spawns, minus the prompt", async () => {
    const dump = join(root, "invocation-args.txt");
    const binary = await fakeClaude(`printf '%s\n' "$@" > "${dump}"; echo '{}'`);
    const runtime = createClaudeCodeRuntime({ binary });
    const req = request({ model: "claude-opus-5" });

    await runtime.run(req);
    const spawned = (await readFile(dump, "utf8")).split("\n").slice(0, -1);
    const described = runtime.invocation!(req);

    expect(described.command).toBe(binary);
    // The one difference, and the only one: the document itself is on the run's
    // stream as `RunPrompted` rather than repeated here.
    expect(spawned[1]).toBe("fix the thing");
    expect(described.args[1]).toBe(PROMPT_ELIDED);
    expect([...described.args].toSpliced(1, 1)).toEqual(spawned.toSpliced(1, 1));
  });

  /** The old loop's failures produced no event at all. Every ending has a kind. */
  it("turns a non-zero exit into a crash, with the detail", async () => {
    const binary = await fakeClaude(`echo "context window exceeded" >&2; exit 1`);
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());

    expect(outcome.failure?.kind).toBe("crash");
    expect(outcome.failure?.detail).toContain("context window exceeded");
    expect(outcome.exitCode).toBe(1);
  });

  it("turns is_error into a crash even when the exit code is zero", async () => {
    const binary = await fakeClaude(
      `echo '{"is_error":true,"result":"the model refused","num_turns":2}'; exit 0`,
    );
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());

    // A clean exit code with an error result is still a failure, and saying so
    // is the difference between a receipt and a rumour.
    expect(outcome.failure?.kind).toBe("crash");
    expect(outcome.failure?.detail).toContain("the model refused");
    expect(outcome.turns).toBe(2);
  });

  it("turns a run that never ends into a timeout, not a hang", async () => {
    const binary = await fakeClaude("sleep 30");
    const outcome = await createClaudeCodeRuntime({ binary }).run(
      request({ limits: { turns: 300, wallMs: 400 } }),
    );

    expect(outcome.failure?.kind).toBe("timeout");
    expect(outcome.failure?.detail).toContain("400ms");
  });

  it("turns an abort into aborted", async () => {
    const binary = await fakeClaude("sleep 30");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const outcome = await createClaudeCodeRuntime({ binary }).run(
      request({ signal: controller.signal }),
    );
    expect(outcome.failure?.kind).toBe("aborted");
  });

  it("turns a missing binary into a crash rather than a stack trace", async () => {
    const outcome = await createClaudeCodeRuntime({ binary: join(root, "not-here") }).run(request());
    expect(outcome.failure?.kind).toBe("crash");
    expect(outcome.failure?.detail.length).toBeGreaterThan(0);
  });

  /**
   * The six runs of
   * [0031](../../../doc/decisions/0031-a-run-that-never-started.md), as one.
   *
   * Every field the adapter is given here is the shape a quota actually
   * produced: an error, no turns, no cost, and a sentence assembled from a
   * table of prefixes that no schema describes. The classification reads the
   * first three and not the fourth — which is why the assertion below is that
   * the sentence survives *whole* rather than that it was recognised.
   */
  it("turns an error that took no turns and spent nothing into never-started", async () => {
    const said = "You've hit your session limit \u00b7 resets 11pm (America/Chicago)";
    // A heredoc rather than `echo '…'`: the sentence has an apostrophe in it,
    // which is the sort of thing that makes a fixture quietly stop being the
    // string it is standing in for.
    const binary = await fakeClaude(
      [
        "cat <<'JSON'",
        JSON.stringify({ is_error: true, num_turns: 0, total_cost_usd: 0, result: said }),
        "JSON",
        "exit 1",
      ].join("\n"),
    );
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());

    expect(outcome.failure?.kind).toBe("never-started");
    // Evidence, not a verdict: the prose is kept, and nothing was decided by it.
    expect(outcome.failure?.detail).toBe(said);
    expect(outcome.turns).toBe(0);
    expect(outcome.costUsd).toBe(0);
  });

  /**
   * The false positive that would matter: output nobody can parse leaves turns
   * at zero and cost at null out of *ignorance*, and reading that as "never
   * started" would stop the whole conductor over one broken run.
   */
  it("leaves an unparseable ending a crash, however little it appears to have spent", async () => {
    const binary = await fakeClaude(`echo "Segmentation fault" >&2; exit 139`);
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());

    expect(outcome.turns).toBe(0);
    expect(outcome.costUsd).toBeNull();
    expect(outcome.failure?.kind).toBe("crash");
  });
});

/**
 * `#109`'s one risk, asserted rather than argued.
 *
 * The parse path this changed is the accounting: the close handler is what
 * produces `RunFinished`'s turns, cost, duration and exit code, and the branch
 * before `#89` spent $13.04 getting this region wrong. So the test is not that
 * a stream parses — it is that a stream and the lone object the old format
 * printed produce **the same outcome, field for field**.
 */
describe("the stream, and the accounting that must not move", () => {
  const accounting = (o: Awaited<ReturnType<ReturnType<typeof createClaudeCodeRuntime>["run"]>>) => ({
    exitCode: o.exitCode,
    turns: o.turns,
    durationMs: o.durationMs,
    costUsd: o.costUsd,
    text: o.text,
    failure: o.failure,
    sessionId: o.sessionId,
  });

  it("reads a real stream to the same fields the lone object produced", async () => {
    const runtime = createClaudeCodeRuntime;
    const streamed = await runtime({ binary: await fakeStream(stream()) }).run(request());
    // The same receipt, alone, which is exactly what `--output-format json`
    // printed and what the parser was written against.
    const lone = await runtime({ binary: await fakeStream([RECEIPT]) }).run(request());

    expect(accounting(streamed)).toEqual(accounting(lone));
    // Named as well as compared, so a change to both at once is still caught.
    expect(accounting(streamed)).toEqual({
      exitCode: 0,
      turns: 63,
      durationMs: 4_210_000,
      costUsd: 5.42,
      text: "the point runs on every outcome, not just an inline merge",
      failure: null,
      sessionId: sessionIdFor("run-01JX"),
    });
  });

  /**
   * The five `subtype`s of the shipped bundle, 2026-09-08 (0031 §2).
   *
   * The classification is `neverStarted`'s three checkable facts, and — since
   * `#89` — one closed-enum `subtype`, so what survives here is that each one
   * still lands where it did, with its turns and its cost intact.
   * `error_max_turns` is the one that moved: it was a `crash`, which put a run
   * that spent its whole declared budget beside a segfault, and it is now
   * `out-of-turns`. It is still emphatically not a run that never started.
   */
  const subtypes: readonly [
    string,
    { is_error: boolean; num_turns: number; total_cost_usd: number },
    number,
    string | null,
  ][] = [
    ["success", { is_error: false, num_turns: 63, total_cost_usd: 5.42 }, 0, null],
    ["error_during_execution", { is_error: true, num_turns: 12, total_cost_usd: 0.41 }, 1, "crash"],
    ["error_max_turns", { is_error: true, num_turns: 300, total_cost_usd: 12.9 }, 1, "out-of-turns"],
    ["error_max_budget_usd", { is_error: true, num_turns: 40, total_cost_usd: 20 }, 1, "crash"],
    ["error_max_structured_output_retries", { is_error: true, num_turns: 3, total_cost_usd: 0.08 }, 1, "crash"],
    // Not a subtype: the shape 0031 measured, which carries no word of its own.
    ["error_during_execution", { is_error: true, num_turns: 0, total_cost_usd: 0 }, 1, "never-started"],
  ];

  it.each(subtypes)("carries %s through the stream unchanged", async (subtype, receipt, exit, kind) => {
    const binary = await fakeStream(stream({ ...RECEIPT, subtype, ...receipt }), exit);
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());

    expect(outcome.failure?.kind ?? null).toBe(kind);
    expect(outcome.turns).toBe(receipt.num_turns);
    expect(outcome.costUsd).toBe(receipt.total_cost_usd);
    expect(outcome.exitCode).toBe(exit);
  });

  /**
   * The daemon killed mid-run, which is what `reconcile` does to an agent left
   * behind (0030 §5) and what a second Ctrl+C does.
   *
   * Under a stream every line is an object, so "the last object in the output"
   * would find an assistant message here — one with no `num_turns` and no
   * `is_error`, which the close handler would have read as a **clean run of
   * zero turns**. That is the false success `#109` had to not introduce.
   */
  it.each([
    [137, "killed"],
    // The dangerous one. A non-zero exit is a failure whatever the parser
    // says; a *clean* exit with no receipt is the case where reading the last
    // object would report a successful run of zero turns and nothing spent.
    [0, "exited cleanly with nothing to show for it"],
  ])("makes a stream cut off before its receipt a crash (%i, %s)", async (exit) => {
    const binary = await fakeStream(
      stream(null),
      exit,
      // Half a line, with no newline after it: a pipe closed mid-object.
      `printf '%s' '{"type":"assistant","message":{"content":[{"type":"tex'`,
    );
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());

    expect(outcome.failure?.kind).toBe("crash");
    expect(outcome.turns).toBe(0);
    expect(outcome.costUsd).toBeNull();
    expect(outcome.text).toBeNull();
    // Something says so, always. Here it is the end of what was printed.
    expect(outcome.failure?.detail.length).toBeGreaterThan(0);
  });

  it("still finds the receipt behind a wrapper's warning", async () => {
    const binary = await fakeClaude(
      ["echo 'npm warn Unknown env config'", "cat <<'JSON'", JSON.stringify(RECEIPT), "JSON"].join("\n"),
    );
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());
    expect(outcome.turns).toBe(63);
    expect(outcome.failure).toBeNull();
  });
});

/**
 * What the ticket was filed for: the agent's own output reaching somebody.
 *
 * Before this it went into a string, was read for `result`, and was dropped —
 * so a run that took four minutes could be observed only with `ps`.
 */
describe("the agent's output in the run log", () => {
  it("writes what the agent said and thought, and not what the hook already writes", async () => {
    const trace = recordingTrace();
    const binary = await fakeStream(stream());
    await createClaudeCodeRuntime({ binary }).run(request({ log: trace }));

    expect(trace.lines).toContain("agent\tReading the adapter first.");
    expect(trace.lines).toContain("think\tthe close handler is what produces the accounting");
    // The tool call is the hook socket's line, written with the verdict it got
    // — which is more than the stream knows. Twice would say it happened twice.
    expect(trace.lines.join("\n")).not.toContain("claude-code.ts");
    // And a tool *result* is a file that is still on disk. It is the volume in
    // a stream and the least the agent's own.
    expect(trace.lines.join("\n")).not.toContain("four hundred lines");
    // How it ended, in the runtime's own word for it, `subtype` included.
    expect(trace.lines.at(-1)).toBe("receipt\tsuccess · 63 turns · $5.42 · exit 0");
  });

  /**
   * One file, one writer, one order.
   *
   * The conductor's hook trace and the agent's prose are the two halves of
   * 0034 §3, and they are handed the same `RunTrace` rather than the same path
   * — so this is the file that comes out, read back as a person would.
   */
  it("interleaves with the hook trace in one readable file", async () => {
    const path = join(root, "interleaved.log");
    const log = await openRunLog({ path });
    log.note("run", "run-01JX · wi-lingtai-109 · agent/109 → main");

    const binary = await fakeStream(stream());
    await createClaudeCodeRuntime({ binary }).run(request({ log }));

    log.note("run", "did not land — this file is kept, and is the only account of why");
    await log.close("keep");

    const written = (await readFile(path, "utf8")).split("\n");
    expect(written[0]).toContain("lingtai run log · started");
    const labels = written
      .filter((l) => /^\d\d:\d\d:\d\d {2}/.test(l))
      .map((l) => l.slice(10).trimEnd().split(/\s+/)[0]);
    expect(labels).toEqual(["run", "think", "agent", "receipt", "run"]);
    // Timestamped, one line each, and readable while it is being written.
    expect(written[3]).toMatch(/^\d\d:\d\d:\d\d {2}agent {3}Reading the adapter first\.$/);
  });

  /**
   * A run with no log — a gate agent, or `discuss` — writes to the one that is
   * not there. The run is worse observed and is not worse off.
   */
  it("runs without a log at all", async () => {
    const binary = await fakeStream(stream());
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());
    expect(outcome.turns).toBe(63);
  });

  /**
   * 0034 §7's cap is about the file; this one is about the line. A single
   * runaway message must not be able to spend the whole file in one go, and a
   * line nobody can read is not what the file is for — the transcript keeps
   * all of it, at a session id computable from the run id forever.
   */
  it("clips one enormous line, and says it clipped it", () => {
    const [[label, detail]] = traceOf(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(9_000) }] } }),
    ) as [[string, string]];

    expect(label).toBe("agent");
    expect(detail).toContain(`(${9_000 - TRACE_LINE_CHARS} more characters`);
    expect(detail.length).toBeLessThan(TRACE_LINE_CHARS + 200);
  });

  /**
   * A line that is not a stream event at all — a wrapper's warning, or the
   * truncated object at the end of a killed run. This file is the only place
   * it would have survived.
   */
  it("keeps a line that is not a stream event, rather than dropping it", () => {
    expect(traceOf("npm warn Unknown env config")).toEqual([["stdout", "npm warn Unknown env config"]]);
    expect(traceOf('{"type":"assistant","message":{"conte')).toEqual([
      ["stdout", '{"type":"assistant","message":{"conte'],
    ]);
    // And the ones with nothing to say say nothing.
    expect(traceOf(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([]);
    expect(traceOf("")).toEqual([]);
  });
});

describe("neverStarted", () => {
  /** Zero turns, zero cost, an error. Three facts, and no words. */
  it("is the three facts and nothing else", () => {
    expect(neverStarted({ turns: 0, costUsd: 0, isError: true })).toBe(true);
    // A receipt that recorded no cost recorded no spend.
    expect(neverStarted({ turns: 0, costUsd: null, isError: true })).toBe(true);

    // A run that took a turn failed at its task, not at beginning.
    expect(neverStarted({ turns: 1, costUsd: 0, isError: true })).toBe(false);
    // A run that spent money started.
    expect(neverStarted({ turns: 0, costUsd: 0.02, isError: true })).toBe(false);
    // And a clean ending is not a failure at all.
    expect(neverStarted({ turns: 0, costUsd: 0, isError: false })).toBe(false);
  });
});

describe("parseResult", () => {
  it("reads clean JSON", () => {
    expect(parseResult('{"num_turns":3}')).toEqual({ num_turns: 3 });
  });

  /**
   * The old loop's cost record was a `.jsonl` that also contained raw `pnpm
   * build` output — 9,555 of 42,147 lines were not JSON and the file would not
   * parse. Assuming clean output is how a receipt gets lost.
   */
  it("finds the result even behind a line of noise", () => {
    expect(parseResult('npm warn something\n{"num_turns":3}')).toEqual({ num_turns: 3 });
  });

  it("returns null rather than guessing", () => {
    expect(parseResult("")).toBeNull();
    expect(parseResult("not json at all")).toBeNull();
  });

  /**
   * The line that says it is the receipt, and no other. Every line of a stream
   * is an object, so "the last one" is a different function on a stream than it
   * was on a lone object — and on a truncated stream it is the wrong one.
   */
  it("takes the result line out of a stream and passes over the rest", () => {
    expect(parseResult(stream().map((l) => JSON.stringify(l)).join("\n"))?.num_turns).toBe(63);
  });

  it("finds no receipt in a stream that has not reached one", () => {
    expect(parseResult(stream(null).map((l) => JSON.stringify(l)).join("\n"))).toBeNull();
  });
});

describe("the Codex stub", () => {
  it("declares capabilities but refuses to run, naming the issue", async () => {
    const codex = createCodexRuntime();
    expect(codex.capabilities.providesTier).toBe("sandboxed");
    await expect(codex.run({} as never)).rejects.toBeInstanceOf(CodexNotImplementedError);
    await expect(codex.run({} as never)).rejects.toThrow(/#34/);
  });
});
