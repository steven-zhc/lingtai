import { LABEL_STATES } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { FOLLOWUP_LABEL, HOLD_LABEL, OWN_LABELS, foreignLabels, labelsFor } from '../src/labels.ts'
import { type IssueChannel, tellGitHubEffect } from '../src/tell.ts'

describe('foreignLabels', () => {
  it('keeps a person-set lingtai: label and drops only the ones labelsFor computes', () => {
    expect(
      foreignLabels([
        'bug',
        'lingtai:working',
        'lingtai:waiting',
        'lingtai:hold',
        'lingtai:pr-fix',
        'lingtai:publishing',
      ]),
    ).toEqual(['bug', 'lingtai:hold', 'lingtai:pr-fix', 'lingtai:publishing'])
  })
})

describe('OWN_LABELS', () => {
  it('is exactly what labelsFor produces over LABEL_STATES', () => {
    expect(OWN_LABELS).toEqual(new Set(LABEL_STATES.flatMap((s) => labelsFor(s))))
    expect([...OWN_LABELS].sort()).toEqual(['lingtai:waiting', 'lingtai:working'])
  })

  it('holds neither label a person sets', () => {
    expect(OWN_LABELS.has(HOLD_LABEL)).toBe(false)
    expect(OWN_LABELS.has(FOLLOWUP_LABEL)).toBe(false)
  })
})

describe('a tell labels write', () => {
  it('keeps a lingtai:hold the issue carries', async () => {
    const written: string[][] = []
    const github = {
      getIssue: async () => ({
        labels: [{ name: 'bug' }, { name: 'lingtai:hold' }, { name: 'lingtai:working' }],
        body: '',
      }),
      setLabels: async (_issue: number, labels: readonly string[]) => {
        written.push([...labels])
      },
    } as unknown as IssueChannel
    await Effect.runPromise(
      tellGitHubEffect({
        store: createMemoryEventStore(),
        github,
        ticketId: 'ticket-lingtai-7',
        change: { kind: 'labels', labels: ['lingtai:waiting'] },
      }),
    )
    expect(written).toEqual([['bug', 'lingtai:hold', 'lingtai:waiting']])
  })
})
