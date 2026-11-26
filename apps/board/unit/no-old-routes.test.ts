import { readdirSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { config, proxy } from '../src/proxy.ts'

/** The old board addresses (#1501): none of them is a page, and none is answered with a redirect. */
const OLD = ['/task/ticket-lingtai-1', '/pr/lingtai/1', '/recipe/lingtai']
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
  it('is not in the proxy matcher: the proxy answers `/` alone', () => {
    expect(config.matcher).toEqual(['/'])
  })
  it('is answered with no redirect, a project parameter on `/` included', () => {
    for (const url of [...OLD, '/?project=lingtai', '/landed?project=lingtai', '/backlog?project=lingtai']) {
      const res = proxy(new NextRequest(new URL(url, 'http://board.test')))
      expect(res.headers.get('location'), url).toBeNull()
    }
  })
})
