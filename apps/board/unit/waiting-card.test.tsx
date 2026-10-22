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
 * is pinned is the wait's first line, with no wait pill, hold detail, or
 * resolutions. Those now live on the task page (0118 §2).
 *
 * `standing.tsx` and the task page's own controls are out of scope on
 * purpose: their props are `StandingView`/`RunView`, which are #483's and
 * #484's to rewrite, so a pin built on them could not survive either ticket
 * unedited.
 */
import { WaitReason } from '@lingtai/domain/wait'
import { createSqliteProjectionStore, openSqliteProjections } from '@lingtai/projector/sqlite'
import { taskViewProjection, type TaskCard } from '@lingtai/projector/task-view'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Card } from '../src/app/page.tsx'
import { toCard } from '../src/lib/board.ts'
import { WAIT_FIXTURES, type WaitFixture } from '../test/waits.ts'

interface Fixture extends WaitFixture {
  /** The wait's own first line when triage has no current advice. */
  expectedQuestion: string | null
}

/** Keyed by `WaitFixture.name` — the events are `test/waits.ts`'s own, shared with `moves-by-wait.test.tsx`. */
const EXPECTED: Record<string, Pick<Fixture, 'expectedQuestion'>> = {
  ownquestion: {
    expectedQuestion: 'which base branch?',
  },
  agentquestion: {
    expectedQuestion: 'the `implement` step asked: which approach?',
  },
  signoffrequired: {
    expectedQuestion: 'the `merge` step held: merge this?',
  },
  fixerdisagrees: {
    expectedQuestion: 'the `implement` step declined: the fixer thinks this is fine',
  },
  nothingproduced: {
    expectedQuestion: 'the `implement` step did-not-finish: the agent produced no commits',
  },
  'proposedescalated-buildred': {
    expectedQuestion: 'agent/buildred is waiting on you. tsc failed',
  },
  'proposedescalated-verifyred': {
    expectedQuestion: 'agent/verifyred is waiting on you. verify red output',
  },
  'proposedescalated-mergeconflict': {
    expectedQuestion: 'agent/mergeconflict is waiting on you. conflict output',
  },
  'proposedescalated-reviewfindings': {
    expectedQuestion: 'agent/reviewfindings is waiting on you. bug',
  },
  'proposedescalated-unpushed': {
    expectedQuestion: 'agent/unpushed is waiting on you. tsc failed',
  },
  checkrefused: {
    expectedQuestion: 'the `merge` step refused: ci red',
  },
  mergerefused: {
    expectedQuestion: 'dirty-base: uncommitted changes present',
  },
  budgetexhausted: {
    expectedQuestion: 'out-of-turns: spent 80 turns',
  },
  agentcrashed: {
    expectedQuestion: 'the `implement` step did-not-finish: segfault',
  },
  setuprefused: {
    expectedQuestion: 'the `prepared` step refused: npm install failed',
  },
  answerunreadable: {
    expectedQuestion:
      'agent/answerunreadable is waiting on you. `review`&#x27;s findings could not be read at all: not json',
  },
}

const FIXTURES: Fixture[] = WAIT_FIXTURES.map((f) => ({ ...f, ...EXPECTED[f.name]! }))

/** The unadvised wait's own first line, where there is one. */
function questionOf(html: string): string | null {
  return /<p class="question waiting-fallback">([^<]*)<\/p>/.exec(html)?.[1] ?? null
}

/** Every `<button>`'s own text, in document order. */
function buttonsOf(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1] ?? '')
}

async function foldOne(fx: Fixture, options: { row?: Partial<TaskCard> } = {}): Promise<string> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => taskViewProjection.create(ctx))
    await store.transact((ctx) => taskViewProjection.apply(fx.events, ctx))
    const rows = await store.tasks({ retentionDays: 2 })
    const row = rows.find((r) => r.taskId === fx.taskId)
    if (row === undefined) throw new Error(`no task_view row for ${fx.taskId}`)
    const projected = { ...row, ...options.row }
    const card = toCard(projected)
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
      expect(questionOf(html)).toBe(fx.expectedQuestion)
      expect(html).toContain('class="id"')
      expect(html).toContain('class="ti"')
      expect(html).not.toContain('class="proj"')
      expect(html).not.toContain('class="kdot"')
      expect(html).not.toContain('class="pill')
      expect(html).not.toContain('class="held"')
      expect(html).not.toContain('class="btnrow"')
      expect(buttonsOf(html)).toEqual([])
    })
  }
})

describe('the cause line', () => {
  const fx = FIXTURES.find((f) => f.name === 'agentquestion')!
  const advised = {
    _tag: 'TriageAdvised' as const,
    cause: { _tag: 'WrongApproach' as const },
    resolution: 'Requeue' as const,
    summary: 'the approach cannot converge',
    want: null,
  }

  it('distinguishes the current wait cause from its summary', async () => {
    const html = await foldOne(fx, { row: { triage: { started: null, result: advised } } })
    expect(html).toContain(
      '<span class="waiting-cause-label cause-chip cause-chip--approach">The approach is wrong</span>',
    )
    expect(html).toContain('<span class="waiting-cause-summary">the approach cannot converge</span>')
    expect(questionOf(html)).toBeNull()
    expect(html).not.toContain('class="held"')
    expect(buttonsOf(html)).toEqual([])
  })

  it('uses the wait reason when the copied note is stale', async () => {
    const html = await foldOne(fx, {
      row: { note: 'old detail' },
    })
    expect(questionOf(html)).toBe(fx.expectedQuestion)
    expect(html).not.toContain('old detail')
  })

  it('uses the wait first line when triage failed', async () => {
    const html = await foldOne(fx, {
      row: { triage: { started: null, result: { _tag: 'TriageFailed', why: 'raw failure' } } },
    })
    expect(questionOf(html)).toBe(fx.expectedQuestion)
    expect(html).not.toContain('waiting-cause-label')
    expect(html).not.toContain('raw failure')
  })

  it('still renders the reason when the copied note is null', async () => {
    const html = await foldOne(fx, { row: { note: null } })
    expect(questionOf(html)).toBe(fx.expectedQuestion)
  })
})
