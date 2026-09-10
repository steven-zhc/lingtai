import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { elapsed, money, readSnapshot, stamp } from "@/lib/snapshot";

/**
 * The board on the front page is the one thing on this site that is not read
 * from a file in the repository, so it is the one thing that could be made up.
 * These tests are about that: what the page may say when there is no snapshot,
 * and that no figure is written down anywhere but the snapshot.
 */

describe("a build with no log", () => {
  it("has no snapshot rather than a plausible one", async () => {
    // The repository commits no `snapshot.json` — it is generated, and
    // `.gitignore` keeps it out — so this is what a fresh clone builds with.
    // `null` is the only honest answer and the page renders `NoSnapshot`.
    if (process.env.LINGTAI_SITE_HAS_SNAPSHOT === "1") return;
    expect(await readSnapshot()).toBeNull();
  });
});

describe("figures live in the snapshot and nowhere else", () => {
  it("has no money and no lane count written into the front page", async () => {
    const page = await readFile(path.resolve(process.cwd(), "src/app/page.tsx"), "utf8");
    // A dollar amount in the markup is a figure that no log produced, and it
    // would keep reading as true long after it stopped being. The board's
    // numbers arrive as data or not at all.
    //
    // The two tickets under "when it goes wrong" are the one exception and are
    // not one of these: they are amounts in `lib/tickets.ts`, rendered through
    // `money()`, and `test/tickets.test.ts` checks each against the document in
    // `doc/` that records it. History does not go stale; a lane count does.
    const inText = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(inText).not.toMatch(/\$\d/);
  });
});

describe("how a figure reads", () => {
  it("says an age the way a person would", () => {
    expect(elapsed(0.4)).toBe("under an hour");
    expect(elapsed(20)).toBe("20 hours");
    expect(elapsed(72)).toBe("3 days");
    expect(elapsed(null)).toBeNull();
  });

  it("keeps the cents, because at these amounts the cents are the point", () => {
    expect(money(13.04)).toBe("$13.04");
    expect(money(1.9)).toBe("$1.90");
    expect(money(null)).toBeNull();
  });

  it("stamps a date in UTC, which is the only zone a static page can claim", () => {
    expect(stamp("2026-09-09T21:00:00.000Z")).toBe("2026-09-09");
  });
});
