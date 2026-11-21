/** What the PR steps read of git: shared by `pr.ts` and `pr-sync.ts`, which import each other's types and nothing else. */
import { Effect } from 'effect'

import type { PrGitAnswer, PrPorts } from './pr.ts'

/** Refs of a PR's own in the mirror: never `refs/heads/*`, never `refs/lingtai/lane/` (the lane's sweep takes those by age). */
export const targetRef = (n: number): string => `refs/lingtai/pr/${n}/target`
export const fetchedRef = (n: number, name: 'main' | 'personal'): string => `refs/lingtai/pr/${n}/${name}`

/** Deletes a ref of the PR's own; a ref that is not there, or a git that refuses, is not a reason to fail a step. */
export const dropRef = (ports: PrPorts, project: string, ref: string): Effect.Effect<void> =>
  ports.git(project, ['update-ref', '-d', ref]).pipe(Effect.ignore)

export const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** `git` answered with a code other than the two it is expected to: the refusal's sentence. */
export const gitSaid = (args: readonly string[], answer: PrGitAnswer): string =>
  `git ${args.join(' ')} answered ${answer.code === null ? 'nothing' : `exit ${answer.code}`}`

/** The sha a ref has on the remote, matched on the whole ref: `ls-remote` answers `<sha>\t<ref>` lines. Null: absent. */
export const remoteSha = (ports: PrPorts, project: string, ref: string): Effect.Effect<string | null, Error> =>
  Effect.gen(function* () {
    const args = ['ls-remote', '--heads', 'origin', ref] as const
    const answer = yield* ports.remote(project, args)
    if (answer.code !== 0) return yield* Effect.fail(new Error(gitSaid(args, answer)))
    for (const line of answer.stdout.split('\n')) {
      const [sha, name] = line.trim().split('\t')
      if (name === ref && sha !== undefined && sha !== '') return sha
    }
    return null
  })

/**
 * Fetches `from` into `to`, refs of the PR's own under `refs/lingtai/pr/`: never `refs/heads/*`, which a checked-out
 * branch of the mirror (an agent's published one) would refuse to be fetched into, for a PR merge that does not involve it.
 */
export const fetchInto = (
  ports: PrPorts,
  project: string,
  pairs: readonly (readonly [from: string, to: string])[],
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    // The mirror is made if it is not there (a daemon restarted onto a PR whose disposable mirror was removed). One
    // that is there is left alone: `ports.fetch` fetches `refs/heads/*`, which a checked-out branch would refuse.
    const there = yield* Effect.result(ports.git(project, ['rev-parse', '--git-dir']))
    // Absent is only what git says of a directory that is not there (not a repository, or the spawn's ENOENT); a read
    // that failed any other way (EAGAIN, a killed spawn) proves nothing about the mirror and is never read as absence.
    if (there._tag === 'Failure') {
      if (!/ENOENT/.test(asError(there.failure).message)) return yield* Effect.fail(asError(there.failure))
      yield* ports.fetch(project)
    } else if (there.success.code !== 0) yield* ports.fetch(project)
    // The remote port retries a fetch that could not reach origin (`retryUnreachable`, in the live port), as the lane's does.
    const args = ['fetch', '--no-tags', 'origin', ...pairs.map(([from, to]) => `+${from}:${to}`)] as const
    const answer = yield* ports.remote(project, args)
    if (answer.code !== 0) return yield* Effect.fail(new Error(gitSaid(args, answer)))
  })
