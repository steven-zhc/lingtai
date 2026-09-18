import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InvocationConfiguration } from "@lingtai/domain";
import { createClaudeCodeRuntime } from "../src/claude-code.ts";
import type { InvocationRequest } from "../src/invocation.ts";

let root: string;
let cwd: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lingtai-invocation-"));
  cwd = join(root, "cwd");
  await mkdir(cwd);
});
afterEach(async () => { await rm(root, { force: true, recursive: true }); });
const source = { kind: "configured" as const, path: "runtime.agent" };
const configuration: InvocationConfiguration = {
  agent: "claude-code", model: null, modelSelection: "agent-default", requiredTier: "open",
  limits: { turns: 40, wall: "5m", wallMs: 300_000 }, configHash: "a".repeat(64),
  provenance: { agent: source, model: { kind: "agent-default", path: null }, tier: source,
    "limits.turns": source, "limits.wall": source },
};
function request(): InvocationRequest {
  return { role: "development", invocationId: crypto.randomUUID(), configuration,
    ownership: { project: "p", workItemId: "wi-p-200", runId: "run-p-200", chatId: null,
      role: "development", gatePoint: null, action: null, fixRound: null },
    cwd, settingsPath: join(root, "settings.json"), onSha: null,
    env: { USER: "operator", CAPTURE: join(root, "capture.json") }, materials: { prompt: "implement" } };
}
const receipt = { type: "result", is_error: false, num_turns: 2, total_cost_usd: 0.25,
  session_id: "observed-native-session", result: "done", duration_ms: 12,
  usage: { input_tokens: 30, output_tokens: 8, cache_read_input_tokens: 4 } };
async function binary(lines: readonly object[], extra = ""): Promise<string> {
  const path = join(root, "claude.mjs");
  await writeFile(path, `#!${process.execPath}\nimport { readFileSync, writeFileSync, statSync } from 'node:fs';
const args = process.argv.slice(2);
const settingsPath = args[args.indexOf('--settings') + 1];
writeFileSync(process.env.CAPTURE, JSON.stringify({ args, settings: JSON.parse(readFileSync(settingsPath, 'utf8')), mode: statSync(settingsPath).mode & 0o777, env: process.env }));
${lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("\n")}
${extra}\n`);
  await chmod(path, 0o755);
  return path;
}
const capture = async () => JSON.parse(await readFile(join(root, "capture.json"), "utf8"));

