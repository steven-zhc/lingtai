import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  boardCommand,
  readBoardStatus,
  serveBoardWith,
  type BoardCommand,
  type BoardWorld,
  type ServeDeps,
} from '../src/board.ts'

/** The Effect faces of `board.ts`: what a failing step leaves behind, and what the sentences are. */

describe('serveBoardWith', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    for (const key of ['PORT', 'HOSTNAME', 'NEXT_MANUAL_SIG_HANDLE']) delete process.env[key]
  })
  afterEach(() => {
    for (const key of ['PORT', 'HOSTNAME', 'NEXT_MANUAL_SIG_HANDLE']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  const deps = (over: Partial<ServeDeps> = {}): ServeDeps => ({
    exists: () => true,
    checkTelemetry: () => {},
    portIsFree: () => Effect.void,
    importFile: () => Effect.void,
    listening: () => Effect.void,
    installStopOnSignal: () => {},
    ...over,
  })

  it('leaves NEXT_MANUAL_SIG_HANDLE unset and installs no signal handler when the import throws', async () => {
    let installed = 0
    const seen: Array<string | undefined> = []
    const serve = serveBoardWith(
      deps({
        importFile: () =>
          Effect.suspend(() => {
            seen.push(process.env['NEXT_MANUAL_SIG_HANDLE'])
            return Effect.fail(new Error('boom'))
          }),
        installStopOnSignal: () => {
          installed++
        },
      }),
    )
    const outcome = await Effect.runPromise(
      Effect.result(serve({ dir: '/x', port: 17820, host: '127.0.0.1', release: Effect.void })),
    )
    expect(outcome._tag).toBe('Failure')
    expect(seen).toEqual(['1'])
    expect(process.env['NEXT_MANUAL_SIG_HANDLE']).toBeUndefined()
    expect(installed).toBe(0)
  })

  it('names the entry it did not find, and loads nothing', async () => {
    let imported = 0
    const serve = serveBoardWith(
      deps({
        exists: () => false,
        importFile: () => Effect.sync(() => void imported++),
      }),
    )
    const outcome = await Effect.runPromise(
      Effect.result(serve({ dir: '/x', port: 17820, host: '127.0.0.1', release: Effect.void })),
    )
    expect(outcome._tag).toBe('Failure')
    if (outcome._tag === 'Failure') expect(outcome.failure.message).toMatch(/^no built board at /)
    expect(imported).toBe(0)
  })
})

const PORT = 17820

function world(over: Partial<BoardWorld>, released: { n: number }): BoardWorld {
  return {
    host: '127.0.0.1',
    reach: '127.0.0.1',
    hostname: 'mac',
    home: { path: '/h', shown: '~/h' },
    notSetUp: () => false,
    answering: () => Effect.succeed(null),
    bound: () => Effect.succeed(false),
    locker: {
      tryLock: async () => ({
        ok: true,
        lock: {
          release: async () => {
            released.n++
          },
        },
      }),
      holder: async () => null,
    },
    keeper: () => ({ kept: false }),
    exec: () => ({ status: 0, out: '' }),
    serve: () => Effect.void,
    open: () => Effect.succeed(true),
    signal: () => true,
    sleep: () => Effect.void,
    now: () => Date.now(),
    whereThePortIsSet: 'board.port',
    log: () => {},
    error: () => {},
    ...over,
  }
}

describe('boardCommand start', () => {
  it('prints a serve failure alone, releases the lock once, and returns 1', async () => {
    const errors: string[] = []
    const released = { n: 0 }
    const w = world(
      { serve: () => Effect.fail(new Error('no built board at X')), error: (l) => errors.push(l) },
      released,
    )
    const command: BoardCommand = { verb: 'start', port: PORT, dir: '/d', open: false }
    const code = await Effect.runPromise(boardCommand(command, w))
    expect(code).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('no built board at X')
    expect(errors.join('\n')).not.toContain('LINGTAI_DEBUG')
    expect(released.n).toBe(1)
  })
})

describe('readBoardStatus', () => {
  it('says unread, with the lock’s own message, when the holder cannot be read', async () => {
    const w = world(
      {
        locker: {
          tryLock: async () => ({ ok: false, holder: null }),
          holder: async () => {
            throw new Error('EACCES')
          },
        },
      },
      { n: 0 },
    )
    const status = await Effect.runPromise(readBoardStatus({ port: PORT }, w))
    expect(status.serving).toEqual({ unread: 'EACCES' })
  })
})
