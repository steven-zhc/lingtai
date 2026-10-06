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
  installed: boolean
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
    // A missing binary is a spawn error, and not a runtime saying it is signed out.
    installed: !/ENOENT/.test(status.detail),
    signedIn: status.loggedIn,
    detail: status.detail,
  }))
}
