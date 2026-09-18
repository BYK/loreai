import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.LORE_E2E_PORT ?? 7995);
const baseURL = `http://127.0.0.1:${port}`;

/**
 * Browser e2e for the Lore UI as served by the BUILT gateway (real /ui static
 * serving, real /api/v1 reads against a seeded throw-away database).
 *
 * Not part of the regular CI job — see .github/workflows/ui-e2e.yml (path
 * filtered PRs, nightly on main, manual dispatch). Locally:
 *   pnpm --filter @loreai/core build && pnpm --filter @loreai/gateway bundle
 *   pnpm --filter @loreai/ui exec playwright install chromium
 *   pnpm --filter @loreai/ui test:e2e
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  outputDir: "./e2e-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node e2e/gateway.mjs",
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { LORE_E2E_PORT: String(port) },
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
