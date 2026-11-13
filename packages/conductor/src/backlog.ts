/**
 * Deciding a backlog entry: accept one and the store opens an issue, decline
 * one and that is recorded (`#137`,
 * [0038](../../../doc/decisions-archive/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
 * §5).
 *
 * **Both hosts call these, and nothing else does.** `lingtai backlog` and the
 * board's backlog page are two doors onto the same two functions, because a
 * decision that can only be made in a browser is half a decision (#129, #130).
 *
 * ## Nothing is opened without a person
 *
 * There is no rule here, no threshold and no batch. Each call decides **one**
 * entry, named by its key, and refuses an actor that is not `human:`. Which
 * minors deserve a ticket was deliberately left undecided in code: any rule
 * general enough to write is one whose behaviour nobody can predict, and the
 * judgement is not urgent — which is what a backlog is.
 *
 * ## The decision is the log's; the issue is the store's
 *
 * A finding's decision is its own stream, `bkl-{project}-{key}`, and it is at
 * most two events long: `FindingDeclined`, or `FindingAccepted` then
 * `FindingProposed`. Every append is at the version the stream was read at.
 *
 * **The accept is appended before the store is asked**, at version 0, so a
 * decline or a second accept that races it loses there and opens nothing. After
 * it the entry cannot be declined — a person decided it exists — and what is
 * left is the store's half: opening the issue, which is **safe to repeat and to
 * race**, because `propose` is idempotent on the finding's key. So a failure of
 * any kind — the store did not answer, the answer came after a timeout, the log
 * could not record it, the process died — is answered the same way: open it
 * again. There is no state in which a person has to wait for an accept that
 * may still be running, or find an issue by hand and type its number.
 *
 * Two openers that each wrote an issue converge: the store keeps the older, and
 * if the log has already recorded the other, the one it did not record is
 * withdrawn by the call that wrote it.
 */
import {
  backlogStream,
  type Finding,
  type FindingState,
  type PayloadOf,
  SEVERITIES,
  type Severity,
  parsePayload,
  reduceFinding,
  ticketStream,
} from '@lingtai/domain'
import { ConcurrencyError, type EventStore, eventStore } from '@lingtai/event-store'
import { type BacklogEntry, readBacklog } from '@lingtai/projector'
import { Cause, Effect } from 'effect'

import { asFailure } from './port-face.ts'
import type { ProposedRef, ProposedTicket, TicketStore } from './ticket-store.ts'

/**
 * **Where a severity stops being an opinion and becomes an outcome** (`#237`).
 *
 * A reviewer returns findings with a severity and **no verdict**
 * ([0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md) §3),
 * so something after it has to say what each severity costs. This is that
 * something, and it is one comparison: at or below the bar a finding is
 * **filed**, above it a finding **refuses**.
 *
 * Nothing calls it yet, and that is the same fact `whyNoKindAt` states about
 * the `backlog:` plugin. **The bar today is written twice, and this lifts out
 * both.** `verdictFor` in `packages/actions/src/agent-action.ts` is the half that
 * *refuses* — a hard-coded blocker-or-major, which is `refuses` below —
 * and the literal `minor` in the reducer (`packages/projector/src/backlog.ts`) is
 * the half that *files*, which is `filed`. One comparison in two packages that
 * cannot see each other, and neither of which a recipe can name.
 *
 * So **whoever wires `backlog:` has to hand its value to both**. Replace the
 * reduce's literal alone and a `major` still fails at `verdictFor`, the step still
 * ends refused, the reducer never sees the finding — and a recipe that said a
 * major costs nothing has bought a fix round while reading as honoured. That
 * trap is in `CALLED_DIRECTLY.backlog` (`packages/recipe/src/recipe.ts`) too,
 * because the refusal is what somebody about to wire it actually reads.
 *
 * **Naming a thing is not wiring it** — what is here is the decision, which had
 * to exist before the ticket that makes the recipe file `steps:` could hand it
 * a value.
 *
 * **`buysARound` is the half worth having a name for.** *Filed* and *bought no
 * round* are one fact read twice, not two rules that could disagree: a finding
 * that did not refuse is not a refusal, so nothing downstream is ever asked
 * what to do about it. Measured over 14 days that is 316 of 660 findings at
 * `minor` — and 281 more at `major`, which is what a bar raised one rung would
 * cost or save ([012 §4](../../../doc/experiments/012-where-the-turns-go.md)).
 *
 * **What it deliberately does not do is deduplicate.** The same finding raised
 * in round 2 is the same entry already: `findingKey`
 * (`packages/domain/src/backlog.ts`) is over the ticket, the step, the action,
 * the file and the normalised claim, with no run, round or sha in it, and the
 * reduce writes `on conflict (project, key) do nothing`. A second mechanism here
 * would be a second answer to a question that has one.
 *
 * A decision and no I/O, for `fix.ts`'s reason: a rule about what a severity
 * costs that lives inside an `if` in a reducer is a rule nobody can check.
 */
