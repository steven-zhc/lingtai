/**
 * What the sandbox gives every project before its recipe says a word (#1162): the built-in domains, the writable
 * roots, and the deny lists, for the recipe page to draw greyed beside the project's own entries.
 *
 * Read from `@lingtai/sandbox`'s `.` entry only (never `/live`, which loads srt), so the board need not depend on
 * that package. The paths are this machine's, from the same host facts a save is checked against.
 */
import { BUILT_IN_DOMAINS, WORKTREE_PLACEHOLDER, mirrorDir, resolvedPolicy } from '@lingtai/sandbox'
import { Effect } from 'effect'

import { HOST_FOR_SAVING } from './sandbox.ts'

export interface BuiltInSandbox {
  /** The domains a run may reach whatever its recipe says. Always known: it is a constant. */
  readonly domains: readonly string[]
  /** Null where the host's facts could not be read, with why: the paths are then *unknown*, never an empty list. */
  readonly paths: {
    /** The run's own worktree is `<worktree>`: a throwaway path never reaches the page. */
    readonly writable: readonly string[]
    readonly denyRead: readonly string[]
    readonly denyWrite: readonly string[]
  } | null
  readonly pathsWhy: string | null
}

export const builtInSandboxEffect = (project: string): Effect.Effect<BuiltInSandbox> =>
  HOST_FOR_SAVING.hostFacts.pipe(
    Effect.map((host): BuiltInSandbox => {
      const p = resolvedPolicy(host, { project, worktree: WORKTREE_PLACEHOLDER, mirror: mirrorDir(host, project) })
      return {
        domains: [...BUILT_IN_DOMAINS],
        paths: { writable: p.allowWrite, denyRead: p.denyRead, denyWrite: p.denyWrite },
        pathsWhy: null,
      }
    }),
    Effect.catch((e) => Effect.succeed({ domains: [...BUILT_IN_DOMAINS], paths: null, pathsWhy: e.reason })),
  )
