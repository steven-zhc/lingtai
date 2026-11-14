import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'

import { claudeOauthToken } from '@lingtai/env'
import { staticPrefix, within } from '@lingtai/sandbox'
import type { CallerAdditions, ProjectAdditions, WrapInput, Wrapped } from '@lingtai/sandbox'
import { Effect, Redacted, type Scope } from 'effect'

import { liveRunDirFs, prepareClaudeRunDirectory, type RunDirFs } from './claude-run-dir.ts'

/**
 * What a sandboxed Claude Code run is handed, and what `claudeCodeRun` does with it (#1150, 0127 §8 and §16).
 *
 * `packages/agent` never imports the package's live entry (the one that loads srt): the conductor closes over the service and hands a
 * `wrap` function. Only the types and the pure path relation come from the package's root, which loads no srt.
 */

/** The run's decision, as #1147 makes it. `unsandboxed` never reaches a request: `RunRequest.sandbox` is absent instead. */
export type RunSandboxDecision =
  | { readonly kind: 'sandboxed'; readonly project_additions: ProjectAdditions }
  | { readonly kind: 'refused'; readonly why: string }

/** What `Sandbox.wrap` fails with: only its sentence is read, never srt's own object. */
export interface WrapFailure {
  readonly message: string
}

export interface RunSandbox {
  readonly decision: RunSandboxDecision
  readonly project: string
  readonly mirror: string
  /** The project's cache directory (`cacheDir`), which a carried deny must not cover (#1151). */
  readonly cache: string
  /** Where the run writes its work: the worktree, or its own directory for a judge with none. */
  readonly worktree: string
  /** `claudeConfigDirFor(home, <this run's id>)`: the run's own `CLAUDE_CONFIG_DIR`. */
  readonly runDir: string
  /** The operator's Claude directory (`~/.claude`). */
  readonly operatorClaudeDir: string
  /** The host's `HOME`, for a leading `~` in a carried deny. */
  readonly hostHome: string
  /** Paths the conductor knows the run must read and not write, beside its `--settings` file: the hook binary. */
  readonly read: readonly string[]
  readonly wrap: (input: WrapInput) => Effect.Effect<Wrapped, WrapFailure, Scope.Scope>
}

/** A run that did not start, and the sentence that says why. Never carries a token or a file's contents. */
export class SandboxRunRefused {
  readonly _tag = 'SandboxRunRefused'
  readonly sentence: string
  constructor(sentence: string) {
    this.sentence = sentence
  }
}

/** The ports a unit test replaces. */
export interface SandboxPorts {
  /** Throws when the machine file cannot be read; `undefined` when no token is set. */
  readonly oauthToken?: () => Redacted.Redacted<string> | undefined
  readonly runDirFs?: RunDirFs
  /** The operator's `settings.json` as text; `null` when it is absent. */
  readonly readOperatorSettings?: (path: string) => Effect.Effect<string | null, unknown>
}

const liveReadOperatorSettings = (path: string): Effect.Effect<string | null, unknown> =>
  Effect.tryPromise({ try: () => readFile(path, 'utf8'), catch: (e) => e }).pipe(
    Effect.catch((e) => ((e as { code?: unknown } | null)?.code === 'ENOENT' ? Effect.succeed(null) : Effect.fail(e))),
  )

export const NO_TOKEN_SENTENCE =
  'a sandboxed Claude Code run needs a long-lived token: run `claude setup-token` and set `claude.oauth_token` in ~/.lingtai/config.yml'

const expandHome = (path: string, home: string): string =>
  path === '~' ? home : path.startsWith('~/') ? posix.join(home, path.slice(2)) : path

/**
 * `sandbox.filesystem.denyRead` out of the operator's `~/.claude/settings.json`, `~` expanded (0127 §16).
 * Absent carries nothing. Unreadable, not JSON, a non-string entry or a relative one refuses by name:
 * the sentence names the path and never quotes the file.
 */
