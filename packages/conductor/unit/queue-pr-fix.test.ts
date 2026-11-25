/** `selectRunnableEffect`'s kind order with `task_view` stubbed, so it runs under `pnpm test` (0130 §5). */
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@lingtai/projector', () => ({ readTaskStatesEffect: () => Effect.succeed([]) }))

const { selectRunnableEffect } = await import('../src/queue.ts')

describe('selectRunnableEffect and lingtai:pr-fix', () => {
  const offered = [
    { ref: '3', title: 'a bug', kind: 'bug' },
    { ref: '50', title: 'a pr fix', kind: 'lingtai:pr-fix' },
  ]
  const run = (mode: 'solo' | 'team', kinds: string[] = ['bug']) =>
    Effect.runPromise(selectRunnableEffect({ project: 'p', offered, kinds, mode, backoffMs: 0 }))

  it('ranks the pr-fix ahead of a bug in team mode', async () => {
    expect((await run('team')).map((r) => r.issue)).toEqual(['50', '3'])
  })

  it('ranks it in team mode when the recipe names no kinds', async () => {
    expect((await run('team', [])).map((r) => r.issue)).toEqual(['50', '3'])
  })

  it('does not know the kind in solo mode', async () => {
    expect((await run('solo')).map((r) => r.issue)).toEqual(['3'])
  })
})
