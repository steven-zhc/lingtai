import { posix } from 'node:path'

import { copilotGithubToken } from '@lingtai/env'
import type { CallerAdditions } from '@lingtai/sandbox'
import { Effect, Redacted, type Scope } from 'effect'

import { collidingDenies, SandboxRunRefused, type RunSandbox, type SandboxedLaunch } from './claude-sandbox.ts'
import { operatorCodexDenies } from './codex-sandbox.ts'
import { userPermissionsAt, type UserPermissions } from './codex.ts'

/**
 * A sandboxed Copilot run (#1301, 0127 §1 and §8): Copilot's own sandbox is off (`--no-sandbox`), srt is the boundary,
 * and the login is a token of the project's own, since `~/.config/gh` is denied (0127 §5).
 */

export const NO_COPILOT_TOKEN_SENTENCE =
  'a sandboxed Copilot run needs a fine-grained token with the account permission Copilot Requests: set `copilot.github_token` in ~/.lingtai/config.yml or export LINGTAI_COPILOT_GITHUB_TOKEN'

export const CLASSIC_COPILOT_TOKEN_SENTENCE =
  'the Copilot token is a classic token (it begins `ghp_`), which Copilot ignores: make a fine-grained token with Copilot Requests'

/** The hosts a Copilot run reaches that the built-in list does not hold. */
export const COPILOT_NETWORK = ['*.githubcopilot.com'] as const

/** The person's own GitHub credentials, which a run must never be handed: Copilot would read them after its own. */
const PERSONAL_TOKEN_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

export interface CopilotSandboxPorts {
  /** Throws when the machine file cannot be read; `undefined` when no token is set. */
  readonly githubToken?: () => Redacted.Redacted<string> | undefined
  readonly readCodexPermissions?: (env: Record<string, string>, cwd: string) => UserPermissions
}

/** `--no-sandbox` is for this path only: an unsandboxed run keeps Copilot's own sandbox. */
export const COPILOT_SANDBOXED_ARGS = ['--no-sandbox'] as const

export const copilotSandboxedLaunch = (
  sandbox: RunSandbox,
  run: {
    readonly argv: readonly string[]
    readonly env: Record<string, string>
    readonly cwd: string
  },
  trace: (line: string) => void,
  ports: CopilotSandboxPorts = {},
): Effect.Effect<SandboxedLaunch, SandboxRunRefused, Scope.Scope> =>
  Effect.gen(function* () {
    const decision = sandbox.decision
    if (decision.kind === 'refused') {
      return yield* Effect.fail(new SandboxRunRefused(`sandbox required and unavailable on this host: ${decision.why}`))
    }

    const token = yield* Effect.try({
      try: () => (ports.githubToken ?? (() => copilotGithubToken()))(),
      catch: (e) => new SandboxRunRefused(e instanceof Error ? e.message : 'the Copilot token could not be read'),
    })
    if (token === undefined) return yield* Effect.fail(new SandboxRunRefused(NO_COPILOT_TOKEN_SENTENCE))
    const value = Redacted.value(token)
    if (value.startsWith('ghp_')) return yield* Effect.fail(new SandboxRunRefused(CLASSIC_COPILOT_TOKEN_SENTENCE))

    const home = run.env['HOME']
    if (home === undefined || home === '') {
      return yield* Effect.fail(new SandboxRunRefused('the run has no HOME, so its Copilot home cannot be named'))
    }
    const copilotHome = posix.join(home, '.copilot')

    const profile = operatorCodexDenies(
      (ports.readCodexPermissions ?? userPermissionsAt)(run.env, run.cwd),
      { home: run.env['HOME'], cwd: run.cwd },
      sandbox.codexNamed,
    )
    if (!profile.ok) return yield* Effect.fail(profile.refusal)
    if (profile.note !== undefined) trace(profile.note)
    const colliding = collidingDenies(profile.paths, [
      sandbox.worktree,
      sandbox.mirror,
      sandbox.cache,
      copilotHome,
      ...sandbox.read,
    ])
    if (colliding.length > 0) {
      return yield* Effect.fail(
        new SandboxRunRefused(
          `the operator's Codex permission profile denies ${colliding[0]}, which covers a path the run needs, and would be voided by it`,
        ),
      )
    }

    const callerAdditions: CallerAdditions = {
      network: [...COPILOT_NETWORK],
      write: [copilotHome],
      read: [...sandbox.read],
      deny: profile.paths,
    }
    const env: Record<string, string> = { ...run.env }
    for (const name of PERSONAL_TOKEN_NAMES) delete env[name]
    // Ours comes last, so a recipe cannot override it.
    env['COPILOT_GITHUB_TOKEN'] = value

    const wrapped = yield* sandbox
      .wrap({
        project: sandbox.project,
        worktree: sandbox.worktree,
        mirror: sandbox.mirror,
        command: [...run.argv, ...COPILOT_SANDBOXED_ARGS],
        env,
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
