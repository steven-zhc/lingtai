import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "@/lib/docs";

/**
 * The theme rules of #115, as a lint rather than as an intention.
 *
 * Every rule below is already written down — in the comment at the top of
 * `site.css`, in `layout.tsx`, and in
 * [0035](../../../doc/decisions/0035-the-site-is-a-projection.md) §3 and §4.
 * Writing them down is what the ticket asked for and it is not what keeps them:
 * a palette drifts one plausible edit at a time, and every one of those edits
 * looks reasonable in isolation. `#FD5D3F` on a heading reads well. A second
 * `--surface` "just for the docs" is a two-line diff. A serif in `.prose` is
 * the single change that would make the long documents more comfortable to
 * read, and it is the exact change 0035 §4 forbids.
 *
 * So this file asserts the rules against the files, and each rule fails with
 * the reason it exists rather than with a diff. It is the same posture
 * `page.test.ts` takes to the order of the front page's argument: a rule a
 * later edit undoes without noticing is a rule that has to be checked.
 *
 * These read source rather than the built export, deliberately. A rendered page
 * would be the stronger evidence and the suite would then need a `next build`
 * to run at all — and a check that is expensive to run is a check that gets
 * skipped. What a reader sees comes from these files and nothing else.
 */

const siteRoot = path.resolve(process.cwd());
const boardCss = path.join(repoRoot, "apps/board/src/app/globals.css");
const siteCss = path.join(siteRoot, "src/app/site.css");

/** CSS with the prose taken out — every rule below is about declarations. */
const stripped = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** TSX with the prose taken out, for the same reason. */
const code = (tsx: string) =>
  tsx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const read = (file: string) => readFile(file, "utf8");

/**
 * Every innermost rule in a stylesheet, as `{ selector, body }`.
 *
 * `[^{}]` on both halves is what makes it innermost: an `@media` line cannot
 * match as a selector because its body would have to contain a brace, so the
 * rules inside it match on their own and a token defined only in dark mode is
 * seen exactly like one defined at the top.
 */
function rules(css: string): { selector: string; body: string }[] {
  return [...stripped(css).matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({
    selector: group(m, 1).trim(),
    body: group(m, 2),
  }));
}

/**
 * A capture, as a string. A group that did not match and a match that did not
 * happen are the same thing here — the empty string — because every assertion
 * below states what it expected to find, and "" fails all of them with that
 * sentence rather than with a TypeError.
 */
function group(m: RegExpMatchArray | null, n: number): string {
  return m?.[n] ?? "";
}

/** The custom properties a stylesheet *defines*, as opposed to reads. */
function defines(css: string): Set<string> {
  const names = new Set<string>();
  for (const rule of rules(css)) {
    for (const m of rule.body.matchAll(/(--[a-z0-9-]+)\s*:/gi)) names.add(group(m, 1));
  }
  return names;
}

describe("the palette comes from the product, and is not a copy of it", () => {
  /**
   * The ticket's load-bearing rule: *if the board's palette moves, the site
   * moves with it*. An import is the only arrangement in which that is true
   * without anybody remembering it.
   */
  it("imports the board's stylesheet before its own", async () => {
    const layout = code(await read(path.join(siteRoot, "src/app/layout.tsx")));
    const board = layout.indexOf("board/src/app/globals.css");
    const own = layout.indexOf("./site.css");
    expect(board, "the layout does not import apps/board/src/app/globals.css").toBeGreaterThan(-1);
    expect(own, "the layout does not import site.css").toBeGreaterThan(-1);
    expect(board, "site.css is imported first, so the product would override the site").toBeLessThan(
      own,
    );
  });

  /**
   * A redefinition is not an override — it is a second definition of the same
   * name, and the moment the board changes its value the two disagree with
   * nothing to say which is right. This is the same failure 0022 deleted a
   * subsystem to avoid: two writers to one truth, and the one nobody watches
   * is the one that goes stale.
   */
  it("redefines none of the board's tokens", async () => {
    const theirs = defines(await read(boardCss));
    const ours = defines(await read(siteCss));
    const both = [...ours].filter((name) => theirs.has(name));
    expect(
      both,
      `site.css redefines ${both.join(", ")} — the board defines these, so a copy here ` +
        `drifts the first time the product's palette moves`,
    ).toEqual([]);
  });

  /**
   * What the site is allowed to add: a measure, and the coral the product
   * holds out of its own palette. A new name here is a design decision, and it
   * should cost an edit to this list and a sentence saying why.
   */
  it("adds only the tokens a page has and a console does not", async () => {
    const ours = [...defines(await read(siteCss))].sort();
    expect(ours).toEqual(["--measure", "--way-in", "--way-in-ink"]);
  });

  /**
   * Dark is the board's, minus the one hue the board does not have. If the
   * site's dark block ever grows a second entry, it is holding a dark value
   * the product also holds — and #115's whole point is that there is only one
   * place to hold one.
   */
  it("takes its dark values from the board, and darkens only the coral", async () => {
    const dark = rules(await read(siteCss)).filter(
      (r) => r.selector.startsWith(":root") && /--/.test(r.body),
    );
    // Two `:root` blocks: the light one at the top and the one inside the
    // dark-scheme query. Anything the second sets is a dark value this file owns.
    expect(dark.length, "site.css has no dark block, so dark is not from the same tokens").toBe(2);
    const body = dark[1]?.body ?? "";
    const overridden = [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => group(m, 1));
    expect(overridden).toEqual(["--way-in"]);
  });
});

