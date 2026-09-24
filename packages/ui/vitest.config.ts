import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

// Browser-side unit tests (Solid components, router, copied UI primitives,
// API client). Runs under jsdom; no gateway, no database.
export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: { "~": srcDir },
    conditions: ["development", "browser"],
  },
  test: {
    name: "ui",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    server: {
      deps: {
        inline: ["@solidjs/router", "@kobalte/core", "solid-prevent-scroll"],
      },
    },
    testTimeout: 30_000,
    env: {
      NODE_ENV: "test",
    },
  },
});
