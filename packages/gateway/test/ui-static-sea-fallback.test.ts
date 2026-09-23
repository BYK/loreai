import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UI_MANIFEST_FILE } from "../src/ui-manifest";
import { UI_STAGE_DIR } from "../script/ui-assets";

describe("UI source selection inside a host SEA", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(process, "getBuiltinModule").mockImplementation((name) => {
      if (name === "node:sea") {
        return {
          isSea: () => true,
          getRawAsset: () => {
            throw new Error("Lore UI is not embedded in the host SEA");
          },
        };
      }
      return undefined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("falls back to source-checkout assets when the host has no UI", async () => {
    if (!existsSync(join(UI_STAGE_DIR, UI_MANIFEST_FILE))) {
      throw new Error(
        "UI assets are not staged — run `pnpm --filter @loreai/gateway build` first",
      );
    }

    const { handleUIRequest } = await import("../src/ui-static");
    const url = new URL("http://127.0.0.1/ui");
    const response = handleUIRequest(new Request(url), url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
