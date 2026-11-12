import type { Lock } from '@lingtai/domain'
import type { TaskCard } from '@lingtai/projector/task-view'
/**
 * The Queued column's grouping, which is where priority becomes legible.
 *
 * `source.kinds` is a priority order — earlier wins — and until #85 the column
 * rendered nine cards in a flat list, so *what gets taken next* was a fact you
 * could only get by reading the recipe. The grouping is the answer, and it has
 * to be `selectRunnable`'s order and not a second one: a column that claims
 * `feature` is next while the conductor claims a `bug` is worse than no
 * grouping at all.
 */
import { describe, expect, it } from 'vitest'

import {
  groupQueue,
  queuedStanding,
  toCard,
  type BlockedTicket,
  type EpicTicket,
  type QueueEntry,
} from '../src/lib/board.ts'
import { runNowCaption, type QueuedView } from '../src/lib/queued.ts'

function queued(over: Partial<TaskCard> & { issue: string; kind: string }): TaskCard {
  return {
    taskId: `ticket-esctest-${over.issue}`,
    project: 'esctest',
    title: `issue ${over.issue}`,
    state: 'queued',
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
    wait: null,
    answer: null,
    split: null,
    triage: { started: null, result: null },
    triageHeadSha: null,
    repairPending: false,
    ...over,
  }
}

const card = (issue: string, kind: string, heldUntil: Date | null = null) => toCard(queued({ issue, kind }), heldUntil)

const NO_PARENTS = new Map<string, number>()
const refs = (entries: readonly QueueEntry[]) =>
  entries.map((e) =>
    e.type === 'card'
      ? e.card.ref
      : e.type === 'blocked'
        ? `b${e.ticket.ref}`
        : `e${e.epic.ref}[${[...e.cards.map((c) => c.ref), ...e.blocked.map((t) => `b${t.ref}`)].join(',')}]`,
  )

const epic = (ref: number, closed = 1, total = 4): EpicTicket => ({
  project: 'esctest',
  ref,
  title: `epic ${ref}`,
  kind: 'feature',
  kindColor: null,
  closed,
  total,
})

const blockedTicket = (ref: number, kind: string | null = 'feature'): BlockedTicket => ({
  project: 'esctest',
  ref,
  title: `blocked ${ref}`,
  kind,
  blockedBy: 1,
  blockers: null,
  unread: false,
  kindColor: null,
})

const parentsOf = (pairs: Record<string, number>) => new Map(Object.entries(pairs).map(([k, v]) => [`esctest#${k}`, v]))

describe('the Queued column, in selectRunnable order', () => {
  it("walks the recipe's order, not the order cards arrive", () => {
    const { entries } = groupQueue(
      [card('62', 'feature'), card('74', 'bug'), card('75', 'tech-debt'), card('79', 'feature')],
      [],
      ['bug', 'tech-debt', 'feature'],
      NO_PARENTS,
      [],
    )
    expect(refs(entries)).toEqual(['74', '75', '62', '79'])
  })

  /** `selectRunnable`'s tiebreak: #402 before #409, and both before #4100. */
  it('orders by issue number within a kind, as the conductor does', () => {
    const { entries } = groupQueue(
      [card('4100', 'bug'), card('409', 'bug'), card('402', 'bug')],
      [],
      ['bug'],
      NO_PARENTS,
      [],
    )
    expect(refs(entries)).toEqual(['402', '409', '4100'])
  })

  it('marks the first runnable card taken first', () => {
    const { next } = groupQueue([card('79', 'feature'), card('74', 'bug')], [], ['bug', 'feature'], NO_PARENTS, [])
    expect(next).toBe('ticket-esctest-74')
  })

  it('does not mark a card the backoff is holding back', () => {
    const held = new Date('2099-01-01T00:00:00Z')
    const { entries, next } = groupQueue(
      [card('74', 'bug', held), card('79', 'feature')],
      [],
      ['bug', 'feature'],
      NO_PARENTS,
      [],
    )
    expect(refs(entries)).toEqual(['74', '79'])
    expect(next).toBe('ticket-esctest-79')
  })

  it('marks nothing when asked not to', () => {
    expect(groupQueue([card('74', 'bug')], [], ['bug'], NO_PARENTS, [], false).next).toBeNull()
  })

  it('puts a kind the order does not name after the ones it does', () => {
    const { entries } = groupQueue([card('9', 'chore'), card('74', 'bug')], [], ['bug'], NO_PARENTS, [])
    expect(refs(entries)).toEqual(['74', '9'])
  })

  it('has no order to show when no recipe could be read, and still shows every card', () => {
    const { entries } = groupQueue([card('74', 'bug'), card('62', 'feature')], [], [], NO_PARENTS, [])
    expect(refs(entries).sort()).toEqual(['62', '74'])
  })
})

