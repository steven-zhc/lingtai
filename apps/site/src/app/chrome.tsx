import Link from 'next/link'

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
export function Bar({ note }: { note?: string }) {
  return (
    <header className="bar">
      <Link href="/" className="brand">
        <span className="mark" aria-hidden />
        Lingtai
      </Link>
      <span className="spacer" />
      {note !== undefined && <span className="chip">{note}</span>}
      <Link href="/docs/tutorial/">Tutorial</Link>
      <Link href="/docs/plugins/">Plugins</Link>
      <a href={REPO}>GitHub</a>
    </header>
  )
}

export function Foot() {
  return (
    <footer className="foot">
      <div className="wrap foot-layout">
        <p>
          <b>Lingtai runs on one machine of yours.</b> It keeps its log in a local SQLite file by default, alongside a
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
