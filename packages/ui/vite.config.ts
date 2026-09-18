import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

// The gateway serves the built SPA under /ui and /ui/*; the dev server
// mirrors that prefix so client-side routes and asset URLs are identical in
// both modes. `LORE_UI_GATEWAY` points the /api proxy at a running gateway
// (default: the gateway's default port).
const gatewayOrigin = process.env.LORE_UI_GATEWAY ?? "http://127.0.0.1:3207";

export default defineConfig({
  base: "/ui/",
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: { "~": srcDir },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    modulePreload: { polyfill: false },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: gatewayOrigin, changeOrigin: false },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
