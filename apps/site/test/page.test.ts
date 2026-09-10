import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docRoot, FRONT_PAGE_DOCS, HTML_DOCS, published } from "@/lib/docs";

/**
 * The order the front page argues in, as a test.
 *
 * The page's sections are in the order they are for one reason, recorded in
 * `doc/decisions/0035-the-site-is-a-projection.md` and made a rule by #116:
 * **the event log is why the promise is credible, not the promise.** Nobody
 * arrives wanting a record; they arrive wanting the queue to move without them
 * watching it. So the log is argued for under "when it goes wrong" and never
 * above it.
 *
 * That is exactly the kind of rule a later edit undoes without noticing — a
 * sentence about the log reads well anywhere, which is the problem — so it is
 * checked rather than left as an intention in a comment.
 */

/** The page, with the comments taken out: they are not what a reader reads. */
async function prose(): Promise<string> {
  const page = await readFile(path.resolve(process.cwd(), "src/app/page.tsx"), "utf8");
  return page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("nothing above “when it goes wrong” argues from the event log", () => {
  it("says nothing about the log until the section that earns it", async () => {
    const text = await prose();
    const section = text.indexOf("When it goes wrong");
    expect(section, "the page has no “when it goes wrong” section").toBeGreaterThan(-1);
    const above = text.slice(0, section);
    expect(above).not.toMatch(/\blogs?\b/i);
    expect(above).not.toMatch(/\bevent-source|append-only|projection\b/i);
  });

  it("keeps the sections in the order the argument needs", async () => {
    const text = await prose();
    const order = [
      "Point it at a repository",
      "The loop",
      "Your repository sets the rules",
      "When it goes wrong",
      "Open",
      "Docs",
    ];
    const at = order.map((heading) => ({ heading, at: text.indexOf(heading) }));
    const missing = at.filter((s) => s.at < 0).map((s) => s.heading);
    expect(missing, `the page is missing: ${missing.join(", ")}`).toEqual([]);
    const positions = at.map((s) => s.at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("the six docs entries go somewhere", () => {
  it("names a file that is still in doc/", () => {
    expect(FRONT_PAGE_DOCS).toHaveLength(6);
    for (const doc of FRONT_PAGE_DOCS) {
      expect(existsSync(path.join(docRoot, doc.source)), `doc/${doc.source} is gone`).toBe(true);
    }
  });

  it("links to a page this site publishes", async () => {
    const all = await published();
    for (const doc of FRONT_PAGE_DOCS) {
      if (doc.href.startsWith("/doc/")) {
        // Carried, not converted: `architecture.html` is copied into the export
        // by `scripts/doc-assets.ts` and served as itself.
        const file = doc.href.slice("/doc/".length);
        expect(HTML_DOCS.map((d) => d.file), `${doc.href} is not carried`).toContain(file);
      } else if (doc.href.startsWith("/docs/#")) {
        // A section of the generated index, which is a directory of `doc/`.
        expect(all.some((f) => f.startsWith(`${doc.source}/`))).toBe(true);
      } else {
        // A rendered page, so the markdown behind it has to be published.
        expect(all, `${doc.href} renders nothing`).toContain(doc.source);
      }
    }
  });
});
