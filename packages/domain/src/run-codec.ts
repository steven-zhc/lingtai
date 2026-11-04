/**
 * A `RunState`, stored and read back (0124 §1, #844).
 *
 * The run twin of `ticket-codec.ts`, with the same rules (#833): `bigint` is a
 * string (`lastSeq`), a `Date` an ISO string, absent and `null` stay apart, and
 * a value of another shape is refused by name rather than filled from
 * `emptyRun`. The payload copies inside the state are the event schemas
 * themselves, so a shape is defined once. No registry, no version.
 *
 * The first projection to store a run's state is `task_view`, so this lands
 * with it (ADR 0124 §1: a fold's codec lands with the first projection that
 * stores its state).
 */
import { z } from 'zod'

import {
  Finding,
  Invocation,
  PassRouted,
  RunKeptUncommitted,
  RunProducedDiff,
  RunRefsPublished,
  RUN_FAILURE_KINDS,
  RuntimeId,
  Step,
  SEVERITIES,
} from './events.ts'
import type { RunState } from './run.ts'
import { firstDifference } from './ticket-codec.ts'

const IsoDate = z.iso.datetime().transform((s) => new Date(s))
const Seq = z.string().regex(/^\d+$/, 'expected a bigint stored as a string of digits')

const Lifecycle = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('running') }),
  z.strictObject({ status: z.literal('awaiting-input'), prompt: z.string() }),
  z.strictObject({ status: z.literal('gating'), headSha: z.string() }),
  z.strictObject({
    status: z.literal('awaiting-approval'),
    step: z.string(),
    onSha: z.string(),
    question: z.string(),
  }),
  z.strictObject({
    status: z.literal('finished'),
    exitCode: z.number(),
    turns: z.number(),
    durationMs: z.number(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    kind: z.enum([...RUN_FAILURE_KINDS, 'prepare-failed']),
    detail: z.string(),
  }),
])

const StepFinding = z.strictObject({
  file: z.string(),
  line: z.number().nullable(),
  claim: z.string(),
  failureScenario: z.string(),
  severity: z.enum(SEVERITIES),
})

// Keys in the order the reduce writes them, so a decoded state encodes to the same text as one that never
// left memory: an incremental fold and a rebuild then store identical rows.
const StepState = z.strictObject({
  step: z.string(),
  onSha: z.string(),
  by: z.string().nullable(),
  reason: z.string().nullable(),
  verdict: z.enum(['passed', 'failed', 'never-ran', 'did-not-finish', 'asked', 'waived']),
  evidence: z.string().nullable(),
  findings: z.array(StepFinding),
})

const StoredRun = z.strictObject({
  lifecycle: Lifecycle,
  ticketId: z.string().nullable(),
  runtime: RuntimeId.nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  baseSha: z.string().nullable(),
  worktree: z.string().nullable(),
  invocation: Invocation.nullable(),
  headSha: z.string().nullable(),
  produced: RunProducedDiff.nullable(),
  failure: z.strictObject({ kind: z.enum(RUN_FAILURE_KINDS), detail: z.string() }).nullable(),
  refusal: z.strictObject({ key: z.string(), evidence: z.string(), findings: z.array(Finding) }).nullable(),
  touched: z.array(z.strictObject({ path: z.string(), op: z.enum(['edit', 'write', 'delete']) })),
  compactedAtTurns: z.array(z.number()),
  prompts: z.number(),
  prompt: z.string().nullable(),
  promptMeta: z.strictObject({ version: z.string(), bytes: z.number() }).nullable(),
  steps: z.record(z.string(), StepState),
  step: z.strictObject({ step: Step, round: z.number(), since: IsoDate }).nullable(),
  openedAt: IsoDate.nullable(),
  agentStartedAt: IsoDate.nullable(),
  askedAt: IsoDate.nullable(),
  laneWaitedAt: IsoDate.nullable(),
  resolved: z
    .strictObject({
      configHash: z.string(),
      steps: z.array(z.strictObject({ step: Step, actions: z.array(z.string()) })),
    })
    .nullable(),
  implementRound: z.number(),
  roundsOpened: z.array(z.number()),
  receipt: z.strictObject({ exitCode: z.number(), turns: z.number(), durationMs: z.number() }).nullable(),
  route: PassRouted.nullable(),
  published: RunRefsPublished.nullable(),
  kept: z.array(RunKeptUncommitted),
  version: z.number(),
  lastSeq: Seq.transform((s) => BigInt(s)).nullable(),
})

/** Thrown for a stored state that is not a `RunState` of today's shape. */
export class RunCodecError extends Error {
  override readonly name = 'RunCodecError'
}

/** 0124 §1's codec for this fold. `bigint` as a string, `Date` as ISO, absent and `null` kept apart. */
export function encodeRun(state: RunState): string {
  return JSON.stringify(state, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))
}

/**
 * A string (SQLite) or a parsed value (Postgres `jsonb`), back to a `RunState`.
 * Throws, naming the run and `lingtai projection rebuild <projection>`, on any other shape.
 */
export function decodeRun(stored: unknown, projection: string, runId?: string): RunState {
  const refuse = (what: string): never => {
    throw new RunCodecError(
      `${projection}${runId === undefined ? '' : ` ${runId}`}: the stored run state is not today's shape (${what}); ` +
        `run \`lingtai projection rebuild ${projection}\``,
    )
  }
  let value = stored
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored)
    } catch {
      return refuse('not JSON')
    }
  }
  const parsed = StoredRun.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    return refuse(`${issue.path.length === 0 ? 'run_state' : issue.path.join('.')}: ${issue.message}`)
  }
  const state = parsed.data as RunState
  const differs = firstDifference(value, JSON.parse(encodeRun(state)), 'run_state')
  if (differs !== null) return refuse(`${differs}: not part of today's shape`)
  return state
}
