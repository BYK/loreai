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
  plugins: [
    {
      name: "lore-ui-base-redirect",
      configureServer(server) {
        // The router's home href is /ui; Vite requires the trailing slash on a
        // direct request. Preserve chooser/search queries when refreshing it.
        server.middlewares.use((request, response, next) => {
          const url = request.url ?? "";
          if (
            (request.method === "GET" || request.method === "HEAD") &&
            (url === "/ui" || url.startsWith("/ui?"))
          ) {
            response.statusCode = 307;
            response.setHeader("Location", `/ui/${url.slice(3)}`);
            response.end();
            return;
          }
          next();
        });
      },
    },
    solid(),
    tailwindcss(),
  ],
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
