import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No database and no network: every test here either calls a pure function
    // or spawns the CLI against an HTTP server on localhost. It is the one
    // package a third party could have written, so its suite needs nothing of
    // Lingtai's either.
    testTimeout: 30_000,
  },
});
