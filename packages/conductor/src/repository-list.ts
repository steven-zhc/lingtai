/**
 * What a person can pick from on this machine (#969, #970): the App's
 * installations, or the repositories the saved `gh` login can push to — one
 * wiring for `lingtai add` and the board's `/setup/repository`, so neither
 * keeps a copy (0125 §2).
 *
 * The one thing the two hosts do not share is how the App's install link is
 * found, so it is a port: the CLI asks `checkApp`, the board asks
 * `offerCreation`. Fails with the sentence to show; never an empty list.
 */
import { githubApp } from '@lingtai/env'
import { createAppReader, createGhReader, ghStatus } from '@lingtai/github'
import { listRepositories, type RepositoryList } from '@lingtai/setup'
import { Effect } from 'effect'

import { loadAllProjects } from './projects.ts'

export interface RepositoryListPorts {
  /** The App's own install page, or null — only asked on an App machine. */
  installUrl: () => Promise<string | null>
}

export function repositoryList(auth: 'app' | 'gh', ports: RepositoryListPorts): Effect.Effect<RepositoryList, Error> {
  return Effect.gen(function* () {
    const projects = yield* Effect.tryPromise({ try: () => loadAllProjects(), catch: (err) => err as Error })
    if (auth === 'gh') {
      return yield* listRepositories({
        auth,
        projects,
        gh: { status: () => ghStatus(), reader: createGhReader() },
      })
    }
    const credentials = yield* Effect.try({ try: () => githubApp(), catch: (err) => err as Error })
    const installUrl = yield* Effect.tryPromise({ try: () => ports.installUrl(), catch: (err) => err as Error })
    return yield* listRepositories({
      auth,
      projects,
      app: {
        reader: createAppReader({ appId: credentials.appId, privateKey: credentials.privateKey }),
        installUrl,
      },
    })
  })
}
