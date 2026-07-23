/**
 * OCI (GHCR-style) anonymous-pull client.
 *
 * Encapsulates the OCI download protocol for fetching binaries and patch
 * artifacts from a container registry (ghcr.io by default). Anonymous,
 * read-only: performs the standard token exchange, fetches manifests, lists
 * tags, and downloads blobs.
 *
 * Registry / repository / user-agent are all injected — no product coupling.
 * Generalized from Lore's `ghcr.ts`.
 *
 * Redirect quirk: ghcr.io blob downloads return a 307 to Azure Blob Storage.
 * Following the redirect automatically would forward the Authorization header
 * to Azure (→ 404), so redirects are followed manually WITHOUT the auth header.
 */

import { BinpatchError } from "../errors";

/** Default timeout for registry metadata requests (10s). */
const REQUEST_TIMEOUT = 10_000;

/** Retry attempts for transient failures. */
const MAX_RETRIES = 1;

/** Timeout for (larger) blob downloads (30s). */
const BLOB_TIMEOUT = 30_000;

/** Page size for tag-listing pagination. */
const TAGS_PAGE_SIZE = 100;

/** OCI manifest media type. */
const OCI_MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";

/** A single layer entry from an OCI manifest. */
export type OciLayer = {
  digest: string;
  mediaType: string;
  size: number;
  annotations?: Record<string, string>;
};

/** An OCI image manifest returned by the registry. */
export type OciManifest = {
  schemaVersion: number;
  mediaType?: string;
  config?: OciLayer;
  layers: OciLayer[];
  annotations?: Record<string, string>;
};

/** Configuration for an {@link OciClient}. */
export type OciClientConfig = {
  /** Registry base URL, e.g. `https://ghcr.io`. */
  registry: string;
  /** Repository path, e.g. `BYK/loreai`. */
  repo: string;
  /** User-Agent header sent on every request. */
  userAgent: string;
};

function isRetryableError(error: Error): boolean {
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return true;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  );
}

function buildSignal(
  timeout: number,
  externalSignal?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])
    : timeoutSignal;
}

function isExternalAbort(error: Error, externalSignal?: AbortSignal): boolean {
  return Boolean(externalSignal?.aborted && error.name === "AbortError");
}

/**
 * An OCI registry client bound to one registry + repository. All methods are
 * anonymous (read-only). Every method accepts an optional AbortSignal.
 */
export class OciClient {
  private readonly registry: string;
  private readonly repo: string;
  private readonly userAgent: string;

  constructor(config: OciClientConfig) {
    this.registry = config.registry;
    this.repo = config.repo;
    this.userAgent = config.userAgent;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    context: string,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<Response> {
    const timeout = options?.timeout ?? REQUEST_TIMEOUT;
    const externalSignal = options?.signal;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fetch(url, {
          ...init,
          signal: buildSignal(timeout, externalSignal),
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (isExternalAbort(lastError, externalSignal)) break;
        if (attempt >= MAX_RETRIES || !isRetryableError(lastError)) break;
      }
    }

    throw new BinpatchError(
      "network_error",
      `${context}: ${lastError?.message ?? "unknown error"}`,
    );
  }

  /** Exchange for a short-lived anonymous pull token. */
  async getAnonymousToken(signal?: AbortSignal): Promise<string> {
    const url = `${this.registry}/token?scope=repository:${this.repo}:pull`;
    const response = await this.fetchWithRetry(
      url,
      { headers: { "User-Agent": this.userAgent } },
      "Failed to connect to registry",
      { signal },
    );

    if (!response.ok) {
      throw new BinpatchError(
        "network_error",
        `Registry token exchange failed: HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as { token?: string };
    if (!data.token) {
      throw new BinpatchError(
        "network_error",
        "Registry token exchange returned no token",
      );
    }

    return data.token;
  }

  /** Fetch the OCI manifest for an arbitrary tag. */
  async fetchManifest(
    token: string,
    tag: string,
    signal?: AbortSignal,
  ): Promise<OciManifest> {
    const url = `${this.registry}/v2/${this.repo}/manifests/${tag}`;
    const response = await this.fetchWithRetry(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: OCI_MANIFEST_TYPE,
          "User-Agent": this.userAgent,
        },
      },
      `Failed to fetch manifest for tag "${tag}"`,
      { signal },
    );

    if (!response.ok) {
      throw new BinpatchError(
        "network_error",
        `Failed to fetch manifest for tag "${tag}": HTTP ${response.status}`,
      );
    }

    return (await response.json()) as OciManifest;
  }

  private async fetchTagPage(
    token: string,
    lastTag?: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    let url = `${this.registry}/v2/${this.repo}/tags/list?n=${TAGS_PAGE_SIZE}`;
    if (lastTag) {
      url += `&last=${encodeURIComponent(lastTag)}`;
    }

    const response = await this.fetchWithRetry(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent,
        },
      },
      "Failed to list registry tags",
      { signal },
    );

    if (!response.ok) {
      throw new BinpatchError(
        "network_error",
        `Failed to list registry tags: HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as { tags?: string[] };
    return data.tags ?? [];
  }

  /** List tags in the repository, optionally filtered by prefix. */
  async listTags(
    token: string,
    prefix?: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const allTags: string[] = [];
    let lastTag: string | undefined;

    for (;;) {
      const tags = await this.fetchTagPage(token, lastTag, signal);
      if (tags.length === 0) break;

      for (const tag of tags) {
        if (!prefix || tag.startsWith(prefix)) allTags.push(tag);
      }

      if (tags.length < TAGS_PAGE_SIZE) break;
      lastTag = tags.at(-1);
    }

    return allTags;
  }

  /**
   * Download a blob by digest. The registry returns a 3xx redirect to blob
   * storage; the redirect is followed manually without the auth header.
   */
  async downloadBlob(
    token: string,
    digest: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const blobUrl = `${this.registry}/v2/${this.repo}/blobs/${digest}`;

    let blobResponse: Response;
    try {
      blobResponse = await fetch(blobUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent,
        },
        redirect: "manual",
        signal: buildSignal(BLOB_TIMEOUT, signal),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new BinpatchError(
        "network_error",
        `Failed to connect to registry: ${msg}`,
      );
    }

    if (blobResponse.status === 200) return blobResponse;

    if (
      blobResponse.status === 301 ||
      blobResponse.status === 302 ||
      blobResponse.status === 307 ||
      blobResponse.status === 308
    ) {
      const redirectUrl = blobResponse.headers.get("location");
      if (!redirectUrl) {
        throw new BinpatchError(
          "network_error",
          `Registry blob redirect (${blobResponse.status}) had no Location header`,
        );
      }

      let redirectResponse: Response;
      try {
        redirectResponse = await fetch(redirectUrl, {
          headers: { "User-Agent": this.userAgent },
          signal,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new BinpatchError(
          "network_error",
          `Failed to download from blob storage: ${msg}`,
        );
      }

      if (!redirectResponse.ok) {
        throw new BinpatchError(
          "network_error",
          `Blob storage download failed: HTTP ${redirectResponse.status}`,
        );
      }

      return redirectResponse;
    }

    throw new BinpatchError(
      "network_error",
      `Unexpected registry blob response: HTTP ${blobResponse.status}`,
    );
  }

  /** Download a blob by digest as an ArrayBuffer. */
  async downloadBlobBuffer(
    token: string,
    digest: string,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const response = await this.downloadBlob(token, digest, signal);
    return response.arrayBuffer();
  }
}
