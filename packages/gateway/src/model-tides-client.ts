/**
 * Model Tides contribution client (#2026 PR3): a verbatim-behaviour port of
 * scripts/contribute.mjs from BYK/model-tides (publishSnapshot, getOwnedReport,
 * setSharing, reportVisibility, setAggregate, the delete/rotate requests and
 * the upload-response validation + rollback, minus gist support).
 *
 * Endpoint: `process.env.LORE_MODEL_TIDES_ENDPOINT` (read only so tests can
 * point at a local stub; deliberately not a config field) defaulting to
 * https://modeltides.dev/api/contributions. Nothing uploads automatically —
 * every call here is driven by an explicit confirmed UI request.
 */
import { brotliCompressSync } from "node:zlib";

import { modelUsage } from "@loreai/core";

export const MODEL_TIDES_ENDPOINT =
  process.env.LORE_MODEL_TIDES_ENDPOINT ??
  "https://modeltides.dev/api/contributions";

/** Ported verbatim from model-tides scripts/contribute.mjs. */
export function uploadOSForPlatform(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

const publicUrlFor = (endpoint: string, id: string): string =>
  `${new URL(endpoint).origin}/u/${id}`;

export { publicUrlFor };

export interface UploadResponse {
  id?: unknown;
  published?: unknown;
  inAggregate?: unknown;
  metricVersion?: unknown;
  revision?: unknown;
  token?: unknown;
  url?: unknown;
}

/** Ported verbatim (behaviour) from contribute.mjs publishSnapshot. */
export async function publishSnapshot(
  snapshot: modelUsage.WeeklySnapshot,
  owner: modelUsage.ModelTidesOwner | null,
  options: {
    published?: boolean;
    inAggregate?: boolean;
    reviewedRevision?: number | null;
    os?: string | null;
    fetchImpl?: typeof fetch;
    endpoint?: string;
  } = {},
): Promise<UploadResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? MODEL_TIDES_ENDPOINT;
  const os =
    options.os === undefined
      ? uploadOSForPlatform(process.platform)
      : options.os;
  const published = options.published ?? null;
  const inAggregate = options.inAggregate ?? null;
  const reviewedRevision = options.reviewedRevision ?? null;
  if (
    owner &&
    (typeof published !== "boolean" || typeof inAggregate !== "boolean")
  ) {
    throw new TypeError("Expected report state.");
  }
  const migrating =
    !!owner && snapshot.version === 2 && reviewedRevision !== null;
  if (
    migrating &&
    (!Number.isSafeInteger(reviewedRevision) || reviewedRevision < 0)
  ) {
    throw new TypeError("Expected reviewed revision.");
  }
  if (os !== null && !["linux", "macos", "windows", "other"].includes(os)) {
    throw new TypeError("Invalid upload OS.");
  }
  const body = brotliCompressSync(Buffer.from(JSON.stringify(snapshot)));
  const response = await fetchImpl(
    owner
      ? `${endpoint}/${owner.id}${migrating ? "/migrate-v2" : ""}`
      : `${endpoint}/${snapshot.version === 2 ? "personal-v2" : "personal"}`,
    {
      method: owner ? "PUT" : "POST",
      headers: {
        "Content-Type": "application/vnd.model-tides.weekly+json",
        "Content-Encoding": "br",
        "X-Model-Tides-Schema": `weekly-v${snapshot.version}`,
        ...(os === null ? {} : { "X-Model-Tides-Upload-OS": os }),
        ...(!owner
          ? { "X-Model-Tides-Report": `personal-v${snapshot.version}` }
          : {}),
        ...(owner
          ? {
              Authorization: `Bearer ${owner.token}`,
              "X-Model-Tides-Expected-Visibility": published
                ? "public"
                : "private",
              "X-Model-Tides-Expected-Aggregate": inAggregate
                ? "included"
                : "excluded",
              ...(migrating
                ? {
                    "X-Model-Tides-Reviewed-Revision": String(reviewedRevision),
                  }
                : {}),
            }
          : {}),
      },
      body,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Upload failed (HTTP ${response.status}). No successful upload was confirmed; your local history is unchanged.`,
    );
  }
  return (await response.json()) as UploadResponse;
}

/** Ported verbatim (behaviour) from contribute.mjs getOwnedReport. */
export async function getOwnedReport(
  owner: modelUsage.ModelTidesOwner,
  options: { fetchImpl?: typeof fetch; endpoint?: string } = {},
): Promise<modelUsage.OwnedReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? MODEL_TIDES_ENDPOINT;
  try {
    const response = await fetchImpl(`${endpoint}/${owner.id}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
      cache: "no-store",
    });
    if (!response.ok) throw new TypeError("Unavailable report.");
    return modelUsage.parseOwnedReport(await response.json(), owner.id);
  } catch {
    throw new Error(
      "Could not confirm personal report visibility and counts. No sharing change was started.",
    );
  }
}

