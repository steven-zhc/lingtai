/**
 * **What a check says on the commit a pass was cut at** (#743, 0108 §13) — the
 * port the guard in #744 asks before a `build` refusal buys a round.
 * `conduct.ts` builds one per store and `runAttempt` asks it through `baseIsRed`.
 *
 * It answers from the log when a `BaseChecked` for this commit and this
 * command is already on `int-<project>-<base>`, and otherwise cuts a throwaway
 * worktree *detached at the sha*, runs `prepared`'s `run:` commands and then
 * the command once, and appends what it said. `provisionWorktree`'s `at` is not
 * used: it refuses a sha that is not on the ticket's own branch, and a base
 * commit never is.
 *
 * - **Only a command that ran to an exit code is recorded.** A timeout, an
 *   abort, a failed cut, a failed install or a failed read is `unknown` and is
 *   never appended: a cached `red` holds every later ticket on that commit, so
 *   a flake recorded as `red` would hold them all until the base moves.
 * - **One run per `(stream, baseSha, command)` in flight.** Two passes in one
 *   conductor (0102) share the promise. It runs on the *first* asker's `signal`
 *   and `runId`: if that pass is aborted the second asker also gets `unknown`,
 *   nothing is appended, and its next ask runs it again. That is deliberate.
 * - **The stream has other writers** (the merge lane, `integrate.ts`), so the
 *   append is at the version just read and retries on a lost race, bounded.
 *   A failed append is noted and the answer is still returned; `conduct.ts`'s
 *   `appendNow` is not used because it turns a failure into a defect.
 * - The key is the `run:` text exactly. The install command, env and timeout
 *   are not in it (0108 §13 as decided).
 */
import { type CommandOutcome, type RunCommandOptions, boundedEvidence } from '@lingtai/actions'
import { integrationStream, parsePayload } from '@lingtai/domain'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import { Effect, Fiber, Result } from 'effect'

export interface BaseCheckQuestion {
  project: string
  /** The branch, e.g. `main`. */
  base: string
  /** The full sha `rev-parse` gave. */
  baseSha: string
  /** The `run:` text to check. */
  command: string
  /** The `run:` actions of `prepared`, in order, each with its own env and timeout. */
  prepared: readonly BaseCheckCommand[]
  /** The environment the commands get — already resolved by the caller. */
  env: Record<string, string>
  runId: string
  signal: AbortSignal
  timeoutMs: number
  /**
   * The git and filesystem work of one cut. Per ask and not per instance: the instance is shared
   * by every pass in a conductor (#744), and the clone to cut from and the env file to plant are
   * the asking pass's own.
   */
  tree: BaseCheckTree
}

export interface BaseCheckCommand {
  run: string
  env: Record<string, string>
  timeoutMs: number
}

export interface BaseCheckTree {
  /** `git worktree add --force --detach <path> <sha>`. */
  cut: (path: string, sha: string) => Promise<void>
  remove: (path: string) => Promise<void>
  /** Plants the env file in the cut. */
  plant: (path: string) => Promise<void>
}

export type BaseCheckAnswer =
  | { verdict: 'green'; exitCode: 0; from: 'log' | 'ran' }
  | { verdict: 'red'; exitCode: number; evidence: string; from: 'log' | 'ran' }
  | { verdict: 'unknown'; why: string }

export interface BaseCheckDeps {
  store: Pick<EventStore, 'read' | 'append'>
  run: (options: RunCommandOptions) => Effect.Effect<CommandOutcome, unknown>
  worktreePath: (project: string, sha7: string, runId: string) => string
  /** The run-log line for a failed append or removal. */
  note: (line: string) => void
}

const ATTEMPTS = 8

/** A port's promise as an Effect whose failure is whatever it rejected with. */
const attempt = <A>(call: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: () => call(), catch: (error) => error })

const answered = (answer: BaseCheckAnswer): BaseCheckAnswer => answer

const unknownWith = (why: string): BaseCheckAnswer => ({ verdict: 'unknown', why })

