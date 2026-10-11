import {
  ltm,
  normalizeRemoteUrl,
  projectGitRemote,
  projectPath,
} from "@loreai/core";

import { errorResponse, jsonResponse } from "./api-lists";

export function normalizeRepoPath(
  raw: string,
  projectRoot: string | null,
): string | null {
  if (raw.includes("\\")) return null;
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }
  let path = raw.trim().replace(/\/{2,}/g, "/");
  if (!path) return null;

  if (path.startsWith("/")) {
    const rootPrefix = projectRoot ? `${projectRoot}/` : null;
    if (!rootPrefix || !path.startsWith(rootPrefix)) return null;
    path = path.slice(rootPrefix.length);
  }

  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/{2,}/g, "/");
  if (!path || path.endsWith("/")) return null;
  if (path.split("/").some((segment) => segment === "." || segment === ".."))
    return null;
  return path;
}

export function handleKnowledgeFiles(
  requestedId: string,
  resolvedId: string,
): Response {
  const entry =
    ltm.get(resolvedId) ?? ltm.getByLogical(ltm.logicalIdOf(resolvedId));
  if (!entry)
    return errorResponse(
      404,
      "not_found",
      `Knowledge entry not found: ${requestedId}`,
    );

  const projectRoot = entry.project_id ? projectPath(entry.project_id) : null;
  const rawGitRemote = entry.project_id
    ? projectGitRemote(entry.project_id)
    : null;
  const gitRemote = rawGitRemote
    ? normalizeRemoteUrl(rawGitRemote) || null
    : null;
  const commit =
    typeof entry.metadata?.gitHead === "string" &&
    /^[0-9a-f]{7,40}$/.test(entry.metadata.gitHead)
      ? entry.metadata.gitHead
      : null;
  const refs =
    ltm
      .knowledgeFileRefsBatch([entry.logical_id], {
        limit: ltm.MAX_FILE_REFS_PER_ENTRY,
      })
      .get(entry.logical_id) ?? [];
  const anchors =
    ltm
      .knowledgeRefAnchors([entry.logical_id], { limit: 50 })
      .get(entry.logical_id) ?? [];
  const files = new Map<
    string,
    { path: string; recorded: boolean; verified: boolean }
  >();
  let omitted = 0;
  const addPath = (raw: string, source: "recorded" | "verified") => {
    const path = normalizeRepoPath(raw, projectRoot);
    if (!path) {
      omitted++;
      return;
    }
    const file = files.get(path) ?? {
      path,
      recorded: false,
      verified: false,
    };
    file[source] = true;
    files.set(path, file);
  };

  for (const path of refs) addPath(path, "recorded");
  for (const anchor of anchors) {
    if (anchor.kind !== "file") continue;
    addPath(anchor.anchor.replace(/:\d+(?::\d+|-\d+)?$/, ""), "verified");
  }

  return jsonResponse({
    id: entry.logical_id,
    git_remote: gitRemote,
    commit,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    omitted,
  });
}
