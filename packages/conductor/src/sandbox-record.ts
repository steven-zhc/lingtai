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
import { parsePayload, type Step, type ToAppend } from '@lingtai/domain'
import type { SandboxDecision } from '@lingtai/recipe'
import { newCommandId, worthRecording, type SandboxApi, type WrapInput } from '@lingtai/sandbox'
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
        Effect.flatMap((read) =>
          worthRecording(read)
            ? append([
                {
                  type: 'SandboxConnectionsRefused',
                  actor: 'conductor',
                  data: parsePayload('SandboxConnectionsRefused', { ...keysOf(keys, wrapped.commandId), read }),
                },
              ])
            : Effect.void,
        ),
      ),
    )
    return wrapped
  })
