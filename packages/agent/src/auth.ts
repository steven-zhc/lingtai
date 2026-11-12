/**
 * Whether a runtime is signed in, asked of the runtime itself.
 *
 * Its own file, importing nothing but `node:child_process`, because
 * `lingtai init` asks before there is a log (#186): the package's barrel loads
 * `hook-socket.ts`, which loads `@lingtai/event-store`, whose client is built at
 * module scope and throws without a database URL. So a machine that has only
 * just installed could not ask which agent it has without first saying which
 * database it wants — the order the ticket forbids.
 */
import { spawn } from 'node:child_process'

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
 * `claude auth status`, in the environment a run would actually get.
 *
 * Free — it reads the credential and does not call the API. Verified
 * against both environments: without `USER` it answers
 * `{loggedIn: false, authMethod: "none"}`, with it
 * `{loggedIn: true, authMethod: "claude.ai"}`.
 *
 * **The exit code is 0 either way**, so the field is the answer and the
 * code is not. Reading the code would have made this check pass in exactly
 * the situation it exists to catch.
 */
export const claudeCodeAuthEffect = Effect.fn('agent.auth')(function* (binary: string, env: Record<string, string>) {
  return classifyClaudeAuth(yield* probe(binary, ['auth', 'status'], env))
})

/** The Effect above, as the promise `Runtime.checkAuth` still is (a listed face, #790). */
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

/** The Effect above, as the promise `packages/setup` still awaits (a listed face, #790). */
export function askEveryRuntime(env: Record<string, string>): Promise<{ id: RuntimeId; status: AuthStatus }[]> {
  return Effect.runPromise(askEveryRuntimeEffect(env))
}
