import { proposalFor, projectNameOf, readLocalTarget } from '@lingtai/conductor/add-from-page'
import { loadAllProjects } from '@lingtai/conductor/projects'
/**
 * Step 2 of adding a repository (#971): what Lingtai read, every proposed line
 * with its *change*, the two decisions, and the recipe beside them. The page
 * reads on the server and never throws — a read that fails is a sentence and an
 * editable empty line (`proposeSetup`'s `known: false`), and Add is still
 * possible. Nothing is written until Add.
 */
import { alreadyAdded } from '@lingtai/setup'
import { alreadyAddedSentence, type SetupTarget } from '@lingtai/setup'
import { Effect } from 'effect'

import { Bar } from '@/app/bar.tsx'

import { SetupForm } from './setup-form.tsx'
import { viewOf } from './view.ts'

export const dynamic = 'force-dynamic'

const SLUG = /^([\w.-]+)\/([\w.-]+)$/

type Params = { repo?: string; path?: string }

async function resolveTarget(params: Params): Promise<{ target: SetupTarget; remote: string | null } | string> {
  if (params.repo !== undefined) {
    const m = SLUG.exec(params.repo)
    return m === null
      ? `${params.repo} is not owner/repo`
      : { target: { kind: 'github', owner: m[1]!, repo: m[2]! }, remote: null }
  }
  if (params.path !== undefined) {
    const found = await Effect.runPromise(readLocalTarget(params.path))
    return found.ok ? { target: { kind: 'local', path: found.path }, remote: found.path } : found.why
  }
  return 'nothing was chosen'
}

export default async function Read({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const target = await resolveTarget(params)
  const frame = (fact: string, body: React.ReactNode) => (
    <main className="detail">
      <Bar project={undefined}>
        <span className="sep" />
        <span className="mono">repository</span>
      </Bar>
      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Repository</span>
            <span className="hfact">{fact}</span>
          </h2>
          {body}
        </section>
      </div>
    </main>
  )
  if (typeof target === 'string') {
    return frame(
      'nothing to read',
      <p className="note wiz-fail">
        {target}. <a href="/setup/repository">Choose a repository</a>.
      </p>,
    )
  }
  const project = projectNameOf(target.target)
  const label = target.target.kind === 'github' ? `${target.target.owner}/${target.target.repo}` : target.target.path
  const projects = await loadAllProjects().catch(() => [])
  if (alreadyAdded(projects, project) !== undefined) {
    return frame(
      label,
      <p className="note">
        {alreadyAddedSentence(project)}. <a href="/setup/repository">Choose another</a>.
      </p>,
    )
  }
  const proposal = await Effect.runPromise(proposalFor(target.target).pipe(Effect.timeout('25 seconds'))).catch(
    () => null,
  )
  if (proposal === null) {
    return frame(
      label,
      <p className="note wiz-fail">
        Reading the repository took too long. <a href="">Reload</a> to read it again.
      </p>,
    )
  }
  return frame(`step 2 — ${label}`, <SetupForm view={viewOf(proposal, project, target.remote)} />)
}
