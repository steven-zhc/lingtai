/**
 * What a pass appends about each invocation's sandbox boundary and its refused connections (#1164).
 *
 * The boundary goes on the attempt's `pass-` stream **before the child starts**, so an invocation that died still
 * has it. The refused connections go **after it ends**, from a finalizer that runs *inside the wrap's scope*: the
 * scope's own release unregisters srt's per-command list and cleans up, so a read after it would find nothing and
 * record a clean invocation that was not.
 *
 * `runId` is per attempt, so an invocation is keyed by step and action (and the dispatch's own id for an agent),
 * and by the wrap's `commandId`.
 */
import { parsePayload, type Step, type StepOutcome, type ToAppend } from '@lingtai/domain'
import type { SandboxDecision } from '@lingtai/recipe'
import { newCommandId, worthRecording, type RefusedRead, type SandboxApi, type WrapInput } from '@lingtai/sandbox'
import { Effect } from 'effect'

/** What names one invocation, besides its `commandId`. `runId` is null and `runtime` absent for a `run:` command. */
export interface InvocationKeys {
  readonly step: Step
  readonly action: string
  readonly runtime?: string | undefined
  readonly runId: string | null
}

/** Appends to the attempt's `pass-` stream. Conduct's, so that a hook server holding the stream's version stays in step. */
export type AppendInvocation = (events: readonly ToAppend[]) => Effect.Effect<void>

/**
 * The two appends an invocation makes. `before` is the boundary, which **must not be lost**: a refused one is a
 * defect that stops the child from starting. `after` is the refusals: a refused append is remembered by the
 * conductor (so the pass cannot report success without it) but does not fail the invocation, whose receipts matter more.
 */
export interface InvocationAppends {
  readonly before: AppendInvocation
  readonly after: AppendInvocation
  /**
   * Told each read worth recording, **before** `after` appends it, so a refused append does not lose a read that
   * happened (#1157). Absent where nobody collects.
   */
  readonly read?: (step: Step, read: RefusedRead) => void
}

type NotSandboxed = Exclude<SandboxDecision, { kind: 'sandboxed' }>

/** The boundary an invocation that is not wrapped ran under. */
export const boundaryOfDecision = (decision: NotSandboxed) =>
  decision.kind === 'refused'
    ? ({ kind: 'refused', why: decision.why } as const)
    : decision.reason === 'degraded'
      ? ({ kind: 'unsandboxed', reason: 'degraded', why: decision.why } as const)
      : ({ kind: 'unsandboxed', reason: 'off by choice' } as const)

const keysOf = (keys: InvocationKeys, commandId: string) => ({
  step: keys.step,
  action: keys.action,
  ...(keys.runtime === undefined ? {} : { runtime: keys.runtime }),
  runId: keys.runId,
  commandId,
})

/** A decided-but-not-wrapped invocation: its boundary, with an id of its own, and no refusals to read. */
export const recordUnwrapped = (
  decision: NotSandboxed,
  keys: InvocationKeys,
  append: AppendInvocation,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const commandId = yield* Effect.sync(newCommandId)
    yield* append([
      {
        type: 'SandboxBoundaryRecorded',
        actor: 'conductor',
        data: parsePayload('SandboxBoundaryRecorded', {
          ...keysOf(keys, commandId),
          boundary: boundaryOfDecision(decision),
        }),
      },
    ])
  })

/**
 * `api.wrap`, then the boundary, then a finalizer that reads the refusals.
 *
 * A wrap that fails appends nothing: no child starts and no `commandId` was minted, so the run's own failure is the
 * record. A reader of the stream must not take that absence for *unsandboxed*; the schema reads it as *unknown*.
 *
 * The policy is computed from the same `input` the wrap was given, so the recorded one is what srt was handed.
 * The finalizer is added after `api.wrap`'s own two, so a scope runs it first.
 */
export const recordingWrap = (
  api: SandboxApi,
  wrapInput: WrapInput,
  keys: InvocationKeys,
  appends: InvocationAppends,
): ReturnType<SandboxApi['wrap']> =>
  Effect.gen(function* () {
    const wrapped = yield* api.wrap(wrapInput)
    const policy = api.policyOf(wrapInput)
    yield* appends.before([
      {
        type: 'SandboxBoundaryRecorded',
        actor: 'conductor',
        data: parsePayload('SandboxBoundaryRecorded', {
          ...keysOf(keys, wrapped.commandId),
          boundary: { kind: 'sandboxed', srtVersion: policy.srtVersion, policy },
        }),
      },
    ])
    // Named `append` so the catalogue's finder reads this as the refusals' append site.
    const append = appends.after
    yield* Effect.addFinalizer(() =>
      api.refusedConnections(wrapped).pipe(
        Effect.flatMap((read) => {
          if (!worthRecording(read)) return Effect.void
          // Before the append, so a refused append does not lose a read that happened (#1157).
          appends.read?.(keys.step, read)
          return append([
            {
              type: 'SandboxConnectionsRefused',
              actor: 'conductor',
              data: parsePayload('SandboxConnectionsRefused', { ...keysOf(keys, wrapped.commandId), read }),
            },
          ])
        }),
      ),
    )
    return wrapped
  })

/**
 * The hosts a set of reads refused, as `host:port` (`host` where the port is unknown; the whole line where it
 * did not parse), in first-seen order, each once (#1157).
 *
 * **Telemetry never counts** (0127 §17). An `unreadable` read counts as no refusal: the step routes as today. An
 * incomplete read still counts: a host it did see is a refusal.
 */
export const refusedHostsOf = (reads: readonly RefusedRead[]): string[] => {
  const hosts = new Set<string>()
  for (const read of reads) {
    if (read.kind !== 'entries') continue
    for (const entry of read.entries) {
      if (entry.telemetry) continue
      hosts.add(
        entry.host === null
          ? (entry.line ?? 'unknown')
          : entry.port === null
            ? entry.host
            : `${entry.host}:${entry.port}`,
      )
    }
  }
  return [...hosts]
}

/** What the sandbox did to a step, for its `StepOutcome`: absent when there is nothing to say. */
export const sandboxOutcomeOf = (reads: readonly RefusedRead[]): StepOutcome['sandbox'] => {
  const refused = refusedHostsOf(reads)
  return refused.length === 0 ? undefined : { refused }
}

/**
 * **One pass's record of what its invocations were refused**, by step (#1157). Tee'd from the refusals append, so a
 * refused append does not lose a read that happened; **drained** by `runStep` after the step's actions return, so
 * a fix round's second `build` sees only its own reads. Built inside one `conduct` call: two passes at once each
 * have their own.
 */
export interface RefusalCollector {
  /** Remembers one read. */
  readonly record: (step: Step, read: RefusedRead) => void
  /** The step's reads, cleared. */
  readonly drain: (step: Step) => readonly RefusedRead[]
}

export const makeRefusalCollector = (): RefusalCollector => {
  const byStep = new Map<Step, RefusedRead[]>()
  return {
    record: (step, read) => {
      const reads = byStep.get(step) ?? []
      reads.push(read)
      byStep.set(step, reads)
    },
    drain: (step) => {
      const reads = byStep.get(step) ?? []
      byStep.delete(step)
      return reads
    },
  }
}
