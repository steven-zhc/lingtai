import { aWaitId } from '@lingtai/domain/test/events'
import type { SpendRow } from '@lingtai/projector'
import type { TaskCard } from '@lingtai/projector/task-view'
/**
 * What the board gives weight to, and what it leads with.
 *
 * Driven off the screenshot in #81: two projects, three queued, one running,
 * one waiting, six landed — six full cards of finished `enhancement`s filling
 * the screen while the one card asking for a person took about a twelfth of the
 * ink, and a bar leading with `11 items`, the sum of four columns that mean
 * different things. The two numbers an operator acts on — how many need me, and
 * what has this cost — were absent, the second of them from a page carrying
 * eleven costs and no total.
 *
 * The ordering and the arithmetic are checked here rather than in the page,
 * because both are functions of the cards and nothing else.
 */
import { describe, expect, it } from 'vitest'

import { LANDED_OPEN, compareUrl, issueUrl, ledger, toCard, toColumns } from '../src/lib/board.ts'

function task(over: Partial<TaskCard> = {}): TaskCard {
  return {
    taskId: `ticket-esctest-${over.issue ?? '1'}`,
    project: 'esctest',
    issue: '1',
    title: 'a task',
    kind: 'enhancement',
    state: 'landed',
    tier: 'guarded',
    runId: null,
    turns: null,
    passed: 0,
    failed: 0,
    waived: 0,
    approved: 0,
    baseSha: null,
    headSha: null,
    files: null,
    insertions: null,
    deletions: null,
    note: null,
    updatedAt: new Date('2026-09-04T04:27:22Z'),
    closedAt: null,
    attempts: 0,
    restarts: 0,
    restartsOf: 0,
    lastAttemptAt: null,
    awaitingSha: null,
    awaitingApproval: false,
    // A real wait when the caller asks for `state: 'waiting'` — `wait: null`
    // there is the combination `toCard`/`waitOf` can never produce.
    wait:
      over.state === 'waiting'
        ? { waitId: aWaitId(), reason: { _tag: 'OwnQuestion', question: 'still relevant?', by: 'steven' } }
        : null,
    answer: null,
    triage: { started: null, result: null },
    triageHeadSha: null,
    repairPending: false,
    ...over,
  }
}

describe("the Landed lane's order", () => {
  /**
   * "Collapsed by default past the most recent few" is only a sentence the
   * order can make true. `readTasks` hands the lane back by ticket number,
   * which is neither recency nor anything a person reading history wants.
   */
  it('puts what landed most recently first', () => {
    const landed = toColumns(
      [
        toCard(task({ issue: '150', updatedAt: new Date('2026-09-06T00:00:00Z') })),
        toCard(task({ issue: '151', updatedAt: new Date('2026-09-08T00:00:00Z') })),
        toCard(task({ issue: '149', updatedAt: new Date('2026-09-07T00:00:00Z') })),
      ],
      [],
    ).find((c) => c.id === 'landed')

    expect(landed?.cards.map((c) => c.ref)).toEqual(['151', '149', '150'])
  })

  /**
   * The other lanes are ordered deliberately by `readTasks` — waiting by how
   * long it has waited, which is the question that lane exists to ask — and
   * this is not the place that gets to undo it.
   */
  it('leaves every other lane in the order it was given', () => {
    const columns = toColumns([
      toCard(task({ state: 'waiting', issue: '9', updatedAt: new Date('2026-09-01T00:00:00Z') })),
      toCard(task({ state: 'waiting', issue: '8', updatedAt: new Date('2026-09-08T00:00:00Z') })),
    ])

    expect(columns.find((c) => c.id === 'waiting')?.cards.map((c) => c.ref)).toEqual(['9', '8'])
  })

  it('keeps enough of the lane open to answer whether the last thing worked', () => {
    expect(LANDED_OPEN).toBeGreaterThan(0)
  })
})

/** `spend` fixtures: `round: 0` is work, `round: 1` or above is answering (0039 §3). */
function spendRow(ticket: string, costUsd: number | null, over: Partial<SpendRow> = {}): SpendRow {
  return {
    seq: '1',
    at: new Date('2026-09-10T04:27:22Z'),
    streamId: `pass-${ticket}`,
    ticket,
    project: null,
    pass: `pass-${ticket}`,
    purpose: 'Action',
    step: 'proposed',
    action: 'build',
    round: 0,
    runtime: 'claude-code',
    turns: 1,
    durationMs: 1000,
    costUsd,
    usage: [],
    ...over,
  }
}

