import type { WaitReason } from '@lingtai/domain/wait'
import { describe, expect, it } from 'vitest'

import { waitCommand } from '../src/wait-command.ts'

const at = (reason: unknown) => ({ project: 'p', issue: 3, reason: reason as WaitReason })

describe('waitCommand', () => {
  it('puts approve first, bare, for a signoff, and merges the requeue pair', () => {
    const line = waitCommand(
      { first: 'Approve', rest: ['Requeue', 'EditBodyAndRequeue'] },
      at({ _tag: 'SignoffRequired' }),
    )
    expect(line).toBe(
      'lingtai approve p --issue 3   (or lingtai requeue p --issue 3 [--into-body "<text>"], or the board)',
    )
  })

  it('asks for a note on every other approve, and starts an unranked line with one of', () => {
    const line = waitCommand({ first: null, rest: ['Approve', 'Requeue'] }, at({ _tag: 'MergeRefused' }))
    expect(line).toBe(
      'one of: lingtai approve p --issue 3 --note "<why>", or lingtai requeue p --issue 3   (or the board)',
    )
  })

  it('writes the answer unbracketed for a question', () => {
    const line = waitCommand({ first: null, rest: ['EditBodyAndRequeue', 'Requeue'] }, at({ _tag: 'AgentQuestion' }))
    expect(line).toContain('lingtai requeue p --issue 3 --into-body "<answer>"')
    expect(line).not.toContain('[')
  })

  it('names the answer command first for an own question', () => {
    const line = waitCommand({ first: 'AnswerQuestion', rest: ['Requeue'] }, at({ _tag: 'OwnQuestion' }))
    expect(line.startsWith('lingtai answer p --issue 3 "<choice>"')).toBe(true)
  })

  it('falls back to the board when nothing is left', () => {
    expect(waitCommand({ first: null, rest: [] }, at({ _tag: 'MergeRefused' }))).toBe('the board')
  })
})
