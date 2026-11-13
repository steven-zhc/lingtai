/**
 * Running git, and where Lingtai keeps what it clones.
 *
 * **The integrator never uses your checkout.** A worktree cut from a clone
 * Lingtai owns is the blast radius; the operator's own working copy is not
 * touched, read or written. Uncommitted work in it is what made a merge fail
 * with no log, no comment and no label — five re-runs and about $29 on #58/#59.
 */
import { execFile } from 'node:child_process'

import { Data, Effect } from 'effect'

/**
 * A token, or something that will produce a current one.
 *
 * The function form is what real runs use. An installation token lasts an hour
 * and a run may last two, so anything holding a string taken at the start is
 * holding something that expires before the integrator pushes. The string form
 * stays for tests, which do not talk to GitHub at all.
 */
export type TokenSource = string | (() => Promise<string>)

export interface GitRunOptions {
  cwd?: string
  /** Preserve leading and trailing whitespace for blob content and line positions. */
  trimOutput?: boolean
  /**
   * An installation token, passed through `GIT_CONFIG_*` environment variables
   * rather than on the command line or in `.git/config`.
   *
   * argv is visible in `ps`; `.git/config` outlives the run and would be
   * readable from inside the worktree by the agent itself. The environment of a
   * single child process is neither.
   */
  token?: TokenSource
  env?: NodeJS.ProcessEnv
  /** Kills the child when it aborts; the promise then rejects. */
  signal?: AbortSignal
}

/**
 * What `git` is spawned with, given the already-resolved token.
 *
 * A call that carries a token also runs with `core.hooksPath=/dev/null`, so no
 * code from the managed repository (a husky `pre-push`, say) runs while the
 * token is in the child's environment. The `-c` is argv and carries no secret;
 * git reads it only before the subcommand, so it goes first.
 */
export function gitInvocation(
  args: string[],
  token: string | undefined,
  baseEnv: NodeJS.ProcessEnv,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  let argv = args
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    env['GIT_CONFIG_COUNT'] = '1'
    env['GIT_CONFIG_KEY_0'] = 'http.https://github.com/.extraheader'
    env['GIT_CONFIG_VALUE_0'] = `AUTHORIZATION: basic ${basic}`
    argv = ['-c', 'core.hooksPath=/dev/null', ...args]
  }
  // Never prompt: a hung credential prompt inside a daemon is indistinguishable
  // from a slow clone.
  env['GIT_TERMINAL_PROMPT'] = '0'
  // English stderr, so `isUnreachable`, `PUSH_REJECTED` and `BASE_PROTECTED` read git's words (#1029).
  env['LC_ALL'] = 'C'
  return { args: argv, env }
}

/**
 * Anything this package could not do to a repository, in a channel a caller
 * can see.
 *
 * [0026](../../../doc/decisions-archive/0026-the-conversion-past-the-seam.md): the
 * point of the conversion is not that `git` returns an `Effect` — it is that a
 * caller's type says this can fail. `Effect.promise` erases exactly that, which
 * is why the seam it was holding stopped one frame in.
 *
 * One error for the package rather than one per function: the *operation* is a
 * field, so a new call site adds a value and not a type.
 */
export class RepoFailed extends Data.TaggedError('RepoFailed')<{
  /** `git fetch`, `provision`, `integrate` — what was being attempted. */
  readonly operation: string
  readonly detail: string
  /** The argv as passed, without the `-c core.hooksPath` prefix. */
  readonly command?: readonly string[]
  /** `git`'s exit code; null when there was none (spawn failed, killed, `maxBuffer`, aborted). */
  readonly exitCode?: number | null
  readonly stdout?: string
  readonly stderr?: string
}> {
  /** So a face's rejection reads as `execFile`'s own error did. */
  override get message(): string {
    return this.detail
  }
}

/**
 * The same command, as an `Effect`, and the one place `git` is spawned.
 *
 * **This is `Effect.callback` and not `Effect.tryPromise`, on purpose.**
 * `tryPromise` aborts the signal on interrupt and returns without waiting, and
 * Node's `execFile` reports the abort at once without waiting for the child to
 * exit. A SIGTERMed `git fetch` still holds its ref lock for a moment, and the
 * mirror permit (`mirror-lock.ts`: "one would let a second writer start beside
 * a holder whose git is still running"; 0122 §6) is released when this Effect
 * ends. So the canceller returned below waits for the child's `close`: an
 * interrupt finishes only once git has exited and removed its own locks.
 */
export const gitEffect = (args: string[], options: GitRunOptions = {}): Effect.Effect<string, RepoFailed> => {
  const operation = `git ${args[0] ?? ''}`
  const fail = (detail: string, rest: Partial<ConstructorParameters<typeof RepoFailed>[0]> = {}) =>
    new RepoFailed({ operation, detail, command: args, exitCode: null, ...rest })
  return Effect.gen(function* () {
    // Resolved here, per invocation, rather than once by the caller — that is the
    // whole point of accepting a function.
    const source = options.token
    const token = yield* typeof source === 'function'
      ? Effect.tryPromise({
          try: () => source(),
          catch: (err) => fail(err instanceof Error ? err.message : String(err)),
        })
      : Effect.succeed(source)
    const invocation = gitInvocation(args, token, options.env ?? process.env)
    return yield* Effect.callback<string, RepoFailed>((resume, signal) => {
      const signals = [signal, options.signal].filter((s): s is AbortSignal => s !== undefined)
      let child: ReturnType<typeof execFile>
      try {
        child = execFile(
          'git',
          invocation.args,
          {
            cwd: options.cwd,
            env: invocation.env,
            maxBuffer: 32 * 1024 * 1024,
            signal: AbortSignal.any(signals),
          },
          (err, stdout, stderr) => {
            if (err === null) {
              resume(Effect.succeed(options.trimOutput === false ? stdout : stdout.trim()))
              return
            }
            const code = (err as { code?: unknown }).code
            resume(
              Effect.fail(
                fail(err.message ?? String(err), {
                  exitCode: typeof code === 'number' ? code : null,
                  stdout,
                  stderr,
                }),
              ),
            )
          },
        )
      } catch (err) {
        // `execFile` throws synchronously for E2BIG and the like; that is a
        // typed failure like any other, not a defect.
        resume(Effect.fail(fail(err instanceof Error ? err.message : String(err))))
        return Effect.void
      }
      // The canceller: runs on interrupt, after the signal has sent SIGTERM, and
      // holds the fiber until the child is gone.
      return Effect.callback<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done(Effect.void)
          return
        }
        child.once('close', () => done(Effect.void))
      })
    })
  }).pipe(Effect.withSpan('repo.git', { attributes: { 'git.subcommand': args[0] ?? '' } }))
}

/**
 * The promise face. `apps/board/src/app/actions.ts` is a Next.js server action
 * and keeps it by 0101 §7: a face is only a `runPromise` over the Effect.
 */
export function git(args: string[], options: GitRunOptions = {}): Promise<string> {
  return Effect.runPromise(gitEffect(args, options))
}
