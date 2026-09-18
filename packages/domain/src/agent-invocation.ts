import type { Envelope } from "./envelope.ts";
import { AgentInvocationStarted, AgentInvocationFinished } from "./events.ts";
import { invocationStream } from "./streams.ts";

export interface AgentInvocationState {
  version: number;
  started: AgentInvocationStarted | null;
  finished: AgentInvocationFinished | null;
}

/** A stream has one start and at most one ending. Invalid history fails loudly. */
export function reduceAgentInvocation(events: readonly Envelope[]): AgentInvocationState {
  const state: AgentInvocationState = { version: 0, started: null, finished: null };
  for (const event of events) {
    state.version = event.version;
    if (event.type === "AgentInvocationStarted") {
      if (state.started !== null) throw new Error("invocation already started");
      state.started = AgentInvocationStarted.parse(event.data);
      if (event.streamId !== invocationStream(state.started.invocationId)) throw new Error("invocation is on the wrong stream");
    } else if (event.type === "AgentInvocationFinished") {
      const finished = AgentInvocationFinished.parse(event.data);
      if (event.streamId !== invocationStream(finished.invocationId)) throw new Error("invocation is on the wrong stream");
      if (!state.started || finished.invocationId !== state.started.invocationId) {
        throw new Error("invocation finished without its matching start");
      }
      if (state.finished) throw new Error("invocation already finished");
      if (Date.parse(finished.finishedAt) < Date.parse(state.started.startedAt)) {
        throw new Error("invocation finished before it started");
      }
      state.finished = finished;
    }
  }
  return state;
}

export interface AccountedAgentCall {
  key: string;
  source: "invocation" | "legacy";
  costUsd: number | null;
  /** The source facts, for consumers to read without consulting today's recipe. */
  started: AgentInvocationStarted | null;
  finished: AgentInvocationFinished | null;
  legacy: Envelope | null;
}

/**
 * Pass the full accounting window, including linked invocation streams.
 * A started call owns accounting even before it has a receipt: unknown cost
 * stays unknown. Legacy review prose and DiscussionHeld totals are not receipts.
 */
export function accountedAgentCalls(events: readonly Envelope[]): AccountedAgentCall[] {
  const streams = new Map<string, Envelope[]>();
  for (const event of events) {
    if (event.type !== "AgentInvocationStarted" && event.type !== "AgentInvocationFinished") continue;
    const id = (event.data as { invocationId: string }).invocationId;
    const stream = streams.get(id) ?? [];
    stream.push(event);
    streams.set(id, stream);
  }
  const calls: AccountedAgentCall[] = [];
  for (const [id, events] of streams) {
    const state = reduceAgentInvocation(events);
    calls.push({ key: id, source: "invocation", costUsd: state.finished?.costUsd ?? null,
      started: state.started, finished: state.finished, legacy: null });
  }
  for (const event of events) {
    if (!["RunFinished", "FixApplied", "DiscussionAnswered"].includes(event.type)) continue;
    const data = event.data as { invocationId?: string | null; costUsd?: number | null };
    if (data.invocationId && streams.has(data.invocationId)) continue;
    calls.push({ key: `legacy:${event.seq}`, source: "legacy", costUsd: data.costUsd ?? null,
      started: null, finished: null, legacy: event });
  }
  return calls;
}
