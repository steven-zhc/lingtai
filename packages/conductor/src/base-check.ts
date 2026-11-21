import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * **What a check says on the commit a pass was cut at** (#743, 0108 §13) — the
 * port the guard in #744 asks before a `build` refusal buys a round.
 * `conduct.ts` builds one per store and `runAttempt` asks it through `baseIsRed`. The question
 * is built by `baseCheckQuestion` below, which needs a project and its recipe and no attempt: a
 * pass is one caller of it.
 *
 * It answers from the log when a `BaseChecked` for this commit, this
 * command and this boundary is already on `int-<project>-<base>`, and otherwise cuts a throwaway
 * worktree *detached at the sha*, runs `prepared`'s `run:` commands and then
 * the command, and appends what it said. `provisionWorktree`'s `at` is not
 * used: it refuses a sha that is not on the ticket's own branch, and a base
 * commit never is.
 *
 * - **Only a command that ran to an exit code is recorded.** A timeout, an
 *   abort, a failed cut, a failed install or a failed read is `unknown` and is
 *   never appended: a cached `red` holds every later ticket on that commit, so
 *   a flake recorded as `red` would hold them all until the base moves.
 * - **A non-zero exit is run once more, at once, in the same tree** (0108 §17, #1207); `prepared` is not.
 *   The rerun can only turn a red into a green, never produce a red: red twice records the second run's
 *   evidence, red then green records green with the first run's failing tests as `flaky`, and a second run
 *   with no exit code is `unknown`, never the first run's red.
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
  commandEffect,
  wrapRefusal,
} from '@lingtai/actions'
import { extensionEnv, productionPatterns, renderEnvFile, runnableEnv, type AgentEnv } from '@lingtai/agent-env'
import { failingTestsOf, integrationStream, parsePayload } from '@lingtai/domain'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import { parseDuration, submodulesOf, type ResolvedRecipe } from '@lingtai/recipe'
import { mirrorPathFor, mirrorWrite, worktreePath, type TokenSource } from '@lingtai/repo'
import { Effect, Fiber, Result } from 'effect'

import { Repo } from './ports.ts'
import { runtimesOf } from './runtimes-of.ts'
import { makeRunSandbox, type PassSandbox } from './sandbox-decision.ts'
import { observedKindOfDecision } from './sandbox-record.ts'

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
  /**
   * Which kind of boundary the asking pass ran under (#1180). Part of the in-flight key when unsandboxed, because
   * *degraded* and *off by choice* are the same cache key but not the same observation: a join must not hand one
   * pass the other's run.
   */
  observedAs?: string
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
  | { verdict: 'green'; exitCode: 0; boundary: string; from: 'log' | 'ran' }
  | { verdict: 'red'; exitCode: number; evidence: string; boundary: string; from: 'log' | 'ran' }
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
          ? answered({ verdict: 'green', exitCode: 0, boundary, from: 'log' })
          : answered({
              verdict: 'red',
              exitCode: data.exitCode ?? 1,
              evidence: data.evidence ?? '',
              boundary,
              from: 'log',
            })
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
        const last = commands[commands.length - 1] as BaseCheckCommand
        let outcome = yield* runIn(last, commands.length - 1)
        let first: CommandOutcome | undefined
        // 0108 §17: a non-zero exit is run once more, at once, in this tree. `prepared` is not run again.
        if (!q.signal.aborted && !outcome.timedOut && outcome.exitCode !== null && outcome.exitCode !== 0) {
          first = outcome
          outcome = yield* runIn(last, commands.length - 1)
        }
        return { outcome, first, boundary } as const
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
      const first = ran.first

      if (q.signal.aborted) return unknownWith('the check was aborted')
      if (outcome.timedOut || outcome.exitCode === null) {
        return unknownWith(`\`${q.command}\` did not run to an exit code: ${outcome.evidence}`)
      }
      const ok = outcome.exitCode === 0
      const evidence = ok ? '' : boundedEvidence(outcome.evidence)
      const names = first !== undefined && ok ? failingTestsOf(first.evidence) : null
      if (first !== undefined && ok) {
        deps.note(`base check: \`${q.command}\` failed once on ${q.baseSha.slice(0, 7)} and passed on the rerun`)
      }
      const data = {
        base: q.base,
        baseSha: q.baseSha,
        command: q.command,
        boundary: ran.boundary,
        ok,
        exitCode: outcome.exitCode,
        durationMs: Math.max(0, Math.round(outcome.durationMs + (first?.durationMs ?? 0))),
        evidence,
        ...(names === null ? {} : { flaky: names }),
        runId: q.runId,
      }
      const recorded = yield* Effect.result(record(stream, data).pipe(Effect.catchDefect((d) => Effect.fail(d))))
      if (Result.isFailure(recorded)) {
        deps.note(`base check: could not record BaseChecked on ${stream}: ${(recorded.failure as Error).message}`)
      }
      return ok
        ? answered({ verdict: 'green', exitCode: 0, boundary: ran.boundary, from: 'ran' })
        : answered({ verdict: 'red', exitCode: outcome.exitCode, evidence, boundary: ran.boundary, from: 'ran' })
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
        const key = JSON.stringify([
          stream,
          q.baseSha,
          q.command,
          fingerprint,
          fingerprint === UNSANDBOXED ? (q.observedAs ?? null) : null,
        ])
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

export interface BaseCheckQuestionInput {
  project: string
  base: string
  baseSha: string
  recipe: ResolvedRecipe['recipe']
  /** The name of the `build` action whose `run:` is checked. */
  action: string
  /** What `host.resolveEnv` gave: `merged` feeds each command's env, `values` is planted. */
  env: AgentEnv
  home: string
  /** The host's sandbox, as `decidePassSandbox(recipe.sandbox, host)` decided it: one rule, never a second. */
  sandbox: PassSandbox
  /** Names the cut worktree and is written as `BaseChecked.runId`. A pass passes its own `runId`. */
  checkId: string
  signal: AbortSignal
  token: TokenSource | undefined
  gitEnv: NodeJS.ProcessEnv | undefined
}

export type BuiltBaseCheckQuestion =
  | {
      question: BaseCheckQuestion
      /** What the pass observes of its sandbox, for `observeTheSandbox`; null when nothing is to be said. */
      observed: ReturnType<typeof observedKindOfDecision>
    }
  | { notBuilt: string }

/**
 * **The base check's question, built from a project and its recipe and no attempt** (#1206, 0122 §2).
 * A pass and a look both ask through this, so a question is built one way. It never throws: a read that
 * fails, or a sandbox the host cannot provide, is `notBuilt` — never an unsandboxed question in its place,
 * because that answer would be recorded under a boundary no pass asks about.
 *
 * The git runs against the mirror, not a pass's worktree, so there is no attempt in scope.
 */
export const baseCheckQuestion = (input: BaseCheckQuestionInput): Effect.Effect<BuiltBaseCheckQuestion, never, Repo> =>
  Effect.gen(function* () {
    const { recipe, sandbox: passSandbox, project, home } = input
    const decision = passSandbox.decision
    if (decision.kind === 'refused') return { notBuilt: decision.why }
    if (decision.kind === 'sandboxed' && passSandbox.service === undefined) {
      return {
        notBuilt: 'the recipe sandboxes its runs and this host provided no Sandbox service to wrap them with',
      }
    }
    const action = recipe.steps.build.find((a) => a.name === input.action)
    if (action === undefined || !('run' in action)) return { notBuilt: 'not a run: action in the recipe' }

    const built = Result.try({
      try: () => {
        const envFor = (declared: readonly string[]): Record<string, string> =>
          runnableEnv(extensionEnv(input.env.merged, declared, productionPatterns(recipe.env.refuseHosts)).values)
        return {
          prepared: recipe.steps.prepared.flatMap((a) =>
            'run' in a ? [{ run: a.run, env: envFor(a.env), timeoutMs: parseDuration(a.timeout) }] : [],
          ),
          env: envFor(action.env),
          timeoutMs: parseDuration(action.timeout),
        }
      },
      catch: (error) => (error as Error).message,
    })
    if (Result.isFailure(built)) return { notBuilt: built.failure }

    // Read before any mirror write, so a permit holder is never carried into the detached runs.
    const repo = yield* Repo
    const services = yield* Effect.context()
    const detached = Effect.runPromiseWith(services)
    const mirror = mirrorPathFor(project, home)
    const git = (args: string[], cwd: string) => repo.git(args, { token: input.token, env: input.gitEnv, cwd })

    // Without `appends`: the base check names no step, so it records nothing on an attempt, and the wrap is identical.
    const runSandbox =
      decision.kind === 'sandboxed' && passSandbox.service !== undefined
        ? makeRunSandbox(passSandbox.service, {
            project,
            mirror,
            cache: join(home, 'cache', project),
            additions: decision.project_additions,
            codexNamed: runtimesOf(recipe).includes('codex'),
          })
        : undefined
    const observed = observedKindOfDecision(decision, runSandbox !== undefined)

    const question: BaseCheckQuestion = {
      project,
      base: input.base,
      baseSha: input.baseSha,
      command: action.run,
      prepared: built.success.prepared,
      env: built.success.env,
      runId: input.checkId,
      signal: input.signal,
      timeoutMs: built.success.timeoutMs,
      ...(runSandbox === undefined ? {} : { sandbox: runSandbox }),
      ...(observed === null ? {} : { observedAs: observed }),
      tree: {
        cut: (path, sha) =>
          detached(
            Effect.gen(function* () {
              const cut = yield* Effect.result(
                mirrorWrite(mirror, git(['worktree', 'add', '--force', '--detach', path, sha], mirror)),
              )
              if (Result.isFailure(cut)) return yield* Effect.die(new Error(cut.failure.detail))
              if (submodulesOf(recipe)) {
                // `worktree add` leaves submodule directories empty, as `provisionWorktree` says.
                yield* repo.git(['submodule', 'update', '--init', '--recursive'], {
                  token: input.token,
                  env: input.gitEnv,
                  cwd: path,
                })
              }
            }),
          ),
        remove: (path) =>
          detached(
            Effect.gen(function* () {
              const gone = yield* Effect.result(
                mirrorWrite(mirror, git(['worktree', 'remove', '--force', path], mirror)),
              )
              if (Result.isFailure(gone)) return yield* Effect.die(new Error(gone.failure.detail))
            }),
          ),
        plant: (path) => {
          const plantedAt = resolve(path, recipe.env.plantAt)
          return mkdir(dirname(plantedAt), { recursive: true }).then(() =>
            writeFile(plantedAt, renderEnvFile(input.env.values), { mode: 0o600 }),
          )
        },
      },
    }
    return { question, observed }
  })

const baseChecks = new WeakMap<EventStore, ReturnType<typeof createBaseCheck>>()

/**
 * **The one base check of a store in this process**: its in-flight map is what makes two asks about one commit one run
 * (#744, 0122), so a pass and a PR's build share it.
 */
export function baseCheckFor(store: EventStore, log: (line: string) => void, home: string) {
  let check = baseChecks.get(store)
  if (check === undefined) {
    check = createBaseCheck({
      store,
      run: commandEffect,
      worktreePath: (project, sha7, runId) => worktreePath(home, project, `base-${sha7}-${runId}`),
      note: log,
    })
    baseChecks.set(store, check)
  }
  return check
}
