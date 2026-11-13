/**
 * The line a command that only appends says about the board (0100 §13): one
 * line when no conductor is up, nothing when one is, and *could not tell* when
 * the lock cannot be asked — never *no conductor* for a read that failed.
 */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type Bound, conductorNote, NO_CONDUCTOR } from '../src/conductor-note.ts'
import { requeueCommand } from '../src/requeue.ts'

describe('conductorNote', () => {
  it('says no conductor is running when nobody holds the lock', async () => {
    expect(await conductorNote({ holder: async () => null })).toBe(NO_CONDUCTOR)
  })

  it('says nothing when a conductor holds the lock', async () => {
    expect(await conductorNote({ holder: async () => 'lingtai daemon (pid 1 on h)' })).toBeNull()
  })

  it('says it could not tell when the read throws', async () => {
    const line = await conductorNote({
      holder: async () => {
        throw new Error('EACCES')
      },
    })
    expect(line).toContain('could not tell whether a conductor is running (EACCES)')
    expect(line).not.toBe(NO_CONDUCTOR)
  })

  it('says it could not tell when the read gets no answer in time', async () => {
    const bound: Bound = async () => ({ ok: false, why: 'timeout' })
    expect(await conductorNote({ holder: () => new Promise(() => {}), bound })).toContain('could not tell')
  })

  it('says nothing when Ctrl+C aborted the wait', async () => {
    const bound: Bound = async () => ({ ok: false, why: 'abort' })
    expect(await conductorNote({ holder: () => new Promise(() => {}), bound })).toBeNull()
  })
})

describe('requeue prints the note through its deps seam', () => {
  const run = async (holder: () => Promise<string | null>) => {
    const lines: string[] = []
    const code = await Effect.runPromise(
      requeueCommand({ project: 'lingtai', issue: 9, note: 'again', by: 'human:test' }, (l) => lines.push(l), {
        store: createMemoryEventStore(),
        loadProject: () => Effect.succeed({ owner: 'steven' } as never),
        conductorNote: () => conductorNote({ holder }),
        requeue: () => Effect.succeed({ ok: true, ticketId: 'ticket-lingtai-9', detail: 'back in the queue' } as never),
      }),
    )
    return { code, lines }
  }

  it('prints the line when the holder is null', async () => {
    const { code, lines } = await run(async () => null)
    expect(code).toBe(0)
    expect(lines).toContain(NO_CONDUCTOR)
  })

  it('prints nothing about a conductor when a name holds the lock', async () => {
    const { lines } = await run(async () => 'lingtai daemon (pid 1 on h)')
    expect(lines).not.toContain(NO_CONDUCTOR)
    expect(lines.join('\n')).not.toContain('could not tell')
  })

  it('prints could-not-tell, and still succeeds, when the read throws', async () => {
    const { code, lines } = await run(async () => {
      throw new Error('EACCES')
    })
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('could not tell whether a conductor is running (EACCES)')
  })
})
