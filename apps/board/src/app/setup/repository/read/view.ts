/**
 * A `Proposal` as the plain `ReadView` the form starts from (#971). Server
 * side: it may import values; the form may not.
 */
import { everyRuntime } from '@lingtai/agent'
import { localTicketsOf } from '@lingtai/conductor/add-from-page'
import { LIMIT_DEFAULTS } from '@lingtai/recipe'
import {
  LINGTAI_BASE,
  SANDBOX_OFF_LINE,
  sandboxCannotSentence,
  type Line,
  type Proposal,
  type SetupTarget,
} from '@lingtai/setup'

import type { CheckView, LineView, ReadView } from './read-model.ts'

const lineOf = <T, U>(line: Line<T>, pick: (v: T) => U, fallback: U): LineView<U> =>
  line.known
    ? { value: pick(line.value), note: line.because, known: true }
    : { value: fallback, note: `could not be read: ${line.reason}`, known: false }

export function viewOf(proposal: Proposal, project: string, remote: string | null): ReadView {
  const local = proposal.target.kind === 'local'
  const detected = proposal.detected.known ? proposal.detected.value : null
  const checks: CheckView[] =
    detected === null
      ? []
      : [
          ...detected.build.map((b) => ({ name: b.name, run: b.run, ticked: true, why: b.because })),
          ...(detected.others ?? []).map((o) => ({
            name: o.script,
            run: o.run,
            ticked: false,
            why: 'a script the repository defines',
          })),
          ...detected.skipped.map((s) => ({
            name: s.script,
            run: s.run ?? s.script,
            ticked: false,
            why: s.why,
          })),
        ]
  const tickets = lineOf(proposal.tickets, (t) => t.source, 'db' as const)
  const ownerless = local ? localTicketsOf(proposal) : null
  return {
    project,
    target: proposal.target,
    remote,
    base: lineOf(proposal.base, (b) => b ?? '', ''),
    install: lineOf(proposal.install, (i) => i ?? '', ''),
    stack: lineOf(proposal.stack, (s) => s.notes, []),
    checks:
      proposal.checks.known || proposal.detected.known
        ? { value: checks, note: proposal.checks.known ? proposal.checks.because : '', known: true }
        : { value: [], note: `could not be read: ${proposal.checks.reason}`, known: false },
    runtimes: proposal.runtimes.known
      ? proposal.runtimes.value.map((r) => ({
          id: r.id,
          signedIn: r.signedIn,
          remedy: r.remedy,
          noTurnCeiling: noTurnCeiling(r.id),
        }))
      : [],
    writer: lineOf(proposal.writer, (w) => w ?? '', ''),
    reviewer: lineOf(proposal.reviewer, (w) => w ?? 'none', 'none'),
    tickets: ownerless === null ? tickets : { value: 'db', note: ownerless.because, known: tickets.known },
    githubOff: local ? 'a local directory has no owner, so it cannot take GitHub issues yet (#977)' : null,
    ticketsLocked: proposal.tickets.known && proposal.tickets.because.startsWith('kept:'),
    kinds: lineOf(proposal.kinds, (k) => k, []),
    heldBy: lineOf(proposal.heldBy, (h) => h ?? '', ''),
    end: lineOf(proposal.end, (e) => e.length > 0, false),
    limits: {
      turns: proposal.limits.known ? proposal.limits.value.turns : LIMIT_DEFAULTS.turns,
      wall: proposal.limits.known ? proposal.limits.value.wall : LIMIT_DEFAULTS.wall,
      rounds: proposal.limits.known ? proposal.limits.value.rounds : LIMIT_DEFAULTS.rounds,
      restarts: LIMIT_DEFAULTS.restarts,
    },
    sandbox:
      proposal.sandbox === null
        ? null
        : {
            builtIns: [...proposal.sandbox.builtIns],
            cannot: sandboxCannotSentence(proposal.sandbox),
            offLine: SANDBOX_OFF_LINE,
          },
  }
}

const noTurnCeiling = (id: string): boolean =>
  everyRuntime().some((r) => r.capabilities.id === id && !r.capabilities.enforces.includes('turns'))

/**
 * The form when nothing could be read at all (a timeout, a key that would not
 * load): every line says so and starts empty, and Add is still possible.
 */
export function emptyView(target: SetupTarget, project: string, remote: string | null, reason: string): ReadView {
  const local = target.kind === 'local'
  const note = `could not be read: ${reason}`
  const unread = <T>(value: T) => ({ value, note, known: false })
  return {
    project,
    target,
    remote,
    base: unread(local ? LINGTAI_BASE : ''),
    install: unread(''),
    stack: unread([]),
    checks: unread([]),
    runtimes: [],
    writer: unread(''),
    reviewer: unread('none'),
    tickets: unread<ReadView['tickets']['value']>(local ? 'db' : 'github'),
    githubOff: local ? 'a local directory has no owner, so it cannot take GitHub issues yet (#977)' : null,
    ticketsLocked: false,
    kinds: { value: ['bug', 'feature', 'tech-debt', 'documentation'], note: '', known: true },
    heldBy: unread(''),
    end: unread(false),
    limits: { ...LIMIT_DEFAULTS },
    sandbox: null,
  }
}
