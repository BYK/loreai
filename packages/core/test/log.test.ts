import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Import a fresh copy of the log module with a controlled `LORE_DEBUG` value.
 *
 * `isDebug` (and the `stderrSilenced` flag) are module-level state captured at
 * import time, so each test resets the module registry to get a clean,
 * deterministic instance regardless of the ambient environment.
 */
async function freshLog(debug: string | undefined) {
  if (debug === undefined) delete process.env.LORE_DEBUG;
  else process.env.LORE_DEBUG = debug;
  vi.resetModules();
  return import("../src/log");
}

function makeSink() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureException: vi.fn(),
  };
}

describe("log stderr silencing (embedded/TUI mode)", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  const savedDebug = process.env.LORE_DEBUG;

  beforeEach(() => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
    if (savedDebug === undefined) delete process.env.LORE_DEBUG;
    else process.env.LORE_DEBUG = savedDebug;
    vi.resetModules();
  });

  it("writes errors and notices to stderr by default", async () => {
    const log = await freshLog(undefined);
    expect(log.isStderrSilenced()).toBe(false);

    log.error("boom");
    log.notice("heads up");

    expect(stderr).toHaveBeenCalledWith("[lore]", "boom");
    expect(stderr).toHaveBeenCalledWith("[lore]", "heads up");
  });

  it("silenceStderr() suppresses stderr for EVERY level, even with LORE_DEBUG=1", async () => {
    // LORE_DEBUG=1 would normally let info/warn through too — silencing wins.
    const log = await freshLog("1");
    log.silenceStderr();
    expect(log.isStderrSilenced()).toBe(true);

    log.info("i");
    log.warn("w");
    log.notice("n");
    log.error("e");

    expect(stderr).not.toHaveBeenCalled();
  });

  it("keeps forwarding to the file/sink while stderr is silenced", async () => {
    const log = await freshLog("1");
    const sink = makeSink();
    log.registerSink(sink);
    log.silenceStderr();

    log.info("i");
    log.warn("w");
    log.notice("n");
    log.error("e");

    // Nothing reached the TUI...
    expect(stderr).not.toHaveBeenCalled();
    // ...but the sink (Sentry/file bridge) still received everything.
    expect(sink.info).toHaveBeenCalledWith("i");
    expect(sink.warn).toHaveBeenCalledWith("w");
    expect(sink.warn).toHaveBeenCalledWith("n"); // notice -> warn severity
    expect(sink.error).toHaveBeenCalledWith("e");
  });

  it("notice is NOT debug-gated (visible on a standalone CLI), unlike warn", async () => {
    const log = await freshLog(undefined); // LORE_DEBUG unset -> isDebug false
    expect(log.isStderrSilenced()).toBe(false);

    log.warn("should-be-hidden");
    log.notice("should-be-visible");

    // warn is suppressed without debug; notice is always visible.
    expect(stderr).not.toHaveBeenCalledWith("[lore] WARN:", "should-be-hidden");
    expect(stderr).toHaveBeenCalledWith("[lore]", "should-be-visible");
  });

  it("notice reports to the sink at WARNING severity, not error", async () => {
    const log = await freshLog(undefined);
    const sink = makeSink();
    log.registerSink(sink);

    log.notice("misattribution warning");

    expect(sink.warn).toHaveBeenCalledWith("misattribution warning");
    expect(sink.error).not.toHaveBeenCalled();
    expect(sink.captureException).not.toHaveBeenCalled();
  });

  it("shares the silence flag across SEPARATE core module instances (bundled-gateway safety)", async () => {
    // The in-process gateway can be a second, independently-bundled copy of
    // @loreai/core (its Node/CJS bundle inlines core). The plugin silences via
    // its own copy; the gateway logs via its bundled copy. A module-level flag
    // would not cross that boundary — so the flag must be process-global.
    const first = await freshLog(undefined);
    first.silenceStderr(true);

    // A genuinely different module instance (as the gateway's bundled core is
    // at runtime) must observe the flag set by the first instance.
    vi.resetModules();
    const second = await import("../src/log");
    expect(second).not.toBe(first);
    expect(second.isStderrSilenced()).toBe(true);

    // ...and clearing it from the second instance is seen by the first.
    second.silenceStderr(false);
    expect(first.isStderrSilenced()).toBe(false);
  });

  it("silenceStderr(false) restores stderr visibility", async () => {
    const log = await freshLog(undefined);
    log.silenceStderr(true);
    expect(log.isStderrSilenced()).toBe(true);
    log.silenceStderr(false);
    expect(log.isStderrSilenced()).toBe(false);

    log.error("now visible");
    expect(stderr).toHaveBeenCalledWith("[lore]", "now visible");
  });
});

