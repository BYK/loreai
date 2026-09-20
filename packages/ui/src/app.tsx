import type { Component, ParentProps } from "solid-js";
import { lazy } from "solid-js";
import { A, type RouteDefinition, Router } from "@solidjs/router";

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
 *
 * Both are `lazy()`: a static import here would put their modules in the
 * product entry's graph, and any library they share with a product chunk
 * (the virtualiser, the rendering engines) would then be hoisted into the
 * entry rather than staying in that chunk.
 */
const compatSmoke = () => import("./compat/CompatSmoke");
const devOnlyRoutes: RouteDefinition[] = import.meta.env.DEV
  ? [
      {
        path: "/fixture",
        component: lazy(() =>
          import("./routes/Fixture").then((m) => ({ default: m.Fixture })),
        ),
      },
      {
        path: "/_compat",
        component: lazy(() =>
          compatSmoke().then((m) => ({ default: m.CompatSmoke })),
        ),
        children: [
          {
            path: "/",
            component: lazy(() =>
              compatSmoke().then((m) => ({ default: m.RouteIndex })),
            ),
          },
          {
            path: "/a",
            component: lazy(() =>
              compatSmoke().then((m) => ({ default: m.probeRoute("a") })),
            ),
          },
          {
            path: "/b",
            component: lazy(() =>
              compatSmoke().then((m) => ({ default: m.probeRoute("b") })),
            ),
          },
        ],
      },
    ]
  : [];

export const routes: RouteDefinition[] = [
  { path: "/", component: () => <Browse view="welcome" /> },
  {
    path: "/projects/:projectId/knowledge/:knowledgeId",
    component: () => <Browse view="entry" />,
  },
  { path: "/knowledge/:knowledgeId", component: () => <Browse view="entry" /> },
  {
    path: "/projects/:projectId/knowledge",
    component: () => <Browse view="knowledge-table" />,
  },
  {
    path: "/projects/:projectId/sessions/:sessionId",
    component: lazy(() =>
      import("./routes/Session").then((m) => ({ default: m.Session })),
    ),
  },
  {
    path: "/projects/:projectId/sessions",
    component: () => <Browse view="sessions" />,
  },
  {
    path: "/projects/:projectId/search",
    component: () => <Browse view="search" />,
  },
  { path: "/projects/:projectId", component: () => <Browse view="project" /> },
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
