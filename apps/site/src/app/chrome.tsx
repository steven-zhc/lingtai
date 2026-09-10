import Link from "next/link";

export const REPO = "https://github.com/steven-zhc/lingtai";

/**
 * The bar, and it is the board's bar.
 *
 * `.bar`, `.brand`, `.mark`, `.sep` and `.chip` are all defined in the
 * product's stylesheet. Reusing the classes rather than the look is what makes
 * "the site extends the product's palette" a fact the build enforces instead of
 * an intention somebody has to keep.
 *
 * **Three destinations and the mark, and that is the ceiling** (#115): read the
 * documentation, start the tutorial, or go and look at the source. A site with
 * more navigation than the product has features is describing an ambition
 * rather than a product, and the fourth entry is always the one that seems
 * harmless. `architecture.html` was that fourth — it is one document among the
 * documents, indexed under Docs and linked from the front page at the point it
 * is being argued from, and in the bar it advertised a section this site does
 * not have. `test/theme.test.ts` holds the count.
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
          nothing to sign up for — <code>git clone</code>, and read{" "}
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
