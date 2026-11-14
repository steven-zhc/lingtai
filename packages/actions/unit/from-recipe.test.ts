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
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ActionUnavailableError } from '../src/from-recipe.ts'
import { actionsFromRecipe } from '../test/promise-actions.ts'

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
      enforces: ['turns', 'wall', 'usd'],
    },
    run: (request) => {
      seen.push(request)
      return Effect.succeed(outcome)
    },
  }
}

const context = { runId: 'pass-abc', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: {} }

describe("usd through actionsFromRecipe's review dispatch", () => {
  it('reaches the runtime where the ceiling declared one', async () => {
    const runtime = reviewer()
    const [action] = actionsFromRecipe('review', [{ name: 'review', agent: 'claude-code', prompt: 'read the diff' }], {
      agent: {
        runtime,
        issue: async () => ({ ref: '1', title: 't', body: '' }),
        diff: async () => 'diff --git a/x b/x\n+1',
        restore: async () => ({ untouched: true as const }),
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
        restore: async () => ({ untouched: true as const }),
        settingsPath: '/tmp/settings.json',
        limits: { turns: 40, wallMs: 60_000, diffBytes: 400_000 },
      },
    })

    await action!.run(context)

    expect(runtime.seen[0]!.limits.usd).toBeUndefined()
  })
})

describe("landed and settingsPath through actionsFromRecipe's review dispatch (#1044)", () => {
  const moved = { paths: ['src/x.ts'], fromSha: 'b'.repeat(40), toSha: 'c'.repeat(40) }
  const build = (runtime: Runtime, extra: Record<string, unknown>) =>
    actionsFromRecipe('review', [{ name: 'review', agent: 'claude-code', prompt: '' }], {
      agent: {
        runtime,
        issue: async () => ({ ref: '1', title: 't', body: '' }),
        diff: async () => 'diff --git a/x b/x\n+1',
        restore: async () => ({ untouched: true as const }),
        settingsPath: '/tmp/settings.json',
        limits: { turns: 40, wallMs: 60_000, diffBytes: 400_000 },
        ...extra,
      },
    })[0]!

  it('shows the block for the overlapping paths after a base move', async () => {
    const runtime = reviewer()
    const calls: unknown[] = []
    const landed = async (m: typeof moved) => {
      calls.push(m)
      return [{ path: 'src/x.ts', diff: '+changed on base' }]
    }
    await build(runtime, { landed }).run({ ...context, landedOnBase: moved })

    expect(calls).toEqual([moved])
    expect(runtime.seen[0]!.prompt).toContain('## What landed on the base')
    expect(runtime.seen[0]!.prompt).toContain('src/x.ts')
  })

  it('asks nothing where the base did not move', async () => {
    const runtime = reviewer()
    let called = 0
    const landed = async () => {
      called += 1
      return []
    }
    await build(runtime, { landed }).run(context)

    expect(called).toBe(0)
    expect(runtime.seen[0]!.prompt).not.toContain('## What landed on the base')
  })

  it('still reads settingsPath when the action runs, not when it is built', async () => {
    const runtime = reviewer()
    const agent = {
      runtime,
      issue: async () => ({ ref: '1', title: 't', body: '' }),
      diff: async () => 'diff --git a/x b/x\n+1',
      restore: async () => ({ untouched: true as const }),
      settingsPath: '/tmp/before.json',
      limits: { turns: 40, wallMs: 60_000, diffBytes: 400_000 },
    }
    const [action] = actionsFromRecipe('review', [{ name: 'review', agent: 'claude-code', prompt: '' }], { agent })
    agent.settingsPath = '/tmp/after.json'
    await action!.run(context)

    expect(JSON.stringify(runtime.seen[0])).toContain('/tmp/after.json')
  })
})

/**
 * **`implement` wraps a `run:` and the other four steps do not** (`#390`).
 *
 * `env` alone is what a plain `run:` needs; `implement`'s copy needs a git
 * port too, and the refusal names what is missing by name rather than falling
 * back to a process action that would commit nothing silently.
 */
describe('a run: at implement needs the git port, and env: alone is not enough', () => {
  const action = { name: 'format', run: 'pnpm fmt', timeout: '5m', env: [] as string[] }

  it('refuses by name when no git port was supplied', () => {
    expect(() => actionsFromRecipe('implement', [action], { env: () => ({}) })).toThrow(ActionUnavailableError)
    expect(() => actionsFromRecipe('implement', [action], { env: () => ({}) })).toThrow(/no git port was supplied/)
  })

  it('builds once both are supplied', () => {
    const built = actionsFromRecipe('implement', [action], {
      env: () => ({}),
      keptRun: { clean: async () => ({ ok: true }), keep: async () => ({ nothing: true }) },
    })
    expect(built.map((a) => a.name)).toEqual(['format'])
    expect(built[0]!.kind).toBe('run')
  })
})

describe('designAsks through actionsFromRecipe at design (#649)', () => {
  const draftWith = async (designAsks: number) => {
    const runtime = reviewer()
    const [action] = actionsFromRecipe('design', [{ name: 'draft', agent: 'claude-code', prompt: '' }], {
      agent: {
        runtime,
        issue: async () => ({ ref: '1', title: 't', body: '' }),
        designAsks,
        diff: async () => '',
        restore: async () => ({ untouched: true as const }),
        settingsPath: '/tmp/settings.json',
        limits: { turns: 40, wallMs: 60_000, diffBytes: 400_000 },
      },
    })
    await action!.run(context)
    return runtime.seen[0]!.prompt
  }

  it('shows the form with no fence once the ticket has asked twice', async () => {
    const prompt = await draftWith(2)
    expect(prompt).not.toContain('```question')
    expect(prompt).toContain('## Assumptions')
  })

  it('shows the question form below that', async () => {
    expect(await draftWith(1)).toContain('```question')
  })
})
