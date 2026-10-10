import type { Metadata } from 'next'
import localFont from 'next/font/local'

import './globals.css'

/**
 * The typefaces the design asks for, self-hosted.
 *
 * The stylesheet named "IBM Plex Sans" from the start and nothing ever loaded
 * it, so every rule fell through to `system-ui` and the board looked like a
 * different design than the one it was written against.
 *
 * The Google-backed font loader fetched these from Google at dev and build
 * time, which failed to resolve under Turbopack (#437) and failed
 * `release.yml`'s build intermittently besides. The files live in `./fonts/`
 * instead, so there is nothing to fetch and nothing to fail on. `OFL.txt` has
 * to move with them — it is IBM's licence for the files, not boilerplate.
 */
const sans = localFont({
  src: [
    { path: './fonts/ibm-plex-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans',
  display: 'swap',
})

const mono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Lingtai',
  description: 'Event-sourced scheduler for autonomous code agents',
  /**
   * `public/logo.png` and `public/logo-dark.png` are copies of the two files in
   * `doc/` — a Next app serves its own `public/`, and reaching out of the app
   * for an asset is not something the build will do.
   *
   * Two entries because the mark is ink on a transparent ground: the near-black
   * one disappears in a dark tab strip and the light one disappears in a light
   * one. The dark-ground file is declared first so that the last entry — which
   * is what a browser that ignores `media` on an icon settles on — is the
   * dark-ink mark, right for the light tab strip that is the common case.
   */
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
