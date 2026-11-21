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
import type { Invocable, RunOutcome, RunRequest, Runtime, RuntimeCapabilities, Spawned } from './runtime.ts'

export const COPILOT_CAPABILITIES: RuntimeCapabilities = {
  id: 'copilot',
  hooks: [],
  acceptsOutputSchema: false,
  canFailClosed: true,
  canRewriteToolCall: false,
  // Turns and usd are the next ticket's.
  enforces: ['wall'],
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
  if (end.stopReason === undefined) return { kind: 'crash', detail: `${profile.name} ended the turn with no stopReason` }
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

const outcomeOf = (
  started: number,
  parts: Pick<RunOutcome, 'failure' | 'text' | 'sessionId'> & { turns: number; exitCode?: number | null },
): RunOutcome => ({
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

  return yield* Effect.callback<RunOutcome>((resume) => {
    const trace = request.log
    const note = (label: string, detail?: string) => trace?.note(label, detail)
    const child = spawnAgent(spawn, binary, profile.args, { cwd: request.cwd, env: request.env })
    const ledger = createToolLedger()
    const chunks: string[] = []
    const pending = new Set<Promise<unknown>>()
    let calls = 0
    let sessionId = ''
    let phase: 'opening' | 'prompting' = 'opening'
    let ctxRef: ClientContext | undefined
    let stderrTail = ''
    let finished = false
    let wallHit = false
    let exited = false
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
          outcomeOf(started, { turns: calls, text: text === '' ? null : text, sessionId, failure, exitCode }),
        ),
      )
    }

    /** The detail every `crash` carries: what stderr last said. */
    const withStderr = (message: string) =>
      stderrTail.trim() === '' ? message : `${message}\nstderr: ${stderrTail.trim()}`

    const record = (payload: Record<string, unknown>) => {
      const sent = send(socketPath, hookRunId, { session_id: sessionId, ...payload }).then(
        (reply) => {
          if (!reply.allow) note('hook', `refused ${String(payload['tool_name'])}: ${reply.reason ?? ''}`)
        },
        (error: unknown) =>
          note('hook', `could not record ${String(payload['tool_name'])}: ${(error as Error).message}`),
      )
      pending.add(sent)
      void sent.then(() => pending.delete(sent))
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
      }
      const payload = ledger.apply(update)
      if (payload) record(payload)
    }

    /** The wall, or an abort: `session/cancel`, a wait, then the group. */
    function onWall() {
      if (finished || wallHit) return
      wallHit = true
      note('wall', 'the wall was reached: cancelling, then ending the process group')
      if (ctxRef && sessionId) void ctxRef.notify('session/cancel', { sessionId }).catch(() => undefined)
      timers.push(
        setTimeout(() => {
          signalGroup(child, 'SIGTERM')
          timers.push(
            setTimeout(() => finish({ kind: 'timeout', detail: 'the wall was reached; the group was killed' }), TERM_TO_KILL_MS),
          )
        }, cancelWaitMs),
      )
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL)
    })
    child.on('error', (error) => finish({ kind: 'crash', detail: withStderr(`could not start ${binary}: ${error.message}`) }))
    child.on('exit', (code, signal) => {
      exited = true
      if (finished) return
      if (wallHit) return finish({ kind: 'timeout', detail: 'the wall was reached' }, code)
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
        note('permission', `asked ${params.toolCall.title ?? params.toolCall.toolCallId}: ${allow ? 'allowed' : 'no allow-once offered'}`)
        return allow
          ? { outcome: { outcome: 'selected' as const, optionId: allow.optionId } }
          : { outcome: { outcome: 'cancelled' as const } }
      })
      .onNotification('session/update', ({ params }) => {
        onUpdate(params.update as unknown as SessionUpdate)
      })
      .connectWith(streamOf(child), (ctx) => {
        ctxRef = ctx
        return openSession(ctx, request.cwd)
          .then((id) => {
            sessionId = id
            return request.model === undefined
              ? undefined
              : // Copilot advertises no model option; the removed unstable method still works (019 E9).
                ctx.request('session/set_model', { sessionId: id, modelId: request.model })
          })
          .then(() =>
            send(socketPath, hookRunId, {
              hook_event_name: 'UserPromptSubmit',
              session_id: sessionId,
              prompt: request.prompt,
            }).then(
              (reply) => {
                if (!reply.allow) throw new HookRefused(`the hook socket ${socketPath} refused: ${reply.reason ?? ''}`)
              },
              (error: unknown) => {
                throw new HookRefused(`the hook socket ${socketPath} could not be reached: ${(error as Error).message}`)
              },
            ),
          )
          .then(() => {
            phase = 'prompting'
            return ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: request.prompt }] })
          })
      })
      .then(
        (response) =>
          Promise.allSettled([...pending]).then(() => {
            if (wallHit) return finish({ kind: 'timeout', detail: 'the wall was reached; the turn was cancelled' })
            const text = chunks.join('')
            finish(acpFailure(profile, { stopReason: (response as { stopReason?: string }).stopReason, text }))
          }),
        (error: unknown) => {
          if (finished) return
          const message = error instanceof Error ? error.message : String(error)
          if (wallHit) return finish({ kind: 'timeout', detail: 'the wall was reached' })
          if (error instanceof HookRefused) return finish({ kind: 'crash', detail: message })
          if (phase === 'opening' && isAuthRequired(error)) {
            return finish({
              kind: 'never-started',
              detail: `${profile.name} wants a sign-in (code ${AUTH_REQUIRED}): run \`${profile.loginCommand}\``,
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
})
