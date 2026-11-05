/**
 * A `AttemptState`, stored and read back (0124 §1, #844).
 *
 * The run twin of `ticket-codec.ts`, with the same rules (#833): `bigint` is a
 * string (`lastSeq`), a `Date` an ISO string, absent and `null` stay apart, and
 * a value of another shape is refused by name rather than filled from
 * `emptyAttempt`. The payload copies inside the state are the event schemas
 * themselves, so a shape is defined once. No registry, no version.
 *
 * The first projection to store a run's state is `task_view`, so this lands
 * with it (ADR 0124 §1: a reducer's codec lands with the first projection that
 * stores its state).
 */
import { z } from 'zod'

import { emptyAttempt, reduceAttemptEvent, type AttemptState } from './attempt.ts'
import {
  Finding,
  Invocation,
  RunKeptUncommitted,
  RunProducedDiff,
  RunRefsPublished,
  RUN_FAILURE_KINDS,
  RuntimeId,
  Step,
} from './events.ts'
import { StoredRoute } from './routing.ts'
import { PromptRefEntry } from './prompt-ref.ts'
import type { Reducer } from './reducer.ts'
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

// Keys in the order the reduce writes them, so a decoded state encodes to the same text as one that never
// left memory: an incremental reduce and a rebuild then store identical rows.
const StepState = z.strictObject({
  step: z.string(),
  onSha: z.string(),
  by: z.string().nullable(),
  reason: z.string().nullable(),
  verdict: z.enum(['passed', 'failed', 'never-ran', 'did-not-finish', 'asked', 'waived']),
  evidence: z.string().nullable(),
  findings: z.array(Finding),
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
  refusal: z
    .strictObject({
      key: z.string(),
      evidence: z.string(),
      findings: z.array(Finding),
      endedVersion: z.number(),
      action: z.string(),
    })
    .nullable(),
  touched: z.array(z.strictObject({ path: z.string(), op: z.enum(['edit', 'write', 'delete']) })),
  compactedAtTurns: z.array(z.number()),
  prompts: z.number(),
  prompt: z.string().nullable(),
  promptMeta: z.strictObject({ version: z.string(), bytes: z.number() }).nullable(),
  /** #928; absent on a row written before it. */
  promptRefs: z.array(PromptRefEntry).nullable().optional(),
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
  route: StoredRoute.nullable(),
  published: RunRefsPublished.nullable(),
  kept: z.array(RunKeptUncommitted),
  version: z.number(),
  lastSeq: Seq.transform((s) => BigInt(s)).nullable(),
})

/** Thrown for a stored state that is not a `AttemptState` of today's shape. */
export class RunCodecError extends Error {
  override readonly name = 'RunCodecError'
}

/** 0124 §1's codec for this reduce. `bigint` as a string, `Date` as ISO, absent and `null` kept apart. */
export function encodeRun(state: AttemptState): string {
  return JSON.stringify(state, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))
}

/** The parse behind both decoders: the state, or what is wrong with the stored value. */
function parseStored(stored: unknown): { ok: true; state: AttemptState } | { ok: false; what: string } {
  let value = stored
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored)
    } catch {
      return { ok: false, what: 'not JSON' }
    }
  }
  const parsed = StoredRun.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    return { ok: false, what: `${issue.path.length === 0 ? 'run_state' : issue.path.join('.')}: ${issue.message}` }
  }
  const state = parsed.data as AttemptState
  const differs = firstDifference(value, JSON.parse(encodeRun(state)), 'run_state')
  if (differs !== null) return { ok: false, what: `${differs}: not part of today's shape` }
  return { ok: true, state }
}

/**
 * A string (SQLite) or a parsed value (Postgres `jsonb`), back to a `AttemptState`.
 * Throws, naming the run and `lingtai projection rebuild <projection>`, on any other shape.
 */
export function decodeRun(stored: unknown, projection: string, runId?: string): AttemptState {
  const r = parseStored(stored)
  if (r.ok) return r.state
  throw new RunCodecError(
    `${projection}${runId === undefined ? '' : ` ${runId}`}: the stored run state is not today's shape (${r.what}); ` +
      `run \`lingtai projection rebuild ${projection}\``,
  )
}

/** The attempt reduce as a snapshottable reducer (0124 §1). A snapshot is discarded, not rebuilt, so no remedy is named. */
export const attemptReducer: Reducer<AttemptState> = {
  name: 'attempt',
  // 2: a `RunPrompted` for implement round 0 now folds into `prompt` (#928); a
  // version-1 snapshot may have been cut by a reducer that ignored it.
  // 3: a `ProposalRouted` folds like a `PassRouted` (#932), and `refusal` names
  // the `StepEnded` version and action it came from.
  version: 3,
  initial: emptyAttempt,
  reduceEvent: reduceAttemptEvent,
  encode: encodeRun,
  decode: (stored) => {
    const r = parseStored(stored)
    if (r.ok) return r.state
    throw new RunCodecError(`attempt snapshot: the stored state is not today's shape (${r.what})`)
  },
}
