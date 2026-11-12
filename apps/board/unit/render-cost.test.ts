import { DEPENDENCIES_UNREAD } from '@lingtai/conductor/discover'
import type { ProjectFilter } from '@lingtai/conductor/filter'
import type { ProjectState } from '@lingtai/domain'
/**
 * What a render costs, as a property rather than as a stopwatch.
 *
 * #112 measured the home page at 4.68s, 4.69s and 4.82s server-side, three
 * times the detail page at a third the size, and — because `live.tsx` asks the
 * router to re-render on every append — paid again for every event the log took
 * during a run. The stage breakdown had one shape in it: `board.ts` asked each
 * project for its recipe and its queue **in series**, so two repositories cost
 * 597ms + 762ms where 762 would have done, and a third would have added a
 * third.
 *
 * A wall-clock assertion would only re-measure this machine's GitHub. What is
 * asserted here is the thing that was actually wrong and that a later edit can
 * silently undo: whether the projects overlap. It fails closed — a sequential loop deadlocks
 * on the barrier rather than merely running slower. (The recipe is a local file since #180,
 * so a render no longer fetches it at all.)
 */
import { describe, expect, it } from 'vitest'

import {
  columnSkeletonCount,
  queuedSkeletonCount,
  recordColumnCounts,
  recordQueuedOffered,
  forgetKindColors,
  forgetSkeletonCounts,
  skeletonCount,
  githubQueue,
  lastKindColor,
  queueFilters,
  type AskableFilter,
  type ProjectQueue,
} from '../src/lib/board.ts'

/** Enough of a project for a reducer that only ever reads its name. */
const project = (name: string): ProjectState => ({ project: name, owner: 'steven-zhc', base: 'main' }) as ProjectState

/**
 * A gate every caller must arrive at before any of them may leave.
 *
 * The whole test, really. Under `Promise.all` all of them arrive; under a loop
 * of `await`s the first one waits for a second caller that the loop will not
 * send until the first has returned, and the race below reports that rather
 * than hanging for the suite's timeout.
 */
function barrier(expected: number) {
  let arrived = 0
  let open!: () => void
  const all = new Promise<void>((resolve) => {
    open = resolve
  })
  return {
    async wait(): Promise<void> {
      arrived += 1
      if (arrived === expected) open()
      let timer: ReturnType<typeof setTimeout>
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`only ${arrived} of ${expected} projects were in flight at once`)),
          250,
        )
      })
      try {
        await Promise.race([all, late])
      } finally {
        clearTimeout(timer!)
      }
    },
  }
}

/**
 * A project that answered, carrying only what the reducer reads.
 *
 * `client` is on a resolved filter and is the *asking*'s, not the reducer's —
 * nothing below this point looks at it. `recipe` is read now, for
 * `ticketSourceOf` (#384), so it carries just enough of one for that call to
 * answer `'github'`.
 */
function resolvedFilter(name: string, kinds: string[]) {
  return {
    project: name,
    ok: true,
    kinds,
    backoffMs: 0,
    // `restarts` among them since 0040: the reducer reads it for the bar's chip,
    // which names both ceilings because they multiply.
    limits: { rounds: 2, restarts: 0, turns: 150, wall: '1h', wallMs: 3_600_000 },
    plan: new Map(),
    recipe: { source: {} },
  } as unknown as AskableFilter
}

function listed(filter: AskableFilter, refs: string[], kindColors: Record<string, string> = {}): ProjectQueue {
  const name = filter.project
  return {
    state: 'listed',
    filter,
    offered: { runnable: [], skipped: [], kindColors, dependenciesUnread: null },
    runnable: refs.map((ref) => ({
      taskId: `ticket-${name}-${ref}`,
      issue: ref,
      title: `issue ${ref}`,
      kind: filter.kinds[0]!,
    })),
    blocked: [],
  }
}

const filterOf = (kinds: Record<string, string[]>) => async (p: ProjectState) =>
  resolvedFilter(p.project!, kinds[p.project!] ?? ['bug']) as ProjectFilter

describe('the recipes on a board', () => {
  it('are all read at once, not one after the one before', async () => {
    const step = barrier(2)
    const result = await queueFilters([project('lingtai'), project('nextloom-ai-admin')], async (p) => {
      await step.wait()
      return resolvedFilter(p.project!, ['bug']) as ProjectFilter
    })

    expect(result.askable.map((f) => f.project)).toEqual(['lingtai', 'nextloom-ai-admin'])
  })

  it('still reduce in the order the projects were given, whichever answers first', async () => {
    const slow = new Map([['lingtai', 20]])
    const kinds = { lingtai: ['bug'], 'nextloom-ai-admin': ['feature', 'bug'] }
    const result = await queueFilters([project('lingtai'), project('nextloom-ai-admin')], async (p) => {
      await new Promise((r) => setTimeout(r, slow.get(p.project!) ?? 0))
      return filterOf(kinds)(p)
    })

    // First mention wins, and the first mention is the first *project* — the
    // rule the old loop got from being a loop, and the one concurrency is most
    // likely to take away.
    expect(result.kindOrder).toEqual(['bug', 'feature'])
    expect(result.limits.map((l) => l.project)).toEqual(['lingtai', 'nextloom-ai-admin'])
  })

  it('name a recipe that will not read, before GitHub is asked', async () => {
    const result = await queueFilters([project('lingtai')], async (p) => ({
      project: p.project!,
      ok: false,
      problem: 'recipe.yml: missing',
    }))

    expect(result.problems).toEqual([{ project: 'lingtai', reason: 'recipe.yml: missing' }])
    expect(result.askable).toEqual([])
  })
})

