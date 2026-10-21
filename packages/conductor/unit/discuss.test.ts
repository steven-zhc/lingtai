import type { Envelope, ToAppend } from '@lingtai/domain'
/**
 * The two things the discussion assistant must not pretend, and the two places
 * its conclusion can go.
 *
 * These are `#105`'s own bar, and they are here rather than in an integration
 * test because both of them are decisions about *what is said* rather than
 * about what is stored. `readingFor` is the sentence Lingtai writes before the
 * assistant speaks; `parseReply` is what refuses to present prose as an answer.
 *
 * Unit, under `--project unit`: most of this reads no database, and an
 * assistant whose containment needed one would be the wrong shape.
 * `concludeDiscussion`'s `db`-project test below is SQLite `:memory:`, which
 * 0060 §1 counts as unit too — it touches no filesystem and no process.
 */
import { createSqliteTicketSql, openSqliteLog } from '@lingtai/event-store/sqlite'
import { describe, expect, it } from 'vitest'

import { answerOpenMarker } from '../src/body-section.ts'
import { dbTickets } from '../src/db-tickets.ts'
import {
  buildBrief,
  concludeDiscussion,
  discussionSection,
  holdDiscussion,
  MAX_READ_ROUNDS,
  outstanding,
  parseReply,
  readingFor,
  turnsOf,
  type Answered,
  type DiscussionEvidence,
} from '../src/discuss.ts'
import { passClientOf } from '../src/ticket-store.ts'
import { fakeGitHub as fullFakeGitHub, memoryStore } from '../test/one-pass.ts'

const EVIDENCE: DiscussionEvidence = {
  ticketId: 'ticket-lingtai-89',
  attempt: 2,
  ticket: { ref: '89', title: 'the run does not stop at the turn limit', body: '…' },
  ticketProblem: null,
  log: ['1  2026-09-08 04:12:00  ticket-lingtai-89  TicketClaimed  conductor  {}'],
  reading: ['main: readable at abc1234'],
  refs: [{ ref: 'main', sha: 'abc1234', paths: ['packages/agent/src/claude-code.ts'], truncated: false }],
}

/** What one `ask` call may spend — a stand-in for the recipe's `discuss.limits`. */
const CALL = { turns: 40, wallMs: 300_000 }

describe('what was readable, said by Lingtai', () => {
  /**
   * The blind spot that killed `#89`'s repair, and the reason this function
   * exists at all. `worktree.ts` runs `-B` on every run, so the *branch ref*
   * survives an attempt that committed nothing — a check on the ref would find
   * one, read `main` under another name, and report neither.
   */
  it('says an attempt left no branch, and that main is being read instead', () => {
    const lines = readingFor({ attempt: 2, base: 'main', baseSha: 'abc1234ff', head: null })

    expect(lines.join('\n')).toContain('attempt 2 left no branch; I am reading main')
    expect(lines.join('\n')).toContain('-B')
  })

  it('names the commit when the attempt did produce one', () => {
    const lines = readingFor({ attempt: 2, base: 'main', baseSha: 'abc1234ff', head: '9f8e7d6c5b' })

    expect(lines.join('\n')).toContain('attempt-2: readable at 9f8e7d6')
    expect(lines.join('\n')).not.toContain('left no branch')
  })

  it('says so when there is no mirror at all, rather than offering a ref', () => {
    const lines = readingFor({ attempt: null, base: 'main', baseSha: null, head: null })
    expect(lines[0]).toContain('no file can be read')
  })
})