export interface BacklogOutcome {
  /** At or below the bar: filed for a person, and buying nothing. */
  filed: readonly Finding[]
  /**
   * Above it: these refuse, and a refusal is what may go on to buy a round.
   * `verdictFor` in `packages/actions/src/agent-action.ts` is where that same
   * question is answered today, off its own copy of the bar.
   */
  refuses: readonly Finding[]
  /** `false` when everything is at or below the bar — there is no refusal to buy one with. */
  buysARound: boolean
}

/** Worst first, so *at or below* is `index >= index`. `SEVERITIES` is the one ladder. */
function rung(severity: Severity): number {
  return SEVERITIES.indexOf(severity)
}

export function decideBacklog(findings: readonly Finding[], bar: Severity = 'minor'): BacklogOutcome {
  const filed = findings.filter((f) => rung(f.severity) >= rung(bar))
  const refuses = findings.filter((f) => rung(f.severity) < rung(bar))
  return { filed, refuses, buysARound: refuses.length > 0 }
}

export type BacklogDecision =
  | { ok: true; detail: string; externalRef?: string; url?: string | null }
  | { ok: false; detail: string }

type Decision = Pick<PayloadOf<'FindingAccepted'>, 'kind' | 'labels'>

/** What an accepted entry opens. Pure, so what an issue will say is testable. */
export function proposalFor(entry: BacklogEntry, decision: Decision, since: Date): ProposedTicket {
  const firstLine = entry.claim.trim().split('\n')[0] ?? entry.claim
  const title = firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine
  const where = entry.line === null ? entry.file : `${entry.file}:${entry.line}`
  const body = [
    `A \`${entry.severity}\` finding from a passing \`${entry.step}:${entry.action}\` on #${entry.issue}. ` +
      `It did not stop that run, and a person accepted it from the backlog.`,
    '',
    `**\`${where}\`** — ${entry.claim.trim()}`,
    '',
    '## Failure scenario',
    '',
    entry.failureScenario.trim(),
    '',
    '## Where it came from',
    '',
    `- ticket: #${entry.issue}`,
    `- run: \`${entry.runId}\`, reviewing \`${entry.onSha.slice(0, 12)}\``,
    `- step: \`${entry.step}\`, action \`${entry.action}\``,
    `- finding: \`${entry.key}\` (seq ${entry.raisedSeq})`,
    '',
    '## Done when',
    '',
    '- [ ] the failure scenario above no longer happens, and a test says so',
    '',
  ].join('\n')
  return { key: entry.key, since, title, body, kind: decision.kind, labels: decision.labels }
}

export interface DecideOptions {
  project: string
  key: string
  by: string
  events?: EventStore
  /** The entry, as the backlog has it. Defaults to reading the projection. */
  entry?: (
    project: string,
    key: string,
  ) => Promise<BacklogEntry | undefined> | Effect.Effect<BacklogEntry | undefined, Error>
}

function decidedDetail(key: string, state: FindingState): string {
  if (state.status === 'accepted' && state.proposed) {
    const p = state.proposed
    return `${key} was already accepted — it is ${p.url ?? `#${p.externalRef}`} (seq ${p.seq})`
  }
  if (state.status === 'declined') return `${key} was already decided — FindingDeclined at seq ${state.seq}`
  return `${key} was already decided`
}

const lift = <A>(f: () => Promise<A>): Effect.Effect<A, Error> => Effect.tryPromise({ try: f, catch: asFailure })

/** The whole cause of an effect as a message: a thrown error says nothing about whether a write landed. */
type Caught<A> = { ok: true; value: A } | { ok: false; message: string }
const caught = <A, E>(eff: Effect.Effect<A, E>): Effect.Effect<Caught<A>> =>
  Effect.exit(eff).pipe(
    Effect.flatMap((exit): Effect.Effect<Caught<A>> => {
      if (exit._tag === 'Success') return Effect.succeed({ ok: true as const, value: exit.value })
      if (Cause.hasInterrupts(exit.cause)) return Effect.failCause(exit.cause as Cause.Cause<never>)
      const error = Cause.squash(exit.cause)
      return Effect.succeed({ ok: false as const, message: (error as Error).message })
    }),
  )

