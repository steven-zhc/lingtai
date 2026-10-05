/**
 * `actionsFromRecipe`'s own seam, `dispatchDeps` — not `createAgentAction`
 * directly, which `agent-action.test.ts` already covers.
 *
 * `usd` (`#370`) is not narrowable inside a dispatch's own `limits:`, unlike
 * `turns` and `wall`: it is carried from `deps.agent.limits` to the action
 * unchanged, the same way `diffBytes` already is. `dispatchDeps` rebuilds the
 * limits object by hand, so a key added to `AgentActionDeps.limits` and not to
 * that literal is dropped silently rather than refused — which is exactly how
 * `usd` reached the runtime as `undefined` even once `conduct.ts` started
 * carrying it.
 */
import type { RunOutcome, RunRequest, Runtime } from '@lingtai/agent'
import { describe, expect, it } from 'vitest'

import { actionsFromRecipe } from '../src/from-recipe.ts'

const outcome: RunOutcome = {
  exitCode: 0,
  turns: 7,
  durationMs: 1234,
  costUsd: 0.42,
  text: null,
  failure: null,
  sessionId: 's',
}

function reviewer(): Runtime & { seen: RunRequest[] } {
  const seen: RunRequest[] = []
  return {
    seen,
    capabilities: {
      id: 'claude-code',
      hooks: [],
      canFailClosed: true,
      canRewriteToolCall: false,
      providesTier: 'guarded',
      enforces: ['turns', 'wall', 'usd'],
    },
    async run(request) {
      seen.push(request)
      return outcome
    },
  }
}

const context = { runId: 'run-abc', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: {} }

describe("usd through actionsFromRecipe's review dispatch", () => {
  it('reaches the runtime where the ceiling declared one', async () => {
    const runtime = reviewer()
    const [action] = actionsFromRecipe('review', [{ name: 'review', agent: 'claude-code', prompt: 'read the diff' }], {
      agent: {
        runtime,
        issue: async () => ({ ref: '1', title: 't', body: '' }),
        diff: async () => 'diff --git a/x b/x\n+1',
        settingsPath: '/tmp/settings.json',
        limits: { turns: 40, wallMs: 60_000, diffBytes: 400_000, usd: 12 },
      },
    })

    await action!.run(context)

    expect(runtime.seen[0]!.limits.usd).toBe(12)
  })

  it('is absent where the ceiling declared none', async () => {
    const runtime = reviewer()
    const [action] = actionsFromRecipe('review', [{ name: 'review', agent: 'claude-code', prompt: 'read the diff' }], {
      agent: {
        runtime,
        issue: async () => ({ ref: '1', title: 't', body: '' }),
        diff: async () => 'diff --git a/x b/x\n+1',
        settingsPath: '/tmp/settings.json',
        limits: { turns: 40, wallMs: 60_000, diffBytes: 400_000 },
      },
    })

    await action!.run(context)

    expect(runtime.seen[0]!.limits.usd).toBeUndefined()
  })
})