describe('what the board says it has cost', () => {
  /**
   * Roughly $16 was on the #81 screenshot, one card at a time, and stated
   * nowhere.
   */
  it('totals the cards in front of you, across every lane', () => {
    const columns = toColumns([
      toCard(task({ state: 'landed', issue: '1' })),
      toCard(task({ state: 'landed', issue: '2' })),
      toCard(task({ state: 'waiting', issue: '3' })),
      toCard(task({ state: 'running', issue: '4' })),
    ])
    const rows = [
      spendRow('ticket-esctest-1', 0.97),
      spendRow('ticket-esctest-2', 1.78),
      spendRow('ticket-esctest-3', 3.4),
      // Never spent, so this card contributes nothing — still a card, still counted.
    ]

    const { total } = ledger(columns, rows)
    expect(total.byPurpose.Work.reportedCents).toBe(615)
    expect(total.cards).toBe(4)
  })

  /**
   * Apart from the work, for the reason the card keeps it apart: a repair is
   * default-on and spends an agent without being asked again, so folding it in
   * would make it an invisible bill (#84).
   */
  it("keeps repair out of the work's figure and still shows it", () => {
    const columns = toColumns([toCard(task())])
    const rows = [spendRow('ticket-esctest-1', 1.0), spendRow('ticket-esctest-1', 0.5, { round: 1 })]
    const { total } = ledger(columns, rows)

    expect(total.byPurpose.Work.reportedCents).toBe(100)
    expect(total.byPurpose.Answering.reportedCents).toBe(50)
  })

  it('says nothing spent rather than nothing at all on an empty board', () => {
    const { total } = ledger(toColumns([]), [])
    expect(total.cards).toBe(0)
    expect(total.byPurpose.Work.reportedRuns).toBe(0)
    expect(total.byPurpose.Work.unknown).toBe(0)
  })

  /**
   * `ticket-lingtai-89` ran twice before `spend` existed, so `readSpend({ ticket })`
   * returns `[]` for it — `attempts: 2` says it ran, but no row names it.
   * `billOf` used to fold that to five empty bills, which `ledger` printed as
   * `—` in every column: the same reading an unclaimed card gets, though one
   * of them ran and one never did (0110 §7).
   */
  it('reads a ticket with attempts but not one spend row as unknown, never as nothing', () => {
    const columns = toColumns([toCard(task({ attempts: 2 }))])
    const { total } = ledger(columns, [])

    expect(total.byPurpose.Work).toEqual({ reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 2 })
  })
})

describe("where a card's reference points", () => {
  it('goes to the issue on GitHub', () => {
    expect(issueUrl('lingtai-dev', 'lingtai', '112', 'github')).toBe(
      'https://github.com/lingtai-dev/lingtai/issues/112',
    )
  })

  /**
   * A project registered before `ProjectConfigured` carried an owner has no
   * link to build, and a dead one is worse than none.
   */
  it('declines to invent one for a project with no owner recorded', () => {
    expect(issueUrl(null, 'lingtai', '112', 'github')).toBeNull()
  })

  /**
   * A `db` project's tickets are not on GitHub, so a card for one carries no
   * issue link (#384) — the title still goes to the task page.
   */
  it('carries no link for a project whose tickets are in the database', () => {
    expect(issueUrl('lingtai-dev', 'lingtai', '112', 'db')).toBeNull()
  })

  /**
   * Unknown is not `'github'`: a project the board could not read a recipe
   * for is exactly the project likeliest to have no GitHub App, so it gets
   * no link rather than the bogus one it would have gotten before `tickets`
   * existed.
   */
  it('declines to invent one for a project whose ticket source is unknown', () => {
    expect(issueUrl('lingtai-dev', 'lingtai', '112', null)).toBeNull()
  })
})

describe("where a merge-conflict wait's compare view points", () => {
  it('compares the base against the branch on GitHub, keeping the branch slash', () => {
    expect(compareUrl('lingtai-dev', 'lingtai', 'main', 'agent/590', 'github')).toBe(
      'https://github.com/lingtai-dev/lingtai/compare/main...agent/590',
    )
  })

  it('encodes each segment but not the slash between them', () => {
    expect(compareUrl('o', 'p', 'release/1 0', 'agent/590', 'github')).toBe(
      'https://github.com/o/p/compare/release/1%200...agent/590',
    )
  })

  it('gives no link without an owner, a base, or tickets known to be on GitHub', () => {
    expect(compareUrl(null, 'lingtai', 'main', 'agent/590', 'github')).toBeNull()
    expect(compareUrl('o', 'lingtai', null, 'agent/590', 'github')).toBeNull()
    expect(compareUrl('o', 'lingtai', 'main', 'agent/590', 'db')).toBeNull()
    expect(compareUrl('o', 'lingtai', 'main', 'agent/590', null)).toBeNull()
  })
})
