/**
 * Whose start the log records (0042 §5), and what the daemon does with the answer (0126). The evening this
 * closes is a start nobody can name; the failure to avoid on the way is a start the log names *wrongly* — a
 * person for launchd's respawn.
 */
import type { ShutdownRequest } from '@lingtai/daemon'
import { describe, expect, it } from 'vitest'

import { attributeStart, startRecorder } from '../src/restart.ts'

describe('whose start it is', () => {
  const base = { restart: null, tty: false, user: 'ops' }

  it('names nobody for a start with no terminal, and the typist for one at a terminal', () => {
    expect(attributeStart(base)).toEqual({ by: 'daemon', reason: null })
    expect(attributeStart({ ...base, tty: true })).toEqual({ by: 'human:ops', reason: null })
  })

  it('names the restart that started it in this process', () => {
    expect(attributeStart({ ...base, restart: { by: 'human:steven', reason: 'picking up #88' } })).toEqual({
      by: 'human:steven',
      reason: 'picking up #88',
    })
  })
})

describe('the start a daemon records first', () => {
  const drain: ShutdownRequest = { by: 'human:steven', reason: 'restarting', timeoutMs: null, version: 3, force: false }
  const input = { restart: null, tty: false, user: 's' }

  it('records over an older drain, and is not asked to drain', async () => {
    const recorded: unknown[] = []
    const note = startRecorder({
      ...input,
      record: async (a) => {
        recorded.push(a)
        return { recorded: true }
      },
      log: () => {},
    })
    expect(await note()).toEqual({ take: true })
    expect(recorded).toEqual([{ by: 'daemon', reason: null }])
  })

  it('does not record over a newer drain, and is asked to drain', async () => {
    const note = startRecorder({ ...input, record: async () => ({ recorded: false, standing: drain }), log: () => {} })
    expect(await note()).toEqual({ take: false, standing: drain })
  })

  it('reports a record that threw as taking no work, without throwing', async () => {
    const lines: string[] = []
    const note = startRecorder({
      ...input,
      record: async () => {
        throw new Error('version race, five times')
      },
      log: (l) => lines.push(l),
    })
    expect(await note()).toEqual({ take: false, failed: 'version race, five times' })
    expect(lines.join('\n')).toContain('version race')
  })

  it('records once: two calls await the one record', async () => {
    let calls = 0
    const note = startRecorder({
      ...input,
      record: async () => {
        calls += 1
        return { recorded: true }
      },
      log: () => {},
    })
    await Promise.all([note(), note()])
    await note()
    expect(calls).toBe(1)
  })
})