const readEntry = (
  options: DecideOptions,
): Effect.Effect<{ entry: BacklogEntry; stream: FindingState; events: EventStore } | string, Error> =>
  Effect.gen(function* () {
    if (!options.by.startsWith('human:')) {
      return `a backlog entry is decided by a person, and ${options.by} is not one`
    }
    const read = options.entry ?? ((project: string, key: string) => readBacklog({ project, key }).then((r) => r[0]))
    const entry = yield* Effect.suspend(() => {
      const got = read(options.project, options.key)
      return Effect.isEffect(got) ? got : lift(() => got)
    })
    if (!entry) return `no backlog entry ${options.key} in ${options.project}`
    const events = options.events ?? eventStore
    // The log settles it, not the projection: a decision a moment old may not be reduced yet.
    const stream = reduceFinding(yield* lift(() => events.read(backlogStream(options.project, options.key))))
    return { entry, stream, events }
  })

/**
 * Accept one entry — or, if it is already accepted and its issue is not
 * recorded, open that issue.
 *
 * `kind` is needed only for the first: an accepted entry opens the ticket its
 * `FindingAccepted` describes, and a different kind typed at a retry is
 * refused rather than silently ignored. `kinds` is the recipe's `source.kinds`:
 * an issue carrying any other kind is one no pass will ever claim.
 */
export function acceptFinding(
  options: DecideOptions & {
    tickets: TicketStore
    kind?: string
    kinds: readonly string[]
    labels?: readonly string[]
  },
): Promise<BacklogDecision> {
  return Effect.runPromise(acceptFindingEffect(options))
}

export function acceptFindingEffect(
  options: DecideOptions & {
    tickets: TicketStore
    kind?: string
    kinds: readonly string[]
    labels?: readonly string[]
  },
): Effect.Effect<BacklogDecision, Error> {
  return Effect.gen(function* () {
    const found = yield* readEntry(options)
    if (typeof found === 'string') return { ok: false, detail: found }
    const { entry, stream, events } = found
    const kind = options.kind?.trim() ?? ''

    if (stream.status === 'declined' || (stream.status === 'accepted' && stream.proposed)) {
      return { ok: false, detail: decidedDetail(options.key, stream) }
    }

    if (stream.status === 'accepted') {
      const d = stream
      if (kind && kind !== d.kind) {
        return {
          ok: false,
          detail:
            `${options.key} was accepted as "${d.kind}" by ${d.by} at seq ${d.seq}, ` +
            `and that is the issue opening it again opens — leave out --kind`,
        }
      }
      return yield* open(options, entry, events, { kind: d.kind, labels: [...d.labels] }, d.at)
    }

    if (!kind) return { ok: false, detail: 'an accepted finding needs a kind' }
    if (!options.kinds.includes(kind)) {
      return {
        ok: false,
        detail:
          `"${kind}" is not one of the recipe's source.kinds (${options.kinds.join(', ') || 'none'}) — ` +
          `an issue of that kind is one the queue never sees`,
      }
    }

    const decision: Decision = { kind, labels: [...(options.labels ?? [])] }
    const since = new Date()
    const appended = yield* lift(() =>
      events.append(backlogStream(options.project, options.key), 0, [
        {
          type: 'FindingAccepted',
          actor: options.by,
          data: parsePayload('FindingAccepted', {
            project: options.project,
            key: options.key,
            by: options.by,
            ...decision,
          }),
        },
      ]),
    ).pipe(
      Effect.as(true),
      Effect.catchIf(
        (err) => err instanceof ConcurrencyError,
        () => Effect.succeed(false),
      ),
    )
    if (!appended) {
      return { ok: false, detail: `another decision about ${options.key} landed first — nothing was opened` }
    }
    return yield* open(options, entry, events, decision, since)
  })
}

/** How to answer any failure after the decision: the same command, again. */
function again(options: DecideOptions): string {
  return `opening it again finds the issue if there is one and opens it if not: lingtai backlog accept ${options.project} ${options.key}`
}