describe('what GitHub offers', () => {
  const lingtai = resolvedFilter('lingtai', ['bug'])
  const other = resolvedFilter('nextloom-ai-admin', ['bug'])

  it('is asked of all the projects at once', async () => {
    const step = barrier(2)
    const result = await githubQueue([lingtai, other], new Set(), async (f) => {
      await step.wait()
      return listed(f, ['1'])
    })

    expect(result.cards.map((c) => c.project)).toEqual(['lingtai', 'nextloom-ai-admin'])
    expect(result).toMatchObject({ asked: 2, answered: 2 })
  })

  it('counts what selectRunnable returned, before the log takes its cards out (#1015)', async () => {
    const result = await githubQueue([lingtai, other], new Set(['ticket-lingtai-1']), async (f) =>
      listed(f, ['1', '2']),
    )

    expect(result.runnable).toBe(4)
  })

  it('has no count rather than 0 when a project did not answer and nothing else was runnable (#1015)', async () => {
    const down = async () => {
      throw new Error('no answer')
    }
    expect((await githubQueue([lingtai], new Set(), down)).runnable).toBeNull()
    const mixed = await githubQueue([lingtai, other], new Set(), async (f) => {
      if (f.project === 'lingtai') throw new Error('no answer')
      return listed(f, ['1'])
    })
    expect(mixed.runnable).toBe(1)
  })

  it('does not add a task the log already has a card for a second time', async () => {
    const result = await githubQueue([lingtai], new Set(['ticket-lingtai-1']), async (f) => listed(f, ['1', '2']))

    expect(result.cards.map((c) => c.taskId)).toEqual(['ticket-lingtai-2'])
  })

  /**
   * #131, on the surface the operator watches. A ticket held by an open blocker
   * is not a card, so without this it is simply absent from Queued; and a
   * repository whose GitHub reports no dependencies shows an order nobody
   * checked against a chain. Both are listed, so neither is a problem — they
   * are notes, in `lingtai status`'s own words.
   */
  it('say what they passed over, and which issues were not checked for a blocker', async () => {
    const result = await githubQueue(
      [lingtai],
      new Set(),
      async (f) =>
        ({
          ...listed(f, ['121']),
          offered: {
            runnable: [],
            skipped: [
              {
                ref: 123,
                reason: 'blocked-by',
                label: null,
                title: 't',
                kind: null,
                blockedBy: null,
                parent: null,
                subIssues: null,
              },
              {
                ref: 9,
                reason: 'excluded-label',
                label: 'agent:hold',
                title: 't',
                kind: null,
                blockedBy: null,
                parent: null,
                subIssues: null,
              },
              {
                ref: 10,
                reason: 'epic',
                label: null,
                title: 'e',
                kind: 'feature',
                blockedBy: null,
                parent: null,
                subIssues: { total: 7, completed: 3 },
              },
              {
                ref: 11,
                reason: 'no-kind',
                label: null,
                title: 't',
                kind: null,
                blockedBy: null,
                parent: null,
                subIssues: null,
              },
            ],
            kindColors: {},
            dependenciesUnread: DEPENDENCIES_UNREAD,
          },
        }) as ProjectQueue,
    )

    expect(result.problems).toEqual([])
    expect(result.held).toEqual([
      { project: 'lingtai', ref: 9, title: 't', kind: null, kindColor: null, label: 'agent:hold' },
    ])
    expect(result.epics).toEqual([
      { project: 'lingtai', ref: 10, title: 'e', kind: 'feature', kindColor: null, closed: 3, total: 7 },
    ])
    expect(result.notes).toEqual([
      { project: 'lingtai', reason: '1 passed over — no-kind 1' },
      { project: 'lingtai', reason: DEPENDENCIES_UNREAD },
    ])
  })

  it('name a project GitHub would not answer for, and keep the others', async () => {
    const result = await githubQueue([lingtai, other], new Set(), async (f) =>
      f.project === 'lingtai'
        ? { state: 'unanswered', filter: f, problem: 'API rate limit exceeded' }
        : listed(f, ['5']),
    )

    expect(result.problems).toEqual([{ project: 'lingtai', reason: 'API rate limit exceeded' }])
    expect(result.cards.map((c) => c.taskId)).toEqual(['ticket-nextloom-ai-admin-5'])
    expect(result).toMatchObject({ asked: 2, answered: 1 })
  })

  it('never rejects, even when the asking throws', async () => {
    const result = await githubQueue([lingtai], new Set(), async () => {
      throw new Error('boom')
    })

    expect(result.problems).toEqual([{ project: 'lingtai', reason: 'boom' }])
    expect(result).toMatchObject({ asked: 1, answered: 0 })
  })

  it('is not waited for by the recipes: a queue that never answers leaves them resolved', async () => {
    const pending = githubQueue([lingtai], new Set(), () => new Promise<ProjectQueue>(() => {}))
    const recipes = await queueFilters([project('lingtai')], async () => lingtai as ProjectFilter)

    expect(recipes.askable.map((f) => f.project)).toEqual(['lingtai'])
    expect(await Promise.race([pending, Promise.resolve('still waiting')])).toBe('still waiting')
  })
})

