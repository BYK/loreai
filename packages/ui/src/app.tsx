import type { Component, ParentProps } from "solid-js";
import { lazy, createSignal, Show } from "solid-js";
import { A, type RouteDefinition, Router } from "@solidjs/router";

import { Browse } from "./routes/Browse";
import { WorkspaceProvider } from "./routes/workspace";
import { setGatewayAuthToken, type ApiClient } from "./lib/api";
import type { LoreUiDb } from "./db";
import { theme } from "./lib/theme";
import { useWorkspace } from "./routes/workspace";

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
    path: "/entities",
    component: lazy(() =>
      import("./routes/Entities").then((m) => ({ default: m.EntitiesList })),
    ),
  },
  {
    path: "/warming",
    component: lazy(() =>
      import("./routes/Operations").then((m) => ({ default: m.WarmingRoute })),
    ),
  },
  {
    path: "/costs",
    component: lazy(() =>
      import("./routes/Operations").then((m) => ({ default: m.CostsRoute })),
    ),
  },
  {
    path: "/model-usage",
    component: lazy(() =>
      import("./routes/Operations").then((m) => ({
        default: m.ModelUsageRoute,
      })),
    ),
  },
  {
    path: "/contradictions",
    component: lazy(() =>
      import("./routes/Contradictions").then((m) => ({
        default: m.ContradictionsRoute,
      })),
    ),
  },
  {
    path: "/promotions",
    component: lazy(() =>
      import("./routes/Promotions").then((m) => ({
        default: m.PromotionsRoute,
      })),
    ),
  },
  {
    path: "/team",
    component: lazy(() =>
      import("./routes/FolkManagement").then((m) => ({
        default: m.TeamRoute,
      })),
    ),
  },
  {
    path: "/conflicts",
    component: lazy(() =>
      import("./routes/FolkManagement").then((m) => ({
        default: m.ConflictsRoute,
      })),
    ),
  },
  {
    path: "/entities/:entityId",
    component: lazy(() =>
      import("./routes/Entities").then((m) => ({
        default: m.EntityDetailRoute,
      })),
    ),
  },
  {
    path: "/projects/:projectId/knowledge/:knowledgeId",
    component: () => <Browse view="entry" />,
  },
  { path: "/knowledge", component: () => <Browse view="all-knowledge" /> },
  { path: "/knowledge/:knowledgeId", component: () => <Browse view="entry" /> },
  {
    path: "/projects/:projectId/knowledge",
    component: () => <Browse view="knowledge-table" />,
  },
  {
    path: "/projects/:projectId/duplicates",
    component: () => <Browse view="duplicates" />,
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
    path: "/projects/:projectId/imports",
    component: () => <Browse view="imports" />,
  },
  {
    path: "/search",
    component: () => <Browse view="workspace-search" />,
  },
  {
    path: "/projects/:projectId/search",
    component: () => <Browse view="search" />,
  },
  { path: "/projects/:projectId", component: () => <Browse view="project" /> },
  ...devOnlyRoutes,
  { path: "*", component: NotFound },
];

const RemoteGatewayAuthGate: Component<ParentProps> = (props) => {
  const workspace = useWorkspace();
  const [token, setToken] = createSignal("");

  const connect = (event: SubmitEvent) => {
    event.preventDefault();
    const value = token().trim();
    if (!value) return;
    setGatewayAuthToken(value);
    setToken("");
    workspace.state.projects.list.reload();
  };

  return (
    <Show
      when={workspace.connection.state() === "unauthorized"}
      fallback={props.children}
    >
      <main
        class="mx-auto max-w-xl p-8 text-sm"
        data-testid="gateway-auth-gate"
      >
        <h1 class="text-lg font-semibold">Connect to your gateway</h1>
        <p class="mt-2 text-muted">
          Enter the LORE_GATEWAY_AUTH_TOKEN configured on this gateway to open
          its dashboard.
        </p>
        <form class="mt-6 grid gap-3" onSubmit={connect}>
          <label class="grid gap-2" for="gateway-token">
            <span>Gateway token</span>
            <input
              id="gateway-token"
              class="rounded border border-default bg-panel px-3 py-2"
              type="password"
              autocomplete="current-password"
              value={token()}
              onInput={(event) => setToken(event.currentTarget.value)}
              required
            />
          </label>
          <button
            class="w-fit rounded border border-default px-3 py-2"
            type="submit"
          >
            Connect
          </button>
          <p class="text-muted" role="status">
            {workspace.connection.detail()}
          </p>
        </form>
      </main>
    </Show>
  );
};

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
      <RemoteGatewayAuthGate>{props.children}</RemoteGatewayAuthGate>
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
