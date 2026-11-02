import { execFileSync } from 'node:child_process'

import type { MetadataRoute } from 'next'

import { DOCS_PUBLIC, isPublicSlug, repoRoot, servable, slugOf } from '@/lib/docs'

import { SITE_URL } from './chrome'

/**
 * Written into the export as `out/sitemap.xml`: every page the build makes and
 * nothing it prunes.
 *
 * The docs come from `servable()`, the same list `generateStaticParams` builds
 * from. `/docs/` itself and `/docs/events/` are their own routes rather than
 * files under `doc/`, so they are named here, each under the same condition
 * `prune-hidden-docs.ts` keeps it by — a page in the sitemap that the export
 * removed would be a 404 offered to a crawler. The trailing slash is
 * `trailingSlash: true`'s: it is the URL the host actually serves.
 */
export const dynamic = 'force-static'

export interface SitemapPage {
  path: string
  /** Relative to the repository, the file whose last commit dates the page; null for none. */
  source: string | null
}

/** Which pages the export holds, given the servable files and what is public. Pure, so a unit test can hold it. */
export function sitemapPages(files: readonly string[], docsPublic: boolean): SitemapPage[] {
  const pages: SitemapPage[] = [{ path: '/', source: 'apps/site/src/app/page.tsx' }]
  if (docsPublic) pages.push({ path: '/docs/', source: null })
  for (const file of files) pages.push({ path: `/docs/${slugOf(file)}/`, source: `doc/${file}` })
  if (docsPublic || isPublicSlug('events')) pages.push({ path: '/docs/events/', source: 'doc/events.json' })
  const seen = new Set<string>()
  return pages.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)))
}

/**
 * The last commit to touch a file, or null. Null rather than the build's own
 * date when git cannot say — a shallow clone, no git, a file never committed —
 * because a `lastmod` that is always today is one a crawler learns to ignore.
 */
function lastCommitted(file: string): Date | null {
  try {
    const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoRoot, encoding: 'utf8' })
    if (shallow.trim() === 'true') return null
    const at = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
    return at === '' ? null : new Date(at)
  } catch {
    return null
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapPages(await servable(), DOCS_PUBLIC).map(({ path, source }) => {
    const lastModified = source === null ? null : lastCommitted(source)
    return {
      url: `${SITE_URL}${path}`,
      ...(lastModified === null ? {} : { lastModified }),
      priority: path === '/' ? 1 : 0.7,
    }
  })
}
