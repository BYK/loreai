import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

export const onRequest = defineRouteMiddleware((context) => {
  const path = context.url.pathname;
  const anchor = path.endsWith("/docs/configuration/")
    ? "field-reference"
    : path.endsWith("/docs/environment/")
      ? "setting-reference"
      : undefined;
  const toc = context.locals.starlightRoute.toc;
  if (!anchor || !toc) return;
  const index = toc.items.findIndex((item) => item.slug === anchor);
  if (index < 0) return;
  // ReferenceFinder keeps every field/category link available. Retain the shorter
  // chapter outline for both framework TOCs; do not alter headings or content.
  toc.items = toc.items
    .slice(0, index + 1)
    .map((item) => ({ ...item, children: [] }));
  toc.maxHeadingLevel = 2;
});
