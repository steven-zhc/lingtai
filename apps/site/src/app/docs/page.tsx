import Link from "next/link";
import type { Metadata } from "next";
import {
  entriesOf,
  GITHUB_BLOB,
  HTML_DOCS,
  SECTIONS,
  statuses,
  unpublished,
} from "@/lib/docs";
import { Bar, Foot } from "../chrome";

export const metadata: Metadata = {
  title: "Documentation",
  description: "Every document in the repository, rendered from the repository.",
};

/**
 * The index, generated from what is in `doc/` — never a list maintained here.
 *
 * A hand-kept index is the smallest possible version of the drift this whole
 * pipeline refuses: a new ADR lands and the page that is supposed to list every
 * decision quietly lists all but one. This reads the directory, takes each
 * file's own `#` heading and first paragraph, and takes the decisions' statuses
 * out of `doc/README.md`, which is where this repository keeps them.
 */
export default async function Docs() {
  const sections = await Promise.all(
    SECTIONS.map(async (section) => ({ section, entries: await entriesOf(section) })),
  );
  const status = await statuses();
  const missing = await unpublished();

  return (
    <>
      <Bar />
      <main>
        <div className="wrap">
          <section style={{ paddingBottom: 12 }}>
            <p className="kicker">Documentation</p>
            <h1 style={{ fontSize: 34 }}>Everything, rendered from the repository.</h1>
            <p className="lede">
              Every page below is a file in <code>doc/</code>, read at build time. There is no
              second copy to fall behind — a document edited on <code>main</code> is the page the
              next build serves.
            </p>
            <p style={{ marginTop: 18 }}>
              <Link className="way-in" href="/docs/tutorial/">
                Start with the tutorial
              </Link>
            </p>
          </section>

          <div className="doc-section">
            <h2>Architecture</h2>
            <p style={{ color: "var(--ink-2)", marginTop: 6 }}>
              Written as HTML, with its own diagrams, and served as itself rather than reformatted.
            </p>
            <ul className="doc-list">
              {HTML_DOCS.map((doc) => (
                <li key={doc.file}>
                  <a href={`/doc/${doc.file}`}>
                    <span className="t">{doc.label}</span>
                    <span className="s">doc/{doc.file}</span>
                    <span className="l">{doc.note}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {sections.map(({ section, entries }) => (
            <div className="doc-section" key={section.id} id={section.id}>
              <h2>{section.label}</h2>
              <p style={{ color: "var(--ink-2)", marginTop: 6 }}>{section.note}</p>
              <ul className="doc-list">
                {entries.map((entry) => {
                  const state = status.get(entry.slug);
                  return (
                    <li key={entry.slug}>
                      <Link href={`/docs/${entry.slug}/`}>
                        <span className="t">{entry.title}</span>
                        {state !== undefined && state !== "accepted" && (
                          <span className="s">{state}</span>
                        )}
                        {/* When, for the one list whose shape is a sequence:
                            the decision's own date, not one kept here. A guide
                            has no such date — the first one in `operating.md` is
                            the day a section moved — so only decisions show it. */}
                        {section.id === "decisions" && entry.decided !== null && (
                          <span className="s">{entry.decided}</span>
                        )}
                        <span className="s">doc/{entry.source}</span>
                        {entry.lede !== "" && <span className="l">{entry.lede}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {missing.length > 0 && (
            <div className="doc-section">
              <h2>In the repository, not on this site</h2>
              <p style={{ color: "var(--ink-2)", marginTop: 6 }}>
                What is published is an explicit list, because a projection that publishes whatever
                it finds in a directory eventually publishes something nobody meant to. The cost of
                that is what it leaves out silently — so it does not: these files are in{" "}
                <code>doc/</code> and no section takes them.
              </p>
              <ul className="doc-list">
                {missing.map((file) => (
                  <li key={file}>
                    <a href={`${GITHUB_BLOB}doc/${file}`}>
                      <span className="t">doc/{file}</span>
                      <span className="s">on GitHub</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </main>
      <Foot />
    </>
  );
}
