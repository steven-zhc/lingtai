/**
 * The Integration aggregate: `int-{project}-{base}`, one per base branch,
 * forever. It is the *record* of the lane, and since #194 it is not the
 * serialisation point: two integrations against one base overlap, and git's ref
 * update decides which lands.
 *
 * This is the aggregate that exists because of a specific, expensive silence.
 * The old loop's `integrate()` had six `return 1` paths, and not one of them
 * emitted a log line, a comment or a label. #58 and #59 re-ran five times for
 * roughly $29 while the actual cause — a dirty checkout of `main` on the
 * operator's own machine — was never reported by anything.
 *
 * So every refusal here is typed and counted. `refusalsByReason` is the query
 * that could not be written before: *why does this project fail to merge?*
 */
import type { Envelope } from './envelope.ts'
import type { PayloadOf, RefusalReason } from './events.ts'

export type IntegrationLifecycle =
  | { status: 'idle' }
  /**
   * An integration is in flight against this base. It excludes nothing —
   * another may be attempting the same base, and one of the two will be
   * refused at the push (#194).
   */
  | { status: 'attempting'; ticketId: string; branch: string; headSha: string }

export type IntegrationStatus = IntegrationLifecycle['status']

/**
 * The whole of `IntegrationRefused`'s payload, not just the four fields this
 * file used to keep — #445's `MergeRefused` wants `paths`, `baseSha` and
 * `headSha` too, and they are already on every row the reducer stores.
 */
export type Refusal = PayloadOf<'IntegrationRefused'>

export interface Landed {
  ticketId: string
  branch: string
  mergeCommit: string
}

export interface IntegrationState {
  lifecycle: IntegrationLifecycle

  /** Set by the first success; the lane's base branch. */
  base: string | null

  attempts: number
  /** Merges, oldest first. */
  landed: readonly Landed[]
  /** Refusals, oldest first — each one a `return 1` that used to be silent. */
  refusals: readonly Refusal[]
  /** The same, tallied. The answer to "why does this project fail to merge?" */
  refusalsByReason: Readonly<Partial<Record<RefusalReason, number>>>

  version: number
  lastSeq: bigint | null
}

export const emptyIntegration: IntegrationState = {
  lifecycle: { status: 'idle' },
  base: null,
  attempts: 0,
  landed: [],
  refusals: [],
  refusalsByReason: {},
  version: 0,
  lastSeq: null,
}

export function reduceIntegrationEvent(state: IntegrationState, event: Envelope): IntegrationState {
  const at = { version: event.version, lastSeq: event.seq }

  switch (event.type) {
    case 'IntegrationAttempted': {
      const d = event.data as PayloadOf<'IntegrationAttempted'>
      return {
        ...state,
        ...at,
        lifecycle: {
          status: 'attempting',
          ticketId: d.ticketId,
          branch: d.branch,
          headSha: d.headSha,
        },
        attempts: state.attempts + 1,
      }
    }

    case 'IntegrationRefused': {
      const d = event.data as PayloadOf<'IntegrationRefused'>
      return {
        ...state,
        ...at,
        // Back to idle. A refusal that left this `attempting` would say a merge
        // is in flight for ever, and the board would say so with it.
        lifecycle: { status: 'idle' },
        refusals: [...state.refusals, d],
        refusalsByReason: {
          ...state.refusalsByReason,
          [d.reason]: (state.refusalsByReason[d.reason] ?? 0) + 1,
        },
      }
    }

    case 'IntegrationSucceeded': {
      const d = event.data as PayloadOf<'IntegrationSucceeded'>
      return {
        ...state,
        ...at,
        lifecycle: { status: 'idle' },
        base: d.base,
        landed: [...state.landed, { ticketId: d.ticketId, branch: d.branch, mergeCommit: d.mergeCommit }],
      }
    }

    default:
      // See the note in ticket.ts: ignored, not rejected.
      return { ...state, ...at }
  }
}

export function reduceIntegration(events: readonly Envelope[]): IntegrationState {
  return events.reduce(reduceIntegrationEvent, emptyIntegration)
}

