import rss from "@astrojs/rss";
import mdxRenderer from "@astrojs/mdx/server.js";
import type { APIContext } from "astro";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { getCollection, render } from "astro:content";

const MAX_ITEMS = 20;
const SITE = "https://withlore.ai";

// RSS readers need absolute URLs. Posts currently have no images, but bodies
// may contain root-relative links (e.g. /docs/...); rewrite them to absolute.
// Only double-quoted href/src are handled (Astro's output form); srcset and
// single-quoted attributes are not — extend if a post ever needs them.
// We intentionally do NOT use a global `build.assetsPrefix` (the guide's
// approach) because it would break the /_preview/pr-<n>/ base path and rewrite
// every docs asset to the production domain.
function absolutize(html: string): string {
  return html.replace(/(href|src)="\/(?!\/)/g, `$1="${SITE}/`);
}

// Minimal escaping for raw text we inject into customData (which @astrojs/rss
// does not escape for us). Author values come from trusted frontmatter, but
// escaping keeps the feed well-formed regardless.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function GET(context: APIContext) {
  // The Container API lets us render a post's compiled `Content` component to
  // an HTML string outside the page pipeline, so the feed carries full content.
  // Registering the MDX renderer is a no-op for the current `.md` posts and
  // keeps the feed working if a future post is authored as `.mdx`.
  // Note: this path surfaces an Astro-internal `markdown.gfm`/`markdown.smartypants`
  // deprecation warning (markdown-remark still reads the deprecated top-level
  // config); it is upstream, non-blocking, and not introduced by our code.
  const container = await AstroContainer.create();
  container.addServerRenderer({ renderer: mdxRenderer });

  const site = context.site ?? new URL(SITE);

  const posts = (await getCollection("blog"))
    .filter((post) => !post.data.draft)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
    .slice(0, MAX_ITEMS);

  return rss({
    title: "Lore Blog",
    description:
      "Product notes, engineering updates, and memory architecture deep dives from Lore.",
    site,
    xmlns: {
      atom: "http://www.w3.org/2005/Atom",
      dc: "http://purl.org/dc/elements/1.1/",
    },
    items: await Promise.all(
      posts.map(async (post) => {
        const { Content } = await render(post);
        const body = await container.renderToString(Content);
        return {
          title: post.data.title,
          pubDate: post.data.pubDate,
          description: post.data.description,
          link: new URL(`blog/${post.id}/`, site).toString(),
          categories: post.data.tags,
          content: absolutize(body),
          // RSS <author> expects an email address; a display name belongs in
          // Dublin Core's dc:creator.
          customData: `<dc:creator>${escapeXml(post.data.author)}</dc:creator>`,
        };
      }),
    ),
    customData: [
      "<language>en-us</language>",
      `<atom:link href="${new URL("rss.xml", site).toString()}" rel="self" type="application/rss+xml"/>`,
    ].join(""),
  });
}
