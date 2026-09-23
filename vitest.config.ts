import { existsSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * One config, two projects, and the line between them is 0060 §1.
 *
 * > **A test is integration when it exercises a dependency outside the system.**
 * > Outside it: Postgres · the GitHub API · the `git` binary · any OS process ·
 * > the filesystem · the network · the real `$HOME` · the wall clock.
 *
 * `unit` is what the `build` gate runs, so a red there is a claim about the
 * diff. `integration` is everything else — including the whole of what used to
 * be `pnpm test:db`, and the 21 files that start a process.
 *
 * **The split is by directory, not by tag**, and that was measured rather than
 * assumed ([0060](doc/decisions/0060-the-gate-runs-unit-tests.md)'s last open
 * question): a file whose every test is tagged `@integration`, run under
 * `--tagsFilter '@unit'`, still threw from module scope and still failed the
 * run. A tag filters *tests*; the file is loaded to find them. For a file that
 * opens a pool at import or spawns in `beforeAll`, the tag buys nothing and the
 * cost is paid anyway.
 *
 * It replaces twenty `vitest*.config.ts` files run through `pnpm -r`, which
 * stopped at the first failing package and hid every package after it (#222).
 * One run reports every project.
 */

/**
 * `@/x` means *this app's `src/x`*, and two apps say so — `apps/board` and
 * `apps/site`, each in its own `tsconfig`. One `resolve.alias` cannot hold two
 * values for one key, so the alias is resolved against the importer's own
 * package instead of globally.
 */
function appAlias(): Plugin {
  return {
    name: "lingtai:app-alias",
    resolveId(source, importer) {
      if (!source.startsWith("@/") || !importer) return null;
      for (let dir = path.dirname(importer); dir !== path.dirname(dir); dir = path.dirname(dir)) {
        if (!existsSync(path.join(dir, "package.json"))) continue;
        return this.resolve(path.join(dir, "src", source.slice(2)), importer, { skipSelf: true });
      }
      return null;
    },
  };
}

const shared = {
  // The apps' `tsconfig` says `jsx: "preserve"` because Next compiles the JSX.
  // There is no Next here, so a `.tsx` test would fail to parse rather than to
  // assert (#101).
  oxc: { jsx: { runtime: "automatic" as const } },
  plugins: [appAlias()],
};

// `output: "standalone"` copies `apps/board` into `.next/standalone`, tests
// included (#183). The include globs below do not reach a nested copy, and this
// says so where a reader looking for it would look.
const exclude = [...configDefaults.exclude, "**/.next/**"];

export default defineConfig({
  ...shared,
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: "unit",
          include: ["{apps,packages}/*/unit/**/*.test.ts?(x)"],
          exclude,
          // Chosen, rather than vitest's 5000ms default — which is what refused
          // #215 and #196 on a loaded machine. Nothing here leaves the system,
          // so nothing here is waiting on anything; the bound is a bound on a
          // runaway, not on a round trip.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        ...shared,
        test: {
          name: "integration",
          include: ["{apps,packages}/*/integration/**/*.test.ts?(x)"],
          exclude,
          // A Supabase round trip, two `next build`s and a board started from
          // each (`apps/release`), a compiled hook on a real socket. None of it
          // is a 5s job.
          testTimeout: 180_000,
          hookTimeout: 600_000,
          // One file at a time: they share one `events` table, the cleanup hook
          // toggles a table-level rule, and `conduct` appends a refusal that
          // `doctor`'s "is green" would read as red while both ran.
          fileParallelism: false,
          // Removes this run's throwaway `esctest*` projects from the test log.
          // Without it the residue outlives the run, and `lingtai doctor`'s own
          // test — which asserts the whole database is green — fails on rows an
          // earlier file's tests left behind.
          globalSetup: ["./packages/event-store/test-support/teardown.ts"],
        },
      },
    ],
  },
});
