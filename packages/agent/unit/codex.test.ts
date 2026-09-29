/**
 * The Codex adapter, everywhere it is not a process.
 *
 * In `unit/` rather than beside `integration/claude-code.test.ts` because
 * `pnpm test` is the `build` gate and runs the unit project only: a claim about
 * this diff has to be reachable inside a pass, and the integration half takes 803
 * seconds. So everything except `spawn` lives in an exported pure function and is
 * asserted here — the receipt fold against fixture JSONL, the argv through
 * `invocation()`, and the hook translation against the file `renderSettings`
 * actually writes.
 *
 * **Every fixture line below was copied off a real `codex exec --json` stream**
 * from `codex-cli 0.155.1` on 2026-09-29, not invented. The one that matters is
 * `blocked`: a hook refusing the prompt, which is the shape `canFailClosed`
 * promises and which exits **0**.
 */
import { describe, expect, it } from "vitest";
import { CODEX_CAPABILITIES, codexArgv, codexHookArgs, codexOutcome, codexTrace } from "../src/codex.ts";
import { renderSettings } from "../src/hook-config.ts";
import { meetsTier, missingForTier, RUN_LIMITS } from "../src/runtime.ts";
import { PROMPT_ELIDED } from "../src/claude-code.ts";

const jsonl = (...events: readonly unknown[]): string[] => events.map((e) => JSON.stringify(e));

/** A run that answered. `usage` carries tokens and no dollars, which is the point. */
const clean = () =>
  jsonl(
    { type: "thread.started", thread_id: "01a0ee8f-64cc-7532-abcd-096ecaa6d997" },
    {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "error",
        message: "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.",
      },
    },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } },
    {
      type: "turn.completed",
      usage: { input_tokens: 17018, cached_input_tokens: 7680, output_tokens: 5 },
    },
  );

/**
 * The measured hook refusal: `UserPromptSubmit` exited 2, so nothing reached a
 * model. **`turn.completed` still arrives and the process still exits 0.**
 */
const blocked = () =>
  jsonl(
    { type: "thread.started", thread_id: "01a0ee90-02cd-70c1-a793-b4d970d03ad2" },
    { type: "turn.started" },
    { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
  );

describe("the receipt, as a fold over the stream", () => {
  it("reads the session id off thread.started, because nothing supplies one", () => {
    // `sessionIdFor`'s derive-from-the-run-id trick is deliberately not reused:
    // `codex exec` takes no `--session-id`, and a computable UUID naming no
    // transcript is a worse answer than the empty string.
    expect(codexOutcome(clean()).sessionId).toBe("01a0ee8f-64cc-7532-abcd-096ecaa6d997");
    expect(codexOutcome([]).sessionId).toBe("");
  });

  it("counts turns as agent messages and keeps the last one as the text", () => {
    const two = [
      ...clean().slice(0, -1),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "and this" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
    ];
    const receipt = codexOutcome(two);
    expect(receipt.turns).toBe(2);
    expect(receipt.text).toBe("and this");
  });

  /** An `error` item is not a failure: the bypass notice is one on every hooked run. */
  it("collects error items as detail without making the run a failed one", () => {
    const receipt = codexOutcome(clean());
    expect(receipt.errors).toHaveLength(1);
    expect(receipt.errors[0]).toMatch(/bypass-hook-trust/);
    expect(receipt.completed).toBe(true);
    expect(receipt.turns).toBe(1);
  });

  it("has no receipt at all where the stream never reached turn.completed", () => {
    expect(codexOutcome(clean().slice(0, -1)).completed).toBe(false);
    // A line cut mid-object is a fragment and not a fact.
    expect(codexOutcome(['{"type":"turn.compl']).completed).toBe(false);
    expect(codexOutcome(["not json at all", ""]).completed).toBe(false);
  });

  /**
   * The measurement `canFailClosed` rests on, read as a receipt: zero billed
   * tokens and no message, beside a `turn.completed` that did arrive.
   */
  it("says a hook-blocked run reached no model, though it completed and exited 0", () => {
    const receipt = codexOutcome(blocked());
    expect(receipt.completed).toBe(true);
    expect(receipt.billedTokens).toBe(0);
    expect(receipt.turns).toBe(0);
  });

  it("counts input and output tokens as the evidence of spend", () => {
    // Not `cached_input_tokens`, which is a discount on the input and not a
    // second charge; what is being asked is only *whether* a model was reached.
    expect(codexOutcome(clean()).billedTokens).toBe(17018 + 5);
  });
});

describe("what one line is worth saying in the log", () => {
  it("keeps the agent's prose and its reasoning", () => {
    expect(codexTrace(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }))).toEqual([
      ["agent", "hi"],
    ]);
    expect(codexTrace(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "why" } }))).toEqual([
      ["think", "why"],
    ]);
  });

  /**
   * A tool *call*, from `item.started` — never the completed item, which carries
   * `aggregated_output`. That is the tool result, and tool results are the volume
   * in a stream and the least the agent's own (`traceOf`'s rule).
   */
  it("traces a command from item.started and never its output from item.completed", () => {
    const start = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "/bin/zsh -lc 'cat a.txt'" },
    });
    const done = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "/bin/zsh -lc 'cat a.txt'", aggregated_output: "hello" },
    });
    expect(codexTrace(start, { tools: true })).toEqual([["Bash", "/bin/zsh -lc 'cat a.txt'"]]);
    // Off by default: for an implementer the hook socket already wrote the call.
    expect(codexTrace(start)).toEqual([]);
    expect(codexTrace(done, { tools: true })).toEqual([]);
  });

  it("keeps a line that is not a stream event at all, because nothing else would", () => {
    expect(codexTrace("Reading additional input from stdin...")).toEqual([
      ["stdout", "Reading additional input from stdin..."],
    ]);
  });
});

