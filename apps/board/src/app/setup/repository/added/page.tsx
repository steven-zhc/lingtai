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

/**
 * What the added page says about the token (#1169): ask for it, say the file could not be read, or nothing.
 * An unreadable `config.yml` is said — never taken as *no setup needed* — but only for a project that would need a token.
 */
type TokenSay = { say: 'none' } | { say: 'ask' } | { say: 'unreadable'; why: string }

function tokenSay(recipe: Parameters<typeof needsClaudeToken>[0]): TokenSay {
  // Whether a token would matter at all, whatever the file holds: the same predicate over a state of nothing set.
  if (!needsClaudeToken(recipe, { environment: false, file: false, usable: false })) return { say: 'none' }
  try {
    const state = claudeTokenSetAt({ file: liveMachineText(), path: join(stateDir(), 'config.yml'), env: process.env })
    if ('unreadable' in state) return { say: 'unreadable', why: state.unreadable }
    return needsClaudeToken(recipe, state) ? { say: 'ask' } : { say: 'none' }
  } catch {
    return { say: 'unreadable', why: 'config.yml could not be read, so claude.oauth_token is unknown' }
  }
}

async function read(project: string | undefined): Promise<{ added: Added; token: TokenSay }> {
  if (project === undefined || project === '') return { added: { state: 'none' }, token: { say: 'none' } }
  const loaded = await loadProject(project).then(
    (state) => ({ ok: true as const, state }),
    () => ({ ok: false as const }),
  )
  if (!loaded.ok) return { added: { state: 'unreadable', project }, token: { say: 'none' } }
  const state = loaded.state
  if (state === null) return { added: { state: 'unregistered', project }, token: { say: 'none' } }
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
      token: { say: 'none' },
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
    token: tokenSay(resolved.recipe),
  }
}

export default async function AddedPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams
  const { added, token } = await read(project)
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
        {token.say === 'unreadable' ? (
          <section>
            <h2>
              <span className="hlab">Claude Code token</span>
              <span className="hfact">unknown</span>
            </h2>
            <p>
              {token.why} — this project's sandboxed Claude Code runs may be refused for want of a token. Fix the file,
              then set it at /setup/claude-token.
            </p>
          </section>
        ) : null}
        {token.say === 'ask' ? (
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
