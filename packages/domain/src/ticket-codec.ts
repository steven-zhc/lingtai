/**
 * A `TicketState`, stored and read back (0124 §1, #833).
 *
 * **The first stored copy of the ticket reduce**, so a change to what
 * `reduceTicketEvent` returns makes stored rows stale. `decodeTicket` therefore
 * refuses a value of another shape, naming the field and the rebuild, and never
 * fills a gap from `emptyTicket`: a gap filled quietly is a projection that
 * disagrees with a replay and says nothing.
 *
 * `bigint` is a string (`lastSeq`), a `Date` an ISO string, and absent and
 * `null` stay apart. The reasons and payload copies inside the state are the
 * event schemas themselves, so a shape is defined once. No registry, no version.
 */
import { z } from 'zod'

import { WaitId } from './action.ts'
import { DiscussionHeld, DispatchRefused, IssueUpdated, ReleaseCause, SplitChild, TriageStartedBy } from './events.ts'
import type { Reducer } from './reducer.ts'
import { emptyTicket, reduceTicketEvent, type TicketState } from './ticket.ts'
import { Resolution, TriageResult, WaitReason } from './wait.ts'

const IsoDate = z.iso.datetime().transform((s) => new Date(s))
const Seq = z.string().regex(/^\d+$/, 'expected a bigint stored as a string of digits')

const Claim = z.strictObject({
  runId: z.string(),
  at: IsoDate,
  ended: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('released'), reason: z.string() }),
      z.strictObject({ kind: z.literal('asked'), reason: WaitReason }),
    ])
    .nullable(),
})

const Wait = z.strictObject({
  waitId: WaitId,
  reason: WaitReason,
  at: IsoDate,
  resolution: z.strictObject({ resolution: Resolution, by: z.string() }).nullable(),
  triage: z.strictObject({
    started: z.strictObject({ attempt: z.number(), at: IsoDate, by: TriageStartedBy }).nullable(),
    result: TriageResult.nullable(),
    headSha: z.string().nullable(),
  }),
  landed: z.strictObject({ mergeCommit: z.string(), base: z.string() }).nullable(),
  closed: z.strictObject({ by: z.string() }).nullable(),
})

const Lifecycle = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('backlog') }),
  z.strictObject({ status: z.literal('claimed'), runId: z.string(), worker: z.string() }),
  z.strictObject({ status: z.literal('blocked'), waitId: WaitId, reason: WaitReason, runId: z.string().nullable() }),
  z.strictObject({ status: z.literal('landed'), mergeCommit: z.string(), base: z.string() }),
  z.strictObject({ status: z.literal('closed'), by: z.string(), reason: z.string() }),
  z.strictObject({
    status: z.literal('approved'),
    runId: z.string(),
    waitId: WaitId,
    onSha: z.string(),
    grantRef: z.string().optional(),
  }),
])

const GitHubWrite = z.strictObject({ outcome: z.enum(['updated', 'failed']), text: z.string() })

const StoredTicket = z.strictObject({
  lifecycle: Lifecycle,
  project: z.string().nullable(),
  source: z.enum(['github-issue', 'manual', 'agent-followup']).nullable(),
  externalRef: z.string().nullable(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  labels: z.array(z.string()),
  links: z.array(z.strictObject({ relation: z.enum(['caused-by', 'follows-up', 'duplicates']), otherRef: z.string() })),
  split: z.strictObject({ waitId: WaitId, children: z.array(SplitChild) }).nullable(),
  dispatchRefusals: z.array(DispatchRefused),
  runs: z.array(z.string()),
  claims: z.array(Claim),
  lastAttemptAt: IsoDate.nullable(),
  since: IsoDate.nullable(),
  lastMove: z
    .strictObject({
      waitId: WaitId,
      resolution: Resolution,
      by: z.string(),
      note: z.string(),
      current: z.boolean(),
      then: z
        .discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('closed'), reason: z.string() }),
          z.strictObject({ kind: z.literal('released'), reason: z.string(), cause: ReleaseCause.nullable() }),
        ])
        .nullable(),
    })
    .nullable(),
  restarts: z.array(z.strictObject({ after: z.string(), restart: z.number() })),
  pendingPrompt: z.strictObject({ text: z.string(), by: z.string() }).nullable(),
  answers: z.array(
    z.strictObject({
      question: z.string().nullable(),
      runId: z.string().nullable(),
      answer: z.string(),
      by: z.string(),
    }),
  ),
  github: z.strictObject({
    last: z.partialRecord(IssueUpdated.shape.change, GitHubWrite),
    labels: z.array(z.string()).nullable(),
    comments: z.array(z.strictObject({ waitId: WaitId, commentId: z.number(), question: z.string() })),
    edited: z.array(WaitId),
    lastWait: WaitId.nullable(),
    bodyAfterWait: WaitId.nullable(),
  }),
  waits: z.array(Wait),
  discussions: z.array(z.strictObject({ chatId: z.string(), outcome: DiscussionHeld.shape.outcome })),
  version: z.number(),
  lastSeq: Seq.transform((s) => BigInt(s)).nullable(),
})

