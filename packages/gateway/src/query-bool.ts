import { BadRequest } from "./api-lists";

const TRUE_VALUES = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "n", "off"]);

export function parseBooleanParam(
  url: URL,
  name: string,
  fallback: boolean,
): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = raw.toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new BadRequest(
    "invalid_request",
    `Invalid ${name}: ${raw} (expected a boolean)`,
  );
}
