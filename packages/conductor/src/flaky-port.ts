/**
 * **The reads behind a red then green** (0108 §17, #1222): what a `run:` check's second run hands the decision.
 *
 * The decision is `flakyVerdict` in the domain and is pure; this is the IO around it, as Effects whose failures
 * are values. A read that fails is `null` to the verdict, and a `null` is red — never *not flaky*.
 */
import type { FlakyPort } from '@lingtai/actions'
import { type BacklogRow, type BaseRecord, flakyVerdict } from '@lingtai/domain'
import { failingTestsOf } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { Effect, Result } from 'effect'

export interface FlakyReads {
  /** The project's integration stream, where `BaseChecked` is appended. */
  readonly store: Pick<EventStore, 'read'>
  readonly stream: string
  /** The paths this ticket's diff changes; null (or a failure) when it could not be read. */
  readonly diffPaths: () => Effect.Effect<readonly string[] | null, unknown>
  /** Every backlog row of the project, in every status. */
  readonly backlog: () => Effect.Effect<readonly BacklogRow[], unknown>
  /** The head sha; absent when it could not be read. */
  readonly head: () => Effect.Effect<string | undefined, unknown>
}

const orNull = <A>(read: Effect.Effect<A, unknown>): Effect.Effect<A | null> =>
  Effect.map(Effect.result(read), (r) => (Result.isSuccess(r) ? r.success : null))

export function flakyPortOf(reads: FlakyReads): FlakyPort {
  return (ask) =>
    Effect.gen(function* () {
      const first = ask.first.evidence
      // The tests are named first: when they cannot be, nothing else is read.
      const named = failingTestsOf(first) !== null
      const diffPaths = named ? yield* orNull(reads.diffPaths()) : null
      const records = named
        ? yield* orNull(
            Effect.map(
              Effect.tryPromise({ try: () => reads.store.read(reads.stream), catch: (e) => e }),
              (events): BaseRecord[] =>
                events.flatMap((event) => {
                  if (event.type !== 'BaseChecked') return []
                  const d = event.data as {
                    baseSha?: string
                    command?: string
                    ok?: boolean
                    evidence?: string
                    flaky?: string[]
                  }
                  if (d.command !== ask.command) return []
                  return [{ sha: d.baseSha ?? '', ok: d.ok === true, evidence: d.evidence ?? '', flaky: d.flaky }]
                }),
            ),
          )
        : null
      const backlog = named ? yield* orNull(reads.backlog()) : null
      const head = named ? ((yield* orNull(reads.head())) ?? undefined) : undefined
      const verdict = flakyVerdict({
        command: ask.command,
        first,
        diffPaths,
        diffWhy: diffPaths === null ? 'git diff failed or the pass has no base commit' : undefined,
        baseRecords: records,
        backlog,
        head,
      })
      return verdict
    })
}
