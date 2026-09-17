import { defineConfig } from "vitest/config";

export default defineConfig({
  // Two `next build`s and a board started from each is not a 5s job.
  test: { testTimeout: 180_000, hookTimeout: 600_000 },
});
