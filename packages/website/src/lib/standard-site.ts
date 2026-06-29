/**
 * Standard.site (https://standard.site) AT Protocol integration for the Lore
 * blog.
 *
 * The blog is modeled as a single `site.standard.publication` record plus one
 * `site.standard.document` record per post, stored in the `@withlore.ai`
 * Bluesky account's PDS.
 *
 * We use DETERMINISTIC record keys — the publication is `self`, each document
 * uses its post slug — so the AT-URIs are predictable. That lets the on-page
 * verification (`<link rel="site.standard.document">` and the `.well-known`
 * endpoint) be generated at build time without first reading back what the PDS
 * assigned, and makes publishing idempotent: `putRecord` upserts in place
 * rather than creating duplicates on re-runs.
 *
 * The records themselves are materialized by `scripts/publish-standard-site.mjs`,
 * which reads the build manifest emitted by `src/pages/standard-site.json.ts`.
 *
 * NOTE: this module is intentionally framework-free (no `astro:*` imports) so
 * it can be imported from `astro.config.mjs` at config-load time as well as
 * from page/endpoint code.
 *
 * If you change `PUBLICATION_DID` or `PUBLICATION_RKEY`, also update the static
 * verification file at `public/.well-known/site.standard.publication` (the
 * publish script asserts the two stay in sync before writing any record).
 */

/** DID of the `@withlore.ai` Bluesky account (resolved from the handle). */
export const PUBLICATION_DID = "did:plc:mnccz4sthqjuyugmzlfacnv7";

/** Record key of the singleton publication record. */
export const PUBLICATION_RKEY = "self";

/** Base URL combined with a document path to form its canonical URL. No trailing slash. */
export const SITE_URL = "https://withlore.ai";

export const PUBLICATION_NAME = "Lore Blog";
export const PUBLICATION_DESCRIPTION =
  "Product notes, engineering updates, and memory architecture deep dives from Lore.";

const PUBLICATION_COLLECTION = "site.standard.publication";
const DOCUMENT_COLLECTION = "site.standard.document";

/** AT-URI of the publication record. */
export function publicationUri(): string {
  return `at://${PUBLICATION_DID}/${PUBLICATION_COLLECTION}/${PUBLICATION_RKEY}`;
}

/**
 * AT Protocol record-key syntax: 1–512 chars from `[A-Za-z0-9._~:-]`, and never
 * `.` or `..`. See https://atproto.com/specs/record-key.
 */
const RECORD_KEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/;

/**
 * Documents are keyed by their post slug for stable, idempotent AT-URIs.
 *
 * Astro derives the slug from the file path and keeps `/` for nested
 * directories plus any unicode letters — both illegal in a record key. Rather
 * than silently mangle the slug (which would desync the on-page `<link>` from
 * the published record), fail the build loudly so a problematic slug is a
 * deliberate decision, not a broken AT-URI / rejected PDS write.
 */
export function documentRkey(slug: string): string {
  if (slug === "." || slug === ".." || !RECORD_KEY_RE.test(slug)) {
    throw new Error(
      `Blog slug "${slug}" is not a valid AT Protocol record key ` +
        "(allowed: 1–512 chars of A–Z a–z 0–9 . _ ~ : - ; not '.' or '..'). " +
        "Rename the post file or add an explicit slug mapping in standard-site.ts.",
    );
  }
  return slug;
}

/** AT-URI of a document record. */
export function documentUri(slug: string): string {
  return `at://${PUBLICATION_DID}/${DOCUMENT_COLLECTION}/${documentRkey(slug)}`;
}

/** Site-relative path for a post; combined with `SITE_URL` to form its URL. */
export function documentPath(slug: string): string {
  return `/blog/${slug}/`;
}

interface RgbColor {
  $type: "site.standard.theme.color#rgb";
  r: number;
  g: number;
  b: number;
}

function rgb(r: number, g: number, b: number): RgbColor {
  return { $type: "site.standard.theme.color#rgb", r, g, b };
}

// Lore blog palette (see public/theme.css): cream surface, deep-green ink and
// accent. Mirrors the rendered blog so reader apps keep the site's identity.
const BASIC_THEME = {
  $type: "site.standard.theme.basic" as const,
  background: rgb(247, 242, 232), // --c0
  foreground: rgb(26, 46, 27), // --ink
  accent: rgb(26, 51, 32), // --g0
  accentForeground: rgb(247, 242, 232), // --c0
};

export interface PublicationRecord {
  $type: "site.standard.publication";
  url: string;
  name: string;
  description: string;
  basicTheme: typeof BASIC_THEME;
  preferences: { showInDiscover: boolean };
}

export function buildPublicationRecord(): PublicationRecord {
  return {
    $type: PUBLICATION_COLLECTION,
    url: SITE_URL,
    name: PUBLICATION_NAME,
    description: PUBLICATION_DESCRIPTION,
    basicTheme: BASIC_THEME,
    preferences: { showInDiscover: true },
  };
}

export interface DocumentInput {
  slug: string;
  title: string;
  description?: string;
  /** ISO 8601 timestamp. */
  publishedAt: string;
  /** ISO 8601 timestamp. */
  updatedAt?: string;
  tags?: string[];
  textContent?: string;
}

export interface DocumentRecord {
  $type: "site.standard.document";
  site: string;
  path: string;
  title: string;
  publishedAt: string;
  description?: string;
  updatedAt?: string;
  tags?: string[];
  textContent?: string;
}

export function buildDocumentRecord(input: DocumentInput): DocumentRecord {
  const record: DocumentRecord = {
    $type: DOCUMENT_COLLECTION,
    site: publicationUri(),
    path: documentPath(input.slug),
    title: input.title,
    publishedAt: input.publishedAt,
  };
  if (input.description) record.description = input.description;
  if (input.updatedAt) record.updatedAt = input.updatedAt;
  if (input.tags && input.tags.length > 0) record.tags = input.tags;
  if (input.textContent) record.textContent = input.textContent;
  return record;
}
