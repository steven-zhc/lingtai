/**
 * The home page's memory of the project a person chose (#1435).
 *
 * Pure, with no `next/*`, `node:` or `@lingtai/*` value import: client files
 * import it (`unit/client-graph.test.ts`). **Only a person's choice writes the
 * cookie**, from the browser, through `rememberProject`; the proxy reads it for
 * a bare `/` and never writes it, so a refresh cannot rewrite the memory.
 */

export const PROJECT_COOKIE = 'lingtai-project'

const YEAR = 60 * 60 * 24 * 365

/**
 * The proxy's decision for `/`: the target to redirect (307) to, or `null` to
 * pass through. A request that names `project` (empty included) is never
 * redirected. `remembered` is the already-decoded cookie value; anything but a
 * non-empty string means *all projects*, so `''` never reaches the reads.
 */
export function homeRedirect(search: URLSearchParams, remembered: string | undefined): string | null {
  if (search.has('project')) return null
  const rest = new URLSearchParams(search)
  const name = typeof remembered === 'string' && remembered !== '' ? remembered : ''
  const q = new URLSearchParams({ project: name })
  for (const [k, v] of rest) q.append(k, v)
  return `/?${q.toString().replace(/\+/g, '%20')}`
}

/**
 * The remembered name out of a raw `Cookie` header. A `lingtai-project` pair
 * with no `=` is malformed and reads as absent (Next's parser would say `'true'`),
 * as does a value that cannot be decoded.
 */
export function rememberedProject(header: string | null | undefined): string | undefined {
  for (const pair of (header ?? '').split(';')) {
    const i = pair.indexOf('=')
    if (i < 0 || pair.slice(0, i).trim() !== PROJECT_COOKIE) continue
    try {
      return decodeURIComponent(pair.slice(i + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The cookie line for a choice; `undefined` is *all projects*. Not `HttpOnly`: the browser writes it. */
export function projectCookie(choice: string | undefined): string {
  return `${PROJECT_COOKIE}=${encodeURIComponent(choice ?? '')}; Path=/; SameSite=Lax; Max-Age=${YEAR}`
}

/** Called where a person chooses a project, and nowhere that renders, refreshes or prefetches. */
export function rememberProject(choice: string | undefined): void {
  document.cookie = projectCookie(choice)
}
