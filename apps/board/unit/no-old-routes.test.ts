import { readdirSync } from 'node:fs'

import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { config, proxy } from '../src/proxy.ts'

/** The old board addresses (#1501): none of them is a page, and none is answered with a redirect. */
const OLD = ['task/ticket-lingtai-1', 'pr/lingtai/1', 'recipe/lingtai'].map((p) => `/${p}`)
const APP = new URL('../src/app/', import.meta.url)

/** Does a URL path land on a `page.tsx` under `src/app`? `[param]` is a wildcard, `(group)` is transparent. */
function resolves(segments: readonly string[], dir: URL = APP): boolean {
  const entries = readdirSync(dir, { withFileTypes: true })
  if (segments.length === 0) {
    if (entries.some((e) => e.isFile() && e.name === 'page.tsx')) return true
    return entries.some((e) => e.isDirectory() && /^\(.+\)$/.test(e.name) && resolves([], new URL(`${e.name}/`, dir)))
  }
  const [head, ...tail] = segments
  return entries.some((e) => {
    if (!e.isDirectory()) return false
    const next = new URL(`${e.name}/`, dir)
    if (/^\(.+\)$/.test(e.name)) return resolves(segments, next)
    if (/^\[\.\.\.[^\]]+\]$/.test(e.name)) return resolves([], next)
    if (/^\[[^\]]+\]$/.test(e.name) || e.name === head) return resolves(tail, next)
    return false
  })
}

describe('an old board address is not a page (#1501)', () => {
  it('matches no page under src/app', () => {
    for (const url of OLD) expect(resolves(url.split('/').filter(Boolean)), url).toBe(false)
  })
  it('still finds the pages that remain', () => {
    expect(resolves(['p', 'lingtai', 'ticket', '1'])).toBe(true)
    expect(resolves([])).toBe(true)
  })
  it('is not in the proxy matcher: the proxy answers `/`, and refuses `/landed` and `/backlog` with a project', () => {
    expect(config.matcher).toEqual(['/', '/landed', '/backlog'])
  })
  it('is answered with no redirect', () => {
    for (const url of OLD) {
      const res = proxy(new NextRequest(new URL(url, 'http://board.test')))
      expect(res.headers.get('location'), url).toBeNull()
    }
  })
  it('is a 404 where the address is `/`, `/landed` or `/backlog` with a project parameter, a cookie or not', () => {
    for (const path of ['', 'landed', 'backlog']) {
      for (const cookie of [undefined, 'lingtai-project=other']) {
        const url = new URL(`/${path}?project=lingtai`, 'http://board.test')
        const res = proxy(new NextRequest(url, cookie ? { headers: { cookie } } : undefined))
        expect(res.status, `${url} ${cookie ?? ''}`).toBe(404)
        expect(res.headers.get('location')).toBeNull()
      }
    }
  })
  it('leaves a bare `/` and the global pages served', () => {
    for (const path of ['/landed', '/backlog', '/']) {
      expect(proxy(new NextRequest(new URL(path, 'http://board.test'))).status, path).toBe(200)
    }
  })
})