/** The store's half: have the ticket, then record which one it is. */
const open = (
  options: DecideOptions & { tickets: TicketStore },
  entry: BacklogEntry,
  events: EventStore,
  decision: Decision,
  since: Date,
): Effect.Effect<BacklogDecision, Error> =>
  Effect.gen(function* () {
    const streamId = backlogStream(options.project, options.key)
    const proposed = yield* caught(Effect.suspend(() => options.tickets.propose(proposalFor(entry, decision, since))))
    if (!proposed.ok) {
      return {
        ok: false,
        detail:
          `${options.key} is accepted, but the store did not say it has the issue: ${proposed.message}. ` +
          again(options),
      }
    }
    const ref: ProposedRef = proposed.value

    const recorded = yield* Effect.exit(
      lift(() =>
        events.append(streamId, 1, [
          {
            type: 'FindingProposed',
            actor: options.by,
            data: parsePayload('FindingProposed', {
              project: options.project,
              key: options.key,
              by: options.by,
              externalRef: ref.externalRef,
              url: ref.url,
            }),
          },
        ]),
      ),
    )
    if (recorded._tag === 'Failure') {
      if (Cause.hasInterrupts(recorded.cause)) return yield* Effect.failCause(recorded.cause)
      const err = Cause.squash(recorded.cause)
      if (!(err instanceof ConcurrencyError)) {
        return {
          ok: false,
          detail: `${ref.url ?? ref.externalRef} is the issue, but the log did not record it: ${(err as Error).message}. ${again(options)}`,
        }
      }
      return yield* settle(options, events, ref)
    }
    return {
      ok: true,
      detail: `${ref.created ? 'opened' : 'recorded'} ${ref.url ?? ref.externalRef} for ${options.key} (${ticketStream(entry.project, entry.issue)})`,
      externalRef: ref.externalRef,
      url: ref.url,
    }
  })

/**
 * Another opener recorded first. If it recorded a different issue and this call
 * wrote the one it holds, this call withdraws its own — the log names the
 * finding's issue, and nothing it does not name is left open.
 */
const settle = (
  options: DecideOptions & { tickets: TicketStore },
  events: EventStore,
  ref: ProposedRef,
): Effect.Effect<BacklogDecision, Error> =>
  Effect.gen(function* () {
    const state = reduceFinding(yield* lift(() => events.read(backlogStream(options.project, options.key))))
    if (state.status !== 'accepted' || !state.proposed) {
      return {
        ok: false,
        detail: `${options.key} changed while it was being opened — it is ${state.status}`,
      }
    }
    const recorded = state.proposed
    const is = recorded.url ?? `#${recorded.externalRef}`
    // The same issue, or one this call only found: nothing of this call's to withdraw.
    if (recorded.externalRef === ref.externalRef || !ref.created) {
      return { ok: true, detail: `${options.key} is ${is}`, externalRef: recorded.externalRef, url: recorded.url }
    }
    const withdrawn = yield* caught(
      Effect.suspend(() =>
        options.tickets.withdraw(
          ref.externalRef,
          recorded.externalRef,
          `the backlog recorded #${recorded.externalRef} as finding ${options.key}'s issue while this one was being opened`,
        ),
      ),
    )
    if (!withdrawn.ok) {
      return {
        ok: false,
        detail:
          `${options.key} is ${is}, and ${ref.url ?? ref.externalRef} is a duplicate this call opened ` +
          `and could not close: ${withdrawn.message} — close it by hand`,
      }
    }
    return {
      ok: true,
      detail: `${options.key} is ${is}; the duplicate this call opened, ${ref.url ?? ref.externalRef}, is closed`,
      externalRef: recorded.externalRef,
      url: recorded.url,
    }
  })

/**
 * Decline one entry. A reason is required: a decline nobody can explain is asked again.
 *
 * Only an open entry: one already accepted is a ticket a person decided exists,
 * and declining it afterwards would leave an issue the backlog says was refused.
 */
export function declineFinding(options: DecideOptions & { reason: string }): Promise<BacklogDecision> {
  return Effect.runPromise(declineFindingEffect(options))
}

export function declineFindingEffect(
  options: DecideOptions & { reason: string },
): Effect.Effect<BacklogDecision, Error> {
  return Effect.gen(function* () {
    if (!options.reason.trim()) return { ok: false, detail: 'a decline needs a reason' }
    const found = yield* readEntry(options)
    if (typeof found === 'string') return { ok: false, detail: found }
    const { stream, events } = found
    if (stream.status === 'accepted' && !stream.proposed) {
      return {
        ok: false,
        detail: `${options.key} was accepted by ${stream.by} at seq ${stream.seq} — ${again(options)}`,
      }
    }
    if (stream.status !== 'open') return { ok: false, detail: decidedDetail(options.key, stream) }

    const appended = yield* lift(() =>
      events.append(backlogStream(options.project, options.key), 0, [
        {
          type: 'FindingDeclined',
          actor: options.by,
          data: parsePayload('FindingDeclined', {
            project: options.project,
            key: options.key,
            by: options.by,
            reason: options.reason.trim(),
          }),
        },
      ]),
    ).pipe(
      Effect.as(true),
      Effect.catchIf(
        (err) => err instanceof ConcurrencyError,
        () => Effect.succeed(false),
      ),
    )
    if (!appended) return { ok: false, detail: `another decision about ${options.key} landed first` }
    return { ok: true, detail: `declined ${options.key} — it will not be asked again` }
  })
}
