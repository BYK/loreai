import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: true,
  workers: 4,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:4331", reducedMotion: "reduce" },
  projects: [
    {
      name: "desktop-light",
      use: { viewport: { width: 1280, height: 900 }, colorScheme: "light" },
    },
    {
      name: "desktop-dark",
      use: { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
    },
    {
      name: "mobile-light",
      use: {
        viewport: { width: 320, height: 844 },
        colorScheme: "light",
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "mobile-dark",
      use: {
        viewport: { width: 320, height: 844 },
        colorScheme: "dark",
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "compact-light",
      use: { viewport: { width: 1024, height: 768 }, colorScheme: "light" },
    },
  ],
  webServer: {
    command: "pnpm build && node test/preview.mjs",
    url: "http://127.0.0.1:4331",
    reuseExistingServer: false,
    env: { PR_NUMBER: "" },
    timeout: 120_000,
  },
});
