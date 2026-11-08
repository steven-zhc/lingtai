/**
 * Step 1 of adding a repository (#970): which one — a list on either machine,
 * `owner/repo` typed, or a local path. This path still has to answer for three
 * callers it cannot tell apart from any other request:
 *
 * - **Every App this board ever created carries this as its manifest's
 *   `setupUrl`** (`github-app/start/route.ts`), so `installed/route.ts`'s 303
 *   lands here however long ago the App was made, and on GitHub's side there
 *   is no changing that address now.
 * - **`lingtai init` opens this in a browser and prints it**
 *   (`apps/cli/src/init.ts`).
 * - **The board's own `+`** (`apps/board/src/app/projects.tsx`) links here.
 *
 * The page reads the list on the server and never throws: a failed read is a
 * sentence and the `owner/repo` box, never an empty list. The filter, the tab
 * and the path box are `pick-repository.tsx`, a client component that is
 * handed plain rows. Nothing is written in this step.
 */
import { offerCreation } from '@lingtai/conductor/create-app'
import { repositoryList } from '@lingtai/conductor/repository-list'
import { githubAuthKind } from '@lingtai/env'
import { Effect } from 'effect'

import { Bar } from '@/app/bar.tsx'

import type { Source } from './pick-model.ts'
import { PickRepository } from './pick-repository.tsx'
import { viewOf } from './view.ts'

export const dynamic = 'force-dynamic'

async function read(auth: 'app' | 'gh' | null): Promise<Source> {
  if (auth === null) return null
  try {
    const list = await Effect.runPromise(
      repositoryList(auth, {
        installUrl: () => offerCreation().then((offer) => offer.installUrl),
      }).pipe(Effect.timeout('20 seconds')),
    )
    return { list: viewOf(list) }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

export default async function PickRepositoryPage({ searchParams }: { searchParams: Promise<{ requested?: string }> }) {
  const params = await searchParams
  let auth: 'app' | 'gh' | null = null
  let source: Source
  try {
    auth = githubAuthKind()
    source = await read(auth)
  } catch (err) {
    source = { error: (err as Error).message }
  }
  const app = auth === 'app'
  return (
    <main className="detail">
      <Bar project={undefined}>
        <span className="sep" />
        <span className="mono">repository</span>
      </Bar>

      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Repository</span>
            <span className="hfact">step 1 — which one</span>
          </h2>
          {params.requested === '1' && app ? (
            <p className="note">
              The install was requested, and an organisation owner has to approve it on GitHub. Once they have, reload
              this page.
            </p>
          ) : null}
          <PickRepository source={source} />
        </section>
      </div>
    </main>
  )
}
