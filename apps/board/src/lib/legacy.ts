/**
 * The old board addresses and where each now lives (#1498). A pure function of
 * the URL: no store and no register, so the proxy that calls it does no IO. A
 * hit is answered 308; `null` passes the request through. Targets are built by
 * `paths.ts` only.
 */
import { backlogPath, historyPath, landedHref, prPath, recipePath, sandboxTabPath, ticketPath, attemptTabPath, homePath, ticketRefOf } from './paths.ts'

const WHOLE = /^[1-9]\d*$/

/** The query string without `project`, serialized as `remember.ts` does (`+` → `%20`). */
function rest(search: URLSearchParams): string {
  const q = new URLSearchParams()
  for (const [k, v] of search) if (k !== 'project') q.append(k, v)
  const s = q.toString().replace(/\+/g, '%20')
  return s === '' ? '' : `?${s}`
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** Only the path part of a built address, the query being the caller's. */
const bare = (href: string): string => href.split('?')[0]!

/** `/task/<id>[/ticket|/attempt/<k>|/sandbox]`. */
function ofTask(segments: string[]): string | null {
  const id = decode(segments[0] ?? '')
  const ref = id === null ? null : ticketRefOf(id)
  if (ref === null) return null
  const tail = segments.slice(1)
  if (tail.length === 0) return ticketPath(ref)
  if (tail.length === 1 && tail[0] === 'ticket') return historyPath(ref)
  if (tail.length === 1 && tail[0] === 'sandbox') return bare(sandboxTabPath(ref))
  if (tail.length === 2 && tail[0] === 'attempt' && WHOLE.test(tail[1]!)) return attemptTabPath(ref, Number(tail[1]))
  return null
}

/**
 * The new address, query included, for an old `pathname` and `search`, or null.
 * An address that does not parse (`/task/foo`, `/task/ticket-x-abc`) gets none:
 * a redirect to a guessed address is worse than a 404.
 */
export function legacyRedirect(pathname: string, search: URLSearchParams): string | null {
  const segments = pathname.split('/').slice(1)
  if (segments.at(-1) === '' && segments.length > 1) return null
  const [head, ...tail] = segments
  const project = search.get('project')

  if (head === '' && tail.length === 0) return project === '' ? `/${rest(search)}` : project === null ? null : `${homePath(project)}${rest(search)}`
  if (head === 'landed' && tail.length === 0) {
    if (project === null) return null
    const href = landedHref({ project: project === '' ? null : project })
    return `${href}${rest(search)}`
  }
  if (head === 'backlog' && tail.length === 0) {
    if (project === null) return null
    return `${backlogPath(project)}${rest(search)}`
  }
  if (head === 'task' && tail.length >= 1) {
    const to = ofTask(tail)
    return to === null ? null : `${to}${rest(search)}`
  }
  if (head === 'pr' && tail.length >= 1 && tail.length <= 2) {
    const name = decode(tail[0]!)
    if (name === null || name === '') return null
    const to = tail.length === 1 ? prPath(name) : `${prPath(name)}/${tail[1]}`
    return `${to}${rest(search)}`
  }
  if (head === 'recipe' && tail.length === 1) {
    const name = decode(tail[0]!)
    return name === null || name === '' ? null : `${recipePath(name)}${rest(search)}`
  }
  return null
}
