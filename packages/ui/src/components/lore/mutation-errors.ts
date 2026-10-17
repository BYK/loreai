import { ApiError } from "~/lib/api";

const RELOAD_REQUIRED_CODES = new Set([
  "stale_version",
  "stale_policy",
  "stale_member",
  "not_found",
]);

export function requiresMutationReload(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ((error.code !== null && RELOAD_REQUIRED_CODES.has(error.code)) ||
      error.kind === "not_found")
  );
}
