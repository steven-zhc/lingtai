import { defineConfig } from "vitest/config";

/**
 * The tests that need nothing.
 *
 * Separate from `vitest.config.ts` for one reason: that config has a
 * `globalSetup` which connects to Postgres to sweep the test log. A pure test
 * running under it would prove nothing about whether the code under test needs
 * a database, because the harness around it would have opened one.
 */
export default defineConfig({
  test: {
    include: ["pure/**/*.test.ts"],
  },
});
