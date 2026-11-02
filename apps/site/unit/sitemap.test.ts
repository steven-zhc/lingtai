import { describe, expect, it } from 'vitest'

import { sitemapPages } from '@/app/sitemap'
import { DOCS_PUBLIC, isPublicSlug, PUBLIC_SLUGS, servable, slugOf } from '@/lib/docs'

const paths = (files: string[], docsPublic: boolean) => sitemapPages(files, docsPublic).map((p) => p.path)

describe('the sitemap', () => {
  it('names the front page and every servable doc, each once, with the trailing slash the host serves', async () => {
    const files = await servable()
    const got = paths(files, DOCS_PUBLIC)
    expect(got[0]).toBe('/')
    for (const file of files) expect(got).toContain(`/docs/${slugOf(file)}/`)
    expect(new Set(got).size).toBe(got.length)
    for (const p of got) expect(p.endsWith('/')).toBe(true)
  })

  it('names no doc page the export prunes while docs are private', async () => {
    if (DOCS_PUBLIC) return
    for (const p of paths(await servable(), false)) {
      if (p === '/') continue
      const slug = p.replace(/^\/docs\//, '').replace(/\/$/, '')
      expect(PUBLIC_SLUGS.some((s) => slug === s || slug.startsWith(`${s}/`))).toBe(true)
    }
  })

  it('offers /docs/ only when every doc is public', () => {
    expect(paths([], false)).not.toContain('/docs/')
    expect(paths([], true)).toContain('/docs/')
  })

  it('offers the events page under the condition the export keeps it by', () => {
    expect(paths([], true)).toContain('/docs/events/')
    expect(paths([], false).includes('/docs/events/')).toBe(isPublicSlug('events'))
  })

  it('dates a doc by its own file and the events page by the catalogue it is drawn from', () => {
    const pages = sitemapPages(['guide.md', 'plugins/index.md'], true)
    expect(pages.find((p) => p.path === '/docs/guide/')?.source).toBe('doc/guide.md')
    expect(pages.find((p) => p.path === '/docs/plugins/')?.source).toBe('doc/plugins/index.md')
    expect(pages.find((p) => p.path === '/docs/events/')?.source).toBe('doc/events.json')
    expect(pages.find((p) => p.path === '/docs/')?.source).toBeNull()
  })
})
