/**
 * The App's setup URL: where GitHub sends a person who has installed it (#168).
 *
 * `?installation_id=…&setup_action=install|update|request&state=…`, and **none
 * of it is trusted or required.**
 *
 * - **`installation_id` can be spoofed** — GitHub's documentation says so in
 *   those words. Its remedy is a user access token, and Lingtai has no user
 *   OAuth (0045). So the id is checked against what the App itself reports,
 *   `GET /app/installations/{id}` with the App's JWT, in
 *   `verifiedInstallation`; an id that is not this App's names nothing, and a
 *   verified one is never acted on either — it only reaches `?installed=` on
 *   the redirect, and nothing reads that query string (#401). What decides
 *   what the App can see is `lingtai add`, asking GitHub directly when a
 *   person runs it.
 * - **`state` is not required**, because an organisation owner's approval
 *   arrives without one — a member requests, an owner approves days later.
 *   Nothing here reads it: `lingtai add` asks GitHub what the App can see
 *   now.
 *
 * A route and not a page, so the query is gone from the address bar by the time
 * anybody reads the screen. It writes nothing.
 */
import { setupReturn } from '@lingtai/conductor/pick-repository'
import { hasGitHubApp, githubApp } from '@lingtai/env'
import { createAppReader } from '@lingtai/github'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const location = hasGitHubApp()
    ? await setupReturn(createAppReader(githubApp()), url.searchParams)
    : '/setup/repository'

  return new Response(null, {
    status: 303,
    headers: { location: new URL(location, url.origin).toString(), 'cache-control': 'no-store' },
  })
}
