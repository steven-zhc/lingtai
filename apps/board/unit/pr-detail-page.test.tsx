/**
 * `/pr/<project>/<n>` starts its detail load alongside the bar's reads, not after them (#1439). Each read is a deferred
 * promise the test settles, so what is asserted is what has started and what has settled — never a duration.
 */
import { isValidElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  registered: vi.fn(),
  locks: vi.fn(),
  onBoard: vi.fn(),
  load: vi.fn(),
  views: vi.fn(),
  pause: vi.fn(),
}))

vi.mock('../src/lib/locks.ts', async (orig) => ({
  ...(await orig<object>()),
  readRegistered: m.registered,
  readProjectLocks: m.locks,
}))
vi.mock('../src/lib/board.ts', async (orig) => ({ ...(await orig<object>()), onBoardProjects: m.onBoard }))
vi.mock('../src/lib/prs.ts', async (orig) => ({
  ...(await orig<object>()),
  loadPrDetail: m.load,
  placeViewsOf: m.views,
}))
vi.mock('../src/app/lock-banner.tsx', async (orig) => ({
  ...(await orig<object>()),
  LockBanner: () => null,
  pauseSlot: m.pause,
}))
vi.mock('@lingtai/env', async (orig) => ({ ...(await orig<object>()), hasGitHubAuth: () => false }))

import Page from '../src/app/p/[project]/pr/[n]/page.tsx'

type El = { type: (props: unknown) => Promise<unknown>; props: Record<string, unknown> }

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function walk(node: ReactNode, visit: (el: El) => void) {
  if (Array.isArray(node)) return node.forEach((c) => walk(c, visit))
  if (!isValidElement(node)) return
  visit(node as never)
  for (const v of Object.values(node.props as Record<string, ReactNode>)) walk(v, visit)
}

const detailOf = (tree: unknown): El => {
  let found: El | undefined
  walk(tree as ReactNode, (el) => {
    if (found === undefined && 'load' in el.props && 'project' in el.props) found = el
  })
  if (found === undefined) throw new Error('no Detail element in the tree')
  return found
}

const textOf = (tree: unknown): string => {
  const out: string[] = []
  walk(tree as ReactNode, (el) => {
    const c = el.props.children
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) out.push(c.filter((x) => typeof x === 'string').join(''))
  })
  return out.join('|')
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const page = (n: string) => Page({ params: Promise.resolve({ project: 'p', n }) })

/** Every bar read pending, each on a deferred of its own. */
function pendingBar() {
  const d = {
    registered: deferred<unknown[]>(),
    onBoard: deferred<string[]>(),
    locks: deferred<unknown>(),
    views: deferred<unknown>(),
    pause: deferred<unknown>(),
  }
  m.registered.mockReset().mockReturnValue(d.registered.promise)
  m.onBoard.mockReset().mockReturnValue(d.onBoard.promise)
  m.locks.mockReset().mockReturnValue(d.locks.promise)
  m.views.mockReset().mockReturnValue(d.views.promise)
  m.pause.mockReset().mockReturnValue(d.pause.promise)
  return {
    ...d,
    answer() {
      d.registered.resolve([])
      d.onBoard.resolve([])
      d.locks.resolve({ ok: true, held: [] })
      d.views.resolve(null)
      d.pause.resolve(null)
    },
  }
}

beforeEach(() => {
  m.load.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the detail load starts with the bar', () => {
  it.each([
    ['7', 7],
    ['next', 'next'],
  ])('starts the load for %s while every bar read is pending, and hands Detail that promise', async (raw, n) => {
    const bar = pendingBar()
    const load = deferred<unknown>()
    m.load.mockReturnValue(load.promise)
    const result = page(raw)
    await flush()
    expect(m.load).toHaveBeenCalledTimes(1)
    expect(m.load).toHaveBeenCalledWith('p', n)
    for (const r of [m.registered, m.onBoard, m.locks, m.views, m.pause]) expect(r).toHaveBeenCalled()
    bar.answer()
    const el = detailOf(await result)
    expect(el.props.load).toBe(load.promise)
    expect(m.load).toHaveBeenCalledTimes(1)
  })

  it.each(['0', '-1', 'abc', '07'])('starts no load for %s, and Detail says so', async (raw) => {
    const bar = pendingBar()
    const result = page(raw)
    await flush()
    bar.answer()
    const el = detailOf(await result)
    expect(m.load).not.toHaveBeenCalled()
    expect(el.props.load).toBeNull()
    expect(textOf(await el.type(el.props))).toContain('There is no PR numbered like that.')
  })
})

describe('a body that rejects before the bar answers', () => {
  it.each([
    ['a slow bar', false],
    ['a bar that answers', true],
  ])('is not unhandled and still reaches Detail, with %s', async (_label, answers) => {
    const spy = vi.fn()
    process.on('unhandledRejection', spy)
    try {
      const bar = pendingBar()
      const boom = new Error('the detail read broke')
      m.load.mockReturnValue(Promise.reject(boom))
      const result = page('7')
      if (answers) bar.answer()
      await new Promise((r) => setImmediate(r))
      expect(spy).not.toHaveBeenCalled()
      bar.answer() // the page is only returned once the bar has answered
      const el = detailOf(await result)
      await expect(el.type(el.props)).rejects.toBe(boom)
      await new Promise((r) => setImmediate(r))
      expect(spy).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', spy)
    }
  })
})

describe('the listing error', () => {
  const run = async (registered: unknown, onBoard: unknown) => {
    const bar = pendingBar()
    m.load.mockReturnValue(new Promise(() => {}))
    m.registered.mockReturnValue(registered)
    m.onBoard.mockReturnValue(onBoard)
    bar.locks.resolve({ ok: true, held: [] })
    bar.views.resolve(null)
    bar.pause.resolve(null)
    return textOf(await page('7'))
  }

  it('shows the registered listing’s message when both fail', async () => {
    const text = await run(Promise.reject(new Error('registered down')), Promise.reject(new Error('onboard down')))
    expect(text).toContain('registered down')
    expect(text).not.toContain('onboard down')
  })

  it('shows the onboard listing’s message when only it fails', async () => {
    const text = await run(Promise.resolve([]), Promise.reject(new Error('onboard down')))
    expect(text).toContain('onboard down')
  })
})
