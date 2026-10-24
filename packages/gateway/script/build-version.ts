import { randomUUID } from "node:crypto";

/** Official publishing jobs opt in; every other invocation gets its own ID.
 * --release controls compression and must not make a local build official.
 */
export function buildVersion(
  packageVersion: string,
  official = process.env.LORE_OFFICIAL_BUILD === "1",
): string {
  if (official) return packageVersion;
  const separator = packageVersion.includes("+") ? "." : "+";
  return `${packageVersion}${separator}local.${randomUUID().replaceAll("-", "")}`;
}

/** A reused staging tree must retain its declared identity. Rebuilding an
 * official staging bundle locally would reproduce the original collision.
 */
export function stagingVersion(
  stagedVersion: string,
  packageVersion: string,
  official = process.env.LORE_OFFICIAL_BUILD === "1",
): string {
  if (
    official
      ? stagedVersion !== packageVersion
      : !stagedVersion.split("+")[1]?.split(".").includes("local")
  ) {
    throw new Error(
      "Staging build identity does not match this build; regenerate with --prepare-only in the same build mode.",
    );
  }
  return stagedVersion;
}
