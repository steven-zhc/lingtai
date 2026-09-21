import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docRoot, FRONT_PAGE_DOCS, HTML_DOCS, published } from "@/lib/docs";

/** The home page leads with a visitor's outcome and keeps its proof honest. */

/** The page, with the comments taken out: they are not what a reader reads. */
async function prose(): Promise<string> {
  const page = await readFile(path.resolve(process.cwd(), "src/app/page.tsx"), "utf8");
  return page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("the home page's argument", () => {
  it("does not lead with internals or event-log claims", async () => {
    const text = await prose();
    const section = text.indexOf("The work, in the open");
    expect(section, "the page has no evidence section").toBeGreaterThan(-1);
    const above = text.slice(0, section);
    expect(above).not.toMatch(/\blogs?\b/i);
    expect(above).not.toMatch(/\bevent-source|append-only|projection|Postgres sequence\b/i);
  });

  it("explains the benefit, use, proof, and limits in that order", async () => {
    const text = await prose();
    const order = [
      "Let your backlog move",
      "What changes for you",
      "Why Lingtai",
      "How you use it",
      "The work, in the open",
      "Know the edges",
      "Keep exploring",
    ];
    const at = order.map((heading) => ({ heading, at: text.indexOf(heading) }));
    const missing = at.filter((s) => s.at < 0).map((s) => s.heading);
    expect(missing, `the page is missing: ${missing.join(", ")}`).toEqual([]);
    const positions = at.map((s) => s.at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("marks the conceptual diagram as an illustration, not board data", async () => {
    const text = await prose();
    expect(text).toContain('role="img"');
    expect(text).toContain("ILLUSTRATION");
    expect(text).toContain("snapshot === null ? <NoSnapshot /> : <SnapshotBoard snapshot={snapshot} />");
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
