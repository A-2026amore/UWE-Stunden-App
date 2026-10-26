import { defineConfig, devices } from "@playwright/test";

// Two local servers: the unchanged legacy app (repo root) and the new platform build preview.
export default defineConfig({
  testDir: "tests/e2e",
  // Legacy tests: tests/e2e/legacy (port 4173). Platform tests: tests/e2e/platform (port 4174).
  testIgnore: process.env.PW_PLATFORM === "0" ? ["platform/**"] : [],
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure", locale: "de-DE", timezoneId: "Europe/Berlin" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-android", use: { ...devices["Pixel 7"] } },
    // WebKit approximates iPhone Safari; real-device tests are still required (see docs/testplan.md).
    { name: "mobile-iphone", use: { ...devices["iPhone 14"] } },
  ],
  webServer: [
    { command: "node scripts/serve-static.mjs . 4173", url: "http://127.0.0.1:4173/index.html", reuseExistingServer: !process.env.CI },
    // PW_PLATFORM=0 skips the platform build (e.g. when only legacy tests run).
    ...(process.env.PW_PLATFORM === "0" ? [] : [
      { command: "npm run build && npm run preview -- --port 4174 --strictPort", url: "http://127.0.0.1:4174/", reuseExistingServer: !process.env.CI, timeout: 120000 },
    ]),
  ],
});
