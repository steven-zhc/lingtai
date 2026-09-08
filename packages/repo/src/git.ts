/**
 * Running git, and where Lingtai keeps what it clones.
 *
 * **The integrator never uses your checkout.** A worktree cut from a clone
 * Lingtai owns is the blast radius; the operator's own working copy is not
 * touched, read or written. Uncommitted work in it is what made a merge fail
 * with no log, no comment and no label — five re-runs and about $29 on #58/#59.
 */
import { execFile } from "node:child_process";
import { Data, Effect } from "effect";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * A token, or something that will produce a current one.
 *
 * The function form is what real runs use. An installation token lasts an hour
 * and a run may last two, so anything holding a string taken at the start is
 * holding something that expires before the integrator pushes. The string form
 * stays for tests, which do not talk to GitHub at all.
 */
export type TokenSource = string | (() => Promise<string>);

export interface GitRunOptions {
  cwd?: string;
  /**
   * An installation token, passed through `GIT_CONFIG_*` environment variables
   * rather than on the command line or in `.git/config`.
   *
   * argv is visible in `ps`; `.git/config` outlives the run and would be
   * readable from inside the worktree by the agent itself. The environment of a
   * single child process is neither.
   */
  token?: TokenSource;
  env?: NodeJS.ProcessEnv;
}

export async function git(args: string[], options: GitRunOptions = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  // Resolved here, per invocation, rather than once by the caller — that is the
  // whole point of accepting a function.
  const token = typeof options.token === "function" ? await options.token() : options.token;
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    env["GIT_CONFIG_COUNT"] = "1";
    env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader";
    env["GIT_CONFIG_VALUE_0"] = `AUTHORIZATION: basic ${basic}`;
  }
  // Never prompt: a hung credential prompt inside a daemon is indistinguishable
  // from a slow clone.
  env["GIT_TERMINAL_PROMPT"] = "0";

  const { stdout } = await exec("git", args, { cwd: options.cwd, env, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Anything this package could not do to a repository, in a channel a caller
 * can see.
 *
 * [0025](../../../doc/decisions/0025-the-conversion-past-the-seam.md): the
 * point of the conversion is not that `git` returns an `Effect` — it is that a
 * caller's type says this can fail. `Effect.promise` erases exactly that, which
 * is why the seam it was holding stopped one frame in.
 *
 * One error for the package rather than one per function: the *operation* is a
 * field, so a new call site adds a value and not a type.
 */
export class RepoFailed extends Data.TaggedError("RepoFailed")<{
  /** `git fetch`, `provision`, `integrate` — what was being attempted. */
  readonly operation: string;
  readonly detail: string;
}> {}

/**
 * The same command, as an `Effect`.
 *
 * `git` itself stays a promise: `apps/board/src/app/actions.ts` is a Next.js
 * server action and has no runtime to run an `Effect` in. The boundary 0023
 * drew is the port, not the process.
 */
export const gitEffect = (
  args: string[],
  options: GitRunOptions = {},
): Effect.Effect<string, RepoFailed> =>
  Effect.tryPromise({
    try: () => git(args, options),
    catch: (err) =>
      new RepoFailed({ operation: `git ${args[0] ?? ""}`, detail: (err as Error).message }),
  });