export const carriedDenies = (
  settingsPath: string,
  home: string,
  read: (path: string) => Effect.Effect<string | null, unknown>,
): Effect.Effect<string[], SandboxRunRefused> =>
  Effect.gen(function* () {
    const text = yield* read(settingsPath).pipe(
      Effect.mapError(() => new SandboxRunRefused(`${settingsPath} could not be read, so its read denies are unknown`)),
    )
    if (text === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return yield* Effect.fail(new SandboxRunRefused(`${settingsPath} is not JSON, so its read denies are unknown`))
    }
    const entries = (parsed as { sandbox?: { filesystem?: { denyRead?: unknown } } } | null)?.sandbox?.filesystem
      ?.denyRead
    if (entries === undefined) return []
    if (!Array.isArray(entries)) {
      return yield* Effect.fail(new SandboxRunRefused(`${settingsPath}: sandbox.filesystem.denyRead is not a list`))
    }
    const out: string[] = []
    for (const [i, entry] of entries.entries()) {
      if (typeof entry !== 'string') {
        return yield* Effect.fail(
          new SandboxRunRefused(`${settingsPath}: sandbox.filesystem.denyRead[${i}] is not a string`),
        )
      }
      const path = expandHome(entry, home)
      if (!posix.isAbsolute(path)) {
        return yield* Effect.fail(
          new SandboxRunRefused(`${settingsPath}: sandbox.filesystem.denyRead[${i}] is not an absolute path`),
        )
      }
      out.push(path)
    }
    return out
  })

/** A deny that is, lies inside or contains a path the run needs would be voided by that path's `allowRead` (017). */
export const collidingDenies = (denies: readonly string[], needed: readonly string[]): string[] =>
  denies.filter((d) => {
    const prefix = posix.resolve(staticPrefix(d))
    return needed.some((n) => within(prefix, n) || within(n, prefix))
  })

export interface SandboxedLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
}

/**
 * The prepared run: token read, directory made, argv wrapped. Everything it makes lives in the caller's scope,
 * so it is torn down only after the agent is gone.
 */
export const sandboxedLaunch = (
  sandbox: RunSandbox,
  run: { readonly argv: readonly string[]; readonly env: Record<string, string>; readonly settingsPath: string },
  buildEnv: (env: Record<string, string>) => Record<string, string>,
  trace: (line: string) => void,
  ports: SandboxPorts = {},
): Effect.Effect<SandboxedLaunch, SandboxRunRefused, Scope.Scope> =>
  Effect.gen(function* () {
    const decision = sandbox.decision
    if (decision.kind === 'refused') {
      return yield* Effect.fail(new SandboxRunRefused(`sandbox required and unavailable on this host: ${decision.why}`))
    }

    const token = yield* Effect.try({
      try: () => (ports.oauthToken ?? (() => claudeOauthToken()))(),
      catch: (e) => new SandboxRunRefused(e instanceof Error ? e.message : 'the long-lived token could not be read'),
    })
    if (token === undefined) return yield* Effect.fail(new SandboxRunRefused(NO_TOKEN_SENTENCE))

    const operatorSettings = posix.join(sandbox.operatorClaudeDir, 'settings.json')
    const denies = yield* carriedDenies(
      operatorSettings,
      sandbox.hostHome,
      ports.readOperatorSettings ?? liveReadOperatorSettings,
    )
    const needed = [sandbox.worktree, sandbox.mirror, sandbox.runDir, run.settingsPath, ...sandbox.read]
    const colliding = collidingDenies(denies, needed)
    if (colliding.length > 0) {
      return yield* Effect.fail(
        new SandboxRunRefused(
          `${operatorSettings}: the read deny ${colliding[0]} covers a path the run needs, and would be voided by it`,
        ),
      )
    }

    const copied = yield* prepareClaudeRunDirectory(
      sandbox.runDir,
      { source: sandbox.operatorClaudeDir, settings: { sandbox: { enabled: false } }, trace },
      ports.runDirFs ?? liveRunDirFs,
    ).pipe(Effect.mapError((e) => new SandboxRunRefused(e.detail)))

    const callerAdditions: CallerAdditions = {
      write: [sandbox.runDir],
      read: [run.settingsPath, ...sandbox.read, ...copied],
      deny: denies,
    }
    const wrapped = yield* sandbox
      .wrap({
        project: sandbox.project,
        worktree: sandbox.worktree,
        mirror: sandbox.mirror,
        command: run.argv,
        // The only environment there is: ours come last, so a recipe cannot override them.
        env: buildEnv({
          ...run.env,
          CLAUDE_CODE_OAUTH_TOKEN: Redacted.value(token),
          CLAUDE_CONFIG_DIR: sandbox.runDir,
        }),
        project_additions: decision.project_additions,
        caller_additions: callerAdditions,
      })
      .pipe(Effect.mapError((e) => new SandboxRunRefused(e.message)))

    const [command, ...args] = wrapped.argv
    if (command === undefined) {
      return yield* Effect.fail(new SandboxRunRefused('the sandbox returned an empty command'))
    }
    return { command, args, env: { ...wrapped.env } }
  })
