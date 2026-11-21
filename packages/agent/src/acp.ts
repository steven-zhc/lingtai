/**
 * The ACP runtime (0.16.0, *The ACP runtime: decided*): an agent that speaks
 * the Agent Client Protocol on stdio, driven through the official SDK, run as
 * one process group and recorded the way a Claude Code run is.
 *
 * **The record, never the mediation.** Lingtai refuses no tool call (ADR 0016
 * §6), so every `session/request_permission` is answered *allow once* and noted;
 * the run's `UserPromptSubmit` goes to the hook socket before `session/prompt`,
 * and an unreachable socket means no prompt — the run is not allowed to be
 * unrecorded. That is what `canFailClosed: true` stands for here.
 *
 * **A finished turn is not a success.** Copilot ends `end_turn` with the error
 * as the reply text when it cannot do the work (019 E9), so the profile names the
 * sentence and `acpFailure` reads it.
 *
 * **`session/cancel` is not the end of the process** (019 E4): the wall sends it,
 * waits, and then ends the group.
 *
 * No `async` function, no `Effect.run*` (the ratchet, 0101 §6): the SDK's
 * promises are chained and the whole run is one `Effect.callback`.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { connect } from 'node:net'

import type { ClientContext } from '@agentclientprotocol/sdk'
import type { Usage } from '@lingtai/domain'
import { Effect } from 'effect'

import {
  AUTH_REQUIRED,
  COPILOT_PROFILE,
  isAuthRequired,
  lingtaiClient,
  openSession,
  signalGroup as killGroup,
  spawnAgent,
  streamOf,
  type AcpProfile,
  type SpawnAgent,
} from './acp-session.ts'
import { copilotAuth, runtimeVersionEffect } from './auth.ts'
import type { SandboxedLaunch } from './claude-sandbox.ts'
import { copilotSandboxedLaunch, type CopilotSandboxPorts } from './copilot-sandbox.ts'
import type { Invocable, RunOutcome, RunRequest, Runtime, RuntimeCapabilities, Spawned } from './runtime.ts'

export const COPILOT_CAPABILITIES: RuntimeCapabilities = {
  id: 'copilot',
  hooks: [],
  acceptsOutputSchema: false,
  canFailClosed: true,
  canRewriteToolCall: false,
  // usd stays unenforced: nothing can price the run while it runs.
  enforces: ['wall', 'turns'],
}

/** What the hook socket answers: `{ allow, reason? }`, one JSON line. */
export interface HookReply {
  allow: boolean
  reason?: string
}

/** One JSON line to the run's hook socket, as `lingtai-hook` sends it. */
export type HookSend = (socketPath: string, runId: string, payload: unknown) => Promise<HookReply>

const HOOK_TIMEOUT_MS = 1_000

