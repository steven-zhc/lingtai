/**
 * The one ticket that makes a red base green (#1266, 0108 §13).
 *
 * Every `BaseRed` release asks `proposeBaseFix` once, after it has released. A recorded red is already red
 * twice (a rerun can only turn a red into a green, `base-check.ts`), so *red twice* needs no check here: what
 * decides is whether the log already names a ticket for the **first red commit since the last green**, so a
 * base that stays red over three commits is one ticket, and red-green-red is two.
 *
 * The door is `TicketStore.propose` (idempotent on the key); the record is `BaseFixProposed` on the base's
 * own stream. That stream has other writers (the merge lane, base checks), so a lost append is *usually*
 * something unrelated: it is read again, and only a record for this key settles it. A failure never holds
 * the release: it is said, and the next red release asks again.
 */
import { baseStateOf, integrationStream, parsePayload, type Envelope } from '@lingtai/domain'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import type { Recipe } from '@lingtai/recipe'
import { kindsOf } from '@lingtai/recipe/settings'
import { Effect, Result } from 'effect'

import { buildRunsOf } from './base-red.ts'
import type { ProposedRef, TicketStore } from './ticket-store.ts'

const ATTEMPTS = 5

const whyOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The body of the ticket: the house shape, written to be worked from. */
export function baseFixBody(input: {
  base: string
  command: string
  baseSha: string
  firstRedSha: string
  boundary: string
  evidence: string
  flaky: readonly string[] | null
}): string {
  return [
    '| | |',
    '|---|---|',
    `| **Problem** | \`${input.command}\` fails on \`${input.base}\`, so Lingtai passes every other ticket of the project over until it is green. |`,
    `| **Want** | \`${input.command}\` exits 0 on \`${input.base}\`. |`,
    '| **Fix** | Find what the failing output below names and fix that, in the smallest change. |',
    "| **Watch out** | A red base is this ticket's subject, not a reason to skip it: if the failure is the environment rather than the code, say so rather than weakening the check. |",
    '',
    '---',
    '',
    '## Evidence',
    '',
    `- First red commit: \`${input.firstRedSha}\``,
    `- Red on: \`${input.baseSha}\` (\`${input.base}\`)`,
    `- Command: \`${input.command}\``,
    `- Boundary: \`${input.boundary}\``,
    ...(input.flaky === null || input.flaky.length === 0
      ? []
      : [`- Failed once and passed on a rerun earlier: ${input.flaky.map((n) => `\`${n}\``).join(', ')}`]),
    '',
    '```',
    input.evidence,
    '```',
    '',
    '## Done when',
    '',
    `- [ ] \`${input.command}\` exits 0 on \`${input.base}\``,
    '- [ ] `pnpm typecheck` and `HOME=/nonexistent pnpm test` are green',
    '',
  ].join('\n')
}

/**
 * Proposes the base-fix ticket for the base's current red, unless the log already names one. Never fails:
 * anything that goes wrong is said through `note` and the caller carries on.
 */
export const proposeBaseFix = (options: {
  store: Pick<EventStore, 'read' | 'append'>
  tickets: TicketStore
  project: string
  base: string
  recipe: Recipe
  note: (message: string) => void
}): Effect.Effect<void> => {
  const { store, tickets, project, base, note } = options
  const stream = integrationStream(project, base)
  const read = Effect.tryPromise({ try: () => store.read(stream), catch: whyOf })
  const stateOf = (events: readonly Envelope[]) => baseStateOf(events, () => buildRunsOf(options.recipe))

  let opened: ProposedRef | null = null
  return Effect.gen(function* () {
    const events = yield* read
    const state = stateOf(events)
    if (!('red' in state) || state.red.fix !== null) return
    const red = state.red

    const ref: ProposedRef = yield* tickets.propose({
      key: red.key,
      since: red.firstRedAt,
      title: `fix(base): ${red.command} is green on ${base} again`,
      body: baseFixBody({
        base,
        command: red.command,
        baseSha: red.baseSha,
        firstRedSha: red.firstRedSha,
        boundary: red.boundary,
        evidence: red.evidence,
        flaky: red.flaky,
      }),
      kind: kindsOf(options.recipe)[0] ?? 'bug',
      labels: [],
    })
    opened = ref

    for (let attemptNo = 0; attemptNo < ATTEMPTS; attemptNo++) {
      const now = yield* read
      const named = stateOf(now)
      if ('red' in named && named.red.key === red.key && named.red.fix !== null) {
        // Another opener recorded first: keep what the log names, and close our own duplicate.
        const kept = named.red.fix.externalRef
        if (ref.created && kept !== ref.externalRef) {
          yield* tickets.withdraw(
            ref.externalRef,
            kept,
            `the log recorded #${kept} as the ticket for ${red.key} while this one was being opened`,
          )
        }
        return
      }
      const appended = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            store.append(stream, now.length, [
              {
                type: 'BaseFixProposed',
                actor: 'conductor',
                data: parsePayload('BaseFixProposed', {
                  project,
                  base,
                  baseSha: red.baseSha,
                  key: red.key,
                  externalRef: ref.externalRef,
                  url: ref.url,
                }),
              },
            ]),
          catch: (error) => error,
        }),
      )
      if (Result.isSuccess(appended)) {
        note(`base: opened ${ref.url ?? `#${ref.externalRef}`} to make ${base} green (${red.key})`)
        return
      }
      if (!(appended.failure instanceof ConcurrencyError)) return yield* Effect.fail(whyOf(appended.failure))
    }
    return yield* Effect.fail(`could not record BaseFixProposed on ${stream} after ${ATTEMPTS} attempts`)
  }).pipe(
    Effect.result,
    Effect.catchDefect((defect) => Effect.succeed(Result.fail(defect))),
    Effect.map((outcome) => {
      if (Result.isSuccess(outcome)) return
      const made = opened as ProposedRef | null
      note(
        made === null
          ? `base: no ticket was opened to make ${base} green — ${whyOf(outcome.failure)}; asked again on the next red release`
          : `base: ${made.url ?? `#${made.externalRef}`} was opened to make ${base} green, but it was not fully settled — ${whyOf(outcome.failure)}; asked again on the next red release`,
      )
    }),
  )
}
