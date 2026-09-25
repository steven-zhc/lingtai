import type { NextConfig } from "next";

const config: NextConfig = {
  // Next writes an `AGENTS.md` and a `CLAUDE.md` into this directory on every
  // start, describing its own conventions. Two of them were committed here
  // before anybody noticed, and a directory-level `CLAUDE.md` is read as
  // project instructions by an agent working in it — so a generated file
  // becomes an instruction nobody wrote. Every agent in this repository
  // commits with `git add -A`, which is how they get in.
  agentRules: false,
  // Localhost, one user. See doc/decisions/0008-nextjs.md for why there is no
  // auth here and what has to change before that stops being true.
  // Every workspace package the board reaches. They ship as TypeScript source
  // with no build step (doc/decisions/0010), so Turbopack compiles them here.
  transpilePackages: [
    "@lingtai/conductor",
    "@lingtai/recipe",
    "@lingtai/domain",
    "@lingtai/env",
    "@lingtai/github",
    "@lingtai/event-store",
  ],
  // What `pnpm build` ships (#183, 0049): a `server.js` and only the files it
  // traces, rather than a tree that needs `pnpm install` beside it.
  output: "standalone",
  // Without this the board would optimise images with `sharp`, whose only file
  // is a `.node` built for one platform. The board renders `next/image`
  // nowhere, so it costs nothing. It does not stop Next's own server trace
  // naming sharp — `apps/release/src/build.ts` prunes that, and its test fails
  // if a `.node` file is left in the output.
  images: { unoptimized: true },
  // The build id is a directory name under `.next/static/`, and Next's default
  // is random — so two builds of one commit were two layouts. `pnpm build`
  // passes the commit; `next build` alone keeps the default.
  generateBuildId: () => process.env["LINGTAI_BUILD_ID"] ?? null,
};

export default config;
