import { afterEach, describe, expect, test, vi } from "vitest";

const stageUiAssets = vi.hoisted(() => vi.fn());

vi.mock("../script/ui-assets", () => ({ stageUiAssets }));

describe("source UI bootstrap", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    stageUiAssets.mockReset();
  });

  test("stages once and shares the in-flight result with concurrent callers", async () => {
    let release: (() => void) | undefined;
    stageUiAssets.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ files: 17, buildId: "build-a" });
        }),
    );

    const { prepareSourceUiAssets } = await import("../src/ui-bootstrap");
    const first = prepareSourceUiAssets();
    const second = prepareSourceUiAssets();
    await vi.waitFor(() => expect(stageUiAssets).toHaveBeenCalledOnce());
    expect(stageUiAssets).toHaveBeenCalledWith({ build: "never" });

    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { attempted: true, files: 17, buildId: "build-a" },
      { attempted: true, files: 17, buildId: "build-a" },
    ]);
    await expect(prepareSourceUiAssets()).resolves.toEqual({
      attempted: true,
      files: 17,
      buildId: "build-a",
    });
    expect(stageUiAssets).toHaveBeenCalledOnce();
  });

  test("retries after a failed staging attempt", async () => {
    stageUiAssets
      .mockRejectedValueOnce(new Error("temporary staging failure"))
      .mockResolvedValueOnce({ files: 4, buildId: "build-c" });

    const { prepareSourceUiAssets } = await import("../src/ui-bootstrap");
    await expect(prepareSourceUiAssets()).resolves.toEqual({
      attempted: true,
      files: 0,
      buildId: null,
      error: "temporary staging failure",
    });
    await expect(prepareSourceUiAssets()).resolves.toEqual({
      attempted: true,
      files: 4,
      buildId: "build-c",
    });
    expect(stageUiAssets).toHaveBeenCalledTimes(2);
  });

  test("also resets after an unexpected preparation rejection", async () => {
    const { prepareSourceUiAssets } = await import("../src/ui-bootstrap");
    stageUiAssets.mockRejectedValueOnce({
      toString: () => {
        throw new Error("unprintable staging failure");
      },
    });
    await expect(prepareSourceUiAssets()).rejects.toThrow(
      "unprintable staging failure",
    );

    stageUiAssets.mockResolvedValueOnce({ files: 2, buildId: "build-d" });
    await expect(prepareSourceUiAssets()).resolves.toEqual({
      attempted: true,
      files: 2,
      buildId: "build-d",
    });
    expect(stageUiAssets).toHaveBeenCalledTimes(2);
  });

  test("is a no-op when the gateway is not running from a source checkout", async () => {
    vi.doMock("node:fs", () => ({ existsSync: () => false }));

    const { prepareSourceUiAssets } = await import("../src/ui-bootstrap");
    await expect(prepareSourceUiAssets()).resolves.toEqual({
      attempted: false,
      files: 0,
      buildId: null,
    });
    expect(stageUiAssets).not.toHaveBeenCalled();
  });
});
