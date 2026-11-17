/** The call an account limit cut off is named by its spend, not by the last prompt that happened to be recorded (#1205). */
import { describe, expect, it } from 'vitest'

import { askedAgainOn, cutOffPromptOf } from '../src/index.ts'
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

describe('askedAgainOn', () => {
  it('is true once a rule asked the step again', () => {
    const e = makeStream('pass-1')
    const rerun = { runId: 'r', step: 'review', rerun: 1, said: 'x', waitMs: 0 }
    expect(askedAgainOn([e('StepRerunInPlace', rerun)], 'review')).toBe(false)
    expect(askedAgainOn([e('StepRerunInPlace', { ...rerun, askedAgain: true })], 'review')).toBe(true)
  })
})