describe("coral marks the way in and nothing else", () => {
  /**
   * The rule 0035 §3 states and this file enforces. Coral is not spendable on
   * a heading, a hover, a rule, or an accent on something that already carries
   * the teal — because if a second thing on a page is coral, one of them is
   * not the way in and the reader has to work out which.
   */

  /** The classes that paint with coral, read out of the stylesheet itself. */
  async function coralClasses(): Promise<string[]> {
    const painted = rules(await read(siteCss)).filter(
      (r) => !r.selector.startsWith(":root") && /var\(\s*--way-in\s*\)/.test(r.body),
    );
    const names = new Set<string>();
    for (const rule of painted) {
      for (const m of rule.selector.matchAll(/\.([a-z0-9-]+)/gi)) names.add(group(m, 1));
    }
    return [...names].sort();
  }

  it("is defined once, and the product still does not have it", async () => {
    const site = stripped(await read(siteCss));
    const board = stripped(await read(boardCss));
    expect(
      [...board.matchAll(/#fd5d3f/gi)],
      "the board's palette has grown the coral — 0035 §3 rests on it being held out",
    ).toEqual([]);
    // One light value and one lifted for a dark ground, and no third.
    const literal = [...site.matchAll(/#(fd5d3f|ff7256)/gi)];
    expect(literal.map((m) => group(m, 0).toLowerCase())).toEqual(["#fd5d3f", "#ff7256"]);
  });

  it("is never written as a literal outside the two token definitions", async () => {
    const loose: string[] = [];
    for (const file of await sources()) {
      if (file.endsWith("site.css")) continue;
      if (/#fd5d3f|#ff7256/i.test(stripped(await read(file)))) loose.push(rel(file));
    }
    expect(
      loose,
      `coral is spelled out in ${loose.join(", ")} — it has a token, and a literal is a ` +
        `second definition that no longer moves when the token does`,
    ).toEqual([]);
  });

  it("paints only the way in and the one claim the page rests on", async () => {
    // Not a list this test carries: it is read out of `site.css`, so a new
    // coral rule is seen here whatever it is called.
    expect(await coralClasses()).toEqual(["claim", "way-in"]);
  });

  /**
   * The chrome is on every page, so anything coral in it is coral on every
   * page — and a bar with a coral link in it would spend the whole budget
   * before the page has said anything.
   */
  it("is absent from the bar and the footer", async () => {
    const chrome = code(await read(path.join(siteRoot, "src/app/chrome.tsx")));
    for (const name of await coralClasses()) {
      expect(chrome, `the chrome carries .${name}, which puts coral on every page`).not.toContain(
        `"${name}"`,
      );
    }
  });

  it("appears at most twice on a page, and at most once as something pressable", async () => {
    const classes = await coralClasses();
    for (const file of await sources()) {
      if (!file.endsWith("page.tsx")) continue;
      const markup = code(await read(file));
      const used = [...markup.matchAll(/className="([^"]*)"/g)].flatMap((m) =>
        group(m, 1)
          .split(/\s+/)
          .filter((c) => classes.includes(c)),
      );
      expect(
        used.length,
        `${rel(file)} has ${used.length} coral elements (${used.join(", ")}) — a reader ` +
          `cannot be asked which of three is the way in`,
      ).toBeLessThanOrEqual(2);

      const pressed = [...markup.matchAll(/<(?:Link|a|button)\s[^>]*className="([^"]*)"/g)].flatMap(
        (m) =>
          group(m, 1)
            .split(/\s+/)
            .filter((c) => classes.includes(c)),
      );
      expect(
        pressed.length,
        `${rel(file)} offers ${pressed.length} coral things to press — only one of them ` +
          `can be the way in`,
      ).toBeLessThanOrEqual(1);
    }
  });
});

describe("two faces, and the range comes from scale", () => {
  it("loads IBM Plex Sans and IBM Plex Mono, and no third family", async () => {
    const layout = code(await read(path.join(siteRoot, "src/app/layout.tsx")));
    const loaded = [...layout.matchAll(/from\s+"next\/font\/google"/g)];
    expect(loaded.length, "the faces are not loaded by next/font").toBe(1);
    const imported = group(layout.match(/import\s*\{([^}]*)\}\s*from\s*"next\/font\/google"/), 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    expect(imported).toEqual(["IBM_Plex_Mono", "IBM_Plex_Sans"]);
  });

  /**
   * 0035 §4: no serif, including in the long documentation. It would read a
   * little better and it is the one move that would make this look like every
   * other documentation site — which is why it is checked and not trusted.
   * Comfort comes from `--measure` and from leading.
   */
  it("has no serif anywhere, and keeps the measure that pays for not having one", async () => {
    const site = stripped(await read(siteCss));
    expect(site, "a serif has appeared in the site's own layer").not.toMatch(
      /font-family:[^;]*\bserif\b/i,
    );
    expect(site).toMatch(/--measure:\s*\d+ch/);
    expect(site, ".prose does not use the measure, so the documents have nothing holding them")
      .toMatch(/\.prose\s*\{[^}]*var\(--measure\)/);
  });
});

/**
 * The nav is three things and a mark.
 *
 * #115 put a ceiling on it and gave the reason: *a site with more navigation
 * than the product has features is describing an ambition, not a product*.
 * Three is not a round number picked to be strict — it is what there is. Read
 * the documentation, start the tutorial, or go and look at the source.
 *
 * `architecture.html` used to be the fourth. It is one document among the
 * documents, reachable from Docs and linked from the front page where it is
 * being argued from, and having it in the bar said the site had a section it
 * does not have.
 */
describe("the bar is three things and a mark", () => {
  async function bar(): Promise<string> {
    const chrome = code(await read(path.join(siteRoot, "src/app/chrome.tsx")));
    const from = chrome.indexOf("export function Bar");
    const to = chrome.indexOf("export function Foot");
    expect(from, "chrome.tsx has no Bar").toBeGreaterThan(-1);
    return chrome.slice(from, to > from ? to : undefined);
  }

  it("carries one mark, drawn from the palette rather than chosen here", async () => {
    const marks = [...(await bar()).matchAll(/className="mark"/g)];
    expect(marks.length).toBe(1);
  });

  it("offers three destinations besides the mark", async () => {
    // Any opening tag, not any `href="…"`: the repository's link is
    // `href={REPO}`, and a check that counted only literal hrefs would have
    // quietly stopped seeing it.
    const links = [...(await bar()).matchAll(/<(?:Link|a)[\s>]/g)];
    // The brand is a link too — it is the mark, and it goes home.
    const brand = [...(await bar()).matchAll(/className="brand"/g)];
    expect(brand.length).toBe(1);
    expect(
      links.length - brand.length,
      `the bar offers ${links.length - brand.length} destinations; three is the ceiling, ` +
        `and a fourth is a section this product does not have`,
    ).toBe(3);
  });
});

/* --- the files these rules are about ------------------------------------- */

function rel(file: string): string {
  return path.relative(repoRoot, file);
}

/** Every source file the site renders from. */
async function sources(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const found: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(tsx?|css)$/.test(entry.name)) found.push(full);
    }
  }
  await walk(path.join(siteRoot, "src"));
  return found.sort();
}
