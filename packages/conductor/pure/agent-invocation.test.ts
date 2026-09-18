import type { InvocationRequest, InvocationRuntime, InvocationOutcome, PreparedInvocation } from "@lingtai/agent";
import {
  accountedAgentCalls, reduceAgentInvocation, invocationStream,
  type AgentRole, type InvocationConfiguration, type InvocationOwnership,
} from "@lingtai/domain";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import { Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { invokeAgent, interruptAgentInvocation } from "../src/agent-invocation.ts";
import { AgentRuntimes, RuntimeSelectionRefused, type RuntimeSelectorPort } from "../src/ports.ts";
import { liveRuntimeSelector } from "../src/live.ts";

const now = () => new Date("2026-09-18T12:00:00.000Z");
const source = { kind: "configured" as const, path: "runtime.agent" };
const configuration: InvocationConfiguration = {
  agent: "claude-code", model: null, modelSelection: "agent-default", requiredTier: "guarded",
  limits: { turns: 40, wall: "5m", wallMs: 300_000 }, configHash: "a".repeat(64),
  provenance: { agent: source, model: { kind: "agent-default", path: null }, tier: source,
    "limits.turns": source, "limits.wall": source },
};
function request(role: AgentRole, id = crypto.randomUUID()): InvocationRequest {
  const ownership: InvocationOwnership = { project: "p", workItemId: "wi-p-200", role,
    runId: role === "discussion" ? null : "run-p-200", chatId: role === "discussion" ? "chat-p-200" : null,
    gatePoint: role === "fix" || role === "review" ? "proposed" : null,
    action: role === "fix" || role === "review" ? "review" : null,
    fixRound: role === "fix" ? 1 : null };
  const base = { invocationId: id, ownership, configuration, cwd: "/host/worktree",
    settingsPath: `/host/settings/${id}.json`, onSha: role === "review" ? "b".repeat(40) : null, env: {} };
  switch (role) {
    case "development": return { ...base, role, materials: { prompt: "implement" } };
    case "fix": return { ...base, role, materials: { prompt: "repair", findings: [
      { file: "src/x.ts", line: 1, severity: "blocker", claim: "a race", failureScenario: "two writers overwrite one another" },
    ] } };
    case "review": return { ...base, role, materials: { prompt: "fixed rubric", diff: "diff" } };
    case "discussion": return { ...base, role, materials: { question: "why?", context: "evidence" } };
  }
}
const outcome: InvocationOutcome = {
  state: "succeeded", failure: null, text: "done", exitCode: 0, durationMs: 100, costUsd: null,
  observedModel: null, sessionId: null, threadId: null, usage: null,
  execution: { processStarted: true, receiptReceived: true },
};
function fakeSelector(options: { execute?: (r: InvocationRequest) => Promise<InvocationOutcome> } = {}) {
  const selected: InvocationRequest[] = [];
  const closed: string[] = [];
  const port: RuntimeSelectorPort = {
    select: (selection) => Effect.succeed({
      id: selection.configuration.agent, supports() {},
      async prepare(r) {
        selected.push(r);
        const prepared: PreparedInvocation = {
          containment: { tier: "guarded", mechanism: "fake containment", filesystemSandbox: false,
            commands: r.role !== "discussion", fileChanges: r.role !== "discussion" },
          execute: () => options.execute ? options.execute(r) : Promise.resolve(outcome),
          async close() { closed.push(r.invocationId); },
        };
        return prepared;
      },
    } satisfies InvocationRuntime),
  };
  return { selected, closed, port, layer: Layer.succeed(AgentRuntimes, port) };
}

describe("role-aware invocation lifecycle", () => {
  it("records four independent calls, selected only through the conductor port", async () => {
    const store = createMemoryEventStore();
    const fake = fakeSelector();
    const roles = ["development", "fix", "review", "discussion"] as const;
    const requests = roles.map((role) => request(role));
    requests[2] = { ...requests[2]!, configuration: { ...configuration, agent: "codex", limits: { ...configuration.limits, turns: null } } };
    const projected: string[] = [];
    for (const r of requests) await Effect.runPromise(invokeAgent({ store, request: r, now,
      appended: async (events) => { projected.push(events[0]!.type); } }).pipe(Effect.provide(fake.layer)));
    expect(fake.selected.map((r) => [r.role, r.configuration.agent])).toEqual([
      ["development", "claude-code"], ["fix", "claude-code"], ["review", "codex"], ["discussion", "claude-code"],
    ]);
    expect(new Set(fake.selected.map((r) => r.invocationId)).size).toBe(4);
    for (const r of requests) {
      const state = reduceAgentInvocation(await store.read(invocationStream(r.invocationId)));
      expect(state.started).toMatchObject({ ...r.ownership, configuration: r.configuration, onSha: r.onSha });
      expect(state.finished).toMatchObject({ state: "succeeded", observedModel: null, sessionId: null, usage: null, costUsd: null });
    }
    expect(fake.closed).toEqual(requests.map((r) => r.invocationId));
    expect(projected).toHaveLength(8);
  });

  it("does not execute twice when an invocation ID is reused", async () => {
    const store = createMemoryEventStore();
    let executed = 0;
    const fake = fakeSelector({ execute: async () => { executed++; return outcome; } });
    const r = request("development");
    const run = () => Effect.runPromise(invokeAgent({ store, request: r, now }).pipe(Effect.provide(fake.layer)));
    await run();
    await expect(run()).rejects.toThrow("no longer at version 0");
    expect(executed).toBe(1);
    expect(fake.closed).toHaveLength(2);
  });

  it("persists a failed execution with its original detail and unknown usage", async () => {
    const store = createMemoryEventStore();
    const detail = "protocol broke\n" + "x".repeat(2000);
    const fake = fakeSelector({ execute: async () => { throw new Error(detail); } });
    const r = request("review");
    const receipt = await Effect.runPromise(invokeAgent({ store, request: r, now }).pipe(Effect.provide(fake.layer)));
    expect(receipt).toMatchObject({ state: "failed", failure: { kind: "crash", detail }, costUsd: null, usage: null });
    expect(reduceAgentInvocation(await store.read(invocationStream(r.invocationId))).finished?.failure?.detail).toBe(detail);
    expect(fake.closed).toEqual([r.invocationId]);
  });

  it("cancels an interrupted Effect, waits for the native ending and writes it before closing settings", async () => {
    const store = createMemoryEventStore();
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    const fake = fakeSelector({ execute: (r) => new Promise((resolve) => {
      entered();
      r.signal!.addEventListener("abort", () => resolve({ ...outcome, state: "interrupted",
        failure: { kind: "aborted", detail: "cancelled" }, usage: null, costUsd: null }), { once: true });
    }) });
    const r = request("fix");
    const fiber = Effect.runFork(invokeAgent({ store, request: r, now }).pipe(Effect.provide(fake.layer)));
    await running;
    await Effect.runPromise(Fiber.interrupt(fiber));
    const state = reduceAgentInvocation(await store.read(invocationStream(r.invocationId)));
    expect(state.finished).toMatchObject({ state: "interrupted", failure: { kind: "aborted" }, costUsd: null });
    expect(fake.closed).toEqual([r.invocationId]);
  });

  it("honors interruption while the Started projector callback is still pending", async () => {
    const store = createMemoryEventStore();
    let entered!: () => void;
    let release!: () => void;
    const appending = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const signals: boolean[] = [];
    const fake = fakeSelector({ execute: (r) => new Promise((resolve) => {
      signals.push(r.signal!.aborted);
      const interrupted: InvocationOutcome = { ...outcome, state: "interrupted",
        failure: { kind: "aborted", detail: "cancelled before execution" },
        usage: null, costUsd: null, execution: { processStarted: false, receiptReceived: false } };
      if (r.signal!.aborted) { resolve(interrupted); return; }
      // Bound the broken case so this regression fails instead of hanging.
      const timer = setTimeout(() => resolve(outcome), 100);
      r.signal!.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(interrupted);
      }, { once: true });
    }) });
    const r = request("development");
    const fiber = Effect.runFork(invokeAgent({ store, request: r, now,
      appended: async (events) => {
        if (events[0]!.type === "AgentInvocationStarted") { entered(); await blocked; }
      },
    }).pipe(Effect.provide(fake.layer)));
    await appending;
    await Effect.runPromise(Fiber.interruptFork(fiber));
    release();
    await Effect.runPromise(Fiber.await(fiber));
    expect(signals).toEqual([true]);
    const state = reduceAgentInvocation(await store.read(invocationStream(r.invocationId)));
    expect(state.finished).toMatchObject({ state: "interrupted", failure: { kind: "aborted" },
      execution: { processStarted: false, receiptReceived: false }, usage: null, costUsd: null });
    expect(fake.closed).toEqual([r.invocationId]);
  });

  it("recovers a stopped host's unfinished call honestly, once", async () => {
    const store = createMemoryEventStore();
    const fake = fakeSelector();
    const r = request("development");
    // A write failure after execution leaves only the start, like a hard crash.
    const failing = { ...store, append: async (...args: Parameters<typeof store.append>) => {
      if (args[1] === 1) throw new Error("connection lost");
      return store.append(...args);
    } };
    await expect(Effect.runPromise(invokeAgent({ store: failing, request: r, now }).pipe(Effect.provide(fake.layer)))).rejects.toThrow("connection lost");
    const recover = () => Effect.runPromise(interruptAgentInvocation({ store, invocationId: r.invocationId,
      detail: "previous host stopped; no final receipt", now: () => new Date("2026-09-18T12:01:00.000Z") }));
    expect(await recover()).toBe(true);
    expect(await recover()).toBe(false);
    expect(reduceAgentInvocation(await store.read(invocationStream(r.invocationId))).finished).toMatchObject({
      state: "interrupted", durationMs: 60_000, exitCode: null, usage: null, costUsd: null,
      observedModel: null, sessionId: null, execution: { processStarted: null, receiptReceived: null },
    });
  });

  it("uses invocation accounting once, retaining unknown cost and unlinked legacy receipts", async () => {
    const store = createMemoryEventStore();
    const fake = fakeSelector();
    const r = request("development");
    await Effect.runPromise(invokeAgent({ store, request: r, now }).pipe(Effect.provide(fake.layer)));
    await store.append("run-p-200", 0, [
      { type: "RunFinished", actor: "conductor", data: { invocationId: r.invocationId, exitCode: 0, turns: 5, durationMs: 100, costUsd: 9 } },
      { type: "FixApplied", actor: "conductor", data: { runId: "run-p-200", round: 1, headSha: null, turns: 2, costUsd: 2, failure: null } },
    ]);
    const calls = accountedAgentCalls(store.all());
    expect(calls.map((c) => [c.source, c.costUsd])).toEqual([["invocation", null], ["legacy", 2]]);
    expect(calls[1]!.started).toBe(null);
    const inFlight = accountedAgentCalls(store.all().filter((event) => event.type !== "AgentInvocationFinished"));
    expect(inFlight[0]).toMatchObject({ source: "invocation", costUsd: null, finished: null });
    expect(inFlight).toHaveLength(2);
  });

  it("refuses selection explicitly without preparing, writing or falling back", async () => {
    const store = createMemoryEventStore();
    const r = request("development");
    const layer = Layer.succeed(AgentRuntimes, { select: () => Effect.fail(new RuntimeSelectionRefused({
      agent: "claude-code", role: "development", detail: "unsupported containment",
    })) });
    await expect(Effect.runPromise(invokeAgent({ store, request: r }).pipe(Effect.provide(layer)))).rejects.toThrow("unsupported containment");
    expect(store.all()).toEqual([]);
  });
});

describe("host registry", () => {
  it("does not advertise the historical Codex stub as an implemented adapter", async () => {
    const port = liveRuntimeSelector();
    await expect(Effect.runPromise(port.select({ role: "review", configuration: { ...configuration, agent: "codex" } }))).rejects.toThrow("no installed invocation adapter");
    const selected = await Effect.runPromise(port.select({ role: "discussion", configuration }));
    expect(selected.id).toBe("claude-code");
    await expect(Effect.runPromise(port.select({ role: "development", configuration: { ...configuration, requiredTier: "sandboxed" } }))).rejects.toThrow("filesystem sandbox");
  });
});
