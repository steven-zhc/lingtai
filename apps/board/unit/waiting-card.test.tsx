/**
 * #482: what a person reads on the "Waiting on you" card, pinned once per
 * `WaitReason` (0118 §1, `@lingtai/domain/wait`) before #483 rewrites
 * `actions.ts`, `decide.tsx`, `rail.tsx` and `standing.tsx` underneath it.
 *
 * Each wait is built with `aWait`/`aClaim` (`@lingtai/domain/test/events`),
 * folded through the real `task_view` projection on an in-memory sqlite store
 * — the same path `task-view-rebuild.test.ts` runs, unit under 0060 §1 — read
 * back with `store.tasks`, turned into a `BoardCard` with `toCard`
 * (`lib/board.ts`) and rendered with `<Card>` exactly as the page does. What
 * is pinned is the wait pill's text, the `.question` sentence, and the
 * ordered button labels inside `.btnrow` — the three things a person reads
 * on a card that is waiting on them.
 *
 * **Generated from today's code, and never regenerated after the `src`**
 * **change.** The literals below are what `legacyColumns` (`@lingtai/domain`),
 * `describeWait` (`@lingtai/projector/task-view`) and `decide.tsx` produce
 * now; if this test goes red once #483 lands, the card changed and the fix
 * belongs in `src`, never in this file.
 *
 * `standing.tsx` and the task page's own controls are out of scope on
 * purpose: their props are `StandingView`/`RunView`, which are #483's and
 * #484's to rewrite, so a pin built on them could not survive either ticket
 * unedited.
 */
import { aWaitId } from '@lingtai/domain/test/events'
import { WaitReason } from '@lingtai/domain/wait'
import { createSqliteProjectionStore, openSqliteProjections } from '@lingtai/projector/sqlite'
import { taskViewProjection } from '@lingtai/projector/task-view'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Card } from '../src/app/page.tsx'
import { toCard } from '../src/lib/board.ts'
import { WAIT_FIXTURES, type WaitFixture } from '../test/waits.ts'

interface Fixture extends WaitFixture {
  /** `card.wait` — the pill's text — or null where the wait draws none. */
  expectedPill: string | null
  /** `card.note`, rendered in the `.question` paragraph. */
  expectedQuestion: string | null
  /** The `.btnrow` button labels, in document order. */
  expectedButtons: string[]
}

/** Keyed by `WaitFixture.name` — the events are `test/waits.ts`'s own, shared with `moves-by-wait.test.tsx`. */
const EXPECTED: Record<string, Pick<Fixture, 'expectedPill' | 'expectedQuestion' | 'expectedButtons'>> = {
  ownquestion: {
    expectedPill: 'waiting for your answer',
    expectedQuestion: 'which base branch?',
    expectedButtons: ['Answer', 'Withdraw', 'Close'],
  },
  agentquestion: {
    expectedPill: null,
    expectedQuestion: 'the `implement` step asked: which approach?',
    expectedButtons: ['Back to the queue', 'Close'],
  },
  signoffrequired: {
    expectedPill: 'waiting for your review',
    expectedQuestion: 'the `merge` step held: merge this?',
    expectedButtons: ['Approve', 'Back to the queue', 'Close'],
  },
  fixerdisagrees: {
    expectedPill: null,
    expectedQuestion: 'the `implement` step declined: the fixer thinks this is fine',
    expectedButtons: ['Back to the queue', 'Close'],
  },
  nothingproduced: {
    expectedPill: null,
    expectedQuestion: 'the `implement` step did-not-finish: the agent produced no commits',
    expectedButtons: ['Back to the queue', 'Close'],
  },
  'proposedescalated-buildred': {
    expectedPill: 'waiting for your review',
    expectedQuestion: 'agent/buildred is waiting on you. tsc failed',
    expectedButtons: ['Approve', 'Back to the queue', 'Close'],
  },
  'proposedescalated-verifyred': {
    expectedPill: 'waiting for your review',
    expectedQuestion: 'agent/verifyred is waiting on you. verify red output',
    expectedButtons: ['Approve', 'Back to the queue', 'Close'],
  },
  'proposedescalated-mergeconflict': {
    expectedPill: 'waiting for your review',
    expectedQuestion: 'agent/mergeconflict is waiting on you. conflict output',
    expectedButtons: ['Approve', 'Back to the queue', 'Close'],
  },
  'proposedescalated-reviewfindings': {
    expectedPill: 'waiting for your review',
    expectedQuestion: 'agent/reviewfindings is waiting on you. bug',
    expectedButtons: ['Approve', 'Back to the queue', 'Close'],
  },
  'proposedescalated-unpushed': {
    expectedPill: null,
    expectedQuestion: 'agent/unpushed is waiting on you. tsc failed',
    expectedButtons: ['Back to the queue', 'Close'],
  },
  checkrefused: {
    expectedPill: null,
    expectedQuestion: 'the `merge` step refused: ci red',
    expectedButtons: ['Approve', 'Back to the queue', 'Close'],
  },
  mergerefused: {
    expectedPill: null,
    expectedQuestion: 'dirty-base: uncommitted changes present',
    expectedButtons: ['Approve', 'Back to the queue', 'Close'],
  },
  budgetexhausted: {
    expectedPill: null,
    expectedQuestion: 'out-of-turns: spent 80 turns',
    expectedButtons: ['Back to the queue', 'Close'],
  },
  agentcrashed: {
    expectedPill: null,
    expectedQuestion: 'the `implement` step did-not-finish: segfault',
    expectedButtons: ['Back to the queue', 'Close'],
  },
  setuprefused: {
    expectedPill: null,
    expectedQuestion: 'the `prepared` step refused: npm install failed',
    expectedButtons: ['Back to the queue', 'Close'],
  },
  answerunreadable: {
    expectedPill: 'waiting for your review',
    expectedQuestion:
      'agent/answerunreadable is waiting on you. `review`&#x27;s findings could not be read at all: not json',
    expectedButtons: ['Approve', 'Back to the queue', 'Close'],
  },
}

