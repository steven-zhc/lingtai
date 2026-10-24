/**
 * `triageBrief` and `parseTriage` (`#412`), and the fence that keeps
 * `triage.ts`/`read-step.ts` free of a runtime — the same property
 * `discuss.ts`'s subpath exists for, checked the way `one-store.test.ts`
 * checks the conductor never reaches for a driver.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MERGE_HUNKS_ONE_BY_ONE,
  TRIAGE_FIXES_MAX,
  TRIAGE_QUESTIONS_MAX,
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

  /**
   * `#427`'s gap: a `branchCarries: false` row means `branch` holds only the
   * WIP, with the agent's own commits never on it — the brief must say so
   * rather than rendering the row as though `branch` carried `headSha`.
   */
  it('says branch does not carry headSha when branchCarries is false, rather than implying the work is on it', () => {
    const brief = triageBrief({
      evidence: {
        ...EVIDENCE,
        published: {
          branch: 'agent/412',
          arm: 'agent/412-attempt-1',
          headSha: 'wip1234',
          outcome: 'published',
          branchCarries: false,
          detail: null,
        },
      },
      served: [],
      roundsLeft: 4,
    })

    expect(brief).toContain('does **not** carry')
    expect(brief).toContain('an agent that committed nothing of its own')
  })

  /** On `arm-only`, `branch` is a sibling claim's ref, never this run's own. */
  it("says branch is a sibling claim's ref on an arm-only outcome", () => {
    const brief = triageBrief({
      evidence: {
        ...EVIDENCE,
        published: {
          branch: 'agent/412',
          arm: 'agent/412-attempt-1',
          headSha: 'armsha1',
          outcome: 'arm-only',
          detail: "push-rejected: 'refs/heads/agent/412' fetch first",
        },
      },
      served: [],
      roundsLeft: 4,
    })

    expect(brief).toContain("sibling claim's ref")
    expect(brief).toContain('fetch first')
  })

  /**
   * The carries sentence used to fall through to "`branch` carries `headSha`"
   * on every outcome but `arm-only` and `branchCarries: false` — including the
   * four where `branchCarries` is never written at all (`events.ts:570-571`)
   * and nothing reached origin, or reached it under a different ref. These
   * cases pin one sentence per outcome and that none of them claims `branch`
   * carries a head it never got.
   */
  it('says nothing was committed, so no ref was left, on nothing-committed', () => {
    const brief = triageBrief({
      evidence: {
        ...EVIDENCE,
        published: {
          branch: 'agent/412',
          arm: 'agent/412-attempt-1',
          headSha: null,
          outcome: 'nothing-committed',
          detail: null,
        },
      },
      served: [],
      roundsLeft: 4,
    })

    expect(brief).toContain('Nothing was committed, so no ref was left')
    expect(brief).not.toContain('carries `headSha`')
  })

  it('says branch was not pushed on refused, with a head that is not on origin', () => {
    const brief = triageBrief({
      evidence: {
        ...EVIDENCE,
        published: {
          branch: 'agent/412',
          arm: 'agent/412-attempt-1',
          headSha: 'abc1234',
          outcome: 'refused',
          detail: 'push rejected: fetch first',
        },
      },
      served: [],
      roundsLeft: 4,
    })

    expect(brief).toContain('was **not** pushed')
    expect(brief).toContain('is a commit that is not on origin')
    expect(brief).toContain('push rejected: fetch first')
    expect(brief).not.toContain('carries `headSha`')
  })

  it('says branch was not pushed and no head was read on refused with a null head', () => {
    const brief = triageBrief({
      evidence: {
        ...EVIDENCE,
        published: {
          branch: 'agent/412',
          arm: 'agent/412-attempt-1',
          headSha: null,
          outcome: 'refused',
          detail: 'rev-parse failed',
        },
      },
      served: [],
      roundsLeft: 4,
    })

    expect(brief).toContain('was **not** pushed, and no head was read')
    expect(brief).toContain('rev-parse failed')
    expect(brief).not.toContain('carries `headSha`')
  })

  it('says the commits are on origin under a different ref on unrecorded, never naming branch as the holder', () => {
    const brief = triageBrief({
      evidence: {
        ...EVIDENCE,
        published: {
          branch: 'agent/412',
          arm: 'agent/412-attempt-1',
          headSha: 'def5678',
          outcome: 'unrecorded',
          detail: 'agent/412-attempt-1 — store refused the append',
        },
      },
      served: [],
      roundsLeft: 4,
    })

    expect(brief).toContain('are on origin')
    expect(brief).toContain('not nothing done')
    expect(brief).toContain('agent/412-attempt-1 — store refused the append')
    expect(brief).not.toContain('carries `headSha`')
  })

  it('says the work was already there on already-published', () => {
    const brief = triageBrief({
      evidence: {
        ...EVIDENCE,
        published: {
          branch: 'agent/412',
          arm: 'agent/412-attempt-1',
          headSha: 'deadbeef',
          outcome: 'already-published',
          detail: null,
        },
      },
      served: [],
      roundsLeft: 4,
    })

    expect(brief).toContain('already there')
    expect(brief).toContain('carries `headSha`')
  })

  it('reads an absent branchCarries as carried, the replay rule for published rows written before #468', () => {
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
      },
      served: [],
      roundsLeft: 4,
    })

    expect(brief).toContain('carries `headSha`')
  })

  it('says so explicitly when nothing was published or no diff stat could be read, rather than a blank section', () => {
    const brief = triageBrief({ evidence: EVIDENCE, served: [], roundsLeft: 4 })

    expect(brief).toContain('evidence and not proof')
    expect(brief).toContain('No diff stat could be read')
  })

  /**
   * The bounds `parseTriage` enforces through `TriageResult.safeParse`, so an
   * answer written exactly to the brief does not come back refused: the
   * strict key set, the >20-hunk rule, and the character bound on `summary`
   * and `want`.
   */
  it('states the strict key set, the character bound, and the >20-hunk rule', () => {
    const brief = triageBrief({ evidence: EVIDENCE, served: [], roundsLeft: 4 })

    expect(brief).toContain('cause`, `resolution`, `summary`, `want`')
    expect(brief).toMatch(/and no\s+others/)
    expect(brief).toContain('"confidence"')
    expect(brief).toContain(`at most ${TRIAGE_SENTENCE_MAX} characters`)
    expect(brief).toMatch(/Past that bound, send\s+`"hunks": \[\]` with `total`/)
    expect(brief).toContain(`${MERGE_HUNKS_ONE_BY_ONE}`)
  })
})

