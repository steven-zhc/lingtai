import Link from "next/link";

export const REPO = "https://github.com/steven-zhc/lingtai";

/**
 * Where `install.sh` is fetched from — the two addresses, and they are not
 * interchangeable.
 *
 * `INSTALL_URL` is this site serving its own `public/install.sh`, and it is the
 * front door. `INSTALL_FALLBACK` is the same file published as a release asset,
 * and it is the one that **cannot move**: a domain can lapse, be renamed, or
 * end up behind a bot challenge that returns a 200 HTML page — which `curl -f`
 * does not catch, and which then gets piped into `sh`. GitHub's is the address
 * to write down where it has to outlive a decision.
 *
 * Neither is load-bearing after the first install. The script fetches every
 * artifact straight from GitHub Releases, and so does `lingtai upgrade`
 * (`apps/cli/src/install.ts`'s `RELEASES_API`) — so a domain that moves breaks
 * new installs and nothing else.
 */
export const INSTALL_URL = "https://lingtai.nextloom.ai/install.sh";
export const INSTALL_FALLBACK = `${REPO}/releases/latest/download/install.sh`;

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
      <span className="sep" />
      <Link href="/docs/">Docs</Link>
      <Link href="/docs/tutorial/">Tutorial</Link>
      <a href="/doc/architecture.html">Architecture</a>
      <span className="spacer" />
      {note !== undefined && <span className="chip">{note}</span>}
      <a href={REPO}>GitHub</a>
    </header>
  );
}

export function Foot() {
  return (
    <footer className="foot">
      <div className="wrap">
        <p>
          <b>Lingtai runs on one machine of yours.</b> It owns a Postgres database, a clone of each
          repository it manages, and the agent processes it starts. There is no hosted service and
          nothing to sign up for — install the CLI, run <code>lingtai init</code>, and follow{" "}
          <Link className="link" href="/docs/tutorial/">
            the tutorial
          </Link>
          .
        </p>
        <p style={{ marginTop: 14 }}>
          Every page under <code>/docs</code> is rendered from a file in{" "}
          <a className="link" href={`${REPO}/tree/main/doc`}>
            <code>doc/</code>
          </a>{" "}
          at build time. Nothing here is a second copy of anything in the repository.
        </p>
      </div>
    </footer>
  );
}
