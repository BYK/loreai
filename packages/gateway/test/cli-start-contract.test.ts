import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;
const origArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  process.env.LORE_NO_UPDATE_CHECK = "1";
  process.argv = origArgv;
});

afterAll(() => {
  if (origNoUpdateCheck === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
  else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  process.argv = origArgv;
});

describe("Phase 3B.2 - typed lore start", () => {
  test("start is registered in STRICLI_ROUTES and not legacy", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    const { LEGACY_ROUTES } = await import("../src/cli/app");

    expect(STRICLI_ROUTES.has("start")).toBe(true);
    expect(LEGACY_ROUTES.has("start")).toBe(false);
  });

  test("start forwards parsed gateway options to the lifecycle handler", async () => {
    const commandStart = vi.fn(async () => undefined as never);
    vi.doMock("../src/cli/start", () => ({ commandStart }));
    const { runCli } = await import("../src/cli/cli");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = [
      "node",
      "lore",
      "start",
      "--port",
      "4321",
      "--host",
      "127.0.0.1,::1",
      "--debug",
      "--remote",
      "https://gateway.example",
      "--local",
      "--bg",
    ];
    try {
      await runCli();
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(commandStart).toHaveBeenCalledWith({
      port: 4321,
      hosts: ["127.0.0.1", "::1"],
      debug: true,
      remoteUrl: "https://gateway.example",
      local: true,
      bg: true,
    });
  });

  test("start --daemon aliases --bg", async () => {
    const commandStart = vi.fn(async () => undefined as never);
    vi.doMock("../src/cli/start", () => ({ commandStart }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "start", "--daemon"];

    await runCli();

    expect(commandStart).toHaveBeenCalledWith(
      expect.objectContaining({ bg: true }),
    );
  });
});
