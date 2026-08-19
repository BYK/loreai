import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  failedSemanticLintReport,
  MAX_LINT_REPORT_CANDIDATES,
  MAX_LINT_REPORT_RESOLVED_REASON_LENGTH,
  validateSemanticLintReport,
  type SemanticLintReport,
} from "../src/cli/lint-report";

const actionDirectory = resolve(
  import.meta.dirname,
  "../../../.github/actions/lint",
);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function report(): SemanticLintReport {
  return {
    schemaVersion: 1,
    status: "complete",
    model: "test/model",
    effort: "off",
    elapsedMs: 1,
    range: { base: "a", head: "b", source: "test" },
    health: {
      range: { status: "healthy" },
      diff: { status: "healthy" },
      invariantSource: { status: "healthy" },
      invariantVectors: {
        status: "healthy",
        expected: 0,
        available: 0,
        missing: 0,
      },
      hunkVectors: { status: "healthy", expected: 0, available: 0, missing: 0 },
      judge: {
        status: "healthy",
        selected: 0,
        resolved: 0,
        unresolved: 0,
        notAttempted: 0,
      },
    },
    counters: {
      hunks: 0,
      invariants: 0,
      candidates: 0,
      attempted: 0,
      resolved: 0,
      unresolved: 0,
      notAttempted: 0,
      semanticCalls: 0,
      transportAttempts: 0,
    },
    candidates: [],
    findings: [],
    gate: {
      mode: "advisory",
      blockingFindingIds: [],
      overridden: [],
      advisoryFindingIds: [],
      wouldBlockFindingIds: [],
    },
  };
}

function runReporter(value: unknown, gate: boolean, cliExit: number) {
  const directory = mkdtempSync(join(tmpdir(), "lore-action-report-"));
  directories.push(directory);
  const resultPath = join(directory, "report.json");
  const summaryPath = join(directory, "summary.md");
  if (value !== undefined) writeFileSync(resultPath, JSON.stringify(value));
  const result = spawnSync(
    process.execPath,
    [
      join(actionDirectory, "report.mjs"),
      resultPath,
      String(gate),
      String(cliExit),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    },
  );
  return {
    ...result,
    summary: (() => {
      try {
        return readFileSync(summaryPath, "utf8");
      } catch {
        return "";
      }
    })(),
  };
}

function resolvedReport(
  candidateCount = 1,
  reason = "The invariant is satisfied.",
): SemanticLintReport {
  const value = report();
  value.health.judge = {
    status: "healthy",
    selected: candidateCount,
    resolved: candidateCount,
    unresolved: 0,
    notAttempted: 0,
  };
  value.counters = {
    ...value.counters,
    candidates: candidateCount,
    attempted: candidateCount,
    resolved: candidateCount,
    semanticCalls: candidateCount,
    transportAttempts: candidateCount,
  };
  value.candidates = Array.from({ length: candidateCount }, (_, index) => ({
    id: `candidate-${index + 1}`,
    file: `src/file-${index + 1}.ts`,
    invariantId: `inv-${index + 1}`,
    invariantTitle: "Rule",
    state: "resolved",
    verdict: "satisfies",
    reason,
    stats: { semanticCalls: 1, transportAttempts: 1 },
  }));
  return value;
}

function unresolvedReport(): SemanticLintReport {
  const value = report();
  value.status = "failed";
  value.health.judge = {
    status: "failed",
    selected: 1,
    resolved: 0,
    unresolved: 1,
    notAttempted: 0,
  };
  value.counters = {
    ...value.counters,
    candidates: 1,
    attempted: 1,
    unresolved: 1,
    semanticCalls: 1,
  };
  value.candidates = [
    {
      id: "candidate-1",
      file: "src/file.ts",
      invariantId: "inv-1",
      invariantTitle: "Rule",
      state: "unresolved",
      failure: {
        code: "timeout",
        message: "judge timed out",
        scope: "candidate",
      },
      stats: { semanticCalls: 1, transportAttempts: 0 },
    },
  ];
  return value;
}

