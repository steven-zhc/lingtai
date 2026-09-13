import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One of these opens real connections and holds a listener for 1.5s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One file at a time: `conduct` appends a refusal that `doctor`'s "is
    // green" would read as red while both ran.
    fileParallelism: false,
    // Removes this run's throwaway `esctest*` projects from the test log. Without
    // it the residue outlives the run, and `lingtai doctor`'s own test — which
    // asserts the whole database is green — fails on rows an earlier package's
    // tests left behind. See the file for what that looked like.
    globalSetup: ["../../packages/event-store/test-support/teardown.ts"],
  },
});
