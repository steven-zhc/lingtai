/**
 * Whether a runtime is signed in, asked of the runtime itself.
 *
 * Its own file, importing nothing but Node built-ins, because
 * `lingtai init` asks before there is a log (#186): the package's barrel loads
 * `hook-socket.ts`, which loads `@lingtai/event-store`, whose client is built at
 * module scope and throws without a database URL. So a machine that has only
 * just installed could not ask which agent it has without first saying which
 * database it wants — the order the ticket forbids.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { RuntimeId } from '@lingtai/domain'
import { Effect } from 'effect'

import type { AuthState, AuthStatus } from './runtime.ts'

/**
 * What a probe's child did, gathered by the probe and judged by the
 * classifiers below — which are pure, so every outcome is a unit test and
 * none needs a spawned binary (0060 §1, #735).
 */
export type ProbeEnd =
  | { kind: 'spawn-error'; code: string | undefined; message: string }
  | { kind: 'timeout' }
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; out: string; err: string }

function status(state: AuthState, detail: string, method: string | null = null): AuthStatus {
  return { state, loggedIn: state === 'signed-in', method, detail }
}

function unreadable(end: ProbeEnd, what: string): AuthStatus | null {
  if (end.kind === 'timeout') return status('did-not-start', `${what} did not answer in 20s`)
  if (end.kind === 'spawn-error') {
    return status(end.code === 'ENOENT' ? 'not-installed' : 'did-not-start', end.message)
  }
  return null
}

/**
 * `claude auth status`, judged. **Signed out is positively recognised**: the
 * JSON parsed and said `loggedIn: false`. Output that cannot be read, or JSON
 * that says neither, is `did-not-start` — a probe nobody could read is never
 * told to sign in (#735).
 */
export function classifyClaudeAuth(end: ProbeEnd): AuthStatus {
  const early = unreadable(end, 'claude auth status')
  if (early) return early
  if (end.kind !== 'exited') return status('did-not-start', 'no output')
  const { out, err } = end
  // Defensive for the same reason `parseResult` is: a wrapper or a
  // warning can put a line in front of the JSON.
  const brace = out.indexOf('{')
  if (brace < 0) return status('did-not-start', (err.trim() || out.trim() || 'no output').slice(0, 300))
  try {
    const parsed = JSON.parse(out.slice(brace)) as { loggedIn?: unknown; authMethod?: string }
    const method = parsed.authMethod ?? null
    if (parsed.loggedIn === true) return status('signed-in', `signed in via ${parsed.authMethod}`, method)
    if (parsed.loggedIn === false) return status('signed-out', 'not signed in', method)
    return status('did-not-start', out.slice(0, 300), method)
  } catch {
    return status('did-not-start', out.slice(0, 300))
  }
}

/**
 * `codex login status`, judged. Exit 0 is signed in; **signed out is exit 1
 * and output saying so**. Any other exit, a signal (a `node` that aborts
 * before Codex runs), or exit 1 with other output is `did-not-start`.
 */
export function classifyCodexLogin(end: ProbeEnd): AuthStatus {
  const early = unreadable(end, 'codex login status')
  if (early) return early
  if (end.kind !== 'exited') return status('did-not-start', 'no output')
  const detail = ((end.out + end.err).trim() || 'no output').slice(0, 300)
  if (end.code === 0) return status('signed-in', detail)
  if (end.code === 1 && /not logged in/i.test(detail)) return status('signed-out', detail)
  return status('did-not-start', detail)
}

/**
 * Spawn `binary args`, and finish with what happened — the first thing to
 * settle wins. Interrupting it kills the child and clears the timer.
 */
function probe(
  binary: string,
  args: string[],
  env: Record<string, string>,
  how: { readonly timeoutMs?: number; readonly spawn?: typeof spawn; readonly cwd?: string } = {},
): Effect.Effect<ProbeEnd> {
  const spawnChild = how.spawn ?? spawn
  return Effect.callback<ProbeEnd>((resume) => {
    const child = spawnChild(binary, args, {
      ...(how.cwd === undefined ? {} : { cwd: how.cwd }),
      // Cast for a compiler that widens `ProcessEnv` — Next's does, and the
      // board reaches this through `currentRecipe`'s sign-in detection.
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => (err += c.toString()))

    // A hung probe must not hang the doctor.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resume(Effect.succeed({ kind: 'timeout' }))
    }, how.timeoutMs ?? 20_000)

    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resume(Effect.succeed({ kind: 'spawn-error', code: e.code, message: e.message }))
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resume(Effect.succeed({ kind: 'exited', code, signal, out, err }))
    })

    return Effect.sync(() => {
      clearTimeout(timer)
      child.kill('SIGKILL')
    })
  })
}