/** Ported verbatim (behaviour) from contribute.mjs setSharing. */
export async function setSharing(
  owner: modelUsage.ModelTidesOwner,
  published: boolean,
  options: {
    reviewed?: { snapshot: modelUsage.WeeklySnapshot; revision: number } | null;
    fetchImpl?: typeof fetch;
    endpoint?: string;
  } = {},
): Promise<UploadResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? MODEL_TIDES_ENDPOINT;
  const reviewed = options.reviewed ?? null;
  if (
    published &&
    (!reviewed ||
      !reviewed.snapshot ||
      !Number.isSafeInteger(reviewed.revision) ||
      reviewed.revision < 0)
  ) {
    throw new Error("Review every stored weekly count before sharing.");
  }
  const revision = reviewed?.revision;
  const response = await fetchImpl(
    `${endpoint}/${owner.id}/${published ? "share" : "unshare"}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        ...(published
          ? { "X-Model-Tides-Reviewed-Revision": String(revision) }
          : {}),
      },
    },
  ).catch(() => null);
  if (response && !response.ok) {
    throw new Error(
      "Sharing was rejected. Review the current report before retrying.",
    );
  }
  try {
    if (!response) throw new TypeError("Sharing response unavailable.");
    const result = (await response.json()) as UploadResponse;
    if (
      result.id !== owner.id ||
      result.published !== published ||
      (published && result.url !== publicUrlFor(endpoint, owner.id))
    ) {
      throw new TypeError("Invalid sharing response.");
    }
    return result;
  } catch {
    const current = await getOwnedReport(owner, {
      fetchImpl,
      endpoint,
    }).catch(() => null);
    if (!current) {
      throw new Error(
        "Could not confirm personal report visibility. The change may have happened; check before retrying.",
      );
    }
    if (
      current.published !== published ||
      (published &&
        (current.revision !== (revision ?? 0) + 1 ||
          JSON.stringify(current.snapshot) !==
            JSON.stringify(reviewed?.snapshot)))
    ) {
      throw new Error(
        `The personal report is ${current.published ? "public" : "hidden"}. The sharing change was not confirmed; review again before retrying.`,
      );
    }
    return {
      id: owner.id,
      published,
      ...(published ? { url: publicUrlFor(endpoint, owner.id) } : {}),
    };
  }
}

/** Ported verbatim (behaviour) from contribute.mjs reportVisibility. */
export async function reportVisibility(
  owner: modelUsage.ModelTidesOwner,
  options: { fetchImpl?: typeof fetch; endpoint?: string } = {},
): Promise<modelUsage.OwnedReport> {
  try {
    const report = await getOwnedReport(owner, options);
    if (report.inAggregate === null) {
      throw new TypeError("Unknown aggregate participation.");
    }
    return report;
  } catch {
    throw new Error(
      "Could not confirm personal report visibility and aggregate participation. No upload was started.",
    );
  }
}

/** Ported verbatim (behaviour) from contribute.mjs setAggregate. */
export async function setAggregate(
  owner: modelUsage.ModelTidesOwner,
  contribute: boolean,
  options: {
    reviewed?: { snapshot: modelUsage.WeeklySnapshot; revision: number } | null;
    fetchImpl?: typeof fetch;
    endpoint?: string;
  } = {},
): Promise<UploadResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? MODEL_TIDES_ENDPOINT;
  const reviewed = options.reviewed ?? null;
  if (
    contribute &&
    (!reviewed?.snapshot ||
      !Number.isSafeInteger(reviewed.revision) ||
      reviewed.revision < 0)
  ) {
    throw new Error("Review every stored weekly count before contributing.");
  }
  const response = await fetchImpl(
    `${endpoint}/${owner.id}/${contribute ? "contribute" : "withdraw"}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        ...(contribute
          ? {
              "X-Model-Tides-Reviewed-Revision": String(reviewed?.revision),
            }
          : {}),
      },
    },
  ).catch(() => null);
  if (response && !response.ok) {
    throw new Error(
      "Aggregate change was rejected. Review your current report before retrying.",
    );
  }
  try {
    if (!response) throw new TypeError("Aggregate response unavailable.");
    const result = (await response.json()) as UploadResponse;
    if (result.id !== owner.id || result.inAggregate !== contribute) {
      throw new TypeError("Invalid aggregate response.");
    }
    return result;
  } catch {
    const current = await getOwnedReport(owner, {
      fetchImpl,
      endpoint,
    }).catch(() => null);
    if (
      !current ||
      current.inAggregate !== contribute ||
      (contribute &&
        (current.revision !== (reviewed?.revision ?? 0) + 1 ||
          JSON.stringify(current.snapshot) !==
            JSON.stringify(reviewed?.snapshot)))
    ) {
      throw new Error(
        "Could not confirm the aggregate change. Check your report before retrying.",
      );
    }
    return { id: owner.id, inAggregate: contribute };
  }
}

/** The delete/rotate request pair from contribute.mjs ~L518-536. */
export async function deleteRemoteReport(
  owner: modelUsage.ModelTidesOwner,
  options: { fetchImpl?: typeof fetch; endpoint?: string } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? MODEL_TIDES_ENDPOINT;
  const response = await fetchImpl(`${endpoint}/${owner.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  if (!response.ok) {
    throw new Error(`Request failed (HTTP ${response.status}).`);
  }
}

export async function rotateRemoteReport(
  owner: modelUsage.ModelTidesOwner,
  options: { fetchImpl?: typeof fetch; endpoint?: string } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? MODEL_TIDES_ENDPOINT;
  const response = await fetchImpl(`${endpoint}/${owner.id}/rotate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  if (!response.ok) {
    throw new Error(`Request failed (HTTP ${response.status}).`);
  }
  const { token } = (await response.json()) as { token?: unknown };
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Invalid upload response.");
  }
  return token;
}
