/**
 * Dedup management routes (MEM-01 #1803 / MEM-02 #1804).
 *
 *   POST /api/v1/projects/:id/dedup        — typed dry-run preview, never writes
 *   POST /api/v1/projects/:id/dedup/apply  — apply reviewed decisions
 *
 * The preview keeps the legacy `{ project, global }` `DedupResult` payload that
 * `lore data dedup --remote` prints, and adds `dry_run` + `groups`: one typed
 * group per cluster with the revision of every candidate, so a later
 * `/dedup/apply` can prove the reviewer saw the entries it is about to merge.
 */
import { createHash } from "node:crypto";
import { db, dedupApply, isHostedMode, ltm } from "@loreai/core";
import { decodeRequestBody } from "./http-body";

type DedupResult = ltm.DedupResult;
type DedupApplyReceipt = dedupApply.DedupApplyReceipt;

export const CONTENT_EXCERPT_LENGTH = 200;

export type DedupScope = "project" | "global";

export type DedupPreviewCandidate = {
  /** Current version id — the id to send back in `/dedup/apply`. */
  id: string;
  logical_id: string;
  revision: number;
  title: string;
  content_excerpt: string;
  /** Strongest dedup signal between this entry and another group member. */
  score: number;
  reasons: string[];
};

export type DedupPreviewGroup = {
  group_id: string;
  scope: DedupScope;
  project_id: string | null;
  candidates: DedupPreviewCandidate[];
  suggested_keep_id: string;
};

export type DedupPreviewResponse = {
  dry_run: true;
  groups: DedupPreviewGroup[];
  project: DedupResult;
  global: DedupResult;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  status: number,
  type: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse(
    { type: "error", error: { type, message }, ...extra },
    status,
  );
}

function excerpt(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= CONTENT_EXCERPT_LENGTH) return collapsed;
  return `${collapsed.slice(0, CONTENT_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

/** Stable across previews as long as the cluster's membership is unchanged. */
function groupIdFor(scope: DedupScope, memberIds: string[]): string {
  const digest = createHash("sha256")
    .update([...memberIds].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `${scope}:${digest}`;
}

function toGroups(
  result: DedupResult,
  scope: DedupScope,
  projectId: string | null,
): DedupPreviewGroup[] {
  const groups: DedupPreviewGroup[] = [];
  const pairMatches =
    result.pairMatches ?? new Map<string, ltm.DedupPairMatch>();
  for (const cluster of result.clusters) {
    const memberIds = [
      cluster.surviving.id,
      ...cluster.merged.map((m) => m.id),
    ];
    // Revisions are read after clustering; an entry deleted in between simply
    // drops out instead of being offered with a revision apply would refuse.
    const revisions = dedupApply.currentRevisions(memberIds);
    const candidates: DedupPreviewCandidate[] = [];
    for (const id of memberIds) {
      const revision = revisions.get(id);
      const entry = revision === undefined ? null : ltm.get(id);
      if (revision === undefined || !entry) continue;
      let score = 0;
      const reasons = new Set<string>();
      for (const other of memberIds) {
        if (other === id) continue;
        const match = pairMatches.get(ltm.dedupPairKey(id, other));
        if (!match) continue;
        score = Math.max(score, match.score);
        for (const reason of match.reasons) reasons.add(reason);
      }
      candidates.push({
        id,
        logical_id: entry.logical_id,
        revision,
        title: entry.title,
        content_excerpt: excerpt(entry.content),
        score: Number(score.toFixed(4)),
        reasons: [...reasons].sort(),
      });
    }
    if (candidates.length < 2) continue;
    const keepId = candidates.some((c) => c.id === cluster.surviving.id)
      ? cluster.surviving.id
      : candidates[0].id;
    groups.push({
      group_id: groupIdFor(
        scope,
        candidates.map((c) => c.id),
      ),
      scope,
      project_id: projectId,
      candidates,
      suggested_keep_id: keepId,
    });
  }
  return groups;
}

/** POST /api/v1/projects/:id/dedup — always a dry run. */
export async function handleDedupPreview(
  projectId: string,
  projectPath: string,
): Promise<Response> {
  const project = await ltm.deduplicate(projectPath, { dryRun: true });
  const global = await ltm.deduplicateGlobal({ dryRun: true });
  const body: DedupPreviewResponse = {
    dry_run: true,
    groups: [
      ...toGroups(project, "project", projectId),
      ...toGroups(global, "global", null),
    ],
    project,
    global,
  };
  return jsonResponse(body);
}

/**
 * POST /api/v1/projects/:id/dedup/apply
 *
 * Body: `DedupApplyRequest` minus `projectId`, which defaults to the route
 * project. `projectId: null` is accepted so the global groups a preview returns
 * can be applied through the same route; any other value must equal the route.
 *
 *   200 every group applied (or an identical operation replayed as such)
 *   400 malformed body / invalid request
 *   403 hosted mode
 *   404 project vanished
 *   409 `operation_conflict`, or at least one group refused
 *       (`stale_revision` / `not_found` / `scope_mismatch` /
 *       `conflicting_groups`); the receipt is included, applied groups stay
 *       applied.
 */
export async function handleDedupApply(
  req: Request,
  projectId: string,
): Promise<Response> {
  if (isHostedMode()) {
    return errorResponse(
      403,
      "forbidden",
      "Dedup apply is not available in hosted mode (mutates knowledge).",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await decodeRequestBody(req));
  } catch {
    return errorResponse(400, "invalid_request", "Invalid JSON body");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return errorResponse(
      400,
      "invalid_request",
      "request body must be a JSON object",
    );
  }
  const body = raw as Record<string, unknown>;
  if (body.projectId === undefined) body.projectId = projectId;
  if (body.projectId !== null && body.projectId !== projectId) {
    return errorResponse(
      400,
      "invalid_request",
      "projectId must be null or match the route project",
    );
  }

  let receipt: DedupApplyReceipt;
  try {
    const request = dedupApply.parseDedupApplyRequest(body);
    receipt = dedupApply.applyDedupDecisions(db(), request);
  } catch (err) {
    if (err instanceof dedupApply.DedupApplyError) {
      const status =
        err.code === "invalid_request"
          ? 400
          : err.code === "not_found"
            ? 404
            : 409;
      return errorResponse(status, err.code, err.message);
    }
    throw err;
  }

  if (receipt.refused.length > 0) {
    const codes = [...new Set(receipt.refused.map((g) => g.error.code))];
    return errorResponse(
      409,
      codes.length === 1 ? codes[0] : "groups_refused",
      `${receipt.refused.length} of ${receipt.applied.length + receipt.refused.length} groups refused (${codes.join(", ")})`,
      { receipt },
    );
  }
  return jsonResponse(receipt);
}