/**
 * What `--version` printed, judged (#929): the first non-empty stdout line,
 * trimmed and capped at 200 characters, only for a clean exit. Everything else
 * is `null` — stderr is never the answer, and a probe nobody could read is not
 * a version.
 */
export function reportedVersion(end: ProbeEnd): string | null {
  if (end.kind !== 'exited' || end.code !== 0) return null
  const line = end.out.split(/\r?\n/).find((l) => l.trim() !== '')
  return line === undefined ? null : line.trim().slice(0, 200)
}

/** `binary --version`, as the binary printed it, in `env`. Asked per call; never cached. */
export const runtimeVersionEffect = Effect.fn('agent.version')(function* (
  binary: string,
  env: Record<string, string>,
  spawnChild?: typeof spawn,
  cwd?: string,
) {
  const end = yield* probe(binary, ['--version'], env, {
    timeoutMs: 5_000,
    ...(spawnChild ? { spawn: spawnChild } : {}),
    ...(cwd === undefined ? {} : { cwd }),
  })
  return reportedVersion(end)
})

/**
 * What the credential store says about when the login's token expires. Never
 * the token: `why` is a phrase this file chose, never text read from a store or
 * from an error, because both can carry a fragment of the secret.
 */
export type StoredExpiry =
  | { kind: 'expires'; at: number; from: 'keychain' | 'file' }
  | { kind: 'unreadable'; why: string }

/**
 * `claudeAiOauth.expiresAt` out of a credentials blob (epoch ms), or `null`
 * when the text is not JSON, has no `claudeAiOauth`, or has no finite
 * `expiresAt`. Nothing else is returned from it.
 */
export function expiryFromCredentials(text: string): number | null {
  const brace = text.indexOf('{')
  if (brace < 0) return null
  try {
    const parsed = JSON.parse(text.slice(brace)) as { claudeAiOauth?: { expiresAt?: unknown } | null }
    const at = parsed.claudeAiOauth?.expiresAt
    return typeof at === 'number' && Number.isFinite(at) ? at : null
  } catch {
    // Not the error's message: V8 quotes the text it choked on.
    return null
  }
}

/** Whether `auth status`'s answer is one a stored expiry can overrule. */
export function needsStoredExpiry(status: AuthStatus): boolean {
  return status.state === 'signed-in' && status.method === 'claude.ai'
}

/**
 * `claude auth status` says `loggedIn: true` for a token that expired and
 * cannot refresh (017). A stored expiry in the past, read **after** that call,
 * makes it signed out. A store nobody could read changes nothing (#735).
 */
export function withStoredExpiry(status: AuthStatus, stored: StoredExpiry, now: number): AuthStatus {
  if (!needsStoredExpiry(status) || stored.kind !== 'expires' || stored.at > now) return status
  const where = stored.from === 'keychain' ? 'the Keychain' : '~/.claude/.credentials.json'
  return {
    state: 'signed-out',
    loggedIn: false,
    method: status.method,
    detail: `signed in via claude.ai, but the token in ${where} expired at ${new Date(stored.at).toISOString()} and did not refresh — sign in again: run \`claude\`, then /login`,
  }
}

/**
 * Judge `claude auth status`, and only when it says signed in ask the store —
 * after it, never before, because that call refreshes a token that can be.
 */
export const claudeAuthThenStore = Effect.fn('agent.auth.store')(function* (
  askStatus: Effect.Effect<ProbeEnd>,
  readStore: Effect.Effect<StoredExpiry>,
  now: () => number = Date.now,
) {
  const judged = classifyClaudeAuth(yield* askStatus)
  if (!needsStoredExpiry(judged)) return judged
  return withStoredExpiry(judged, yield* readStore, now())
})

/**
 * Where this session's Claude Code keeps its login: on macOS the Keychain item
 * when it answers, otherwise `~/.claude/.credentials.json` (017). The probe's
 * own `env`, because macOS finds an item by who is asking. IO, no unit test.
 */
const readClaudeStoredExpiry = (env: Record<string, string>): Effect.Effect<StoredExpiry> =>
  Effect.gen(function* () {
    if (process.platform === 'darwin') {
      const end = yield* probe('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], env, {
        timeoutMs: 5_000,
      })
      if (end.kind === 'exited' && end.code === 0 && end.out.includes('claudeAiOauth')) {
        const at = expiryFromCredentials(end.out)
        // The desktop session ignores the file when the Keychain holds a login.
        return at === null
          ? ({ kind: 'unreadable', why: 'no claudeAiOauth.expiresAt in the Keychain item' } as const)
          : ({ kind: 'expires', at, from: 'keychain' } as const)
      }
    }
    const path = join(env.HOME ?? homedir(), '.claude', '.credentials.json')
    const text = yield* Effect.tryPromise(() => readFile(path, 'utf8')).pipe(Effect.option)
    if (text._tag === 'None') return { kind: 'unreadable', why: 'credentials file unreadable' } as const
    const at = expiryFromCredentials(text.value)
    return at === null
      ? ({ kind: 'unreadable', why: 'no claudeAiOauth.expiresAt in the file' } as const)
      : ({ kind: 'expires', at, from: 'file' } as const)
  })