describe('the Queued column, grouped by epic (#956)', () => {
  const order = ['bug', 'tech-debt', 'feature']

  it("places an epic's group where its first card falls, runnable then blocked", () => {
    const { entries, headed } = groupQueue(
      [card('10', 'feature'), card('11', 'feature')],
      [blockedTicket(12)],
      order,
      parentsOf({ '10': 5, '11': 5, '12': 5 }),
      [epic(5)],
    )
    expect(refs(entries)).toEqual(['e5[10,11,b12]'])
    expect([...headed]).toEqual(['esctest#5'])
  })

  it('interleaves two epics with ungrouped cards at each first card', () => {
    const { entries } = groupQueue(
      [
        card('1', 'bug'),
        card('20', 'feature'),
        card('21', 'feature'),
        card('30', 'tech-debt'),
        card('31', 'tech-debt'),
      ],
      [],
      order,
      parentsOf({ '20': 7, '30': 8, '21': 8, '31': 7 }),
      [epic(7), epic(8)],
    )
    // #30 (tech-debt) is the first card of epic 8; #31 the first of epic 7.
    expect(refs(entries)).toEqual(['1', 'e8[30,21]', 'e7[31,20]'])
  })

  it('groups an epic with only blocked cards, at its first blocked card', () => {
    const { entries, next } = groupQueue(
      [card('90', 'feature')],
      [blockedTicket(40, 'bug'), blockedTicket(41, 'bug')],
      order,
      parentsOf({ '40': 6, '41': 6 }),
      [epic(6)],
    )
    expect(refs(entries)).toEqual(['e6[b40,b41]', '90'])
    expect(next).toBe('ticket-esctest-90')
  })

  it('leaves a blocked card with no epic below every card and group', () => {
    const { entries } = groupQueue(
      [card('10', 'feature'), card('90', 'documentation')],
      [blockedTicket(2, 'bug'), blockedTicket(12)],
      [...order, 'documentation'],
      parentsOf({ '10': 5, '12': 5 }),
      [epic(5)],
    )
    expect(refs(entries)).toEqual(['e5[10,b12]', '90', 'b2'])
  })

  it('leaves a child ungrouped when its parent is not a known epic', () => {
    const { entries, headed } = groupQueue(
      [card('10', 'feature')],
      [blockedTicket(12)],
      order,
      parentsOf({ '10': 5, '12': 5 }),
      [],
    )
    expect(refs(entries)).toEqual(['10', 'b12'])
    expect(headed.size).toBe(0)
  })

  it('marks the first runnable card even when its group sits below a held-back card', () => {
    const held = new Date('2099-01-01T00:00:00Z')
    const { entries, next } = groupQueue(
      [card('5', 'bug', held), card('60', 'tech-debt'), card('70', 'feature')],
      [],
      order,
      parentsOf({ '60': 9 }),
      [epic(9)],
    )
    expect(refs(entries)).toEqual(['5', 'e9[60]', '70'])
    expect(next).toBe('ticket-esctest-60')
  })

  it('marks the card taken first inside a group an earlier-kind blocked child pulled up', () => {
    const { entries, next } = groupQueue(
      [card('1', 'tech-debt'), card('50', 'feature')],
      [blockedTicket(30, 'bug')],
      order,
      parentsOf({ '30': 9, '50': 9 }),
      [epic(9)],
    )
    expect(refs(entries)).toEqual(['e9[50,b30]', '1'])
    // #1 is first in today's order, though its group sits lower.
    expect(next).toBe('ticket-esctest-1')
  })

  it('never joins a group across projects', () => {
    const other = { ...epic(5), project: 'elsewhere' }
    const { entries } = groupQueue([card('10', 'feature')], [], order, parentsOf({ '10': 5 }), [other])
    expect(refs(entries)).toEqual(['10'])
  })
})

/**
 * The three states that read identically, rendered
 * ([0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md)'s closing
 * table, `#100`).
 *
 * `run failed: crash` was on the card whether the run would be back at 23:45 or
 * whether the conductor had been stopped and nothing here would move at all,
 * and a card nobody had tried said nothing — which is right, and was
 * indistinguishable from the other two because they said nothing about *when*
 * either.
 */
