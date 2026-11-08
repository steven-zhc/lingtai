'use server'

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'

import { gitEffect } from '@lingtai/repo'
import { readLocalRepository } from '@lingtai/setup'
import { Effect } from 'effect'

import type { LocalView } from './pick-model.ts'

/**
 * Step 1's one server action: check a typed directory. It reads, it never
 * writes (#970), and it is an action rather than a page read so the filter
 * and the tab are not re-rendered, and the GitHub list not re-fetched, for
 * every key pressed.
 */
export async function checkLocalPath(input: string): Promise<LocalView> {
  const found = await Effect.runPromise(
    readLocalRepository(input, {
      home: homedir(),
      stat: (path) =>
        Effect.promise(() =>
          stat(path).then(
            (s) => (s.isDirectory() ? ('directory' as const) : ('file' as const)),
            () => 'missing' as const,
          ),
        ),
      git: (cwd, args) =>
        gitEffect([...args], { cwd }).pipe(
          Effect.match({
            onSuccess: (out) => ({ ok: true, out }),
            onFailure: (err) => ({ ok: false, out: err.detail }),
          }),
        ),
    }),
  )
  if (!found.ok) return { ok: false, say: found.why, path: input, branch: null }
  const where =
    found.github !== null
      ? `${found.remote} — tickets still come from its issues`
      : found.remote !== null
        ? `${found.remote} — Lingtai keeps its own tickets`
        : 'no remote — Lingtai keeps its own tickets'
  return { ok: true, say: where, path: found.path, branch: found.branch }
}
