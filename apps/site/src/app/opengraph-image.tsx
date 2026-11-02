import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { ImageResponse } from 'next/og'

/**
 * The preview a link to the site unfurls into, rendered once at build into the
 * export (`out/opengraph-image.png`). At the root, so every page inherits it;
 * the words are the hero's, which are agreed copy and not this file's to change.
 */
export const dynamic = 'force-static'
export const alt = 'Lingtai — agents do the work, Lingtai keeps the books'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

// The light palette of site.css.
const GROUND = '#f1f4f4'
const INK = '#0f181c'
const INK_2 = '#3a4a50'
const ACCENT_INK = '#075056'

export default async function OpengraphImage() {
  const logo = await readFile(path.join(process.cwd(), 'public', 'logo.png'))
  const src = `data:image/png;base64,${logo.toString('base64')}`
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '72px 80px',
        background: GROUND,
        color: INK,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <img src={src} width={72} height={72} alt="" />
        <div style={{ fontSize: 40, fontWeight: 700 }}>Lingtai</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ fontSize: 24, letterSpacing: 4, color: ACCENT_INK }}>FOR CLAUDE CODE AND CODEX</div>
        <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2, maxWidth: 1000 }}>
          Agents do the work. Lingtai keeps the books.
        </div>
      </div>
      <div style={{ fontSize: 28, color: INK_2 }}>lingtai.hczhang.com</div>
    </div>,
    size,
  )
}
