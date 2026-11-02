import type { MetadataRoute } from 'next'

import { SITE_URL } from './chrome'

/**
 * Written into the export as `out/robots.txt`. Until there was one, a crawler
 * asking for it got Cloudflare's 404 and the site had no sitemap to offer, so
 * nothing told a search engine which pages exist — and nothing linked here
 * from outside but the README.
 */
export const dynamic = 'force-static'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
