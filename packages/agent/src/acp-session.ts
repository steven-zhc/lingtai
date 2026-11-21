/**
 * The half of the ACP runtime that needs nothing of Lingtai: a profile, the
 * process, and `initialize` → `session/new` over the official SDK.
 *
 * Its own file, importing only Node built-ins, the SDK and `effect`, for the
 * reason `auth.ts` gives: the sign-in probe asks before there is a log, and
 * reaching `acp.ts` loads `hook-socket.ts` and with it `@lingtai/event-store`.
 * `AUTH_PROBES.copilot` is built on `probeSession` below.
 *
 * No `async` function here (0101 §6, the ratchet): the SDK's promises are
 * chained with `.then` and wrapped at the edge with `Effect.tryPromise`.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'

import { client, ndJsonStream, PROTOCOL_VERSION, RequestError, type ClientContext } from '@agentclientprotocol/sdk'
import type { RuntimeId, TokenCounts } from '@lingtai/domain'
import { Effect } from 'effect'

/**
 * The per-agent facts experiment 019 found differ between ACP agents.
 * One runtime is parameterised by it; this ticket has one profile.
 */
export interface AcpProfile {
  /** The runtime this profile is: what the pass records as the invocation's runtime. */
  readonly id: RuntimeId
  /** What the runtime calls itself in a message. */
  readonly name: string
  /** How `RunRequest.model` reaches the agent: Copilot's removed `session/set_model`, or a `model` config option. */
  readonly modelBy: 'set_model' | 'config-option'
  /** Whether the run reads the session's mode and switches to `mode` when it is not the one current. */
  readonly selectMode: boolean
  /** Said when `session/new` wants a sign-in, by the run and by the probe alike. */
  readonly signedOut: string
  /** The executable, when a caller names none. */
  readonly command: string
  readonly args: readonly string[]
  /**
   * The session mode to run in — never an auto mode (0.16.md). Named so a
   * reader sees what was chosen; Copilot's default is its `#agent` mode and
   * nothing is sent to select it.
   */
  readonly mode: string
  /** The reply that means a turn ended `end_turn` and did not do the work. */
  readonly failedTurn: RegExp
  /** What a person types to sign in, said back when `session/new` wants it. */
  readonly loginCommand: string
  /**
   * The `session/prompt` result's `usage` as `TokenCounts`, by this agent's own
   * meaning of each figure. A field the agent did not send stays absent, never
   * `0` (0110 §4). `note` is for the run log.
   */
  readonly tokens: (usage: Record<string, unknown>) => { tokens: TokenCounts; note?: string }
}

/** A figure the agent sent: a finite number ≥ 0. `null`, a string, a missing key are all *not said*. */
export const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined

/**
 * Copilot (019 E1): `inputTokens` already contains both cache figures, and
 * `thoughtTokens` is inside `outputTokens` — so no `reasoning`, and `fresh` is
 * the input less the cache.
 */
export function copilotTokens(usage: Record<string, unknown>): { tokens: TokenCounts; note?: string } {
  const input = count(usage['inputTokens'])
  const cacheRead = count(usage['cachedReadTokens'])
  const cacheWrite = count(usage['cachedWriteTokens'])
  const output = count(usage['outputTokens'])
  const tokens: TokenCounts = {}
  let note: string | undefined
  if (input !== undefined && cacheRead !== undefined && cacheWrite !== undefined) {
    const fresh = input - cacheRead - cacheWrite
    if (fresh >= 0) tokens.fresh = fresh
    else
      note = `inputTokens ${input} is below cachedReadTokens ${cacheRead} + cachedWriteTokens ${cacheWrite}: fresh left absent`
  }
  if (cacheRead !== undefined) tokens.cacheRead = cacheRead
  if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite
  if (output !== undefined) tokens.output = output
  return note === undefined ? { tokens } : { tokens, note }
}

/**
 * Antigravity (019 E1): `inputTokens` exclude the cache — total = input + output + cached read — and thought tokens
 * are inside `outputTokens`, so there is no `reasoning` and `fresh` is the input as sent.
 */
export function antigravityTokens(usage: Record<string, unknown>): { tokens: TokenCounts; note?: string } {
  const tokens: TokenCounts = {}
  const fresh = count(usage['inputTokens'])
  const cacheRead = count(usage['cachedReadTokens'])
  const cacheWrite = count(usage['cachedWriteTokens'])
  const output = count(usage['outputTokens'])
  if (fresh !== undefined) tokens.fresh = fresh
  if (cacheRead !== undefined) tokens.cacheRead = cacheRead
  if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite
  if (output !== undefined) tokens.output = output
  return { tokens }
}

