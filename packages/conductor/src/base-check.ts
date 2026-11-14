import { createHash } from 'node:crypto'

/**
 * **What a check says on the commit a pass was cut at** (#743, 0108 §13) — the
 * port the guard in #744 asks before a `build` refusal buys a round.
 * `conduct.ts` builds one per store and `runAttempt` asks it through `baseIsRed`.
 *
 * It answers from the log when a `BaseChecked` for this commit, this
 * command and this boundary is already on `int-<project>-<base>`, and otherwise cuts a throwaway
 * worktree *detached at the sha*, runs `prepared`'s `run:` commands and then
 * the command once, and appends what it said. `provisionWorktree`'s `at` is not
 * used: it refuses a sha that is not on the ticket's own branch, and a base
 * commit never is.
 *
 * - **Only a command that ran to an exit code is recorded.** A timeout, an
 *   abort, a failed cut, a failed install or a failed read is `unknown` and is
 *   never appended: a cached `red` holds every later ticket on that commit, so
 *   a flake recorded as `red` would hold them all until the base moves.
 * - **One run per `(stream, baseSha, command, fingerprint)` in flight.** Two passes in one
 *   conductor (0102) share the promise. It runs on the *first* asker's `signal`
 *   and `runId`: if that pass is aborted the second asker also gets `unknown`,
 *   nothing is appended, and its next ask runs it again. That is deliberate.
 * - **The stream has other writers** (the merge lane, `integrate.ts`), so the
 *   append is at the version just read and retries on a lost race, bounded.
 *   A failed append is noted and the answer is still returned; `conduct.ts`'s
 *   `appendNow` is not used because it turns a failure into a defect.
 * - The key is the commit, the `run:` text exactly, and the **boundary** it ran under (0108 §13, 0127 §15):
 *   `unsandboxed`, or the fingerprint of the sandbox policy. An answer recorded under one boundary never
 *   answers a question asked under another, and an event with no `boundary` is `unsandboxed`. The install
 *   command, env and timeout are not in it.
 * - **A sandboxed question reads the operator's profile once per command, after the cut**, and the same
 *   value is fingerprinted and handed to the wrap: nothing on a command's path reads it twice. So the
 *   in-flight key carries only the fingerprint *before* any profile (it cannot name the profile without
 *   the tree), and the recorded boundary is the one the profile read made.
 * - A wrap that fails is an outcome with no exit code, which is `unknown` and recorded nowhere: a host that
 *   could not wrap says nothing about the commit, and a command is never spawned unwrapped instead.
 */
import {
  type CommandOutcome,
  type OperatorProfile,
  type RunCommandOptions,
  type RunSandbox,
  boundedEvidence,
  wrapRefusal,
} from '@lingtai/actions'
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
  /**
   * The wrap the commands go through, closed over the asking pass's own project, mirror and decision. Per ask
   * for the same reason as `tree`. Absent is *unsandboxed*: the commands spawn as they always have.
   */
  sandbox?: RunSandbox
}

