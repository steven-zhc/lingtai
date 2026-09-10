/**
 * The hook wiring, rendered by the conductor **outside the worktree**.
 *
 * That location is the point. `settings.json` inside the repository would be a
 * file the agent can edit, and an agent that can edit its own hook configuration
 * has no hook configuration. Claude Code takes `--settings <path>`, so the file
 * lives beside the socket in Lingtai's own state directory, and the worktree
 * never contains it.
 *
 * What is rendered is the five hooks both runtimes have plus Claude Code's extra
 * four, all pointing at the same binary. The adapter contract is the
 * intersection (doc/decisions/0007-dual-runtime.md); the extras are bonus signal
 * and the system works without them.
 */
import { Data, Effect } from "effect";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { stateDir } from "@lingtai/env";

/**
 * The four both runtimes have, then Claude Code's extras.
 *
 * `PreToolUse` was here and is not any more. Lingtai refuses no tool call
 * (ADR 0016 §6), so it had no job left — and it was the only hook on the hot
 * path, one round trip per tool call against a 20ms budget of which process
 * startup alone was 17ms ([ADR 0011](../../../doc/decisions/0011-hook-latency-is-runtime-startup.md)).
 * Dropping it removes the hot path rather than optimising it.
 */
export const INTERSECTION_HOOKS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
] as const;

export const CLAUDE_ONLY_HOOKS = ["SessionEnd", "PreCompact", "Notification"] as const;

export interface HookWiring {
  /** `--settings` for `claude -p`. Outside the worktree, always. */
  settingsPath: string;
  /**
   * `--settings` for an agent that is **not** this run: the gate reviewer.
   *
   * The hooks and the environment that answers them are one thing, and handing
   * over half of it is worse than handing over neither. `settingsPath` names a
   * `UserPromptSubmit` hook that denies unless `LINGTAI_HOOK_SOCKET` and
   * `LINGTAI_HOOK_RUN_ID` are set — which is what makes the recorder fail
   * closed — and the gates are given the recipe's environment, which has no
   * such names in it. The reviewer therefore never got as far as reading the
   * diff: its whole answer was *"UserPromptSubmit operation blocked by hook"*,
   * which is not readable as findings, so `proposed:review` refused every
   * change it was asked about.
   *
   * Wiring it to the run's socket instead would be the wrong repair. The
   * reviewer runs under `<runId>:review:<gate>` precisely so that it is cold
   * (`agent-gate.ts`), and pointing its hook at the implementer's run would
   * file the reviewer's reading of the diff on the implementer's stream, after
   * that run had already ended. There is nothing to record here: what a gate
   * agent did is a `GateResolved` with its findings, its turns and its cost.
   */
  unhookedSettingsPath: string;
  socketPath: string;
  /** Environment the runtime child needs so the hook can find the conductor. */
  env: Record<string, string>;
}

/** macOS caps `sun_path` at 104 bytes; Linux at 108. Neither reports why. */
export const SUN_PATH_MAX = 104;

/**
 * Where a run's hook socket lives.
 *
 * **Not under `home`.** The first version put it there and `listen` failed with
 * a bare `EINVAL: invalid argument` — the path was 106 bytes, and nothing in the
 * error said so. Shortening the *name* was not enough either: the limit is on
 * the whole path, and `home` can be arbitrarily deep.
 *
 * So a socket goes in the temp directory, which is what ephemeral runtime state
 * is for — `home` holds mirrors and worktrees, which are durable and want to be
 * somewhere predictable. The name is a digest of the home *and* the run id, so
 * two conductors with different state directories cannot collide.
 */
export function socketPathFor(runId: string, home = stateDir()): string {
  const short = createHash("sha256").update(`${home}\u0000${runId}`).digest("hex").slice(0, 12);
  const path = join(tmpdir(), "lingtai", `${short}.sock`);

  if (Buffer.byteLength(path) >= SUN_PATH_MAX) {
    // Say which limit and how far over. `EINVAL` on its own costs an hour.
    throw new Error(
      `the hook socket path is ${Buffer.byteLength(path)} bytes and the limit is ${SUN_PATH_MAX}: ${path}. ` +
        "Set TMPDIR to something shorter.",
    );
  }
  return path;
}

export function settingsPathFor(runId: string, home = stateDir()): string {
  return join(home, "runs", runId, "settings.json");
}

/** Beside the run's, and outside the worktree for the same reason. */
export function unhookedSettingsPathFor(runId: string, home = stateDir()): string {
  return join(home, "runs", runId, "settings-unhooked.json");
}

export interface RenderOptions {
  runId: string;
  /** Absolute path to the compiled `lingtai-hook`. */
  hookBinary: string;
  home?: string;
  /** Claude Code's extras. Off for a runtime that does not have them. */
  includeClaudeOnly?: boolean;
}

/**
 * Claude Code's settings shape: a matcher per hook with a list of commands.
 *
 * `matcher: "*"` is deliberate — a matcher that lists tools is a list that will
 * fall behind the runtime's.
 */
