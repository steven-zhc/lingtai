import {
  AgentInvocationStarted, AgentInvocationFinished, invocationStream, reduceAgentInvocation,
  InvocationObservation, InvocationFailure, type Envelope,
} from "@lingtai/domain";
import type { EventStore } from "@lingtai/event-store/store";
import type { InvocationRequest, InvocationOutcome } from "@lingtai/agent";
import { Data, Effect, Exit } from "effect";
import { AgentRuntimes } from "./ports.ts";

export class InvocationLifecycleFailed extends Data.TaggedError("InvocationLifecycleFailed")<{
  operation: string;
  detail: string;
  observation?: InvocationObservation;
}> {
  override get message() {
    return this.detail;
  }
}
const detailOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const observationOf = (error: unknown) =>
  InvocationObservation.safeParse((error as { observation?: unknown } | null)?.observation).data;
const io = <T>(operation: string, work: () => Promise<T>) => Effect.tryPromise({
  try: work,
  catch: (error) => new InvocationLifecycleFailed({ operation, detail: detailOf(error), observation: observationOf(error) }),
});
const unknown: InvocationObservation = { observedModel: null, sessionId: null, threadId: null,
  usage: null, execution: { processStarted: null, receiptReceived: null } };

export interface InvokeAgentOptions {
  store: EventStore;
  request: InvocationRequest;
  now?: () => Date;
  /** Hosts that hold a projector can catch it up after each durable write. */
  appended?: (events: readonly Envelope[]) => Promise<void>;
}

/** A reusable lifecycle, connected to the process flows in #204/#205. */
export function invokeAgent(options: InvokeAgentOptions) {
  const { store, request } = options;
  const now = options.now ?? (() => new Date());
  const stream = invocationStream(request.invocationId);
  const append = (version: number, type: "AgentInvocationStarted" | "AgentInvocationFinished", data: unknown) =>
    io("append invocation", async () => {
      const written = await store.append(stream, version, [{ type, data, actor: "conductor" }]);
      await options.appended?.(written);
    });
  return Effect.scoped(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const selector = yield* AgentRuntimes;
    const runtime = yield* restore(selector.select(request));
    // The scope owns a controller too: Effect interruption cancels the native
    // call, then waits for its ending before settings are released.
    const controller = new AbortController();
    const prepared = yield* Effect.acquireRelease(
      io("prepare invocation", () => runtime.prepare({ ...request,
        signal: request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal })),
      (prepared) => Effect.promise(() => prepared.close()),
    );
    const startedAt = now().toISOString();
    const started = AgentInvocationStarted.parse({ ...request.ownership,
      invocationId: request.invocationId, configuration: request.configuration,
      cwd: request.cwd, onSha: request.onSha, containment: prepared.containment, startedAt });
    yield* append(0, "AgentInvocationStarted", started);
    // Interrupt the process immediately, but finish its durable receipt in the
    // masked region. A hard host crash is closed honestly by recovery below.
    let pending: Promise<InvocationOutcome> | undefined;
    const executeOnce = () => pending ??= Promise.resolve().then(() => prepared.execute()).catch((error: unknown): InvocationOutcome => ({
      ...(observationOf(error) ?? unknown),
      state: "failed",
      exitCode: null,
      durationMs: Math.max(0, now().getTime() - Date.parse(startedAt)),
      costUsd: null,
      text: null,
      failure: InvocationFailure.safeParse({
        kind: (error as { kind?: unknown } | null)?.kind ?? "crash", detail: detailOf(error),
      }).data ?? { kind: "crash", detail: detailOf(error) || "agent execution failed without detail" },
    }));
    const execute = Effect.async<InvocationOutcome>((resume) => {
      void executeOnce().then((outcome) => resume(Effect.succeed(outcome)));
      return Effect.promise(async () => { controller.abort(); await executeOnce(); });
    });
    const exit = yield* Effect.exit(restore(execute));
    // An interruption during prepare/Started can skip the async registration
    // entirely. Abort before asking the adapter for its pre-cancelled receipt.
    if (Exit.isFailure(exit)) controller.abort();
    const outcome = Exit.isSuccess(exit) ? exit.value : yield* io("finish cancelled invocation", executeOnce);
    const finished = AgentInvocationFinished.parse({ ...outcome, invocationId: request.invocationId,
      finishedAt: now().toISOString() });
    yield* append(1, "AgentInvocationFinished", finished);
    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
    return outcome;
  })));
}

/**
 * Call only after the host proves the previous owner/process has stopped.
 * Never scan-and-close active calls. A terminal stream is idempotently left alone;
 * a competing writer loses the store's expected-version check.
 */
export function interruptAgentInvocation(options: {
  store: EventStore; invocationId: string; detail: string; now?: () => Date;
  observation?: InvocationObservation;
}) {
  return Effect.gen(function* () {
    const stream = invocationStream(options.invocationId);
    const events = yield* io("read invocation", () => options.store.read(stream));
    const state = reduceAgentInvocation(events);
    if (!state.started || state.finished) return false;
    const finishedAt = (options.now ?? (() => new Date()))().toISOString();
    const receipt = AgentInvocationFinished.parse({ ...options.observation ?? unknown,
      invocationId: options.invocationId, finishedAt, state: "interrupted",
      exitCode: null, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(state.started.startedAt)),
      costUsd: null, text: null, failure: { kind: "interrupted", detail: options.detail } });
    yield* io("interrupt invocation", () => options.store.append(stream, state.version,
      [{ type: "AgentInvocationFinished", data: receipt, actor: "conductor" }]));
    return true;
  });
}
