/**
 * `lingtai doctor`'s sandbox canary (#1159): a command run through the same `Sandbox.wrap` a run gets, to
 * measure that the policy holds on this host rather than to read that it was configured.
 *
 * Four commands, each wrapped with the built-in policy and nothing added to it. Two are *negative* — a planted
 * file under a denied path, a host off the allowlist — and must fail; two are *positive controls* run through
 * the same wrap — a file in the canary's own worktree, an allowlisted host — and must succeed. **A refusal only
 * counts when the same wrap can succeed**: a missing `curl`, a wrong path or an argv that never ran all exit
 * non-zero and would otherwise read as *refused*. So a failing positive is *could not run* whatever the
 * negatives did, and so is anything that stops a command being run at all: the canary fails closed.
 *
 * It judges by exit status and by whether the planted file's random content reached stdout, never by srt's
 * messages. It depends on `Pick<SandboxApi, 'wrap' | 'policyOf'>` and nothing lower, so it cannot build a
 * policy of its own: what it measures is what a run gets.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { processSandbox } from '@lingtai/conductor/sandbox-service'
import { cacheDir, within, type HostFacts, type SandboxApi } from '@lingtai/sandbox'
import { readHost } from '@lingtai/sandbox/host'
import { Cause, Effect } from 'effect'

/** The project name the canary wraps under; its cache directory is `<stateDir>/cache/<this>`. */
export const CANARY_PROJECT = 'lingtai-doctor-canary'

/** What one canary run found. */
export type CanaryResult =
  | { readonly kind: 'held' }
  | { readonly kind: 'leaked'; readonly which: readonly ('read' | 'network')[] }
  | { readonly kind: 'could-not-run'; readonly why: string }

/** How one spawned command ended: its exit code and what it wrote to stdout. */
export interface CanaryRun {
  readonly exit: number | null
  readonly stdout: string
}

/** Everything the canary does to the machine, so a unit test touches none of it. */
export interface CanaryIo {
  /** A fresh directory with a random name under `parent`, which is created when absent. */
  readonly makeDir: (parent: string, prefix: string) => Effect.Effect<string, unknown>
  readonly write: (path: string, content: string) => Effect.Effect<void, unknown>
  /** Removes a path and everything under it. Never fails: a leftover is harmless. */
  readonly remove: (path: string) => Effect.Effect<void>
  /** Spawns `argv` with `env` and no shell. Fails on a spawn error or a timeout. */
  readonly run: (
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    timeoutMs: number,
  ) => Effect.Effect<CanaryRun, unknown>
}

const COMMAND_TIMEOUT_MS = 20_000

/** `curl` follows the proxy srt puts in the environment; Node's `net` and `fetch` do not. No `--fail`: the question is whether the connection was made. */
const connect = (url: string): readonly string[] => ['curl', '-sS', '-o', '/dev/null', '--max-time', '10', url]

const said = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null && 'reason' in e) {
    const sentences = 'sentences' in e && Array.isArray(e.sentences) ? (e.sentences as string[]) : []
    return [String((e as { reason: unknown }).reason), ...sentences].join('; ')
  }
  return String(e)
}

const couldNot = (why: string): CanaryResult => ({ kind: 'could-not-run', why })

/**
 * Runs the canary. `host` defaults to the real facts; every other effect on the machine is `io`'s.
 * Never fails: a failure of any kind is `could-not-run`, and only an interrupt passes through.
 */