/** Thrown for a stored state that is not a `TicketState` of today's shape. */
export class TicketCodecError extends Error {
  override readonly name = 'TicketCodecError'
}

/** 0124 §1's codec for this reduce. `bigint` as a string, `Date` as ISO, absent and `null` kept apart. */
export function encodeTicket(state: TicketState): string {
  return JSON.stringify(state, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))
}

/** The parse behind both decoders: the state, or what is wrong with the stored value. */
function parseStored(stored: unknown): { ok: true; state: TicketState } | { ok: false; what: string } {
  let value = stored
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored)
    } catch {
      return { ok: false, what: 'not JSON' }
    }
  }
  const parsed = StoredTicket.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    return { ok: false, what: `${issue.path.length === 0 ? 'ticket_state' : issue.path.join('.')}: ${issue.message}` }
  }
  // The reused event schemas are not strict, so a field of another shape inside a reason or a payload copy
  // is stripped by the parse above. Whatever the parse dropped or filled, the stored value no longer equals
  // the state's own encoding, and that is another shape.
  const state = parsed.data as TicketState
  const differs = firstDifference(value, JSON.parse(encodeTicket(state)), 'ticket_state')
  if (differs !== null) return { ok: false, what: `${differs}: not part of today's shape` }
  return { ok: true, state }
}

/**
 * A string (SQLite) or a parsed value (Postgres `jsonb`), back to a `TicketState`.
 * Throws, naming the field and `lingtai projection rebuild <projection>`, on any other shape.
 * `subject` is what the value was stored for (a ticket's stream id), where the caller has one.
 */
export function decodeTicket(stored: unknown, projection: string, subject?: string): TicketState {
  const r = parseStored(stored)
  if (r.ok) return r.state
  throw new TicketCodecError(
    `${projection}${subject === undefined ? '' : ` ${subject}`}: the stored ticket state is not today's shape (${r.what}); ` +
      `run \`lingtai projection rebuild ${projection}\``,
  )
}

/** The ticket reduce as a snapshottable reducer (0124 §1). A snapshot is discarded, not rebuilt, so no remedy is named. */
export const ticketReducer: Reducer<TicketState> = {
  name: 'ticket',
  version: 1,
  initial: emptyTicket,
  reduceEvent: reduceTicketEvent,
  encode: encodeTicket,
  decode: (stored) => {
    const r = parseStored(stored)
    if (r.ok) return r.state
    throw new TicketCodecError(`ticket snapshot: the stored state is not today's shape (${r.what})`)
  },
}

/** The path of the first place two parsed JSON values differ, or `null` for none. Key order is not a difference. */
export function firstDifference(a: unknown, b: unknown, path: string): string | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return path
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}.${i}`)
      if (d !== null) return d
    }
    return null
  }
  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const x = a as Record<string, unknown>
    const y = b as Record<string, unknown>
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      // Own properties only: `key in` and `x[key]` also see `__proto__`, `constructor` and the rest of
      // `Object.prototype`, which would make a stored `"__proto__": {}` look equal to an absent field.
      // `undefined` is absent: JSON never holds it.
      const xv = Object.hasOwn(x, key) ? x[key] : undefined
      const yv = Object.hasOwn(y, key) ? y[key] : undefined
      if (xv === undefined && yv === undefined) continue
      if (xv === undefined || yv === undefined) return `${path}.${key}`
      const d = firstDifference(xv, yv, `${path}.${key}`)
      if (d !== null) return d
    }
    return null
  }
  return Object.is(a, b) ? null : path
}
