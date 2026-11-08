import { expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ answer: "" }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => fixture.answer,
    close: () => {},
  }),
}));

test.each(["provider", "transport", "empty input"])(
  "team discovery keeps %s OAuth failures private and actionable",
  async (mode) => {
    const savedExitCode = process.exitCode;
    vi.stubEnv("SUPABASE_URL", "https://account.example.test");
    vi.stubEnv("SUPABASE_ANON_KEY", "fixture-key");
    vi.resetModules();
    fixture.answer = mode === "empty input" ? "" : "fixture-oauth-code";
    const exchanges = vi.fn();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.pathname === "/auth/v1/token") {
        exchanges();
        if (mode === "transport")
          throw new Error("private-team-oauth-sentinel\u001b[2J");
        return Response.json(
          { message: "private-team-oauth-sentinel\u001b[2J" },
          { status: 400 },
        );
      }
      return Response.json({});
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const session = await import("../src/supabase");
      session.clearSession();
      vi.spyOn(session, "getAuthedClient").mockResolvedValue(
        session.createSupabaseClient(),
      );
      const { commandTeam } = await import("../src/cli/team-cmd");
      await commandTeam(["discover", "fixture/repository"], {
        "no-browser": true,
      });
      expect(process.exitCode).toBe(1);
      expect(exchanges).toHaveBeenCalledTimes(mode === "empty input" ? 0 : 1);
      const text = [
        ...output.mock.calls,
        ...error.mock.calls,
        ...warn.mock.calls,
      ]
        .flat()
        .join("\n");
      expect(text).not.toContain("private-team-oauth-sentinel");
      expect(text).not.toContain("\u001b[2J");
      expect(error).toHaveBeenCalledWith(
        mode === "empty input"
          ? "GitHub authorization failed: No code provided."
          : "GitHub authorization failed. Please try again.",
      );
    } finally {
      process.exitCode = savedExitCode;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  },
);