describe("the hook wiring, translated", () => {
  const settings = (includeClaudeOnly: boolean) =>
    renderSettings({
      runId: "run-1",
      hookBinary: "/opt/lingtai/lingtai-hook",
      includeClaudeOnly,
    });

  /**
   * `codex exec` takes no `--settings`, and `-c hooks=<path>` is refused —
   * *"invalid type: string …, expected struct HooksToml"*, measured. So the file
   * is re-emitted as TOML overrides, and this asserts against the real
   * `renderSettings` output rather than a hand-written object.
   */
  it("re-emits Claude Code's settings.json as -c overrides Codex parses", () => {
    const args = codexHookArgs(settings(false));
    expect(args).toContain("--dangerously-bypass-hook-trust");
    expect(args).toContain(
      'hooks.UserPromptSubmit=[{matcher="*",hooks=[{type="command",command="/opt/lingtai/lingtai-hook"}]}]',
    );
    // Every override is a value `-c` immediately precedes — `-c` takes one
    // `key=value`, so a list that drifted out of pairs would hand Codex a flag
    // where it wanted a value.
    for (const [i, arg] of args.entries()) {
      if (arg.startsWith("hooks.")) expect(args[i - 1]).toBe("-c");
    }
  });

  /**
   * **Filtering is required, not tidiness.** An event name Codex has no
   * dispatcher for makes `config.toml` fail to load, which kills the run at
   * spawn — and `renderSettings` writes `Notification`, which Codex does not
   * have.
   */
  it("passes over a hook Codex does not serve, rather than failing the run at spawn", () => {
    const args = codexHookArgs(settings(true));
    expect(args.join(" ")).not.toContain("Notification");
    expect(args.join(" ")).toContain("hooks.SessionStart=");
    for (const arg of args.filter((a) => a.startsWith("hooks."))) {
      const event = arg.slice("hooks.".length, arg.indexOf("="));
      expect(CODEX_CAPABILITIES.hooks).toContain(event);
    }
  });

  /**
   * `writeUnhookedSettings` writes `{}` for a reviewer or a fixer, which is not a
   * run and has no socket. No overrides, and **no dangerous-sounding flag that
   * buys nothing** — one of those is how a flag stops being read.
   */
  it("wires nothing for the unhooked reviewer's empty settings", () => {
    expect(codexHookArgs({})).toEqual([]);
    expect(codexHookArgs(null)).toEqual([]);
    expect(codexHookArgs({ hooks: {} })).toEqual([]);
  });

  it("quotes a path as TOML rather than interpolating it", () => {
    const odd = codexHookArgs({
      hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: '/a "b"/hook' }] }] },
    });
    expect(odd.join(" ")).toContain('command="/a \\"b\\"/hook"');
  });
});

