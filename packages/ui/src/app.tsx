import type { Component } from "solid-js";
import { A, type RouteDefinition, Router } from "@solidjs/router";

import { compatRoutes } from "./compat/CompatSmoke";

/** Router base: the gateway serves the SPA under /ui (UI-02 wires the shell). */
export const ROUTER_BASE = "/ui";

const Landing: Component = () => (
  <main class="mx-auto max-w-xl p-8 text-sm">
    <h1 class="text-xl font-semibold tracking-tight">Lore UI</h1>
    <p class="mt-2 text-muted">
      UI-01: compatibility smoke project. The memory browser shell arrives in
      UI-02.
    </p>
    <p class="mt-4">
      <A href="/_compat" class="underline">
        Open the compatibility smoke page
      </A>
    </p>
  </main>
);

const NotFound: Component = () => (
  <main class="mx-auto max-w-xl p-8 text-sm">
    <h1 class="text-lg font-semibold">Not found</h1>
    <p class="mt-2 text-muted">
      <A href="/" class="underline">
        Back to start
      </A>
    </p>
  </main>
);

export const routes: RouteDefinition[] = [
  { path: "/", component: Landing },
  compatRoutes,
  { path: "*", component: NotFound },
];

export const App: Component = () => (
  <Router base={ROUTER_BASE}>{routes}</Router>
);
