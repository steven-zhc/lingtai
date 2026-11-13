/**
 * Whether this machine has a GitHub App configured, and whether it still
 * answers — `GET /app` with the App's own JWT, the call that proves the id and
 * the key belong together (#393, #394).
 *
 * Pulled out of `init.ts` so `first-project.ts` can ask the same question for
 * `lingtai add` without importing `init.ts` — the two files would otherwise
 * import each other, since `init.ts` calls into `first-project.ts` for
 * `chooseFirstProject`.
 */
import { Effect, Schedule } from 'effect'

import { lift, recovering } from './exit.ts'

export type AppCheck =
  | { configured: false }
  | { configured: true; ok: true; slug: string; owner: string }
  | { configured: true; ok: false; why: string }

export const checkAppEffect = (): Effect.Effect<AppCheck> =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(() => import('@lingtai/env'))
    if (!env.hasGitHubApp()) return { configured: false } as AppCheck
    return yield* Effect.gen(function* () {
      const github = yield* lift(() => import('@lingtai/github'))
      const credentials = env.githubApp()
      const reader = github.createAppReader({ appId: credentials.appId, privateKey: credentials.privateKey })
      const app = yield* lift(() => reader.request<{ slug: string; owner: { login: string } }>('GET', '/app', 'app'))
      return { configured: true, ok: true, slug: app.slug, owner: app.owner.login } as AppCheck
    }).pipe(recovering((err) => Effect.succeed({ configured: true, ok: false, why: err.message } as AppCheck)))
  })

/**
 * Resolves once an App is configured and answers; checks at once, then again
 * every two seconds for as long as the fiber lives — the loser of a race
 * against a keypress or a timeout (`waitForApp`) is interrupted, and an
 * interrupted repeat stops.
 */
export const pollForAppEffect = (): Effect.Effect<{ slug: string; owner: string }> =>
  checkAppEffect().pipe(
    Effect.repeat({
      schedule: Schedule.spaced('2 seconds'),
      until: (app) => app.configured && app.ok,
    }),
    Effect.flatMap((app) =>
      app.configured && app.ok
        ? Effect.succeed({ slug: app.slug, owner: app.owner })
        : Effect.die(new Error('the repeat ends only on an App that answers')),
    ),
  )