describe('what a Queued card says about whether it will come back', () => {
  const held = new Date('2026-09-09T04:32:00Z')
  const now = Date.parse('2026-09-09T04:00:00Z')

  it('says nothing at all about a card that is simply next', () => {
    expect(queuedStanding(card('74', 'bug'), false, now)).toBeNull()
  })

  it("says when a backing-off card returns, in `lingtai status`'s own words", () => {
    const said = queuedStanding(card('74', 'bug', held), false, now)
    expect(said?.state).toBe('backing-off')
    // The exact line `lingtai status` prints inside its brackets, so the two
    // cannot come to word the same row differently again.
    expect(said?.text).toBe('backing off — runnable in 32m')
    expect(said?.title).toBe(`backing off until ${held.toISOString()}`)
  })

  it('says nothing will start while the conductor is paused', () => {
    const said = queuedStanding(card('74', 'bug'), true, now)
    expect(said?.state).toBe('paused')
    expect(said?.text).toBe('paused — nothing will start')
  })

  describe("a project's own pause (#995)", () => {
    const lock = [{ kind: 'paused' as const, by: 'steven', since: new Date('2026-11-01T00:00:00Z') }]

    it('marks a Queued card with the project named', () => {
      const said = queuedStanding(card('74', 'bug'), false, now, lock)
      expect(said?.state).toBe('paused')
      expect(said?.text).toBe(`${card('74', 'bug').project} is paused — nothing will start`)
    })

    it('says nothing about a Running card', () => {
      expect(queuedStanding({ ...card('74', 'bug'), column: 'running' }, false, now, lock)).toBeNull()
    })

    it('is outranked by the conductor-wide pause', () => {
      expect(queuedStanding(card('74', 'bug'), true, now, lock)?.text).toBe('paused — nothing will start')
    })
  })

  /** The whole complaint, as one assertion: three states, three readings. */
  it('gives the three of them three different readings', () => {
    const readings = [
      queuedStanding(card('74', 'bug'), false, now),
      queuedStanding(card('74', 'bug', held), false, now),
      queuedStanding(card('74', 'bug'), true, now),
    ].map((s) => s?.text ?? null)

    expect(new Set(readings).size).toBe(3)
  })

  /**
   * A pause outranks a backoff, because only one of them decides anything: an
   * item whose backoff lifts in a minute still does not move while the
   * conductor is taking nothing, and `runnable in 32m` would be the more
   * precise of two answers and the wrong one.
   */
  it('says the pause, not the backoff, when both hold', () => {
    expect(queuedStanding(card('74', 'bug', held), true, now)?.state).toBe('paused')
  })

  /**
   * Neither fact is about any other lane. A running card is not backing off and
   * a paused conductor does not stop the run already in flight (0013).
   */
  it('says nothing about a card that is not queued', () => {
    const running = toCard(queued({ issue: '74', kind: 'bug', state: 'running' }))
    expect(queuedStanding(running, true, now)).toBeNull()
  })
})

describe('runNowCaption', () => {
  const none = { notOffered: null, paused: false, runnableAt: null, problem: null } as unknown as QueuedView
  it('says what the click does under each hold, in holding’s order, and nothing when none holds', () => {
    expect(runNowCaption({ ...none, notOffered: 'closed', paused: true, runnableAt: '2026-10-31T00:00:00Z' })).toBe(
      'GitHub is not offering it, so a request now would match nothing',
    )
    expect(runNowCaption({ ...none, paused: true, runnableAt: '2026-10-31T00:00:00Z' })).toBe(
      'the request waits until the conductor is resumed',
    )
    expect(runNowCaption({ ...none, runnableAt: '2026-10-31T00:00:00Z' })).toBe('skips the backoff')
    expect(runNowCaption(none)).toBeNull()
    expect(
      runNowCaption({ ...none, problem: 'GitHub failed', runnableAt: '2026-10-31T00:00:00Z', paused: true }),
    ).toBeNull()
  })
})

describe('queuedStanding: the ceiling (#1007)', () => {
  const now = new Date(2026, 10, 11, 12, 0)
  const card = { column: 'queued', runnableAt: null, project: 'esctest' } as const
  const ceiling = (day: string): Lock => ({
    kind: 'ceiling',
    since: now,
    day,
    reportedUsd: 120,
    estimatedUsd: 80,
    ceilingUsd: 200,
    until: new Date(2026, 10, 12),
  })
  const pause: Lock = { kind: 'paused', by: 'human:x', since: now }

  it("marks a card held by today's ceiling, ahead of a person's pause", () => {
    for (const locks of [[ceiling('2026-11-11')], [pause, ceiling('2026-11-11')]]) {
      const s = queuedStanding(card, false, now.getTime(), locks)
      expect(s?.state).toBe('paused')
      expect(s?.text).toBe("today's spend reached the ceiling — nothing will start")
    }
  })

  it('lets the conductor-wide pause outrank it', () => {
    expect(queuedStanding(card, true, now.getTime(), [ceiling('2026-11-11')])?.text).toBe('paused — nothing will start')
  })

  it("says nothing of yesterday's ceiling", () => {
    expect(queuedStanding(card, false, now.getTime(), [ceiling('2026-11-10')])).toBeNull()
  })
})

describe('queuedStanding: a runtime at its usage limit (#1010)', () => {
  const now = new Date(2026, 10, 11, 18, 0)
  const card = { column: 'queued', runnableAt: null, project: 'lingtai' } as const
  const limit = (until: Date): Lock => ({
    kind: 'account',
    runtime: 'claude-code',
    by: 'lingtai',
    since: new Date(2026, 10, 11, 17, 0),
    until,
    untilFrom: 'message',
    said: 'limit reached',
  })

  it('marks a Queued card before until, and not after it', () => {
    const s = queuedStanding(card, false, now.getTime(), [limit(new Date(2026, 10, 11, 23, 0))])
    expect(s?.state).toBe('paused')
    expect(s?.text).toBe('claude-code is at its usage limit until 23:00 — nothing will start')
    expect(queuedStanding(card, false, now.getTime(), [limit(new Date(2026, 10, 11, 17, 30))])).toBeNull()
  })

  it('is outranked by the conductor-wide pause', () => {
    const s = queuedStanding(card, true, now.getTime(), [limit(new Date(2026, 10, 11, 23, 0))])
    expect(s?.text).toBe('paused — nothing will start')
  })
})
