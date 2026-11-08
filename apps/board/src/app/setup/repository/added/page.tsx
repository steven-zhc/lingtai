/**
 * Step 3 of adding a repository (#972): what step 2 added. This reads and
 * `AddedCard` draws; every read is caught here so none can throw the page.
 */
import { currentRecipe, loadProject } from '@lingtai/conductor/projects'
import { recipePath } from '@lingtai/recipe'
import { queueOf, ticketSourceOf } from '@lingtai/recipe/settings'

import { Bar } from '@/app/bar.tsx'

import { AddedCard, type Added } from './added-card.tsx'

export const dynamic = 'force-dynamic'

async function read(project: string | undefined): Promise<Added> {
  if (project === undefined || project === '') return { state: 'none' }
  const loaded = await loadProject(project).then(
    (state) => ({ ok: true as const, state }),
    () => ({ ok: false as const }),
  )
  if (!loaded.ok) return { state: 'unreadable', project }
  const state = loaded.state
  if (state === null) return { state: 'unregistered', project }
  const name = state.project ?? project
  const recipe = recipePath(name)
  const resolved = await currentRecipe(state).then(
    (r) => r,
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  )
  if (resolved instanceof Error) {
    return {
      state: 'registered',
      project: name,
      recipe,
      read: { ok: false, problem: resolved.message.replace(/\s*\n\s*/g, ' ').trim() },
    }
  }
  const queue = queueOf(resolved.recipe)
  return {
    state: 'registered',
    project: name,
    recipe,
    read: {
      ok: true,
      kinds: [...queue.kinds],
      held: [...queue.exclude],
      owner: state.owner,
      github: ticketSourceOf(resolved.recipe) === 'github',
    },
  }
}

export default async function AddedPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams
  const added = await read(project)
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
            <span className="hfact">added</span>
          </h2>
          <AddedCard {...added} />
        </section>
      </div>
    </main>
  )
}
