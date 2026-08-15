/**
 * Stable release integrity metadata.
 *
 * Trust boundary: GitHub's HTTPS Releases API authenticates repository release
 * metadata and supplies a server-computed digest for the checksum asset. The
 * checksum asset then authenticates the decompressed platform binary. This is
 * not an offline publisher signature: compromise of GitHub or release-publish
 * credentials can still publish a self-consistent malicious release.
 */

import { createHash } from "node:crypto";
import {
  compareVersions,
  fetchWithUpgradeError,
  getGitHubHeaders,
  getPlatformBinaryName,
  GITHUB_RELEASES_URL,
} from "./binary";
import { UpgradeError } from "./errors";

export const RELEASE_CHECKSUMS_ASSET = "lore-checksums.txt";

/** Last stable release published before checksum assets became mandatory. */
export const LAST_LEGACY_STABLE_RELEASE = "0.40.0";

const SHA256_ASSET_DIGEST = /^sha256:([a-f0-9]{64})$/;
const CHECKSUM_LINE = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const MAX_CHECKSUM_METADATA_BYTES = 64 * 1024;

type GitHubReleaseAsset = {
  name?: string;
  browser_download_url?: string;
  digest?: string;
};

type GitHubRelease = {
  tag_name?: string;
  assets?: GitHubReleaseAsset[];
};

function isExpectedChecksumAssetUrl(url: string, tag: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname === "github.com" &&
      parsed.port === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.pathname ===
        `/BYK/loreai/releases/download/${encodeURIComponent(tag)}/${RELEASE_CHECKSUMS_ASSET}`
    );
  } catch {
    return false;
  }
}

export function stableReleaseRequiresChecksums(version: string): boolean {
  try {
    return compareVersions(version, LAST_LEGACY_STABLE_RELEASE) === 1;
  } catch {
    // Unknown stable tag shapes receive the strict policy, not a compatibility
    // bypass. Historical Lore releases all use semver.
    return true;
  }
}

function integrityError(message: string): UpgradeError {
  return new UpgradeError("execution_failed", message);
}

function parseExpectedChecksum(metadata: string, filename: string): string {
  if (!metadata.endsWith("\n")) {
    throw integrityError("Stable release checksum metadata is not canonical");
  }

  const entries = new Map<string, string>();
  for (const line of metadata.slice(0, -1).split("\n")) {
    const match = CHECKSUM_LINE.exec(line);
    if (!match?.[1] || !match[2]) {
      throw integrityError("Stable release checksum metadata is malformed");
    }
    if (entries.has(match[2])) {
      throw integrityError(
        `Stable release checksum metadata contains duplicate entry ${match[2]}`,
      );
    }
    entries.set(match[2], match[1]);
  }

  const checksum = entries.get(filename);
  if (!checksum) {
    throw integrityError(
      `Stable release checksum metadata has no entry for ${filename}`,
    );
  }
  return checksum;
}

/**
 * Fetch and authenticate the expected SHA-256 for this platform's stable
 * binary. Missing metadata is tolerated only for releases that predate the
 * checksum rollout.
 */
export async function fetchStableBinaryChecksum(
  version: string,
): Promise<string | null> {
  const required = stableReleaseRequiresChecksums(version);
  let response: Response;
  try {
    response = await fetchWithUpgradeError(
      `${GITHUB_RELEASES_URL}/tags/${encodeURIComponent(version)}`,
      { headers: getGitHubHeaders() },
      "GitHub",
    );
  } catch (error) {
    if (!required) return null;
    throw error;
  }

  if (!response.ok) {
    if (!required) return null;
    throw integrityError(
      `Could not fetch checksum metadata for stable release ${version}: HTTP ${response.status}`,
    );
  }

  let release: GitHubRelease;
  try {
    release = (await response.json()) as GitHubRelease;
  } catch {
    throw integrityError("Stable release metadata is not valid JSON");
  }
  if (release.tag_name !== version && release.tag_name !== `v${version}`) {
    throw integrityError(
      `Stable release metadata tag does not match requested version ${version}`,
    );
  }

  const asset = release.assets?.find(
    (candidate) => candidate.name === RELEASE_CHECKSUMS_ASSET,
  );
  if (!asset) {
    if (!required) return null;
    throw integrityError(
      `Stable release ${version} is missing required checksum metadata`,
    );
  }
  if (!asset.browser_download_url) {
    throw integrityError(
      "Stable release checksum metadata has no download URL",
    );
  }
  if (
    !release.tag_name ||
    !isExpectedChecksumAssetUrl(asset.browser_download_url, release.tag_name)
  ) {
    throw integrityError(
      "Stable release checksum metadata has an invalid download URL",
    );
  }
  const expectedMetadataDigest = SHA256_ASSET_DIGEST.exec(
    asset.digest ?? "",
  )?.[1];
  if (!expectedMetadataDigest) {
    throw integrityError(
      "Stable release checksum metadata has no authenticated SHA-256 asset digest",
    );
  }

  const metadataResponse = await fetchWithUpgradeError(
    asset.browser_download_url,
    { headers: getGitHubHeaders() },
    "GitHub",
  );
  if (!metadataResponse.ok) {
    throw integrityError(
      `Failed to download stable release checksum metadata: HTTP ${metadataResponse.status}`,
    );
  }
  const declaredLength = Number(metadataResponse.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_CHECKSUM_METADATA_BYTES
  ) {
    throw integrityError("Stable release checksum metadata is too large");
  }
  const metadataBytes = new Uint8Array(await metadataResponse.arrayBuffer());
  if (metadataBytes.byteLength > MAX_CHECKSUM_METADATA_BYTES) {
    throw integrityError("Stable release checksum metadata is too large");
  }
  const actualMetadataDigest = createHash("sha256")
    .update(metadataBytes)
    .digest("hex");
  if (actualMetadataDigest !== expectedMetadataDigest) {
    throw integrityError(
      `Stable release checksum metadata digest mismatch: got ${actualMetadataDigest}, expected ${expectedMetadataDigest}`,
    );
  }

  let metadata: string;
  try {
    metadata = new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes);
  } catch {
    throw integrityError("Stable release checksum metadata is not valid UTF-8");
  }
  return parseExpectedChecksum(metadata, getPlatformBinaryName());
}
