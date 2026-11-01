import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Bar, DOCS_MENU } from '@/app/chrome'
import { HomePage } from '@/app/page'
import { Receipt } from '@/app/receipt'
import { dollars, receiptAt } from '@/app/replay-receipt'
import { parseBooks } from '@/lib/books'
import { DOCS_PUBLIC, PUBLIC_SLUGS } from '@/lib/docs'

import { BOOKS_FILE_FIXTURE } from './books-fixture'

/** The home page leads with a visitor's outcome and keeps its proof honest. */

/** The page, with the comments taken out: they are not what a reader reads. */
async function prose(): Promise<string> {
  const page = await readFile(path.resolve(import.meta.dirname, '../src/app/page.tsx'), 'utf8')
  return page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

/** The source with its line breaks and indentation folded to single spaces, so a sentence can be looked for whole. */
const flat = (s: string) => s.replace(/\s+/g, ' ')

/** Everything above the kicker that opens the books; the whole text when that kicker is absent. */
const above = (text: string) => {
  const i = text.indexOf('The work, in the open')
  return i < 0 ? text : text.slice(0, i)
}

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

  it('cuts the page at the books kicker when it is there, and nowhere when it is not', () => {
    expect(above('a log\nThe work, in the open\nb')).toBe('a log\n')
    expect(above('a log, no kicker')).toBe('a log, no kicker')
  })

  it('does not lead with internals or event-log claims', async () => {
    // The rendered page, not its source: the footer's words live in Foot, not in page.tsx.
    const rendered = renderToStaticMarkup(<HomePage books={null} />).replace(/<[^>]*>/g, ' ')
    for (const top of [above(await prose()), above(rendered)]) {
      expect(top).not.toMatch(/\blogs?\b/i)
      expect(top).not.toMatch(/\bevent-source|append-only|projection|Postgres sequence\b/i)
    }
    expect(rendered).toContain('keeps its state in a local SQLite file')
  })

  it('may say log only below the books kicker', () => {
    const books = parseBooks(structuredClone(BOOKS_FILE_FIXTURE))
    const withBooks = renderToStaticMarkup(<HomePage books={books} />).replace(/<[^>]*>/g, ' ')
    expect(withBooks).toContain('The work, in the open')
    expect(above(withBooks)).not.toMatch(/\blogs?\b/i)
    expect(withBooks).toMatch(/\blog\b/i)
  })

  it('explains the benefit, then how to start', async () => {
    const text = await prose()
    const order = [
      'Agents do the work',
      'The agent got it wrong. Twice.',
      'Why not just give the agent the issue?',
      'Three steps to your first receipt.',
    ]
    const at = order.map((heading) => ({ heading, at: text.indexOf(heading) }))
    const missing = at.filter((s) => s.at < 0).map((s) => s.heading)
    expect(missing, `the page is missing: ${missing.join(', ')}`).toEqual([])
    const positions = at.map((s) => s.at)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it("keeps page sections out of the board's generic setup class", async () => {
    const text = await prose()
    expect(text).not.toContain('<section className="setup"')
    expect(text).toContain('<section className="home-setup"')
  })

  it('renders one Docs menu with the nine public pages and no other doc link', () => {
    const bar = renderToStaticMarkup(<Bar />)
    expect(bar.match(/<details/g)).toHaveLength(1)
    expect(bar).toMatch(/<summary>Docs<\/summary>/)
    const menu = bar.slice(bar.indexOf('<details'), bar.indexOf('</details>'))
    const hrefs = [...menu.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
    expect(hrefs).toEqual(PUBLIC_SLUGS.map((s) => `/docs/${s}/`).sort((a, b) => hrefs.indexOf(a) - hrefs.indexOf(b)))
    expect(new Set(hrefs)).toEqual(new Set(PUBLIC_SLUGS.map((s) => `/docs/${s}/`)))
    expect(DOCS_MENU.map((d) => d.label)).toEqual([
      'Tutorial',
      'Concepts',
      'Requirements',
      'What an agent can touch',
      'Recipe',
      'CLI',
      'Plugins',
      'Events',
      'Coming from Symphony',
    ])
    const outside = bar.replace(menu, '')
    expect(outside).not.toMatch(/href="\/docs/)
  })

  it('keeps repository docs out of the public site except the public slugs', async () => {
    const home = await prose()
    expect(DOCS_PUBLIC).toBe(false)
    expect(PUBLIC_SLUGS).toEqual([
      'tutorial',
      'concepts',
      'recipe',
      'cli',
      'requirements',
      'safety',
      'from-symphony',
      'plugins',
      'events',
    ])
    const links = [...home.matchAll(/href="(\/docs?\/[^"]*)"/g)].map((m) => m[1])
    expect(links.every((l) => l === '/docs/tutorial/' || l === '/docs/requirements/' || l === '/docs/safety/')).toBe(
      true,
    )
    expect(home).toContain('href="#setup"')
  })

  it('answers the common questions under the ledger, honestly about ~/.ssh', () => {
    const html = renderToStaticMarkup(<HomePage books={null} />)
    const faq = html.slice(html.indexOf('class="faq"'))
    const block = faq.slice(0, faq.indexOf('</section>'))
    expect(block.match(/<details/g)).toHaveLength(6)
    for (const q of [
      'Will it break main?',
      'Will it run up a bill?',
      'Will it loop forever?',
      'What if my laptop restarts at 3am?',
      'Can it weaken its own checks?',
    ]) {
      expect(block).toContain(q)
    }
    const honest = block.slice(block.indexOf('faq-item honest'))
    expect(honest).toContain('~/.ssh')
    expect(honest).toContain('HONEST ANSWER')
    expect(honest).toContain('href="/docs/safety/"')
    expect(honest.indexOf('By default, yes')).toBeLessThan(honest.indexOf('not a container'))
    expect(html).not.toMatch(/\bguarded\b/i)
  })

  it('no longer says what stopped being true', async () => {
    const text = flat(await prose())
    expect(text).not.toContain('work on them one at a time')
    expect(text).not.toContain('0.9.0 is the first release')
    expect(text).not.toContain('nothing enforces yet')
    expect(text).not.toContain('creates the GitHub App')
    expect(text).not.toContain('touch the same file')
    expect(text).not.toMatch(/\b0\.11\b/)
  })

  it('says the slogan in the title and the description, and not "one at a time"', async () => {
    const layout = flat(await readFile(path.resolve(import.meta.dirname, '../src/app/layout.tsx'), 'utf8'))
    expect(layout).toContain("default: 'Lingtai — agents do the work, Lingtai keeps the books'")
    expect(layout).toContain(
      'Lingtai hands your tickets to Claude Code or Codex, runs your checks and a cold review, and ends every ticket in a receipt you can check',
    )
    expect(layout).not.toContain('one at a time')
  })
})

describe('why not just give the agent the issue', () => {
  const text = (html: string) =>
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
  const html = renderToStaticMarkup(<HomePage books={null} />)
  const rows = [...html.matchAll(/<tr><th scope="row">(.*?)<\/th><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td><\/tr>/g)].map(
    (m) => ({ key: text(m[1]!), alone: text(m[2]!), lingtai: text(m[3]!) }),
  )

  it.each([
    ['Completion', 'Your recipe: checks, review, your approval'],
    ['Checks', "Separate steps the agent can't skip"],
    ['Rules', 'Outside its worktree'],
    ['Recovery', 'Persisted; a restart picks it up'],
    ['Cost', 'Per ticket, with a daily ceiling'],
    ['Audit', 'Structured events and a receipt'],
  ])('says of %s, with Lingtai: %s', (key, claim) => {
    expect(rows.find((r) => r.key === key)?.lingtai).toBe(claim)
  })

  it('keeps the agent-alone column fair', () => {
    expect(rows).toHaveLength(6)
    const page = text(html)
    for (const unfair of ['The session is gone', 'Found out later', 'A transcript, maybe', 'Logs and transcripts']) {
      expect(page).not.toContain(unfair)
    }
  })

  it('links to the replay receipt, as a real table', () => {
    expect(html).toContain('id="replay"')
    expect(html).toMatch(/<a class="why-ref" href="#replay"/)
    expect(html).toContain('<table')
    expect(html.match(/scope="col"/g)).toHaveLength(2)
    expect(html.match(/scope="row"/g)).toHaveLength(6)
  })
})

describe('the replay receipt', () => {
  const steps = [0, 1, 2, 3, 4, 5, 6].map(receiptAt)

  it('renders a landed and a closed receipt from props', () => {
    const base = {
      issue: 'ISSUE #2 · X',
      title: 'T',
      rows: [{ key: 'Checks', value: '✗ → ✓ after 1 round' }],
      costLabel: 'COST',
      cost: '$1.00',
    }
    const landed = renderToStaticMarkup(
      <Receipt {...base} status={{ kind: 'landed', text: 'Landed' }} stamp={{ text: 'LANDED', shown: true }} />,
    )
    expect(landed).toContain('r-status landed')
    expect(landed).toContain('r-stamp on')
    expect(landed).toContain('<span class="no">✗</span>')
    const closed = renderToStaticMarkup(
      <Receipt {...base} status={{ kind: 'closed', text: 'Closed' }} stamp={{ text: 'NOT LANDED', shown: true }} />,
    )
    expect(closed).toContain('r-status closed')
    expect(closed).toContain('r-stamp closed on')
    expect(closed).not.toContain('rcpt landed')
  })

  it('is stamped only at step 6, and the cost never decreases', () => {
    expect(steps.map((s) => s.stamped)).toEqual([false, false, false, false, false, false, true])
    const cents = steps.map((s) => s.cents)
    expect(cents).toEqual([...cents].sort((a, b) => a - b))
    expect(dollars(cents[6]!)).toBe('$0.40')
  })

  it('has every row empty at 0 and clamps outside 0-6', () => {
    const s = receiptAt(0)
    expect([s.impl, s.checks, s.review, s.approve]).toEqual(['—', '—', '—', '—'])
    expect(s.status).toBe('Queued')
    expect(receiptAt(99)).toBe(receiptAt(6))
    expect(receiptAt(-1)).toBe(receiptAt(0))
  })

  it('never says log in any state', () => {
    expect(JSON.stringify(steps)).not.toMatch(/\blogs?\b/i)
  })

  it('renders the page beside one receipt in state 0, after the hero', () => {
    const html = renderToStaticMarkup(<HomePage books={null} />)
    expect(html.match(/class="rcpt/g)).toHaveLength(1)
    expect(html).toContain('>Queued<')
    expect(html).toContain('$0.00')
    expect(html).not.toContain('rcpt live landed')
    expect(html).not.toMatch(/r-row [^"]*now/)
    expect(html).not.toContain('r-stamp on')
    expect(html).toMatch(/class="r-stamp"[^>]*aria-hidden="true"/)
    expect(html).toContain('href="#replay"')
    expect(html).toContain('id="replay"')
    expect(html.indexOf('id="replay"')).toBeGreaterThan(html.indexOf('id="hero-title"'))
  })

  it('puts the replay heading after the hero in the page source', async () => {
    const text = await prose()
    expect(text.indexOf('The agent got it wrong. Twice.')).toBeGreaterThan(text.indexOf('Agents do the work'))
    expect(text.indexOf('The agent got it wrong. Twice.')).toBeLessThan(
      text.indexOf('Three steps to your first receipt.'),
    )
  })
})
