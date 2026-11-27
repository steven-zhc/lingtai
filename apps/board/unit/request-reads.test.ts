/**
 * One request to `/p/<project>/pr` reads each stream once (#1420): `prj` and every PR stream, counted on a memory store
 * through what the page itself calls — `readRegistered`, `readProjectLocks`, `placeViewsOf`, `pauseSlot`, `loadPrBoard`.
 *
 * vitest has no `react-server` condition, so `cache` is a passthrough there; it is mocked per run of an
 * `AsyncLocalStorage`, one run being one request, as `task-loader-spans.test.ts` does.
 */
import { emptyControl, projectStream, prStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { sourceHashOf } from '@lingtai/recipe'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  // No machine's `config.yml`: a home that does not exist reads as nothing configured.
  process.env.LINGTAI_HOME = '/nonexistent/lingtai-home'
  return {
    renders: null as unknown as import('node:async_hooks').AsyncLocalStorage<Map<unknown, unknown>>,
    reads: [] as string[],
    heads: [] as string[],
    failing: new Set<string>(),
    inner: null as unknown as EventStore,
    recipe: '',
    spend: null as unknown as (...a: unknown[]) => unknown,
  }
})

vi.mock('react', async (orig) => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  h.renders = new AsyncLocalStorage()
  return {
    ...(await orig<object>()),
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
      return (...args: A): R => {
        const memo = h.renders.getStore()
        if (memo === undefined) return fn(...args)
        const key = JSON.stringify(args)
        const slot = memo.get(fn) as Map<string, R> | undefined
        const seen = slot ?? new Map<string, R>()
        memo.set(fn, seen)
        if (!seen.has(key)) seen.set(key, fn(...args))
        return seen.get(key)!
      }
    },
  }
})
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return {
    ...real,
    readFile: ((path: string, ...rest: unknown[]) =>
      String(path).endsWith('recipe.yml')
        ? Promise.resolve(h.recipe)
        : (real.readFile as (...a: unknown[]) => unknown)(path, ...rest)) as typeof real.readFile,
  }
})
vi.mock('@lingtai/event-store', async (orig) => {
  const counted: EventStore = {
    append: (...a) => h.inner.append(...a),
    appendAll: (...a) => h.inner.appendAll(...a),
    read: async (id, from) => {
      h.reads.push(id)
      if (h.failing.has(id)) throw new Error(`${id}: the store is gone`)
      return h.inner.read(id, from)
    },
    head: async (id) => {
      h.heads.push(id)
      if (h.failing.has(id)) throw new Error(`${id}: the store is gone`)
      return h.inner.head(id)
    },
    readTypes: (...a) => h.inner.readTypes(...a),
    readAll: (...a) => h.inner.readAll(...a),
  }
  return {
    ...(await orig<typeof import('@lingtai/event-store')>()),
    eventStore: counted,
    log: {
      store: counted,
      queries: { projectStreams: async () => [projectStream('p')] },
      snapshots: {},
      waker: () => ({}),
    },
  }
})
vi.mock('@lingtai/daemon', async (orig) => ({
  ...(await orig<typeof import('@lingtai/daemon')>()),
  conductorLockHolder: vi.fn(async () => null),
}))
vi.mock('@lingtai/daemon/control', async (orig) => ({
  ...(await orig<typeof import('@lingtai/daemon/control')>()),
  readControl: vi.fn(async () => emptyControl),
}))
vi.mock('@lingtai/projector', async (orig) => ({
  ...(await orig<typeof import('@lingtai/projector')>()),
  readSpendEffect: (...a: unknown[]) => h.spend(...a),
}))
vi.mock('../src/lib/snapshot-writer.ts', () => ({ boardWriterOrNone: vi.fn(async () => undefined) }))

import { recordPrNumber } from '@lingtai/project/test/pr-numbers'

import { pauseSlot } from '../src/app/lock-banner.tsx'
import { viewsFor } from '../src/app/place-line.tsx'
import { readProjectLocks, readRegistered } from '../src/lib/locks.ts'
import { loadPrBoard, placeViewsOf, readPrPage, spendByPr } from '../src/lib/prs.ts'

const RECIPE =
  'version: 2\nmode: team\nbranch: { main: main, personal: foundry }\nsource:\n  kinds: [bug]\n  assignee: { login: me }\nruntime:\n  agent: claude-code\nenv:\n  plantAt: .env.local\n'
const requested = { type: 'PrSubmitRequested', actor: 'human:x', data: { by: 'human:x' } } as const
const PRS = [1, 2, 3]

/** What the page calls, in the order it calls them, as one request. */
async function page(): Promise<void> {
  await readRegistered()
  await readProjectLocks()
  await placeViewsOf('p')
  await pauseSlot('p')
  await loadPrBoard('p')
}

