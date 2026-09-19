/**
 * Shape of the Lore UI asset manifest written by script/ui-assets.ts next to
 * the staged SPA files (dist/ui/ui-manifest.json) and read by ui-static.ts at
 * runtime — from disk beside the gateway bundle, or as a SEA asset in the
 * standalone binary. Shared by the build script and the server so the two
 * cannot drift.
 */

export const UI_MANIFEST_FILE = "ui-manifest.json";
export const UI_MANIFEST_VERSION = 1;
/** SEA asset keys for the staged UI files are `ui/<relative path>`. */
export const UI_SEA_ASSET_PREFIX = "ui/";

export type UiContentEncoding = "br" | "gzip";
export const UI_CONTENT_ENCODINGS: readonly UiContentEncoding[] = [
  "br",
  "gzip",
];

/** Filename suffix of the precompressed sibling for each encoding. */
export const UI_VARIANT_SUFFIX: Readonly<Record<UiContentEncoding, string>> = {
  br: ".br",
  gzip: ".gz",
};

export interface UiManifestFile {
  /** Content-Type header value. */
  type: string;
  /** Identity byte length. */
  size: number;
  /**
   * Precompressed variants present as `<path><suffix>` siblings, with their
   * byte lengths. Only encodings that beat identity are listed.
   */
  variants?: Partial<Record<UiContentEncoding, number>>;
}

export interface UiManifest {
  version: typeof UI_MANIFEST_VERSION;
  /** sha256 prefix over every file's path + identity bytes. */
  buildId: string;
  /** Keyed by path relative to /ui/ (POSIX separators). */
  files: Record<string, UiManifestFile>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate manifest JSON. Throws a descriptive error on any
 * structural problem so a truncated or foreign file can never be served as
 * if it were a manifest.
 */
export function parseUiManifest(text: string): UiManifest {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error("manifest is not an object");
  if (raw.version !== UI_MANIFEST_VERSION) {
    throw new Error(
      `unsupported manifest version ${String(raw.version)} (expected ${UI_MANIFEST_VERSION})`,
    );
  }
  if (typeof raw.buildId !== "string" || raw.buildId === "") {
    throw new Error("manifest has no buildId");
  }
  if (!isRecord(raw.files)) throw new Error("manifest has no files map");
  // Null prototype: a path such as "__proto__" or "constructor" must become a
  // plain own key, and lookups must never hit Object.prototype.
  const files: Record<string, UiManifestFile> = Object.create(null);
  for (const [path, entry] of Object.entries(raw.files)) {
    if (path === "" || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`manifest has an invalid path ${JSON.stringify(path)}`);
    }
    if (!isRecord(entry)) throw new Error(`manifest entry ${path} is invalid`);
    if (typeof entry.type !== "string" || entry.type === "") {
      throw new Error(`manifest entry ${path} has no content type`);
    }
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
      throw new Error(`manifest entry ${path} has an invalid size`);
    }
    const file: UiManifestFile = {
      type: entry.type,
      size: entry.size as number,
    };
    if (entry.variants !== undefined) {
      if (!isRecord(entry.variants)) {
        throw new Error(`manifest entry ${path} has invalid variants`);
      }
      const variants: Partial<Record<UiContentEncoding, number>> = {};
      for (const [encoding, size] of Object.entries(entry.variants)) {
        if (!UI_CONTENT_ENCODINGS.includes(encoding as UiContentEncoding)) {
          throw new Error(
            `manifest entry ${path} lists unknown encoding ${encoding}`,
          );
        }
        if (!Number.isSafeInteger(size) || (size as number) < 0) {
          throw new Error(
            `manifest entry ${path} has an invalid ${encoding} size`,
          );
        }
        variants[encoding as UiContentEncoding] = size as number;
      }
      file.variants = variants;
    }
    files[path] = file;
  }
  return { version: UI_MANIFEST_VERSION, buildId: raw.buildId, files };
}
