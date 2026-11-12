import { readFileSync } from 'node:fs'

import { isValidElement, type ReactNode, Suspense } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prerender } from 'react-dom/static'
/**
 * `/` draws its frame at once and streams each part that reads the log into a
 * boundary keyed by the project (#1037). Every read is pending here, so what
 * renders is the shell and every fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadBoard = vi.hoisted(() => vi.fn<(project?: string) => Promise<unknown>>(() => new Promise<never>(() => {})))
const never = vi.hoisted(() => () => new Promise<never>(() => {}))
const reads = vi.hoisted(() => ({
  registered: vi.fn(),
  control: vi.fn(),
  locks: vi.fn(),
  day: vi.fn(),
  lag: vi.fn(),
}))

vi.mock('../src/lib/board.ts', async (orig) => ({ ...(await orig<object>()), loadBoard }))
vi.mock('../src/lib/locks.ts', async (orig) => ({
  ...(await orig<object>()),
  readRegistered: reads.registered,
  readControlOnce: reads.control,
  readProjectLocks: reads.locks,
}))
vi.mock('../src/lib/day-spend.ts', async (orig) => ({ ...(await orig<object>()), readDayReading: reads.day }))
vi.mock('@lingtai/projector', async (orig) => ({ ...(await orig<object>()), projectionLag: reads.lag }))
vi.mock('../src/app/draining.tsx', () => ({ Draining: () => null }))
vi.mock('@lingtai/env', async (orig) => ({
  ...(await orig<object>()),
  storeChoice: () => ({}),
  hasGitHubAuth: () => false,
  stateDir: () => '/nonexistent/lingtai-trial/a',
  shownHome: () => '~/lingtai-trial/a',
}))
vi.mock('../src/app/live.tsx', () => ({ Live: () => <span className="live" /> }))

import { Health } from '../src/app/health.tsx'
import { Live } from '../src/app/live.tsx'
import Page from '../src/app/page.tsx'
import { COLUMNS } from '../src/lib/board.ts'

const render = async (project?: string) => (await Page({ searchParams: Promise.resolve({ project }) })) as ReactNode

/** Every element in a tree, with the elements it sits under. */
function walk(node: ReactNode, under: unknown[], visit: (el: ReturnType<typeof asElement>, under: unknown[]) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, under, visit))
  if (!isValidElement(node)) return
  visit(node as never, under)
  const props = node.props as Record<string, ReactNode>
  for (const v of Object.values(props)) walk(v, [...under, node], visit)
}
const asElement = (e: unknown) => e as { type: unknown; key: string | null; props: Record<string, unknown> }

const suspenseKeys = (tree: ReactNode): (string | null)[] => {
  const keys: (string | null)[] = []
  walk(tree, [], (el) => {
    if (el.type === Suspense) keys.push(el.key)
  })
  return keys
}

/** Every read pending, the state of a switch that has just been clicked. */
const allPending = () => {
  loadBoard.mockReset().mockImplementation(never)
  for (const r of Object.values(reads)) r.mockReset().mockImplementation(never)
}

/** Every read answers, and the board's answer is the project's own: it names `<project>-sibling`. */
const allAnswer = () => {
  loadBoard.mockReset().mockImplementation(async (project?: string) => ({
    columns: COLUMNS.map((c) => ({ id: c.id, label: c.label, cards: [] })),
    projects: [project ?? 'none', `${project ?? 'none'}-sibling`],
    pending: [],
    askable: [],
    known: [],
    queueOrder: [],
    ticketSources: new Map(),
  }))
  reads.registered.mockReset().mockResolvedValue([])
  reads.control.mockReset().mockResolvedValue({ paused: false })
  reads.locks.mockReset().mockResolvedValue({ ok: true, held: [] })
  reads.day.mockReset().mockResolvedValue({ text: '', day: null, figure: null, ceilingUsd: undefined })
  reads.lag.mockReset().mockResolvedValue([])
}

/** The page as it ends: every boundary whose read answered is drawn, and GitHub's (never) stays its fallback. */
const settled = async (project?: string) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 150)
  const { prelude } = await prerender((await render(project)) as never, { signal: ac.signal })
  clearTimeout(timer)
  return new Response(prelude).text()
}

beforeEach(() => {
  allPending()
})

