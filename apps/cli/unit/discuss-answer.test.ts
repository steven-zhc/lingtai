/**
 * #1105. A discussion never throws into the loop, and the run log is deleted on every exit.
 *
 * `answerDiscussion` reaches the filesystem, the mirror and the runtime; each is replaced here, so
 * what is under test is the order and the exits: an `ask` that dies is a crash the discussion
 * records, the log's `close('delete')` still runs, and the loop's port (`answerOutstandingQueued`
 * over it) does not fail.
 */
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

const world = vi.hoisted(() => ({ closed: [] as string[], store: null as unknown }))

vi.mock('node:fs/promises', async (importActual) => ({
  ...(await importActual<typeof import('node:fs/promises')>()),
  mkdir: async () => undefined,
  rm: async () => undefined,
  writeFile: async () => undefined,
  utimes: async () => undefined,
}))
vi.mock('@lingtai/agent', async (importActual) => {
  const { Effect: E } = await import('effect')
  return {
    ...(await importActual<typeof import('@lingtai/agent')>()),
    openRunLog: async () => ({
      note: () => {},
      close: async (how: string) => {
        world.closed.push(how)
      },
    }),
    createRuntime: () => ({
      capabilities: {},
      run: () => E.die(new Error('boom')),
    }),
  }
})
vi.mock('@lingtai/conductor/projects', async (importActual) => ({
  ...(await importActual<typeof import('@lingtai/conductor/projects')>()),
  loadProjectEffect: () => Effect.succeed(null),
  currentRecipe: async () => {
    throw new Error('unreachable: no project is registered')
  },
}))
vi.mock('@lingtai/repo', async (importActual) => ({
  ...(await importActual<typeof import('@lingtai/repo')>()),
  refShaEffect: () => Effect.succeed(null),
  listAtEffect: () => Effect.succeed({ paths: [], truncated: false }),
  readAtEffect: () => Effect.succeed(null),
}))
vi.mock('@lingtai/event-store', async (importActual) => {
  const { createMemoryEventStore } = await import('@lingtai/event-store/memory')
  const eventStore = createMemoryEventStore()
  world.store = eventStore
  return { ...(await importActual<typeof import('@lingtai/event-store')>()), eventStore }
})

import type { DiscussionRequest } from '@lingtai/domain'

import { answerDiscussion, answerOutstandingQueued } from '../src/discuss.ts'

const request = (): DiscussionRequest => ({
  chatId: crypto.randomUUID(),
  ticketId: 'ticket-lingtai-1',
  attempt: null,
  question: 'why?',
  by: 'human:test',
})

describe('answerDiscussion', () => {
  it('deletes the run log and logs the crash once when the runtime dies', async () => {
    world.closed.length = 0
    const lines: string[] = []

    await Effect.runPromise(answerDiscussion(request(), (line) => lines.push(line)))

    expect(world.closed).toEqual(['delete'])
    expect(lines.filter((l) => l.includes('crash — boom'))).toHaveLength(1)
    expect(lines.some((l) => l.includes('did not answer'))).toBe(true)
    expect(lines.some((l) => l.includes('failed:'))).toBe(false)
  })

  it("does not fail the loop's port, and still deletes the log", async () => {
    world.closed.length = 0
    const req = request()
    const lines: string[] = []

    const out = await Effect.runPromise(
      answerOutstandingQueued({
        log: (line) => lines.push(line),
        control: () => Effect.succeed({ discussions: [req] } as never),
        answer: answerDiscussion,
      }),
    )

    expect(out).toEqual({ answered: 1, heldBack: 0 })
    expect(world.closed).toEqual(['delete'])
  })
})
