/**
 * Step 3 of adding a repository (#972 replaces this). Until then it names the
 * project step 2 added and where its recipe is.
 */
import { recipePath } from '@lingtai/recipe'

import { Bar } from '@/app/bar.tsx'

export const dynamic = 'force-dynamic'

export default async function Added({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams
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
          {project === undefined || project === '' ? (
            <p className="note">
              Nothing was added. <a href="/setup/repository">Choose a repository</a>.
            </p>
          ) : (
            <p className="note">
              <span className="mono">{project}</span> is added. Its recipe is{' '}
              <span className="mono">{recipePath(project)}</span>, and it is edited there.
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