describe('the colour a log card draws', () => {
  const lingtai = resolvedFilter('lingtai', ['bug'])

  it('is none before any queue answer, and the last one seen after', async () => {
    forgetKindColors()
    expect(lastKindColor('lingtai', 'bug')).toBeNull()

    await githubQueue([lingtai], new Set(), async (f) => listed(f, ['1'], { bug: 'd73a4a' }))

    expect(lastKindColor('lingtai', 'bug')).toBe('d73a4a')
    // By project: another repository's `bug` is not this one's colour.
    expect(lastKindColor('nextloom-ai-admin', 'bug')).toBeNull()
    forgetKindColors()
  })
})

describe('the skeletons the Queued column waits in', () => {
  it('are two before any answer, then what GitHub offered, capped at three', async () => {
    forgetSkeletonCounts()
    expect(skeletonCount(['lingtai'])).toBe(2)

    await githubQueue([resolvedFilter('lingtai', ['bug'])], new Set(), async (f) => listed(f, ['1'], {}))
    expect(skeletonCount(['lingtai'])).toBe(1)
    // A project that has not answered adds nothing; the ones that have are summed.
    expect(skeletonCount(['lingtai', 'other'])).toBe(1)
    expect(skeletonCount(['other'])).toBe(2)

    await githubQueue([resolvedFilter('lingtai', ['bug'])], new Set(), async (f) =>
      listed(f, ['1', '2', '3', '4', '5'], {}),
    )
    expect(skeletonCount(['lingtai'])).toBe(3)

    // Nothing offered: the label alone.
    await githubQueue([resolvedFilter('lingtai', ['bug'])], new Set(), async (f) => listed(f, [], {}))
    expect(skeletonCount(['lingtai'])).toBe(0)
    forgetSkeletonCounts()
  })
})

describe('the skeletons each column waits in on a switch (#1038)', () => {
  const col = (id: string, n: number) => ({ id, cards: Array.from({ length: n }, () => ({})) })

  it('are the last count capped, zero as the label alone, two when never seen, and per scope', () => {
    forgetSkeletonCounts()
    expect(columnSkeletonCount('lingtai', 'running')).toBe(2)
    recordColumnCounts('lingtai', [col('running', 5), col('waiting', 0), col('landed', 7)])
    expect(columnSkeletonCount('lingtai', 'running')).toBe(3)
    expect(columnSkeletonCount('lingtai', 'waiting')).toBe(0)
    expect(columnSkeletonCount('lingtai', 'landed')).toBe(3)
    expect(columnSkeletonCount('other', 'running')).toBe(2)
    expect(columnSkeletonCount(undefined, 'running')).toBe(2)
    forgetSkeletonCounts()
  })

  it('size Queued for the log and GitHub together', async () => {
    forgetSkeletonCounts()
    expect(queuedSkeletonCount('lingtai')).toBe(2)
    recordColumnCounts('lingtai', [col('queued', 1)])
    expect(queuedSkeletonCount('lingtai')).toBe(1)
    await githubQueue([resolvedFilter('lingtai', ['bug'])], new Set(), async (f) => listed(f, ['1'], {}))
    recordQueuedOffered('lingtai', [resolvedFilter('lingtai', ['bug'])])
    expect(queuedSkeletonCount('lingtai')).toBe(2)
    await githubQueue([resolvedFilter('lingtai', ['bug'])], new Set(), async (f) => listed(f, ['1', '2', '3', '4'], {}))
    recordQueuedOffered('lingtai', [resolvedFilter('lingtai', ['bug'])])
    expect(queuedSkeletonCount('lingtai')).toBe(3)
    forgetSkeletonCounts()
  })

  it('keeps all projects independent of the named projects', async () => {
    forgetSkeletonCounts()
    const f = resolvedFilter('lingtai', ['bug'])
    await githubQueue([f], new Set(), async (x) => listed(x, ['1', '2', '3', '4', '5'], {}))
    recordQueuedOffered('lingtai', [f])
    expect(queuedSkeletonCount('lingtai')).toBe(3)
    expect(queuedSkeletonCount(undefined)).toBe(2)
    forgetSkeletonCounts()
  })
})
