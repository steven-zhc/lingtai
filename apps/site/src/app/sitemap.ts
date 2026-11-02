import type { MetadataRoute } from 'next'

import { DOCS_PUBLIC, servable, slugOf } from '@/lib/docs'

import { SITE_URL } from './chrome'

/**
 * Written into the export as `out/sitemap.xml`: every page the build makes and
 * nothing it prunes.
 *
 * The docs come from `servable()`, the same list `generateStaticParams` builds
 * from, so a page cannot be in the sitemap without existing or exist without
 * being in it. `/docs/` itself and `/docs/events/` are their own routes rather
 * than files under `doc/`, so they are named here. The trailing slash is
 * `trailingSlash: true`'s: it is the URL the host actually serves.
 */
export const dynamic = 'force-static'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docs = (await servable()).map((file) => `/docs/${slugOf(file)}/`)
  const paths = ['/', ...(DOCS_PUBLIC ? ['/docs/'] : []), ...docs, '/docs/events/']
  return [...new Set(paths)].map((p) => ({
    url: `${SITE_URL}${p}`,
    priority: p === '/' ? 1 : 0.7,
  }))
}
