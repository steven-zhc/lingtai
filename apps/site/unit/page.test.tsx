import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Bar, DOCS_MENU } from '@/app/chrome'
import { HomePage } from '@/app/page'
import { Receipt } from '@/app/receipt'
import { dollars, receiptAt, STEPS } from '@/app/replay-receipt'
import { SHOTS } from '@/app/shots'
import { parseBooks } from '@/lib/books'
import { DOCS_PUBLIC, PUBLIC_SLUGS } from '@/lib/docs'

import { BOOKS_FILE_FIXTURE } from './books-fixture'

/** The home page leads with a visitor's outcome and keeps its proof honest. */

/** The page, with the comments taken out: they are not what a reader reads. */
async function prose(): Promise<string> {
  const page = await readFile(path.resolve(import.meta.dirname, '../src/app/page.tsx'), 'utf8')
  return page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

/** The source with its line breaks and indentation reduced to single spaces, so a sentence can be looked for whole. */
const flat = (s: string) => s.replace(/\s+/g, ' ')

/** Everything above the kicker that opens the books; the whole text when that kicker is absent. */
const above = (text: string) => {
  const i = text.indexOf('The work, in the open')
  return i < 0 ? text : text.slice(0, i)
}

const DRAWN_PATHS = ['~/.ssh/id_ed25519', '~/.npmrc', '~/.lingtai', '~/Library/Keychains']

const DRAWN_HOSTS = ['api.anthropic.com', 'api.openai.com', 'github.com', 'registry.npmjs.org']

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
      'One ticket, filed to landed.',
      'You slept. It shipped.',
      'Every run is sandboxed.',
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

  it('renders one Docs menu with the ten public pages and no other doc link', () => {
    const bar = renderToStaticMarkup(<Bar />)
    expect(bar.match(/<details/g)).toHaveLength(1)
    expect(bar).toMatch(/<summary>Docs<\/summary>/)
    const menu = bar.slice(bar.indexOf('<details'), bar.indexOf('</details>'))
    const hrefs = [...menu.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
    // #1061: tutorial-more is public but is reached from the tutorial, not the menu; #1295: so is when-it-fails, listed in the Guides; #1330: and upgrading-to-0.16; #1343: and team, which the tutorial ends on; #1380: and board, reached through the book; #1383: and tickets, the same; #1410: and solo; #1382: and connect-github; #1386: and checks-and-spend.
    const inMenu = PUBLIC_SLUGS.filter(
      (s) =>
        s !== 'tutorial-more' &&
        s !== 'team' &&
        s !== 'connect-github' &&
        s !== 'when-it-fails' &&
        s !== 'upgrading-to-0.16' &&
        s !== 'board' &&
        s !== 'tickets' &&
        s !== 'solo' &&
        s !== 'checks-and-spend',
    )
    expect(hrefs).toEqual(inMenu.map((s) => `/docs/${s}/`).sort((a, b) => hrefs.indexOf(a) - hrefs.indexOf(b)))
    expect(new Set(hrefs)).toEqual(new Set(inMenu.map((s) => `/docs/${s}/`)))
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
      'tutorial-more',
      'team',
      'connect-github',
      'concepts',
      'board',
      'tickets',
      'when-it-fails',
      'recipe',
      'cli',
      'requirements',
      'safety',
      'solo',
      'checks-and-spend',
      'upgrading-to-0.16',
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

  it('answers the common questions under the ledger, with no ~/.ssh question', () => {
    const html = renderToStaticMarkup(<HomePage books={null} />)
    const faq = html.slice(html.indexOf('class="faq"'))
    const block = faq.slice(0, faq.indexOf('</section>'))
    expect(block.match(/<details/g)).toHaveLength(6)
    for (const q of [
      'Can I approve before it merges?',
      'What does it do in each case?',
      'Will it break main?',
      'Will it run up a bill?',
      'What if my laptop restarts at 3am?',
      'Can it weaken its own checks?',
    ]) {
      expect(block).toContain(q)
    }
    expect(block).not.toContain('~/.ssh')
    expect(block).not.toContain('faq-item honest')
    expect(html).not.toMatch(/\bguarded\b/i)
  })

  it('has a dark sandbox band before the first question, from v0.14.0, linking the safety page', () => {
    const html = renderToStaticMarkup(<HomePage books={null} />)
    const start = html.indexOf('class="sandbox-pitch"')
    expect(start).toBeGreaterThan(-1)
    const block = html.slice(start, html.indexOf('</section>', start))
    expect(start).toBeLessThan(html.indexOf('class="why"'))
    expect(block).toContain('from v0.14.0')
    expect(block).toContain('href="/docs/safety/"')
    expect(block).toMatch(/telemetry/i)
    expect(block).toContain('On for new projects')
    expect(block).toContain('ILLUSTRATION')
    expect(block).toContain('class="home-shield"')
    expect(block).toContain(
      'aria-label="A shield around the agent&#x27;s run; the hosts on the allowlist are reached from it, and the keys and config on the machine stay outside it"',
    )
    expect(block).not.toContain('home-sbx')
    for (const drawn of [...DRAWN_PATHS, ...DRAWN_HOSTS, 'pastebin.com', '+ your allowlist', '+ blocked by default']) {
      expect(block).toContain(drawn)
    }
    // Every path drawn is on the built-in deny list (packages/sandbox/src/policy.ts), by prefix. `~/.lingtai` is
    // the state dir entry there, not a home join.
    const DENY = ['~/.ssh', '~/.aws', '~/.npmrc', '~/.lingtai', '~/.config/gh', '~/Library/Keychains']
    for (const drawn of DRAWN_PATHS) {
      expect(DENY.some((d) => drawn === d || drawn.startsWith(`${d}/`))).toBe(true)
    }
    // Every host drawn as reachable is on the built-in allowlist (BUILT_IN_DOMAINS in the same file).
    const ALLOW = ['api.anthropic.com', 'api.openai.com', 'registry.npmjs.org', 'github.com']
    for (const drawn of DRAWN_HOSTS) {
      expect(ALLOW).toContain(drawn)
    }
    expect(block).not.toContain('sandbox.svg')
    expect(block).not.toContain('sandbox-facts')
    expect(block).not.toContain('sandbox-note')
  })

  it('no longer says "Not a sandbox" in the footer line', () => {
    const html = renderToStaticMarkup(<HomePage books={null} />)
    const start = html.indexOf('class="home-edges"')
    expect(start).toBeGreaterThan(-1)
    const line = html.slice(start, html.indexOf('</p>', start))
    expect(line).not.toMatch(/not a sandbox/i)
  })

  it('holds the SVG aria-label and the safety page alt equal', async () => {
    const root = path.resolve(__dirname, '../../..')
    const svg = await readFile(path.join(root, 'doc/img/sandbox.svg'), 'utf8')
    const label = /aria-label="([^"]*)"/.exec(svg)?.[1]
    expect(label?.length).toBeGreaterThan(0)
    const safety = await readFile(path.join(root, 'doc/safety.md'), 'utf8')
    expect(safety).toContain(`![${label}](img/sandbox.svg)`)
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
      'Lingtai hands your tickets to Claude Code or Codex, runs your checks and an AI review, and ends every ticket in a receipt you can check',
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
    [
      "Who says it's done",
      'Your checks, run apart from the agent, a second AI review — your OK only if you turn it on',
    ],
    [
      'The workflow',
      'Built in: steps you set once in a recipe. Your skills still work — for the task, not the process.',
    ],
    ['Rules', 'Outside anything it can edit'],
    ['Sandbox', 'Sandboxed: keys unreadable, network allowlisted'],
    ['After a crash', 'Saved; it carries on after a restart'],
    ['Cost', 'Per ticket, with a daily limit'],
    ['Record', 'Every step recorded, and a receipt'],
  ])('says of %s, with Lingtai: %s', (key, claim) => {
    expect(rows.find((r) => r.key === key)?.lingtai).toBe(claim)
  })

  it('has no Requeue anywhere on the page', () => {
    expect(html).not.toContain('Requeue')
  })

  it('says the agent alone can read your keys and logins', () => {
    expect(rows.find((r) => r.key === 'Sandbox')?.alone).toBe('Can read your keys and logins')
  })

  it('keeps the agent-alone column fair', () => {
    expect(rows).toHaveLength(7)
    const page = text(html)
    for (const unfair of ['The session is gone', 'Found out later', 'A transcript, maybe', 'Logs and transcripts']) {
      expect(page).not.toContain(unfair)
    }
  })

  it('links to the replay receipt, as a real table', () => {
    expect(html).toContain('id="replay"')
    expect(html).toMatch(/<a href="#replay">See it above ↑<\/a>/)
    const ledger = html.slice(html.indexOf('class="ledger"'), html.indexOf('class="fp-head"'))
    expect(ledger).toContain('<table')
    expect(ledger.match(/scope="col"/g)).toHaveLength(2)
    // the seven it always had (Checks folded into Who says it's done, The workflow added), and When something breaks
    expect(ledger.match(/scope="row"/g)).toHaveLength(8)
  })
})

