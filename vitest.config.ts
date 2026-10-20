import { defineConfig } from "vitest/config";

// Native addons are loaded into forked worker processes so a crash in one test file
// cannot take down the whole run. The global setup starts the local HTTPS test server
// (test/support/server.py) once for the whole run.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/support/global-setup.ts"],
    pool: "forks",
    testTimeout: 30_000,
  },
});
