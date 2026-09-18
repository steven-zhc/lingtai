import { describe, expect, it } from "vitest";
import {
  AgentInvocationStarted, AgentInvocationFinished, InvocationUsage,
  reduceAgentInvocation, parseStoredPayload, SCHEMA_VER,
} from "../src/index.ts";
import { makeStream } from "./support.ts";

const source = { kind: "default" as const, path: null };
const started = {
  invocationId: "one-call", project: "p", workItemId: "wi-p-200", role: "review" as const,
  runId: "run-p-200", chatId: null, gatePoint: "proposed" as const, action: "cold-review", fixRound: null,
  cwd: "/review/one", onSha: "b".repeat(40), startedAt: "2026-09-18T12:00:00.000Z",
  configuration: { agent: "codex" as const, model: null, modelSelection: "agent-default" as const,
    requiredTier: "sandboxed" as const, limits: { turns: null, wall: "5m", wallMs: 300_000 },
    configHash: "a".repeat(64), provenance: { agent: source, model: source, tier: source, "limits.turns": source, "limits.wall": source } },
  containment: { tier: "sandboxed" as const, mechanism: "fixture sandbox", filesystemSandbox: true, commands: true, fileChanges: true },
};
const finished = {
  invocationId: "one-call", state: "failed" as const, finishedAt: "2026-09-18T12:01:00.000Z",
  observedModel: null, sessionId: null, threadId: "observed-thread", usage: null, costUsd: null,
  execution: { processStarted: true, receiptReceived: false }, exitCode: 1, durationMs: 60_000,
  failure: { kind: "crash" as const, detail: "connection lost after model execution" },
  text: null,
};

describe("durable invocation facts", () => {
  it("retains unknown cost after execution rather than classifying Codex as never-started", () => {
    const event = makeStream("inv-one-call");
    const state = reduceAgentInvocation([event("AgentInvocationStarted", started), event("AgentInvocationFinished", finished)]);
    expect(state.finished).toEqual(finished);
    expect(state.started?.configuration.model).toBe(null);
  });
  it("refuses mismatched or repeated terminal receipts and ending before the start", () => {
    const event = makeStream("inv-one-call");
    const begin = event("AgentInvocationStarted", started);
    const end = event("AgentInvocationFinished", finished);
    expect(() => reduceAgentInvocation([end])).toThrow("matching start");
    expect(() => reduceAgentInvocation([begin, end, end])).toThrow("already finished");
    expect(() => reduceAgentInvocation([begin, { ...end, data: { ...finished, invocationId: "another-call" } }])).toThrow("wrong stream");
    expect(() => reduceAgentInvocation([begin, { ...end, data: { ...finished, finishedAt: "2026-09-18T11:00:00.000Z" } }])).toThrow("before it started");
  });
  it("requires correct role ownership, full review SHA and discussion's command/file restrictions", () => {
    expect(AgentInvocationStarted.safeParse({ ...started, onSha: "short" }).success).toBe(false);
    expect(AgentInvocationStarted.safeParse({ ...started, workItemId: "wi-other-200" }).success).toBe(false);
    expect(AgentInvocationStarted.safeParse({ ...started, role: "fix", fixRound: null }).success).toBe(false);
    expect(AgentInvocationStarted.safeParse({ ...started, role: "discussion", chatId: "chat-one", gatePoint: null, action: null }).success).toBe(false);
    expect(AgentInvocationFinished.safeParse({ ...finished, state: "succeeded" }).success).toBe(false);
  });
  it("keeps native turn units and cannot attach a count without its unit", () => {
    const usage = { turns: 1, turnUnit: "codex-protocol-turn", inputTokens: null, outputTokens: null, cachedInputTokens: null };
    expect(InvocationUsage.parse(usage)).toEqual(usage);
    expect(InvocationUsage.safeParse({ ...usage, turnUnit: null }).success).toBe(false);
    expect(InvocationUsage.safeParse({ ...usage, turns: null }).success).toBe(false);
  });
  it("adds no agent, model, containment or cost when upcasting legacy process events", () => {
    const payloads = {
      RunFinished: { exitCode: 0, turns: 2, durationMs: 12, costUsd: null },
      RunFailed: { kind: "crash", detail: "old detail" },
      FixApplied: { runId: "run-old", round: 1, headSha: null, turns: 2, costUsd: 1, failure: null },
      DiscussionAsked: { workItemId: "wi-p-200", attempt: null, by: "human:steven", question: "why?", reading: [] },
      DiscussionAnswered: { text: "answer", read: [], cannot: [], proposal: null, turns: 1, durationMs: 10, costUsd: null, failure: null },
      GateNeverRan: { gate: "proposed", action: "review", runId: "run-old", onSha: "old", detail: "old quota" },
    };
    for (const [type, payload] of Object.entries(payloads)) {
      const key = type as keyof typeof payloads;
      expect(SCHEMA_VER[key]).toBe(2);
      expect(parseStoredPayload(key, 1, payload)).toEqual({ ...payload, invocationId: null });
    }
  });
});
