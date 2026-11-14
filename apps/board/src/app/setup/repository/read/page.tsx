import { proposalFor, projectNameOf, readLocalTarget, recipeIsNew } from '@lingtai/conductor/add-from-page'
import { loadAllProjects, sandboxHostHere } from '@lingtai/conductor/projects'
/**
 * Step 2 of adding a repository (#971): what Lingtai read, every proposed line
 * with its *change*, the two decisions, and the recipe beside them. The page
 * reads on the server and never throws — a read that fails is a sentence and an
 * editable empty line (`proposeSetup`'s `known: false`), and Add is still
 * possible. Nothing is written until Add.
 */
import { verdictOf } from '@lingtai/recipe'
import { alreadyAdded } from '@lingtai/setup'
import { alreadyAddedSentence, type SetupTarget } from '@lingtai/setup'
import { Effect } from 'effect'

import { Bar } from '@/app/bar.tsx'

import { SetupForm } from './setup-form.tsx'
import { emptyView, viewOf } from './view.ts'

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
  // `suspend` so a reader that throws while it is built (an unreadable App key) is a failed read, not a failed page.
  const isNew = await Effect.runPromise(recipeIsNew(project))
  const proposal = await Effect.runPromise(
    Effect.suspend(() => proposalFor(target.target, undefined, { recipeIsNew: isNew })).pipe(
      Effect.timeout('25 seconds'),
    ),
  ).catch((err: unknown) => (err instanceof Error ? err.message : 'it took too long'))
  if (typeof proposal === 'string') {
    // The host check does not depend on the repository read: a failed read still says what this machine can do (#1160).
    const host = sandboxHostHere()
    const sandbox = isNew
      ? {
          verdict: await Effect.runPromise(verdictOf(host.answer)),
          install: host.install,
          builtIns: host.builtIns,
        }
      : null
    return frame(
      `step 2 — ${label}`,
      <>
        <p className="note wiz-fail">
          Reading the repository failed: {proposal}. <a href="">Reload</a> to read it again, or fill the lines in
          yourself.
        </p>
        <SetupForm view={emptyView(target.target, project, target.remote, proposal, sandbox)} />
      </>,
    )
  }
  return frame(`step 2 — ${label}`, <SetupForm view={viewOf(proposal, project, target.remote)} />)
}
