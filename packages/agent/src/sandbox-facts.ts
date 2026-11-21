import { isUnsandboxableRuntime, type RuntimeId } from '@lingtai/domain'

/**
 * What each runtime declares about running inside the sandbox (#1329), as data. A leaf module behind its own subpath:
 * the board reads it, so it imports nothing that reaches `@lingtai/env` or `node:*`.
 */

/** The hosts a Copilot run reaches that the built-in list does not hold. */
export const COPILOT_NETWORK = ['*.githubcopilot.com'] as const

/** The folder under `$HOME` a Copilot run writes. */
export const COPILOT_HOME_FOLDER = '.copilot'

export interface RuntimeSandboxFacts {
  readonly name: string
  /** `own token`: a token of the project's own; `login readable`: the person's login stays readable to the run. */
  readonly login: 'own token' | 'login readable' | null
  readonly tokenCommand?: string
  /** Hosts the runtime adds for itself. */
  readonly network: readonly string[]
  /** The folder under `$HOME` the runtime writes, when it writes one the built-ins do not hold. */
  readonly homeFolder?: string
}

export const RUNTIME_SANDBOX_FACTS: Record<RuntimeId, RuntimeSandboxFacts> = {
  'claude-code': { name: 'Claude Code', login: 'own token', tokenCommand: 'lingtai token claude', network: [] },
  codex: { name: 'Codex', login: 'login readable', network: [] },
  copilot: {
    name: 'GitHub Copilot',
    login: 'own token',
    tokenCommand: 'lingtai token copilot',
    network: COPILOT_NETWORK,
    homeFolder: COPILOT_HOME_FOLDER,
  },
  antigravity: { name: 'Antigravity', login: null, network: [] },
}

/** The facts for an id, or undefined for one this build does not know. */
export const sandboxFactsOf = (id: string): RuntimeSandboxFacts | undefined =>
  (RUNTIME_SANDBOX_FACTS as Record<string, RuntimeSandboxFacts | undefined>)[id]

export const runsSandboxed = (id: string): boolean => !isUnsandboxableRuntime(id)