describe('the brief', () => {
  it('carries the reading sentences, so the assistant cannot be given the blind spot', () => {
    const brief = buildBrief({
      evidence: {
        ...EVIDENCE,
        reading: readingFor({ attempt: 2, base: 'main', baseSha: 'abc1234ff', head: null }),
      },
      history: [],
      question: 'why did attempt 2 produce nothing?',
      served: [],
      roundsLeft: MAX_READ_ROUNDS,
    })

    expect(brief).toContain('attempt 2 left no branch; I am reading main')
  })

  /**
   * The inference that cost `#89` two attempts and $13.04. It is in the fixed
   * text of the brief rather than left to judgement for the reason the agent
   * gate's rubric is: it went wrong once, measurably, and a rule that depends
   * on the model remembering is not a rule.
   */
  it('forbids concluding a flag is absent from its absence in documentation', () => {
    const brief = buildBrief({
      evidence: EVIDENCE,
      history: [],
      question: 'does the binary accept --max-turns?',
      served: [],
      roundsLeft: MAX_READ_ROUNDS,
    })

    expect(brief).toContain('no command execution')
    expect(brief).toContain('Absence from documentation is not absence from the program')
    expect(brief).toContain('say that it needs a command')
  })

  it('says when the reading is over, so a question cannot be asked forever', () => {
    const brief = buildBrief({
      evidence: EVIDENCE,
      history: [],
      question: 'why?',
      served: [],
      roundsLeft: 0,
    })
    expect(brief).toContain('You have no reading left')
  })
})

describe('the reply', () => {
  it('reads a request for files', () => {
    const reply = parseReply('{"read":["main:packages/agent/src/claude-code.ts"]}')
    expect(reply).toEqual({ kind: 'read', paths: ['main:packages/agent/src/claude-code.ts'] })
  })

  it('reads an answer, its caveats and its proposal', () => {
    const reply = parseReply(
      '```json\n{"answer":"the flag is not passed","cannot":["whether the binary accepts it"],' +
        '"proposal":{"kind":"prompt","text":"pass --max-turns"}}\n```',
    )
    expect(reply).toEqual({
      kind: 'answer',
      text: 'the flag is not passed',
      cannot: ['whether the binary accepts it'],
      proposal: { kind: 'prompt', text: 'pass --max-turns' },
    })
  })

  /**
   * There are two carriers and only two (0033 §2). A third is dropped rather
   * than guessed at: a discussion that could invent a place to put an
   * instruction would be the third carrier the decision refuses.
   */
  it('drops a proposal that names neither carrier', () => {
    const reply = parseReply('{"answer":"x","proposal":{"kind":"pull-request","text":"…"}}')
    expect(reply).toEqual({ kind: 'answer', text: 'x', cannot: [], proposal: null })
  })

  /**
   * The prose is kept and marked, never promoted. Treating a half-finished
   * thought as the answer is how a refusal gets presented as a conclusion.
   */
  it('refuses to read prose as an answer', () => {
    expect(parseReply('I think the problem is probably the flag.')).toEqual({
      kind: 'unreadable',
      text: 'I think the problem is probably the flag.',
    })
  })
})

describe('the ticket, appended to', () => {
  it('is a dated, attributed heading over the text', () => {
    const section = discussionSection('Pass --max-turns.', 'human:steven', new Date('2026-09-09T10:00:00Z'))
    expect(section).toContain('## Added from a discussion, 2026-09-09, by human:steven')
    expect(section).toContain('Pass --max-turns.')
  })
})

/**
 * `ticket.github` is `IssueChannel`, and a `db` project's `TicketedClient`
 * (`passClientOf`, #383) satisfies it the same way the board's `concludeChat`
 * now hands it one — `IssueChannel` is a subset of `TicketedClient`.
 */
describe('concludeDiscussion', () => {
  it("writes a db project's ticket outcome to dbTickets' body, and reaches none of IssueChannel's verbs on the raw client", async () => {
    const calls: string[] = []
    const github = fullFakeGitHub([])
    const wrapped = {
      ...github,
      updateBody: async (...args: Parameters<typeof github.updateBody>) => {
        calls.push('updateBody')
        return github.updateBody(...args)
      },
    }
    const sql = createSqliteTicketSql(openSqliteLog(':memory:'))
    const tickets = dbTickets(sql, 'lingtai')
    const opened = await tickets.createIssue({ title: 't', body: 'the original ticket.', labels: ['bug'] })
    const client = passClientOf(wrapped, tickets)

    const store = memoryStore()
    const result = await concludeDiscussion({
      store,
      ticketId: `ticket-lingtai-${opened.number}`,
      chatId: 'chat-1',
      by: 'human:steven',
      outcome: 'ticket',
      text: 'Pass --max-turns.',
      ticket: { github: client, body: opened.body },
    })

    expect(result.ok).toBe(true)
    expect(calls).toEqual([])

    const after = await tickets.getIssue(opened.number)
    expect(after.body).toContain('the original ticket.')
    expect(after.body).toContain('Pass --max-turns.')
    // `#422`: the addition sits between `chat-<chatId>` markers, not just appended.
    expect(after.body).toContain(answerOpenMarker('chat-chat-1'))
    expect(after.body).toContain('## Added from a discussion,')
  })
})

