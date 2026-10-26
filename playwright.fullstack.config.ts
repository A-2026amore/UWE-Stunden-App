import { defineConfig, devices } from "@playwright/test";

/**
 * Full-stack browser tests (docs/testplan.md, "Full-Stack"): api-mode build of the
 * platform, served by the real Node API (STATIC_DIR) against a throwaway
 * PostgreSQL 16 with migrations + seed. Every worker (= every project) starts its
 * own database and API, so the projects never share data.
 *
 *   npx playwright test -c playwright.fullstack.config.ts --project desktop-chromium
 *
 * FULLSTACK_DIST=<dir> reuses an existing api-mode build instead of building.
 */
export default defineConfig({
  testDir: "tests/e2e/fullstack",
  // *.fullstack.ts (not *.spec.ts): the default playwright.config.ts (demo build) must not pick them up.
  testMatch: "**/*.fullstack.ts",
  globalSetup: "./tests/e2e/fullstack/support/global-setup.ts",
  // One stack per worker; tests inside a file share it and run in order.
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 10000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/fullstack" }]] : "list",
  outputDir: "test-results/fullstack",
  use: { trace: "retain-on-failure", locale: "de-DE", timezoneId: "Europe/Berlin" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-android", use: { ...devices["Pixel 7"] } },
  ],
});
