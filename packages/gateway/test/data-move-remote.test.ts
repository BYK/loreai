import { afterEach, describe, expect, test, vi } from "vitest";

const REMOTE_URL = "https://control.example.test";

describe("remote data move", () => {
  afterEach(() => {
    delete process.env.LORE_REMOTE_URL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("dry-run previews a remote knowledge move without posting", async () => {
    process.env.LORE_REMOTE_URL = REMOTE_URL;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const { commandData } = await import("../src/cli/data");

    await commandData(["move", "knowledge", "knowledge-id"], {
      "dry-run": true,
      to: "/target",
      project: "/source",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(
      "Would move knowledge entry knowledge-id to /target",
    );
  });
});