describe('whether a request has been answered', () => {
  it('counts answers against asks rather than needing a consumed event', () => {
    const answers = [envelope('DiscussionAnswered', {})]
    expect(outstanding(1, answers)).toBe(false)
    expect(outstanding(2, answers)).toBe(true)
  })
})

describe('holding one question', () => {
  /**
   * The meter, and the whole of 0033 §4: there is no spend limit, so a turn
   * that cost money and then failed has to leave the money on the log. A
   * failure that appended nothing would be a meter that can miss a spend, which
   * is not a meter.
   */
  it("appends the ask before it runs anything, and records a failure's cost", async () => {
    const store = fakeStore()
    const calls: unknown[] = []
    const held = await holdDiscussion(
      {
        store: store.store,
        serve: async () => null,
        ask: async (_prompt, _round, call): Promise<Answered> => {
          calls.push(call)
          return {
            turns: 3,
            durationMs: 120,
            costUsd: 0.42,
            text: null,
            failure: { kind: 'timeout', detail: 'no result within 300000ms' },
          }
        },
      },
      {
        chatId: 'chat-1',
        evidence: EVIDENCE,
        question: 'why?',
        by: 'human:steven',
        call: CALL,
        runtime: 'claude-code',
      },
    )

    // A process that returned an outcome is recorded even though it failed —
    // only a killed one (the `crash` test below) records nothing (#496).
    expect(store.types()).toEqual(['DiscussionAsked', 'RunSpent', 'DiscussionAnswered'])
    expect(held).toEqual({ costUsd: 0.42, answered: false, proposal: null })
    // **The cost is `RunSpent`'s alone (#502, 0110 §9)** — `DiscussionAnswered`
    // carries no dollar figure of its own any more.
    const spent = store.appended.find((e) => e.type === 'RunSpent')!
    expect((spent.data as { costUsd: number | null }).costUsd).toBe(0.42)
    const answer = answerOf(store.appended)
    expect(answer.failure).toContain('timeout')
    // Every round — and here, the only one — receives the `HoldOptions.call` it was handed.
    expect(calls).toEqual([CALL])
  })

  /**
   * A killed process has nothing to record, and records nothing (0110 §2) —
   * the other half of `#496` from the test above, where a process that
   * answered with a failure still billed one `RunSpent`.
   */
  it('appends no RunSpent for a process that was killed before it answered anything', async () => {
    const store = fakeStore()
    const held = await holdDiscussion(
      {
        store: store.store,
        serve: async () => null,
        ask: async (): Promise<Answered> => {
          throw new Error('killed')
        },
      },
      {
        chatId: 'chat-1',
        evidence: EVIDENCE,
        question: 'why?',
        by: 'human:steven',
        call: CALL,
        runtime: 'claude-code',
      },
    )

    expect(store.types()).toEqual(['DiscussionAsked', 'DiscussionAnswered'])
    expect(held.answered).toBe(false)
    expect(answerOf(store.appended).failure).toContain('crash')
  })

  it('serves the files it is asked for, then answers with them', async () => {
    const store = fakeStore()
    const served: string[] = []
    let round = 0

    const held = await holdDiscussion(
      {
        store: store.store,
        serve: async (ref, path) => {
          served.push(`${ref}:${path}`)
          return 'export const x = 1;'
        },
        ask: async (prompt): Promise<Answered> => {
          round += 1
          if (round === 1) {
            return { turns: 1, durationMs: 1, costUsd: 0.1, text: '{"read":["main:a.ts"]}', failure: null }
          }
          expect(prompt).toContain('export const x = 1;')
          return {
            turns: 1,
            durationMs: 1,
            costUsd: 0.2,
            text: '{"answer":"it is a.ts","cannot":[],"proposal":null}',
            failure: null,
          }
        },
      },
      {
        chatId: 'chat-1',
        evidence: EVIDENCE,
        question: 'why?',
        by: 'human:steven',
        call: CALL,
        runtime: 'claude-code',
      },
    )

    expect(served).toEqual(['main:a.ts'])
    expect(held.answered).toBe(true)
    // Both rounds, on one event. A person watching the meter is watching what
    // the question cost, not what one of its rounds did.
    expect(held.costUsd).toBeCloseTo(0.3)
    const answer = answerOf(store.appended)
    expect(answer.read).toEqual(['main:a.ts'])
  })

  /**
   * One `RunSpent` per process, not one per question (#496, 0110 §2). A
   * question that takes three processes — two reads, then an answer — leaves
   * three `RunSpent`s on the chat stream, each carrying its own round's
   * figures — the spend `held.costUsd` sums in memory, never a second time on
   * `DiscussionAnswered` (#502, 0110 §9).
   */
  it('appends one RunSpent per process, and holdDiscussion sums the cost in memory', async () => {
    const store = fakeStore()
    const rounds: Answered[] = [
      {
        turns: 1,
        durationMs: 10,
        costUsd: 0.1,
        text: '{"read":["main:a.ts"]}',
        failure: null,
        usage: [{ model: 'claude-sonnet-5', tokens: { fresh: 10 } }],
      },
      {
        turns: 2,
        durationMs: 20,
        costUsd: null,
        text: '{"read":["main:b.ts"]}',
        failure: null,
        usage: [{ model: 'claude-sonnet-5', tokens: { fresh: 20 } }],
      },
      {
        turns: 3,
        durationMs: 30,
        costUsd: 0.3,
        text: '{"answer":"done","cannot":[],"proposal":null}',
        failure: null,
        usage: [{ model: 'claude-sonnet-5', tokens: { fresh: 30 } }],
      },
    ]
    let round = 0

    const held = await holdDiscussion(
      {
        store: store.store,
        serve: async () => 'x',
        ask: async (): Promise<Answered> => rounds[round++]!,
      },
      {
        chatId: 'chat-1',
        evidence: EVIDENCE,
        question: 'why?',
        by: 'human:steven',
        call: CALL,
        runtime: 'claude-code',
      },
    )

    expect(store.types()).toEqual(['DiscussionAsked', 'RunSpent', 'RunSpent', 'RunSpent', 'DiscussionAnswered'])
    const spents = store.appended
      .filter((e) => e.type === 'RunSpent')
      .map(
        (e) => e.data as { for: unknown; runtime: unknown; turns: number; durationMs: number; costUsd: number | null },
      )
    expect(spents.map((s) => [s.turns, s.durationMs, s.costUsd])).toEqual([
      [1, 10, 0.1],
      [2, 20, null],
      [3, 30, 0.3],
    ])
    for (const s of spents) {
      expect(s.for).toEqual({ _tag: 'Discussion' })
      expect(s.runtime).toBe('claude-code')
    }

    expect(held.costUsd).toBeCloseTo(0.4)
    const answer = answerOf(store.appended)
    expect(answer.turns).toBe(6)
    expect(answer.durationMs).toBe(60)
  })

  /**
   * **Each round's own `RunSpent` carries its own usage, never accumulated**
   * (#502, 0110 §9/§13): `usage` is gone from `DiscussionAnswered`, and spend
   * — tokens included — has one source, `RunSpent`, one row per process.
   */
  it("carries each round's own usage on its own RunSpent, not summed onto DiscussionAnswered", async () => {
    const store = fakeStore()
    let round = 0

    await holdDiscussion(
      {
        store: store.store,
        serve: async () => 'x',
        ask: async (): Promise<Answered> => {
          round += 1
          return round === 1
            ? {
                turns: 1,
                durationMs: 1,
                costUsd: 0.1,
                text: '{"read":["main:a.ts"]}',
                failure: null,
                usage: [{ model: 'claude-sonnet-5', tokens: { fresh: 10, output: 2 } }],
              }
            : {
                turns: 1,
                durationMs: 1,
                costUsd: 0.2,
                text: '{"answer":"it is a.ts","cannot":[],"proposal":null}',
                failure: null,
                usage: [{ model: 'claude-sonnet-5', tokens: { fresh: 5, output: 1 } }],
              }
        },
      },
      {
        chatId: 'chat-1',
        evidence: EVIDENCE,
        question: 'why?',
        by: 'human:steven',
        call: CALL,
        runtime: 'claude-code',
      },
    )

    const spents = store.appended.filter((e) => e.type === 'RunSpent').map((e) => e.data as { usage: unknown })
    expect(spents.map((s) => s.usage)).toEqual([
      [{ model: 'claude-sonnet-5', tokens: { fresh: 10, output: 2 } }],
      [{ model: 'claude-sonnet-5', tokens: { fresh: 5, output: 1 } }],
    ])
    expect(answerOf(store.appended)).not.toHaveProperty('usage')
  })

  it('leaves usage off the event when nothing reported any', async () => {
    const store = fakeStore()
    await holdDiscussion(
      {
        store: store.store,
        serve: async () => null,
        ask: async (): Promise<Answered> => ({
          turns: 1,
          durationMs: 1,
          costUsd: 0.1,
          text: '{"answer":"ok","cannot":[],"proposal":null}',
          failure: null,
        }),
      },
      {
        chatId: 'chat-1',
        evidence: EVIDENCE,
        question: 'why?',
        by: 'human:steven',
        call: CALL,
        runtime: 'claude-code',
      },
    )

    const answer = answerOf(store.appended)
    expect(answer.usage).toBeUndefined()
  })

  it('stops asking for files once the rounds run out, and says that is why', async () => {
    const store = fakeStore()
    await holdDiscussion(
      {
        store: store.store,
        serve: async () => 'x',
        ask: async (): Promise<Answered> => ({
          turns: 1,
          durationMs: 1,
          costUsd: 0.01,
          text: '{"read":["main:a.ts"]}',
          failure: null,
        }),
      },
      {
        chatId: 'chat-1',
        evidence: EVIDENCE,
        question: 'why?',
        by: 'human:steven',
        call: CALL,
        runtime: 'claude-code',
      },
    )

    const answer = answerOf(store.appended)
    expect(answer.failure).toContain(`${MAX_READ_ROUNDS} rounds`)
  })
})

