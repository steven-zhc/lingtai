import { defineConfig } from "vitest/config";

/**
 * The tests that need no Postgres.
 *
 * Separate from `vitest.config.ts` for one reason, which `conductor` wrote down
 * first: that config has a `globalSetup` which connects to the database to sweep
 * the test log. A test running under it would prove nothing about whether the
 * code under test needs one, because the harness around it would have opened it.
 *
 * Which files belong here was decided by running each one with the database
 * pointed at a dead address — not by reading imports, which do not show what a
 * module reaches through three of them (#158).
 */
export default defineConfig({
  test: {
    include: ["pure/**/*.test.ts?(x)"],
  },
});