/** The boundary of a command that ran with no sandbox, and what an event with no `boundary` reads as. */
export const UNSANDBOXED = 'unsandboxed'

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

  /** The log's answer for this commit, command and boundary; `undefined` is a miss. */
  function lookup(
    q: BaseCheckQuestion,
    stream: string,
    boundary: string,
  ): Effect.Effect<BaseCheckAnswer | undefined, unknown> {
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
          boundary?: string
          ok?: boolean
          exitCode?: number
          evidence?: string
        }
        if (data.baseSha !== q.baseSha || data.command !== q.command) continue
        if ((data.boundary ?? UNSANDBOXED) !== boundary) continue
        return data.ok
          ? answered({ verdict: 'green', exitCode: 0, from: 'log' })
          : answered({ verdict: 'red', exitCode: data.exitCode ?? 1, evidence: data.evidence ?? '', from: 'log' })
      }
      return undefined
    })
  }

  function check(q: BaseCheckQuestion, stream: string, path: string): Effect.Effect<BaseCheckAnswer, unknown> {
    return Effect.gen(function* () {
      const sandbox = q.sandbox
      // Unsandboxed, the boundary is known before anything is cut, so a hit costs nothing.
      if (sandbox === undefined) {
        const hit = yield* lookup(q, stream, UNSANDBOXED)
        if (hit !== undefined) return hit
      }

      const ran = yield* Effect.gen(function* () {
        const cut = yield* Effect.result(attempt(() => q.tree.cut(path, q.baseSha)))
        if (Result.isFailure(cut)) {
          return {
            answer: unknownWith(`the worktree could not be cut at ${q.baseSha}: ${(cut.failure as Error).message}`),
          } as const
        }
        const commands: BaseCheckCommand[] = [...q.prepared, { run: q.command, env: q.env, timeoutMs: q.timeoutMs }]
        // Sandboxed: the operator's profile is read here, once per command, in the tree it will be read from
        // by nothing else. The boundary is made from these values and the wrap is handed these same values.
        let boundary = UNSANDBOXED
        const profiles: OperatorProfile[] = []
        if (sandbox !== undefined) {
          for (const c of commands) profiles.push(sandbox.profile(path, c.env))
          const refused = profiles.find((p) => !p.ok)
          if (refused !== undefined && !refused.ok) {
            return {
              answer: unknownWith(`the sandbox would not wrap the base check: ${refused.refusal.sentence}`),
            } as const
          }
          for (const p of profiles) if (p.ok && p.note !== undefined) deps.note(`base check: ${p.note}`)
          const fps = profiles.map((p) => sandbox.fingerprint(path, p))
          boundary = fps.every((f) => f === fps[0])
            ? (fps[0] as string)
            : createHash('sha256').update(JSON.stringify(fps)).digest('hex')
          const hit = yield* lookup(q, stream, boundary)
          if (hit !== undefined) return { answer: hit } as const
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
        const spawn = (
          c: BaseCheckCommand,
          wrapped?: { argv: readonly string[]; env: Readonly<Record<string, string>> },
        ) =>
          deps.run({
            run: c.run,
            timeoutMs: c.timeoutMs,
            cwd: path,
            env: c.env,
            signal: q.signal,
            ownGroup: true,
            ...(wrapped === undefined ? {} : { wrapped }),
          })
        const runIn = (c: BaseCheckCommand, i: number): Effect.Effect<CommandOutcome, unknown> => {
          if (sandbox === undefined) return spawn(c)
          // The scope encloses the command: closing it cleans srt up, which must not happen under a running child.
          return Effect.scoped(
            Effect.gen(function* () {
              const wrapped = yield* Effect.result(
                sandbox.wrap(['/bin/sh', '-c', c.run], path, c.env, profiles[i] as OperatorProfile),
              )
              if (Result.isFailure(wrapped)) {
                return {
                  ok: false,
                  exitCode: null,
                  timedOut: false,
                  durationMs: 0,
                  evidence: wrapRefusal(c.run, wrapped.failure),
                }
              }
              // The wrap is awaited, and `runCommand` only hears an abort that comes after it starts.
              if (q.signal.aborted) {
                return { ok: false, exitCode: null, timedOut: false, durationMs: 0, evidence: 'the check was aborted' }
              }
              return yield* spawn(c, { argv: wrapped.success.argv, env: wrapped.success.env })
            }),
          )
        }
        for (const [i, prep] of q.prepared.entries()) {
          const prepared = yield* runIn(prep, i)
          if (q.signal.aborted) return { answer: unknownWith('the check was aborted') } as const
          if (prepared.timedOut || prepared.exitCode !== 0) {
            return { answer: unknownWith(`\`${prep.run}\` did not succeed: ${prepared.evidence}`) } as const
          }
        }
        const outcome = yield* runIn(commands[commands.length - 1] as BaseCheckCommand, commands.length - 1)
        return { outcome, boundary } as const
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
        boundary: ran.boundary,
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
        const path = deps.worktreePath(q.project, q.baseSha.slice(0, 7), q.runId)
        // The fingerprint before any profile: it reads nothing, and it is the same for every ask of one policy.
        let fingerprint = UNSANDBOXED
        try {
          if (q.sandbox !== undefined) fingerprint = q.sandbox.fingerprint(path)
        } catch (defect) {
          return Effect.succeed(
            unknownWith(`the sandbox policy could not be fingerprinted: ${(defect as Error).message}`),
          )
        }
        const key = JSON.stringify([stream, q.baseSha, q.command, fingerprint])
        const shared = inFlight.get(key)
        if (shared) return Fiber.join(shared)
        const running = check(q, stream, path).pipe(
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
