/**
 * **What a check says on the commit a pass was cut at** (#743, 0108 §13) — the
 * port the guard in #744 asks before a `build` refusal buys a round.
 * `conduct.ts` builds one per store and `runPass` asks it through `baseIsRed`.
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
  run: (options: RunCommandOptions) => Promise<CommandOutcome>
  worktreePath: (project: string, sha7: string, runId: string) => string
  /** The run-log line for a failed append or removal. */
  note: (line: string) => void
}

const ATTEMPTS = 8

export function createBaseCheck(deps: BaseCheckDeps): { ask: (q: BaseCheckQuestion) => Promise<BaseCheckAnswer> } {
  const inFlight = new Map<string, Promise<BaseCheckAnswer>>()

  async function check(q: BaseCheckQuestion, stream: string): Promise<BaseCheckAnswer> {
    let events
    try {
      events = await deps.store.read(stream)
    } catch (err) {
      return { verdict: 'unknown', why: `the log could not be read: ${(err as Error).message}` }
    }
    for (const event of [...events].reverse()) {
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
        ? { verdict: 'green', exitCode: 0, from: 'log' }
        : { verdict: 'red', exitCode: data.exitCode ?? 1, evidence: data.evidence ?? '', from: 'log' }
    }

    const path = deps.worktreePath(q.project, q.baseSha.slice(0, 7), q.runId)
    let outcome!: CommandOutcome
    try {
      try {
        await q.tree.cut(path, q.baseSha)
      } catch (err) {
        return { verdict: 'unknown', why: `the worktree could not be cut at ${q.baseSha}: ${(err as Error).message}` }
      }
      try {
        await q.tree.plant(path)
      } catch (err) {
        return { verdict: 'unknown', why: `the env file could not be planted: ${(err as Error).message}` }
      }
      // An abort that landed while the cut or the plant was pending: `runCommand` only hears
      // aborts that come after it starts, so nothing may be started with the signal already down.
      if (q.signal.aborted) return { verdict: 'unknown', why: 'the check was aborted' }
      const runIn = (c: BaseCheckCommand): Promise<CommandOutcome> =>
        deps.run({
          run: c.run,
          timeoutMs: c.timeoutMs,
          cwd: path,
          env: c.env,
          signal: q.signal,
          ownGroup: true,
        })
      for (const prep of q.prepared) {
        const prepared = await runIn(prep)
        if (q.signal.aborted) return { verdict: 'unknown', why: 'the check was aborted' }
        if (prepared.timedOut || prepared.exitCode !== 0) {
          return { verdict: 'unknown', why: `\`${prep.run}\` did not succeed: ${prepared.evidence}` }
        }
      }
      outcome = await runIn({ run: q.command, env: q.env, timeoutMs: q.timeoutMs })
    } finally {
      await q.tree.remove(path).catch((err: Error) => {
        deps.note(`base check: could not remove ${path}: ${err.message} — it may hold the planted env file`)
      })
    }

    if (q.signal.aborted) return { verdict: 'unknown', why: 'the check was aborted' }
    if (outcome.timedOut || outcome.exitCode === null) {
      return { verdict: 'unknown', why: `\`${q.command}\` did not run to an exit code: ${outcome.evidence}` }
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
    try {
      await record(stream, data)
    } catch (err) {
      deps.note(`base check: could not record BaseChecked on ${stream}: ${(err as Error).message}`)
    }
    return ok
      ? { verdict: 'green', exitCode: 0, from: 'ran' }
      : { verdict: 'red', exitCode: outcome.exitCode, evidence, from: 'ran' }
  }

  async function record(stream: string, data: unknown): Promise<void> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const at = (await deps.store.read(stream)).length
      try {
        await deps.store.append(stream, at, [
          { type: 'BaseChecked', actor: 'conductor', data: parsePayload('BaseChecked', data) },
        ])
        return
      } catch (err) {
        if (!(err instanceof ConcurrencyError)) throw err
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
      }
    }
    throw new Error(`could not record BaseChecked on ${stream} after ${ATTEMPTS} attempts`)
  }

  return {
    ask(q) {
      const stream = integrationStream(q.project, q.base)
      const key = JSON.stringify([stream, q.baseSha, q.command])
      const shared = inFlight.get(key)
      if (shared) return shared
      const promise = check(q, stream)
        .catch((err: Error): BaseCheckAnswer => ({ verdict: 'unknown', why: err.message }))
        .finally(() => inFlight.delete(key))
      inFlight.set(key, promise)
      return promise
    },
  }
}
