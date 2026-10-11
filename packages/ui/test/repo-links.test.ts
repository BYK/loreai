import { describe, expect, it } from "vitest";

import { repoFileUrl } from "~/lib/repo-links";

describe("repoFileUrl", () => {
  it("builds a commit-pinned GitHub link and short commit label", () => {
    expect(
      repoFileUrl(
        "github.com/BYK/loreai",
        "0123456789abcdef0123456789abcdef01234567",
        "packages/ui/src/file.ts",
      ),
    ).toEqual({
      href: "https://github.com/BYK/loreai/blob/0123456789abcdef0123456789abcdef01234567/packages/ui/src/file.ts",
      label: "at 0123456",
    });
  });

  it("uses HEAD and labels links to the default branch without a commit", () => {
    expect(repoFileUrl("github.com/BYK/loreai", null, "src/file.ts")).toEqual({
      href: "https://github.com/BYK/loreai/blob/HEAD/src/file.ts",
      label: "default branch",
    });
  });

  it("encodes each path segment, including spaces, reserved characters, and Unicode", () => {
    expect(
      repoFileUrl("github.com/BYK/loreai", null, "a b/#x?.ts"),
    ).toMatchObject({
      href: "https://github.com/BYK/loreai/blob/HEAD/a%20b/%23x%3F.ts",
    });
    expect(repoFileUrl("github.com/BYK/loreai", null, "src/é.ts")?.href).toBe(
      "https://github.com/BYK/loreai/blob/HEAD/src/%C3%A9.ts",
    );
  });

  it.each([
    ["gitlab.com/BYK/loreai", "src/file.ts"],
    [null, "src/file.ts"],
    ["github.com/BYK/loreai/extra", "src/file.ts"],
    ["github.com/../loreai", "src/file.ts"],
    ["github.com/BYK/.", "src/file.ts"],
  ])("rejects unsupported remote %s", (remote, path) => {
    expect(repoFileUrl(remote, null, path)).toBeNull();
  });
});
