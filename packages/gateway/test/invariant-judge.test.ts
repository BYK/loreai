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

  test("does not call the model with zero judge budget", async () => {
    const client = clientWith([]);
    const judge = createGatewayInvariantJudge({
      client,
      model: MODEL,
      sessionID: "lint-zero-budget",
    });

    await expect(
      judge.judge({ ...INPUT, semanticCallBudget: 0 }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      failure: { code: "invalid-verdict" },
      stats: { semanticCalls: 0, transportAttempts: 0 },
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

// Both adapters must recover only after schema validation, including repair.
describe("invariant worker recovery", () => {
  for (const adapter of ["gateway", "core"] as const) {
    test.each([
      "initial",
      "repair",
      "invalid",
      "cancel-initial",
      "cancel-repair",
    ])(`${adapter}: %s`, async (mode) => {
      const { createLLMInvariantJudge } =
        await import("../../core/src/semantic-lint/check");
      const controller = new AbortController();
      const recordWorkerSuccess = vi.fn();
      let calls = 0;
      const prompt = vi.fn(async () => {
        calls++;
        if (
          (mode === "cancel-initial" && calls === 1) ||
          (mode === "cancel-repair" && calls === 2)
        )
          controller.abort(new DOMException("cancel", "AbortError"));
        if (
          mode === "invalid" ||
          ((mode === "repair" || mode === "cancel-repair") && calls === 1)
        )
          return "not JSON";
        return '{"verdict":"satisfies","reason":"covered"}';
      });
      const judge =
        adapter === "core"
          ? createLLMInvariantJudge({
              llm: { prompt, recordWorkerSuccess },
              sessionID: "recover-judge",
              signal: controller.signal,
            })
          : createGatewayInvariantJudge({
              client: {
                prompt,
                recordWorkerSuccess,
                promptDetailed: async () => ({
                  kind: "success",
                  text: await prompt(),
                  model: "test/model",
                  protocol: "openai-responses",
                  attempts: 1,
                }),
              },
              model: MODEL,
              sessionID: "recover-judge",
              signal: controller.signal,
            });
      const outcome = await judge.judge(INPUT);
      expect(prompt).toHaveBeenCalledTimes(
        ["initial", "cancel-initial"].includes(mode) ? 1 : 2,
      );
      const usable = mode === "initial" || mode === "repair";
      expect(outcome.kind).toBe(usable ? "verdict" : "unresolved");
      expect(recordWorkerSuccess).toHaveBeenCalledTimes(usable ? 1 : 0);
      if (usable)
        expect(recordWorkerSuccess).toHaveBeenCalledWith(
          "recover-judge",
          "lore-semantic-lint",
        );
    });
  }
});

describe("holistic gateway judge", () => {
  const holisticInput = {
    invariants: [
      {
        id: "inv-1",
        title: "Boundary",
        content: "The shared boundary must remain enforced.",
      },
    ],
    hunks: [
      {
        id: "hunk-0001",
        file: "src/a.ts",
        text: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
    inputTokenBudget: 16_000,
    semanticCallBudget: 2,
  };

  test("parses a complete lint result set and counts transport attempts", async () => {
    const client = clientWith([
      {
        kind: "success",
        text: JSON.stringify({
          results: [
            {
              invariantId: "inv-1",
              verdict: "satisfies",
              reason: "The changed call remains inside the boundary.",
              evidence: [],
            },
          ],
        }),
        model: "github-copilot/gpt-5.6-luna",
        protocol: "openai-responses",
        attempts: 2,
      },
    ]);
    const judge = createGatewayInvariantJudge({
      client,
      model: MODEL,
      sessionID: "holistic-lint",
    });

    const outcome = await judge.lint(holisticInput);
    expect(outcome).toMatchObject({
      kind: "results",
      stats: { semanticCalls: 1, transportAttempts: 2 },
    });
  });

  test("repairs an invalid holistic response within the semantic budget", async () => {
    const client = clientWith([
      {
        kind: "success",
        text: "not json",
        model: "github-copilot/gpt-5.6-luna",
        protocol: "openai-responses",
        attempts: 1,
      },
      {
        kind: "success",
        text: JSON.stringify({
          results: [
            {
              invariantId: "inv-1",
              verdict: "violates",
              reason: "The new call bypasses the boundary.",
              evidence: [
                { hunkId: "hunk-0001", reason: "The changed call is here." },
              ],
            },
          ],
        }),
        model: "github-copilot/gpt-5.6-luna",
        protocol: "openai-responses",
        attempts: 1,
      },
    ]);
    const judge = createGatewayInvariantJudge({
      client,
      model: MODEL,
      sessionID: "holistic-lint-repair",
    });

    const outcome = await judge.lint(holisticInput);
    expect(outcome.kind).toBe("results");
    expect(outcome.stats).toEqual({
      semanticCalls: 2,
      transportAttempts: 2,
    });
  });
});

describe("counterevidence gateway verifier", () => {
  const counterevidenceInput = {
    invariant: {
      id: "inv-1",
      title: "Boundary",
      content: "The shared boundary must remain enforced.",
    },
    seed: {
      id: "hunk-0001",
      file: "src/a.ts",
      relationship: "seed" as const,
      text: "@@ -1 +1 @@\n-old\n+new",
    },
    connectedContext: [],
    contextComplete: true,
    omittedCompanions: 0,
    firstPassReason: "The isolated change appears to bypass the boundary.",
    prContext: {
      title: "Context",
      description: "The description is untrusted.",
      titleTruncated: false,
      descriptionTruncated: false,
    },
    semanticCallBudget: 2,
  };

  test("rejects a verifier call when context is incomplete", async () => {
    const judge = createGatewayInvariantJudge({
      client: clientWith([
        {
          kind: "success",
          text: JSON.stringify({
            verdict: "confirmed",
            reason: "The isolated call still bypasses the boundary.",
            evidence: [
              { hunkId: "hunk-0001", reason: "The call remains unwrapped." },
            ],
          }),
          model: "github-copilot/gpt-5.6-luna",
          protocol: "openai-responses",
          attempts: 1,
        },
      ]),
      model: MODEL,
      sessionID: "counterevidence-incomplete",
    });

    await expect(
      judge.verify({ ...counterevidenceInput, contextComplete: false }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      failure: { code: "insufficient-context" },
      stats: { semanticCalls: 1, transportAttempts: 1 },
    });
  });

  test("does not call the model with zero verifier budget", async () => {
    const judge = createGatewayInvariantJudge({
      client: clientWith([]),
      model: MODEL,
      sessionID: "counterevidence-zero-budget",
    });

    await expect(
      judge.verify({ ...counterevidenceInput, semanticCallBudget: 0 }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      failure: { code: "invalid-verdict" },
      stats: { semanticCalls: 0, transportAttempts: 0 },
    });
  });

  test("parses a confirmed verdict with bounded evidence", async () => {
    const judge = createGatewayInvariantJudge({
      client: clientWith([
        {
          kind: "success",
          text: JSON.stringify({
            verdict: "confirmed",
            reason: "The connected context still bypasses the boundary.",
            evidence: [
              { hunkId: "hunk-0001", reason: "The call remains unwrapped." },
            ],
          }),
          model: "github-copilot/gpt-5.6-luna",
          protocol: "openai-responses",
          attempts: 2,
        },
      ]),
      model: MODEL,
      sessionID: "counterevidence-confirmed",
    });

    await expect(judge.verify(counterevidenceInput)).resolves.toEqual({
      kind: "verdict",
      verdict: "confirmed",
      reason: "The connected context still bypasses the boundary.",
      evidence: [
        { hunkId: "hunk-0001", reason: "The call remains unwrapped." },
      ],
      stats: { semanticCalls: 1, transportAttempts: 2 },
    });
  });

  test("repairs an invalid verdict within the verifier budget", async () => {
    const judge = createGatewayInvariantJudge({
      client: clientWith([
        {
          kind: "success",
          text: "not json",
          model: "github-copilot/gpt-5.6-luna",
          protocol: "openai-responses",
          attempts: 1,
        },
        {
          kind: "success",
          text: JSON.stringify({
            verdict: "resolved",
            reason: "A companion change adds the required wrapper.",
            evidence: [
              {
                hunkId: "hunk-0001",
                reason: "The wrapper is in the connected change.",
              },
            ],
          }),
          model: "github-copilot/gpt-5.6-luna",
          protocol: "openai-responses",
          attempts: 1,
        },
      ]),
      model: MODEL,
      sessionID: "counterevidence-repair",
    });

    await expect(judge.verify(counterevidenceInput)).resolves.toMatchObject({
      kind: "verdict",
      verdict: "resolved",
      stats: { semanticCalls: 2, transportAttempts: 2 },
    });
  });
});