export const COPILOT_PROFILE: AcpProfile = {
  id: 'copilot',
  modelBy: 'set_model',
  selectMode: false,
  signedOut: 'copilot wants a sign-in: run `copilot login`',
  name: 'copilot',
  command: 'copilot',
  args: ['--acp'],
  mode: 'https://agentclientprotocol.com/protocol/session-modes#agent',
  // 019 E9: *"Error: Execution failed: Model \"gpt-5\" is not available."* as the reply of an `end_turn`.
  failedTurn: /^Error: Execution failed:/,
  loginCommand: 'copilot login',
  tokens: copilotTokens,
}

export const ANTIGRAVITY_PROFILE: AcpProfile = {
  id: 'antigravity',
  name: 'antigravity',
  modelBy: 'config-option',
  selectMode: true,
  signedOut:
    'antigravity is not signed in, or Lingtai is not running in your GUI login session (started over ssh?) — ' +
    'sign in with `agy acp --login` in Terminal',
  command: 'agy',
  args: ['acp'],
  // Never `auto` (0.16.md); 019 E2: `default` asks before every execute and edit.
  mode: 'default',
  // 019 E5: its model host refused → `end_turn` with this as the reply.
  failedTurn: /^⚠ failed to construct executor/,
  loginCommand: 'agy acp --login',
  tokens: antigravityTokens,
}

/** The runtimes that speak ACP, by the profile each one runs on. */
export const ACP_PROFILES: Partial<Record<RuntimeId, AcpProfile>> = {
  copilot: COPILOT_PROFILE,
  antigravity: ANTIGRAVITY_PROFILE,
}

/** ACP's own code for *Authentication required*. */
export const AUTH_REQUIRED = -32000

export const isAuthRequired = (error: unknown): boolean =>
  error instanceof RequestError ? error.code === AUTH_REQUIRED : false

/** Where a spawn is made: `node:child_process`'s, or a test's. */
export type SpawnAgent = typeof nodeSpawn

/**
 * The agent as its own process group, so that ending the run ends what it
 * started — a shell command included. `session/cancel` is not the end of the
 * process (019 E4), and a pid is not the end of its children.
 */
export function spawnAgent(
  spawn: SpawnAgent,
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
): ChildProcess {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env as unknown as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
}

/** The child's stdio as the SDK's stream: newline-delimited JSON-RPC both ways. */
export function streamOf(child: ChildProcess) {
  return ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  )
}

/** `client(...)` as Lingtai names itself to an agent. */
export const lingtaiClient = () => client({ name: 'lingtai' })

/** `initialize`, then `session/new`; the session's id and what `session/new` answered. */
export function openSession(ctx: ClientContext, cwd: string) {
  return ctx
    .request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'lingtai', version: '0' },
    })
    .then(() => ctx.request('session/new', { cwd, mcpServers: [] }))
    .then((response) => ({ id: response.sessionId, response }))
}

/** The group, signalled. `-pid` is the group a `detached` child leads. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid === undefined) child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // Already gone.
  }
}

export type SessionProbe =
  | { kind: 'opened' }
  | { kind: 'auth-required' }
  | { kind: 'failed'; message: string }
  | { kind: 'not-installed'; message: string }
  | { kind: 'timeout' }

const PROBE_MS = 20_000

/**
 * Whether the agent will open a session: `initialize` and `session/new`, no
 * prompt sent (so nothing is billed). The process group is ended before it
 * answers either way. A promise, because `Runtime.checkAuth` is one and must
 * not need an `Effect.run*` to be (the ratchet, 0101 §6).
 */
export const probeSessionPromise = (
  profile: AcpProfile,
  binary: string,
  env: Record<string, string>,
  spawn: SpawnAgent = nodeSpawn,
): Promise<SessionProbe> =>
  new Promise<SessionProbe>((resolve) => {
    const child = spawnAgent(spawn, binary, profile.args, { cwd: tmpdir(), env })
    let done = false
    const finish = (result: SessionProbe) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signalGroup(child, 'SIGKILL')
      resolve(result)
    }
    const timer = setTimeout(() => finish({ kind: 'timeout' }), PROBE_MS)
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({ kind: error.code === 'ENOENT' ? 'not-installed' : 'failed', message: error.message }),
    )
    child.on('exit', (code) => finish({ kind: 'failed', message: `${profile.name} exited ${code} before answering` }))
    lingtaiClient()
      .connectWith(streamOf(child), (ctx) => openSession(ctx, tmpdir()))
      .then(
        () => finish({ kind: 'opened' }),
        (error: unknown) =>
          finish(
            isAuthRequired(error)
              ? { kind: 'auth-required' }
              : { kind: 'failed', message: error instanceof Error ? error.message : String(error) },
          ),
      )
  })

export const probeSession = (
  profile: AcpProfile,
  binary: string,
  env: Record<string, string>,
  spawn: SpawnAgent = nodeSpawn,
): Effect.Effect<SessionProbe> => Effect.promise(() => probeSessionPromise(profile, binary, env, spawn))
