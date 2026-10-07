/**
 * A `RefChannel` over a plain git remote, for a project with no GitHub owner
 * (`#352`).
 *
 * `tell.ts`'s own docstring is the reason this exists at all rather than
 * being skipped: *"a channel that silently cannot delete is a recipe that
 * resolved an effect nothing ran"*. Before `#355`, nothing else would ever
 * have swept these refs for an owner-less project — `convergeIssues` only
 * ever asked GitHub, and the daemon skipped an owner-less project outright —
 * so `agent/*` arms would have piled up on the remote with nothing converging
 * them if this answered a skip instead of a channel. **Since `#355`,
 * `convergeIssues` sweeps them too**, over this same channel rather than
 * GitHub's API: `clientsForProjects` hands it a `RefChannel` built from this
 * function for every registered owner-less project, not only the one
 * `lingtai run` happens to be working.
 *
 * Both calls run with no token: `apps/cli/src/run.ts`'s owner-less branch
 * mints none, so a remote that needs one has to be one this machine's own git
 * credentials already reach — the ticket's "pushes with this machine's own
 * git credentials".
 *
 * **`git push` refuses outright with no `cwd` naming a repository** — unlike
 * `git ls-remote`, which answers an explicit URL from anywhere. `cwd` is
 * `repoRoot()`, Lingtai's own checkout, which 0010 runs unbuilt and so is
 * always present and always a repository regardless of where `lingtai run`
 * itself was invoked from; nothing about it reaches the mirror or the remote
 * being swept.
 */
import { repoRoot } from '@lingtai/env'
import { git } from '@lingtai/repo'

import type { RefChannel } from './tell.ts'

export interface GitRefChannelOptions {
  /** Where `git ls-remote` and `git push --delete` are run against. */
  remote: string
  gitEnv?: NodeJS.ProcessEnv
}

/** A `git ls-remote --heads` line is `<sha>\t<ref>`; only the ref matters here. */
function refOf(line: string): string | null {
  const ref = line.split('\t')[1]
  return ref === undefined ? null : ref
}

export function gitRefChannel(options: GitRefChannelOptions): RefChannel {
  const run = { cwd: repoRoot(), env: options.gitEnv }

  return {
    async matchingRefs(prefix) {
      const out = await git(['ls-remote', '--heads', options.remote], run)
      return out
        .split('\n')
        .map(refOf)
        .filter((ref): ref is string => ref !== null && ref.startsWith(`refs/${prefix}`))
        .map((ref) => ref.slice('refs/'.length))
    },
    async deleteRef(ref) {
      await git(['push', options.remote, '--delete', `refs/${ref}`], run)
    },
  }
}
