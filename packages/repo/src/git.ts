/**
 * Running git, and where Lingtai keeps what it clones.
 *
 * **The integrator never uses your checkout.** A worktree cut from a clone
 * Lingtai owns is the blast radius; the operator's own working copy is not
 * touched, read or written. Uncommitted work in it is what made a merge fail
 * with no log, no comment and no label — five re-runs and about $29 on #58/#59.
 */
import { execFile } from "node:child_process";
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
