/**
 * A `RefChannel` over a plain git remote, for a project with no GitHub owner
 * (`#352`).
 *
 * `tell.ts`'s own docstring is the reason this exists at all rather than
 * being skipped: *"a channel that silently cannot delete is a recipe that
 * resolved an effect nothing ran"*. Nothing else will ever sweep these refs
 * for an owner-less project — `convergeIssues` only ever asks GitHub, and the
 * daemon skips an owner-less project outright — so `agent/*` arms would pile
 * up on the remote with nothing converging them if this answered a skip
 * instead of a channel.
 *
 * Both calls run with no token: `apps/cli/src/run.ts`'s owner-less branch
 * mints none, so a remote that needs one has to be one this machine's own git
 * credentials already reach — the ticket's "pushes with this machine's own
 * git credentials".
 */
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
  const run = { env: options.gitEnv }

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
