import { describe, expect, it } from "vitest";
import {
  entriesOf,
  fileOf,
  GITHUB_BLOB,
  ledeOf,
  published,
  resolveHref,
  SECTIONS,
  statuses,
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
    expect(status.get("decisions/0016-the-settled-model")).toBe("accepted");
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