const FIXTURES: Fixture[] = WAIT_FIXTURES.map((f) => ({ ...f, ...EXPECTED[f.name]! }))

/** `<p class="question">…</p>` — `card.note`, where there is one. */
function questionOf(html: string): string | null {
  return /<p class="question">([^<]*)<\/p>/.exec(html)?.[1] ?? null
}

/** The wait pill's text — the one `<li class="pill sig">`/`<li class="pill hold">` this card ever draws. */
function waitPillOf(html: string): string | null {
  return /<li class="pill (?:sig|hold)"[^>]*>([^<]*)<\/li>/.exec(html)?.[1] ?? null
}

/** Every `<button>`'s own text, in document order — Decide's, then Requeue's, then Close's. */
function buttonsOf(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1] ?? '')
}

async function foldOne(fx: Fixture): Promise<string> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => taskViewProjection.create(ctx))
    await store.transact((ctx) => taskViewProjection.apply(fx.events, ctx))
    const rows = await store.tasks({ retentionDays: 2 })
    const row = rows.find((r) => r.taskId === fx.taskId)
    if (row === undefined) throw new Error(`no task_view row for ${fx.taskId}`)
    // A wait id, not read off `laneWaitIds` here — this fixture is about the
    // button set per `WaitReason`, not about the staleness guard, and `Card`
    // only ever checks this for `=== null` (#508).
    const card = toCard(row, null, null, null, null, undefined, undefined, aWaitId())
    return renderToStaticMarkup(<Card card={card} showProject={false} issue={null} paused={false} />)
  } finally {
    db.close()
  }
}

describe('the waiting card is pinned for every WaitReason (#482)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pins one fixture per WaitReason tag — a thirteenth variant fails here, not silently', () => {
    const pinned = new Set(FIXTURES.map((f) => f.tag))
    const declared = new Set(WaitReason.options.map((o) => o.shape._tag.value))
    expect([...pinned].sort()).toEqual([...declared].sort())
  })

  for (const fx of FIXTURES) {
    it(`${fx.tag} — ${fx.name}`, async () => {
      const html = await foldOne(fx)
      expect(waitPillOf(html)).toBe(fx.expectedPill)
      expect(questionOf(html)).toBe(fx.expectedQuestion)
      expect(buttonsOf(html)).toEqual(fx.expectedButtons)
    })
  }
})

describe('a card whose wait id could not be read (#510)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the refusal and offers no Decide/Requeue/Close', async () => {
    const fx = FIXTURES[0]!
    const db = openSqliteProjections(':memory:')
    let html: string
    try {
      const store = createSqliteProjectionStore(db)
      await store.transact((ctx) => taskViewProjection.create(ctx))
      await store.transact((ctx) => taskViewProjection.apply(fx.events, ctx))
      const rows = await store.tasks({ retentionDays: 2 })
      const row = rows.find((r) => r.taskId === fx.taskId)
      if (row === undefined) throw new Error(`no task_view row for ${fx.taskId}`)
      // `laneWaitIds`'s own read failed (or the fold moved off `blocked`
      // before it ran) — the null this test is about, distinct from the
      // staleness guard the fixtures above pass a real id for.
      const card = toCard(row, null, null, null, null, undefined, undefined, null)
      html = renderToStaticMarkup(<Card card={card} showProject={false} issue={null} paused={false} />)
    } finally {
      db.close()
    }
    expect(html).toContain('the wait on this card could not be read')
    expect(buttonsOf(html)).toEqual([])
  })
})
