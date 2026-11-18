/** The call an account limit cut off is named by its spend, not by the last prompt that happened to be recorded (#1205). */
import { describe, expect, it } from 'vitest'

import { cutOffPromptOf, stepStartedAtOf } from '../src/index.ts'
import { makeStream } from '../test/support.ts'

const forOf = (name: string) => ({ _tag: 'Action' as const, step: 'review' as const, name, round: 0 })
const spent = { runtime: 'codex' as const, turns: 1, durationMs: 1, usage: [], costUsd: null }
const prompted = (name: string) => ({ promptVersion: 'v', bytes: 1, prompt: name, for: forOf(name) })

describe('cutOffPromptOf', () => {
  it('names the later reviewer when its prompt record is missing, and gives no prompt', () => {
    const e = makeStream('pass-1')
    const events = [
      e('RunPrompted', prompted('A')),
      e('RunSpent', { for: forOf('A'), ...spent }),
      e('RunSpent', { for: forOf('B'), ...spent }),
    ]
    const cut = cutOffPromptOf(events)
    expect(cut?.for.name).toBe('B')
    expect(cut?.prompt).toBeNull()
  })

  it('finds the prompt recorded for the same call', () => {
    const e = makeStream('pass-1')
    const events = [
      e('RunPrompted', prompted('A')),
      e('RunPrompted', prompted('B')),
      e('RunSpent', { for: forOf('B'), ...spent }),
    ]
    expect(cutOffPromptOf(events)?.prompt?.prompt).toBe('B')
  })
})

describe('stepStartedAtOf (#1246)', () => {
  it('reads the latest arrival at the step that names a sha, and an old row without one is skipped', () => {
    const e = makeStream('pass-1')
    const started = (step: 'implement' | 'build', startedAt?: string) =>
      e('StepStarted', { runId: 'r', step, round: 0, ...(startedAt === undefined ? {} : { startedAt }) })
    const events = [
      started('implement', 'aaa'),
      started('build', 'bbb'),
      started('implement', 'ccc'),
      started('implement'),
    ]
    expect(stepStartedAtOf(events, 'implement')).toBe('ccc')
    expect(stepStartedAtOf(events, 'review')).toBeNull()
    expect(stepStartedAtOf([started('implement')], 'implement')).toBeNull()
  })
})