describe('parseTriage', () => {
  it('reads a request for files', () => {
    expect(parseTriage('{"read":["main:packages/conductor/src/triage.ts"]}')).toEqual({
      kind: 'read',
      paths: ['main:packages/conductor/src/triage.ts'],
    })
  })

  /**
   * The earlier candidate decides, even when a later one asks to read — the
   * same precedence `discuss.test.ts` pins for `parseReply`. An agent that
   * answers at round 0 and then offers a second, unreadable confirmation must
   * not have its paid answer discarded for a read `#428` has no round left to
   * serve.
   */
  it('reads the earlier candidate as advice, even when a later one asks to read', () => {
    const reply = parseTriage(
      '```json\n{"cause":{"_tag":"WrongApproach"},"resolution":"Requeue","summary":"s","want":null}\n```\n\n' +
        'If you want me to confirm, I can read:\n\n```json\n{"read":["main:a.ts"]}\n```',
    )
    expect(reply.kind).toBe('advised')
    if (reply.kind !== 'advised') throw new Error('unreachable')
    expect(reply.result.cause._tag).toBe('WrongApproach')
    expect(reply.result.summary).toBe('s')
  })

  /**
   * An echoed example from the brief — one of the six JSON shapes
   * `triageBrief` quotes, carrying neither `cause` nor `resolution` — must not
   * be adopted as the answer just because it is the first candidate that
   * parses to an object. The real answer, in a later block, is what should be
   * read; refusing the reply here would discard advice that is in the text.
   */
  it('skips an earlier candidate that carries neither cause nor resolution, and reads the real answer after it', () => {
    const reply = parseTriage(
      'Here is the hunk shape I used:\n```json\n{"_tag":"Mechanical","path":"a.ts","line":10}\n```\n' +
        'My answer:\n```json\n{"cause":{"_tag":"WrongApproach"},"resolution":"Requeue","summary":"s","want":null}\n```',
    )
    expect(reply.kind).toBe('advised')
    if (reply.kind !== 'advised') throw new Error('unreachable')
    expect(reply.result.cause._tag).toBe('WrongApproach')
    expect(reply.result.summary).toBe('s')
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

  it('refuses a Split answer whose plan has a cycle', () => {
    const child = (key: string) => ({ key, title: key, body: key, kind: 'feature' })
    const reply = parseTriage(
      JSON.stringify({
        cause: {
          _tag: 'TicketTooBig',
          split: {
            children: [child('a'), child('b')],
            blockedBy: [
              { ticket: 'a', blockedBy: 'b' },
              { ticket: 'b', blockedBy: 'a' },
            ],
          },
        },
        resolution: 'Split',
        summary: 'too big',
        want: null,
      }),
    )
    expect(reply.kind).toBe('refused')
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
    expect(reply.why).toContain(`${TRIAGE_SENTENCE_MAX}`)
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
    expect(reply.why).toContain(`${TRIAGE_QUESTIONS_MAX}`)
  })

  it('refuses more than 20 fixes, and names the bound', () => {
    const fixes = Array.from({ length: 21 }, (_, i) => ({ path: `a${i}.ts`, line: i, what: 'fix' }))
    const reply = parseTriage(
      JSON.stringify({ cause: { _tag: 'FixableLines', fixes }, resolution: 'Requeue', summary: 'x', want: null }),
    )
    expect(reply.kind).toBe('refused')
    if (reply.kind !== 'refused') throw new Error('unreachable')
    expect(reply.why).toContain('fixes')
    expect(reply.why).toContain(`${TRIAGE_FIXES_MAX}`)
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
    expect(reply.why).toContain(`${MERGE_HUNKS_ONE_BY_ONE}`)
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
    expect(reply.why).toContain(`${TRIAGE_TEXT_MAX}`)
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

  /**
   * Every local file the two starting files reach, walking their own
   * `from './x.ts'` imports recursively — the actual transitivity. Naming two
   * files and checking only those two would miss a third file either of them
   * comes to import later; this follows however many hops that import chain
   * grows to.
   */
  function localClosure(startFiles: readonly string[]): Set<string> {
    const seen = new Set<string>()
    const queue = startFiles.map((f) => join(SRC, f))
    while (queue.length > 0) {
      const abs = queue.shift()!
      if (seen.has(abs)) continue
      seen.add(abs)
      const text = code(readFileSync(abs, 'utf8'))
      for (const m of text.matchAll(/from ['"](\.[^'"]+)['"]/g)) {
        queue.push(resolve(dirname(abs), m[1]!))
      }
    }
    return seen
  }

  it('imports nothing from @lingtai/agent or @lingtai/repo, transitively through every local import it reaches', () => {
    for (const abs of localClosure(['triage.ts', 'read-step.ts'])) {
      const text = code(readFileSync(abs, 'utf8'))
      expect(text).not.toMatch(/from ['"]@lingtai\/agent/)
      expect(text).not.toMatch(/from ['"]@lingtai\/repo/)
    }
  })
})
