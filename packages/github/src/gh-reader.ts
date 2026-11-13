/**
 * Reading GitHub as the saved `gh` login, `GET` only (#969).
 *
 * The sibling of `AppReader` for a `gh` machine, and like it the surface a
 * listing is allowed: one method, no write. It is not scoped to a repository
 * because the questions it answers (`GET /user/repos`) belong to none.
 *
 * **The token never leaves this closure.** `ghToken` is asked for on each call,
 * goes into the `authorization` header and nowhere else: not a variable the
 * shell sees, not a message, not a log. Every error that comes out is built
 * from `ghToken`'s own sentences (which scrub stderr) or from GitHub's reply.
 */
import { Effect } from 'effect'

import { GITHUB_API, GitHubFailed } from './app.ts'
import { type GhRun, ghTokenEffect, liveGh } from './gh.ts'
import { observedRequest, remainingOf } from './observe.ts'

const TIMEOUT = '15 seconds'

export interface GhReader {
  /** One page of one `GET`. Fails with an `Error` whose message is safe to print. */
  request<T>(path: string): Effect.Effect<T, Error>
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

export function createGhReader(run: GhRun = liveGh): GhReader {
  return {
    request: <T>(path: string) =>
      Effect.gen(function* () {
        const token = yield* ghTokenEffect(run)
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            observedRequest('GET', path, (report) =>
              fetch(`${GITHUB_API}${path}`, {
                signal,
                headers: {
                  accept: 'application/vnd.github+json',
                  'x-github-api-version': '2022-11-28',
                  'user-agent': 'lingtai',
                  authorization: `Bearer ${token}`,
                },
              }).then((response) => {
                report(remainingOf(response))
                return response
              }),
            ),
          catch: (err) => new Error(`could not reach GitHub: ${asError(err).message}`),
        })
        if (!response.ok) {
          const body = yield* Effect.tryPromise({ try: () => response.text(), catch: asError })
          let message = body.slice(0, 400)
          try {
            message = (JSON.parse(body) as { message?: string }).message ?? message
          } catch {
            // Not JSON. The raw prefix is more useful than nothing.
          }
          return yield* Effect.fail(new GitHubFailed(response.status, path, message))
        }
        return (yield* Effect.tryPromise({ try: () => response.json(), catch: asError })) as T
      }).pipe(
        Effect.timeout(TIMEOUT),
        Effect.mapError((err) =>
          err instanceof Error && err.name === 'TimeoutError'
            ? new Error(`GitHub did not answer ${path} in 15s`)
            : (err as Error),
        ),
      ),
  }
}
