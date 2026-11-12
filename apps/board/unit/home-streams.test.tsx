import { readFileSync } from 'node:fs'

import { isValidElement, type ReactNode, Suspense } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
/**
 * `/` draws its frame at once and streams each part that reads the log into a
 * boundary keyed by the project (#1037). Every read is pending here, so what
 * renders is the shell and every fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadBoard = vi.hoisted(() => vi.fn(() => new Promise<never>(() => {})))
const never = vi.hoisted(() => () => new Promise<never>(() => {}))

vi.mock('../src/lib/board.ts', async (orig) => ({ ...(await orig<object>()), loadBoard }))
vi.mock('../src/lib/locks.ts', async (orig) => ({
  ...(await orig<object>()),
  readRegistered: never,
  readControlOnce: never,
  readProjectLocks: never,
}))
vi.mock('@lingtai/env', async (orig) => ({
  ...(await orig<object>()),
  storeChoice: () => ({}),
  hasGitHubAuth: () => false,
  stateDir: () => '/nonexistent/lingtai-trial/a',
  shownHome: () => '~/lingtai-trial/a',
}))
vi.mock('../src/app/live.tsx', () => ({ Live: () => <span className="live" /> }))

import { Health } from '../src/app/health.tsx'
import Page from '../src/app/page.tsx'

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

beforeEach(() => {
  loadBoard.mockClear()
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
    expect(html).toContain('reading the log…')
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

  it('share no key between two projects, so a switch remounts every one and none of B stays under C', async () => {
    const [b, c] = [suspenseKeys(await render('b')), suspenseKeys(await render('c'))]
    expect(b.filter((k) => c.includes(k))).toEqual([])
    const [all, one] = [suspenseKeys(await render()), suspenseKeys(await render('b'))]
    expect(all.filter((k) => one.includes(k))).toEqual([])
  })

  it('leave `Live` outside every one of them, and hand it the project and promises', async () => {
    let seen = 0
    walk(await render('lingtai'), [], (el, under) => {
      if (el.type !== Health) return
      seen++
      expect(under.filter((u) => asElement(u).type === Suspense)).toEqual([])
      expect(el.props.projectKey).toBe('lingtai')
      expect(el.props.near).toBeInstanceOf(Promise)
    })
    expect(seen).toBe(1)
  })

  it('are keyed in page.tsx at every site', () => {
    const src = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8')
    const all = src.match(/<Suspense\b/g) ?? []
    const keyed = src.match(/<Suspense\s+key=\{(key\(|`[^`]*\$\{projectKey\})/g) ?? []
    expect(all.length).toBeGreaterThan(8)
    expect(keyed).toHaveLength(all.length)
  })
})
