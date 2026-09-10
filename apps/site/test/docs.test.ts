import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decidedOn,
  decisionsByNumber,
  docRoot,
  entriesOf,
  fileOf,
  GITHUB_BLOB,
  headingsOf,
  ledeOf,
  published,
  resolveHref,
  SECTIONS,
  slugify,
  statuses,
  statusParts,
  titleOf,
  unpublished,
} from "@/lib/docs";

/**
 * The projection is tested against the real `doc/`, not a fixture.
 *
 * A fixture would test that the code can read a directory, which is not the
 * claim. The claim is that *this repository's* documentation renders — that
 * every file a section names is there, that the links inside those files reach
 * somewhere, and that nothing is quietly dropped. A fixture passes on the day
 * somebody deletes `tutorial.md`.
 */

describe("what the site publishes", () => {
  it("takes every guide the sections name, and they all exist", async () => {
    const guides = SECTIONS.find((s) => s.id === "guides");
    expect(guides).toBeDefined();
    const files = Array.isArray(guides!.files) ? guides!.files : [];
    // `filesOf` drops a file that is not on disk, so a name that disappeared
    // from `doc/` would leave the site quietly one page short.
    const { filesOf } = await import("@/lib/docs");
    expect(await filesOf(guides!)).toEqual(files);
  });

  it("takes every decision in the directory", async () => {
    const all = await published();
    expect(all).toContain("tutorial.md");
    expect(all).toContain("decisions/0022-the-seams.md");
    expect(all.filter((f) => f.startsWith("decisions/")).length).toBeGreaterThan(30);
  });

  it("names what it does not publish rather than dropping it", async () => {
    const missing = await unpublished();
    // `doc/research/` is a market study and not documentation, so it is not
    // projected — and the index says so. The failure this guards against is
    // the *silent* omission, not the omission.
    expect(missing).toContain("research/market-opportunities.md");
    expect(missing).not.toContain("README.md");
  });

  it("refuses a slug that climbs out of doc/", () => {
    expect(fileOf("../package")).toBeNull();
    expect(fileOf("../../package")).toBeNull();
    expect(fileOf("tutorial")).toBe("tutorial.md");
  });
});

describe("what a document says it is", () => {
  it("takes the title from the file's own heading", () => {
    expect(titleOf("# The seams\n\nbody", "fallback")).toBe("The seams");
    expect(titleOf("no heading here", "fallback")).toBe("fallback");
  });

  it("takes a lede from prose, and skips tables, quotes and lists", () => {
    expect(ledeOf("# T\n\n| a | b |\n\n- one\n\nThe **real** first line.")).toBe(
      "The real first line.",
    );
  });

  it("reads each decision's status out of doc/README.md", async () => {
    const status = await statuses();
    // 0014 was superseded by 0016 and the index is the only place that says so.
    // A site that showed the two as equals would disagree with the repository
    // about which decisions are in force.
    expect(status.get("decisions/0014-one-loop-one-log")).toMatch(/superseded/);
    // 0016 is still in force and its status still begins by saying so — but it
    // now carries what 0036 and 0037 did to two of its sections, and an
    // equality here asserted that no decision would ever be *partly* revised.
    // It went red the day 0037 landed, which is a test failing for being right.
    expect(status.get("decisions/0016-the-settled-model")).toMatch(/^accepted/);
    expect(status.get("decisions/0016-the-settled-model")).toMatch(/superseded by 0037/);
  });

  it("gives every entry a title that is not just its filename", async () => {
    const decisions = SECTIONS.find((s) => s.id === "decisions")!;
    for (const entry of await entriesOf(decisions)) {
      expect(entry.title).not.toBe(entry.slug);
    }
  });
});

describe("where a link inside a document goes", () => {
  const isPublished = (file: string) =>
    ["tutorial.md", "decisions/0022-the-seams.md", "decisions/0016-the-settled-model.md"].includes(
      file,
    );

  it("sends a link between two projected documents to its route here", () => {
    expect(resolveHref("decisions/0022-the-seams", "0016-the-settled-model.md", isPublished)).toBe(
      "/docs/decisions/0016-the-settled-model/",
    );
    expect(resolveHref("tutorial", "decisions/0022-the-seams.md", isPublished)).toBe(
      "/docs/decisions/0022-the-seams/",
    );
    expect(resolveHref("decisions/0022-the-seams", "../tutorial.md", isPublished)).toBe(
      "/docs/tutorial/",
    );
  });

  it("keeps the anchor", () => {
    expect(resolveHref("tutorial", "decisions/0022-the-seams.md#the-seams", isPublished)).toBe(
      "/docs/decisions/0022-the-seams/#the-seams",
    );
  });

  it("sends a link to source code to the repository, where the code is", () => {
    expect(
      resolveHref("decisions/0016-the-settled-model", "../../packages/domain/src/events.ts", isPublished),
    ).toBe(`${GITHUB_BLOB}packages/domain/src/events.ts`);
  });

  it("sends a link to a document nobody projected to the repository too", () => {
    expect(resolveHref("tutorial", "research/market-opportunities.md", isPublished)).toBe(
      `${GITHUB_BLOB}doc/research/market-opportunities.md`,
    );
  });

  it("sends architecture.html to the copy the build made", () => {
    expect(resolveHref("decisions/0022-the-seams", "../architecture.html", isPublished)).toBe(
      "/doc/architecture.html",
    );
  });

  it("leaves an absolute link and a bare anchor alone", () => {
    expect(resolveHref("tutorial", "https://github.com/x", isPublished)).toBe("https://github.com/x");
    expect(resolveHref("tutorial", "#done-when", isPublished)).toBe("#done-when");
  });
});

