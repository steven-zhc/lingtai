/**
 * `triageBrief` and `parseTriage` (`#412`), and the fence that keeps
 * `triage.ts`/`read-step.ts` free of a runtime — the same property
 * `discuss.ts`'s subpath exists for, checked the way `one-store.test.ts`
 * checks the conductor never reaches for a driver.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MERGE_HUNKS_ONE_BY_ONE,
  TRIAGE_SENTENCE_MAX,
  TRIAGE_TEXT_MAX,
  type JudgeReply,
  type RouteDecision,
  type RouteOffer,
} from '@lingtai/domain'
import type { WaitReason } from '@lingtai/domain/wait'
import { describe, expect, it } from 'vitest'

import { parseTriage, triageBrief, type TriageEvidence } from '../src/triage.ts'

const REASON: WaitReason = {
  _tag: 'MergeRefused',
  run: { runId: 'run-1' },
  reason: 'push-rejected',
  raw: 'was merged in first',
}

const OFFER: RouteOffer = { proposal: { _tag: 'BuildRed', output: 'it failed' }, available: [], unavailable: [] }
const REPLY: JudgeReply = { _tag: 'Selected', candidate: 'fix-lines', why: 'the judge says so' }
const DECISION: RouteDecision = { _tag: 'Selected', candidate: 'fix-lines' }

const EVIDENCE: TriageEvidence = {
  ticketId: 'ticket-lingtai-412',
  ticket: { ref: '412', title: 'triageBrief and parseTriage', body: '…' },
  ticketProblem: null,
  reason: REASON,
  routed: { runId: 'run-1', offer: OFFER, reply: REPLY, decision: DECISION },
  published: null,
  diffStat: null,
  reading: ['main: readable at abc1234'],
  refs: [{ ref: 'main', sha: 'abc1234', paths: ['packages/conductor/src/triage.ts'], truncated: false }],
}

describe('triageBrief', () => {
  it("labels the stopping step's words and the judge's reply as claims, before quoting them", () => {
    const brief = triageBrief({ evidence: EVIDENCE, served: [], roundsLeft: 4 })

    const reasonLabel = brief.indexOf('its claim, not something established')
    const reasonWords = brief.indexOf('was merged in first')
    expect(reasonLabel).toBeGreaterThan(-1)
    expect(reasonWords).toBeGreaterThan(reasonLabel)

    const judgeLabel = brief.indexOf("judge's reason for its choice")
    const judgeWords = brief.indexOf('the judge says so')
    expect(judgeLabel).toBeGreaterThan(-1)
    expect(judgeWords).toBeGreaterThan(judgeLabel)
  })

  it('carries the refs and the diff stat, and names the read contract', () => {
    const brief = triageBrief({
      evidence: {
        ...EVIDENCE,
        published: {
          branch: 'agent/412',
          arm: 'agent/412-attempt-1',
          headSha: 'deadbeef',
          outcome: 'published',
          detail: null,
        },
        diffStat: '2 files changed, 10 insertions(+), 2 deletions(-)',
      },
      served: [],
      roundsLeft: 4,
    })

    expect(brief).toContain('packages/conductor/src/triage.ts')
    expect(brief).toContain('agent/412-attempt-1')
    expect(brief).toContain('deadbeef')
    expect(brief).toContain('2 files changed, 10 insertions(+), 2 deletions(-)')
    expect(brief).toContain('{"read":["main:packages/agent/src/claude-code.ts"]}')
  })

  it('says so explicitly when nothing was published or no diff stat could be read, rather than a blank section', () => {
    const brief = triageBrief({ evidence: EVIDENCE, served: [], roundsLeft: 4 })

    expect(brief).toContain('evidence and not proof')
    expect(brief).toContain('No diff stat could be read')
  })
})

describe('parseTriage', () => {
  it('reads a request for files', () => {
    expect(parseTriage('{"read":["main:packages/conductor/src/triage.ts"]}')).toEqual({
      kind: 'read',
      paths: ['main:packages/conductor/src/triage.ts'],
    })
  })

  const CAUSES: Array<{ tag: string; answer: Record<string, unknown> }> = [
    {
      tag: 'UndecidedQuestion',
      answer: {
        cause: {
          _tag: 'UndecidedQuestion',
          questions: [
            {
              id: 'q1',
              text: 'approve or requeue?',
              answers: [
                { id: 'a', text: 'approve' },
                { id: 'b', text: 'requeue' },
              ],
              recommended: 'a',
            },
          ],
        },
        resolution: 'EditBodyAndRequeue',
        summary: 'a person has to decide',
        want: null,
      },
    },
    {
      tag: 'FixableLines',
      answer: {
        cause: { _tag: 'FixableLines', fixes: [{ path: 'a.ts', line: 10, what: 'fix the thing' }] },
        resolution: 'Requeue',
        summary: 'specific edits',
        want: 'fix the bug',
      },
    },
    {
      tag: 'WrongApproach',
      answer: { cause: { _tag: 'WrongApproach' }, resolution: 'Requeue', summary: 'wrong shape', want: null },
    },
    {
      tag: 'ConflictingHunks',
      answer: {
        cause: { _tag: 'ConflictingHunks', hunks: [{ _tag: 'Mechanical', path: 'a.ts', line: 1 }], total: 1 },
        resolution: 'Requeue',
        summary: 'a conflict',
        want: null,
      },
    },
    {
      tag: 'TicketTooBig',
      answer: { cause: { _tag: 'TicketTooBig' }, resolution: 'EditBodyAndRequeue', summary: 'split it', want: null },
    },
    {
      tag: 'SetupBroken',
      answer: { cause: { _tag: 'SetupBroken' }, resolution: 'Requeue', summary: 'the setup is broken', want: null },
    },
  ]

  it.each(CAUSES)('parses a $tag cause into TriageAdvised', ({ tag, answer }) => {
    const reply = parseTriage(JSON.stringify(answer))
    expect(reply.kind).toBe('advised')
    if (reply.kind !== 'advised') throw new Error('unreachable')
    expect(reply.result.cause._tag).toBe(tag)
    expect(reply.result.summary).toBe(answer['summary'])
  })

  it('refuses an unknown cause, and says which', () => {
    const reply = parseTriage(
      JSON.stringify({ cause: { _tag: 'NotACause' }, resolution: 'Close', summary: 'x', want: null }),
    )
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('cause')
  })

  it('refuses a missing summary, and says which', () => {
    const reply = parseTriage(JSON.stringify({ cause: { _tag: 'WrongApproach' }, resolution: 'Close', want: null }))
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('summary')
  })

  it.each(['out-of-turns', 'out-of-usd', 'out of rounds'])('refuses the budget given as the cause: %s', (budget) => {
    const reply = parseTriage(JSON.stringify({ cause: budget, resolution: 'Requeue', summary: 'x', want: null }))
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('budget is not a cause')
    expect(reply.why).toContain(budget)
  })

  it('refuses AnswerQuestion', () => {
    const reply = parseTriage(
      JSON.stringify({ cause: { _tag: 'WrongApproach' }, resolution: 'AnswerQuestion', summary: 'x', want: null }),
    )
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('AnswerQuestion')
  })

  it('parses want: null', () => {
    const reply = parseTriage(
      JSON.stringify({ cause: { _tag: 'WrongApproach' }, resolution: 'Requeue', summary: 'x', want: null }),
    )
    expect(reply.kind).toBe('advised')
    if (reply.kind !== 'advised') throw new Error('unreachable')
    expect(reply.result.want).toBeNull()
  })

  it('refuses a want past TRIAGE_SENTENCE_MAX, and names the bound', () => {
    const reply = parseTriage(
      JSON.stringify({
        cause: { _tag: 'WrongApproach' },
        resolution: 'Requeue',
        summary: 'x',
        want: 'a'.repeat(TRIAGE_SENTENCE_MAX + 1),
      }),
    )
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('want')
  })

  it('refuses more than 5 questions, and names the bound', () => {
    const questions = Array.from({ length: 6 }, (_, i) => ({
      id: `q${i}`,
      text: `question ${i}`,
      answers: [{ id: 'a', text: 'yes' }],
      recommended: 'a',
    }))
    const reply = parseTriage(
      JSON.stringify({
        cause: { _tag: 'UndecidedQuestion', questions },
        resolution: 'EditBodyAndRequeue',
        summary: 'x',
        want: null,
      }),
    )
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('questions')
  })

  it('refuses more than 20 fixes, and names the bound', () => {
    const fixes = Array.from({ length: 21 }, (_, i) => ({ path: `a${i}.ts`, line: i, what: 'fix' }))
    const reply = parseTriage(
      JSON.stringify({ cause: { _tag: 'FixableLines', fixes }, resolution: 'Requeue', summary: 'x', want: null }),
    )
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('fixes')
  })

  it('refuses 21 or more hunks listed, and names the bound', () => {
    expect(MERGE_HUNKS_ONE_BY_ONE).toBe(20)
    const hunks = Array.from({ length: 21 }, (_, i) => ({ _tag: 'Mechanical', path: `a${i}.ts`, line: i }))
    const reply = parseTriage(
      JSON.stringify({
        cause: { _tag: 'ConflictingHunks', hunks, total: 21 },
        resolution: 'Requeue',
        summary: 'x',
        want: null,
      }),
    )
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('hunks')
  })

  it('refuses text over TRIAGE_TEXT_MAX, and names the bound', () => {
    const reply = parseTriage(
      JSON.stringify({
        cause: { _tag: 'FixableLines', fixes: [{ path: 'a.ts', line: 1, what: 'x'.repeat(TRIAGE_TEXT_MAX + 1) }] },
        resolution: 'Requeue',
        summary: 'x',
        want: null,
      }),
    )
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('what')
  })

  it("returns the tag 'Approve'", () => {
    const reply = parseTriage(
      JSON.stringify({ cause: { _tag: 'WrongApproach' }, resolution: 'Approve', summary: 'x', want: null }),
    )
    expect(reply.kind).toBe('advised')
    if (reply.kind !== 'advised') throw new Error('unreachable')
    expect(reply.result.resolution).toBe('Approve')
  })

  it('refuses an object resolution', () => {
    const reply = parseTriage(
      JSON.stringify({
        cause: { _tag: 'WrongApproach' },
        resolution: { _tag: 'Approve', onSha: 'abc' },
        summary: 'x',
        want: null,
      }),
    )
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('tag')
  })
})

describe('the fence: triage.ts and read-step.ts stay pure', () => {
  const SRC = fileURLToPath(new URL('../src', import.meta.url))
  /** Ignores the prose, the same way `one-store.test.ts` does. */
  const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('imports nothing from @lingtai/agent or @lingtai/repo', () => {
    for (const file of ['triage.ts', 'read-step.ts']) {
      const text = code(readFileSync(join(SRC, file), 'utf8'))
      expect(text).not.toMatch(/from ['"]@lingtai\/agent/)
      expect(text).not.toMatch(/from ['"]@lingtai\/repo/)
    }
  })
})
