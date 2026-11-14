/**
 * The process action: run a command, the exit code is the verdict.
 *
 * This is `verify.sh` unchanged, which is the point — the old loop's build check
 * was the one part of it that worked, and collapsing it into the same primitive
 * as review and approval is what makes the other three cost a configuration line
 * (design.md §2).
 *
 * The execution itself now lives in `command.ts`, because the prepare stage
 * needs the same spawning, the same bounded buffer and the same distinction
 * between a timeout and a refusal — while needing none of this file's meaning.
 * What is left here is exactly the translation from "a command ended" to "a
 * verdict about a commit", which is the part that is genuinely about actions.
 */
import type { RunTrace } from '@lingtai/agent'
import { parseDuration } from '@lingtai/recipe'
import {
  type SandboxPolicyRefused,
  type SandboxUnavailable,
  type SandboxWrapFailed,
  type Wrapped,
} from '@lingtai/sandbox'
import { Effect, type Scope } from 'effect'

import { type ActionContext, type ActionPort } from './action.ts'
import { type CommandOutcome, type RunCommandOptions, commandEffect } from './command.ts'

// Re-exported because they were part of this module's surface before the
// extraction, and moving a file should not move someone's import.
export { EVIDENCE_BYTES, EVIDENCE_LINES, tail } from './command.ts'

/** What spawns a command. Absent from a spec, it is `commandEffect`; a test hands one that records its options. */
export type CommandRunner = (options: RunCommandOptions) => Effect.Effect<CommandOutcome>

export type SandboxWrapError = SandboxUnavailable | SandboxWrapFailed | SandboxPolicyRefused

/**
 * The wrap a *sandboxed* run's commands go through (#1152): `Sandbox.wrap`, closed over the pass's project,
 * mirror and decision by the conductor. Scoped, because the wrap's scope must enclose the command.
 */
export interface RunSandbox {
  wrap(
    command: readonly string[],
    worktree: string,
    env: Record<string, string>,
    /** The run's log, for a note about protection the wrap left out (#1155). */
    log?: RunTrace,
  ): Effect.Effect<Wrapped, SandboxWrapError, Scope.Scope>
}

/** The sentence a failed wrap puts in evidence — the error's own words, never a fallback spawn. */
export const wrapRefusal = (run: string, error: SandboxWrapError): string => {
  const why =
    error._tag === 'SandboxUnavailable'
      ? [error.reason, ...error.sentences].join('; ')
      : error._tag === 'SandboxPolicyRefused'
        ? error.refusals.map((r) => `${r.path} ${r.relation} ${r.protectedPath}`).join('; ')
        : error.cause instanceof Error
          ? error.cause.message
          : String(error.cause)
  return `the sandbox would not wrap \`${run}\`: ${why}`
}

export interface ProcessActionSpec {
  name: string
  run: string
  /** `15m` by default, per the recipe schema. */
  timeout?: string
  /**
   * **Everything this command's process gets**, resolved from the names the
   * recipe declared beside it
   * ([0037](../../../doc/decisions-archive/0037-an-extension-is-a-command.md) §1).
   *
   * Not `ActionContext.env`, and that is the change: a `run:` action is the
   * extension point that needs nothing declared — a plugin declares a key, its
   * fields and the steps it serves, and today every declaration lives in
   * `PLUGINS`;
   * [0067](../../../doc/decisions-archive/0067-a-plugin-is-a-declaration-and-an-implementation.md)
   * is what lets one come from elsewhere, and it supersedes 0037 §2. Its code is
   * not trusted (0037 §1), and it used to be
   * handed the environment the *agent* was given — so a credential put there
   * for one command reached every command. Required rather than optional so
   * that a caller cannot forget it and get the old behaviour by accident; the
   * empty object is the honest answer for an extension that declared nothing,
   * and it is `runnableEnv`'s job, not this one's, to add the `PATH` a process
   * needs to be a process.
   */
  env: Record<string, string>
  /**
   * Present only under a *sandboxed* decision: the command is spawned as the wrap's argv and environment, in its
   * own process group. Absent, the spawn is today's, byte for byte.
   */
  sandbox?: RunSandbox
  /** The runner, as the subscriber's `options.command ?? commandEffect`. */
  command?: CommandRunner
}

export function makeProcessAction(spec: ProcessActionSpec): ActionPort {
  const timeoutLabel = spec.timeout ?? '15m'
  const timeoutMs = parseDuration(timeoutLabel)
  /** A wrap that failed spawns nothing: a failed command with the error's sentence. */
  const refused = (error: SandboxWrapError, mark: () => void): Effect.Effect<CommandOutcome> =>
    Effect.sync(mark).pipe(
      Effect.as({
        ok: false,
        evidence: wrapRefusal(spec.run, error),
        timedOut: false,
        durationMs: 0,
        exitCode: null,
      }),
    )

  return {
    name: spec.name,
    kind: 'run',
    yields: 'verdict',

    run: (context: ActionContext) =>
      Effect.gen(function* () {
        const base: RunCommandOptions = {
          run: spec.run,
          timeoutMs,
          timeoutLabel,
          cwd: context.cwd,
          // `spec.env`, deliberately, and not `context.env`: the context carries
          // the agent's environment and this is not the agent. See ProcessActionSpec.
          env: spec.env,
          signal: context.signal,
        }
        const spawn = spec.command ?? commandEffect
        let wrapFailed = false
        const outcome =
          spec.sandbox === undefined
            ? yield* spawn(base)
            : // The scope encloses the command: closing it cleans srt up, which must not happen under a running child.
              yield* Effect.scoped(
                spec.sandbox.wrap(['/bin/sh', '-c', spec.run], context.cwd, spec.env, context.log).pipe(
                  Effect.flatMap((wrapped) =>
                    spawn({ ...base, wrapped: { argv: wrapped.argv, env: wrapped.env }, ownGroup: true }),
                  ),
                  Effect.catchTags({
                    SandboxUnavailable: (e) => refused(e, () => (wrapFailed = true)),
                    SandboxWrapFailed: (e) => refused(e, () => (wrapFailed = true)),
                    SandboxPolicyRefused: (e) => refused(e, () => (wrapFailed = true)),
                  }),
                ),
              )

        // A process action finds nothing structured — that is what the agent action is
        // for (#18). Its evidence is the log, which is what someone acting on the
        // card actually needs.
        return {
          verdict: outcome.ok ? ('passed' as const) : ('failed' as const),
          evidence: outcome.evidence,
          findings: [],
          ...(wrapFailed ? { notWrapped: true as const } : {}),
        }
      }),
  }
}
