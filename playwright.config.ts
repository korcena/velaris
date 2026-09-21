import { defineConfig, devices } from "@playwright/test";

/**
 * E2E configuration.
 *
 * The webServer runs `next dev` against a dedicated E2E database
 * (db/velaris-e2e.db, gitignored with the other *.db files) so tests never
 * touch the developer's real database. VELARIS_DB_PATH takes precedence
 * over the .env.local value, and the web process auto-applies migrations
 * and seeds defaults on boot, so each run starts from a clean slate.
 */

const E2E_DB_PATH = "./db/velaris-e2e.db";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // shared DB between tests → sequential for determinism
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "html" : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: `rm -f ${E2E_DB_PATH} ${E2E_DB_PATH}-shm ${E2E_DB_PATH}-wal && VELARIS_DB_PATH=${E2E_DB_PATH} npm run dev:web`,
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VELARIS_DB_PATH: E2E_DB_PATH },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
