import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_PUBLIC } from "@/lib/docs";

/** The home page leads with a visitor's outcome and keeps its proof honest. */

/** The page, with the comments taken out: they are not what a reader reads. */
async function prose(): Promise<string> {
  const page = await readFile(path.resolve(import.meta.dirname, "../src/app/page.tsx"), "utf8");
  return page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("the home page's argument", () => {
  it("uses the public home as the installer front door", async () => {
    const chrome = await readFile(path.resolve(import.meta.dirname, "../src/app/chrome.tsx"), "utf8");
    expect(chrome).toContain('export const SITE_URL = "https://lingtai.hczhang.com"');
    expect(chrome).toContain('export const INSTALL_URL = `${SITE_URL}/install.sh`');
  });

  it("lays the two footer facts out as a responsive pair", async () => {
    const chrome = await readFile(path.resolve(import.meta.dirname, "../src/app/chrome.tsx"), "utf8");
    const css = await readFile(path.resolve(import.meta.dirname, "../src/app/site.css"), "utf8");
    expect(chrome).toContain('className="wrap foot-layout"');
    expect(chrome).not.toContain("style={{ marginTop: 14 }}");
    expect(css).toMatch(/\.foot-layout\s*{[^}]*display:\s*grid/s);
  });

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

  it("keeps page sections out of the board's generic setup and evidence classes", async () => {
    const text = await prose();
    expect(text).not.toContain('<section className="setup"');
    expect(text).not.toContain('<section className="evidence"');
    expect(text).toContain('<section className="home-setup"');
    expect(text).toContain('<section className="home-evidence"');
  });

  it("keeps repository docs out of the public site until they are ready", async () => {
    const [home, chrome] = await Promise.all([
      prose(),
      readFile(path.resolve(import.meta.dirname, "../src/app/chrome.tsx"), "utf8"),
    ]);
    expect(DOCS_PUBLIC).toBe(false);
    expect(`${home}\n${chrome}`).not.toMatch(/href="\/docs|href="\/doc\//);
    expect(home).toContain('href="#setup"');
  });
});