describe("the invocation", () => {
  /**
   * The parsed wiring, not a path: `codexArgv` is pure, so the whole command line
   * is a claim `pnpm test` can settle. The `readFileSync` behind it is the
   * adapter's own and belongs to the integration half (0060 §1).
   */
  const wiring = () => renderSettings({ runId: "run-1", hookBinary: "/opt/lingtai/lingtai-hook" });

  const invocable = {
    runId: "run-1",
    cwd: "/tmp/tree",
    settingsPath: "/state/runs/run-1/settings.json",
    env: {},
    limits: { turns: 150, wallMs: 3_600_000 },
  };

  const argv = (over: { sandbox?: "workspace-write" | "read-only"; settings?: unknown } = {}) =>
    codexArgv(invocable, PROMPT_ELIDED, {
      // `"settings" in over` rather than `??`: `null` is the case being tested.
      settings: "settings" in over ? over.settings : wiring(),
      sandbox: over.sandbox ?? "workspace-write",
    });

  it("spawns `codex exec` in the worktree, sandboxed, with the prompt behind --", () => {
    const args = argv();
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args[args.indexOf("--cd") + 1]).toBe("/tmp/tree");
    // Nothing is watching to approve anything; a run that waits for an approval
    // burns the wall clock.
    expect(args).toContain("approval_policy=never");

    /**
     * **`--` is load-bearing.** Measured at 0.155.1: `codex exec review` runs the
     * `review` subcommand, `codex exec -- review` sends it as the prompt. A
     * prompt is a document somebody wrote, so the day one begins with a bare
     * subcommand name is the day a run silently does something else.
     */
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe(PROMPT_ELIDED);
  });

  /** The flag that would make `providesTier: "sandboxed"` a lie. */
  it("never passes the flag that turns the sandbox off", () => {
    expect(argv()).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv().join(" ")).not.toContain("danger-full-access");
  });

  it("reads the worktree only, for an agent that may answer and not act", () => {
    expect(argv({ sandbox: "read-only" })[argv({ sandbox: "read-only" }).indexOf("--sandbox") + 1]).toBe(
      "read-only",
    );
  });

  it("names a model only where the recipe named one", () => {
    expect(argv()).not.toContain("--model");
    expect(codexArgv({ ...invocable, model: "gpt-5.6-sol" }, "p", {
      settings: wiring(),
      sandbox: "workspace-write",
    })[
      codexArgv({ ...invocable, model: "gpt-5.6-sol" }, "p", {
        settings: wiring(),
        sandbox: "workspace-write",
      }).indexOf("--model") + 1
    ]).toBe("gpt-5.6-sol");
  });

  /**
   * An argv with no hook flags in it is what would actually have been spawned, so
   * it is not a lie — and `conduct.ts` calls `runtime.invocation?.(…)` bare,
   * before `RunStarted` is appended, so a throw there would take out the run
   * rather than record it. `run()` is the one that refuses.
   */
  it("carries no hook flags where there was no wiring to read", () => {
    const args = argv({ settings: null });
    expect(args.join(" ")).not.toContain("hooks.");
    expect(args).not.toContain("--dangerously-bypass-hook-trust");
    // Still a runnable command line, and still sandboxed.
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });
});

describe("Codex's capabilities, each measured against the binary", () => {
  /**
   * **`wall` only.** `codex exec --help` at 0.155.1 offers no `--max-turns` and
   * no flag of any name bounds turns, so a recipe's `turns` is a bound nothing
   * applies — and `limitsRow` turns `fail` for every Codex project with its own
   * sentence. That is `#89` working, not a regression.
   */
  it("applies the wall and says so, and claims nothing about turns", () => {
    expect(CODEX_CAPABILITIES.enforces).toEqual(["wall"]);
    expect(CODEX_CAPABILITIES.enforces).not.toContain("turns");
    // Every name in `enforces` is one `RUN_LIMITS` knows, or doctor cannot walk it.
    for (const limit of CODEX_CAPABILITIES.enforces) expect(RUN_LIMITS).toContain(limit);
  });

  /**
   * Proved, not read off documentation: a `UserPromptSubmit` hook exiting 2
   * stopped the run before the model — `input_tokens: 0`, no `agent_message`.
   */
  it("fails closed at the hook Lingtai installs", () => {
    expect(CODEX_CAPABILITIES.canFailClosed).toBe(true);
    expect(CODEX_CAPABILITIES.hooks).toContain("UserPromptSubmit");
  });

  /**
   * Proved with `codex sandbox`: `read-only` refused a write inside the working
   * root, and `workspace-write` refused `$HOME` and `~/.lingtai` — Lingtai's own
   * state directory, where the hook wiring and the run logs live.
   */
  it("carries sandboxed, and carries guarded because it also fails closed", () => {
    expect(CODEX_CAPABILITIES.providesTier).toBe("sandboxed");
    expect(meetsTier(CODEX_CAPABILITIES, "sandboxed")).toBe(true);
    expect(meetsTier(CODEX_CAPABILITIES, "guarded")).toBe(true);
    expect(missingForTier(CODEX_CAPABILITIES, "sandboxed")).toEqual([]);
  });
});

/**
 * The correction the ticket's *Watch out* named: `meetsTier` returned on rank
 * alone, so `sandboxed` satisfied `guarded` **without `canFailClosed` ever being
 * read**. A rank that grants `guarded` to a runtime that cannot fail closed is
 * the silent downgrade 0007 forbids by name.
 */
describe("guarded is an axis, not a rung", () => {
  const sandboxedButOpenLoop = { ...CODEX_CAPABILITIES, canFailClosed: false };

  it("refuses guarded to a sandboxed runtime that cannot fail closed", () => {
    expect(meetsTier(sandboxedButOpenLoop, "guarded")).toBe(false);
    expect(missingForTier(sandboxedButOpenLoop, "guarded")).toEqual(["pre-tool-use-interception"]);
  });

  it("names the promise that is missing, not the one that is kept", () => {
    // It has a filesystem sandbox; what it lacks is failing closed. A refusal
    // saying `filesystem-sandbox` would send an operator to fix the wrong thing.
    expect(missingForTier(sandboxedButOpenLoop, "sandboxed")).toEqual(["pre-tool-use-interception"]);
  });

  it("still lets `open` through, which asks for neither promise", () => {
    expect(meetsTier({ ...sandboxedButOpenLoop, providesTier: "open" }, "open")).toBe(true);
  });
});
