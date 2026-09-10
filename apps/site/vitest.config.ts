import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The site's tests are over `src/lib` — the docs projection and the snapshot
 * reader — and neither renders. The alias is here because the modules under
 * test import each other through it, and `jsx` is here for the day one of them
 * does.
 */
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