/**
 * `claude auth status`, in the environment a run would actually get, and then
 * the stored token's expiry.
 *
 * **Not free, and `loggedIn` is not validity** (017). `claude auth status` may
 * refresh a refreshable token, which is a call to `platform.claude.com` though
 * not to the model; and it answers `loggedIn: true` for a token that expired
 * and cannot refresh. So the store is read after it — before it, every login
 * merely due for refresh would read as signed out — and an `expiresAt` in the
 * past makes it signed out. A store that cannot be read leaves the answer as
 * it was. Verified against both environments: without `USER` it answers
 * `{loggedIn: false, authMethod: "none"}`, with it
 * `{loggedIn: true, authMethod: "claude.ai"}`.
 *
 * **The exit code is 0 either way**, so the field is the answer and the
 * code is not. Reading the code would have made this check pass in exactly
 * the situation it exists to catch.
 */
export const claudeCodeAuthEffect = Effect.fn('agent.auth')(function* (binary: string, env: Record<string, string>) {
  return yield* claudeAuthThenStore(probe(binary, ['auth', 'status'], env), readClaudeStoredExpiry(env))
})

/** The Effect above, as the promise `Runtime.checkAuth` still is. */
export function claudeCodeAuth(binary: string, env: Record<string, string>): Promise<AuthStatus> {
  return Effect.runPromise(claudeCodeAuthEffect(binary, env))
}

/**
 * `codex login status`, in the environment a run would get.
 *
 * Real, though the adapter is not: which runtimes are signed in decides what
 * setup can offer as the writer's default. With several signed in it is the
 * first in `RuntimeId`'s own order, not whichever probe finished first. The
 * exit code is the answer — 0 `Logged in using …`, 1 `Not logged in` — but
 * only together with the output (see `classifyCodexLogin`).
 */
export const codexAuthEffect = Effect.fn('agent.auth')(function* (binary: string, env: Record<string, string>) {
  return classifyCodexLogin(yield* probe(binary, ['login', 'status'], env))
})

/** The Effect above, as the promise `Runtime.checkAuth` and the board still await (a listed face, #790). */
export function codexAuth(binary: string, env: Record<string, string>): Promise<AuthStatus> {
  return Effect.runPromise(codexAuthEffect(binary, env))
}

/**
 * Every runtime asked whether it is signed in, **before there is a log**.
 *
 * The second exhaustive table over `RuntimeId`, and the duplication is forced
 * rather than an oversight (`#313`). `RUNTIMES` in `runtimes.ts` is the one place
 * a runtime is *constructed*, and `RUNTIMES[id]().checkAuth` is this same probe —
 * but reaching it loads `claude-code.ts`, which loads `hook-socket.ts` for
 * `observedCall`, which loads `@lingtai/event-store`, whose client is built at
 * module scope and throws without a database URL. That is the whole reason this
 * file exists (see the header), and it is why `lingtai init` cannot ask which
 * agent a machine has by way of the factory table.
 *
 * What the duplication costs is bounded by the type: `Record<RuntimeId, …>` makes
 * a third runtime a `tsc` error **here as well as there**, so the two cannot
 * drift into disagreeing about which runtimes exist. `unit/runtimes.test.ts`
 * asserts both are exhaustive.
 *
 * **Keyed, not zipped.** It was `Promise.all([claudeCodeAuth(…), codexAuth(…)])`
 * indexed positionally against a written-out list of ids, which is one careless
 * insertion away from reporting Codex's answer under Claude Code's name.
 */
export const AUTH_PROBES: Record<RuntimeId, (env: Record<string, string>) => Effect.Effect<AuthStatus>> = {
  'claude-code': (env) => claudeCodeAuthEffect('claude', env),
  codex: (env) => codexAuthEffect('codex', env),
}

/** In the enum's own order, so a caller's list is never written by hand. */
export const askEveryRuntimeEffect = (env: Record<string, string>) =>
  Effect.forEach(RuntimeId.options, (id) => AUTH_PROBES[id](env).pipe(Effect.map((status) => ({ id, status }))), {
    concurrency: 'unbounded',
  })
