import { mkdir, rm } from 'node:fs/promises'
import { type Socket, createServer } from 'node:net'
import { dirname } from 'node:path'

/**
 * The conductor's end of the hook channel.
 *
 * A hook is usually thought of as a guard. It is better understood as **the only
 * channel through which the outside world reports facts to the event log** — and
 * the same round trip carries the verdict back. One socket, both directions.
 *
 * Three rules hold the hot path, and each is a way to make an agent slow or an
 * outage worse:
 *
 * **The verdict is synchronous; persistence is not.** An allowed call is counted
 * in memory and answered immediately. *The event store's availability must never
 * gate an agent's tool call* — a database blip would otherwise stall every tool
 * use in every run. Only a denial persists before answering, and by then the
 * decision is already made, so a slow store delays only a call that was going to
 * be refused.
 *
 * **It answers from memory.** Everything it needs is resolved when the run is
 * registered. No read, no parse, no allocation beyond the reply.
 *
 * **A run it does not know is denied.** The socket is per-conductor, not
 * per-run, and a request carrying an unknown run id is a misconfiguration rather
 * than a permission.
 */
import { type PayloadOf, parsePayload } from '@lingtai/domain'
import { type EventStore, eventStore } from '@lingtai/event-store'
import { Effect, FiberSet, type Fiber } from 'effect'

import { AgentHostFailed } from './hook-config.ts'

/** What the runtimes call the five hooks both of them have. */
export type HookName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  // Claude Code only. Bonus signal: better when present, never required.
  | 'SessionEnd'
  | 'PreCompact'
  | 'Notification'

/**
 * The tools that change a file, and what to call what they did.
 *
 * A list rather than a default, because the failure modes are not symmetric. A
 * tool missing from here means a real edit goes unrecorded, which shows up as a
 * diff nobody predicted — visible, and annoying. A default that treats anything
 * with a `file_path` as a write means reads are recorded as writes, which shows
 * up as a board that confidently reports work that never happened. Only the
 * second kind is hard to notice, so the list is the one that is easy to audit.
 */
/**
 * Strip anything credential-shaped out of a string bound for the wire.
 *
 * Moved here when the guard was deleted (ADR 0016 §6) rather than deleted with
 * it: the error path in `handle` puts a thrown message into a reply, and a
 * thrown message is exactly where a connection string turns up.
 */
export function redact(command: string): string {
  return command
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s"']*@/gi, '$1***@')
    .replace(/\b(sk|pk|ghp|ghs|gho|github_pat)_[A-Za-z0-9_]{8,}/g, '$1_***')
    .replace(/(-{1,2}(?:password|token|secret|key)[= ])\S+/gi, '$1***')
    .replace(/\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Za-z0-9_]*=\S+/g, (m) => `${m.split('=')[0]}=***`)
    .slice(0, 500)
}

/** Just enough of a tool call to tell whether it changed a file. */
interface ToolCall {
  /** `Bash`, `Read`, `Write`, … as the runtime names it. */
  tool: string
  input: Record<string, unknown>
}

/**
 * A tool call as a watcher sees it: what, and on what.
 *
 * The socket's own decisions do not need this — `MUTATIONS` above is the whole
 * of what it reads an input for. It exists because `onDecision` used to carry
 * the hook name and a verdict and nothing else, which is enough to count calls
 * and not enough to say what the agent is *doing*, and 0034's whole claim is
 * that the live picture is already arriving.
 */
export interface ObservedCall {
  /** `Bash`, `Read`, `Write`, … */
  tool: string
  /** The path, the command, the pattern — whatever this tool is about. Never multi-line. */
  target: string
}

/**
 * What a tool call is about, in one clipped and redacted string.
 *
 * Redacted because a `Bash` command is exactly where a connection string turns
 * up, and this now reaches a file on disk rather than only a counter in memory
 * — the same reason `redact` survived the guard's deletion.
 */
