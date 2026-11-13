/** `service start` over a shutdown request it could not read: a store's defect is a refusal, never *nothing stands* (#1096). */
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { serviceCommand, type ServiceOptions } from '../src/service.ts'

// The job's file is "there"; whether it is is not what this is about.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: () => true,
}))

const unused = Effect.die(new Error('not read in this scene'))

describe('a start whose shutdown read dies', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`refuses with the could-not-be-read lines and starts nothing (${platform})`, async () => {
      const calls: string[] = []
      const err: string[] = []
      const options: ServiceOptions = {
        liveness: () => unused,
        // A defect, not a failure: `Effect.catch` would let it through.
        shutdown: () => Effect.die(new Error('store gone')),
        drain: { ask: () => unused, holding: () => unused, queue: () => unused },
        started: { watermark: () => unused, after: () => unused },
        board: { url: 'http://127.0.0.1:1', answering: () => unused, missing: () => null, heldBy: () => unused },
        by: 'human:lingtai',
        platform,
        env: { HOME: '/home/x', USER: 'x' },
        root: '/home/x/lingtai',
        uid: 501,
        username: 'x',
        exec: (call) => (calls.push(call.join(' ')), { status: 0, out: '' }),
        which: (bin) => `/usr/bin/${bin}`,
        sleep: () => Effect.void,
        log: () => {},
        error: (line) => err.push(line),
      }
      const code = await Effect.runPromise(serviceCommand(['start'], options))
      expect(code).toBe(1)
      const said = err.join('\n')
      expect(said).toContain('could not read whether a shutdown request stands — store gone. Nothing was started.')
      expect(said).toContain('A start ends a drain somebody asked for and could not tell it had')
      expect(calls.filter((c) => /bootstrap|kickstart|systemctl --user start/.test(c))).toEqual([])
    })
  }
})