export function createBaseCheck(deps: BaseCheckDeps): {
  ask: (q: BaseCheckQuestion) => Effect.Effect<BaseCheckAnswer>
} {
  // Fibers, not Effects: two passes asking one question join one run (#744). They are
  // detached, so the run goes on to the end whoever stops waiting for it — a pass
  // interrupted mid-check must not take the answer, or the cut worktree's removal, with it.
  const inFlight = new Map<string, Fiber.Fiber<BaseCheckAnswer>>()

  function check(q: BaseCheckQuestion, stream: string): Effect.Effect<BaseCheckAnswer, unknown> {
    return Effect.gen(function* () {
      const read = yield* Effect.result(attempt(() => deps.store.read(stream)))
      if (Result.isFailure(read)) {
        return unknownWith(`the log could not be read: ${(read.failure as Error).message}`)
      }
      for (const event of [...read.success].reverse()) {
        if (event.type !== 'BaseChecked') continue
        const data = event.data as {
          baseSha?: string
          command?: string
          ok?: boolean
          exitCode?: number
          evidence?: string
        }
        if (data.baseSha !== q.baseSha || data.command !== q.command) continue
        return data.ok
          ? answered({ verdict: 'green', exitCode: 0, from: 'log' })
          : answered({ verdict: 'red', exitCode: data.exitCode ?? 1, evidence: data.evidence ?? '', from: 'log' })
      }

      const path = deps.worktreePath(q.project, q.baseSha.slice(0, 7), q.runId)
      const ran = yield* Effect.gen(function* () {
        const cut = yield* Effect.result(attempt(() => q.tree.cut(path, q.baseSha)))
        if (Result.isFailure(cut)) {
          return {
            answer: unknownWith(`the worktree could not be cut at ${q.baseSha}: ${(cut.failure as Error).message}`),
          } as const
        }
        const planted = yield* Effect.result(attempt(() => q.tree.plant(path)))
        if (Result.isFailure(planted)) {
          return {
            answer: unknownWith(`the env file could not be planted: ${(planted.failure as Error).message}`),
          } as const
        }
        // An abort that landed while the cut or the plant was pending: `runCommand` only hears
        // aborts that come after it starts, so nothing may be started with the signal already down.
        if (q.signal.aborted) return { answer: unknownWith('the check was aborted') } as const
        const runIn = (c: BaseCheckCommand): Effect.Effect<CommandOutcome, unknown> =>
          deps.run({
            run: c.run,
            timeoutMs: c.timeoutMs,
            cwd: path,
            env: c.env,
            signal: q.signal,
            ownGroup: true,
          })
        for (const prep of q.prepared) {
          const prepared = yield* runIn(prep)
          if (q.signal.aborted) return { answer: unknownWith('the check was aborted') } as const
          if (prepared.timedOut || prepared.exitCode !== 0) {
            return { answer: unknownWith(`\`${prep.run}\` did not succeed: ${prepared.evidence}`) } as const
          }
        }
        const outcome = yield* runIn({ run: q.command, env: q.env, timeoutMs: q.timeoutMs })
        return { outcome } as const
      }).pipe(
        Effect.ensuring(
          attempt(() => q.tree.remove(path)).pipe(
            Effect.catch((err) =>
              Effect.sync(() => {
                deps.note(
                  `base check: could not remove ${path}: ${(err as Error).message} — it may hold the planted env file`,
                )
              }),
            ),
          ),
        ),
      )
      if (ran.outcome === undefined) return ran.answer
      const outcome = ran.outcome

      if (q.signal.aborted) return unknownWith('the check was aborted')
      if (outcome.timedOut || outcome.exitCode === null) {
        return unknownWith(`\`${q.command}\` did not run to an exit code: ${outcome.evidence}`)
      }
      const ok = outcome.exitCode === 0
      const evidence = ok ? '' : boundedEvidence(outcome.evidence)
      const data = {
        base: q.base,
        baseSha: q.baseSha,
        command: q.command,
        ok,
        exitCode: outcome.exitCode,
        durationMs: Math.max(0, Math.round(outcome.durationMs)),
        evidence,
        runId: q.runId,
      }
      const recorded = yield* Effect.result(record(stream, data).pipe(Effect.catchDefect((d) => Effect.fail(d))))
      if (Result.isFailure(recorded)) {
        deps.note(`base check: could not record BaseChecked on ${stream}: ${(recorded.failure as Error).message}`)
      }
      return ok
        ? answered({ verdict: 'green', exitCode: 0, from: 'ran' })
        : answered({ verdict: 'red', exitCode: outcome.exitCode, evidence, from: 'ran' })
    })
  }

  function record(stream: string, data: unknown): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
      for (let attemptNo = 0; attemptNo < ATTEMPTS; attemptNo++) {
        const at = (yield* attempt(() => deps.store.read(stream))).length
        const appended = yield* Effect.result(
          attempt(() =>
            deps.store.append(stream, at, [
              { type: 'BaseChecked', actor: 'conductor', data: parsePayload('BaseChecked', data) },
            ]),
          ),
        )
        if (Result.isSuccess(appended)) return
        if (!(appended.failure instanceof ConcurrencyError)) return yield* Effect.fail(appended.failure)
        yield* Effect.sleep(20 * (attemptNo + 1))
      }
      return yield* Effect.fail(new Error(`could not record BaseChecked on ${stream} after ${ATTEMPTS} attempts`))
    })
  }

  return {
    ask(q) {
      return Effect.suspend(() => {
        const stream = integrationStream(q.project, q.base)
        const key = JSON.stringify([stream, q.baseSha, q.command])
        const shared = inFlight.get(key)
        if (shared) return Fiber.join(shared)
        const running = check(q, stream).pipe(
          // A throw anywhere in the run is an answer of *unknown*, never a failed ask.
          Effect.catchDefect((defect) => Effect.fail(defect)),
          Effect.catch((err) => Effect.succeed(unknownWith((err as Error).message))),
          Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
        )
        return Effect.forkDetach(running).pipe(
          Effect.tap((fiber) => Effect.sync(() => inFlight.set(key, fiber))),
          Effect.flatMap(Fiber.join),
        )
      })
    },
  }
}
