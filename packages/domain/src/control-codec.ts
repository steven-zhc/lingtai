/**
 * A `ControlState`, stored and read back (0124 §1, #867).
 *
 * The control twin of `ticket-codec.ts`, with the same rules (#833): a `Date` is
 * an ISO string, absent and `null` stay apart, and a value of another shape is
 * refused by name rather than filled from `emptyControl`. What to do with a
 * refused snapshot is the reader's, not the codec's.
 */
import { z } from 'zod'

import type { ControlState } from './control.ts'
import { firstDifference } from './ticket-codec.ts'

const IsoDate = z.iso.datetime().transform((s) => new Date(s))

const StoredControl = z.strictObject({
  paused: z.boolean(),
  by: z.string().nullable(),
  reason: z.string().nullable(),
  shutdown: z
    .strictObject({
      by: z.string(),
      reason: z.string(),
      timeoutMs: z.number().nullable(),
      force: z.boolean(),
      version: z.number(),
    })
    .nullable(),
  requested: z.array(z.strictObject({ project: z.string(), issue: z.string(), by: z.string() })),
  continuing: z.array(z.strictObject({ project: z.string(), issue: z.string(), runId: z.string(), by: z.string() })),
  discussions: z.array(
    z.strictObject({
      chatId: z.string(),
      ticketId: z.string(),
      attempt: z.number().nullable(),
      question: z.string(),
      by: z.string(),
    }),
  ),
  dayCeiling: z.strictObject({
    reached: z
      .strictObject({
        day: z.string(),
        reportedUsd: z.number(),
        estimatedUsd: z.number(),
        ceilingUsd: z.number(),
        at: IsoDate,
        seq: z.number(),
      })
      .nullable(),
    raised: z
      .strictObject({ day: z.string(), toUsd: z.number(), fromUsd: z.number().optional(), by: z.string(), at: IsoDate })
      .nullable(),
  }),
})

/** Thrown for a stored state that is not a `ControlState` of today's shape. */
export class ControlCodecError extends Error {
  override readonly name = 'ControlCodecError'
}

export function encodeControl(state: ControlState): string {
  return JSON.stringify(state, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))
}

/** A string or a parsed value back to a `ControlState`; throws `ControlCodecError`, naming the field, on any other shape. */
export function decodeControl(stored: unknown): ControlState {
  const refuse = (what: string): never => {
    throw new ControlCodecError(`control: the stored state is not today's shape (${what})`)
  }
  let value = stored
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored)
    } catch {
      return refuse('not JSON')
    }
  }
  const parsed = StoredControl.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    return refuse(`${issue.path.length === 0 ? 'control_state' : issue.path.join('.')}: ${issue.message}`)
  }
  const state = parsed.data as ControlState
  const differs = firstDifference(value, JSON.parse(encodeControl(state)), 'control_state')
  if (differs !== null) return refuse(`${differs}: not part of today's shape`)
  return state
}