describe("Claude Code role contract", () => {
  it("generates native settings, preserves filtered auth environment and records only observed facts", async () => {
    const runtime = createClaudeCodeRuntime({ binary: await binary([
      { type: "system", subtype: "init", model: "claude-observed" }, receipt,
    ]) });
    const r = request();
    const prepared = await runtime.prepare(r);
    try {
      const outcome = await prepared.execute();
      expect(outcome).toMatchObject({ state: "succeeded", costUsd: 0.25, observedModel: "claude-observed",
        sessionId: "observed-native-session", threadId: null,
        usage: { turns: 2, turnUnit: "claude-agentic-turn", inputTokens: 30, outputTokens: 8, cachedInputTokens: 4 },
        execution: { processStarted: true, receiptReceived: true } });
      const native = await capture();
      expect(native.settings).toEqual({});
      expect(native.mode).toBe(0o600);
      expect(native.env.USER).toBe("operator");
      expect(native.env.LINGTAI_DATABASE_URL).toBeUndefined();
      expect(native.args).not.toContain("--model");
      expect(native.args).toContain("bypassPermissions");
      expect(native.args[native.args.indexOf("--max-turns") + 1]).toBe("40");
      expect(native.args[native.args.indexOf("--session-id") + 1]).not.toBe(outcome.sessionId);
      await expect(prepared.execute()).rejects.toThrow("executes once");
    } finally { await prepared.close(); }
    await expect(stat(r.settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps absent comparable counts, model, session and tokens unknown on an incomplete stream", async () => {
    const runtime = createClaudeCodeRuntime({ binary: await binary([{ type: "assistant", message: { content: [] } }]) });
    const prepared = await runtime.prepare(request());
    try {
      expect(await prepared.execute()).toMatchObject({ state: "failed", failure: { kind: "crash" },
        usage: null, costUsd: null, observedModel: null, sessionId: null,
        execution: { processStarted: true, receiptReceived: false } });
    } finally { await prepared.close(); }
  });

  it.each([
    { unrelated: "JSON without a terminal receipt" },
    { type: "result", is_error: false, num_turns: 2, total_cost_usd: "unreported" },
  ])("malformed native receipt fails with unknown usage/cost instead of throwing or succeeding", async (line) => {
    const runtime = createClaudeCodeRuntime({ binary: await binary([line]) });
    const prepared = await runtime.prepare(request());
    try {
      expect(await prepared.execute()).toMatchObject({ state: "failed", failure: { kind: "crash" }, usage: null, costUsd: null });
    } finally { await prepared.close(); }
  });

  it("preserves native turn-limit classification and complete failure detail", async () => {
    const detail = "quota evidence " + "x".repeat(2000);
    const runtime = createClaudeCodeRuntime({ binary: await binary([
      { ...receipt, subtype: "error_max_turns", is_error: true, result: detail },
    ], "process.exitCode = 1;") });
    const prepared = await runtime.prepare(request());
    try {
      expect(await prepared.execute()).toMatchObject({ state: "failed", costUsd: 0.25,
        failure: { kind: "out-of-turns", detail }, usage: { turns: 2, turnUnit: "claude-agentic-turn" } });
    } finally { await prepared.close(); }
  });

  it("keeps Claude's receipt-specific never-started rule without manufacturing missing usage", async () => {
    const runtime = createClaudeCodeRuntime({ binary: await binary([
      { type: "result", is_error: true, num_turns: 1, result: "not logged in" },
    ], "process.exitCode = 1;") });
    const prepared = await runtime.prepare(request());
    try {
      expect(await prepared.execute()).toMatchObject({ state: "failed", costUsd: null,
        failure: { kind: "never-started", detail: "not logged in" },
        usage: { turns: 1, inputTokens: null, outputTokens: null }, sessionId: null });
    } finally { await prepared.close(); }
  });

  it("discussion disables native tools, MCP and skills, overriding caller permission flags", async () => {
    const runtime = createClaudeCodeRuntime({ binary: await binary([receipt]),
      permissionMode: "bypassPermissions", extraArgs: ["--tools", "Bash"] });
    const base = request();
    const r: InvocationRequest = { ...base, role: "discussion",
      ownership: { ...base.ownership, role: "discussion", runId: null, chatId: "chat-p-200" },
      materials: { question: "run a command", context: "read-only evidence" } };
    const prepared = await runtime.prepare(r);
    try {
      expect(prepared.containment).toMatchObject({ commands: false, fileChanges: false, filesystemSandbox: false });
      await prepared.execute();
      const native = await capture();
      expect(native.args[native.args.indexOf("--tools") + 1]).toBe("");
      expect(native.args).toContain("--strict-mcp-config");
      expect(native.args).toContain("--safe-mode");
      expect(native.args).toContain("--disable-slash-commands");
      expect(native.args).not.toContain("bypassPermissions");
      expect(native.args).not.toContain("Bash");
      expect(native.settings.permissions.defaultMode).toBe("default");
    } finally { await prepared.close(); }
  });

  it("review starts a fresh native session, retaining the supplied fixed rubric and immutable diff", async () => {
    const runtime = createClaudeCodeRuntime({ binary: await binary([receipt]) });
    const base = request();
    const r: InvocationRequest = { ...base, role: "review", onSha: "b".repeat(40),
      configuration: { ...configuration, model: "requested-model", modelSelection: "requested" },
      ownership: { ...base.ownership, role: "review", gatePoint: "proposed", action: "cold-review" },
      materials: { prompt: "Severity rubric: blocker", diff: "diff --git" } };
    const prepared = await runtime.prepare(r);
    try {
      await prepared.execute();
      const native = await capture();
      expect(native.args[1]).toContain("Severity rubric: blocker");
      expect(native.args[1]).toContain(r.onSha);
      expect(native.args[1]).toContain("diff --git");
      expect(native.args).not.toContain("--resume");
      expect(native.args[native.args.indexOf("--model") + 1]).toBe("requested-model");
    } finally { await prepared.close(); }
  });

  it("rejects unsupported containment, missing turn bounds, host secrets and settings inside cwd before spawning", async () => {
    const runtime = createClaudeCodeRuntime();
    const base = request();
    for (const r of [
      { ...base, configuration: { ...configuration, requiredTier: "sandboxed" as const } },
      { ...base, configuration: { ...configuration, limits: { ...configuration.limits, turns: null } } },
      { ...base, env: { LINGTAI_DATABASE_URL: "host-secret" } },
      { ...base, settingsPath: join(cwd, "settings.json") },
      { ...base, configuration: { ...configuration, requiredTier: "guarded" as const } },
    ]) await expect(runtime.prepare(r)).rejects.toThrow();
    await expect(stat(base.settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes guarded hook settings and wiring together", async () => {
    const runtime = createClaudeCodeRuntime({ binary: await binary([receipt]) });
    const r = { ...request(), configuration: { ...configuration, requiredTier: "guarded" as const },
      hooks: { hookBinary: "/host/lingtai-hook", socketPath: "/host/conductor.sock" } };
    const prepared = await runtime.prepare(r);
    try {
      await prepared.execute();
      const native = await capture();
      expect(native.settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe("/host/lingtai-hook");
      expect(native.env.LINGTAI_HOOK_RUN_ID).toBe(r.invocationId);
      expect(native.env.LINGTAI_HOOK_SOCKET).toBe("/host/conductor.sock");
    } finally { await prepared.close(); }
  });

  it("a pre-aborted call never spawns and records explicit no-execution evidence", async () => {
    const runtime = createClaudeCodeRuntime({ binary: await binary([receipt]) });
    const prepared = await runtime.prepare({ ...request(), signal: AbortSignal.abort() });
    try {
      expect(await prepared.execute()).toMatchObject({ state: "interrupted", usage: null, costUsd: null,
        failure: { kind: "aborted" }, execution: { processStarted: false, receiptReceived: false } });
      await expect(capture()).rejects.toThrow();
    } finally { await prepared.close(); }
  });

  it("closing a running invocation cancels and waits before deleting native settings", async () => {
    const runtime = createClaudeCodeRuntime({ binary: await binary([], "setInterval(() => {}, 1000);") });
    const r = request();
    const prepared = await runtime.prepare(r);
    const pending = prepared.execute();
    try {
      let ready = false;
      const deadline = Date.now() + 3000;
      while (!ready && Date.now() < deadline) {
        try { await capture(); ready = true; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      expect(ready).toBe(true);
      await prepared.close();
      expect(await pending).toMatchObject({ state: "interrupted", failure: { kind: "aborted" },
        execution: { processStarted: true, receiptReceived: false } });
      await expect(stat(r.settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await prepared.close(); await pending; }
  });

  it("cancellation stops a verification child that ignores SIGTERM before releasing settings", async () => {
    const runtime = createClaudeCodeRuntime({ binary: await binary([], `
import { spawn } from 'node:child_process';
const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
worker.on('message', () => writeFileSync(process.env.CAPTURE, JSON.stringify({ childPid: worker.pid })));
setInterval(() => {}, 1000);
`) });
    const controller = new AbortController();
    const r = { ...request(), signal: controller.signal };
    const prepared = await runtime.prepare(r);
    const pending = prepared.execute();
    let childPid: number | undefined;
    const deadline = Date.now() + 3000;
    try {
      while (!childPid && Date.now() < deadline) {
        try { childPid = (await capture()).childPid; } catch { /* Native process is starting. */ }
        if (!childPid) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(childPid).toBeTypeOf("number");
      controller.abort();
      expect(await pending).toMatchObject({ state: "interrupted", failure: { kind: "aborted" },
        usage: null, costUsd: null, execution: { processStarted: true, receiptReceived: false } });
      let alive = true;
      for (let tries = 0; alive && tries < 100; tries++) {
        try { process.kill(childPid!, 0); } catch { alive = false; }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(alive).toBe(false);
    } finally {
      controller.abort();
      await pending;
      if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* Already stopped. */ } }
      await prepared.close();
    }
    await expect(stat(r.settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32").each([
    { exitCode: 0, stdio: "ignore" },
    { exitCode: 1, stdio: "ignore" },
    { exitCode: 0, stdio: "inherit" },
  ])(
    "native exit $exitCode stops background verification with $stdio stdio before returning its receipt", async ({ exitCode, stdio }) => {
      const nativeReceipt = { ...receipt, is_error: exitCode !== 0 };
      const runtime = createClaudeCodeRuntime({ binary: await binary([], `
import { spawn } from 'node:child_process';
const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', ${JSON.stringify(stdio)}, ${JSON.stringify(stdio)}, 'ipc'] });
worker.once('message', () => {
  writeFileSync(process.env.CAPTURE, JSON.stringify({ childPid: worker.pid }));
  worker.disconnect();
  worker.unref();
  console.log(${JSON.stringify(JSON.stringify(nativeReceipt))});
  process.exitCode = ${exitCode};
});
`) });
      const base = request();
      const r = { ...base, configuration: { ...base.configuration,
        limits: { ...base.configuration.limits, wall: "2s", wallMs: 2000 } } };
      const prepared = await runtime.prepare(r);
      let childPid: number | undefined;
      try {
        const outcome = await prepared.execute();
        childPid = (await capture()).childPid;
        if (exitCode === 0) expect(outcome.failure).toBeNull();
        expect(outcome).toMatchObject({ state: exitCode === 0 ? "succeeded" : "failed",
          exitCode, costUsd: 0.25, usage: { turns: 2 }, execution: { processStarted: true, receiptReceived: true } });
        expect(childPid).toBeTypeOf("number");
        expect(() => process.kill(childPid!, 0)).toThrow();
        // Settings remain protected until close, after the native group is gone.
        await expect(stat(r.settingsPath)).resolves.toBeDefined();
        await prepared.close();
        await expect(stat(r.settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (!childPid) { try { childPid = (await capture()).childPid; } catch { /* Spawn failed. */ } }
        if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* Already stopped. */ } }
        await prepared.close();
      }
    },
  );
});
