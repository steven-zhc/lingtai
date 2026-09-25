import type { NextConfig } from "next";

/**
 * A static export, and that is the load-bearing line in this file.
 *
 * The site's hero is Lingtai's own board, and the temptation is to render it
 * live. A marketing page holding a connection to the event store is a coupling
 * (the site goes down when the database does) and an exposure (one of the
 * projects on that board is private). `output: "export"` makes it *impossible*
 * rather than merely discouraged: there is no server at the other end of a
 * request, so a page cannot grow a query later without this line being deleted
 * first, deliberately, by somebody who has to explain why.
 *
 * The board's figures therefore arrive the other way round — `scripts/snapshot.ts`
 * reads the log once at build time and writes a file, and the page reads the
 * file. See `src/lib/snapshot.ts` for what is in it and what is withheld.
 */
const config: NextConfig = {
  // Next writes an `AGENTS.md` and a `CLAUDE.md` into this directory on every
  // start, describing its own conventions. Two of them were committed here
  // before anybody noticed, and a directory-level `CLAUDE.md` is read as
  // project instructions by an agent working in it — so a generated file
  // becomes an instruction nobody wrote. Every agent in this repository
  // commits with `git add -A`, which is how they get in.
  agentRules: false,
  output: "export",
  // The whole point of an export is a directory of files; `/docs/tutorial/`
  // wants to be a directory with an `index.html` in it so any static host
  // serves it without rewrite rules.
  trailingSlash: true,
  // No image optimiser exists in an export. The only images here are the mark,
  // which is drawn from CSS anyway.
  images: { unoptimized: true },
};

export default config;
