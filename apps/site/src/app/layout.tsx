import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'

/**
 * The product's stylesheet, imported and not copied.
 *
 * Every colour, every card, every lane on this site is the board's own — the
 * hero renders `.col`, `.card` and `.pill` because those *are* the board, not
 * because they were reproduced to look like it. A site that looks unlike the
 * product is a promise the product breaks, and a second stylesheet claiming to
 * hold the same palette is a second truth waiting to drift from the first.
 *
 * `site.css` comes after and adds only what a page has and a console does not:
 * a measure, a hero, and one coral thing.
 */
import '../../../board/src/app/globals.css'
import './site.css'
import './home.css'
import { SITE_URL } from './chrome'

/**
 * The two faces the product uses, via `next/font/google` — which still fetches
 * them from Google at build time. The board stopped doing that (#437, which
 * showed the resolver failing intermittently under Turbopack) and now loads
 * the same files from `next/font/local`; this app has not followed yet.
 *
 * No serif, including in the long documentation. It would read a little better
 * and it is the one move that would make this look like every other docs site.
 * Comfort comes from measure and leading; see `--measure` in `site.css`.
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
})

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Lingtai — agents do the work, Lingtai keeps the books',
    template: '%s — Lingtai',
  },
  description:
    'Lingtai hands your tickets to Claude Code or Codex, runs your checks and a cold review, and ends every ticket in a receipt you can check: what the agent was given, what it produced, what passed, who let it through, and what it cost.',
  openGraph: { type: 'website', siteName: 'Lingtai' },
  twitter: { card: 'summary_large_image' },
  icons: {
    icon: [
      { url: '/logo-dark.png', type: 'image/png', media: '(prefers-color-scheme: dark)' },
      { url: '/logo.png', type: 'image/png', media: '(prefers-color-scheme: light)' },
    ],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
