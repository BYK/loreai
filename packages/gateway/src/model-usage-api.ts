/**
 * Model-usage export endpoints (`GET /api/v1/model-usage[/export]`) (#2026).
 * Returns the model-tides daily document built by
 * `modelUsage.buildDailyModelUsage` — per-day session counts keyed by
 * `provider/model`, scoped to the current tenant.
 *
 * `project` filters by internal project id (same lookup convention as the
 * project-scoped knowledge list: unknown id → 404 `not_found`).
 */
import { modelUsage, projectPath } from "@loreai/core";
import { errorResponse, jsonResponse } from "./management-access";
import {
  deleteRemoteReport,
  getOwnedReport,
  MODEL_TIDES_ENDPOINT,
  publishSnapshot,
  publicUrlFor,
  reportVisibility,
  rotateRemoteReport,
  setAggregate,
  setSharing,
  uploadOSForPlatform,
} from "./model-tides-client";

class ProjectNotFound extends Error {
  constructor(readonly projectId: string) {
    super(`Project not found: ${projectId}`);
  }
}

function parseFilter(url: URL): modelUsage.ModelUsageFilter {
  const filter: {
    -readonly [K in keyof modelUsage.ModelUsageFilter]?: modelUsage.ModelUsageFilter[K];
  } = {};
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from !== null) filter.from = from;
  if (to !== null) filter.to = to;
  if (url.searchParams.has("project")) {
    const id = url.searchParams.get("project") ?? "";
    if (!id) {
      throw new modelUsage.ModelUsageFilterError("project must not be empty");
    }
    if (!projectPath(id)) throw new ProjectNotFound(id);
    filter.projectId = id;
  }
  return filter;
}

function toErrorResponse(err: unknown): Response {
  if (err instanceof ProjectNotFound) {
    return errorResponse(404, "not_found", err.message);
  }
  if (err instanceof modelUsage.ModelUsageFilterError) {
    return errorResponse(400, "invalid_request", err.message);
  }
  if (err instanceof modelUsage.ModelUsageLimitError) {
    return errorResponse(422, "result_too_large", err.message);
  }
  if (err instanceof modelUsage.ModelUsageUnavailableError) {
    return errorResponse(503, "service_unavailable", err.message);
  }
  throw err;
}

