import Link from 'next/link'
import { Fragment } from 'react'

export const REPO = 'https://github.com/steven-zhc/lingtai'
export const SITE_URL = 'https://lingtai.hczhang.com'

/**
 * Where `install.sh` is fetched from.
 *
 * The site serves its own `public/install.sh`. The script fetches artifacts
 * straight from GitHub Releases, as does `lingtai upgrade`.
 */
export const INSTALL_URL = `${SITE_URL}/install.sh`

/**
 * The bar, and it is the board's bar.
 *
 * `.bar`, `.brand`, `.mark`, `.sep` and `.chip` are all defined in the
 * product's stylesheet. Reusing the classes rather than the look is what makes
 * "the site extends the product's palette" a fact the build enforces instead of
 * an intention somebody has to keep.
 */
/** The public docs, in the order the Docs menu lists them. A rule is drawn after `rule`. */
export const DOCS_MENU: { slug: string; label: string; note?: string; rule?: boolean }[] = [
  { slug: 'tutorial', label: 'Tutorial', note: 'One ticket, start to finish' },
  { slug: 'concepts', label: 'Concepts', note: 'The steps of an attempt' },
  { slug: 'requirements', label: 'Requirements', note: 'What it needs' },
  { slug: 'safety', label: 'What an agent can touch', note: 'Before you run it' },
  { slug: 'guide', label: 'Best practices', note: 'How to get good results', rule: true },
  { slug: 'recipe', label: 'Recipe' },
  { slug: 'cli', label: 'CLI' },
  { slug: 'plugins', label: 'Plugins' },
  { slug: 'events', label: 'Events' },
  { slug: 'from-symphony', label: 'Coming from Symphony' },
]

/**
 * The items are plain anchors, not `Link`: `<details>` keeps its `open` in the
 * DOM, so a client navigation between docs pages would leave the menu open over
 * the page just reached. A full load comes back closed, and no script is needed.
 */
export function Bar() {
  return (
    <header className="bar">
      <Link href="/" className="brand">
        <span className="mark" aria-hidden />
        Lingtai
      </Link>
      <details className="docs-menu">
        <summary>Docs</summary>
        <div className="docs-menu-list">
          {DOCS_MENU.map((d) => (
            <Fragment key={d.slug}>
              <a href={`/docs/${d.slug}/`}>
                {d.label}
                {d.note !== undefined && <small>{d.note}</small>}
              </a>
              {d.rule === true && <hr />}
            </Fragment>
          ))}
        </div>
      </details>
      <span className="spacer" />
      <a href={REPO}>GitHub</a>
    </header>
  )
}

export function Foot() {
  return (
    <footer className="foot">
      <div className="wrap foot-layout">
        <p>
          <b>Lingtai runs on one machine of yours.</b> It keeps its state in a local SQLite file by default, alongside a
          clone of each repository it manages and the agent processes it starts. There is no hosted service and nothing
          to sign up for — install the CLI and run <code>lingtai init</code>.
        </p>
        <p>
          <b>Built in the open.</b> Source, releases, and issues live on{' '}
          <a className="link" href={REPO}>
            GitHub
          </a>
          .
        </p>
      </div>
    </footer>
  )
}
