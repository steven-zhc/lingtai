import type {
  AgentRole, InvocationConfiguration, InvocationContainment, InvocationOwnership,
  AgentInvocationFinished, InvocationObservation,
  PayloadOf,
} from "@lingtai/domain";
import type { RunTrace } from "./run-log.ts";
import type { AuthStatus } from "./runtime.ts";

export interface RuntimeSelection {
  role: AgentRole;
  configuration: InvocationConfiguration;
}

interface InvocationRequestBase extends RuntimeSelection {
  /** Unique for every attempt, fix round, review and discussion turn. */
  invocationId: string;
  ownership: InvocationOwnership;
  cwd: string;
  /** A full immutable review SHA. Null where no head is being reviewed. */
  onSha: string | null;
  /** Host chooses an exclusive file outside cwd; adapter chooses its contents. */
  settingsPath: string;
  /** Hook identity/wiring, never a Claude settings object. Host proves fail-closed. */
  hooks?: { hookBinary: string; socketPath: string };
  env: Record<string, string>;
  log?: RunTrace;
  signal?: AbortSignal;
}

export type InvocationRequest = InvocationRequestBase & (
  | { role: "development"; materials: { prompt: string } }
  | { role: "fix"; materials: { prompt: string; findings: readonly PayloadOf<"GateFailed">["findings"][number][] } }
  | { role: "review"; materials: { prompt: string; diff: string } }
  | { role: "discussion"; materials: { question: string; context: string } }
);

/** No counters, model names or session bindings synthesized from request values. */
export type InvocationOutcome = Omit<AgentInvocationFinished, "invocationId" | "finishedAt">;

export const UNKNOWN_OBSERVATION: InvocationObservation = {
  observedModel: null, sessionId: null, threadId: null, usage: null,
  execution: { processStarted: null, receiptReceived: null },
};

/** Ordinary Promise seam: actions can execute without depending on Effect. */
export interface PreparedInvocation {
  readonly containment: InvocationContainment;
  execute(): Promise<InvocationOutcome>;
  close(): Promise<void>;
}
export interface InvocationRuntime {
  readonly id: InvocationConfiguration["agent"];
  /** Asked in the exact filtered environment the selected role will receive. */
  checkAuth?(env: Record<string, string>): Promise<AuthStatus>;
  /** Reject unsupported roles/limits/tiers before settings, events or execution. */
  supports(selection: RuntimeSelection): void;
  prepare(request: InvocationRequest): Promise<PreparedInvocation>;
}

export class InvocationRefused extends Error {
  override readonly name = "InvocationRefused";
  readonly kind: "unsupported" | "configuration";
  readonly observation: InvocationObservation;
  constructor(kind: "unsupported" | "configuration", detail: string) {
    super(detail);
    this.kind = kind;
    this.observation = { ...UNKNOWN_OBSERVATION, execution: { processStarted: false, receiptReceived: false } };
  }
}
