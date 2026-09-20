import type { Component, ParentProps } from "solid-js";
import { lazy } from "solid-js";
import { A, type RouteDefinition, Router } from "@solidjs/router";

import { compatRoutes } from "./compat/CompatSmoke";
import { Browse } from "./routes/Browse";
import { WorkspaceProvider } from "./routes/workspace";
import type { ApiClient } from "./lib/api";
import type { LoreUiDb } from "./db";
import { theme } from "./lib/theme";

/** Router base: the gateway serves the SPA under /ui with history fallback. */
export const ROUTER_BASE = "/ui";

const NotFound: Component = () => (
  <main class="mx-auto max-w-xl p-8 text-sm" data-testid="not-found">
    <h1 class="text-lg font-semibold">Page not found</h1>
    <p class="mt-2 text-muted">
      Nothing is served at this address.{" "}
      <A href="/" class="underline">
        Back to projects
      </A>
    </p>
  </main>
);

/**
 * Dev/test-only screens: the design specimen and the UI-01 compatibility
 * smoke. Production builds drop them (and their chunks) from the route table,
 * so the shipped bundle contains product routes only; the Vite dev server
 * and the unit/e2e suites still mount them.
 */
const devOnlyRoutes: RouteDefinition[] = import.meta.env.DEV
  ? [
      {
        path: "/fixture",
        // Lazy so the specimen's rendering engines (Markdown, highlighter,
        // sanitiser) form their own chunk and stay out of the product entry.
        component: lazy(() =>
          import("./routes/Fixture").then((m) => ({ default: m.Fixture })),
        ),
      },
      compatRoutes,
    ]
  : [];

export const routes: RouteDefinition[] = [
  {
    // One route definition so the shell instance (and its loaded lists)
    // survives moving between project, list and entry URLs.
    path: [
      "/",
      "/projects/:projectId",
      "/projects/:projectId/knowledge/:knowledgeId",
      "/knowledge/:knowledgeId",
    ],
    component: Browse,
  },
  ...devOnlyRoutes,
  { path: "*", component: NotFound },
];

/**
 * Router root: provides the workspace (project list + connection state) to
 * every route. `client` is injected by tests; production uses the
 * same-origin client.
 */
export function createAppRoot(
  client?: ApiClient,
  db?: Promise<LoreUiDb | null>,
): Component<ParentProps> {
  return (props) => (
    <WorkspaceProvider client={client} db={db}>
      {props.children}
    </WorkspaceProvider>
  );
}

export const App: Component = () => {
  theme(); // apply the persisted/system theme before first paint
  return (
    <Router base={ROUTER_BASE} root={createAppRoot()}>
      {routes}
    </Router>
  );
};