const count = (ids: string[], id: string) => ids.filter((s) => s === id).length

beforeEach(async () => {
  h.spend = vi.fn(() => Effect.succeed([]))
  h.reads.length = 0
  h.heads.length = 0
  h.failing.clear()
  h.recipe = RECIPE
  h.inner = createMemoryEventStore()
  const store = h.inner
  await store.append(projectStream('p'), 0, [
    {
      type: 'ProjectConfigured',
      actor: 'conductor',
      data: { project: 'p', owner: 'o', base: 'main', configHash: 'h', fromSha: 's' },
    },
    // The file's text is on record, so rendering records nothing: `recordObservedRecipe` appends only on a change.
    {
      type: 'ProjectRecipeChanged',
      actor: 'conductor',
      data: { sourceHash: sourceHashOf(RECIPE), source: RECIPE, by: 'file' },
    },
  ])
  for (const n of PRS) await store.append(prStream('p', n), 0, [requested])
  await recordPrNumber(store, 'p', PRS.length)
})

describe('one request reads each stream once (#1420)', () => {
  it('reads prj once and each PR stream once through the page’s loaders', async () => {
    await h.renders.run(new Map(), page)
    expect(count(h.reads, projectStream('p'))).toBe(1)
    for (const n of PRS) expect(count(h.reads, prStream('p', n))).toBe(1)
    expect(count(h.heads, prStream('p', 1))).toBeLessThanOrEqual(1)
    // Nothing was recorded: the one `prj` read is not a retry after an append.
    expect((await h.inner.read(projectStream('p'))).map((e) => e.type)).not.toContain('ProjectRefused')
    // The configuration, the recipe's text and the recorded PR number: rendering appended nothing.
    expect(await h.inner.head(projectStream('p'))).toBe(3)
  })

  it('reads them all again in the next request: never across requests', async () => {
    await h.renders.run(new Map(), page)
    await h.renders.run(new Map(), page)
    expect(count(h.reads, projectStream('p'))).toBe(2)
    for (const n of PRS) expect(count(h.reads, prStream('p', n))).toBe(2)
  })

  it('shares a failed read in the request and never turns it into an empty value', async () => {
    h.failing.add(projectStream('p'))
    await h.renders.run(new Map(), async () => {
      const read = await readPrPage('p')
      expect(read.kind).toBe('failed')
      expect(await placeViewsOf('p')).toEqual(viewsFor('p', { waiting: null }))
      expect(count(h.reads, projectStream('p'))).toBe(1)
    })
  })
})

describe('a local team project records no owner (#1484)', () => {
  const local = async () => {
    await h.inner.append(projectStream('loc'), 0, [
      {
        type: 'ProjectConfigured',
        actor: 'conductor',
        data: { project: 'loc', owner: null, base: 'main', configHash: 'h', fromSha: 's' },
      },
      {
        type: 'ProjectRecipeChanged',
        actor: 'conductor',
        data: { sourceHash: sourceHashOf(RECIPE), source: RECIPE, by: 'file' },
      },
    ])
  }

  it('draws the board for a registered project with no owner', async () => {
    await local()
    await h.renders.run(new Map(), async () => {
      expect((await readPrPage('loc')).kind).toBe('team')
    })
  })

  it('offers PRs with its waiting count on the place line', async () => {
    await local()
    await h.renders.run(new Map(), async () => {
      const views = await placeViewsOf('loc')
      expect(views).toEqual(viewsFor('loc', { waiting: 0 }))
      expect(views).not.toEqual(viewsFor('loc'))
    })
  })

  it('still answers unknown for a project that is not registered', async () => {
    await h.renders.run(new Map(), async () => {
      expect((await readPrPage('nope')).kind).toBe('unknown')
    })
  })
})

describe('spendByPr reads the streams of the PRs it shows (#1510)', () => {
  const row = (n: number, costUsd: number | null) => ({ streamId: prStream('p', n), costUsd })

  it('reads nothing for no PRs', async () => {
    expect(await Effect.runPromise(spendByPr('p', []))).toEqual(new Map())
    expect(h.spend).not.toHaveBeenCalled()
  })

  it('asks by stream, sums reported cost, skips null and leaves a PR with no rows absent', async () => {
    h.spend = vi.fn(() => Effect.succeed([row(1, 0.5), row(1, 0.25), row(1, null), row(2, null)]))
    const got = await Effect.runPromise(spendByPr('p', [1, 2, 3]))
    expect(h.spend).toHaveBeenCalledTimes(1)
    expect(h.spend).toHaveBeenCalledWith({
      project: 'p',
      stream: [prStream('p', 1), prStream('p', 2), prStream('p', 3)],
    })
    expect(got).toEqual(new Map([[1, 0.75]]))
  })
})
