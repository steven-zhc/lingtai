import { hostname } from 'node:os'

import { ghLoginHere, proposalFor, projectNameOf, readLocalTarget, recipeIsNew } from '@lingtai/conductor/add-from-page'
import { sandboxHostHere } from '@lingtai/conductor/projects'
import { loadAllProjects } from '@lingtai/project'
/**
 * Step 2 of adding a repository (#971): what Lingtai read, every proposed line
 * with its *change*, the two decisions, and the recipe beside them. The page
 * reads on the server and never throws — a read that fails is a sentence and an
 * editable empty line (`proposeSetup`'s `known: false`), and Add is still
 * possible. Nothing is written until Add.
 */
import { verdictOf } from '@lingtai/recipe'
import { alreadyAdded, defaultPersonalBranch, LINGTAI_BASE, machineName } from '@lingtai/setup'
import { alreadyAddedSentence, type SetupTarget } from '@lingtai/setup'
import { Effect } from 'effect'

import { SetupBar } from '@/app/global-bars.tsx'

import { ObjectTitle } from '../../../object-title.tsx'
import type { TeamView } from './read-model.ts'
import { SetupForm } from './setup-form.tsx'
import { emptyView, viewOf } from './view.ts'

export const dynamic = 'force-dynamic'

const SLUG = /^([\w.-]+)\/([\w.-]+)$/

type Params = { repo?: string; path?: string }

/** What the mode block starts from: the signed-in login on a `gh` machine, this machine's name, a directory's own branch. */
async function teamViewOf(target: SetupTarget, checkedOut: string | null): Promise<TeamView> {
  const host = machineName(hostname())
  if (target.kind === 'local') return { login: null, host, personal: LINGTAI_BASE, checkedOut }
  const login = await Effect.runPromise(ghLoginHere)
  return { login, host, personal: login === null ? '' : defaultPersonalBranch(login, hostname()), checkedOut: null }
}

async function resolveTarget(
  params: Params,
): Promise<{ target: SetupTarget; remote: string | null; branch: string | null } | string> {
  if (params.repo !== undefined) {
    const m = SLUG.exec(params.repo)
    return m === null
      ? `${params.repo} is not owner/repo`
      : { target: { kind: 'github', owner: m[1]!, repo: m[2]! }, remote: null, branch: null }
  }
  if (params.path !== undefined) {
    const found = await Effect.runPromise(readLocalTarget(params.path))
    return found.ok
      ? { target: { kind: 'local', path: found.path }, remote: found.path, branch: found.branch }
      : found.why
  }
  return 'nothing was chosen'
}

export default async function Read({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const target = await resolveTarget(params)
  const frame = (fact: string, body: React.ReactNode) => (
    <main className="detail">
      <SetupBar step="Repository" />
      <div className="detail-body">
        <section>
          <ObjectTitle tag="setup" tone="muted" title="Repository" meta={fact} />
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
  const team = await teamViewOf(target.target, target.branch)
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
        <SetupForm view={emptyView(target.target, project, target.remote, proposal, team, sandbox)} />
      </>,
    )
  }
  return frame(`step 2 — ${label}`, <SetupForm view={viewOf(proposal, project, target.remote, team)} />)
}