describe("local log credential redaction", () => {
  it("redacts credential assignments, headers, tokens, and private keys", async () => {
    const log = await freshLog(undefined);
    const redacted = log.redactSensitiveLogText(
      "operation failed clientSecret=client-secret-value " +
        'payload={"apiKey":"json-api-key-value"}\n' +
        "Authorization: Bearer bearer-value\n" +
        "ocp-apim-subscription-key=azure-subscription-secret\n" +
        "cf-access-client-id: cloudflare-client-secret\n" +
        "Cookie: session=cookie-value; refresh=refresh-cookie-value\n" +
        "token=plain-token-value\n" +
        "-----BEGIN PRIVATE KEY-----\nprivate-key-bytes\n-----END PRIVATE KEY-----",
    );

    expect(redacted).toContain("operation failed");
    for (const secret of [
      "client-secret-value",
      "json-api-key-value",
      "bearer-value",
      "azure-subscription-secret",
      "cloudflare-client-secret",
      "cookie-value",
      "refresh-cookie-value",
      "plain-token-value",
      "private-key-bytes",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("[Filtered]");
  });

  it.each([
    {
      name: "a quoted scalar containing whitespace",
      input: 'request failed: token = "quoted secret value" status=401',
      secrets: ["quoted secret value"],
      expected: 'request failed: token = "[Filtered]" status=401',
    },
    {
      name: "an unquoted scalar containing whitespace",
      input: "request failed: token = unquoted secret value status=401",
      secrets: ["unquoted secret value"],
      expected: "request failed: token = [Filtered] status=401",
    },
    {
      name: "an unquoted JSON scalar",
      input: 'request failed: {"token":12345,"status":401}',
      secrets: ["12345"],
      expected: 'request failed: {"token":[Filtered],"status":401}',
    },
    {
      name: "a boolean JSON scalar",
      input: 'request failed: {"token":true,"status":401}',
      secrets: ["true"],
      expected: 'request failed: {"token":[Filtered],"status":401}',
    },
    {
      name: "a null JSON scalar",
      input: 'request failed: {"token":null,"status":401}',
      secrets: ["null"],
      expected: 'request failed: {"token":[Filtered],"status":401}',
    },
    {
      name: "a JSON array",
      input:
        'request failed: credentials=["array-secret",{"nested":"object-secret"}] status=401',
      secrets: ["array-secret", "object-secret"],
      expected: "request failed: credentials=[Filtered] status=401",
    },
    {
      name: "a JSON object",
      input:
        'request failed: credentials={"refreshToken":"refresh-secret","nested":["nested-secret"]} status=401',
      secrets: ["refresh-secret", "nested-secret"],
      expected: "request failed: credentials=[Filtered] status=401",
    },
    {
      name: "a Cookie compound value",
      input:
        "request failed: Cookie: session=cookie-secret; refresh=refresh-secret, oauth=oauth-secret status=401",
      secrets: ["cookie-secret", "refresh-secret", "oauth-secret"],
      expected: "request failed: Cookie: [Filtered] status=401",
    },
    {
      name: "a Cookie2 compound value",
      input:
        "request failed: Cookie2: session=cookie-secret; refresh=refresh-secret, oauth=oauth-secret status=401",
      secrets: ["cookie-secret", "refresh-secret", "oauth-secret"],
      expected: "request failed: Cookie2: [Filtered] status=401",
    },
    {
      name: "a non-cookie compound header value",
      input:
        "request failed: x-auth-token: foo=first-secret; bar=second-secret status=401",
      secrets: ["first-secret", "second-secret"],
      expected: "request failed: x-auth-token: [Filtered] status=401",
    },
  ])(
    "redacts the complete value of $name after arbitrary text",
    async (testCase) => {
      const log = await freshLog(undefined);
      const redacted = log.redactSensitiveLogText(testCase.input);

      for (const secret of testCase.secrets) {
        expect(redacted).not.toContain(secret);
      }
      expect(redacted).toBe(testCase.expected);
    },
  );

  it.each([
    "xapikey",
    "x-authsessionid",
    "x-oauthsessionid",
    "x-secretsessionid",
    "x-tokensessionid",
    "x-keysessionid",
  ])(
    "redacts collapsed credential alias %s in local free text",
    async (name) => {
      const log = await freshLog(undefined);
      const secret = "collapsed-alias-secret";

      expect(
        log.redactSensitiveLogText(`request failed: ${name}=${secret}`),
      ).toBe(`request failed: ${name}=[Filtered]`);
    },
  );

  it("preserves bearer scheme diagnostics", async () => {
    const log = await freshLog(undefined);

    for (const diagnostic of [
      "routing decision scheme=bearer provider=anthropic",
      "routing decision scheme=bearer selected upstream",
    ]) {
      expect(log.redactSensitiveLogText(diagnostic)).toBe(diagnostic);
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "persistent log filesystem security",
  () => {
    let base: string;
    let savedNodeEnv: string | undefined;
    let savedXdg: string | undefined;

    beforeEach(() => {
      savedNodeEnv = process.env.NODE_ENV;
      savedXdg = process.env.XDG_DATA_HOME;
      base = mkdtempSync(join(tmpdir(), "lore-log-test-"));
      process.env.NODE_ENV = "production";
      process.env.XDG_DATA_HOME = base;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
      vi.resetModules();
      rmSync(base, { recursive: true, force: true });
    });

    async function freshPersistentLog() {
      vi.resetModules();
      return import("../src/log");
    }

    it("creates the data directory and log as owner-only", async () => {
      const log = await freshPersistentLog();
      log.info("owner-only");

      const dir = join(base, "lore");
      const path = join(dir, "lore.log");
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    });

    it("redacts credentials before writing persistent log bytes", async () => {
      const log = await freshPersistentLog();
      log.error(
        "request failed",
        "clientSecret=persistent-client-secret",
        "Authorization: Bearer persistent-bearer-secret",
        'payload={"refreshToken":"persistent-refresh-token"}',
      );

      const content = readFileSync(join(base, "lore", "lore.log"), "utf8");
      expect(content).toContain("request failed");
      expect(content).toContain("[Filtered]");
      expect(content).not.toContain("persistent-client-secret");
      expect(content).not.toContain("persistent-bearer-secret");
      expect(content).not.toContain("persistent-refresh-token");
    });

    it("tightens existing directory and log permissions before appending", async () => {
      const dir = join(base, "lore");
      const path = join(dir, "lore.log");
      mkdirSync(dir, { mode: 0o777 });
      chmodSync(dir, 0o777);
      writeFileSync(path, "before\n", { mode: 0o666 });
      chmodSync(path, 0o666);

      const log = await freshPersistentLog();
      log.info("after");

      expect(readFileSync(path, "utf8")).toContain("after");
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    });

    it("clears special and group bits while tightening the data directory", async () => {
      const dir = join(base, "lore");
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o2770);

      const log = await freshPersistentLog();
      log.info("preserve setgid");

      expect(lstatSync(dir).mode & 0o7777).toBe(0o700);
      expect(lstatSync(join(dir, "lore.log")).mode & 0o777).toBe(0o600);
    });

    it("tightens a legacy rotated log immediately", async () => {
      const dir = join(base, "lore");
      const backup = join(dir, "lore.log.1");
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(backup, "old sensitive logs", { mode: 0o666 });
      chmodSync(backup, 0o666);

      const log = await freshPersistentLog();
      log.info("new log");

      expect(readFileSync(backup, "utf8")).toBe("old sensitive logs");
      expect(lstatSync(backup).mode & 0o777).toBe(0o600);
    });

    it("rotates an oversized legacy log into an owner-only backup", async () => {
      const dir = join(base, "lore");
      const path = join(dir, "lore.log");
      const backup = `${path}.1`;
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(path, Buffer.alloc(5 * 1024 * 1024 + 1), { mode: 0o666 });
      chmodSync(path, 0o666);

      const log = await freshPersistentLog();
      for (let i = 0; i < 1_000; i++) log.info("rotation check");

      expect(lstatSync(backup).mode & 0o777).toBe(0o600);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    });

    it("does not replace a symlink used as the rotation backup", async () => {
      const dir = join(base, "lore");
      const path = join(dir, "lore.log");
      const target = join(base, "victim-backup.log");
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(path, Buffer.alloc(5 * 1024 * 1024 + 1), { mode: 0o600 });
      writeFileSync(target, "do not replace");
      symlinkSync(target, `${path}.1`);

      const log = await freshPersistentLog();
      for (let i = 0; i < 1_000; i++) log.info("rotation check");

      expect(readFileSync(target, "utf8")).toBe("do not replace");
      expect(lstatSync(`${path}.1`).isSymbolicLink()).toBe(true);
    });

    it("does not follow a symlink used as the persistent log", async () => {
      const dir = join(base, "lore");
      const target = join(base, "victim.log");
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(target, "do not append");
      symlinkSync(target, join(dir, "lore.log"));

      const log = await freshPersistentLog();
      log.info("credential-bearing message");

      expect(readFileSync(target, "utf8")).toBe("do not append");
    });

    it("does not write through a data path reported as another owner", async () => {
      if (typeof process.getuid !== "function") return;
      const dir = join(base, "lore");
      const path = join(dir, "lore.log");
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(path, "before");
      const uid = process.getuid();
      vi.spyOn(process, "getuid").mockReturnValue(uid + 1);

      const log = await freshPersistentLog();
      log.info("must not append");

      expect(readFileSync(path, "utf8")).toBe("before");
    });
  },
);