describe('the conversation, read back', () => {
  // **`spendOf`/`usageOf` are gone (#502, 0110 §9/§13)**: `DiscussionAnswered`
  // carries no dollar figure or usage of its own any more — the `spend`
  // projection folds `RunSpent` alone, and this fold is `turnsOf`'s claim only.
  it('pairs each ask with the answer that followed it', () => {
    const events = [
      envelope('DiscussionAsked', { question: 'why?', by: 'human:steven', reading: [] }),
      envelope('DiscussionAnswered', { text: 'because' }),
      envelope('DiscussionAsked', { question: 'and then?', by: 'human:steven', reading: [] }),
    ]

    expect(turnsOf(events)).toEqual([
      { question: 'why?', by: 'human:steven', answer: 'because' },
      { question: 'and then?', by: 'human:steven', answer: null },
    ])
  })
})

// ---------------------------------------------------------------- fixtures --

function envelope(type: string, data: unknown): Envelope {
  return {
    seq: 1n,
    streamId: 'chat-1',
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor: 'conductor',
    causation: null,
    at: new Date('2026-09-09T10:00:00Z'),
  }
}

/**
 * The one `DiscussionAnswered` among what a turn appended, found by type
 * rather than by index — a `RunSpent` per process (#496) sits between the ask
 * and the answer now, so the answer's position shifts with the round count.
 */
function answerOf(appended: ToAppend[]): Record<string, unknown> {
  const answer = appended.find((e) => e.type === 'DiscussionAnswered')
  if (answer === undefined) throw new Error('no DiscussionAnswered was appended')
  return answer.data as Record<string, unknown>
}

/** Enough of an `EventStore` for a fold that only reads and appends one stream. */
function fakeStore() {
  const appended: ToAppend[] = []
  return {
    appended,
    types: () => appended.map((e) => e.type),
    store: {
      read: async () => appended.map((e) => envelope(e.type, e.data)),
      append: async (_stream: string, _at: number, events: ToAppend[]) => {
        appended.push(...events)
      },
    } as never,
  }
}
