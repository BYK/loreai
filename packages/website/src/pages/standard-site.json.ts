import mdxRenderer from "@astrojs/mdx/server.js";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { getCollection, render } from "astro:content";
import {
  buildDocumentRecord,
  buildPublicationRecord,
  documentRkey,
  documentUri,
  PUBLICATION_RKEY,
  publicationUri,
} from "../lib/standard-site";

// Build-time export of the standard.site records for the blog. The publish
// script (scripts/publish-standard-site.mjs) reads this from dist/ and writes
// the records to the PDS, so the bytes that ship to AT Protocol are exactly
// what the site renders here — no second source of truth.

// Reduce rendered post HTML to plaintext for the document record's
// `textContent` (the lexicon wants plaintext, no markup). Best-effort for our
// authored posts, not a general HTML-to-text engine.
function htmlToText(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(
        /<\/(p|div|h[1-6]|li|blockquote|pre|tr|figure|section|header)>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;|&#x27;/gi, "'")
      // `&amp;` last so an escaped entity like `&amp;lt;` decodes to `&lt;`, not `<`.
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export async function GET() {
  // Container API renders a post's compiled `Content` to an HTML string outside
  // the page pipeline (same approach as rss.xml.ts). The MDX renderer is a
  // no-op for the current `.md` posts and keeps this working for future `.mdx`.
  const container = await AstroContainer.create();
  container.addServerRenderer({ renderer: mdxRenderer });

  const posts = (await getCollection("blog"))
    .filter((post) => !post.data.draft)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

  const documents = await Promise.all(
    posts.map(async (post) => {
      const { Content } = await render(post);
      const html = await container.renderToString(Content);
      const record = buildDocumentRecord({
        slug: post.id,
        title: post.data.title,
        description: post.data.description,
        publishedAt: post.data.pubDate.toISOString(),
        updatedAt: post.data.updatedDate?.toISOString(),
        tags: post.data.tags,
        textContent: htmlToText(html),
      });
      return { rkey: documentRkey(post.id), uri: documentUri(post.id), record };
    }),
  );

  const manifest = {
    publication: {
      rkey: PUBLICATION_RKEY,
      uri: publicationUri(),
      record: buildPublicationRecord(),
    },
    documents,
  };

  return new Response(`${JSON.stringify(manifest, null, 2)}\n`, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
