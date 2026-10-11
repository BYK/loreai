import { apiPath } from "~/contracts";

export function repoFileUrl(
  gitRemote: string | null,
  commit: string | null,
  path: string,
): { href: string; label: string } | null {
  const match = gitRemote?.match(
    /^github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  );
  if (
    !match ||
    match[1] === "." ||
    match[1] === ".." ||
    match[2] === "." ||
    match[2] === ".."
  ) {
    return null;
  }
  return {
    href:
      `https://github.com/${match[1]}/${match[2]}` +
      apiPath(["blob", commit ?? "HEAD", ...path.split("/")]),
    label: commit ? `at ${commit.slice(0, 7)}` : "default branch",
  };
}
