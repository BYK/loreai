import { createHash } from "node:crypto";
import type { ReplayFixtureDigests, SemanticLintReplayCase } from "./types";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function replayInputPayload(caseData: SemanticLintReplayCase): unknown {
  return {
    id: caseData.id,
    name: caseData.name,
    split: caseData.split,
    label: caseData.label,
    revision: caseData.revision,
    invariant: caseData.invariant,
    hunks: caseData.hunks,
    seedHunkIndex: caseData.seedHunkIndex,
    tags: caseData.tags,
    mutation: caseData.mutation,
  };
}

export function replayTracePayload(caseData: SemanticLintReplayCase): unknown {
  return caseData.recorded;
}

export function replayInvariantContentDigest(
  caseData: SemanticLintReplayCase,
): string {
  const { id: _id, ...content } = caseData.invariant;
  return sha256Canonical(content);
}

export function replayHunkDigests(caseData: SemanticLintReplayCase): string[] {
  return caseData.hunks.map((hunk) => sha256Canonical(hunk));
}

export function computeReplayFixtureDigests(
  caseData: SemanticLintReplayCase,
): ReplayFixtureDigests {
  return {
    inputSha256: sha256Canonical(replayInputPayload(caseData)),
    traceSha256: sha256Canonical(replayTracePayload(caseData)),
  };
}
