import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BuildsItself } from '@/app/builds-itself'
import {
  EnvironmentMini,
  LandedMini,
  LanesMini,
  QueuedMini,
  SpendMini,
  StepsMini,
  WaitingMini,
  WORKTREE_LINES,
  WorktreeMini,
} from '@/app/home-minis'
import { DOCS_PUBLIC, PUBLIC_SLUGS } from '@/lib/docs'
import { landedCount, type Snapshot } from '@/lib/snapshot'

/** The home page leads with a visitor's outcome and keeps its proof honest. */

/** The page, with the comments taken out: they are not what a reader reads. */
async function prose(): Promise<string> {
  const page = await readFile(path.resolve(import.meta.dirname, '../src/app/page.tsx'), 'utf8')
  return page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

/** The source with its line breaks and indentation folded to single spaces, so a sentence can be looked for whole. */
const flat = (s: string) => s.replace(/\s+/g, ' ')

describe("the home page's argument", () => {
  it('uses the public home as the installer front door', async () => {
    const chrome = await readFile(path.resolve(import.meta.dirname, '../src/app/chrome.tsx'), 'utf8')
    expect(chrome).toMatch(/export const SITE_URL = ["']https:\/\/lingtai\.hczhang\.com["']/)
    expect(chrome).toContain('export const INSTALL_URL = `${SITE_URL}/install.sh`')
  })

  it('lays the two footer facts out as a responsive pair', async () => {
    const chrome = await readFile(path.resolve(import.meta.dirname, '../src/app/chrome.tsx'), 'utf8')
    const css = await readFile(path.resolve(import.meta.dirname, '../src/app/site.css'), 'utf8')
    expect(chrome).toContain('className="wrap foot-layout"')
    expect(chrome).not.toContain('style={{ marginTop: 14 }}')
    expect(css).toMatch(/\.foot-layout\s*{[^}]*display:\s*grid/s)
  })

  it('does not lead with internals or event-log claims', async () => {
    const text = await prose()
    const section = text.indexOf('The work, in the open')
    expect(section, 'the page has no evidence section').toBeGreaterThan(-1)
    const above = text.slice(0, section)
    expect(above).not.toMatch(/\blogs?\b/i)
    expect(above).not.toMatch(/\bevent-source|append-only|projection|Postgres sequence\b/i)
  })

  it('explains the benefit, use, proof, and limits in that order', async () => {
    const text = await prose()
    const order = [
      'Let your backlog move',
      'The loop, one stop at a time',
      'Beside the loop',
      'Six more things',
      'How you use it',
      'The work, in the open',
      'Know the edges',
    ]
    const at = order.map((heading) => ({ heading, at: text.indexOf(heading) }))
    const missing = at.filter((s) => s.at < 0).map((s) => s.heading)
    expect(missing, `the page is missing: ${missing.join(', ')}`).toEqual([])
    const positions = at.map((s) => s.at)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('marks the conceptual diagram as an illustration, not board data', async () => {
    const text = await prose()
    expect(text).toContain('role="img"')
    expect(text).toContain('ILLUSTRATION')
    expect(text).toContain('snapshot === null ? <NoSnapshot /> : <SnapshotBoard snapshot={snapshot} />')
  })

  it("keeps page sections out of the board's generic setup and evidence classes", async () => {
    const text = await prose()
    expect(text).not.toContain('<section className="setup"')
    expect(text).not.toContain('<section className="evidence"')
    expect(text).toContain('<section className="home-setup"')
    expect(text).toContain('<section className="home-evidence"')
  })

  it('keeps repository docs out of the public site except the tutorial, the concepts page, the recipe guide, the CLI guide, the requirements, the Symphony page, the plugin pages and the events', async () => {
    const [home, chrome] = await Promise.all([
      prose(),
      readFile(path.resolve(import.meta.dirname, '../src/app/chrome.tsx'), 'utf8'),
    ])
    expect(DOCS_PUBLIC).toBe(false)
    expect(PUBLIC_SLUGS).toEqual([
      'tutorial',
      'concepts',
      'recipe',
      'cli',
      'requirements',
      'from-symphony',
      'plugins',
      'events',
    ])
    const links = [...`${home}\n${chrome}`.matchAll(/href="(\/docs?\/[^"]*)"/g)].map((m) => m[1])
    expect(
      links.every(
        (l) =>
          l === '/docs/tutorial/' ||
          l === '/docs/concepts/' ||
          l === '/docs/plugins/' ||
          l === '/docs/events/' ||
          l === '/docs/requirements/',
      ),
    ).toBe(true)
    expect(chrome).toContain('href="/docs/tutorial/"')
    expect(chrome).toContain('href="/docs/concepts/"')
    expect(chrome).toContain('href="/docs/plugins/"')
    expect(home).toContain('href="#setup"')
  })

  it('no longer says what stopped being true', async () => {
    const text = flat(await prose())
    expect(text).not.toContain('work on them one at a time')
    expect(text).not.toContain('0.9.0 is the first release')
    expect(text).not.toContain('nothing enforces yet')
    expect(text).not.toContain('creates the GitHub App')
    expect(text).not.toContain('touch the same file')
    expect(text).toContain('On a GitHub project it will tell you to use')
    expect(text).not.toMatch(/\b0\.11\b/)
  })

  it('carries each sentence the 0.11 tickets made true', async () => {
    const text = flat(await prose())
    for (const sentence of [
      'One line per ticket from <code>lingtai start</code>: steps, cost, where it stopped, and the command when it waits',
      'buys none and holds as',
      'The issue closed, in a project <code>lingtai add</code> set up',
      'whether to wait for your approval or land without asking',
      'It ends on a summary of what it set up and what to do next',
      'Claude Code or Codex settings still applies',
      'Every release lists the tickets it landed and the decisions it changed',
      'OpenTelemetry trace when you give it a collector',
      'The run as it happens (<code>lingtai attach</code>)',
    ]) {
      expect(text, sentence).toContain(sentence)
    }
  })
})

describe('the landed figure', () => {
  const card = (n: number, cards: number): Snapshot =>
    ({
      lanes: [
        { id: 'queued', label: 'Queued', count: 9, cards: [] },
        { id: 'landed', label: 'Landed', count: n, cards: Array.from({ length: cards }, () => ({})) },
      ],
    }) as unknown as Snapshot

  it('is not rendered without a snapshot', () => {
    const html = renderToStaticMarkup(<BuildsItself landed={landedCount(null)} />)
    expect(html).toContain('Lingtai builds Lingtai')
    expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/[0-9]/)
    expect(html).not.toContain('landed or closed')
  })

  it("is the Landed lane's count, not the cards drawn", () => {
    const html = renderToStaticMarkup(<BuildsItself landed={landedCount(card(42, 2))} />)
    expect(html).toContain('42 landed or closed on its board')
  })

  it('is not rendered as zero', () => {
    const html = renderToStaticMarkup(<BuildsItself landed={landedCount(card(0, 0))} />)
    expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/[0-9]/)
  })
})

describe('the loop illustrations', () => {
  const html = renderToStaticMarkup(
    <>
      <QueuedMini />
      <WorktreeMini />
      <StepsMini />
      <WaitingMini />
      <LandedMini />
      <SpendMini />
      <LanesMini />
      <EnvironmentMini />
    </>,
  )

  it('are eight cards, each labelled an illustration for a reader and on its face', () => {
    expect(html.match(/role="img" aria-label="Illustration: /g)).toHaveLength(8)
    expect(html.match(/>ILLUSTRATION</g)).toHaveLength(8)
  })

  it("print the worktree's lines in the shape lingtai start prints them", () => {
    const [taking, landed, waiting] = WORKTREE_LINES
    expect(taking).toMatch(/^taking #\d+ {2}\S/)
    const ending = /^#\d+ {2}.+ — (\w+ [✓✗] )*\w+ [✓✗] · \$\d+\.\d{2} · /
    expect(landed).toMatch(ending)
    expect(landed).toMatch(/ · landed in [0-9a-f]{7}$/)
    expect(waiting).toMatch(ending)
    expect(waiting).toMatch(/ · waiting for you: lingtai \w+ \S+ --issue \d+$/)
  })

  it('claim nothing the page does not say of 0.11', async () => {
    const src = await readFile(path.resolve(import.meta.dirname, '../src/app/home-minis.tsx'), 'utf8')
    expect(src).not.toMatch(/\b0\.11\b/)
    expect(src).not.toMatch(/agent:hold/)
  })
})
