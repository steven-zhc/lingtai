import { loadProjects } from '@lingtai/conductor/projects'
import { diskFiles, recipePath } from '@lingtai/recipe'
import { notFound } from 'next/navigation'

import { Bar } from '@/app/bar.tsx'
import { underHome } from '@/lib/recipe'
import { hashOf } from '@/lib/recipe-edit'

import { RecipeEditor } from './editor'

/**
 * A project's recipe as text (#973), the mock's `?v=4`. Save resolves the
 * draft and writes only a recipe that resolves. It is under `/setup/` and not
 * `/recipe/`, whose tree `recipe.test.tsx` holds to read-only.
 */
export const dynamic = 'force-dynamic'

export default async function EditRecipePage({ params }: { params: Promise<{ project: string }> }) {
  const name = decodeURIComponent((await params).project)
  if ((await loadProjects()).find((p) => p.project === name) === undefined) notFound()
  const path = recipePath(name)
  let text: string | null = null
  let failure: string | null = null
  try {
    text = await diskFiles.read(path)
  } catch (err) {
    failure = (err as Error).message
  }
  return (
    <main className="detail">
      <Bar project={name}>
        <span className="sep" />
        <span className="mono">edit recipe · {name}</span>
      </Bar>
      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Recipe</span>
            <span className="hfact mono">{underHome(path)}</span>
          </h2>
          {failure !== null ? (
            <p className="refusal">
              The recipe at <span className="mono">{underHome(path)}</span> could not be read: {failure}
            </p>
          ) : text === null ? (
            <p className="refusal">
              No recipe at <span className="mono">{underHome(path)}</span>. Creating one is setup&apos;s job.
            </p>
          ) : (
            <>
              <p className="rnote">
                Saved as typed, comments and all, and only if it resolves. A pass already running keeps the recipe it
                read; the next pass reads this one.
              </p>
              <RecipeEditor project={name} text={text} loaded={hashOf(text)} />
            </>
          )}
        </section>
      </div>
    </main>
  )
}
