/** The verbs that named a person's moves before 0108 did refuse by name and do nothing (#1242). */
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RETIRED_VERBS } from '../src/cli.ts'
import { runCli } from '../test/cli.ts'

/** Every module that would resolve a wait: reaching one of these is an append about to happen. */
const reached = vi.hoisted(() => [] as string[])
vi.mock('../src/start-new-attempt.ts', () => ({
  startNewAttemptVerdict: () => (reached.push('start-new-attempt'), Effect.never),
}))
vi.mock('../src/fix-refusal.ts', () => ({
  fixRefusalVerdict: () => (reached.push('fix-refusal'), Effect.never),
}))
vi.mock('../src/redo-step.ts', () => ({
  redoStepVerdict: () => (reached.push('redo-step'), Effect.never),
}))

const saved = process.env['NO_COLOR']
beforeEach(() => {
  process.env['NO_COLOR'] = '1'
  reached.length = 0
})
afterEach(() => {
  vi.restoreAllMocks()
  if (saved === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = saved
})

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => ((out += String(t)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((t: string | Uint8Array) => ((err += String(t)), true))
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (err += `${a.join(' ')}\n`))
  const code = await runCli(['node', 'lingtai', ...args], {})
  return { code, out, err }
}

describe('the verbs that were renamed', () => {
  it.each([
    ['grant-fix-round', 'fix-refusal', ['--issue', '12', '--if-head', 'abc1234']],
    ['rerun', 'redo-step', ['--issue', '12', '--if-head', 'abc1234']],
    ['requeue', 'start-new-attempt', ['--issue', '12', '--note', 'base moved', '--into-body', 'more text']],
  ] as const)('%s exits non-zero, resolves nothing, and names %s', async (old, now, rest) => {
    const answered = await run([old, 'lingtai', ...rest])
    expect(answered.code).not.toBe(0)
    expect(answered.err).toContain(`${old} is now lingtai ${now}`)
    expect(answered.out).toBe('')
    expect(reached).toEqual([])
    expect(RETIRED_VERBS[old]).toBe(now)
  })

  it('answers in --json with one error document and still resolves nothing', async () => {
    const answered = await run(['requeue', 'lingtai', '--issue', '12', '--json'])
    expect(answered.code).not.toBe(0)
    expect(answered.err + answered.out).toContain('start-new-attempt')
    expect(reached).toEqual([])
  })
})
