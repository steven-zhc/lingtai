import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { GITHUB_BLOB, ledeOf, published, readDoc } from "@/lib/docs";
import { Bar, Foot } from "../../chrome";
import { Document } from "../document";

/**
 * One document, at the route its path in `doc/` gives it.
 *
 * `doc/decisions/0022-the-seams.md` is `/docs/decisions/0022-the-seams/`. The
 * route is derived from the file rather than assigned here, so a new ADR is a
 * new page with no second thing to add.
 */

/**
 * Every page the export writes — which is every file a section takes, and
 * nothing else.
 *
 * A static export has no fallback: a slug that is not in this list is not built
 * and does not exist. That is the property worth having. `fileOf` would happily
 * read anything under `doc/`, and a route reading arbitrary paths off disk at
 * build time is how a file nobody meant to publish gets published.
 */
export async function generateStaticParams() {
  const files = await published();
  return files.map((file) => ({ slug: file.replace(/\.md$/, "").split("/") }));
}

type Params = { params: Promise<{ slug: string[] }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const doc = await readDoc((await params).slug.join("/"));
  if (doc === null) return {};
  return { title: doc.title, description: ledeOf(doc.body).slice(0, 200) };
}

export default async function DocPage({ params }: Params) {
  const slug = (await params).slug.join("/");
  const [doc, files] = await Promise.all([readDoc(slug), published()]);
  if (doc === null || !files.includes(doc.source)) notFound();

  return (
    <>
      <Bar />
      <main>
        <div className="wrap">
          <section style={{ paddingTop: 32 }}>
            <p className="kicker">
              <Link href="/docs/">Documentation</Link>
            </p>
            <Document slug={doc.slug} body={doc.body} published={files} />
            <p className="source">
              Rendered from{" "}
              <a href={`${GITHUB_BLOB}doc/${doc.source}`}>
                <code>doc/{doc.source}</code>
              </a>{" "}
              at build time. The file is the document; this page is a projection of it, and never a
              copy — which is why the fix for anything wrong on it is a pull request against that
              file.
            </p>
          </section>
        </div>
      </main>
      <Foot />
    </>
  );
}
