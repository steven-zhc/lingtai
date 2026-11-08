/**
 * A local directory, read as a candidate repository for `/setup/repository`
 * (#970): is it a git repository, which branch is it on, and where do its
 * tickets come from. Read-only — it runs `rev-parse`, `branch --show-current`
 * and `remote get-url`, nothing that could run a repository's own hooks.
 *
 * The ports are injected so a test needs no `git` and no filesystem. The
 * sentences are `first-project.ts`'s (`does not exist`, `is not a git
 * repository`), so the board and `lingtai add --local` refuse in one voice.
 */
import { isAbsolute, resolve } from 'node:path'

import { Effect } from 'effect'

import { githubSlugOfRemote } from './ticket-source.ts'

export interface LocalPorts {
  /** `git <args>` in `cwd`: never fails, `ok: false` carries git's own words. */
  git: (cwd: string, args: readonly string[]) => Effect.Effect<{ ok: boolean; out: string }>
  stat: (path: string) => Effect.Effect<'directory' | 'file' | 'missing'>
  home: string
}

export type LocalRepository =
  | {
      ok: true
      /** The repository's top level — what is shown and what goes in the URL. */
      path: string
      /** Null when HEAD is detached. */
      branch: string | null
      /** `origin`, with any credentials removed; null when there is none. */
      remote: string | null
      /** `owner/repo`, when `origin` is a github.com remote. */
      github: string | null
    }
  | { ok: false; why: string }

/** `https://user:token@host/…` → `https://host/…`: an `origin` can carry a token. */
export const withoutCredentials = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/i, '$1')

export function readLocalRepository(input: string, ports: LocalPorts): Effect.Effect<LocalRepository> {
  return Effect.gen(function* () {
    let typed = input.trim()
    if (typed === '') return { ok: false, why: 'a directory is needed' } as const
    if (typed === '~') typed = ports.home
    else if (typed.startsWith('~/')) typed = `${ports.home}/${typed.slice(2)}`
    // `resolve` on a relative path would use the board's own working directory.
    if (!isAbsolute(typed)) return { ok: false, why: `${typed} is not an absolute path` } as const
    const dir = resolve(typed)

    const kind = yield* ports.stat(dir)
    if (kind === 'missing') return { ok: false, why: `${dir} does not exist` } as const
    if (kind === 'file') return { ok: false, why: `${dir} is not a directory` } as const

    const top = yield* ports.git(dir, ['rev-parse', '--show-toplevel'])
    if (!top.ok) {
      const detail = top.out.trim()
      return { ok: false, why: `${dir} is not a git repository${detail === '' ? '' : ` — ${detail}`}` } as const
    }
    const path = top.out.trim()

    const branch = yield* ports.git(path, ['branch', '--show-current'])
    const origin = yield* ports.git(path, ['remote', 'get-url', 'origin'])
    const raw = origin.ok ? origin.out.trim() : ''
    const slug = raw === '' ? null : githubSlugOfRemote(raw)
    return {
      ok: true,
      path,
      branch: branch.ok && branch.out.trim() !== '' ? branch.out.trim() : null,
      remote: raw === '' ? null : withoutCredentials(raw),
      github: slug === null ? null : `${slug.owner}/${slug.repo}`,
    } as const
  })
}