describe('the shell, with every read pending', () => {
  it('names the chosen project and draws the four columns before any read returns', async () => {
    const html = renderToStaticMarkup(await render('lingtai'))
    expect(html).toContain('lingtai <span aria-hidden="true">▾</span>')
    expect(html.match(/<section[^>]*class="col/g)).toHaveLength(4)
    for (const label of ['Queued', 'Running', 'Waiting on you', 'Landed'])
      expect(html).toContain(`<span>${label}</span>`)
    expect(html).toContain('class="brand"')
    expect(html).toContain('/report?project=lingtai')
  })

  it('does not name `all projects` first on a URL without a project (#993)', async () => {
    const html = renderToStaticMarkup(await render())
    expect(html).not.toContain('all projects')
    expect(html).toContain('class="filter"')
  })

  it('draws every fallback as loading: a pulse, never $0, nothing paused or a tone', async () => {
    const html = renderToStaticMarkup(await render('lingtai'))
    expect(html).toContain('ct-pulse')
    expect(html).toContain('class="skeleton"')
    expect(html).toContain('sk-card')
    expect(html).not.toContain('$0')
    expect(html).not.toMatch(/class="dot (ok|current|green)/)
    expect(html).not.toContain('waiting on you')
    // the footer is the frame with the pulse in each figure
    expect(html).toMatch(
      /<footer class="footer"><span class="spend"><span>Today<\/span><span class="figures"><span class="ct-pulse"/,
    )
    // the rail's paused slot is the pulse and not an absence
    expect(html).toMatch(/<span class="rail"><span class="live"><\/span><span class="ct-pulse"/)
  })

  it('calls loadBoard once per render', async () => {
    renderToStaticMarkup(await render('lingtai'))
    expect(loadBoard).toHaveBeenCalledTimes(1)
  })
})

describe('the boundaries', () => {
  it('are all keyed, and every key contains the project', async () => {
    const keys = suspenseKeys(await render('lingtai'))
    expect(keys.length).toBeGreaterThan(8)
    for (const k of keys) expect(k).toMatch(/:lingtai$/)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keep their keys across two renders of the same project, so a live refresh shows no fallback', async () => {
    expect(suspenseKeys(await render('lingtai'))).toEqual(suspenseKeys(await render('lingtai')))
  })

  it('share no key between two projects, so a switch remounts every one', async () => {
    const [b, c] = [suspenseKeys(await render('b')), suspenseKeys(await render('c'))]
    expect(b.filter((k) => c.includes(k))).toEqual([])
    const [all, one] = [suspenseKeys(await render()), suspenseKeys(await render('b'))]
    expect(all.filter((k) => one.includes(k))).toEqual([])
  })

  it("end with only the last project's data on the page after A → B → C", async () => {
    allAnswer()
    const [b, c] = [await settled('b'), await settled('c')]
    expect(b).toContain('b-sibling')
    expect(b).not.toContain('c-sibling')
    expect(c).toContain('c-sibling')
    expect(c).not.toContain('b-sibling')
    expect(loadBoard.mock.calls.map(([project]) => project)).toEqual(['b', 'c'])
  })

  it('draw a part as soon as the reads it needs answer, whatever else is still pending', async () => {
    allAnswer()
    reads.day.mockImplementation(never)
    reads.lag.mockImplementation(never)
    const html = await settled('b')
    // the board, the register, the control and the locks answered: the counts, the cards and the paused slot are drawn
    expect(html).toContain('<span class="ct">0</span>')
    // a drawn empty line is `class="empty"` or `empty held`; a skeleton is `class="skeleton"`
    expect(html.match(/class="empty( held)?"/g)).toHaveLength(4)
    expect(html).not.toContain('class="skeleton"')
    expect(html).not.toContain('sk-card')
    expect(html).not.toContain('sk-line')
    // Queued waits for the board and GitHub, not the day's spend: its empty line is drawn too, so all four columns count
    expect(html).not.toMatch(/<span class="rail"><span class="live"><\/span><span class="ct-pulse"/)
    // the day's spend and the lags did not answer: the footer is still its frame, never \$0
    expect(html).toMatch(
      /<footer class="footer"><span class="spend"><span>Today<\/span><span class="figures"><span class="ct-pulse"/,
    )
    expect(html).not.toContain('$0')
  })

  it('draw the footer without the locks', async () => {
    allAnswer()
    reads.locks.mockImplementation(never)
    const html = await settled('b')
    expect(html).toContain('class="home-at')
    // the cards need the locks, so they are still skeletons
    expect(html).toContain('class="skeleton"')
    expect(html).toContain('sk-card')
    expect(html).not.toMatch(
      /<footer class="footer"><span class="spend"><span>Today<\/span><span class="figures"><span class="ct-pulse"/,
    )
  })

  it('draw the `+` and the summary in the shell with every read pending, on a URL without a project too', async () => {
    for (const project of [undefined, 'b']) {
      const html = renderToStaticMarkup((await render(project)) as never)
      expect(html).toContain('class="addp"')
    }
  })

  it('leave `Live` outside every one of them, and hand it the project and promises', async () => {
    let seen = 0
    walk(await render('lingtai'), [], (el, under) => {
      if (el.type !== Health) return
      seen++
      expect(under.filter((u) => asElement(u).type === Suspense)).toEqual([])
      // `Health` is a plain function: what it returns is `Live` itself, with no boundary between.
      const inner = (Health as unknown as (p: unknown) => ReactNode)(el.props) as ReturnType<typeof asElement>
      expect(inner.type).toBe(Live)
      expect(inner.props.projectKey).toBe('lingtai')
      expect(inner.props.near).toBeInstanceOf(Promise)
    })
    expect(seen).toBe(1)
  })

  it('subscribe in `Live` above every boundary it draws', () => {
    const src = readFileSync(new URL('../src/app/live.tsx', import.meta.url), 'utf8')
    const live = src.slice(src.indexOf('export function Live('))
    expect(live.indexOf('useFollow()')).toBeGreaterThan(-1)
    expect(live.indexOf('useFollow()')).toBeLessThan(live.indexOf('<Suspense'))
  })

  it('are keyed in page.tsx at every site', () => {
    const src = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8')
    const all = src.match(/<Suspense\b/g) ?? []
    const keyed = src.match(/<Suspense\s+key=\{(key\(|`[^`]*\$\{projectKey\})/g) ?? []
    expect(all.length).toBeGreaterThan(8)
    expect(keyed).toHaveLength(all.length)
  })
})