/**
 * Whether the **last** attempt on this base has reached a terminal event yet.
 *
 * A reading, and nothing waits on it: nothing consults it before attempting, and nothing has
 * since the lane stopped taking a lock (#194).
 *
 * **It cannot answer *is anything merging right now*, and a caller that reads
 * it that way will be wrong in both directions.** Overlap is the design: A and
 * B both append `IntegrationAttempted`, A is refused at the push, and the first
 * terminal puts `lifecycle` back to `idle` while B is still merging — so this
 * says false with a merge in flight. While both are in flight `lifecycle` names
 * whichever attempted *last*, so B's `ticketId` and `headSha` have overwritten
 * A's. One `lifecycle` cannot hold two, which is why the reducer does not try.
 *
 * What is left is what a single-writer lane made this mean and a chip could
 * still say honestly: something attempted here and nothing has said how it
 * ended. Counting what is genuinely open needs the attempts paired to their
 * terminals by `ticketId`, which is a different reduce, and no caller has
 * needed it.
 */
export function laneIsBusy(state: IntegrationState): boolean {
  return state.lifecycle.status === 'attempting'
}

/**
 * What the project's base is, as the log of `int-{project}-{base}` says it (#1208, 0108 §13): the newest
 * `BaseChecked`, whatever its command or boundary. Red is a fact about a commit, so it carries `baseSha`.
 *
 * `builds` reads the recipe's `build` list as plain data (only when there is a red to match), because a record's `command` is the `run:` text and
 * `baseIsRed` is asked for an action's *name*. A red whose command no `run:` action builds any more is
 * `not-built`, which is not red: nothing could be asked about it.
 */
export type BaseState =
  | {
      readonly red: {
        readonly action: string
        readonly command: string
        readonly base: string
        readonly baseSha: string
        readonly boundary: string
        readonly runId: string
        /** The oldest red since the last green: the commit the fix ticket is keyed by (#1266). */
        readonly firstRedSha: string
        readonly firstRedAt: Date
        /** The newest red's bounded output, and the failing tests of a flake since the last green, if any. */
        readonly evidence: string
        readonly flaky: readonly string[] | null
        /** `base-red:<base>:<firstRedSha>`. */
        readonly key: string
        /** The newest `BaseFixProposed` for exactly this key, or none. */
        readonly fix: { readonly externalRef: string; readonly url: string | null } | null
      }
    }
  | { readonly notRed: 'none' | 'green' | 'not-built' }

export function baseStateOf(
  events: readonly Envelope[],
  builds: () => readonly { readonly name: string; readonly run: string }[],
): BaseState {
  const newest = events.findLast((event) => event.type === 'BaseChecked')
  if (newest === undefined) return { notRed: 'none' }
  const d = newest.data as PayloadOf<'BaseChecked'>
  if (d.ok) return { notRed: 'green' }
  const action = builds().find((build) => build.run === d.command)
  if (action === undefined) return { notRed: 'not-built' }
  // The first red since the last green, whatever its command: the key must not move while the base stays red.
  const checks = events.filter((event) => event.type === 'BaseChecked')
  const lastGreen = checks.findLastIndex((event) => (event.data as PayloadOf<'BaseChecked'>).ok)
  const first = checks[lastGreen + 1] ?? newest
  const flaky = checks.slice(lastGreen + 1).findLast((c) => (c.data as PayloadOf<'BaseChecked'>).flaky?.length)
  const firstRedSha = (first.data as PayloadOf<'BaseChecked'>).baseSha
  const key = `base-red:${d.base}:${firstRedSha}`
  const proposed = events.findLast(
    (event) => event.type === 'BaseFixProposed' && (event.data as PayloadOf<'BaseFixProposed'>).key === key,
  )
  const fix =
    proposed === undefined
      ? null
      : {
          externalRef: (proposed.data as PayloadOf<'BaseFixProposed'>).externalRef,
          url: (proposed.data as PayloadOf<'BaseFixProposed'>).url,
        }
  return {
    red: {
      action: action.name,
      command: d.command,
      base: d.base,
      baseSha: d.baseSha,
      boundary: d.boundary ?? 'unsandboxed',
      runId: d.runId,
      evidence: d.evidence,
      flaky: flaky === undefined ? null : ((flaky.data as PayloadOf<'BaseChecked'>).flaky ?? null),
      firstRedSha,
      firstRedAt: first.at,
      key,
      fix,
    },
  }
}
