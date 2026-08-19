import { describe, expect, test, vi } from "vitest";
import type { GatewayLLMClient, PromptOutcome } from "../src/llm-adapter";
import { createGatewayInvariantJudge } from "../src/llm-adapter";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5.6-luna" };
const INPUT = {
  invariant: { id: "inv-1", title: "Rule", content: "must stay true" },
  file: "src/a.ts",
  hunk: "@@ -1 +1 @@\n-old\n+new",
  semanticCallBudget: 2,
};

function clientWith(outcomes: PromptOutcome[]): GatewayLLMClient {
  const promptDetailed = vi.fn(async () => {
    const outcome = outcomes.shift();
    if (!outcome) throw new Error("unexpected prompt");
    return outcome;
  });
  return {
    prompt: vi.fn(async () => null),
    promptDetailed,
  };
}

describe("createGatewayInvariantJudge", () => {
  test("forwards worker upstream with matching provider provenance", async () => {
    let promptOptions: Record<string, unknown> | undefined;
    const client: GatewayLLMClient = {
      prompt: vi.fn(async () => null),
      promptDetailed: vi.fn(async (_system, _user, options) => {
        promptOptions = options;
        return {
          kind: "success",
          text: JSON.stringify({ verdict: "satisfies", reason: "covered" }),
          model: "github-copilot/gpt-5.6-luna",
          protocol: "openai-responses",
          attempts: 1,
        } satisfies PromptOutcome;
      }),
    };
    const judge = createGatewayInvariantJudge({
      client,
      model: MODEL,
      upstreamUrl: "http://127.0.0.1:12345",
      effort: "off",
      sessionID: "lint-upstream",
    });

    await judge.judge(INPUT);

    expect(promptOptions).toMatchObject({
      upstreamUrl: "http://127.0.0.1:12345",
      upstreamProviderID: "github-copilot",
    });
  });

  test("repairs one invalid verdict and sums transport attempts", async () => {
    const client = clientWith([
      {
        kind: "success",
        text: "not json",
        model: "github-copilot/gpt-5.6-luna",
        protocol: "openai-responses",
        attempts: 2,
      },
      {
        kind: "success",
        text: JSON.stringify({
          verdict: "violates",
          reason: "direct conflict",
        }),
        model: "github-copilot/gpt-5.6-luna",
        protocol: "openai-responses",
        attempts: 3,
      },
    ]);
    const judge = createGatewayInvariantJudge({
      client,
      model: MODEL,
      effort: "off",
      sessionID: "lint-1",
    });

    await expect(judge.judge(INPUT)).resolves.toEqual({
      kind: "verdict",
      verdict: "violates",
      reason: "direct conflict",
      stats: { semanticCalls: 2, transportAttempts: 5 },
    });
  });

  test("maps systemic transport failures to run scope", async () => {
    const client = clientWith([
      {
        kind: "failure",
        code: "no-auth",
        message: "missing credential",
        retryable: false,
        model: "github-copilot/gpt-5.6-luna",
        attempts: 0,
      },
    ]);
    const judge = createGatewayInvariantJudge({
      client,
      model: MODEL,
      sessionID: "lint-2",
    });

    await expect(judge.judge(INPUT)).resolves.toMatchObject({
      kind: "unresolved",
      failure: { code: "no-auth", scope: "run" },
      stats: { semanticCalls: 1, transportAttempts: 0 },
    });
  });

  test("maps insufficient credit to run scope so remaining candidates stop", async () => {
    const client = clientWith([
      {
        kind: "failure",
        code: "insufficient-credit",
        message: "HTTP 402: add credits",
        retryable: false,
        model: "github-copilot/gpt-5.6-luna",
        protocol: "openai-responses",
        httpStatus: 402,
        attempts: 1,
      },
    ]);
    const judge = createGatewayInvariantJudge({
      client,
      model: MODEL,
      sessionID: "lint-credit",
    });

    await expect(judge.judge(INPUT)).resolves.toMatchObject({
      kind: "unresolved",
      failure: { code: "transport-error", scope: "run" },
      stats: { semanticCalls: 1, transportAttempts: 1 },
    });
  });

  test("keeps candidate-specific incomplete responses local", async () => {
    const client = clientWith([
      {
        kind: "failure",
        code: "incomplete-response",
        message: "max output tokens",
        retryable: true,
        model: "github-copilot/gpt-5.6-luna",
        protocol: "openai-responses",
        attempts: 1,
      },
    ]);
    const judge = createGatewayInvariantJudge({
      client,
      model: MODEL,
      sessionID: "lint-3",
    });

    await expect(judge.judge(INPUT)).resolves.toMatchObject({
      kind: "unresolved",
      failure: { code: "incomplete-response", scope: "candidate" },
      stats: { semanticCalls: 1, transportAttempts: 1 },
    });
  });

  test("candidate timeout is local while an overall timeout is run-scoped", async () => {
    const timedOut = clientWith([
      {
        kind: "failure",
        code: "timeout",
        message: "candidate deadline",
        retryable: true,
        model: "github-copilot/gpt-5.6-luna",
        attempts: 1,
      },
    ]);
    const candidateJudge = createGatewayInvariantJudge({
      client: timedOut,
      model: MODEL,
      sessionID: "lint-timeout-candidate",
    });
    await expect(candidateJudge.judge(INPUT)).resolves.toMatchObject({
      kind: "unresolved",
      failure: { code: "timeout", scope: "candidate" },
    });

    const controller = new AbortController();
    controller.abort(new DOMException("overall deadline", "TimeoutError"));
    const overallJudge = createGatewayInvariantJudge({
      client: clientWith([
        {
          kind: "failure",
          code: "timeout",
          message: "overall deadline",
          retryable: false,
          model: "github-copilot/gpt-5.6-luna",
          attempts: 0,
        },
      ]),
      model: MODEL,
      sessionID: "lint-timeout-run",
      signal: controller.signal,
    });
    await expect(overallJudge.judge(INPUT)).resolves.toMatchObject({
      kind: "unresolved",
      failure: { code: "timeout", scope: "run" },
    });
  });
});
