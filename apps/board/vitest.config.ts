import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The two things Next does for this app that a test runner does not.
 *
 * There was no config here while every test was a `.ts` file over `src/lib`.
 * A component test needs both of these, and #101 is the ticket that wanted one:
 * the payload was escaped in the *render*, so a test of the fold alone could
 * never have caught it.
 */
export default defineConfig({
  // `tsconfig.json` says `jsx: "preserve"` because Next compiles the JSX. There
  // is no Next here, so a `.tsx` test would fail to parse rather than to
  // assert.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
