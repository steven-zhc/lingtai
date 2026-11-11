/**
 * `runQueue` asks whether *this project* is locked at the same two points as the
 * conductor-wide pause, and a sentence ends this project's queue (0126).
 */
import type { Runtime } from '@lingtai/agent'
import type { ProjectState } from '@lingtai/domain'
import type { Recipe } from '@lingtai/recipe'
import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { AgentHost, Repo } from '../src/ports.ts'
import { runQueue } from '../src/schedule.ts'
import { createSlots } from '../src/slots.ts'

const untouched = <T>(what: string): T =>
  new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === 'then') return undefined
        return () => {
          throw new Error(`a locked pass reached ${what}.${String(key)}`)
        }
      },
    },
  ) as T

vi.mock('../src/queue.ts', () => ({
  selectRunnable: async () => [{ taskId: 'ticket-p-7', issue: '7', title: 't', kind: 'bug' }],
}))
vi.mock('../src/conduct.ts', () => ({
  runOnce: () => {
    throw new Error('a locked pass reached runOnce')
  },
}))
vi.mock('@lingtai/recipe/settings', () => ({
  queueOf: () => ({ kinds: ['bug'], exclude: [], backoff: '1h', assignee: { take: 'both' } }),
  kindsOf: () => ['bug'],
  backoffOf: () => '1h',
}))

const queue = (
  locked: (project: string) => Promise<string | null>,
  paused?: () => Promise<string | null>,
  extra: { slots?: never } | Record<string, unknown> = {},
) => {
  const lines: string[] = []
  const client = {
    getIssue: async () => ({ body: '' }),
    listOpenIssues: async () => [
      {
        number: 7,
        title: 't',
        state: 'open' as const,
        labels: [{ name: 'bug', color: null }],
        assignees: [],
        dependencies: { blockedBy: 0 },
        parent: null,
        subIssues: null,
      },
    ],
  }
  return Effect.runPromise(
    runQueue({
      project: { project: 'p' } as ProjectState,
      client: client as never,
      runtime: untouched<Runtime>('runtime'),
      hookBinary: '/nonexistent',
      prompt: 'p',
      recipe: untouched<Recipe>('recipe'),
      ...(paused ? { paused } : {}),
      locked,
      ...extra,
      log: (l) => lines.push(l),
    }).pipe(
      Effect.provide(Layer.merge(Layer.succeed(Repo, untouched('repo')), Layer.succeed(AgentHost, untouched('agent')))),
    ),
  ).then((outcome) => ({ outcome, lines }))
}

describe('runQueue under one project’s lock', () => {
  it('stops before anything is offered, naming the project', async () => {
    const asked: string[] = []
    const { outcome, lines } = await queue(async (p) => {
      asked.push(p)
      return 'p is paused by human:a since 2026-11-10T14:20:00.000Z'
    })
    expect(asked).toEqual(['p'])
    expect(outcome.stopped).toBe('paused')
    expect(outcome.ran).toEqual([])
    expect(lines).toContain('p is paused by human:a since 2026-11-10T14:20:00.000Z')
  })

  it('a lock that lands during the queue read takes no claim', async () => {
    let asked = 0
    const { outcome } = await queue(async () => (++asked === 1 ? null : 'p is paused by human:a since now'))
    expect(asked).toBe(2)
    expect(outcome.stopped).toBe('paused')
    expect(outcome.ran).toEqual([])
  })

  it('a read that failed is a sentence, so it stops too', async () => {
    const { outcome } = await queue(async () => 'could not read whether p is paused — db down')
    expect(outcome.stopped).toBe('paused')
  })

  it('the conductor-wide pause is asked first', async () => {
    const locked = vi.fn(async () => null)
    const { outcome } = await queue(locked, async () => 'paused by human:ops')
    expect(outcome.stopped).toBe('paused')
    expect(locked).not.toHaveBeenCalled()
  })

  it('a lock that lands during the issue read starts nothing', async () => {
    let asked = 0
    const started: unknown[] = []
    const { outcome } = await queue(async () => (++asked <= 2 ? null : 'p is paused by human:a since now'), undefined, {
      slots: { set: createSlots(), limit: 2, started: (p: unknown) => started.push(p) },
    })
    expect(asked).toBe(3)
    expect(outcome.stopped).toBe('paused')
    expect(started).toEqual([])
  })
})