describe("finding your way around one document", () => {
  it("gives a heading the anchor GitHub would have given it", () => {
    expect(slugify("8. Deliberately not building")).toBe("8-deliberately-not-building");
    expect(slugify("The layers")).toBe("the-layers");
    expect(slugify("`end` — what it does")).toBe("end--what-it-does");
  });

  it("takes ## through ####, and never a hash inside a fence", () => {
    const headings = headingsOf(
      ["# Title", "## One", "```", "## not a heading", "```", "### Two", "#### Three"].join("\n"),
    );
    expect(headings.map((h) => [h.depth, h.id])).toEqual([
      [2, "one"],
      [3, "two"],
      [4, "three"],
    ]);
  });

  it("gives a repeated heading its own anchor, as GitHub does", () => {
    expect(headingsOf("## Done when\n\n## Done when").map((h) => h.id)).toEqual([
      "done-when",
      "done-when-1",
    ]);
  });

  it("puts every anchor written in doc/ on a heading that exists", async () => {
    // The one check that matters: these anchors were written against the files
    // as GitHub renders them, and a projection that invents its own slugs
    // breaks them silently. `#### The layers` in `operating.md` is why `####`
    // gets an id at all.
    const files = await published();
    const headings = new Map<string, Set<string>>();
    for (const file of files) {
      const body = await readFile(path.join(docRoot, file), "utf8");
      headings.set(file, new Set(headingsOf(body).map((h) => h.id)));
    }

    const dangling: string[] = [];
    for (const file of files) {
      const body = await readFile(path.join(docRoot, file), "utf8");
      const slug = file.replace(/\.md$/, "");
      for (const [, href] of body.matchAll(/\]\(([^)\s]*#[^)\s]*)\)/g)) {
        if (href === undefined) continue;
        const resolved = resolveHref(slug, href, (f) => files.includes(f));
        if (!resolved.startsWith("#") && !resolved.startsWith("/docs/")) continue;
        const [route = "", anchor = ""] = resolved.split("#", 2);
        const target = route === "" ? file : `${route.slice("/docs/".length).replace(/\/$/, "")}.md`;
        if (headings.get(target)?.has(anchor) !== true) dangling.push(`${file} → ${href}`);
      }
    }
    expect(dangling, "an anchor in doc/ lands nowhere on the site").toEqual([]);
  });
});

describe("what a decision's page says about it", () => {
  it("takes the date from the file, and every decision states one", async () => {
    expect(decidedOn("# 0016\n\n**Status** accepted · 2026-09-02 · supersedes")).toBe("2026-09-02");
    expect(decidedOn("# A guide\n\nno date here")).toBeNull();

    const undated: string[] = [];
    for (const file of (await published()).filter((f) => f.startsWith("decisions/"))) {
      if (decidedOn(await readFile(path.join(docRoot, file), "utf8")) === null) undated.push(file);
    }
    expect(undated, "a decision that does not say when it was made").toEqual([]);
  });

  it("makes the decision a status names a link to it", async () => {
    const numbers = await decisionsByNumber();
    expect(numbers.get("0016")).toBe("decisions/0016-the-settled-model");

    const parts = statusParts("superseded by 0016", (n) => {
      const slug = numbers.get(n);
      return slug === undefined ? null : `/docs/${slug}/`;
    });
    expect(parts).toEqual([
      { text: "superseded by " },
      { text: "0016", href: "/docs/decisions/0016-the-settled-model/" },
    ]);
  });

  it("leaves a number that is not a decision as text", () => {
    expect(statusParts("accepted 2026", () => null)).toEqual([
      { text: "accepted " },
      { text: "2026" },
    ]);
  });

  it("carries the repository's sentence and does not restate it", async () => {
    const status = await statuses();
    // 0027 is in force and *supersedes* something; 0014 was replaced outright.
    // The difference is the repository's wording, so it has to survive the trip.
    expect(status.get("decisions/0027-the-lease-is-deleted")).toMatch(/^accepted/);
    expect(status.get("decisions/0014-one-loop-one-log")).toBe("superseded by 0016");
  });
});
