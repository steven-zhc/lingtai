/**
 * Making a team project's `branch.personal` (0130 §2, #1358): `refs/heads/<name>` at the tip of
 * `branch.main`, **read first, then made**, so an existence read that fails makes nothing and a
 * branch that exists is never moved. The board's Add, `lingtai add` and a team pass's `admit` share it.
 */
import { gitEffect, mirrorPathFor, type TokenSource } from '@lingtai/repo'
import { Effect } from 'effect'

/** The three GitHub verbs this needs, in any error shape: the board's `GitHub` and the CLI's promise face both fit. */
export interface BranchClient {
  branchExists(name: string): Effect.Effect<boolean, unknown>
  refSha(ref: string): Effect.Effect<string, unknown>
  createBranch(name: string, sha: string): Effect.Effect<void, unknown>
}

/** What a pass asks for before it cuts: the branch is made, or was there already. Failing is *the read failed — nothing was made*. */
export type PersonalBranchPort = (
  name: string,
  from: string,
) => Effect.Effect<{ readonly made: string } | { readonly exists: true }, Error>

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `refs/heads/<name>` at the tip of `<from>`: the sha is read first, so a failed read makes nothing. */
export const makePersonalBranch = (client: Pick<BranchClient, 'refSha' | 'createBranch'>, name: string, from: string) =>
  client.refSha(from).pipe(Effect.flatMap((sha) => client.createBranch(name, sha).pipe(Effect.as(sha))))

/** Whether the branch exists, then — only if it does not — `makePersonalBranch`. */
export const ensurePersonalBranch = (
  client: BranchClient,
  name: string,
  from: string,
): Effect.Effect<{ readonly made: string } | { readonly exists: true }, Error> =>
  Effect.gen(function* () {
    const exists = yield* client
      .branchExists(name)
      .pipe(
        Effect.mapError(
          (e) => new Error(`could not read whether ${name} exists on GitHub — nothing was made: ${reasonOf(e)}`),
        ),
      )
    if (exists) return { exists: true } as const
    const sha = yield* makePersonalBranch(client, name, from)
    return { made: sha } as const
  }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(reasonOf(e)))))

/**
 * `git ls-remote <remote> refs/heads/<name>`, read: a line is *exists*, success with no output is
 * *absent*, and a failure never reaches here — it is *unknown*, which is neither.
 */
export const lsRemoteReading = (out: string): 'exists' | 'absent' => (out.trim() === '' ? 'absent' : 'exists')

/**
 * The same rule against a plain git remote, from the pass's own mirror (which the pass's provision has just
 * fetched). The push carries an empty lease for the ref, so it is refused if the branch is there: it can
 * never move one that exists. A refused push is read again, and a branch there now is *exists*.
 */
export const ensurePersonalBranchOnRemote = (options: {
  readonly remote: string
  readonly project: string
  readonly home: string
  readonly token?: TokenSource
  readonly gitEnv?: NodeJS.ProcessEnv
}): PersonalBranchPort => {
  const run = { token: options.token, env: options.gitEnv }
  const mirror = mirrorPathFor(options.project, options.home)
  return (name, from) =>
    Effect.gen(function* () {
      const read = (why: string) =>
        gitEffect(['ls-remote', options.remote, `refs/heads/${name}`], { ...run, cwd: mirror }).pipe(
          Effect.mapError(
            (e) => new Error(`could not read whether ${name} exists on ${why} — nothing was made: ${e.detail}`),
          ),
        )
      if (lsRemoteReading(yield* read(options.remote)) === 'exists') return { exists: true } as const
      const sha = yield* gitEffect(['rev-parse', '--verify', `refs/heads/${from}`], { ...run, cwd: mirror }).pipe(
        Effect.mapError((e) => new Error(`could not read ${from} — nothing was made: ${e.detail}`)),
      )
      const pushed = yield* Effect.result(
        gitEffect(['push', `--force-with-lease=refs/heads/${name}:`, options.remote, `${sha}:refs/heads/${name}`], {
          ...run,
          cwd: mirror,
        }),
      )
      if (pushed._tag === 'Success') return { made: sha } as const
      if (lsRemoteReading(yield* read(options.remote)) === 'exists') return { exists: true } as const
      return yield* Effect.fail(new Error(`could not make ${name}: ${pushed.failure.detail}`))
    })
}
