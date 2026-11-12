/**
 * The review and the draft as Effects (#1043): what a promise `await` kept
 * without saying so — the restore on an interruption, the soft fix-delta read
 * and the late getters.
 */
import type { RunOutcome, RunRequest, Runtime } from '@lingtai/agent'
import { Effect, Exit, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeAgentAction, agentPortDepsFrom } from '../src/agent-action.ts'
import { actionPortsFromRecipe, actionPortDepsFrom, actionsFromRecipe } from '../src/from-recipe.ts'

const answer: RunOutcome = {
  exitCode: 0,
  turns: 1,
  durationMs: 1,
  costUsd: null,
  text: '{"findings":[]}',
  failure: null,
  sessionId: 's',
}

const runtimeOf = (run: Runtime['run']): Runtime & { seen: RunRequest[] } => {
  const seen: RunRequest[] = []
  return {
    seen,
    capabilities: {
      id: 'claude-code',
      hooks: [],
      canFailClosed: true,
      canRewriteToolCall: false,
      providesTier: 'guarded',
      enforces: ['turns', 'wall'],
    },
    run: (request) => {
      seen.push(request)
      return run(request)
    },
  }
}

const context = { runId: 'pass-abc', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: {} }
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n'

const baseDeps = (runtime: Runtime, over: Record<string, unknown> = {}) => ({
  runtime,
  issue: async () => ({ ref: '1', title: 't', body: '' }),
  diff: async () => DIFF,
  restore: async () => ({ untouched: true as const }),
  settingsPath: '/tmp/settings.json',
  limits: { turns: 40, wallMs: 60_000, diffBytes: 400_000 },
  ...over,
})

describe('the review as an Effect (#1043)', () => {
  it('restores the worktree once, with onSha, when the fiber is interrupted', async () => {
    let aborted = false
    const runtime = runtimeOf(
      (request) =>
        new Promise<RunOutcome>(() => {
          request.signal?.addEventListener('abort', () => (aborted = true))
        }),
    )
    const restored: string[] = []
    const port = makeAgentAction(
      { name: 'review', prompt: '' },
      agentPortDepsFrom(
        baseDeps(runtime, {
          restore: async (sha: string) => {
            restored.push(sha)
            return { untouched: true as const }
          },
        }),
      ),
    )

    const fiber = Effect.runFork(port.run(context))
    while (runtime.seen.length === 0) await new Promise((r) => setTimeout(r, 1))
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(restored).toEqual([context.onSha])
    expect(aborted).toBe(true)
  })

  it('falls back to a full review when the fix delta cannot be read', async () => {
    const runtime = runtimeOf(async () => answer)
    const notes: string[] = []
    const port = makeAgentAction(
      { name: 'review', prompt: '' },
      agentPortDepsFrom(
        baseDeps(runtime, {
          diff: async (from?: string) => {
            if (from !== undefined) throw new Error('git fell over')
            return DIFF
          },
        }),
      ),
    )

    const result = await Effect.runPromise(
      port.run({
        ...context,
        reviewedSha: 'b'.repeat(40),
        log: { note: (_t: string, text: string) => void notes.push(text) } as never,
      }),
    )

    expect(runtime.seen).toHaveLength(1)
    expect(result.verdict).toBe('passed')
    expect(notes).toContain('the fix delta could not be read (git fell over); this is a full review')
  })
})

describe('settingsPath is read when the action runs (#1043)', () => {
  const step = [{ name: 'review', agent: 'claude-code' as const, prompt: '' }]

  it('through actionsFromRecipe', async () => {
    let path = '/tmp/before.json'
    const runtime = runtimeOf(async () => answer)
    const deps = baseDeps(runtime)
    const [action] = actionsFromRecipe('review', step, {
      agent: {
        ...deps,
        get settingsPath() {
          return path
        },
      },
    })
    path = '/tmp/after.json'
    await action!.run(context)
    expect(runtime.seen[0]!.settingsPath).toBe('/tmp/after.json')
  })

  it('through actionPortsFromRecipe', async () => {
    let path = '/tmp/before.json'
    const runtime = runtimeOf(async () => answer)
    const deps = baseDeps(runtime)
    const [port] = actionPortsFromRecipe(
      'review',
      step,
      actionPortDepsFrom({
        agent: {
          ...deps,
          get settingsPath() {
            return path
          },
        },
      }),
    )
    path = '/tmp/after.json'
    await Effect.runPromise(port!.run(context))
    expect(runtime.seen[0]!.settingsPath).toBe('/tmp/after.json')
  })
})
