/** The seams: srt, the host's facts, and the one directory this package creates. Unit tests hand in fakes of all three. */
import { Context, Data, type Effect } from 'effect'

import type { HostFacts } from './policy.ts'
import type { Refusal } from './protect.ts'

/** The host cannot sandbox, or srt would not start. `sentences` are srt's own, never parsed. */
export class SandboxUnavailable extends Data.TaggedError('SandboxUnavailable')<{
  readonly reason: string
  readonly sentences: readonly string[]
}> {}

/** `wrapWithSandboxArgv` failed. The command is never returned unwrapped. */
export class SandboxWrapFailed extends Data.TaggedError('SandboxWrapFailed')<{
  readonly cause: unknown
}> {}

/** A project's `write` or `deny` named a protected path. */
export class SandboxPolicyRefused extends Data.TaggedError('SandboxPolicyRefused')<{
  readonly refusals: readonly Refusal[]
}> {}

export interface SrtDependencyCheck {
  readonly warnings: readonly string[]
  readonly errors: readonly string[]
}

/** What `srt`'s `SandboxManager` is asked, and only that. Failures arrive as `unknown` and are classified by the caller. */
export interface SrtPort {
  /** `config` is an `initialize` configuration: see `instanceConfig`. */
  initialize(config: unknown): Effect.Effect<void, unknown>
  isSupportedPlatform: Effect.Effect<boolean, unknown>
  checkDependencies: Effect.Effect<SrtDependencyCheck, unknown>
  registerCommandNetworkLists(commandId: string, lists: { allowedDomains: string[] }): Effect.Effect<void, unknown>
  unregisterCommandNetworkLists(commandId: string): Effect.Effect<void, unknown>
  /** Resolves `argv` only. srt's own `env` is `process.env` and is never surfaced through this port. */
  wrapWithSandboxArgv(
    command: string,
    customConfig: unknown,
    options: { commandId: string },
  ): Effect.Effect<{ readonly argv: readonly string[] }, unknown>
  cleanupAfterCommand: Effect.Effect<void, unknown>
  reset: Effect.Effect<void, unknown>
}

export class Srt extends Context.Service<Srt, SrtPort>()('@lingtai/sandbox/Srt') {}

export class Host extends Context.Service<Host, HostFacts>()('@lingtai/sandbox/Host') {}

export interface SandboxFsPort {
  /** `mkdir -p`. */
  ensureDir(path: string): Effect.Effect<void, unknown>
}

export class SandboxFs extends Context.Service<SandboxFs, SandboxFsPort>()('@lingtai/sandbox/SandboxFs') {}
