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
        // The body is read inside the observed request, so its span covers the whole transfer and ends failed
        // on a non-2xx or an unreadable body.
        type Read =
          | { kind: 'ok'; data: unknown }
          | { kind: 'status'; status: number; text: string }
          | { kind: 'unread'; error: Error }
        const read = yield* Effect.tryPromise({
          try: (signal) =>
            observedRequest(
              'GET',
              path,
              (report): Promise<Read> =>
                fetch(`${GITHUB_API}${path}`, {
                  signal,
                  headers: {
                    accept: 'application/vnd.github+json',
                    'x-github-api-version': '2022-11-28',
                    'user-agent': 'lingtai',
                    authorization: `Bearer ${token}`,
                  },
                }).then((response): Promise<Read> => {
                  report(remainingOf(response))
                  const unread = (err: unknown): Read => ({ kind: 'unread', error: asError(err) })
                  return response.ok
                    ? response.json().then((data: unknown): Read => ({ kind: 'ok', data }), unread)
                    : response.text().then((text): Read => ({ kind: 'status', status: response.status, text }), unread)
                }),
              (value) => value.kind !== 'ok',
            ),
          catch: (err) => new Error(`could not reach GitHub: ${asError(err).message}`),
        })
        if (read.kind === 'unread') return yield* Effect.fail(read.error)
        if (read.kind === 'status') {
          let message = read.text.slice(0, 400)
          try {
            message = (JSON.parse(read.text) as { message?: string }).message ?? message
          } catch {
            // Not JSON. The raw prefix is more useful than nothing.
          }
          return yield* Effect.fail(new GitHubFailed(read.status, path, message))
        }
        return read.data as T
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
