/**
 * Step 3 of adding a repository (#972): what step 2 added. This reads and
 * `AddedCard` draws; every read is caught here so none can throw the page.
 */
import { join } from 'node:path'

import { currentRecipe, loadProject } from '@lingtai/conductor/projects'
import { stateDir } from '@lingtai/env'
import { recipePath } from '@lingtai/recipe'
import { queueOf, ticketSourceOf } from '@lingtai/recipe/settings'
import { liveMachineText, needsClaudeToken } from '@lingtai/setup'

import { Bar } from '@/app/bar.tsx'
import { claudeTokenSetAt } from '@/app/setup/claude-token/save.ts'
import { TokenForm } from '@/app/setup/claude-token/token-form.tsx'

import { AddedCard, type Added } from './added-card.tsx'

export const dynamic = 'force-dynamic'

/** Whether the project just added is one whose sandboxed Claude Code run would be refused for want of a token (#1169). */
function asksForToken(recipe: Parameters<typeof needsClaudeToken>[0]): boolean {
  try {
    const state = claudeTokenSetAt({ file: liveMachineText(), path: join(stateDir(), 'config.yml'), env: process.env })
    return needsClaudeToken(recipe, state)
  } catch {
    return false
  }
}

async function read(project: string | undefined): Promise<{ added: Added; askToken: boolean }> {
  if (project === undefined || project === '') return { added: { state: 'none' }, askToken: false }
  const loaded = await loadProject(project).then(
    (state) => ({ ok: true as const, state }),
    () => ({ ok: false as const }),
  )
  if (!loaded.ok) return { added: { state: 'unreadable', project }, askToken: false }
  const state = loaded.state
  if (state === null) return { added: { state: 'unregistered', project }, askToken: false }
  const name = state.project ?? project
  const recipe = recipePath(name)
  const resolved = await currentRecipe(state).then(
    (r) => r,
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  )
  if (resolved instanceof Error) {
    return {
      added: {
        state: 'registered',
        project: name,
        recipe,
        read: { ok: false, problem: resolved.message.replace(/\s*\n\s*/g, ' ').trim() },
      },
      askToken: false,
    }
  }
  const queue = queueOf(resolved.recipe)
  return {
    added: {
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
    },
    askToken: asksForToken(resolved.recipe),
  }
}

export default async function AddedPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams
  const { added, askToken } = await read(project)
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
        {askToken ? (
          <section>
            <h2>
              <span className="hlab">Claude Code token</span>
              <span className="hfact">needed</span>
            </h2>
            <p>
              This project's sandboxed Claude Code runs are refused until a token is set. Run{' '}
              <code>claude setup-token</code> in a terminal and paste what it prints — or skip, and set it later at
              /setup/claude-token.
            </p>
            <TokenForm isSet={false} />
          </section>
        ) : null}
      </div>
    </main>
  )
}
