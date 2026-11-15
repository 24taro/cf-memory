import { defineConfig } from "vitest/config";

// Unit, D1/Miniflare isolation, and client-to-MCP lifecycle regression tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
    // The default 5 s is too short for the D1/Miniflare suites on a two-core CI runner.
    testTimeout: 30000,
  },
});
