/**
 * Mandatory route-map wrapper.
 *
 * Every Lore route tree must be built through `buildRouteMap` rather than
 * Stricli's `buildRouteMap` directly, for the same reason `buildCommand` is
 * mandatory: one enforcement point for shared behavior (default command,
 * hidden-route metadata, future JSON/help wiring).
 */
import {
  buildRouteMap as buildStricliRouteMap,
  type RouteMap,
  type Command,
} from "@stricli/core";
import type { LoreCommandContext } from "../context";

export interface LoreRouteMapSpec<R extends string> {
  /** Document-level description (shown in `lore help` and JSON introspection). */
  brief: string;
  /** Optional longer description. */
  fullDescription?: string;
  /** Optional default child command. */
  defaultCommand?: R;
  /** Command tree, keyed by route name. */
  routes: Readonly<Record<R, Command<LoreCommandContext>>>;
  /** Optional override list of routes to hide from help listings. */
  hideRoute?: Readonly<Partial<Record<R, boolean>>>;
}

export function buildRouteMap<R extends string>(
  spec: LoreRouteMapSpec<R>,
): RouteMap<LoreCommandContext> {
  return buildStricliRouteMap<R, LoreCommandContext>({
    routes: spec.routes,
    defaultCommand: spec.defaultCommand,
    docs: {
      brief: spec.brief,
      fullDescription: spec.fullDescription,
      hideRoute: spec.hideRoute,
    },
  });
}
