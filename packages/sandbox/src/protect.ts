/**
 * The protected-path check S7 refuses a recipe's `write` and `deny` with (0127).
 *
 * A path is refused when it **is**, lies **inside**, or **contains** a protected one, because `write: [/usr]`
 * or an ancestor of `$HOME` would otherwise grant writes over directories that are protected only by being
 * left out of `allowWrite`. Segment-wise, never by string prefix. Absolute normalised paths only: a symlink or
 * case-fold that only `realpath` would reveal is out of scope.
 */
import { posix } from 'node:path'

import { denyRead, type HostFacts } from './policy.ts'

export type Relation = 'is' | 'inside' | 'contains' | 'relative'

export interface Refusal {
  readonly path: string
  /** What it collided with, by kind: `deny-list`, `home`, `state-dir`, `mirror`, `runtime-config`, `host-tool`, `path`. */
  readonly kind: string
  readonly protectedPath: string
  readonly relation: Relation
}

interface Entry {
  readonly kind: string
  readonly path: string
  /** `$HOME` is protected against being written or contained, not against a write inside it (0127). */
  readonly refuseInside: boolean
}

export const protectedEntries = (host: HostFacts, mirror: string): Entry[] => {
  const entry = (kind: string, path: string, refuseInside = true): Entry => ({ kind, path, refuseInside })
  const h = (...parts: string[]) => posix.join(host.home, ...parts)
  return [
    ...denyRead(host).map((p) => entry(p === host.stateDir ? 'state-dir' : 'deny-list', p)),
    entry('home', host.home, false),
    entry('mirror', mirror),
    entry('runtime-config', h('.claude')),
    entry('runtime-config', h('.claude.json')),
    entry('runtime-config', h('.codex')),
    entry('host-tool', h('.cache')),
    entry('host-tool', h('.local')),
    ...(host.pnpmHome ? [entry('host-tool', host.pnpmHome)] : []),
    ...(host.platform === 'darwin' ? [entry('host-tool', h('Library'))] : []),
    ...host.path.map((p) => entry('path', p)),
  ]
}

const within = (outer: string, inner: string): boolean => {
  const rel = posix.relative(outer, inner)
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel))
}

export const refuseProtected = (
  paths: readonly string[],
  host: HostFacts,
  options: { readonly mirror: string },
): Refusal[] => {
  const entries = protectedEntries(host, options.mirror)
  const refusals: Refusal[] = []
  for (const raw of paths) {
    if (!posix.isAbsolute(raw)) {
      refusals.push({ path: raw, kind: 'relative', protectedPath: '', relation: 'relative' })
      continue
    }
    const path = posix.resolve(raw)
    for (const e of entries) {
      const relation: Relation | undefined =
        path === e.path
          ? 'is'
          : within(path, e.path)
            ? 'contains'
            : e.refuseInside && within(e.path, path)
              ? 'inside'
              : undefined
      if (relation) refusals.push({ path: raw, kind: e.kind, protectedPath: e.path, relation })
    }
  }
  return refusals
}
