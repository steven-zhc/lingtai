/**
 * What a command that answers a wait prints (0121 §5, #621): one verdict line,
 * the sentence the command always said beneath it, and `next:` only where that
 * sentence already named a command — and the same verdict as the one `--json`
 * document.
 *
 * Pure: the commands return a `Verdict` and the entry prints it, so the layout
 * and the document are tested with no process, no store and no GitHub.
 */
import { paint } from '@lingtai/env/colour'

import { symbol } from './output.ts'

export interface Verdict {
  outcome: 'accepted' | 'refused'
  /** The ticket stream the command acted on, where it got far enough to name one. */
  ticketId?: string
  /** What follows the verb when there is no ticket to name (`now` has none). */
  subject?: string
  /** A refusal's code. Left out, never `null`, where the function that refused names none. */
  reason?: string
  /** The command's own sentence, word for word. */
  detail: string
  /** A command to run next, where the old text already named one. */
  next?: string
  /** Fields only this command has; they are in the document and not in the line. */
  extra?: Record<string, unknown>
}

/** `✓ approved <ticket>` or `✗ not approved (<reason>)`, then the detail indented and `next:`. */
export function renderVerdict(verb: string, v: Verdict): string[] {
  const glyph = v.outcome === 'accepted' ? symbol.pass() : symbol.fail()
  const subject = v.subject ?? v.ticketId
  const head = [
    glyph,
    verb,
    ...(v.reason === undefined ? [] : [`(${v.reason})`]),
    ...(subject ? [paint.muted(subject)] : []),
  ]
  return [
    head.join(' '),
    ...v.detail.split('\n').map((line) => (line === '' ? '' : `  ${line}`)),
    ...(v.next === undefined ? [] : [`  ${paint.muted('next:')} ${v.next}`]),
  ]
}

/** The body of the `--json` document: a refusal is an outcome here, never the `error` document. */
export function verdictJson(v: Verdict): Record<string, unknown> {
  return {
    outcome: v.outcome,
    ...(v.ticketId === undefined ? {} : { ticketId: v.ticketId }),
    ...(v.reason === undefined ? {} : { reason: v.reason }),
    detail: v.detail,
    ...(v.next === undefined ? {} : { next: v.next }),
    ...v.extra,
  }
}

/** What a `<verb>Verdict` resolves to: the exit code the old command returned, and the verdict. */
export interface Answered {
  code: number
  verdict: Verdict
}

/** The verdict line's verb for each command, in the old words. */
export const VERBS = {
  approve: { accepted: 'approved', refused: 'not approved' },
  requeue: { accepted: 'requeued', refused: 'not requeued' },
  'grant-fix-round': { accepted: 'fix round granted', refused: 'fix round refused' },
  close: { accepted: 'closed', refused: 'not closed' },
  ask: { accepted: 'asked', refused: 'not asked' },
  answer: { accepted: 'answered', refused: 'not answered' },
  now: { accepted: 'requested', refused: 'not requested' },
} as const

/** A refusal the CLI itself made, before the conductor was asked. */
export function refusal(code: number, reason: string, detail: string, rest: Partial<Verdict> = {}): Answered {
  return { code, verdict: { outcome: 'refused', reason, detail, ...rest } }
}

/** An `{ ok, ticketId, detail }` outcome, which carries no reason of its own. */
export function fromOutcome(
  outcome: { ok: boolean; ticketId: string; detail: string },
  extra?: Record<string, unknown>,
): Answered {
  return {
    code: outcome.ok ? 0 : 1,
    verdict: {
      outcome: outcome.ok ? 'accepted' : 'refused',
      ticketId: outcome.ticketId,
      detail: outcome.detail,
      ...(extra === undefined ? {} : { extra }),
    },
  }
}

/** Prints a verdict through `log`, as the wrappers that keep the old signatures do. */
export function logVerdict(
  verbs: { accepted: string; refused: string },
  answered: Answered,
  log: (line: string) => void,
): number {
  const verb = answered.verdict.outcome === 'accepted' ? verbs.accepted : verbs.refused
  for (const line of renderVerdict(verb, answered.verdict)) log(line)
  return answered.code
}