function actionAccepts(value: unknown, cliExit = 0): boolean {
  return !runReporter(value, false, cliExit).stdout.includes(
    "unreadable or invalid report",
  );
}

describe("semantic lint action reporter", () => {
  test("accepts embedding readiness failures produced by the CLI validator", () => {
    const value = failedSemanticLintReport({
      model: "test/model",
      effort: "off",
      elapsedMs: 1,
      range: { base: "a", head: "b", source: "test" },
      failedPhase: "invariantSource",
      failure: {
        code: "embedding-provider-readiness-failed",
        message: "local provider exhausted retries",
      },
      gateMode: "advisory",
    });

    expect(validateSemanticLintReport(value)).toBe(value);
    expect(actionAccepts(value, 3)).toBe(true);
  });

  test("accepts the same boundary report as the CLI validator", () => {
    const value = resolvedReport(
      MAX_LINT_REPORT_CANDIDATES,
      "x".repeat(MAX_LINT_REPORT_RESOLVED_REASON_LENGTH),
    );

    expect(validateSemanticLintReport(value)).toBe(value);
    expect(actionAccepts(value)).toBe(true);
  });

  test.each([
    [
      "too many candidates",
      () => resolvedReport(MAX_LINT_REPORT_CANDIDATES + 1),
    ],
    [
      "an overlong resolved reason",
      () =>
        resolvedReport(
          1,
          "x".repeat(MAX_LINT_REPORT_RESOLVED_REASON_LENGTH + 1),
        ),
    ],
    [
      "an empty range identity",
      () => {
        const value = report();
        value.range = { base: "", head: "b", source: "test" };
        return value;
      },
    ],
    [
      "an empty candidate identity",
      () => {
        const value = resolvedReport();
        value.candidates[0].file = "";
        return value;
      },
    ],
    [
      "a non-string candidate ID",
      () => {
        const value = resolvedReport() as unknown as {
          candidates: Array<Record<string, unknown>>;
        };
        value.candidates[0].id = 1;
        return value;
      },
    ],
    [
      "a resolved candidate failure",
      () => {
        const value = resolvedReport();
        value.candidates[0].failure = {
          code: "timeout",
          message: "unexpected stale failure",
          scope: "candidate",
        };
        return value;
      },
    ],
    [
      "an unresolved candidate verdict",
      () => {
        const value = unresolvedReport() as unknown as {
          candidates: Array<Record<string, unknown>>;
        };
        value.candidates[0].verdict = "violates";
        return value;
      },
    ],
    [
      "a non-string finding ID",
      () => {
        const value = report() as unknown as Record<string, unknown>;
        value.findings = [
          {
            id: 1,
            invariantId: "inv",
            invariantTitle: "Rule",
            invariantContent: "Rule content",
            file: "src/file.ts",
            similarity: 1,
            refHit: true,
            reason: null,
            hunk: "@@ -1,1 +1,1 @@",
            severity: "advisory",
          },
        ];
        (value.gate as Record<string, unknown>).advisoryFindingIds = [1];
        return value;
      },
    ],
    [
      "a complete report with a not-run phase",
      () => {
        const value = report();
        value.health.diff.status = "not-run";
        return value;
      },
    ],
  ])("CLI and action both reject %s", (_, makeValue) => {
    const value = makeValue();
    expect(() => validateSemanticLintReport(value)).toThrow();
    expect(actionAccepts(value, 3)).toBe(false);
  });

  test("reports a valid complete advisory run without blocking", () => {
    const result = runReporter(report(), false, 0);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("exit 0: complete, non-blocking");
    expect(result.stdout).toContain("no suspected invariant violations");
    expect(result.summary).toContain("No suspected invariant violations");
  });

  test("makes malformed reports visible but nonblocking in advisory mode", () => {
    const malformed = { ...report(), schemaVersion: 2 };
    const result = runReporter(malformed, false, 3);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("health failure");
    expect(result.stdout).toContain("Advisory mode remains non-blocking");
    expect(result.stdout).not.toContain("no suspected invariant violations");
  });

  test("fails closed on a missing report in gate mode", () => {
    const result = runReporter(undefined, true, 1);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("exit 1: CLI usage or argument failure");
    expect(result.stdout).toContain("Gate mode fails closed");
  });

  test("fails gate mode on blocking finding exit 2", () => {
    const value = report();
    value.gate = {
      mode: "gate",
      blockingFindingIds: ["finding-01"],
      overridden: [],
      advisoryFindingIds: [],
      wouldBlockFindingIds: ["finding-01"],
    };
    value.findings = [
      {
        id: "finding-01",
        invariantId: "inv",
        invariantTitle: "Never bypass validation",
        invariantContent: "Validation must never be bypassed.",
        file: "src/file.ts",
        similarity: 1,
        refHit: true,
        reason: "The guard was removed.",
        hunk: "@@ -1,1 +1,1 @@",
        severity: "strict",
      },
    ];
    const result = runReporter(value, true, 2);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("exit 2: complete with blocking findings");
    expect(result.stdout).toContain("::error file=src/file.ts");
  });

  test("rejects gate classifications that contradict mode or severity", () => {
    const finding = {
      id: "finding-01",
      invariantId: "inv",
      invariantTitle: "Never bypass validation",
      invariantContent: "Validation must never be bypassed.",
      file: "src/file.ts",
      similarity: 1,
      refHit: true,
      reason: "The guard was removed.",
      hunk: "@@ -1,1 +1,1 @@",
      severity: "strict" as const,
    };
    const advisory = report();
    advisory.findings = [finding];
    advisory.gate = {
      mode: "advisory",
      blockingFindingIds: [finding.id],
      overridden: [],
      advisoryFindingIds: [],
      wouldBlockFindingIds: [finding.id],
    };
    const advisoryResult = runReporter(advisory, false, 0);
    expect(advisoryResult.stdout).toContain(
      "advisory reports cannot contain blocking findings",
    );
    expect(advisoryResult.summary).not.toContain(
      "No suspected invariant violations",
    );

    const gate = report();
    gate.findings = [finding];
    gate.gate = {
      mode: "gate",
      blockingFindingIds: [],
      overridden: [],
      advisoryFindingIds: [finding.id],
      wouldBlockFindingIds: [finding.id],
    };
    const gateResult = runReporter(gate, true, 3);
    expect(gateResult.status).toBe(1);
    expect(gateResult.stdout).toMatch(
      /gate (blocking|advisory) findings disagree/,
    );
    expect(gateResult.summary).not.toContain(
      "No suspected invariant violations",
    );
  });

  test("rejects internally inconsistent counters", () => {
    const value = report();
    value.counters.candidates = 1;
    value.counters.attempted = 1;
    value.counters.resolved = 1;
    const result = runReporter(value, false, 3);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/disagrees with counters/);
    expect(result.stdout).not.toContain("no suspected invariant violations");
    expect(result.summary).not.toContain("No suspected invariant violations");
  });

  test.each([
    [
      "missing judge counters",
      (value: SemanticLintReport) => {
        delete (value.health.judge as Partial<typeof value.health.judge>)
          .notAttempted;
      },
    ],
    [
      "complete unresolved work",
      (value: SemanticLintReport) => {
        value.counters.candidates = 1;
        value.counters.attempted = 1;
        value.counters.unresolved = 1;
        value.health.judge = {
          status: "healthy",
          selected: 1,
          resolved: 0,
          unresolved: 1,
          notAttempted: 0,
        };
        value.candidates = [
          {
            id: "candidate-01",
            file: "src/file.ts",
            invariantId: "inv",
            invariantTitle: "Rule",
            state: "unresolved",
            failure: {
              code: "timeout",
              message: "judge timed out",
              scope: "candidate",
            },
            stats: { semanticCalls: 0, transportAttempts: 0 },
          },
        ];
      },
    ],
  ])("does not render malformed %s reports as clean", (_, mutate) => {
    const value = report();
    mutate(value);
    const result = runReporter(value, false, 0);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unreadable or invalid report");
    expect(result.stdout).not.toContain("no suspected invariant violations");
    expect(result.summary).not.toContain("No suspected invariant violations");
  });

  test("neutralizes and caps report-controlled Markdown summary fields", () => {
    const value = report();
    value.findings = [
      {
        id: "finding-01",
        invariantId: "inv",
        invariantTitle: "<img src=x onerror=alert(1)> [title](https://bad)",
        invariantContent: "Rule",
        file: "[file](https://bad/file)",
        similarity: 1,
        refHit: true,
        reason: `![image](https://bad/image) ${"x".repeat(1_000)}`,
        hunk: "@@ -1,1 +1,1 @@",
        severity: "advisory",
      },
    ];
    value.gate.advisoryFindingIds = ["finding-01"];

    const result = runReporter(value, false, 0);
    expect(result.status).toBe(0);
    expect(result.summary).toContain("&lt;img src=x onerror=alert\\(1\\)&gt;");
    expect(result.summary).not.toContain("<img");
    expect(result.summary).not.toContain("[title](https://bad)");
    expect(result.summary).not.toContain("![image](https://bad/image)");
    expect(result.summary).not.toContain("x".repeat(400));
  });

  test("groups unresolved causes in annotations and the job summary", () => {
    const value = report();
    value.status = "failed";
    value.health.judge = {
      status: "failed",
      selected: 1,
      resolved: 0,
      unresolved: 1,
      notAttempted: 0,
    };
    value.counters = {
      ...value.counters,
      candidates: 1,
      attempted: 1,
      unresolved: 1,
      semanticCalls: 1,
      transportAttempts: 0,
    };
    value.candidates = [
      {
        id: "candidate-01",
        file: "src/file.ts",
        invariantId: "inv",
        invariantTitle: "Rule",
        state: "unresolved",
        failure: {
          code: "no-auth",
          message: "missing credential",
          scope: "run",
        },
        stats: { semanticCalls: 1, transportAttempts: 0 },
      },
    ];

    const result = runReporter(value, false, 3);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("causes: no-auth: 1");
    expect(result.summary).toContain("Unresolved causes:** no-auth: 1");
  });

  test("action uses the report channel and reference deadlines", () => {
    const action = readFileSync(join(actionDirectory, "action.yml"), "utf8");
    expect(action).toContain('default: "1200"');
    expect(action).toContain('default: "90"');
    expect(action).toContain("--report-file");
    expect(action).toContain("if: always()");
    expect(action).toContain(
      "github-token and worker-api-key are mutually exclusive",
    );
    expect(action).toContain(
      "github-token requires a Responses-compatible github-copilot/gpt-5.6-* model",
    );
    expect(action).toContain("npm ci --prefix");
    expect(action).toContain("--ignore-scripts");
    expect(action).not.toContain("npm install");
    expect(action).toContain("'copilot-sdk-bridge'");
    expect(action).not.toContain(
      "LORE_WORKER_API_KEY: ${{ inputs.worker-api-key != '' && inputs.worker-api-key || inputs.github-token }}",
    );
    expect(action).not.toMatch(/>\s*\/tmp\/lore-ic\.json/);

    const actionlint = readFileSync(
      resolve(actionDirectory, "../../actionlint.yaml"),
      "utf8",
    );
    expect(actionlint).toContain(".github/workflows/semantic-linter.yml:");
    expect(actionlint).toContain('unknown permission scope "copilot-requests"');
    const ci = readFileSync(
      resolve(actionDirectory, "../../workflows/ci.yml"),
      "utf8",
    );
    expect(ci).toContain("-config-file .github/actionlint.yaml");
  });

  test("Copilot bridge disables ambient tools and translates Responses output", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    let sessionConfig: Record<string, unknown> | undefined;
    const client = {
      async createSession(config: Record<string, unknown>) {
        sessionConfig = config;
        return {
          async sendAndWait({ prompt }: { prompt: string }) {
            expect(prompt).toBe("judge this hunk");
            return { data: { content: "SATISFIES: covered" } };
          },
          async abort() {},
          async disconnect() {},
        };
      },
    };

    const response = await proxy.runCopilotResponse(client, {
      model: "gpt-5.6-luna",
      instructions: "Return one verdict line.",
      input: [{ role: "user", content: "judge this hunk" }],
      reasoning: { effort: "medium" },
      max_output_tokens: 25_600,
    });

    expect(sessionConfig).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      modelCapabilities: { limits: { max_output_tokens: 25_600 } },
      systemMessage: { mode: "replace", content: "Return one verdict line." },
      tools: [],
      availableTools: [],
      enableConfigDiscovery: false,
      enableSkills: false,
      enableSessionStore: false,
      infiniteSessions: { enabled: false },
      memory: { enabled: false },
    });
    expect(sessionConfig?.excludedTools).toEqual([
      "builtin:*",
      "mcp:*",
      "custom:*",
    ]);
    expect(response.output[0].content[0].text).toBe("SATISFIES: covered");
    expect(response.usage).toBeUndefined();
    expect(
      proxy.copilotProxyErrorResponse(
        new Error("billing_not_configured: quota exceeded"),
      ),
    ).toEqual({ status: 402, message: "insufficient credit or Copilot quota" });
    expect(
      proxy.copilotProxyErrorResponse(new Error("policy denied token")),
    ).toEqual({
      status: 403,
      message: "Copilot authentication or policy rejected",
    });
    expect(
      proxy.copilotProxyErrorResponse(
        new Error('The requested model "gpt-5.6-luna" is not supported'),
      ),
    ).toEqual({ status: 400, message: "Copilot model is not supported" });
  });

  test("Copilot bridge aborts an in-flight SDK session", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    const controller = new AbortController();
    let requestStarted = false;
    const abort = vi.fn(async () => {});
    const disconnect = vi.fn(async () => {});
    const client = {
      async createSession() {
        return {
          sendAndWait: () =>
            new Promise(() => {
              requestStarted = true;
            }),
          abort,
          disconnect,
        };
      },
    };
    const pending = proxy.runCopilotResponse(
      client,
      {
        model: "gpt-5.6-luna",
        instructions: "Return one verdict line.",
        input: [{ role: "user", content: "judge this hunk" }],
      },
      controller.signal,
    );

    await vi.waitFor(() => expect(requestStarted).toBe(true));
    controller.abort(new Error("downstream closed"));

    await expect(pending).rejects.toThrow("downstream closed");
    expect(abort).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  test("Copilot bridge safely ignores a late abort after the response wins", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    const controller = new AbortController();
    const abort = vi.fn(async () => {});
    const disconnect = vi.fn(async () => {});
    const response = await proxy.runCopilotResponse(
      {
        async createSession() {
          return {
            async sendAndWait() {
              return {
                data: {
                  get content() {
                    controller.abort(new Error("late disconnect"));
                    return "SATISFIES: completed";
                  },
                },
              };
            },
            abort,
            disconnect,
          };
        },
      },
      {
        model: "gpt-5.6-luna",
        instructions: "Return one verdict line.",
        input: [{ role: "user", content: "judge this hunk" }],
      },
      controller.signal,
    );

    expect(response.output[0].content[0].text).toBe("SATISFIES: completed");
    expect(abort).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  test("Copilot bridge validates and normalizes request controls", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    expect(() => proxy.copilotSessionConfig(null)).toThrow(
      "request body must be an object",
    );
    expect(() => proxy.copilotSessionConfig({})).toThrow(
      "request model is required",
    );
    expect(() => proxy.copilotSessionConfig({ model: "gpt-5.6-luna" })).toThrow(
      "request instructions are required",
    );
    expect(() =>
      proxy.copilotSessionConfig({
        model: "gpt-5.6-luna",
        instructions: "judge",
        input: { role: "user", content: "not an array" },
      }),
    ).toThrow("request user input is required");

    const result = proxy.copilotSessionConfig({
      model: "gpt-5.6-luna",
      instructions: "judge",
      input: [
        { role: "assistant", content: "ignore" },
        {
          role: "user",
          content: [
            null,
            { type: "input_image", text: "ignore" },
            { type: "input_text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
        { role: "user", content: 42 },
      ],
      reasoning: { effort: "invalid" },
      max_output_tokens: 0,
    });

    expect(result.prompt).toBe("first\nsecond");
    expect(result.config.reasoningEffort).toBeUndefined();
    expect(result.config.modelCapabilities).toBeUndefined();
  });

  test("Copilot bridge classifies rate limits and generic failures", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    expect(proxy.copilotProxyErrorResponse(new Error("HTTP 429"))).toEqual({
      status: 429,
      message: "Copilot rate limit exceeded",
    });
    expect(proxy.copilotProxyErrorResponse("unexpected failure")).toEqual({
      status: 502,
      message: "Copilot SDK request failed",
    });
    for (const message of [
      "author lookup failed",
      "OAuth request timed out",
      "authority unavailable",
    ]) {
      expect(proxy.copilotProxyErrorResponse(message)).toEqual({
        status: 502,
        message: "Copilot SDK request failed",
      });
    }
    for (const message of [
      "Unauthorized",
      "not authorized",
      "not authenticated",
      "Forbidden",
      "access denied",
    ]) {
      expect(proxy.copilotProxyErrorResponse(message)).toEqual({
        status: 403,
        message: "Copilot authentication or policy rejected",
      });
    }
  });

  test("Copilot proxy runtime serves requests and shuts down idempotently", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => []);
    const forceStop = vi.fn(async () => {});
    const runtime = await proxy.startCopilotProxy({
      start,
      stop,
      forceStop,
      async createSession() {
        return {
          async sendAndWait() {
            return { data: { content: "SATISFIES: runtime" } };
          },
          async abort() {},
          async disconnect() {},
        };
      },
    });
    try {
      const health = await fetch(`${runtime.url}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ status: "ok" });

      const missing = await fetch(`${runtime.url}/missing`);
      expect(missing.status).toBe(404);

      const invalid = await fetch(`${runtime.url}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      expect(invalid.status).toBe(502);

      const response = await fetch(`${runtime.url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          instructions: "Return one verdict line.",
          input: [{ role: "user", content: "judge" }],
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "completed",
      });
    } finally {
      await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    }
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(forceStop).not.toHaveBeenCalled();
  });

  test("Copilot bridge propagates an HTTP client disconnect", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    let requestStarted = false;
    const abort = vi.fn(async () => {});
    const disconnect = vi.fn(async () => {});
    const handler = proxy.createCopilotProxyHandler({
      async createSession() {
        return {
          sendAndWait: () =>
            new Promise(() => {
              requestStarted = true;
            }),
          abort,
          disconnect,
        };
      },
    });
    const server = createServer((request, response) => {
      void handler(request, response);
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${address.port}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          instructions: "Return one verdict line.",
          input: [{ role: "user", content: "judge this hunk" }],
        }),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(requestStarted).toBe(true));

      controller.abort();

      await expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
  });

  test("Copilot bridge rejects models outside the Responses family with HTTP 400", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    expect(() =>
      proxy.copilotSessionConfig({
        model: "gpt-5-mini",
        instructions: "Return one verdict line.",
        input: [{ role: "user", content: "judge this hunk" }],
      }),
    ).toThrow("request model must be in the gpt-5.6-* family");

    const createSession = vi.fn();
    const handler = proxy.createCopilotProxyHandler({ createSession });
    const server = createServer((request, response) => {
      void handler(request, response);
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5-mini",
            instructions: "Return one verdict line.",
            input: [{ role: "user", content: "judge this hunk" }],
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { message: "Copilot model is not supported" },
      });
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
  });

  test.each([
    ["rejection", () => Promise.reject(new Error("stop failed"))],
    ["partial cleanup", () => Promise.resolve([new Error("session failed")])],
  ])("Copilot bridge force-stops after SDK %s", async (_name, stop) => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    const forceStop = vi.fn(async () => {});

    await proxy.stopCopilotClient({ stop, forceStop });

    expect(forceStop).toHaveBeenCalledOnce();
  });

  test("Copilot launcher writes outputs and detaches its child", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    const directory = mkdtempSync(join(tmpdir(), "lore-copilot-launch-"));
    directories.push(directory);
    const output = join(directory, "output.txt");
    writeFileSync(output, "");
    const oldOutput = process.env.GITHUB_OUTPUT;
    const oldTemp = process.env.RUNNER_TEMP;
    process.env.GITHUB_OUTPUT = output;
    process.env.RUNNER_TEMP = directory;
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      disconnect: vi.fn(),
      unref: vi.fn(),
    });
    const spawnChild = vi.fn(() => {
      queueMicrotask(() => {
        child.emit("message", null);
        child.emit("message", { type: "ignored" });
        child.emit("message", {
          type: "ready",
          url: "http://127.0.0.1:12345",
        });
      });
      return child;
    });
    try {
      await proxy.launch("sdk.js", spawnChild);
    } finally {
      if (oldOutput === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = oldOutput;
      if (oldTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = oldTemp;
    }

    expect(readFileSync(output, "utf8")).toBe(
      "url=http://127.0.0.1:12345\npid=4242\n",
    );
    expect(spawnChild).toHaveBeenCalledOnce();
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  test("Copilot launcher rejects a child startup failure", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    const directory = mkdtempSync(join(tmpdir(), "lore-copilot-launch-fail-"));
    directories.push(directory);
    const output = join(directory, "output.txt");
    writeFileSync(output, "");
    const oldOutput = process.env.GITHUB_OUTPUT;
    const oldTemp = process.env.RUNNER_TEMP;
    process.env.GITHUB_OUTPUT = output;
    process.env.RUNNER_TEMP = directory;
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      disconnect: vi.fn(),
      unref: vi.fn(),
    });
    const spawnChild = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    });
    try {
      await expect(proxy.launch("sdk.js", spawnChild)).rejects.toThrow(
        "spawn failed",
      );
    } finally {
      if (oldOutput === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = oldOutput;
      if (oldTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = oldTemp;
    }
  });

  test("Copilot process helpers preserve process-group semantics", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    const kill = vi.spyOn(process, "kill");
    try {
      kill.mockImplementation(() => true);
      expect(proxy.processIsAlive(42, true)).toBe(true);
      const groupPid = process.platform === "win32" ? 42 : -42;
      expect(kill).toHaveBeenLastCalledWith(groupPid, 0);
      expect(proxy.killProcess(42, "SIGTERM", true)).toBe(true);
      expect(kill).toHaveBeenLastCalledWith(groupPid, "SIGTERM");

      kill.mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      expect(proxy.processIsAlive(42)).toBe(false);
      expect(proxy.killProcess(42, "SIGTERM")).toBe(false);

      kill
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        })
        .mockImplementationOnce(() => true);
      expect(proxy.killProcess(42, "SIGTERM", true)).toBe(true);
      expect(kill).toHaveBeenLastCalledWith(42, "SIGTERM");

      kill.mockImplementation(() => {
        throw new Error("unexpected");
      });
      expect(() => proxy.processIsAlive(42)).toThrow("unexpected");
      expect(() => proxy.killProcess(42, "SIGTERM")).toThrow("unexpected");
    } finally {
      kill.mockRestore();
    }
  });

  test("Copilot stop bounds graceful shutdown before killing the group", async () => {
    const proxyPath = join(actionDirectory, "copilot-proxy.mjs");
    const proxy = await import(pathToFileURL(proxyPath).href);
    await proxy.stop("invalid");

    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const pending = proxy.stop("42");
      await vi.advanceTimersByTimeAsync(5_100);
      await pending;
      const groupPid = process.platform === "win32" ? 42 : -42;
      expect(kill).toHaveBeenCalledWith(groupPid, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(groupPid, "SIGKILL");
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  test("Copilot SDK dependency graph is integrity-locked", () => {
    const lock = JSON.parse(
      readFileSync(
        join(actionDirectory, "copilot-sdk/package-lock.json"),
        "utf8",
      ),
    ) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    expect(lock.packages["node_modules/@github/copilot-sdk"]).toMatchObject({
      version: "1.0.11",
    });
    expect(lock.packages["node_modules/@github/copilot-sdk"].integrity).toMatch(
      /^sha512-/,
    );
    expect(lock.packages["node_modules/@github/copilot"]).toMatchObject({
      version: "1.0.80",
    });
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (!name.startsWith("node_modules/")) continue;
      expect(entry.integrity, `${name} is not integrity-locked`).toMatch(
        /^sha512-/,
      );
    }
  });

  test("reference workflow runs trusted base code and diffs exact event SHAs", () => {
    const workflow = readFileSync(
      resolve(actionDirectory, "../../workflows/semantic-linter.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      "ref: ${{ github.event.pull_request.base.sha }}",
    );
    expect(workflow).toContain(
      "PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    );
    expect(workflow).toContain(
      "PR_NUMBER: ${{ github.event.pull_request.number }}",
    );
    expect(workflow).toContain(
      '"+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/lore-pr-head"',
    );
    expect(workflow).toContain(
      "base: ${{ github.event.pull_request.base.sha }}",
    );
    expect(workflow).toContain(
      "head: ${{ github.event.pull_request.head.sha }}",
    );
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain(
      "model: ${{ secrets.LORE_WORKER_API_KEY != '' && vars.LORE_INVARIANT_MODEL != '' && vars.LORE_INVARIANT_MODEL || 'github-copilot/gpt-5.6-luna' }}",
    );
    expect(workflow).toContain(
      "worker-api-key: ${{ secrets.LORE_WORKER_API_KEY != '' && vars.LORE_INVARIANT_MODEL != '' && secrets.LORE_WORKER_API_KEY || '' }}",
    );
    expect(workflow).toContain(
      "github-token: ${{ secrets.LORE_WORKER_API_KEY != '' && vars.LORE_INVARIANT_MODEL != '' && '' || github.token }}",
    );
    expect(workflow).toMatch(
      /permissions:\n  actions: write\n  contents: read\n  pull-requests: read\n  copilot-requests: write\n\njobs:/,
    );
    expect(workflow).not.toMatch(/^\s+pull_request:\s*$/m);
  });

  test("published workflow guide preserves trusted credential/model pairing", () => {
    const guide = readFileSync(
      resolve(
        actionDirectory,
        "../../../packages/website/src/content/docs/docs/guides/semantic-linter.md",
      ),
      "utf8",
    );
    expect(guide).toContain("pull_request_target:");
    expect(guide).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(guide).toContain(
      "secrets.LORE_WORKER_API_KEY != '' && vars.LORE_INVARIANT_MODEL",
    );
    expect(guide).toContain("github-token:");
    expect(guide).toContain("official Copilot SDK bridge");
    expect(guide).toContain("copilot-requests: write");
    expect(guide).not.toMatch(/^\s+pull_request:\s*$/m);
  });
});