describe('the replay receipt', () => {
  const steps = [0, 1, 2, 3, 4, 5].map(receiptAt)

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

  it('is stamped only at step 5, and the cost never decreases', () => {
    expect(steps.map((s) => s.stamped)).toEqual([false, false, false, false, false, true])
    const cents = steps.map((s) => s.cents)
    expect(cents).toEqual([...cents].sort((a, b) => a - b))
    expect(dollars(cents[5]!)).toBe('$0.40')
  })

  it('has every row empty at 0 and clamps outside 0-5', () => {
    const s = receiptAt(0)
    expect([s.impl, s.checks, s.review, s.main, s.merged, s.handled]).toEqual(['—', '—', '—', '—', '—', '—'])
    expect(s.status).toBe('Queued')
    expect(receiptAt(99)).toBe(receiptAt(5))
    expect(receiptAt(-1)).toBe(receiptAt(0))
  })

  it('has five steps, no approval row, and lands on its own at the last', () => {
    expect(STEPS).toBe(5)
    const last = receiptAt(5)
    expect(last.merged).toBe('03:20, on its own')
    expect(last.handled).toBe('3 problems · 0 needed you')
    expect(last.status).toBe('✓ Landed')
    expect(JSON.stringify(steps)).not.toContain('Approved')
  })

  it('has five scenes, none of them waiting for a click, and a FAQ item about approval first', () => {
    const html = renderToStaticMarkup(<HomePage books={null} />)
    expect(html.match(/class="rp-scene"/g)).toHaveLength(5)
    expect(html).not.toContain('Approve and continue')
    expect(html).not.toMatch(/cold review|AI judge|The reviewer found/)
    const faq = html.slice(html.indexOf('class="faq-list"'))
    expect(faq.indexOf('Can I approve before it merges?')).toBeLessThan(faq.indexOf('What does it do in each case?'))
    expect(faq).not.toMatch(/<details[^>]* open/)
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

  it('holds the hero and the shots in one row, and the receipt beside the replay', () => {
    const html = renderToStaticMarkup(<HomePage books={null} />)
    const mark = html.indexOf('class="hero-row"')
    expect(mark).toBeGreaterThan(-1)
    const start = html.lastIndexOf('<div', mark)
    // The row's own contents: walk the divs from its opening tag to the one that closes it.
    let depth = 0
    let end = -1
    for (const m of html.slice(start).matchAll(/<div\b|<\/div>/g)) {
      depth += m[0] === '</div>' ? -1 : 1
      if (depth === 0) {
        end = start + m.index
        break
      }
    }
    expect(end).toBeGreaterThan(start)
    const row = html.slice(start, end)
    expect(row).toContain('id="hero-title"')
    expect(row).toContain('shot-tab')
    expect(row).not.toContain('id="replay"')
    expect(html.indexOf('class="rcpt')).toBeGreaterThan(html.indexOf('id="replay"'))
  })

  it('puts the film between the hero row and the replay, and contacts YouTube only by a link', () => {
    const html = renderToStaticMarkup(<HomePage books={null} />)
    expect(html.indexOf('id="film"')).toBeGreaterThan(html.indexOf('class="hero-row"'))
    expect(html.indexOf('id="film"')).toBeLessThan(html.indexOf('id="replay"'))
    expect(html).toContain('href="#film"')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('ytimg')
    expect(html).not.toMatch(/rel="(preconnect|dns-prefetch)"/)
    const watch = 'href="https://www.youtube.com/watch?v=s27esf-NQlc"'
    expect(html).toContain(watch)
    expect(html.replace(watch, '')).not.toContain('youtube')
  })

  it('shows the four screenshots with their captions, each linking to its full page', () => {
    const html = renderToStaticMarkup(<HomePage books={null} />)
    expect(SHOTS.map((s) => s.caption)).toEqual([
      'The board — queued, running, waiting on you, landed',
      'One ticket — every step, the review, what it cost',
      "Landed — what changed, with the AI review's summary",
      'Report — how the work converges and what it cost',
    ])
    for (const s of SHOTS) {
      const caption = s.caption.replace(/'/g, '&#x27;')
      expect(html).toContain(`alt="${caption}"`)
      expect(html).toContain(`>${caption}<`)
      expect(html).toContain(`href="/img/docs/shot-${s.name}-full.png"`)
      expect(html).toContain(`src="/img/docs/shot-${s.name}.png"`)
    }
    expect(html).toContain('width="1440" height="600"')
  })

  it('gives the lightbox tappable previous, next and close controls', () => {
    const html = renderToStaticMarkup(<HomePage books={null} />)
    for (const label of ['Previous screenshot', 'Next screenshot', 'Close']) {
      expect(html).toContain(`aria-label="${label}"`)
    }
  })

  it('puts the replay heading after the hero in the page source', async () => {
    const text = await prose()
    expect(text.indexOf('You slept. It shipped.')).toBeGreaterThan(text.indexOf('Agents do the work'))
    expect(text.indexOf('You slept. It shipped.')).toBeLessThan(text.indexOf('Three steps to your first receipt.'))
  })
})
