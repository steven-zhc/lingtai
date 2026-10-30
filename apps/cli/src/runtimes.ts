import type { AuthState } from '@lingtai/agent'
/**
 * Which agent runtimes this machine has, and whether each can run (#398).
 *
 * Its own file, imported by both `init.ts` and `agents.ts`: `add` must not
 * import `init.ts`, and through it `board.ts` — a question `add` has no
 * business asking about (`doc/design/398.md`).
 */
import { runnableEnv } from '@lingtai/agent-env'
import { askEveryRuntime } from '@lingtai/agent/auth'
import { RuntimeId } from '@lingtai/domain'

/** `RuntimeId`, and not a list of its members written out again (`#313`). */
export type RuntimeName = RuntimeId

export interface RuntimeFound {
  id: RuntimeName
  /** Missing, does not start, signed out or signed in — told apart by the probe (#735). */
  state: AuthState
  signedIn: boolean
  /** What the runtime said, verbatim. */
  detail: string
}

/**
 * Every runtime, asked whether it is installed and signed in.
 *
 * Keyed by id in `auth.ts`, not zipped positionally here: the pair of
 * hand-written lists this replaces was one insertion away from reporting
 * Codex's answer under Claude Code's name.
 */
export async function askRuntimes(): Promise<RuntimeFound[]> {
  return (await askEveryRuntime(runnableEnv({}))).map(({ id, status }) => ({
    id,
    state: status.state,
    signedIn: status.state === 'signed-in',
    detail: status.detail,
  }))
}

/** The first non-empty line of what a runtime printed. */
export function firstLine(detail: string): string {
  return (
    detail
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? 'printed nothing'
  )
}

/**
 * One sentence per way a runtime can be unusable. An unrecognised state is
 * worded as `did-not-start`, never as signed out: a probe that cannot be read
 * is not told to sign in (#735).
 */
export function runtimeStateSentence(id: string, state: AuthState | undefined, detail: string): string {
  if (state === 'not-installed') return `${id} is not installed`
  if (state === 'signed-out') return `${id} is installed and signed out`
  return `${id} is installed but does not start: ${firstLine(detail)}`
}

/** What fits the state: install it, fix what it printed, or sign in. */
export function remedyFor(state: AuthState | undefined): string {
  if (state === 'not-installed') return 'install it'
  if (state === 'signed-out') return 'sign in to it'
  return 'fix what it printed'
}