export function observedCall(call: ToolCall): ObservedCall {
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = call.input[key]
      if (typeof value === 'string' && value !== '') return value
    }
    return ''
  }
  const command = first('command')
  const target = command === '' ? first('file_path', 'path', 'pattern', 'url', 'query') : redact(command)
  return { tool: call.tool, target: target.slice(0, 500) }
}

const MUTATIONS: Record<string, 'write' | 'edit' | undefined> = {
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
}

export interface RegisteredRun {
  runId: string
  /** Tool calls seen. Used where the runtime gives no turn number of its own. */
  calls: number
  /** Counted in memory, flushed as events rather than one append per call. */
  allowed: number
  touched: { path: string; op: 'edit' | 'write' | 'delete' }[]
  /** The stream version the next append expects. */
  version: number
}

export interface HookServerOptions {
  socketPath: string
  store?: EventStore
  /**
   * Every tool call, as it happens.
   *
   * Overridable so a test can watch what the server decided, and — since
   * [0034](../../../doc/decisions-archive/0034-the-run-log.md) — so the conductor can
   * write the run's log from it. The events this hook produces are deliberately
   * buffered (`run.touched`, flushed at the end) because the board wants what
   * the agent *changed* rather than every read it made; this is the other
   * audience, which wants exactly the reads.
   */
  onDecision?: (runId: string, hook: HookName, verdict: 'allow' | 'deny', call: ObservedCall) => void
  /**
   * Called for a lifecycle hook the conductor has to act on rather than merely
   * record — `Stop` is the moment the gate pipeline fires, and firing it needs a
   * diff, which needs git, which does not belong on the hot path.
   */
  onLifecycle?: (runId: string, hook: HookName, payload: unknown) => void
}

export interface HookServer {
  readonly socketPath: string
  /** Teaches the server about a run. Until this, its calls are denied. */
  register(runId: string, version: number): RegisteredRun
  unregister(runId: string): RegisteredRun | undefined
  get(runId: string): RegisteredRun | undefined
  /** Writes the counted-in-memory facts to the log. Called at the end of a run. */
  flush(runId: string): Promise<void>
}

interface Request {
  runId?: string
  payload?: {
    hook_event_name?: string
    tool_name?: string
    tool_input?: Record<string, unknown>
    prompt?: string
    message?: string
    session_id?: string
  }
}

/** Forks an Effect into the serve scope's fiber set. */
type Fork = (effect: Effect.Effect<void>) => Fiber.Fiber<void>
type RunPromise = (effect: Effect.Effect<void>) => Promise<void>