export const runCanary = (
  sandbox: Pick<SandboxApi, 'wrap' | 'policyOf'>,
  io: CanaryIo,
  host: Effect.Effect<HostFacts, unknown> = readHost,
): Effect.Effect<CanaryResult> =>
  Effect.scoped(
    Effect.gen(function* () {
      const facts = yield* host
      const tempDir = (parent: string, prefix: string) =>
        Effect.acquireRelease(io.makeDir(parent, prefix), (dir) => io.remove(dir))
      // A cache directory left by a killed doctor goes first; `wrap` makes it again, and it goes afterwards.
      const cache = cacheDir(facts, CANARY_PROJECT)
      yield* io.remove(cache)
      yield* Effect.addFinalizer(() => io.remove(cache))

      const worktree = yield* tempDir(facts.tmpdir, 'lingtai-canary-worktree-')
      const mirror = yield* tempDir(facts.tmpdir, 'lingtai-canary-mirror-')
      // Under the state directory, which the policy denies whole, and outside the worktree, the mirror and the
      // cache, which `filesystemFor` allows back for reading: a file under one of those would read.
      const plantedDir = yield* tempDir(facts.stateDir, 'doctor-canary-')

      const planted = join(plantedDir, 'secret')
      const inWorktree = join(worktree, 'canary')
      const secret = randomBytes(16).toString('hex')
      const visible = randomBytes(16).toString('hex')
      yield* io.write(planted, secret)
      yield* io.write(inWorktree, visible)

      const policy = sandbox.policyOf({ project: CANARY_PROJECT, worktree, mirror })
      if (!policy.denyRead.some((d) => within(d, planted)) || policy.allowRead.some((a) => within(a, planted))) {
        return couldNot('the planted file is not under a path the policy denies, so reading it would measure nothing')
      }

      // `wrap`'s releases unregister the network lists and clean srt's per-command state, so the child must
      // have exited before the scope it was wrapped in closes.
      const runWrapped = (command: readonly string[]) =>
        Effect.scoped(
          Effect.gen(function* () {
            const wrapped = yield* sandbox.wrap({
              project: CANARY_PROJECT,
              worktree,
              mirror,
              command,
              env: { PATH: process.env['PATH'] ?? '', HOME: facts.home },
            })
            return yield* io.run(wrapped.argv, wrapped.env, COMMAND_TIMEOUT_MS)
          }),
        )

      const attempt = (name: string, command: readonly string[]) =>
        runWrapped(command).pipe(
          Effect.map((run) => ({ ok: true as const, run })),
          Effect.catch((e) => Effect.succeed({ ok: false as const, why: `${name}: ${said(e)}` })),
        )

      const readPlanted = yield* attempt('read of the planted file', ['/bin/cat', planted])
      const readVisible = yield* attempt('read of the worktree file', ['/bin/cat', inWorktree])
      const reachOff = yield* attempt('connection to example.com', connect('https://example.com/'))
      const reachOn = yield* attempt('connection to github.com', connect('https://github.com/'))

      // A command that was never run says nothing about a refusal: fail closed, positives first.
      const positives = [
        !readVisible.ok
          ? readVisible.why
          : readVisible.run.exit !== 0 || !readVisible.run.stdout.includes(visible)
            ? 'the worktree file could not be read through the policy'
            : undefined,
        !reachOn.ok
          ? reachOn.why
          : reachOn.run.exit !== 0
            ? 'github.com, which the policy allows, could not be reached'
            : undefined,
      ].filter((s): s is string => s !== undefined)
      if (positives.length > 0) return couldNot(`the canary could not run — ${positives.join('; ')}`)
      if (!readPlanted.ok) return couldNot(`the canary could not run — ${readPlanted.why}`)
      if (!reachOff.ok) return couldNot(`the canary could not run — ${reachOff.why}`)

      const which: ('read' | 'network')[] = []
      if (readPlanted.run.exit === 0 || readPlanted.run.stdout.includes(secret)) which.push('read')
      if (reachOff.run.exit === 0) which.push('network')
      return which.length === 0 ? ({ kind: 'held' } as const) : ({ kind: 'leaked', which } as const)
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.succeed(couldNot(`the canary could not run — ${said(Cause.squash(cause))}`)),
    ),
  )

/** The live `CanaryIo`: `fs/promises` and `child_process` behind Effects, no `async` function and no `spawnSync`. */
export const liveCanaryIo: CanaryIo = {
  makeDir: (parent, prefix) =>
    Effect.tryPromise({
      try: () => mkdir(parent, { recursive: true }).then(() => mkdtemp(join(parent, prefix))),
      catch: (e) => e,
    }),
  write: (path, content) =>
    Effect.tryPromise({ try: () => writeFile(path, content, { mode: 0o600 }), catch: (e) => e }),
  remove: (path) =>
    Effect.tryPromise({ try: () => rm(path, { recursive: true, force: true }), catch: (e) => e }).pipe(Effect.ignore),
  run: (argv, env, timeoutMs) =>
    Effect.callback<CanaryRun, unknown>((resume) => {
      const [file, ...args] = argv
      if (file === undefined) {
        resume(Effect.fail(new Error('an empty argv')))
        return
      }
      const child = spawn(file, args, { env: { ...env }, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
      let stdout = ''
      let timedOut = false
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < 65_536) stdout += chunk
      })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      child.once('error', (e) => {
        clearTimeout(timer)
        resume(Effect.fail(e))
      })
      child.once('close', (exit) => {
        clearTimeout(timer)
        resume(timedOut ? Effect.fail(new Error('timed out')) : Effect.succeed({ exit, stdout }))
      })
      return Effect.sync(() => {
        clearTimeout(timer)
        child.kill('SIGKILL')
      })
    }),
}

/** The real canary: this process's one `Sandbox` service, never closed (it is `conduct.ts`'s too), and the live io. */
export const liveCanary = (): Effect.Effect<CanaryResult> =>
  processSandbox.pipe(
    Effect.flatMap((sandbox) => runCanary(sandbox, liveCanaryIo)),
    Effect.catch((e) => Effect.succeed(couldNot(`the canary could not run — ${said(e)}`))),
  )