function documentResponse(doc: modelUsage.DailyUsageDocument): Response {
  const response = jsonResponse(doc);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function handleGetModelUsage(url: URL): Promise<Response> {
  try {
    return documentResponse(
      await modelUsage.buildDailyModelUsage(parseFilter(url)),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleExportModelUsage(url: URL): Promise<Response> {
  try {
    const doc = await modelUsage.buildDailyModelUsage(parseFilter(url));
    const today = new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get("from") ?? doc.days[0]?.day ?? today;
    const to =
      url.searchParams.get("to") ?? doc.days[doc.days.length - 1]?.day ?? today;
    const response = new Response(`${JSON.stringify(doc)}\n`, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="lore-model-usage-${from}-${to}.json"`,
      },
    });
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// Consented Model Tides upload (#2026 PR3). Nothing uploads automatically —
// every remote call here follows an explicit `confirm: "YES"` request.
// ---------------------------------------------------------------------------

const OWNER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function jsonObject(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return errorResponse(400, "invalid_request", "Invalid JSON body");
  }
}

function hostedWriteError(
  action: string,
  configuredHostedMode: boolean,
): Response | null {
  return configuredHostedMode
    ? errorResponse(
        403,
        "forbidden",
        `${action} is not available in hosted mode.`,
      )
    : null;
}

/** Body contract shared by every mutation: `{ confirm: "YES" }`. */
function confirmBody(
  body: Record<string, unknown> | null,
  extraKeys: readonly string[] = [],
): Response | null {
  const keys = body ? Object.keys(body) : [];
  if (
    !body ||
    body.confirm !== "YES" ||
    keys.length !== 1 + extraKeys.length ||
    !keys.every((key) => key === "confirm" || extraKeys.includes(key))
  ) {
    return errorResponse(
      400,
      "invalid_request",
      `Body must be { confirm: "YES"${extraKeys.map((k) => `, ${k}`).join("")} }.`,
    );
  }
  return null;
}

interface ReportPayload {
  id: string;
  url?: string;
  published: boolean;
  inAggregate: boolean | null;
  revision: number;
  metricVersion: number;
  snapshot: modelUsage.WeeklySnapshot | null;
}

function reportPayload(report: modelUsage.OwnedReport): ReportPayload {
  return {
    id: report.id,
    ...(report.published
      ? { url: publicUrlFor(MODEL_TIDES_ENDPOINT, report.id) }
      : {}),
    published: report.published,
    inAggregate: report.inAggregate,
    revision: report.revision,
    metricVersion: report.metricVersion,
    snapshot: report.snapshot,
  };
}

async function currentSnapshot(): Promise<{
  doc: modelUsage.DailyUsageDocument;
  snapshot: modelUsage.WeeklySnapshot;
  hash: string;
}> {
  const doc = await modelUsage.buildDailyModelUsage({});
  const snapshot = modelUsage.buildWeeklySnapshot(doc);
  return { doc, snapshot, hash: modelUsage.snapshotSha256(snapshot) };
}

function upstreamError(err: unknown): Response {
  const message = err instanceof Error ? err.message : "Upload failed.";
  return errorResponse(502, "bad_gateway", message);
}

export async function handleGetModelUsageUpload(): Promise<Response> {
  try {
    const { snapshot, hash } = await currentSnapshot();
    const owner = modelUsage.loadOwner();
    let report: ReportPayload | null = null;
    let reportError: string | undefined;
    if (owner) {
      try {
        report = reportPayload(await getOwnedReport(owner));
      } catch (err) {
        reportError = err instanceof Error ? err.message : String(err);
      }
    }
    return jsonResponse({
      snapshot,
      snapshot_sha256: hash,
      upload_os: uploadOSForPlatform(process.platform),
      report,
      ...(reportError ? { report_error: reportError } : {}),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * `POST /api/v1/model-usage/upload` — confirmed upload/replace. The client
 * reviews the snapshot shown by GET first; a changed hash fails 409.
 */
export async function handlePostModelUsageUpload(
  req: Request,
  hostedMode: boolean,
): Promise<Response> {
  const blocked = hostedWriteError("Model Tides upload", hostedMode);
  if (blocked) return blocked;
  const parsed = await readJsonBody(req);
  if (parsed instanceof Response) return parsed;
  const body = jsonObject(parsed);
  const keys = body ? Object.keys(body) : [];
  if (
    !body ||
    body.confirm !== "YES" ||
    typeof body.snapshot_sha256 !== "string" ||
    keys.length < 2 ||
    keys.length > 3 ||
    !keys.every((k) =>
      ["confirm", "snapshot_sha256", "reviewed_revision"].includes(k),
    )
  ) {
    return errorResponse(
      400,
      "invalid_request",
      'Body must be { confirm: "YES", snapshot_sha256, reviewed_revision? }.',
    );
  }
  const reviewedRevision =
    "reviewed_revision" in body ? body.reviewed_revision : null;
  if (
    reviewedRevision !== null &&
    (!Number.isSafeInteger(reviewedRevision) ||
      (reviewedRevision as number) < 0)
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "reviewed_revision must be a non-negative integer.",
    );
  }
  try {
    const { snapshot, hash } = await currentSnapshot();
    if (body.snapshot_sha256 !== hash) {
      return errorResponse(
        409,
        "stale_review",
        "Counts changed since you reviewed them",
      );
    }
    // Empty history — reject before any remote call.
    if (snapshot.weeks.length === 0) {
      return errorResponse(422, "no_usage", "No model usage to upload yet.");
    }
    const owner = modelUsage.loadOwner();
    if (owner) {
      const report = await reportVisibility(owner);
      if (report.metricVersion === 1) {
        if (reviewedRevision !== report.revision) {
          return errorResponse(
            409,
            "stale_review",
            "Report changed since you reviewed it",
          );
        }
        if (!report.snapshot) {
          return errorResponse(
            422,
            "result_too_large",
            "Earlier report is too large to review before replacing it. Withdraw or delete it separately.",
          );
        }
      } else if (report.metricVersion !== 2) {
        return upstreamError(
          new Error("Unknown report metric. No upload was started."),
        );
      }
      const result = await publishSnapshot(snapshot, owner, {
        published: report.published,
        inAggregate: report.inAggregate!,
        reviewedRevision: report.metricVersion === 1 ? report.revision : null,
      });
      if (
        !result ||
        !OWNER_ID_RE.test(String(result.id)) ||
        result.id !== owner.id ||
        result.published !== report.published ||
        result.inAggregate !== report.inAggregate ||
        result.metricVersion !== snapshot.version
      ) {
        return upstreamError(new Error("Invalid upload response."));
      }
      return jsonResponse(reportPayload(await getOwnedReport(owner)));
    }
    const result = await publishSnapshot(snapshot, null);
    if (
      !result ||
      !OWNER_ID_RE.test(String(result.id)) ||
      typeof result.published !== "boolean" ||
      typeof result.inAggregate !== "boolean" ||
      result.metricVersion !== snapshot.version ||
      typeof result.token !== "string" ||
      !OWNER_TOKEN_RE.test(result.token)
    ) {
      return upstreamError(new Error("Invalid upload response."));
    }
    const origin = new URL(MODEL_TIDES_ENDPOINT).origin;
    const newOwner = { id: result.id as string, token: result.token };
    if (
      result.published !== true ||
      result.inAggregate !== false ||
      result.url !== `${origin}/u/${String(result.id)}`
    ) {
      // State mismatch — roll the just-created report back, exactly like the CLI.
      await fetch(`${MODEL_TIDES_ENDPOINT}/${String(result.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${result.token}` },
      }).catch(() => {});
      return upstreamError(
        new Error(
          "Upload response did not match the reviewed report state. Check your report before retrying.",
        ),
      );
    }
    try {
      // Mirrors the CLI's writeFileSync(..., { flag: 'wx' }): a concurrent
      // create must not overwrite an existing credential — createOwner throws
      // on conflict and the rollback below removes the remote report.
      modelUsage.createOwner(newOwner);
    } catch {
      // A network rejection counts as "not removed" — this fetch must not
      // throw past the rollback branch.
      const removed = await fetch(
        `${MODEL_TIDES_ENDPOINT}/${String(result.id)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${result.token}` },
        },
      ).then(
        (r) => r.ok,
        () => false,
      );
      return upstreamError(
        new Error(
          removed
            ? "Could not save your private key; the new contribution was removed."
            : "Could not save your private key or remove the new contribution.",
        ),
      );
    }
    return jsonResponse(reportPayload(await getOwnedReport(newOwner)));
  } catch (err) {
    if (
      err instanceof modelUsage.ModelUsageFilterError ||
      err instanceof modelUsage.ModelUsageLimitError ||
      err instanceof modelUsage.ModelUsageUnavailableError
    ) {
      return toErrorResponse(err);
    }
    return upstreamError(err);
  }
}

/** share/unshare/contribute/withdraw — `{ confirm: "YES", reviewed_revision? }`. */
export async function handleModelUsageUploadAction(
  action: "share" | "unshare" | "contribute" | "withdraw",
  req: Request,
  hostedMode: boolean,
): Promise<Response> {
  const blocked = hostedWriteError(`Model Tides ${action}`, hostedMode);
  if (blocked) return blocked;
  const needsReview = action === "share" || action === "contribute";
  const parsed = await readJsonBody(req);
  if (parsed instanceof Response) return parsed;
  const body = jsonObject(parsed);
  const bad = confirmBody(body, needsReview ? ["reviewed_revision"] : []);
  if (bad) return bad;
  const reviewedRevision = needsReview ? body!.reviewed_revision : undefined;
  if (
    needsReview &&
    (typeof reviewedRevision !== "number" ||
      !Number.isSafeInteger(reviewedRevision) ||
      reviewedRevision < 0)
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "reviewed_revision must be a non-negative integer",
    );
  }
  try {
    const owner = modelUsage.loadOwner();
    if (!owner) {
      return errorResponse(
        409,
        "no_report",
        "No Model Tides report exists. Upload first.",
      );
    }
    const report = await getOwnedReport(owner);
    if (needsReview) {
      if (reviewedRevision !== report.revision) {
        return errorResponse(
          409,
          "stale_review",
          "Report changed since you reviewed it",
        );
      }
      if (!report.snapshot) {
        return errorResponse(
          422,
          "result_too_large",
          action === "share"
            ? "The stored report is too large to review. You can still hide or delete it."
            : "Stored report is too large to review for aggregate contribution.",
        );
      }
    }
    const result =
      action === "share" || action === "unshare"
        ? await setSharing(owner, action === "share", {
            reviewed:
              action === "share"
                ? { snapshot: report.snapshot!, revision: report.revision }
                : null,
          })
        : await setAggregate(owner, action === "contribute", {
            reviewed:
              action === "contribute"
                ? { snapshot: report.snapshot!, revision: report.revision }
                : null,
          });
    return jsonResponse(result);
  } catch (err) {
    return upstreamError(err);
  }
}

/** `POST /api/v1/model-usage/upload/rotate` — `{ confirm: "YES" }`. */
export async function handleModelUsageUploadRotate(
  req: Request,
  hostedMode: boolean,
): Promise<Response> {
  const blocked = hostedWriteError("Model Tides rotate", hostedMode);
  if (blocked) return blocked;
  const parsed = await readJsonBody(req);
  if (parsed instanceof Response) return parsed;
  const body = jsonObject(parsed);
  const bad = confirmBody(body);
  if (bad) return bad;
  try {
    const owner = modelUsage.loadOwner();
    if (!owner) {
      return errorResponse(
        409,
        "no_report",
        "No Model Tides report exists. Upload first.",
      );
    }
    const token = await rotateRemoteReport(owner);
    // Store the new token atomically — kv_meta upsert is a single statement.
    modelUsage.saveOwner({ id: owner.id, token });
    return jsonResponse({ id: owner.id });
  } catch (err) {
    return upstreamError(err);
  }
}

/** `DELETE /api/v1/model-usage/upload` — `{ confirm: "YES" }`. */
export async function handleModelUsageUploadDelete(
  req: Request,
  hostedMode: boolean,
): Promise<Response> {
  const blocked = hostedWriteError("Model Tides delete", hostedMode);
  if (blocked) return blocked;
  const parsed = await readJsonBody(req);
  if (parsed instanceof Response) return parsed;
  const body = jsonObject(parsed);
  const bad = confirmBody(body);
  if (bad) return bad;
  try {
    const owner = modelUsage.loadOwner();
    if (!owner) {
      return errorResponse(
        409,
        "no_report",
        "No Model Tides report exists. Upload first.",
      );
    }
    // The credential is removed only after the remote delete succeeds.
    await deleteRemoteReport(owner);
    modelUsage.deleteOwner();
    return jsonResponse({ id: owner.id });
  } catch (err) {
    return upstreamError(err);
  }
}
