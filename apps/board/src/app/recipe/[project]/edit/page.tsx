import { loadProjects } from '@lingtai/conductor/projects'
import { diskFiles, recipePath } from '@lingtai/recipe'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { Bar } from '@/app/bar.tsx'

import { RecipeForm } from './form'

/**
 * The recipe as text (#973). Saving goes through `app/actions.ts`'s
 * `saveRecipe` (0125 §6), which resolves the text and writes only what
 * resolves; this page only reads the file once and hands it to the form.
 */
export const dynamic = 'force-dynamic'

export default async function EditRecipePage({ params }: { params: Promise<{ project: string }> }) {
  const name = decodeURIComponent((await params).project)
  if ((await loadProjects()).find((p) => p.project === name) === undefined) notFound()
  const path = recipePath(name)
  const text = await diskFiles.read(path)
  return (
    <main className="detail">
      <Bar project={name}>
        <span className="sep" />
        <span className="mono">edit recipe · {name}</span>
      </Bar>
      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Recipe YAML</span>
            <span className="hfact mono">{path}</span>
          </h2>
          {text === null ? <p>no recipe at {path}</p> : <RecipeForm project={name} initial={text} />}
          <p>
            <Link href={`/recipe/${encodeURIComponent(name)}`}>← what the recipe says today</Link>
          </p>
        </section>
      </div>
    </main>
  )
}