function createHookServer(options: HookServerOptions, runPromise: RunPromise) {
  const store = options.store ?? eventStore
  const runs = new Map<string, RegisteredRun>()

  /** Appends to a run's stream, keeping the expected version in step. */
  const append = <T extends Parameters<typeof parsePayload>[0]>(
    run: RegisteredRun,
    type: T,
    data: PayloadOf<T>,
  ): Effect.Effect<void> =>
    Effect.promise(() =>
      store
        .append(run.runId, run.version, [{ type, actor: `agent:${run.runId}`, data: parsePayload(type, data) }])
        .then(([written]) => {
          run.version = written!.version
        }),
    )

  /** The store's rejection is a defect (0101 §6); the two lifecycle appends swallow it. */
  const appendQuietly: typeof append = (run, type, data) =>
    append(run, type, data).pipe(Effect.catchDefect(() => Effect.void))

  const decide = (request: Request) =>
    Effect.gen(function* () {
      const run = request.runId ? runs.get(request.runId) : undefined
      if (!run) {
        // Fail closed on an unknown run: the conductor renders the wiring, so this
        // means the wiring is wrong, not that this call is exempt.
        return { allow: false, reason: `lingtai-hook: run ${request.runId ?? '(none)'} is not registered` }
      }

      const hook = (request.payload?.hook_event_name ?? 'PreToolUse') as HookName
      const call: ToolCall = {
        tool: request.payload?.tool_name ?? '',
        input: request.payload?.tool_input ?? {},
      }

      // The lifecycle hooks. Each maps to the event design.md §5 says it should,
      // except `SessionStart` — its event is `RunStarted`, and the conductor
      // writes that at dispatch because it knows the work item, the model, the
      // base sha and the config hash, none of which the hook is told.
      if (hook === 'UserPromptSubmit') {
        // **Nothing is appended here since #928.** The conductor records the
        // implementer's prompt (`RunPrompted`, with its `for`) before it
        // registers the run, whole or by reference; recording it here as well
        // would be two records and `prompts: 2`.
        options.onLifecycle?.(run.runId, hook, request.payload)
        return { allow: true }
      }

      if (hook === 'PreCompact') {
        // Compaction means the work item was scoped too large — a metric, not
        // noise. The payload carries no turn number, so this records the
        // conductor's own count of tool calls at the moment it happened; what the
        // metric is *for* does not depend on which monotonic counter it is.
        yield* appendQuietly(run, 'RunContextExhausted', { turn: run.calls })
        options.onLifecycle?.(run.runId, hook, request.payload)
        return { allow: true }
      }

      if (hook === 'Notification') {
        // The board lights up instead of the run burning to the wall clock.
        const prompt = request.payload?.message ?? request.payload?.prompt ?? 'waiting'
        yield* appendQuietly(run, 'RunAwaitingInput', { prompt: prompt.slice(0, 2_000) })
        options.onLifecycle?.(run.runId, hook, request.payload)
        return { allow: true }
      }

      if (hook === 'Stop' || hook === 'SessionStart' || hook === 'SessionEnd') {
        // `Stop` is the moment the gate pipeline fires, and firing it needs a diff
        // — git, not the hot path. `SessionEnd`'s event is `RunFinished`, which
        // the adapter writes from the process outcome because that is where cost,
        // turns and duration actually are.
        options.onLifecycle?.(run.runId, hook, request.payload)
        return { allow: true }
      }

      if (hook === 'PostToolUse') {
        // Observation only. Counted, never blocking — the tool already ran.
        //
        // Only the tools that actually change a file. This used to record any
        // call carrying a `file_path` and default the op to "write", which meant
        // every `Read` was written down as a write. One run logged fifteen
        // `RunTouchedFile` events with `op: "write"` for a worktree it had not
        // modified at all — the board showed fifteen changed files, the diff
        // showed none, and the log was the thing that was wrong. In a system
        // whose whole claim is that the log is the answer, a plausible fiction is
        // worse than a gap.
        const op = MUTATIONS[call.tool]
        const path = (call.input['file_path'] ?? call.input['path']) as string | undefined
        if (op && path) run.touched.push({ path, op })
        options.onDecision?.(run.runId, hook, 'allow', observedCall(call))
        return { allow: true }
      }

      // Everything else, `PreToolUse` included. Lingtai refuses no tool call
      // (ADR 0016 §6): tool restrictions are the runtime's own configuration. A
      // whole-tool `permissions.deny` is enforced even under `bypassPermissions`,
      // by removing the tool from the model's list; a path-scoped one refuses the
      // call and covers no subprocess (doc/operating.md, #664).
      //
      // `PreToolUse` is not wired at all any more, so this is defensive rather
      // than a path anything takes. It counts, because a run's tool-call count is
      // what `RunContextExhausted` reports a turn number from.
      run.calls += 1
      run.allowed += 1
      options.onDecision?.(run.runId, hook, 'allow', observedCall(call))
      return { allow: true }
    })

  const flushEffect = (runId: string) =>
    Effect.gen(function* () {
      const run = runs.get(runId)
      if (!run) return
      // One append per touched file rather than one per tool call: the board
      // wants to show what the agent changed, not every read it made.
      const touched = run.touched.splice(0)
      for (const t of touched) {
        yield* append(run, 'RunTouchedFile', t)
      }
    }).pipe(Effect.withSpan('agent.flush'))

  const hook: HookServer = {
    socketPath: options.socketPath,

    register(runId, version) {
      const run: RegisteredRun = {
        runId,
        calls: 0,
        allowed: 0,
        touched: [],
        version,
      }
      runs.set(runId, run)
      return run
    },

    unregister(runId) {
      const run = runs.get(runId)
      runs.delete(runId)
      return run
    },

    get: (runId) => runs.get(runId),

    // Run on the serve scope's fiber set, so the scope closing interrupts it.
    flush: (runId) => runPromise(flushEffect(runId)),
  }
  return { hook, decide }
}