export function renderSettings(options: RenderOptions): unknown {
  // Absolute, and checked rather than trusted, because a relative path here
  // fails *silently*. The caller verifies the binary exists by resolving it
  // against its own cwd; Claude Code spawns it resolved against the worktree. A
  // relative path can therefore pass the existence check and then not be found —
  // and a hook command that is not found exits 127, which the runtime treats as
  // a non-blocking error and carries on. The result is a run that records
  // nothing and looks exactly like a run that recorded everything. Refusing
  // here costs nothing and removes the whole class.
  const command = options.hookBinary;
  if (!isAbsolute(command)) {
    throw new Error(`lingtai-hook path must be absolute, got: ${command}`);
  }
  const entry = () => [{ matcher: "*", hooks: [{ type: "command", command }] }];

  const hooks: Record<string, unknown> = {};
  for (const name of INTERSECTION_HOOKS) hooks[name] = entry();
  if (options.includeClaudeOnly !== false) {
    for (const name of CLAUDE_ONLY_HOOKS) hooks[name] = entry();
  }
  return { hooks };
}

export async function writeHookWiring(options: RenderOptions): Promise<HookWiring> {
  const home = options.home ?? stateDir();
  const settingsPath = settingsPathFor(options.runId, home);
  const unhookedSettingsPath = unhookedSettingsPathFor(options.runId, home);
  const socketPath = socketPathFor(options.runId, home);

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(renderSettings(options), null, 2)}\n`, {
    mode: 0o600,
  });
  // Written here rather than by whoever wants it, so that the one place that
  // knows where a run's settings live is still one place. See
  // `unhookedSettingsPath`: no hooks is the whole of the difference.
  await writeFile(unhookedSettingsPath, `${JSON.stringify({ hooks: {} }, null, 2)}\n`, {
    mode: 0o600,
  });

  return {
    settingsPath,
    unhookedSettingsPath,
    socketPath,
    // `LINGTAI_`-prefixed since `#63`, both ends. These are Lingtai's own names
    // — set here, read by the compiled hook — and the rule that every such name
    // carries the prefix is what makes "is this ours?" answerable without
    // knowing the history. They were `ESC_*`, from before the project was
    // renamed, and the guard test could not see them because it only read
    // `packages/env`. It reads every `src/` now.
    env: {
      LINGTAI_HOOK_SOCKET: socketPath,
      LINGTAI_HOOK_RUN_ID: options.runId,
    },
  };
}

/**
 * Proves the hook fails closed when the conductor is not there.
 *
 * [ADR 0016](../../../doc/decisions/0016-the-settled-model.md) §6 listed this
 * for deletion along with the guard. That was wrong, and the correction is
 * recorded rather than made quietly: the guard is gone, but the hook still
 * carries every lifecycle event a run produces, and the failure this catches
 * has simply changed shape. It is no longer "a tool call went unmediated"; it
 * is **"a run produced no events and nothing said so"** — which in a system
 * whose whole claim is that the log is the answer is the worse of the two.
 *
 * The old loop refused to start when `test-guard.sh` failed, and that instinct
 * was right for the same reason it is right here. This runs the real binary
 * against a socket path that does not exist and requires exit 2. The conductor
 * calls it before dispatching anything.
 */
export async function smokeTestFailClosed(
  hookBinary: string,
  run: (
    bin: string,
    env: Record<string, string>,
    stdin: string,
  ) => Promise<{ code: number | null; stderr: string }>,
): Promise<{ ok: boolean; detail: string }> {
  const nowhere = join(stateDir(), "sockets", `smoke-${Date.now()}.sock`);
  const { code, stderr } = await run(
    hookBinary,
    { LINGTAI_HOOK_SOCKET: nowhere, LINGTAI_HOOK_RUN_ID: "run-smoke" },
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
  );

  if (code === 2) {
    return { ok: true, detail: `denied with exit 2 when the socket was absent: ${stderr.trim()}` };
  }
  return {
    ok: false,
    detail:
      `lingtai-hook exited ${code} with no conductor listening — it must exit 2. ` +
      "A recorder that fails open silently is worse than one that stops: the run " +
      "continues and produces no events, and in a system whose whole claim is that " +
      "the log is the answer, that is the failure with no symptom.",
  };
}

/**
 * Anything the host could not do for a run, in a channel a caller can see.
 *
 * The mirror of `@lingtai/repo`'s `RepoFailed`, and for the same reason
 * ([0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)): the
 * conversion is worth something because the type says a call can fail, not
 * because it returns an `Effect`.
 */
export class AgentHostFailed extends Data.TaggedError("AgentHostFailed")<{
  /** `wire`, `smokeTest`, `serve` — what was being attempted. */
  readonly operation: string;
  readonly detail: string;
}> {}

/** The two above, as `Effect`s. The promise faces stay for callers that are not. */
export const writeHookWiringEffect = (
  options: RenderOptions,
): Effect.Effect<HookWiring, AgentHostFailed> =>
  Effect.tryPromise({
    try: () => writeHookWiring(options),
    catch: (err) => new AgentHostFailed({ operation: "wire", detail: (err as Error).message }),
  });

export const smokeTestFailClosedEffect = (
  hookBinary: string,
  run: (
    bin: string,
    env: Record<string, string>,
    stdin: string,
  ) => Promise<{ code: number | null; stderr: string }>,
): Effect.Effect<{ ok: boolean; detail: string }, AgentHostFailed> =>
  Effect.tryPromise({
    try: () => smokeTestFailClosed(hookBinary, run),
    catch: (err) => new AgentHostFailed({ operation: "smokeTest", detail: (err as Error).message }),
  });
