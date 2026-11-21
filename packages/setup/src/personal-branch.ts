/**
 * The personal branch a team project works on, as 0130 §2 names it by default:
 * `<login>/<machine>`, the machine part made safe by the one rule below.
 *
 * Pure, so the CLI's `lingtai add` and the board's add-a-project step (#1325)
 * propose the same name. It is applied to whatever `os.hostname()` returns and
 * never to a second source — on macOS that is the network name, not the
 * friendly one. Whether the result is a branch git accepts is
 * `branchNameRefusal`'s question, in `@lingtai/recipe`, not this function's.
 */
import { branchNameRefusal } from '@lingtai/recipe'

const MACHINE_AT_MOST = 24

/** `.local` dropped, lower-cased, anything outside `a-z0-9-` a `-`, runs collapsed, trimmed, cut to 24; `machine` if nothing is left. */
export function machineName(hostname: string): string {
  const safe = hostname
    .replace(/\.local$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MACHINE_AT_MOST)
    // The cut can land just after a `-`.
    .replace(/-+$/, '')
  return safe === '' ? 'machine' : safe
}

/** `<login>/<machine>` for the person on this host (0130 §2). */
export function defaultPersonalBranch(login: string, hostname: string): string {
  return `${login}/${machineName(hostname)}`
}

/** Why `name` cannot be the personal branch of a project whose main is `main`, or null where it can: git's rules, and never `main` itself (any case). */
export function personalRefusal(name: string, main: string): string | null {
  const why = branchNameRefusal(name)
  if (why !== null) return `${name === '' ? 'the personal branch' : name} ${why}`
  if (main.trim() !== '' && name.toLowerCase() === main.toLowerCase()) {
    return `${name} is the main branch — the personal branch must be a different one`
  }
  return null
}

/** A name git would take made from `name`, part by part at `/` by `machineName`'s rule; null where it is already fine or nothing safe comes of it. */
export function personalFix(name: string): string | null {
  const fixed = name
    .split('/')
    .map((part) => (part === '' ? '' : machineName(part)))
    .filter((part) => part !== '')
    .join('/')
  return fixed !== name && fixed !== '' && branchNameRefusal(fixed) === null ? fixed : null
}