export const sendToHookSocket: HookSend = (socketPath, runId, payload) =>
  new Promise<HookReply>((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`no answer in ${HOOK_TIMEOUT_MS}ms`))
    }, HOOK_TIMEOUT_MS)
    socket.on('connect', () => socket.write(`${JSON.stringify({ runId, payload })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      clearTimeout(timer)
      socket.end()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as HookReply)
      } catch {
        reject(new Error('the reply was not JSON'))
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      reject(new Error('the connection closed without an answer'))
    })
  })

/** What an ACP `session/update` of a tool call carries that the record needs. */
export interface ToolCallFields {
  toolCallId: string
  kind?: string | null
  title?: string | null
  status?: string | null
  locations?: readonly { path?: string | null }[] | null
  rawInput?: unknown
}

interface ToolEntry {
  kind: string | undefined
  title: string | undefined
  path: string | undefined
  status: string | undefined
  sent: boolean
}

const pathOf = (fields: ToolCallFields): string | undefined => {
  const located = fields.locations?.find((l) => typeof l.path === 'string' && l.path !== '')?.path
  if (located) return located
  const raw = fields.rawInput
  if (raw && typeof raw === 'object') {
    const input = raw as Record<string, unknown>
    for (const key of ['path', 'file_path']) {
      const value = input[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}

/**
 * The tool calls of one run, merged as their updates arrive.
 *
 * A record is made when a call **finishes**, not when it is announced: an edit
 * waits behind a permission request and may never run, and the hook server's own
 * comment rules out writing one down that did not — *a plausible fiction is
 * worse than a gap* (`hook-socket.ts`). Claude Code's `PostToolUse` also fires
 * after the tool ran.
 */
export function createToolLedger() {
  const entries = new Map<string, ToolEntry>()
  return {
    /**
     * Merges one `tool_call` or `tool_call_update`. Returns the `PostToolUse`
     * payload the first time the call is seen finished, otherwise `null`.
     */
    apply(fields: ToolCallFields): Record<string, unknown> | null {
      const entry: ToolEntry = entries.get(fields.toolCallId) ?? {
        kind: undefined,
        title: undefined,
        path: undefined,
        status: undefined,
        sent: false,
      }
      entries.set(fields.toolCallId, entry)
      if (fields.kind) entry.kind = fields.kind
      if (fields.title) entry.title = fields.title
      if (fields.status) entry.status = fields.status
      entry.path = pathOf(fields) ?? entry.path
      if (entry.sent || (entry.status !== 'completed' && entry.status !== 'failed')) return null
      entry.sent = true
      // Only a completed edit with a path is a touched file; the server's
      // `MUTATIONS` map matches on `Edit`. Anything else is traced under a name
      // it does not match, so it is seen and never mistaken for a write.
      const edited = entry.kind === 'edit' && entry.status === 'completed' && entry.path !== undefined
      return {
        hook_event_name: 'PostToolUse',
        tool_name: edited ? 'Edit' : `acp:${entry.kind ?? 'other'}`,
        tool_input: entry.path !== undefined ? { file_path: entry.path } : { title: entry.title ?? '' },
        tool_response: { status: entry.status },
      }
    },
    /** Calls announced and never finished: traced, never recorded as touched. */
    unfinished(): string[] {
      return [...entries.values()].filter((e) => !e.sent).map((e) => e.title ?? e.kind ?? 'tool call')
    },
  }
}

/** What the turn answered, for `acpFailure`. */
export interface TurnEnd {
  stopReason: string | undefined
  text: string
}

/**
 * Whether a turn that ended is a failure. `end_turn` with the profile's
 * *failed turn* sentence is one; a missing `stopReason` is one; `cancelled` is
 * the wall's to name, not this function's.
 */
export function acpFailure(profile: AcpProfile, end: TurnEnd): { kind: 'crash'; detail: string } | null {
  if (end.stopReason === undefined)
    return { kind: 'crash', detail: `${profile.name} ended the turn with no stopReason` }
  if (end.stopReason === 'end_turn' && profile.failedTurn.test(end.text.trimStart())) {
    return { kind: 'crash', detail: end.text.trim() }
  }
  if (end.stopReason !== 'end_turn') {
    return { kind: 'crash', detail: `${profile.name} stopped the turn: ${end.stopReason}` }
  }
  return null
}

/** The session-update shapes this runtime reads, as far as it reads them. */
interface SessionUpdate extends ToolCallFields {
  sessionUpdate: string
  content?: { type?: string; text?: string }
}

/** The SDK's stream with `tap` shown each message the agent sent, unchanged. */
function tapped(stream: ReturnType<typeof streamOf>, tap: (message: unknown) => void): ReturnType<typeof streamOf> {
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          tap(message)
          controller.enqueue(message)
        },
      }),
    ),
  }
}

/** What is wrong with a `session/update`, in a sentence, or `undefined` when it is readable. */
export function invalidUpdate(update: unknown): string | undefined {
  if (update === null || typeof update !== 'object') return 'update is not an object'
  const u = update as Record<string, unknown>
  if (typeof u['sessionUpdate'] !== 'string') return 'sessionUpdate is not a string'
  if (u['sessionUpdate'] === 'tool_call' || u['sessionUpdate'] === 'tool_call_update') {
    if (typeof u['toolCallId'] !== 'string') return 'toolCallId is not a string'
    if (u['sessionUpdate'] === 'tool_call' && typeof u['title'] !== 'string') return 'title is not a string'
    for (const key of ['kind', 'title', 'status']) {
      const v = u[key]
      if (v !== undefined && v !== null && typeof v !== 'string') return `${key} is not a string`
    }
    const locations = u['locations']
    if (locations !== undefined && locations !== null) {
      if (!Array.isArray(locations)) return 'locations is not an array'
      for (const l of locations) {
        const path = (l as { path?: unknown } | null)?.path
        if (path !== undefined && path !== null && typeof path !== 'string') return 'a location path is not a string'
      }
    }
  }
  if (u['sessionUpdate'] === 'agent_message_chunk') {
    const c = u['content'] as { type?: unknown; text?: unknown } | null | undefined
    if (c?.type === 'text' && typeof c.text !== 'string') return 'message text is not a string'
  }
  return undefined
}

/** Waits, briefly, for a condition the SDK's own handling of a message makes true. */
function settled(done: () => boolean, tries = 20): Promise<void> {
  if (done() || tries === 0) return Promise.resolve()
  return new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => settled(done, tries - 1))
}

class HookRefused extends Error {
  override readonly name = 'HookRefused'
}

const STDERR_TAIL = 4_096
const CANCEL_WAIT_MS = 5_000
const TERM_TO_KILL_MS = 2_000

export interface AcpOptions {
  profile?: AcpProfile
  binary?: string
  /** `node:child_process`'s `spawn`, or a test's: `pnpm test` runs no process. */
  spawn?: SpawnAgent
  hook?: HookSend
  /** Signals the agent's process group. A test's records instead of killing. */
  signalGroup?: typeof killGroup
  /** How long `session/cancel` is given before the group is signalled. */
  cancelWaitMs?: number
  /** How long after `SIGTERM` before `SIGKILL`. */
  killWaitMs?: number
  /** The ports a sandboxed run reads through; a test replaces them (#1301). */
  sandbox?: CopilotSandboxPorts
}

export function createAcpRuntime(options: AcpOptions = {}): Runtime {
  const profile = options.profile ?? COPILOT_PROFILE
  const binary = options.binary ?? profile.command
  return {
    capabilities: COPILOT_CAPABILITIES,
    version: (env, cwd) => runtimeVersionEffect(binary, env, options.spawn, cwd),
    checkAuth: (env) => copilotAuth(binary, env),
    // The prompt goes over the protocol, so there is nothing on argv to elide.
    invocation: (_request: Invocable): Spawned => ({ command: binary, args: profile.args }),
    run: (request) => acpRun(options, request),
  }
}

/** The `usage` of a `session/prompt` result, as one entry — or none when it carried no figure. */
function usageOf(profile: AcpProfile, response: unknown, note: (label: string, detail?: string) => void): Usage {
  const raw = (response as { usage?: unknown } | null)?.usage
  if (raw === null || typeof raw !== 'object') return []
  const { tokens, note: said } = profile.tokens(raw as Record<string, unknown>)
  if (said !== undefined) note('usage', said)
  return Object.keys(tokens).length === 0 ? [] : [{ tokens }]
}

const outcomeOf = (
  started: number,
  parts: Pick<RunOutcome, 'failure' | 'text' | 'sessionId'> & {
    turns: number
    exitCode?: number | null
    usage?: Usage
  },
): RunOutcome => ({
  usage: parts.usage ?? [],
  exitCode: parts.exitCode ?? null,
  turns: parts.turns,
  durationMs: Date.now() - started,
  costUsd: null,
  failure: parts.failure,
  text: parts.text,
  sessionId: parts.sessionId,
})

export const acpRun = Effect.fn('agent.run')(function* (options: AcpOptions, request: RunRequest) {
  const profile = options.profile ?? COPILOT_PROFILE
  const binary = options.binary ?? profile.command
  const spawn = options.spawn ?? nodeSpawn
  const send = options.hook ?? sendToHookSocket
  const signalGroup = options.signalGroup ?? killGroup
  const cancelWaitMs = options.cancelWaitMs ?? CANCEL_WAIT_MS
  const killWaitMs = options.killWaitMs ?? TERM_TO_KILL_MS
  const started = Date.now()
  const socketPath = request.env['LINGTAI_HOOK_SOCKET']
  const hookRunId = request.env['LINGTAI_HOOK_RUN_ID']

  if (!socketPath || !hookRunId) {
    // Wiring that is wrong, as `lingtai-hook` reads it: never a run that is exempt.
    return outcomeOf(started, {
      turns: 0,
      text: null,
      sessionId: '',
      failure: {
        kind: 'crash',
        detail: 'LINGTAI_HOOK_SOCKET and LINGTAI_HOOK_RUN_ID are not set — refusing to run unrecorded',
      },
    })
  }

  const runChild = (launch: SandboxedLaunch, sandboxed: boolean) =>
    Effect.callback<RunOutcome>((resume) => {
      const trace = request.log
      const note = (label: string, detail?: string) => trace?.note(label, detail)
      const child = spawnAgent(spawn, launch.command, launch.args, { cwd: request.cwd, env: launch.env })
      const ledger = createToolLedger()
      const chunks: string[] = []
      const pending = new Set<Promise<unknown>>()
      let calls = 0
      // Updates the agent sent, and updates the SDK accepted and handed on: a difference is one it rejected.
      let seen = 0
      let delivered = 0
      let sessionId = ''
      let phase: 'opening' | 'prompting' = 'opening'
      let ctxRef: ClientContext | undefined
      let stderrTail = ''
      let finished = false
      let stopping: { kind: 'timeout' | 'out-of-turns'; detail: string } | undefined
      let usage: Usage = []
      let exited = false
      // Failures of the record or of the protocol: a run that cannot say what it did is not a success.
      const recordFailures: string[] = []
      let protocolError: string | undefined
      const timers: ReturnType<typeof setTimeout>[] = []

      const finish = (failure: RunOutcome['failure'], exitCode: number | null = null) => {
        if (finished) return
        finished = true
        for (const timer of timers) clearTimeout(timer)
        // The turn is over; so is everything the agent started.
        signalGroup(child, 'SIGKILL')
        request.signal?.removeEventListener('abort', onWall)
        const text = chunks.join('')
        for (const title of ledger.unfinished()) note('unfinished', title)
        resume(
          Effect.succeed(
            outcomeOf(started, { turns: calls, text: text === '' ? null : text, sessionId, failure, exitCode, usage }),
          ),
        )
      }

      /** The detail every `crash` carries: what stderr last said. */
      const withStderr = (message: string) =>
        stderrTail.trim() === '' ? message : `${message}\nstderr: ${stderrTail.trim()}`

      const record = (payload: Record<string, unknown>) => {
        const sent = send(socketPath, hookRunId, { session_id: sessionId, ...payload }).then(
          (reply) => {
            if (reply.allow) return
            const why = `the hook socket refused ${String(payload['tool_name'])}: ${reply.reason ?? ''}`
            note('hook', why)
            recordFailures.push(why)
          },
          (error: unknown) => {
            const why = `could not record ${String(payload['tool_name'])}: ${(error as Error).message}`
            note('hook', why)
            recordFailures.push(why)
          },
        )
        pending.add(sent)
        void sent.then(() => pending.delete(sent))
      }

      /**
       * Every message the agent sends, before the SDK reads it. The SDK logs a
       * notification it cannot parse and goes on, so the tool call it carried would
       * vanish and the run read as a success; here that ends the run `crash`.
       */
      const tap = (message: unknown) => {
        const m = message as { method?: unknown; params?: { update?: unknown } } | null
        if (m?.method !== 'session/update') return
        seen += 1
        const invalid = invalidUpdate(m.params?.update)
        if (invalid === undefined) return
        protocolError = `${profile.name} sent a session/update that does not parse: ${invalid}`
        note('protocol', protocolError)
        finish({ kind: 'crash', detail: withStderr(protocolError) })
      }

      const onUpdate = (update: SessionUpdate) => {
        if (update.sessionUpdate === 'agent_message_chunk') {
          if (update.content?.type === 'text' && typeof update.content.text === 'string') {
            chunks.push(update.content.text)
          }
          return
        }
        if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
        if (update.sessionUpdate === 'tool_call') {
          calls += 1
          note('tool', `${update.kind ?? 'other'}: ${update.title ?? update.toolCallId}`)
          const allowed = request.limits.turns
          if (allowed !== undefined && calls > allowed) {
            stop('out-of-turns', `${calls} turns, and the recipe allows ${allowed}`)
          }
        }
        const payload = ledger.apply(update)
        if (payload) record(payload)
      }

      /** The first reason to stop wins: `session/cancel`, a wait, then the group. */
      function stop(kind: 'timeout' | 'out-of-turns', detail: string) {
        if (finished || stopping) return
        stopping = { kind, detail }
        note(kind === 'timeout' ? 'wall' : 'turns', `${detail}: cancelling, then ending the process group`)
        if (ctxRef && sessionId) void ctxRef.notify('session/cancel', { sessionId }).catch(() => undefined)
        timers.push(
          setTimeout(() => {
            signalGroup(child, 'SIGTERM')
            timers.push(setTimeout(() => finish({ kind, detail: `${detail}; the group was killed` }), killWaitMs))
          }, cancelWaitMs),
        )
      }

      /** The wall, or an abort. */
      function onWall() {
        stop('timeout', 'the wall was reached')
      }

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL)
      })
      child.on('error', (error) =>
        finish({ kind: 'crash', detail: withStderr(`could not start ${binary}: ${error.message}`) }),
      )
      child.on('exit', (code, signal) => {
        exited = true
        if (finished) return
        if (stopping) return finish({ kind: stopping.kind, detail: stopping.detail }, code)
        finish(
          { kind: 'crash', detail: withStderr(`${binary} exited (${signal ?? code}) before the turn ended`) },
          code,
        )
      })

      timers.push(setTimeout(onWall, request.limits.wallMs))
      if (request.signal?.aborted) onWall()
      else request.signal?.addEventListener('abort', onWall, { once: true })

      lingtaiClient()
        .onRequest('session/request_permission', ({ params }) => {
          // *Allow once*, never a reject and never an auto mode (0.16.md): Lingtai
          // refuses no tool call, it writes down that one was asked.
          const allow = params.options.find((o) => o.kind === 'allow_once')
          note(
            'permission',
            `asked ${params.toolCall.title ?? params.toolCall.toolCallId}: ${allow ? 'allowed' : 'no allow-once offered'}`,
          )
          return allow
            ? { outcome: { outcome: 'selected' as const, optionId: allow.optionId } }
            : { outcome: { outcome: 'cancelled' as const } }
        })
        .onNotification('session/update', ({ params }) => {
          delivered += 1
          onUpdate(params.update as unknown as SessionUpdate)
        })
        .connectWith(tapped(streamOf(child), tap), (ctx) => {
          ctxRef = ctx
          /** The wall came while a step was pending: cancel the session now it has an id, and start nothing more. */
          const unlessWall = () => {
            if (!stopping) return undefined
            return (
              sessionId ? ctx.notify('session/cancel', { sessionId }).catch(() => undefined) : Promise.resolve()
            ).then(() => {
              throw new Error('the wall was reached before the prompt was sent')
            })
          }
          return openSession(ctx, request.cwd)
            .then((id) => {
              sessionId = id
              return unlessWall()
            })
            .then(() => {
              return request.model === undefined
                ? undefined
                : // Copilot advertises no model option; the removed unstable method still works (019 E9).
                  ctx.request('session/set_model', { sessionId, modelId: request.model })
            })
            .then(() => unlessWall())
            .then(() =>
              send(socketPath, hookRunId, {
                hook_event_name: 'UserPromptSubmit',
                session_id: sessionId,
                prompt: request.prompt,
              }).then(
                (reply) => {
                  if (!reply.allow)
                    throw new HookRefused(`the hook socket ${socketPath} refused: ${reply.reason ?? ''}`)
                },
                (error: unknown) => {
                  throw new HookRefused(
                    `the hook socket ${socketPath} could not be reached: ${(error as Error).message}`,
                  )
                },
              ),
            )
            .then(() => unlessWall())
            .then(() => {
              phase = 'prompting'
              return ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: request.prompt }] })
            })
        })
        .then(
          (response) => {
            const read = usageOf(profile, response, note)
            usage = read
            return settled(() => delivered >= seen)
              .then(() => Promise.allSettled(pending))
              .then(() => {
                if (delivered < seen && !stopping && protocolError === undefined) {
                  protocolError = `${profile.name} sent ${seen - delivered} session/update the SDK rejected`
                  note('protocol', protocolError)
                }
                if (stopping)
                  return finish({ kind: stopping.kind, detail: `${stopping.detail}; the turn was cancelled` })
                if (protocolError !== undefined) return finish({ kind: 'crash', detail: protocolError })
                if (recordFailures.length > 0) {
                  return finish({
                    kind: 'crash',
                    detail: `the run's record is incomplete — ${recordFailures.join('; ')}`,
                  })
                }
                const text = chunks.join('')
                finish(acpFailure(profile, { stopReason: (response as { stopReason?: string }).stopReason, text }))
              })
          },
          (error: unknown) => {
            if (finished) return
            const message = error instanceof Error ? error.message : String(error)
            if (stopping) return finish({ kind: stopping.kind, detail: stopping.detail })
            if (error instanceof HookRefused) return finish({ kind: 'crash', detail: message })
            if (phase === 'opening' && isAuthRequired(error)) {
              return finish({
                kind: 'never-started',
                detail: sandboxed
                  ? `${profile.name} refused its token (code ${AUTH_REQUIRED}): set a fine-grained token with Copilot Requests in \`copilot.github_token\` (a classic \`ghp_\` token is ignored)`
                  : `${profile.name} wants a sign-in (code ${AUTH_REQUIRED}): run \`${profile.loginCommand}\``,
              })
            }
            finish({ kind: 'crash', detail: withStderr(exited ? `${binary} exited: ${message}` : message) })
          },
        )

      return Effect.sync(() => {
        finished = true
        for (const timer of timers) clearTimeout(timer)
        signalGroup(child, 'SIGKILL')
      })
    })

  // Absent is today's run, untouched. A sandboxed run is wrapped, and its scope stays open until the child has
  // exited, since srt's per-command network list is cleaned up when it closes.
  const sandbox = request.sandbox
  if (sandbox === undefined) {
    return yield* runChild({ command: binary, args: profile.args, env: request.env }, false)
  }
  return yield* Effect.scoped(
    copilotSandboxedLaunch(
      sandbox,
      { argv: [binary, ...profile.args], env: request.env, cwd: request.cwd },
      (line) => request.log?.note('sandbox', line),
      options.sandbox,
    ).pipe(
      Effect.matchEffect({
        // A refusal is a crash and never `never-started`: that stands the whole conductor down as an account
        // fact (0031), and this is about the host or the project, which a person has to read.
        onFailure: (refused) =>
          Effect.succeed(
            outcomeOf(started, {
              turns: 0,
              text: null,
              sessionId: '',
              failure: { kind: 'crash', detail: refused.sentence },
            }),
          ),
        onSuccess: (launch) => runChild(launch, true),
      }),
    ),
  )
})