/**
 * The same server, with a lifetime.
 *
 * The socket is one of the three things a run acquires, and it was released by
 * a `finally` in the conductor — correct, and correct only because that
 * function remembered. As an `Effect.acquireRelease` the close happens because
 * the scope closed: on the happy path, on a typed refusal, on a defect and on
 * an interruption alike
 * ([0026](../../../doc/decisions-archive/0026-the-conversion-past-the-seam.md)).
 *
 * The release swallows its own failure, as the `.catch(() => {})` it replaces
 * did. A socket that will not close must not become the run's reported reason.
 *
 * The release also interrupts the requests in flight and destroys their sockets
 * before it closes the server, so a hook still waiting on its answer sees the
 * connection end with none and exits 2: it fails closed. `server.close` waits
 * for open connections, so closing first would wait on a hook that is itself
 * waiting on an answer nobody will now write.
 */
export const serveHookServer = Effect.fn('agent.serve')(function* (options: HookServerOptions) {
  const failed = (err: unknown) => new AgentHostFailed({ operation: 'serve', detail: (err as Error).message })
  const set = yield* FiberSet.make<void, never>()
  const fork: Fork = yield* FiberSet.runtime(set)<never>()
  const runPromise: RunPromise = yield* FiberSet.runtimePromise(set)<never>()
  const { hook, decide } = createHookServer(options, runPromise)
  const sockets = new Set<Socket>()

  yield* Effect.acquireRelease(
    Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => mkdir(dirname(options.socketPath), { recursive: true }), catch: failed })
      // A stale socket file from a killed conductor would make bind fail; there
      // is nothing behind it to protect.
      yield* Effect.tryPromise({ try: () => rm(options.socketPath, { force: true }), catch: failed })

      const server = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        let buffer = ''
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8')
          for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            // A defect is answered fail-closed; an interruption is not answered
            // at all, so a hook cut off by the scope sees no reply and exits 2.
            fork(
              Effect.sync(() => JSON.parse(line) as Request).pipe(
                Effect.flatMap(decide),
                Effect.catchDefect((err) =>
                  Effect.succeed({ allow: false, reason: `lingtai-hook: ${redact(String(err))}` }),
                ),
                Effect.flatMap((reply) =>
                  Effect.sync(() => {
                    socket.write(`${JSON.stringify(reply)}\n`)
                  }),
                ),
              ),
            )
          }
        })
        socket.on('error', () => {
          // A hook that hung up mid-question gets no answer, and its exit code
          // is 2 either way.
        })
      })

      yield* Effect.callback<void, AgentHostFailed>((resume) => {
        const onError = (err: Error) => resume(Effect.fail(failed(err)))
        server.once('error', onError)
        server.listen(options.socketPath, () => {
          server.off('error', onError)
          resume(Effect.void)
        })
      })
      return server
    }),
    (server) =>
      Effect.gen(function* () {
        // In this order, and each step on its own: a failed step skips none.
        yield* FiberSet.clear(set).pipe(Effect.ignore)
        yield* Effect.sync(() => {
          for (const socket of sockets) socket.destroy()
        }).pipe(Effect.ignore)
        yield* Effect.callback<void>((resume) => {
          try {
            server.close(() => resume(Effect.void))
          } catch {
            resume(Effect.void)
          }
        })
        yield* Effect.promise(() => rm(options.socketPath, { force: true }).catch(() => {}))
      }),
  )
  return hook
})
