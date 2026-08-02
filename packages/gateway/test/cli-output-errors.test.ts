/**
 * Phase 2 — output pipeline + CliError contract tests.
 *
 * Pinned behaviors:
 *   - `renderHuman` produces text with no ANSI escapes.
 *   - `renderJson` produces stable JSON (no hints, no banners).
 *   - Hints are emitted only in human mode, on stderr, after the data.
 *   - CliError subtypes render predictable human text with Try/Or/Note.
 *   - CliError.toJson() is stable and never includes secrets.
 *   - selectFields deep-selects dotted paths and silently omits unknowns.
 */
import { describe, expect, test, vi } from "vitest";
import {
  AuthError,
  ContextError,
  CliError,
  ImportError,
  NetworkError,
  ResolutionError,
  StorageError,
  SyncError,
  UsageError,
  UpgradeError,
  ValidationError,
  stringifyUnknown,
} from "../src/cli/lib/errors";
import { jsonLines, selectFields } from "../src/cli/lib/output";
import type { LoreCommandContext } from "../src/cli/context";

function ctx(): LoreCommandContext {
  return {
    process,
    cwd: "/tmp",
    homeDir: "/tmp",
    env: {},
    userArgv: [],
    platform: "linux",
    arch: "x64",
    isStdoutTTY: false,
    isStderrTTY: false,
    isStdinTTY: false,
    commandPath: [],
  };
}

describe("Phase 2 — selectFields", () => {
  const data = {
    id: "abc",
    title: "Example",
    nested: { foo: 1, bar: { baz: 2 } },
    list: [{ n: 1 }, { n: 2 }],
  };

  test("empty selector returns the whole object", () => {
    expect(selectFields(data, [])).toEqual(data);
  });

  test("flat path selects top-level fields", () => {
    expect(selectFields(data, ["id", "title"])).toEqual({
      id: "abc",
      title: "Example",
    });
  });

  test("dotted path descends into nested objects", () => {
    expect(selectFields(data, ["nested.bar.baz"])).toEqual({
      nested: { bar: { baz: 2 } },
    });
  });

  test("unknown paths are silently omitted", () => {
    expect(selectFields(data, ["does.not.exist"])).toEqual({});
  });
});

describe("Phase 2 — jsonLines", () => {
  test("yields one JSON object per item with trailing newline", async () => {
    async function* source() {
      yield { a: 1 };
      yield { a: 2 };
    }
    const out: string[] = [];
    for await (const line of jsonLines(source())) {
      out.push(line);
    }
    expect(out).toEqual(['{"a":1}\n', '{"a":2}\n']);
  });
});

describe("Phase 2 — CliError category exit codes", () => {
  test("AuthError is in the auth range", () => {
    const e = new AuthError({ message: "not signed in" });
    expect(e.exitCode).toBe(10);
  });
  test("UsageError is in the usage range", () => {
    expect(new UsageError({ message: "bad" }).exitCode).toBe(20);
  });
  test("ContextError", () => {
    expect(new ContextError({ message: "missing" }).exitCode).toBe(21);
  });
  test("ResolutionError", () => {
    expect(new ResolutionError({ message: "not found" }).exitCode).toBe(22);
  });
  test("ValidationError", () => {
    expect(new ValidationError({ message: "bad input" }).exitCode).toBe(23);
  });
  test("NetworkError", () => {
    expect(new NetworkError({ message: "no route" }).exitCode).toBe(30);
  });
  test("StorageError", () => {
    expect(new StorageError({ message: "fs" }).exitCode).toBe(50);
  });
  test("ImportError", () => {
    expect(new ImportError({ message: "import" }).exitCode).toBe(51);
  });
  test("SyncError", () => {
    expect(new SyncError({ message: "sync" }).exitCode).toBe(52);
  });
});

describe("Phase 2 — UpgradeError legacy shape", () => {
  test("accepts (reason, message) and exposes reason on the instance", () => {
    const e = new UpgradeError("network_error", "fetch failed");
    expect(e.reason).toBe("network_error");
    expect(e.message).toBe("fetch failed");
    expect(e.exitCode).toBe(53);
  });
  test("also accepts the modern init shape", () => {
    const e = new UpgradeError({ message: "boom", reason: "io_error" });
    expect(e.reason).toBe("io_error");
    expect(e.message).toBe("boom");
  });
});

describe("Phase 2 — CliError human format", () => {
  test("Try/Or/Note sections render in the documented order", () => {
    const e = new UsageError({
      message: "Missing scope",
      tryCommand: "lore recall --scope project 'auth'",
      alternatives: ["lore doctor"],
      note: "scoped to current project",
    });
    const text = e.formatHuman();
    expect(text).toContain("Missing scope");
    expect(text).toContain("Try: lore recall --scope project 'auth'");
    expect(text).toContain("Or:");
    expect(text).toContain("lore doctor");
    expect(text).toContain("Note: scoped to current project");
  });

  test("omits sections when fields are absent", () => {
    const e = new CliError(20, { message: "bare" });
    expect(e.formatHuman()).toBe("bare");
  });
});

describe("Phase 2 — CliError JSON shape", () => {
  test("stable, no secrets, includes reason when present", () => {
    const e = new UpgradeError("network_error", "fetch failed");
    const json = e.toJson();
    expect(json).toEqual({
      error: "UpgradeError",
      code: 53,
      message: "fetch failed",
      reason: "network_error",
    });
  });

  test("optional sections included only when set", () => {
    const e = new UsageError({ message: "bad", tryCommand: "lore help" });
    const json = e.toJson();
    expect(json.try).toBe("lore help");
    expect("alternatives" in json).toBe(false);
    expect("note" in json).toBe(false);
  });
});

describe("Phase 2 — stringifyUnknown preserves the legacy contract", () => {
  test("null", () => {
    expect(stringifyUnknown(null)).toBe("null");
  });
  test("string", () => {
    expect(stringifyUnknown("boom")).toBe("boom");
  });
  test("Error", () => {
    const err = new Error("kaboom");
    expect(stringifyUnknown(err)).toContain("kaboom");
  });
  test("plain object falls through to JSON", () => {
    expect(stringifyUnknown({ a: 1 })).toBe('{"a":1}');
  });
});

describe("Phase 2 — emitCliError sets process exitCode", () => {
  test("renders to stderr and stamps exitCode", async () => {
    const captured: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        captured.push(
          Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk),
        );
        return true;
      });
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const { emitCliError } = await import("../src/cli/lib/errors");
      emitCliError(new UsageError({ message: "nope" }), ctx(), false);
      expect(captured.join("")).toContain("nope");
      expect(process.exitCode).toBe(20);
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });
});
