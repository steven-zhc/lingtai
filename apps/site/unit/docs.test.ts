import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCS_PUBLIC,
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
  slugOf,
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

  it("serves a directory's index.md at the directory", async () => {
    // `/docs/plugins/` and not `/docs/plugins/index/`, which is the route a
    // person guesses when they take a segment off a plugin's page. The pair
    // round-trips, because `generateStaticParams` builds the route `slugOf`
    // gives and the page reads it back with `fileOf`.
    expect(slugOf("plugins/index.md")).toBe("plugins");
    expect(fileOf("plugins")).toBe("plugins/index.md");
    expect(await published()).toContain("plugins/index.md");
  });

  it("does not publish the plugin page template, and does not hide it either", async () => {
    // A leading underscore is the one convention `markdownIn` reads: the
    // template is a shape to fill in, and published it would be a page whose
    // every section is an instruction about a different one. `unpublished()`
    // still names it, so the index links to it on GitHub rather than dropping
    // it — the cost of an allow-list, paid out loud.
    expect(await published()).not.toContain("plugins/_template.md");
    expect(await unpublished()).toContain("plugins/_template.md");
  });
});

describe("the tutorial stays a first-run path", () => {
  it("keeps the beginner path short and in order", async () => {
    const body = await readFile(path.join(docRoot, "tutorial.md"), "utf8");
    const words = body.trim().split(/\s+/).length;
    expect(words, "the tutorial has become a reference manual again").toBeLessThan(1400);
    expect(headingsOf(body).filter((h) => h.depth === 2).map((h) => h.text)).toEqual([
      "Before you start",
      "Step 1 — Set up this machine",
      "Step 2 — Add one repository",
      "Step 3 — Check the queue, then start",
      "Step 4 — Label one issue",
      "Step 5 — Read the result",
      "Next: make it yours",
    ]);
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
    //
    // 0016's cell is no longer the bare word: 0036 and 0037 each took a section
    // of it, and the index now names which. What is in force is that it still
    // *starts* accepted — the shape the 0027 assertion below already uses.
    expect(status.get("decisions/0014-one-loop-one-log")).toMatch(/superseded/);
    expect(status.get("decisions/0016-the-settled-model")).toMatch(/^accepted/);
    // 0057 is built — `StepDidNotFinish` is in `packages/actions/src/action.ts`
    // and the state is drawn by the task view. Its §4 retry is not, and that is
    // the index's cell to say (`#234`): built is not the same as *every section
    // in force*.
    // The index went on saying *implementation pending* after it landed, and
    // `statusParts` carries that cell word for word onto the decisions page, so
    // a reader was told on the site to go and build what was already merged.
    expect(status.get("decisions/0057-a-gate-that-did-not-finish")).not.toMatch(/pending/);
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
    expect(resolveHref("decisions/0022-the-seams.md", "0016-the-settled-model.md", isPublished)).toBe(
      "/docs/decisions/0016-the-settled-model/",
    );
    expect(resolveHref("tutorial.md", "decisions/0022-the-seams.md", isPublished)).toBe(
      "/docs/decisions/0022-the-seams/",
    );
    expect(resolveHref("decisions/0022-the-seams.md", "../tutorial.md", isPublished)).toBe(
      "/docs/tutorial/",
    );
  });

  it("keeps the anchor", () => {
    expect(resolveHref("tutorial.md", "decisions/0022-the-seams.md#the-seams", isPublished)).toBe(
      "/docs/decisions/0022-the-seams/#the-seams",
    );
  });

  it("sends a link to source code to the repository, where the code is", () => {
    expect(
      resolveHref("decisions/0016-the-settled-model.md", "../../packages/domain/src/events.ts", isPublished),
    ).toBe(`${GITHUB_BLOB}packages/domain/src/events.ts`);
  });

  it("sends a link to a document nobody projected to the repository too", () => {
    expect(resolveHref("tutorial.md", "research/market-opportunities.md", isPublished)).toBe(
      `${GITHUB_BLOB}doc/research/market-opportunities.md`,
    );
  });

  it("sends architecture.html to the copy the build made, or to GitHub while docs are private", () => {
    expect(resolveHref("decisions/0022-the-seams.md", "../architecture.html", isPublished)).toBe(
      DOCS_PUBLIC ? "/doc/architecture.html" : `${GITHUB_BLOB}doc/architecture.html`,
    );
  });

  it("leaves an absolute link and a bare anchor alone", () => {
    expect(resolveHref("tutorial.md", "https://github.com/x", isPublished)).toBe("https://github.com/x");
    expect(resolveHref("tutorial.md", "#done-when", isPublished)).toBe("#done-when");
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
      for (const [, href] of body.matchAll(/\]\(([^)\s]*#[^)\s]*)\)/g)) {
        if (href === undefined) continue;
        const resolved = resolveHref(file, href, (f) => files.includes(f));
        if (!resolved.startsWith("#") && !resolved.startsWith("/docs/")) continue;
        const [route = "", anchor = ""] = resolved.split("#", 2);
        // `fileOf` back from the route, and not `${route}.md`: a directory's
        // `index.md` is served at the directory, so the arithmetic that assumed
        // one route per `.md` path would look for `plugins.md` and find nothing.
        const target = route === "" ? file : fileOf(route.slice("/docs/".length).replace(/\/$/, ""));
        if (target === null || headings.get(target)?.has(anchor) !== true) {
          dangling.push(`${file} → ${href}`);
        }
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
